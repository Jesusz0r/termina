/**
 * Live probe: xAI stable-key acceptance and retention (roadmap P0 §9/§12).
 *
 * xAI documents a stable session key (`x-grok-conv-id` on Chat Completions)
 * with no validated TTL. This probe sends the canonical derived identity as
 * the header on a ~1k-token prefix repeated twice back-to-back (acceptance +
 * immediate hit), then once more after a 75s idle gap (retention signal).
 * Own probe seed, tiny outputs, no session state touched.
 *
 *   node --experimental-strip-types --no-warnings scripts/xai-cache-probe.ts --live
 *
 * Without --live (or when imported), no credentials or network are accessed.
 * At most 4 inference requests, no retries, 20-second request deadlines and
 * a 1 MB response cap. XAI_PROBE_GAP_MS overrides the idle gap. Costs a few
 * cents at most (~1k input tokens x3 plus one-word outputs). Never print raw
 * provider payloads or credentials.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cacheIdentityFor, cacheSessionHeaders, resolveAuth } from "../agent-core/auth.ts";
import { protocolEndpoint } from "../agent-core/auth/providers/endpoints.ts";
import { completionResultFromEvents, completionsBody, readSseJson } from "../agent-core/openai-compat.ts";
import { assertProbeAuthPath } from "./codex-cache-probe.ts";
import { ProbeFailure } from "./codex-cache-probe-transport.ts";

const MODEL = "grok-4.6";
const DEFAULT_GAP_MS = 75_000;
const REQUEST_TIMEOUT_MS = 20_000;
const RESPONSE_MAX_BYTES = 1_048_576;

export type XaiProbeOpts = { timeoutMs?: number; maxBytes?: number };

/** Bounded completions POST parsed with the canonical SSE reader. Failures are redacted. */
async function postEvents(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  opts: XaiProbeOpts,
): Promise<{ status: number; events: Array<Record<string, unknown>> }> {
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { ...headers, accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      signal: deadline,
    });
  } catch {
    if (deadline.aborted) throw new ProbeFailure("request-deadline");
    throw new ProbeFailure("request-failed");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ProbeFailure(`HTTP ${res.status}`, res.status);
  }
  if (!res.body) throw new ProbeFailure("missing-response-stream");
  const maxBytes = opts.maxBytes ?? RESPONSE_MAX_BYTES;
  const events: Array<Record<string, unknown>> = [];
  let bytes = 0;
  try {
    await readSseJson(res.body, deadline, (event) => {
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (bytes > maxBytes) throw new ProbeFailure("response-size-limit");
      events.push(event);
      return false;
    });
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    if (deadline.aborted) throw new ProbeFailure("request-deadline");
    throw new ProbeFailure("invalid-response-stream");
  }
  if (deadline.aborted) throw new ProbeFailure("request-deadline");
  return { status: res.status, events };
}

async function send(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  headers: Record<string, string>,
  url: string,
  opts: XaiProbeOpts,
): Promise<{ ok: boolean; status: number; usage: Record<string, unknown> | null; error: string | null }> {
  const body = completionsBody(MODEL, "You are a coding agent.", messages, [], "max_tokens", {
    provider: "xai",
    maxTokens: 16,
  }) as unknown as Record<string, unknown>;
  try {
    const { status, events } = await postEvents(url, headers, body, opts);
    const result = completionResultFromEvents(events, () => {}, Date.now());
    const usage = result.usage ? { ...(result.usage as Record<string, unknown>) } : null;
    return { ok: true, status, usage, error: null };
  } catch (error) {
    const status = error instanceof ProbeFailure ? error.status : null;
    const message = error instanceof ProbeFailure ? error.message : "request-failed";
    return { ok: false, status: status ?? 0, usage: null, error: message };
  }
}

export async function runXaiProbe(args: string[] = process.argv.slice(2), opts: XaiProbeOpts = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node --experimental-strip-types scripts/xai-cache-probe.ts --live\n" +
        "Probe xAI stable-key acceptance and retention with a repeated ~1k-token prefix.\n" +
        "Without --live, prints the plan and sends nothing.",
    );
    return 0;
  }
  if (!args.includes("--live")) {
    console.log(
      JSON.stringify({
        probe: "xai-cache",
        model: MODEL,
        maxRequests: 4,
        live: false,
        note: "Pass --live to use provider quota.",
      }),
    );
    return 0;
  }
  assertProbeAuthPath();
  const auth = await resolveAuth("xai", AbortSignal.timeout(10_000));
  if (!auth.ok) {
    console.log("verdict: credentials unavailable; no inference requests sent");
    return 2;
  }
  const url = protocolEndpoint(auth.baseUrl, MODEL, "openai-completions", true);
  const baseHeaders = auth.headers as Record<string, string>;
  const seed = process.env.XAI_PROBE_SEED ?? `probe-${Date.now().toString(36)}`;
  const gapRaw = Number(process.env.XAI_PROBE_GAP_MS ?? DEFAULT_GAP_MS);
  const gapMs = Number.isFinite(gapRaw) && gapRaw >= 0 ? gapRaw : DEFAULT_GAP_MS;
  const identity = cacheIdentityFor({
    sessionSeed: seed,
    role: "main",
    provider: "xai",
    protocol: "openai-completions",
    route: "api.x.ai",
  });
  const sessionHeaders = identity ? cacheSessionHeaders(identity) : {};
  console.log(`route: ${url} session-header: ${Object.keys(sessionHeaders).join(",") || "(none derived)"}`);
  if (Object.keys(sessionHeaders).length === 0) {
    console.log("verdict: no session header derived — identity owner refuses this route; retention untestable, do not hand-roll a key");
    return 1;
  }
  const headers = { ...baseHeaders, ...sessionHeaders };

  const tiny = await send([{ role: "user", content: "Reply with exactly the word ok." }], headers, url, opts);
  if (!tiny.ok) {
    console.log(`REJECTED status=${tiny.status} error=${tiny.error}`);
    console.log("verdict: request with the session header rejected — record the rejection, do not retry with a different header");
    return 1;
  }
  console.log(`ACCEPTED status=${tiny.status} usage=${JSON.stringify(tiny.usage)}`);

  const filler = Array.from({ length: 150 }, (_, i) => `probe sentence ${i}: the session header pins repeated prefixes to warm state.`).join(" ");
  const shared: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: filler }];
  const first = await send([...shared, { role: "user", content: "First: reply yes." }], headers, url, opts);
  console.log(`first  usage=${JSON.stringify(first.usage)}`);
  const second = await send([...shared, { role: "user", content: "Second: reply yes." }], headers, url, opts);
  console.log(`second usage=${JSON.stringify(second.usage)}`);

  await new Promise((resolveTimer) => setTimeout(resolveTimer, gapMs));
  const third = await send([...shared, { role: "user", content: "Third: reply yes." }], headers, url, opts);
  console.log(`third  usage=${JSON.stringify(third.usage)} (+${Math.round(gapMs / 1000)}s gap)`);
  console.log("verdict: compare input/cache-hit fields across first/second/third — a warm second with a cold third bounds the TTL; warm throughout means retention exceeds the gap; all-cold means the header buys nothing on this route");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runXaiProbe().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error("Probe failed; no credentials or raw provider payloads logged.");
      process.exitCode = 1;
    },
  );
}
