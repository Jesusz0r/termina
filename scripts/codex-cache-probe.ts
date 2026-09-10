/**
 * Bounded live follow-up to the Pi/OpenCode source audit. No production policy changes.
 *
 * node --experimental-strip-types --no-warnings scripts/codex-cache-probe.ts --live --group all --out /owned/tmp/results.json
 *
 * identity: Codex SSE, no identifiers / key only / key + aligned Pi session headers.
 * transport: Codex SSE full replay / reused WebSocket full replay / WS incremental continuation.
 * mode: PUBLIC OpenAI implicit / Termina's explicit mode and marker placement.
 *
 * Three requests per arm, <=24 total, no inference retries or silent transport fallback.
 * Requests have 20s deadlines; the whole probe has a 4-minute deadline. Synthetic
 * prompts only, store:false, tiny requested answers. Missing credentials skip a group.
 * Use of account quota/billing is intentional only with --live. Acceptance is NOT
 * evidence of a cache hit; a few misses do not establish backend policy.
 *
 * https://developers.openai.com/api/docs/guides/prompt-caching
 * https://developers.openai.com/api/docs/guides/websocket-mode
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { authPath, resolveAuth } from "../agent-core/auth.ts";
import { protocolEndpoint } from "../agent-core/auth/providers/endpoints.ts";
import { responsesBody, stripResponsesBreakpoints, usageFromOpenAI } from "../agent-core/openai-compat.ts";
import { httpTransport, websocketTransport, ProbeFailure, type Json, type ProbeTransport } from "./codex-cache-probe-transport.ts";

export const MODEL = "gpt-6-astra";
export const TURNS = 3;
export const MAX_REQUESTS = 24;
export type Group = "identity" | "transport" | "mode";
type Provider = "openai-codex" | "openai";
export type Arm = {
  name: string;
  identity: "none" | "key" | "aligned";
  wire: "http" | "websocket";
  incremental?: boolean;
  explicit?: boolean;
};
export const ARMS: Record<Group, readonly Arm[]> = {
  identity: [
    { name: "no-identifiers", identity: "none", wire: "http" },
    { name: "key-only", identity: "key", wire: "http" },
    { name: "aligned-identifiers", identity: "aligned", wire: "http" },
  ],
  transport: [
    { name: "sse-full", identity: "aligned", wire: "http" },
    { name: "ws-full", identity: "aligned", wire: "websocket" },
    { name: "ws-incremental", identity: "aligned", wire: "websocket", incremental: true },
  ],
  mode: [
    { name: "implicit", identity: "key", wire: "http" },
    { name: "explicit", identity: "key", wire: "http", explicit: true },
  ],
};
const SYSTEM = "This is a synthetic transport benchmark. Answer only with the verification code in the first user message. No explanation, punctuation, or tools.";
const QUESTION = "Return the verification code from the first user message, exactly and nothing else.";
export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function prepareArm(group: Group, arm: Arm, runId: string) {
  const provider: Provider = group === "mode" ? "openai" : "openai-codex";
  const key = `probe_${hash([runId, group, arm.name]).slice(0, 48)}`;
  const code = hash([key, "verification"]).slice(0, 12).toUpperCase();
  // Different early nonces prevent one arm warming another; shape/length and corpus
  // are matched. Within identity/mode arms the three wire requests are identical.
  const prefix = `Verification code: ${code}. Namespace: ${key}.\n` + Array.from({ length: 140 }, (_, i) =>
    `Record ${i}: amber station has a ready worker, stable tools, deterministic inputs, and no pending changes.`,
  ).join("\n");
  const body = responsesBody(MODEL, SYSTEM, [
    { role: "user", content: prefix }, { role: "user", content: QUESTION },
  ], [], {
    provider, reasoningEffort: "low", textVerbosity: "low",
    ...(arm.identity === "none" ? {} : { cacheKey: key }),
    ...(provider === "openai" ? { maxTokens: 64 } : {}),
    ...(arm.explicit ? { promptCacheMode: "explicit", explicitCacheBreakpoint: true } : {}),
  });
  const headers: Record<string, string> = arm.identity === "aligned"
    ? { "session-id": key, "x-client-request-id": key } : {};
  return { provider, body, headers, code, prefixHash: hash(prefix) };
}

function logicalHash(body: Json): string {
  const clean = stripResponsesBreakpoints(body);
  delete clean.prompt_cache_key;
  return hash(clean);
}

export type Sample = {
  group: Group; arm: string; turn: number; ok: boolean; error?: string; status?: number | null;
  bodyHash: string; logicalHash: string; prefixHash: string; inputBytes: number; usedPreviousResponse: boolean;
  elapsedMs?: number; firstTextMs?: number | null; connectMs?: number; requestBytes?: number;
  totalInput?: number | null; responseModel?: string | null; serviceTier?: string | null;
  usage?: ReturnType<typeof usageFromOpenAI>; outputMatches?: boolean;
};
type Access = { baseUrl: string; headers: Record<string, string> };
type TransportFactory = (wire: Arm["wire"], url: string, headers: Record<string, string>, signal: AbortSignal) => ProbeTransport;
const realTransport: TransportFactory = (wire, url, headers, signal) =>
  wire === "http" ? httpTransport(url, headers, signal) : websocketTransport(url, headers, signal);

/** Shared live-probe boundaries; never read the host Pi credential tree. */
export function assertProbeAuthPath(): void {
  const file = existsSync(authPath()) ? realpathSync(authPath()) : resolve(authPath());
  const forbidden = join(homedir(), ".pi", "agent");
  if (file === forbidden || file.startsWith(forbidden + sep)) throw new Error("Refusing host Pi auth tree");
}

export function probeEndpoint(baseUrl: string, provider: Provider): string {
  const protocol = provider === "openai" ? "openai-responses" : "openai-codex-responses";
  const url = protocolEndpoint(baseUrl, MODEL, protocol, true);
  const expected = provider === "openai" ? "https://api.openai.com/v1/responses" : "https://chatgpt.com/backend-api/codex/responses";
  if (url !== expected) throw new ProbeFailure("refusing-noncanonical-provider-route");
  return url;
}

export async function runGroup(
  group: Group, access: Access, runId: string, signal: AbortSignal,
  onSample: (sample: Sample) => void = () => {}, makeTransport: TransportFactory = realTransport,
): Promise<Sample[]> {
  const states = ARMS[group].map((arm) => {
    const prepared = prepareArm(group, arm, runId);
    const url = probeEndpoint(access.baseUrl, prepared.provider);
    return {
      arm, ...prepared, transport: makeTransport(arm.wire, url, { ...access.headers, ...prepared.headers }, signal),
      fullInput: prepared.body.input as Json[], previousId: null as string | null, failed: false,
    };
  });
  const samples: Sample[] = [];
  let blocked = false;
  try {
    // Rotate order on each round, rather than running every baseline before every treatment.
    for (let turn = 0; turn < TURNS && !blocked && !signal.aborted; turn++) {
      const ordered = [...states.slice(turn % states.length), ...states.slice(0, turn % states.length)];
      for (const state of ordered) {
        if (state.failed || signal.aborted) continue;
        const fullBody = { ...state.body, input: state.fullInput };
        const body: Json = state.arm.incremental && turn > 0
          ? { ...fullBody, previous_response_id: state.previousId, input: state.fullInput.slice(-1) }
          : fullBody;
        const sample: Sample = {
          group, arm: state.arm.name, turn: turn + 1, ok: false,
          bodyHash: hash(body), logicalHash: logicalHash(fullBody), prefixHash: state.prefixHash,
          inputBytes: Buffer.byteLength(JSON.stringify(body.input)), usedPreviousResponse: Boolean(body.previous_response_id),
        };
        try {
          if (state.arm.incremental && turn > 0 && !state.previousId) throw new ProbeFailure("missing-continuation-id");
          const result = await state.transport.send(body);
          const raw = result.response.usage as Json | undefined;
          sample.ok = true;
          sample.elapsedMs = result.elapsedMs;
          sample.firstTextMs = result.firstTextMs;
          sample.connectMs = result.connectMs;
          sample.requestBytes = result.requestBytes;
          sample.totalInput = typeof raw?.input_tokens === "number" ? raw.input_tokens : null;
          sample.usage = usageFromOpenAI(raw);
          sample.responseModel = typeof result.response.model === "string" ? result.response.model : null;
          sample.serviceTier = typeof result.response.service_tier === "string" ? result.response.service_tier : null;
          sample.outputMatches = new RegExp(`\\b${state.code}\\b`, "i").test(result.text);
          if (!sample.outputMatches) throw new ProbeFailure("verification-code-mismatch");
          if (group === "transport") {
            if (!Array.isArray(result.response.output)) throw new ProbeFailure("missing-response-output");
            state.previousId = typeof result.response.id === "string" ? result.response.id : null;
            // Preserve actual output items (including encrypted reasoning) byte-for-byte.
            // The incremental request contains neither the code nor old messages.
            state.fullInput = [...state.fullInput, ...result.response.output, {
              role: "user", content: [{ type: "input_text", text: QUESTION }],
            }];
          }
        } catch (error) {
          sample.ok = false;
          sample.error = error instanceof ProbeFailure ? error.message : "transport-failure";
          sample.status = error instanceof ProbeFailure ? error.status : null;
          state.failed = true;
          state.transport.close();
          blocked = sample.status !== null && [401, 402, 403, 429].includes(sample.status!);
        }
        samples.push(sample);
        onSample(sample);
        if (blocked) break;
      }
    }
  } finally {
    for (const state of states) state.transport.close();
  }
  return samples;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2;
}

export function summarize(samples: Sample[]) {
  return [...new Set(samples.map((sample) => `${sample.group}/${sample.arm}`))].map((name) => {
    const rows = samples.filter((sample) => `${sample.group}/${sample.arm}` === name);
    const warm = rows.filter((sample) => sample.ok && sample.turn > 1);
    const known = warm.filter((sample) => typeof sample.usage?.cacheRead === "number" && typeof sample.totalInput === "number" && sample.totalInput > 0);
    return {
      arm: name, completed: rows.filter((sample) => sample.ok).length, attempted: rows.length,
      warmSamples: warm.length, measuredWarmSamples: known.length,
      warmReadFractions: known.map((sample) => sample.usage!.cacheRead! / sample.totalInput!),
      medianWarmMs: median(warm.flatMap((sample) => typeof sample.elapsedMs === "number" ? [sample.elapsedMs] : [])),
      medianWarmInputBytes: median(warm.map((sample) => sample.inputBytes)),
      errors: rows.flatMap((sample) => sample.error ? [sample.error] : []),
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const groupArg = args.indexOf("--group");
  const selected = groupArg < 0 ? "all" : args[groupArg + 1];
  if (selected !== "all" && selected !== "identity" && selected !== "transport" && selected !== "mode") throw new Error("Invalid --group");
  const groups: Group[] = selected === "all" ? ["identity", "transport", "mode"] : [selected];
  if (!args.includes("--live")) {
    console.log(JSON.stringify({ model: MODEL, groups, maxRequests: MAX_REQUESTS, live: false, note: "Pass --live to use provider quota; --out writes a new JSON result file." }));
    return;
  }
  assertProbeAuthPath();
  const outArg = args.indexOf("--out");
  if (outArg >= 0 && !args[outArg + 1]) throw new Error("Missing --out path");
  // Exclusive creation before any inference prevents overwriting another task's files.
  const fd = outArg >= 0 ? openSync(resolve(args[outArg + 1]!), "wx", 0o600) : null;
  const runId = randomUUID();
  const samples: Sample[] = [];
  const skipped: Array<{ group: Group; reason: string }> = [];
  const signal = AbortSignal.timeout(240_000);
  const auths = new Map<Provider, Awaited<ReturnType<typeof resolveAuth>>>();
  try {
    for (const group of groups) {
      const provider: Provider = group === "mode" ? "openai" : "openai-codex";
      if (signal.aborted) { skipped.push({ group, reason: "probe-deadline" }); continue; }
      let auth = auths.get(provider);
      if (!auth) {
        auth = await resolveAuth(provider, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
        auths.set(provider, auth);
      }
      if (!auth.ok) { skipped.push({ group, reason: `${provider}-credentials-unavailable` }); continue; }
      const denied = samples.some((sample) => sample.status != null && [401, 402, 403, 429].includes(sample.status));
      if (denied && provider === "openai-codex") { skipped.push({ group, reason: "provider-blocked-earlier" }); continue; }
      await runGroup(group, auth, runId, signal, (sample) => {
        samples.push(sample);
        console.log(JSON.stringify(sample));
      });
    }
    const result = { schemaVersion: 1, runId, at: new Date().toISOString(), model: MODEL, maxRequests: MAX_REQUESTS,
      productionPolicyChanged: false, samples, skipped, summary: summarize(samples),
      limitation: "Small exploratory sample; no cache-policy conclusion from acceptance or misses alone. Cross-arm prefixes are isolated, not identical. No application session content sent." };
    if (fd !== null) writeFileSync(fd, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ summary: result.summary, skipped }));
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Probe failed; no credentials or raw provider error bodies logged."); process.exitCode = 1; });
}
