#!/usr/bin/env node

/**
 * A deliberately small, evidence-only provider cache probe.
 *
 * This script is not part of agent-core's request path. It builds one fixed
 * request per documented route, defaults to a dry run, and records hashes and
 * nullable observations instead of prompts, credentials, or response bodies.
 * Live mode requires both an explicit `live` request and an explicit opt-in
 * (`allowLive: true` or TERMINA_PROVIDER_PROBE_ALLOW_LIVE=1). Tests inject a
 * loopback HTTP server; this file never contacts a provider by itself.
 */

import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Keep probe serialization, identity derivation, and usage parsing aligned
// with the canonical agent-core owners. The repository's existing script
// tests load these .ts modules with Node's strip-types support.
import * as auth from "../../../agent-core/auth.ts";
import * as compat from "../../../agent-core/openai-compat.ts";
import * as trace from "../../../agent-core/trace.ts";

export const PROBE_SCHEMA_VERSION = 1;
export const FIXTURE_ID = "agent-core-provider-probe-v1";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REPEAT = 16;
const MAX_GAP_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const OPTIONAL_BODY_FIELDS = new Set([
  "cache_control",
  "prompt_cache_breakpoint",
  "prompt_cache_key",
  "prompt_cache_options",
  "session_id",
]);
const OPTIONAL_HEADERS = new Set(["x-grok-conv-id", "x-session-id"]);
const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)$/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const SOURCE_URLS = Object.freeze({
  anthropic: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  openai: "https://developers.openai.com/api/docs/guides/prompt-caching",
  xai: "https://docs.x.ai/developers/advanced-api-usage/prompt-caching",
  openrouter: "https://openrouter.ai/docs/guides/best-practices/prompt-caching",
});

const ROUTES = Object.freeze({
  anthropic: Object.freeze({
    protocols: ["anthropic-messages"],
    hosts: ["api.anthropic.com"],
  }),
  openai: Object.freeze({
    protocols: ["openai-responses"],
    hosts: ["api.openai.com"],
  }),
  xai: Object.freeze({
    protocols: ["openai-responses", "openai-completions"],
    hosts: ["api.x.ai"],
  }),
  openrouter: Object.freeze({
    protocols: ["openai-responses", "openai-completions"],
    hosts: ["openrouter.ai"],
  }),
  // These routes are intentionally represented as disabled rather than
  // guessed. Their compatibility cache fields are not documented by the
  // sources used for this probe.
  google: Object.freeze({ disabled: true }),
  "opencode-zen": Object.freeze({ disabled: true }),
});

const FIXTURE = Object.freeze({
  system: "You are an agent-core provider probe. Return a short acknowledgement.",
  firstUser: "Use the fixed fixture to verify cache request behavior.",
  assistant: "Fixture acknowledgement.",
  secondUser: "Repeat the fixed fixture request.",
  tool: Object.freeze({
    type: "function",
    name: "probe_echo",
    description: "Echo one fixed probe value.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({ value: Object.freeze({ type: "string" }) }),
      required: ["value"],
      additionalProperties: false,
    }),
  }),
});

function normalizeFixture(value) {
  if (value === undefined) {
    return {
      id: FIXTURE_ID,
      system: FIXTURE.system,
      firstUser: FIXTURE.firstUser,
      assistant: FIXTURE.assistant,
      secondUser: FIXTURE.secondUser,
      tool: FIXTURE.tool,
      targetBytes: null,
    };
  }
  if (!isRecord(value)) {
    throw new ProbeConfigurationError("INVALID_FIXTURE", "fixture must be an object");
  }
  const id = nonempty(value.id);
  if (!id || id.length > 128 || hasControl(id)) {
    throw new ProbeConfigurationError("INVALID_FIXTURE", "fixture.id must be a short printable string");
  }
  const targetBytes = value.targetBytes;
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1 || targetBytes > MAX_RESPONSE_BYTES) {
    throw new ProbeConfigurationError("INVALID_FIXTURE", `fixture.targetBytes must be an integer from 1 to ${MAX_RESPONSE_BYTES}`);
  }
  const base = {
    id,
    system: FIXTURE.system,
    firstUser: FIXTURE.firstUser,
    assistant: FIXTURE.assistant,
    secondUser: FIXTURE.secondUser,
    tool: FIXTURE.tool,
    targetBytes,
  };
  const current = Buffer.byteLength(base.system, "utf8");
  const paddingBytes = Math.max(0, targetBytes - current);
  // The caller controls only an explicit size, never arbitrary prompt text.
  // ASCII padding makes the lower-bound deterministic without leaking it in
  // the report.
  base.system += "\n[threshold fixture padding]" + "p".repeat(Math.max(0, paddingBytes - 29));
  return base;
}

export class ProbeConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeConfigurationError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasControl(value) {
  return typeof value === "string" && /\p{Cc}/u.test(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
  return `{${entries.join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isoTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ProbeConfigurationError("INVALID_TIMESTAMP", `${field} must be an ISO timestamp`);
  }
  return date.toISOString();
}

function safeSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeConfigurationError("INVALID_SOURCE", "sourceUrl must be an https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ProbeConfigurationError("INVALID_SOURCE", "sourceUrl must be a credential-free https URL");
  }
  return url.toString();
}

function safeEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeConfigurationError("INVALID_ENDPOINT", "endpoint must be an http(s) URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProbeConfigurationError("INVALID_ENDPOINT", "endpoint must be a credential-free http(s) URL");
  }
  return url;
}

function validateRoute(provider, protocol, endpoint, allowHosts) {
  const route = ROUTES[provider];
  if (!route) throw new ProbeConfigurationError("UNSUPPORTED_PROVIDER", `unsupported probe provider: ${provider}`);
  if (route.disabled) {
    throw new ProbeConfigurationError("PROBE_DISABLED", `${provider} compatibility cache probing is disabled until the route is documented`);
  }
  if (!route.protocols.includes(protocol)) {
    throw new ProbeConfigurationError("PROTOCOL_NOT_ALLOWED", `${provider} does not allow ${protocol} in this probe`);
  }
  const host = endpoint.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) {
    const explicit = Array.isArray(allowHosts) && allowHosts.some((item) => String(item).toLowerCase() === host);
    if (!explicit) {
      throw new ProbeConfigurationError("ROUTE_NOT_ALLOWED", "loopback endpoints require an explicit allowHosts entry");
    }
    return;
  }
  if (!route.hosts.includes(host)) {
    throw new ProbeConfigurationError("ROUTE_NOT_ALLOWED", `${provider} endpoint host is not in the probe allowlist`);
  }
}

function normalizeConfig(config) {
  if (!isRecord(config)) throw new ProbeConfigurationError("INVALID_CONFIG", "probe config must be an object");
  for (const field of ["endpoint", "provider", "model", "protocol"]) {
    if (!nonempty(config[field])) {
      throw new ProbeConfigurationError("MISSING_FIELD", `probe config requires ${field}`);
    }
  }
  const endpoint = safeEndpoint(config.endpoint);
  const provider = config.provider.trim().toLowerCase();
  const model = config.model.trim();
  const protocol = config.protocol.trim().toLowerCase();
  validateRoute(provider, protocol, endpoint, config.allowHosts);
  if (!Object.hasOwn(config, "retrievedAt") || !nonempty(config.retrievedAt)) {
    throw new ProbeConfigurationError("MISSING_FIELD", "probe config requires retrievedAt for the documentation snapshot");
  }
  const sessionId = config.sessionId === undefined ? "" : String(config.sessionId);
  if (hasControl(sessionId)) {
    throw new ProbeConfigurationError("INVALID_SESSION", "sessionId cannot contain control characters");
  }
  const sourceUrl = safeSourceUrl(config.sourceUrl ?? SOURCE_URLS[provider] ?? "https://example.invalid/provider-probe-source");
  const retrievedAt = isoTimestamp(config.retrievedAt, "retrievedAt");
  const sessionSeed = auth.cacheSessionSeed(sessionId || undefined);
  const cacheIdentity = auth.cacheIdentityFor({
    sessionSeed,
    role: "main",
    provider,
    protocol,
    route: endpoint.toString(),
  });
  if (!cacheIdentity) {
    throw new ProbeConfigurationError("INVALID_IDENTITY", "canonical cache identity could not be derived for this route");
  }
  const repeat = config.repeat === undefined ? 1 : config.repeat;
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
    throw new ProbeConfigurationError("INVALID_REPEAT", `repeat must be an integer from 1 to ${MAX_REPEAT}`);
  }
  const gapsMs = config.gapsMs === undefined ? [] : config.gapsMs;
  if (!Array.isArray(gapsMs) || gapsMs.length > repeat - 1 || gapsMs.some((gap) => !Number.isFinite(gap) || gap < 0 || gap > MAX_GAP_MS)) {
    throw new ProbeConfigurationError("INVALID_GAPS", `gapsMs must contain at most ${repeat - 1} gaps from 0 to ${MAX_GAP_MS}ms`);
  }
  const timeoutMs = config.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : config.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ProbeConfigurationError("INVALID_TIMEOUT", `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return {
    endpoint: endpoint.toString(),
    endpointUrl: endpoint,
    provider,
    model,
    protocol,
    sessionId,
    sessionSeed,
    cacheIdentity,
    sourceUrl,
    retrievedAt,
    fixture: normalizeFixture(config.fixture),
    repeat,
    gapsMs: gapsMs.map((gap) => Math.trunc(gap)),
    waitForGaps: config.waitForGaps === true,
    timeoutMs,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    live: config.live === true,
    allowLive: config.allowLive === true,
    allowHosts: Array.isArray(config.allowHosts) ? config.allowHosts.map(String) : [],
  };
}

function deriveProbeKey(config) {
  return config.cacheIdentity.key;
}

function cloneWithoutOptionalFields(value) {
  if (Array.isArray(value)) return value.map(cloneWithoutOptionalFields);
  if (!isRecord(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (OPTIONAL_BODY_FIELDS.has(key)) continue;
    result[key] = cloneWithoutOptionalFields(child);
  }
  return result;
}

function redactHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    result[name] = SENSITIVE_HEADERS.test(name) ? "[REDACTED]" : String(value);
  }
  return result;
}

function strippedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !OPTIONAL_HEADERS.has(name.toLowerCase())),
  );
}

function modelIsGpt56(model) {
  return /(?:^|\/)gpt-5\.6(?:[-/]|$)/i.test(model.trim());
}

function anthropicMessages(fixture) {
  return [
    { role: "user", content: [{ type: "text", text: fixture.firstUser }] },
    { role: "assistant", content: fixture.assistant },
    { role: "user", content: [{ type: "text", text: fixture.secondUser }] },
  ];
}

function kernelMessages(fixture) {
  return [
    { role: "user", content: [{ type: "text", text: fixture.firstUser }] },
    { role: "assistant", content: fixture.assistant },
    { role: "user", content: [{ type: "text", text: fixture.secondUser }] },
  ];
}

function probeToolDef(fixture) {
  return {
    name: fixture.tool.name,
    description: fixture.tool.description,
    input_schema: fixture.tool.parameters,
  };
}

function buildRequest(config, includeOptional = true) {
  const key = deriveProbeKey(config);
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "termina-agent-core-provider-probe/1",
  };
  if (config.apiKey) {
    if (config.provider === "anthropic") headers["x-api-key"] = config.apiKey;
    else headers.authorization = `Bearer ${config.apiKey}`;
  }
  Object.assign(headers, auth.cacheSessionHeaders(config.cacheIdentity));

  let body;
  if (config.provider === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: config.model,
      max_tokens: 16,
      stream: false,
      system: [{ type: "text", text: config.fixture.system }],
      messages: anthropicMessages(config.fixture),
    };
    if (includeOptional) {
      body.system[0].cache_control = { type: "ephemeral", ttl: "1h" };
    }
  } else if (config.protocol === "openai-responses") {
    const options = {
      provider: config.provider,
      maxTokens: 16,
      ...(includeOptional && config.provider === "openai" && modelIsGpt56(config.model)
        ? {
          cacheKey: key,
          promptCacheMode: "explicit",
          explicitCacheBreakpoint: true,
        }
        : {}),
      ...(includeOptional && config.provider === "xai" ? { cacheKey: key } : {}),
      ...(includeOptional && config.provider === "openrouter" ? { sessionId: key } : {}),
    };
    body = compat.responsesBody(
      config.model,
      config.fixture.system,
      kernelMessages(config.fixture),
      [probeToolDef(config.fixture)],
      options,
    );
    body.stream = false;
  } else {
    const options = {
      provider: config.provider,
      maxTokens: 16,
      ...(includeOptional && config.provider === "openrouter" ? { sessionId: key } : {}),
    };
    body = compat.completionsBody(
      config.model,
      config.fixture.system,
      kernelMessages(config.fixture),
      [probeToolDef(config.fixture)],
      "max_tokens",
      options,
    );
    body.stream = false;
    delete body.stream_options;
  }

  const bodyText = stableStringify(body);
  const stablePrefixText = stableStringify(cloneWithoutOptionalFields(body));
  const requestedPolicy = policyFor(config, body, headers, includeOptional);
  return {
    method: "POST",
    endpoint: config.endpoint,
    headers,
    body,
    bodyText,
    stablePrefixText,
    requestedPolicy,
    effectivePolicy: requestedPolicy,
  };
}

function cacheFieldsFor(body, headers) {
  const fields = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (OPTIONAL_BODY_FIELDS.has(key)) fields.add(key);
      visit(child);
    }
  };
  visit(body);
  for (const key of Object.keys(headers)) {
    if (OPTIONAL_HEADERS.has(key.toLowerCase())) fields.add(key.toLowerCase());
  }
  return [...fields].sort();
}

function markerCount(body) {
  let count = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (Object.hasOwn(value, "cache_control") || Object.hasOwn(value, "prompt_cache_breakpoint")) count += 1;
    for (const child of Object.values(value)) visit(child);
  };
  visit(body);
  return count;
}

function markerPositions(body) {
  const positions = [];
  let position = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (Object.hasOwn(value, "cache_control") || Object.hasOwn(value, "prompt_cache_breakpoint")) positions.push(position);
    position += 1;
    for (const child of Object.values(value)) visit(child);
  };
  visit(body);
  return positions;
}

function ttlMilliseconds(ttl) {
  if (ttl === "5m") return 5 * 60 * 1000;
  if (ttl === "30m") return 30 * 60 * 1000;
  if (ttl === "1h") return 60 * 60 * 1000;
  return null;
}

function policyFor(config, body, headers, requested) {
  const fields = cacheFieldsFor(body, headers);
  let ttl = null;
  if (Object.hasOwn(body, "prompt_cache_options") && body.prompt_cache_options?.ttl) ttl = body.prompt_cache_options.ttl;
  if (fields.includes("cache_control")) ttl = body.system?.[0]?.cache_control?.ttl ?? null;
  return {
    namespace: `${config.provider}/${config.protocol}/${config.model}`,
    cacheFields: fields,
    markerCount: markerCount(body),
    markerPositions: markerPositions(body),
    ttl,
    ttlMs: ttlMilliseconds(ttl),
    mode: fields.length === 0 ? "none" : config.provider === "anthropic" ? "explicit-marker" : "key-or-session",
    requested: requested === true,
    providerAcceptance: "unknown",
  };
}

function stripOptionalRequest(request, config) {
  const body = cloneWithoutOptionalFields(request.body);
  const headers = strippedHeaders(request.headers);
  const bodyText = stableStringify(body);
  const stablePrefixText = stableStringify(cloneWithoutOptionalFields(body));
  return {
    ...request,
    headers,
    body,
    bodyText,
    stablePrefixText,
    effectivePolicy: policyFor(config, body, headers, false),
  };
}

function usageNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = usageNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function usageFromPayload(provider, protocol, payload) {
  const usage = isRecord(payload?.usage)
    ? payload.usage
    : isRecord(payload?.usageMetadata)
      ? payload.usageMetadata
      : null;
  const empty = { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null };
  if (!usage) return empty;
  if (provider === "anthropic") {
    const creation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
    const ephemeral5m = firstNumber(usage.ephemeral_5m_input_tokens, creation?.ephemeral_5m_input_tokens);
    const ephemeral1h = firstNumber(usage.ephemeral_1h_input_tokens, creation?.ephemeral_1h_input_tokens);
    const reportedWrite = usageNumber(usage.cache_creation_input_tokens);
    return {
      input: usageNumber(usage.input_tokens),
      cacheRead: usageNumber(usage.cache_read_input_tokens),
      cacheWrite: reportedWrite ?? (ephemeral5m !== null && ephemeral1h !== null ? ephemeral5m + ephemeral1h : null),
      cacheWriteBreakdown: { ephemeral5m, ephemeral1h },
      output: usageNumber(usage.output_tokens),
      reasoning: null,
    };
  }
  // The canonical compatibility parser owns the OpenAI/xAI/OpenRouter
  // response mapping. Keep its nullable semantics, then make an impossible
  // cached > total relationship entirely unknown for this evidence record.
  const parsed = protocol === "openai-responses"
    ? compat.responsesResultFromEvents([{
      type: "response.completed",
      response: { ...payload, output: Array.isArray(payload?.output) ? payload.output : [], usage },
    }], () => {}, 0).usage
    : compat.completionResultFromEvents([{ usage }], () => {}, 0).usage;
  if (!parsed) return empty;
  const details = protocol === "openai-completions"
    ? (isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null)
    : (isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null);
  const total = firstNumber(usage.input_tokens, usage.prompt_tokens);
  const cached = firstNumber(details?.cached_tokens, usage.cached_tokens);
  if (total !== null && cached !== null && cached > total) {
    return { ...parsed, input: null, cacheRead: null, cacheWrite: null };
  }
  return parsed;
}

function optionalFieldRejection(status, rawBody) {
  if (status !== 400 && status !== 422) return false;
  const text = String(rawBody ?? "").toLowerCase();
  return [
    "prompt_cache",
    "cache_control",
    "session_id",
    "x-grok-conv-id",
  ].some((field) => text.includes(field));
}

function abortError() {
  return new DOMException("aborted", "AbortError");
}

function readChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

async function readResponse(response, signal) {
  const reader = response?.body && typeof response.body.getReader === "function" ? response.body.getReader() : null;
  if (reader) {
    const chunks = [];
    let total = 0;
    let oversized = false;
    try {
      while (true) {
        const next = await readChunk(reader, signal);
        if (next.done) break;
        const bytes = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        const room = MAX_RESPONSE_BYTES - total;
        if (bytes.byteLength > room) {
          if (room > 0) chunks.push(bytes.slice(0, room));
          total = MAX_RESPONSE_BYTES;
          oversized = true;
          await reader.cancel();
          break;
        }
        chunks.push(bytes);
        total += bytes.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const rawBody = new TextDecoder().decode(bytes);
    const responseHash = sha256Bytes(bytes);
    if (oversized) return { rawBody, responseHash, responseHashScope: "bounded-prefix", payload: null, oversized: true };
    let payload = null;
    try {
      payload = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      payload = null;
    }
    return { rawBody, responseHash, responseHashScope: "full", payload, oversized: false };
  }
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  const raw = await response.text();
  const bytes = Buffer.from(raw, "utf8");
  const oversized = bytes.byteLength > MAX_RESPONSE_BYTES;
  const bounded = oversized ? bytes.subarray(0, MAX_RESPONSE_BYTES) : bytes;
  const rawBody = bounded.toString("utf8");
  const responseHash = sha256Bytes(bounded);
  if (oversized) return { rawBody, responseHash, responseHashScope: "bounded-prefix", payload: null, oversized: true };
  let payload = null;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    payload = null;
  }
  return { rawBody, responseHash, responseHashScope: "full", payload, oversized: false };
}

function nowIso(dependencies) {
  const value = typeof dependencies?.now === "function" ? dependencies.now() : new Date();
  return isoTimestamp(value, "clock");
}

function waitForGap(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function responseErrorKind(response, normalized) {
  const status = Number.isInteger(response?.status) ? response.status : null;
  if (status !== null && status >= 300 && status < 400) return "redirect-rejected";
  if (response?.redirected === true) return "redirect-rejected";
  if (typeof response?.url === "string" && response.url && response.url !== normalized.endpoint) {
    try {
      validateRoute(normalized.provider, normalized.protocol, new URL(response.url), normalized.allowHosts);
    } catch {
      return "redirect-route-rejected";
    }
    return "redirect-rejected";
  }
  return null;
}

function tracePolicy(policy, rejected, fallbackReason) {
  return {
    mode: policy?.mode ?? null,
    ttlMs: policy?.ttlMs ?? null,
    namespace: policy?.namespace ?? null,
    markerCount: policy?.markerCount ?? null,
    markerPositions: policy?.markerPositions ?? null,
    rejected: rejected ? true : null,
    fallbackReason: fallbackReason ?? null,
  };
}

function traceAdapter(normalized, runId, taskId, attempts) {
  const traceAttempts = attempts.map((attempt) => trace.createAttemptRecord({
    runId,
    taskId,
    attemptId: attempt.attemptId,
    retryOfAttemptId: attempt.retryOfAttemptId,
    role: "main",
    provider: normalized.provider,
    protocol: normalized.protocol,
    route: normalized.endpoint,
    model: normalized.model,
    status: attempt.ok ? "ok" : "error",
    retryCount: attempt.retryIndex,
    fallbackReason: attempt.retryIndex > 0 ? "optional-field-rejection" : null,
    startedAtMs: Date.parse(attempt.startedAt),
    endedAtMs: Date.parse(attempt.finishedAt),
    ttftMs: null,
    turnMs: Math.max(0, Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)),
    usage: attempt.usage,
    cost: null,
    cache: {
      namespace: attempt.effectivePolicy.namespace,
      requested: tracePolicy(attempt.requestedPolicy, false, null),
      effective: tracePolicy(attempt.effectivePolicy, attempt.policyAcceptance === "rejected-by-response", attempt.retryIndex > 0 ? "optional-field-rejection" : null),
      markerCount: attempt.effectivePolicy.markerCount,
      markerPositions: attempt.effectivePolicy.markerPositions,
      rejected: attempt.policyAcceptance === "rejected-by-response" ? true : null,
      fallbackReason: attempt.retryIndex > 0 ? "optional-field-rejection" : null,
      cacheKeyHash: sha256(deriveProbeKey(normalized)),
      modelSettingsHash: null,
      toolsHash: sha256(stableStringify([normalized.fixture.tool])),
      stablePrefixHash: attempt.stablePrefixHash,
      reusablePrefixHash: attempt.stablePrefixHash,
      messagePrefixHash: null,
      workingSetHash: null,
      workingSetChanged: null,
      retryPromptIdentical: attempt.stablePrefixByteIdentical,
      codexTurnStateUsed: null,
    },
    revisions: { count: null, kinds: [] },
    wasteTokens: null,
    wasteCause: null,
  }));
  const taskSettled = trace.createTaskSettledRecord({
    runId,
    taskId,
    taskClass: null,
    attemptCount: traceAttempts.length,
    finalAttemptId: traceAttempts.at(-1)?.attemptId ?? null,
    attemptIds: traceAttempts.map((attempt) => attempt.attemptId),
    summaryAttemptIds: [],
    // The probe cannot establish task correctness from an HTTP response.
    outcome: { status: null, correctness: null, criteriaHash: null },
  });
  return {
    format: "agent-core-trace-v2",
    attempts: traceAttempts,
    taskSettled,
    // Trace v2 intentionally has a fixed usage shape. Keep the documented
    // Anthropic write split in an explicit adapter record instead of dropping
    // it or smuggling provider-only fields into the canonical trace schema.
    providerUsage: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      cacheWriteBreakdown: attempt.usage.cacheWriteBreakdown ?? null,
    })),
  };
}

function publicPolicy(policy) {
  return {
    namespace: policy?.namespace ?? null,
    cacheFields: [...(policy?.cacheFields ?? [])],
    markerCount: policy?.markerCount ?? 0,
    markerPositions: policy?.markerPositions ? [...policy.markerPositions] : null,
    ttl: policy?.ttl ?? null,
    ttlMs: policy?.ttlMs ?? null,
    mode: policy?.mode ?? "none",
    requested: policy?.requested === true,
    providerAcceptance: "unknown",
  };
}

function publicPlan(config, request) {
  return {
    method: request.method,
    endpoint: config.endpoint,
    headers: redactHeaders(request.headers),
    requestBodyHash: sha256(request.bodyText),
    stablePrefixHash: sha256(request.stablePrefixText),
    stablePrefixByteLength: Buffer.byteLength(request.stablePrefixText, "utf8"),
    fixtureSizeBytes: Buffer.byteLength(request.bodyText, "utf8"),
    requestedPolicy: publicPolicy(request.requestedPolicy),
    schedule: {
      repeat: config.repeat,
      gapsMs: [...config.gapsMs],
      waitForGaps: config.waitForGaps,
    },
  };
}

function buildProbePlanFromNormalized(normalized) {
  const request = buildRequest(normalized, true);
  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    fixtureId: normalized.fixture.id,
    provider: normalized.provider,
    model: normalized.model,
    protocol: normalized.protocol,
    source: { url: normalized.sourceUrl, retrievedAt: normalized.retrievedAt },
    requestPlan: publicPlan(normalized, request),
  };
}

/** Validate and build a redacted dry-run plan without invoking fetch. */
export function buildProbePlan(config) {
  return buildProbePlanFromNormalized(normalizeConfig(config));
}

/**
 * Run one controlled probe. The returned object never contains request or
 * response bodies. A 400/422 mentioning an optional cache field gets one—and
 * only one—retry with all optional cache fields removed.
 */
export async function runProviderCacheProbe(config, dependencies = {}) {
  const normalized = normalizeConfig(config);
  const probeStartedAt = nowIso(dependencies);
  const original = buildProbePlanFromNormalized(normalized);
  const previewRequest = buildRequest(normalized, true);
  const taskId = `probe-task-${sha256(stableStringify({
    provider: normalized.provider,
    protocol: normalized.protocol,
    model: normalized.model,
    fixtureId: normalized.fixture.id,
    endpointHost: normalized.endpointUrl.hostname,
    stablePrefix: previewRequest.stablePrefixText,
  })).slice(0, 24)}`;
  const runId = `probe-run-${randomUUID()}`;
  if (!normalized.live) {
    return {
      ...original,
      mode: "dry-run",
      runId,
      taskId,
      startedAt: probeStartedAt,
      finishedAt: nowIso(dependencies),
      attempts: [],
      retry: { count: 0, reason: null },
      trace: traceAdapter(normalized, runId, taskId, []),
    };
  }
  const env = dependencies.env ?? process.env;
  if (!normalized.allowLive && env.TERMINA_PROVIDER_PROBE_ALLOW_LIVE !== "1") {
    throw new ProbeConfigurationError(
      "LIVE_OPT_IN_REQUIRED",
      "live mode requires allowLive: true or TERMINA_PROVIDER_PROBE_ALLOW_LIVE=1",
    );
  }
  if (!normalized.apiKey) {
    throw new ProbeConfigurationError("CREDENTIAL_REQUIRED", "live mode requires an API key in memory");
  }
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new ProbeConfigurationError("FETCH_REQUIRED", "live mode requires fetch");

  const originalRequest = previewRequest;
  const attempts = [];
  let retryCount = 0;
  let retryReason = null;
  let stablePrefixReference = null;
  for (let repeatIndex = 0; repeatIndex < normalized.repeat; repeatIndex += 1) {
    const gapBeforeMs = repeatIndex > 0 ? normalized.gapsMs[repeatIndex - 1] ?? 0 : 0;
    if (normalized.waitForGaps && gapBeforeMs > 0) await waitForGap(gapBeforeMs);
    let request = buildRequest(normalized, true);
    for (let retryIndex = 0; retryIndex < 2; retryIndex += 1) {
      const startedAt = nowIso(dependencies);
      const attemptId = `probe-attempt-${repeatIndex + 1}-${retryIndex + 1}-${sha256(`${runId}\0${repeatIndex}\0${retryIndex}`).slice(0, 16)}`;
      const retryOfAttemptId = retryIndex > 0 ? attempts.at(-1)?.attemptId ?? null : null;
      let response;
      let responseData = { rawBody: "", responseHash: null, responseHashScope: "full", payload: null, oversized: false };
      let errorKind = null;
      let errorMessage = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), normalized.timeoutMs);
      try {
        response = await fetchImpl(request.endpoint, {
          method: request.method,
          headers: request.headers,
          body: request.bodyText,
          redirect: "manual",
          signal: controller.signal,
        });
        responseData = await readResponse(response, controller.signal);
        errorKind = responseErrorKind(response, normalized);
      } catch (error) {
        errorKind = controller.signal.aborted ? "AbortError" : error instanceof Error ? error.name : "request-error";
        errorMessage = error instanceof Error ? error.name : "request-error";
      } finally {
        clearTimeout(timer);
      }
      const finishedAt = nowIso(dependencies);
      const status = response && Number.isInteger(response.status) ? response.status : null;
      const rejectedOptional = !errorKind && optionalFieldRejection(status, responseData.rawBody);
      const usage = errorKind ? { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null } : usageFromPayload(normalized.provider, normalized.protocol, responseData.payload);
      const stablePrefixByteIdentical = stablePrefixReference === null || stablePrefixReference === request.stablePrefixText;
      if (stablePrefixReference === null) stablePrefixReference = request.stablePrefixText;
      const cacheObservation = usage.cacheRead !== null || usage.cacheWrite !== null ? "reported" : "unknown";
      const attempt = {
        attempt: attempts.length + 1,
        repeatIndex,
        gapBeforeMs,
        attemptId,
        retryOfAttemptId,
        retryIndex,
        startedAt,
        finishedAt,
        httpStatus: status,
        ok: !errorKind && Boolean(response?.ok ?? (status !== null && status >= 200 && status < 300)),
        requestBodyHash: sha256(request.bodyText),
        stablePrefixHash: sha256(request.stablePrefixText),
        stablePrefixText: request.stablePrefixText,
        stablePrefixByteLength: Buffer.byteLength(request.stablePrefixText, "utf8"),
        stablePrefixByteIdentical,
        requestedPolicy: publicPolicy(originalRequest.requestedPolicy),
        effectivePolicy: publicPolicy(request.effectivePolicy),
        policyAcceptance: rejectedOptional ? "rejected-by-response" : "unknown",
        cacheObservation,
        // A miss can be caused by provider-side eviction, but this probe cannot
        // observe that distinction. Never turn an absent cache read into a cause.
        missCause: "unknown",
        usage,
        responseHash: responseData.responseHash,
        responseHashScope: responseData.responseHashScope,
        responseOversized: responseData.oversized,
        redactedHeaders: redactHeaders(request.headers),
        ...(errorKind ? { errorKind, error: errorMessage } : {}),
      };
      attempts.push(attempt);
      if (retryIndex === 0 && rejectedOptional) {
        retryCount += 1;
        retryReason = retryReason ?? "optional-field-rejection";
        request = stripOptionalRequest(request, normalized);
        continue;
      }
      break;
    }
  }

  return {
    ...original,
    mode: normalized.endpointUrl.hostname === "127.0.0.1" || normalized.endpointUrl.hostname === "localhost"
      ? "live-mock"
      : "live",
    runId,
    taskId,
    startedAt: probeStartedAt,
    finishedAt: nowIso(dependencies),
    attempts: attempts.map(({ stablePrefixText: _unused, ...attempt }) => attempt),
    retry: { count: retryCount, reason: retryReason },
    trace: traceAdapter(normalized, runId, taskId, attempts),
  };
}

function parseArgs(argv) {
  const values = {};
  const repeated = new Set(["allow-host"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) throw new ProbeConfigurationError("INVALID_ARGUMENT", `unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "live" || name === "allow-live") {
      values[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new ProbeConfigurationError("INVALID_ARGUMENT", `missing value for --${name}`);
    index += 1;
    if (repeated.has(name)) {
      values[name] = [...(values[name] ?? []), value];
    } else {
      values[name] = value;
    }
  }
  return values;
}

function usageText() {
  return [
    "Controlled agent-core provider cache probe (dry-run by default)",
    "",
    "Required: --endpoint URL --provider ID --model ID --protocol ID --retrieved-at ISO",
    "Optional: --source-url URL --session-id ID --api-key-env NAME",
    "          --allow-host HOST (loopback mock only) --live --allow-live",
    "",
    "Live mode requires --live plus --allow-live (or TERMINA_PROVIDER_PROBE_ALLOW_LIVE=1).",
    "The report contains hashes and redacted headers, never request/response bodies.",
  ].join("\n");
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usageText());
      return;
    }
    const provider = args.provider;
    const keyEnv = args["api-key-env"] ?? ({ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", xai: "XAI_API_KEY", openrouter: "OPENROUTER_API_KEY" }[provider] ?? "");
    const report = await runProviderCacheProbe({
      endpoint: args.endpoint,
      provider,
      model: args.model,
      protocol: args.protocol,
      sessionId: args["session-id"],
      sourceUrl: args["source-url"],
      retrievedAt: args["retrieved-at"],
      apiKey: keyEnv ? process.env[keyEnv] ?? "" : "",
      allowHosts: args["allow-host"],
      live: args.live === true,
      allowLive: args["allow-live"] === true,
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const code = error instanceof ProbeConfigurationError ? error.code : "PROBE_ERROR";
    console.error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) void main();
