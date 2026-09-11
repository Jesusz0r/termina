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
import type {
  CacheIdentity,
  ProviderId,
  ProviderProtocol,
} from "../../../agent-core/auth.ts";
import type {
  CompletionsOpts,
  KernelMessage,
  ProviderUsage,
  ToolDef,
} from "../../../agent-core/openai-compat.ts";

type ProbeRoute =
  | { readonly protocols: readonly string[]; readonly hosts: readonly string[] }
  | { readonly disabled: boolean };

interface NormalizedFixture {
  id: string;
  system: string;
  firstUser: string;
  assistant: string;
  secondUser: string;
  tool: typeof FIXTURE.tool;
  targetBytes: number | null;
}

interface NormalizedProbeConfig {
  endpoint: string;
  endpointUrl: URL;
  provider: string;
  model: string;
  protocol: string;
  sessionId: string;
  sessionSeed: string;
  cacheIdentity: CacheIdentity;
  sourceUrl: string;
  retrievedAt: string;
  fixture: NormalizedFixture;
  repeat: number;
  gapsMs: number[];
  waitForGaps: boolean;
  timeoutMs: number;
  apiKey: string;
  live: boolean;
  allowLive: boolean;
  allowHosts: string[];
}

interface ProbePolicy {
  namespace: string;
  cacheFields: string[];
  markerCount: number;
  markerPositions: number[];
  ttl: unknown;
  ttlMs: number | null;
  mode: string;
  requested: boolean;
  providerAcceptance: string;
}

interface PublicPolicy {
  namespace: string | null;
  cacheFields: string[];
  markerCount: number;
  markerPositions: number[] | null;
  ttl: unknown;
  ttlMs: number | null;
  mode: string;
  requested: boolean;
  providerAcceptance: string;
}

interface ProbeRequest {
  method: string;
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  bodyText: string;
  stablePrefixText: string;
  requestedPolicy: ProbePolicy;
  effectivePolicy: ProbePolicy;
}

interface AnthropicProbeMessage {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>> | string;
}

interface CacheWriteBreakdown {
  ephemeral5m: number | null;
  ephemeral1h: number | null;
}

interface ProbeUsage extends ProviderUsage {
  cacheWriteBreakdown?: CacheWriteBreakdown | undefined;
}

interface ProbeResponseData {
  rawBody: string;
  responseHash: string | null;
  responseHashScope: string;
  payload: unknown;
  oversized: boolean;
}

export interface ProbeFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: "manual";
  signal: AbortSignal;
}

export type ProbeFetch = (input: string, init: ProbeFetchInit) => Promise<unknown>;

interface ProbeDependencies {
  now?: () => unknown;
  env?: Record<string, string | undefined>;
  fetchImpl?: ProbeFetch;
}

interface ProbeAttempt {
  attempt: number;
  repeatIndex: number;
  gapBeforeMs: number;
  attemptId: string;
  retryOfAttemptId: string | null;
  retryIndex: number;
  startedAt: string;
  finishedAt: string;
  httpStatus: number | null;
  ok: boolean;
  requestBodyHash: string;
  stablePrefixHash: string;
  stablePrefixText: string;
  stablePrefixByteLength: number;
  stablePrefixByteIdentical: boolean;
  requestedPolicy: PublicPolicy;
  effectivePolicy: PublicPolicy;
  policyAcceptance: string;
  cacheObservation: string;
  missCause: string;
  usage: ProbeUsage;
  responseHash: string | null;
  responseHashScope: string;
  responseOversized: boolean;
  redactedHeaders: Record<string, string>;
  errorKind?: string | undefined;
  error?: string | null | undefined;
}

interface TracePolicyView {
  mode: string | null;
  ttlMs: number | null;
  namespace: string | null;
  markerCount: number | null;
  markerPositions: number[] | null;
  rejected: boolean | null;
  fallbackReason: string | null;
}

interface PublicPlan {
  method: string;
  endpoint: string;
  headers: Record<string, string>;
  requestBodyHash: string;
  stablePrefixHash: string;
  stablePrefixByteLength: number;
  fixtureSizeBytes: number;
  requestedPolicy: PublicPolicy;
  schedule: { repeat: number; gapsMs: number[]; waitForGaps: boolean };
}

interface ProbePlan {
  schemaVersion: number;
  fixtureId: string;
  provider: string;
  model: string;
  protocol: string;
  source: { url: string; retrievedAt: string };
  requestPlan: PublicPlan;
}

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
const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|x-session-id|x-opencode-session|x-grok-conv-id)$/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const SOURCE_URLS: Record<string, string> = Object.freeze({
  anthropic: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  openai: "https://developers.openai.com/api/docs/guides/prompt-caching",
  xai: "https://docs.x.ai/developers/advanced-api-usage/prompt-caching",
  openrouter: "https://openrouter.ai/docs/guides/best-practices/prompt-caching",
});

const ROUTES: Record<string, ProbeRoute> = Object.freeze({
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

function normalizeFixture(value: unknown): NormalizedFixture {
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
  const targetBytes: unknown = value.targetBytes;
  if (typeof targetBytes !== "number" || !Number.isSafeInteger(targetBytes) || targetBytes < 1 || targetBytes > MAX_RESPONSE_BYTES) {
    throw new ProbeConfigurationError("INVALID_FIXTURE", `fixture.targetBytes must be an integer from 1 to ${MAX_RESPONSE_BYTES}`);
  }
  const base: NormalizedFixture = {
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
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProbeConfigurationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasControl(value: unknown): boolean {
  return typeof value === "string" && /\p{Cc}/u.test(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item: unknown) => stableStringify(item)).join(",")}]`;
  const entries: string[] = Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
  return `{${entries.join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (!Number.isFinite(date.getTime())) {
    throw new ProbeConfigurationError("INVALID_TIMESTAMP", `${field} must be an ISO timestamp`);
  }
  return date.toISOString();
}

function safeSourceUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new ProbeConfigurationError("INVALID_SOURCE", "sourceUrl must be an https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ProbeConfigurationError("INVALID_SOURCE", "sourceUrl must be a credential-free https URL");
  }
  return url.toString();
}

function safeEndpoint(value: unknown): URL {
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new ProbeConfigurationError("INVALID_ENDPOINT", "endpoint must be an http(s) URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProbeConfigurationError("INVALID_ENDPOINT", "endpoint must be a credential-free http(s) URL");
  }
  return url;
}

function validateRoute(provider: string, protocol: string, endpoint: URL, allowHosts: unknown): void {
  const route = ROUTES[provider];
  if (!route) throw new ProbeConfigurationError("UNSUPPORTED_PROVIDER", `unsupported probe provider: ${provider}`);
  if ("disabled" in route) {
    throw new ProbeConfigurationError("PROBE_DISABLED", `${provider} compatibility cache probing is disabled until the route is documented`);
  }
  if (!route.protocols.includes(protocol)) {
    throw new ProbeConfigurationError("PROTOCOL_NOT_ALLOWED", `${provider} does not allow ${protocol} in this probe`);
  }
  const host = endpoint.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) {
    const explicit = Array.isArray(allowHosts) && allowHosts.some((item: unknown) => String(item).toLowerCase() === host);
    if (!explicit) {
      throw new ProbeConfigurationError("ROUTE_NOT_ALLOWED", "loopback endpoints require an explicit allowHosts entry");
    }
    return;
  }
  if (!route.hosts.includes(host)) {
    throw new ProbeConfigurationError("ROUTE_NOT_ALLOWED", `${provider} endpoint host is not in the probe allowlist`);
  }
}

function normalizeConfig(config: unknown): NormalizedProbeConfig {
  if (!isRecord(config)) throw new ProbeConfigurationError("INVALID_CONFIG", "probe config must be an object");
  for (const field of ["endpoint", "provider", "model", "protocol"]) {
    if (!nonempty(config[field])) {
      throw new ProbeConfigurationError("MISSING_FIELD", `probe config requires ${field}`);
    }
  }
  const endpoint = safeEndpoint(config.endpoint);
  // The loop above guarantees these fields are non-empty strings.
  const provider = (config.provider as string).trim().toLowerCase();
  const model = (config.model as string).trim();
  const protocol = (config.protocol as string).trim().toLowerCase();
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
    provider: provider as ProviderId,
    protocol: protocol as ProviderProtocol,
    route: endpoint.toString(),
  });
  if (!cacheIdentity) {
    throw new ProbeConfigurationError("INVALID_IDENTITY", "canonical cache identity could not be derived for this route");
  }
  const repeat: unknown = config.repeat === undefined ? 1 : config.repeat;
  if (typeof repeat !== "number" || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
    throw new ProbeConfigurationError("INVALID_REPEAT", `repeat must be an integer from 1 to ${MAX_REPEAT}`);
  }
  const gapsMs: unknown = config.gapsMs === undefined ? [] : config.gapsMs;
  if (!Array.isArray(gapsMs) || gapsMs.length > repeat - 1 || gapsMs.some((gap: unknown) => typeof gap !== "number" || !Number.isFinite(gap) || gap < 0 || gap > MAX_GAP_MS)) {
    throw new ProbeConfigurationError("INVALID_GAPS", `gapsMs must contain at most ${repeat - 1} gaps from 0 to ${MAX_GAP_MS}ms`);
  }
  const timeoutMs: unknown = config.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : config.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
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
    gapsMs: gapsMs.map((gap: number) => Math.trunc(gap)),
    waitForGaps: config.waitForGaps === true,
    timeoutMs,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    live: config.live === true,
    allowLive: config.allowLive === true,
    allowHosts: Array.isArray(config.allowHosts) ? config.allowHosts.map(String) : [],
  };
}

function deriveProbeKey(config: NormalizedProbeConfig): string {
  return config.cacheIdentity.key;
}

function cloneWithoutOptionalFields(value: Record<string, unknown>): Record<string, unknown>;
function cloneWithoutOptionalFields(value: unknown[]): unknown[];
function cloneWithoutOptionalFields(value: unknown): unknown;
function cloneWithoutOptionalFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => cloneWithoutOptionalFields(item));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (OPTIONAL_BODY_FIELDS.has(key)) continue;
    result[key] = cloneWithoutOptionalFields(child);
  }
  return result;
}

function redactHeaders(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(headers)) return result;
  for (const [name, value] of Object.entries(headers)) {
    result[name] = SENSITIVE_HEADERS.test(name) ? "[REDACTED]" : String(value);
  }
  return result;
}

function strippedHeaders(headers: Record<string, string>): Record<string, string>;
function strippedHeaders(headers: unknown): Record<string, unknown>;
function strippedHeaders(headers: unknown): Record<string, unknown> {
  if (!isRecord(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !OPTIONAL_HEADERS.has(name.toLowerCase())),
  );
}

function modelIsGpt56OrLater(model: string): boolean {
  const leaf = model.trim().toLowerCase().split("/").at(-1) ?? "";
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:[.-]|$)/.exec(leaf);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major > 5 || (major === 5 && minor >= 6);
}

function modelSupportsOpenRouterBreakpoint(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return modelIsGpt56OrLater(normalized) || normalized.includes("claude") || normalized.includes("gemini");
}

function anthropicMessages(fixture: NormalizedFixture): AnthropicProbeMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: fixture.firstUser }] },
    { role: "assistant", content: fixture.assistant },
    { role: "user", content: [{ type: "text", text: fixture.secondUser }] },
  ];
}

function kernelMessages(fixture: NormalizedFixture): KernelMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: fixture.firstUser }] },
    { role: "assistant", content: fixture.assistant },
    { role: "user", content: [{ type: "text", text: fixture.secondUser }] },
  ];
}

function probeToolDef(fixture: NormalizedFixture): ToolDef {
  return {
    name: fixture.tool.name,
    description: fixture.tool.description,
    input_schema: fixture.tool.parameters,
  };
}

function buildRequest(config: NormalizedProbeConfig, includeOptional = true): ProbeRequest {
  const key = deriveProbeKey(config);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "termina-agent-core-provider-probe/1",
  };
  if (config.apiKey) {
    if (config.provider === "anthropic") headers["x-api-key"] = config.apiKey;
    else headers.authorization = `Bearer ${config.apiKey}`;
  }
  Object.assign(headers, auth.cacheSessionHeaders(config.cacheIdentity));

  let body: Record<string, unknown>;
  if (config.provider === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    const system: Array<Record<string, unknown>> = [{ type: "text", text: config.fixture.system }];
    body = {
      model: config.model,
      max_tokens: 16,
      stream: false,
      system,
      messages: anthropicMessages(config.fixture),
    };
    if (includeOptional) {
      system[0].cache_control = { type: "ephemeral", ttl: "1h" };
    }
  } else if (config.protocol === "openai-responses") {
    const options: CompletionsOpts = {
      provider: config.provider,
      maxTokens: 16,
      ...(includeOptional && config.provider === "openai" && modelIsGpt56OrLater(config.model)
        ? {
          cacheKey: key,
          promptCacheMode: "explicit" as const,
          explicitCacheBreakpoint: true,
        }
        : {}),
      ...(includeOptional && config.provider === "openrouter"
        ? {
          cacheKey: key,
          sessionId: key,
          ...(modelSupportsOpenRouterBreakpoint(config.model) ? { explicitCacheBreakpoint: true } : {}),
          ...(modelIsGpt56OrLater(config.model) ? { promptCacheMode: "explicit" as const } : {}),
        }
        : {}),
      ...(includeOptional && config.provider === "xai" ? { cacheKey: key } : {}),
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
    const options: CompletionsOpts = {
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

function cacheFieldsFor(body: Record<string, unknown>, headers: Record<string, string>): string[] {
  const fields = new Set<string>();
  const visit = (value: unknown): void => {
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

function markerCount(body: Record<string, unknown>): number {
  let count = 0;
  const visit = (value: unknown): void => {
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

function markerPositions(body: Record<string, unknown>): number[] {
  const positions: number[] = [];
  let position = 0;
  const visit = (value: unknown): void => {
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

function ttlMilliseconds(ttl: unknown): number | null {
  if (ttl === "5m") return 5 * 60 * 1000;
  if (ttl === "30m") return 30 * 60 * 1000;
  if (ttl === "1h") return 60 * 60 * 1000;
  return null;
}

function policyFor(config: NormalizedProbeConfig, body: Record<string, unknown>, headers: Record<string, string>, requested: boolean): ProbePolicy {
  const fields = cacheFieldsFor(body, headers);
  let ttl: unknown = null;
  if (Object.hasOwn(body, "prompt_cache_options")) {
    const promptCacheOptions = body.prompt_cache_options as { ttl?: unknown } | null | undefined;
    if (promptCacheOptions?.ttl) ttl = promptCacheOptions.ttl;
  }
  if (fields.includes("cache_control")) {
    const system = body.system as Array<{ cache_control?: unknown }> | null | undefined;
    const cacheControl = system?.[0]?.cache_control as { ttl?: unknown } | null | undefined;
    ttl = cacheControl?.ttl ?? null;
  }
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

function stripOptionalRequest(request: ProbeRequest, config: NormalizedProbeConfig): ProbeRequest {
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

function usageNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = usageNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function usageFromPayload(provider: string, protocol: string, payload: unknown): ProbeUsage {
  const container: Record<string, unknown> | null =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const usage = container && isRecord(container.usage)
    ? container.usage
    : container && isRecord(container.usageMetadata)
      ? container.usageMetadata
      : null;
  const empty: ProbeUsage = { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null };
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
  const payloadOutput: unknown = container?.output;
  const parsed = protocol === "openai-responses"
    ? compat.responsesResultFromEvents([{
      type: "response.completed",
      response: { ...(container ?? {}), output: Array.isArray(payloadOutput) ? payloadOutput : [], usage },
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

function optionalFieldRejection(status: unknown, rawBody: unknown): boolean {
  if (status !== 400 && status !== 422) return false;
  const text = String(rawBody ?? "").toLowerCase();
  return [
    "prompt_cache",
    "cache_control",
    "session_id",
    "x-grok-conv-id",
  ].some((field) => text.includes(field));
}

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | null | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => { signal.removeEventListener("abort", onAbort); };
    const onAbort = (): void => {
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
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

async function readResponse(response: unknown, signal: AbortSignal | null | undefined): Promise<ProbeResponseData> {
  const fetchResponse = response as {
    body?: { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null;
    text: () => Promise<string>;
  };
  const reader = fetchResponse?.body && typeof fetchResponse.body.getReader === "function" ? fetchResponse.body.getReader() : null;
  if (reader) {
    const chunks: Uint8Array[] = [];
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
    let payload: unknown = null;
    try {
      payload = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      payload = null;
    }
    return { rawBody, responseHash, responseHashScope: "full", payload, oversized: false };
  }
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  const raw = await fetchResponse.text();
  const bytes = Buffer.from(raw, "utf8");
  const oversized = bytes.byteLength > MAX_RESPONSE_BYTES;
  const bounded = oversized ? bytes.subarray(0, MAX_RESPONSE_BYTES) : bytes;
  const rawBody = bounded.toString("utf8");
  const responseHash = sha256Bytes(bounded);
  if (oversized) return { rawBody, responseHash, responseHashScope: "bounded-prefix", payload: null, oversized: true };
  let payload: unknown = null;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    payload = null;
  }
  return { rawBody, responseHash, responseHashScope: "full", payload, oversized: false };
}

function nowIso(dependencies: ProbeDependencies): string {
  const value = typeof dependencies?.now === "function" ? dependencies.now() : new Date();
  return isoTimestamp(value, "clock");
}

function waitForGap(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function responseErrorKind(response: unknown, normalized: NormalizedProbeConfig): string | null {
  const fetchResponse = response as { status?: unknown; redirected?: unknown; url?: unknown } | null | undefined;
  const fetchStatus: unknown = fetchResponse?.status;
  const status = Number.isInteger(fetchStatus) ? (fetchStatus as number) : null;
  if (status !== null && status >= 300 && status < 400) return "redirect-rejected";
  if (fetchResponse?.redirected === true) return "redirect-rejected";
  const responseUrl: unknown = fetchResponse?.url;
  if (typeof responseUrl === "string" && responseUrl && responseUrl !== normalized.endpoint) {
    try {
      validateRoute(normalized.provider, normalized.protocol, new URL(responseUrl), normalized.allowHosts);
    } catch {
      return "redirect-route-rejected";
    }
    return "redirect-rejected";
  }
  return null;
}

function tracePolicy(policy: PublicPolicy | null | undefined, rejected: boolean, fallbackReason: string | null): TracePolicyView {
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

function traceAdapter(normalized: NormalizedProbeConfig, runId: string, taskId: string, attempts: ProbeAttempt[]) {
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

function publicPolicy(policy: ProbePolicy | null | undefined): PublicPolicy {
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

function publicPlan(config: NormalizedProbeConfig, request: ProbeRequest): PublicPlan {
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

function buildProbePlanFromNormalized(normalized: NormalizedProbeConfig): ProbePlan {
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
export function buildProbePlan(config: unknown): ProbePlan {
  return buildProbePlanFromNormalized(normalizeConfig(config));
}

/**
 * Run one controlled probe. The returned object never contains request or
 * response bodies. A 400/422 mentioning an optional cache field gets one—and
 * only one—retry with all optional cache fields removed.
 */
export async function runProviderCacheProbe(config: unknown, dependencies: ProbeDependencies = {}) {
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
  const attempts: ProbeAttempt[] = [];
  let retryCount = 0;
  let retryReason: string | null = null;
  let stablePrefixReference: string | null = null;
  for (let repeatIndex = 0; repeatIndex < normalized.repeat; repeatIndex += 1) {
    const gapBeforeMs = repeatIndex > 0 ? normalized.gapsMs[repeatIndex - 1] ?? 0 : 0;
    if (normalized.waitForGaps && gapBeforeMs > 0) await waitForGap(gapBeforeMs);
    let request = buildRequest(normalized, true);
    for (let retryIndex = 0; retryIndex < 2; retryIndex += 1) {
      const startedAt = nowIso(dependencies);
      const attemptId = `probe-attempt-${repeatIndex + 1}-${retryIndex + 1}-${sha256(`${runId}\0${repeatIndex}\0${retryIndex}`).slice(0, 16)}`;
      const retryOfAttemptId = retryIndex > 0 ? attempts.at(-1)?.attemptId ?? null : null;
      let response: unknown;
      let responseData: ProbeResponseData = { rawBody: "", responseHash: null, responseHashScope: "full", payload: null, oversized: false };
      let errorKind: string | null = null;
      let errorMessage: string | null = null;
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
      const fetchStatus: unknown = (response as { status?: unknown } | null | undefined)?.status;
      const status = Number.isInteger(fetchStatus) ? (fetchStatus as number) : null;
      const rejectedOptional = !errorKind && optionalFieldRejection(status, responseData.rawBody);
      const usage = errorKind ? { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null } : usageFromPayload(normalized.provider, normalized.protocol, responseData.payload);
      const stablePrefixByteIdentical = stablePrefixReference === null || stablePrefixReference === request.stablePrefixText;
      if (stablePrefixReference === null) stablePrefixReference = request.stablePrefixText;
      const cacheObservation = usage.cacheRead !== null || usage.cacheWrite !== null ? "reported" : "unknown";
      const fetchOk: unknown = (response as { ok?: unknown } | null | undefined)?.ok;
      const attempt: ProbeAttempt = {
        attempt: attempts.length + 1,
        repeatIndex,
        gapBeforeMs,
        attemptId,
        retryOfAttemptId,
        retryIndex,
        startedAt,
        finishedAt,
        httpStatus: status,
        ok: !errorKind && Boolean(fetchOk ?? (status !== null && status >= 200 && status < 300)),
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

function parseArgs(argv: string[]): Record<string, string | boolean | string[]> {
  const values: Record<string, string | boolean | string[]> = {};
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
      const prior = values[name];
      values[name] = [...(Array.isArray(prior) ? prior : []), value];
    } else {
      values[name] = value;
    }
  }
  return values;
}

function usageText(): string {
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

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usageText());
      return;
    }
    const provider = args.provider;
    const providerKey = typeof provider === "string" ? provider : "";
    const defaultKeyEnv: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      xai: "XAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    };
    const keyEnv = args["api-key-env"] ?? defaultKeyEnv[providerKey] ?? "";
    const apiKey = typeof keyEnv === "string" && keyEnv ? process.env[keyEnv] ?? "" : "";
    const report = await runProviderCacheProbe({
      endpoint: args.endpoint,
      provider,
      model: args.model,
      protocol: args.protocol,
      sessionId: args["session-id"],
      sourceUrl: args["source-url"],
      retrievedAt: args["retrieved-at"],
      apiKey,
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
