/**
 * Live probe: explicit-breakpoint acceptance boundary on the Codex Responses
 * route (roadmap P0 §8).
 *
 * OpenAI sources conflict on a 50-vs-80 breakpoint/lookback number; the repo
 * never hardcodes either and the serializer caps explicit markers at 4. This
 * probe hand-stamps N explicit `prompt_cache_breakpoint` markers onto tiny
 * input blocks (same placement the serializer uses) and binary-searches the
 * route's accept/reject boundary. Own `tc1_probe_*` key namespace, tiny
 * bodies, no session state touched.
 *
 *   node --experimental-strip-types --no-warnings scripts/codex-breakpoint-probe.ts --live
 *
 * Without --live (or when imported), no credentials or network are accessed.
 * At most 8 inference requests, no retries, 20-second request deadlines and
 * a 1 MB response cap. Rejected calls should not bill; accepted calls are a
 * few dozen tokens each. Never print raw provider payloads or credentials.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAuth } from "../agent-core/auth.ts";
import { protocolEndpoint } from "../agent-core/auth/providers/endpoints.ts";
import { responsesBody } from "../agent-core/openai-compat.ts";
import { assertProbeAuthPath } from "./codex-cache-probe.ts";
import { ProbeFailure } from "./codex-cache-probe-transport.ts";

const MODEL = "gpt-6-astra";
const KEY = `tc1_probe_${Date.now().toString(36)}`;
const MARKER = { prompt_cache_breakpoint: { mode: "explicit" as const } };
const COUNTS = [1, 4, 10, 20, 40, 50, 60, 80];
const REQUEST_TIMEOUT_MS = 20_000;
const RESPONSE_MAX_BYTES = 1_048_576;

export type BreakpointProbeOpts = { timeoutMs?: number; maxBytes?: number };

/** Same placement as the serializer's markLatestInputTexts, with a chosen limit. */
function stampMarkers(input: Array<Record<string, unknown>>, limit: number): boolean {
  let marked = 0;
  for (let i = input.length - 1; i >= 0 && marked < limit; i--) {
    const item = input[i]!;
    for (const field of ["content", "output"] as const) {
      const partsValue = item[field];
      if (!Array.isArray(partsValue)) continue;
      for (let j = partsValue.length - 1; j >= 0; j--) {
        const part = partsValue[j] as Record<string, unknown>;
        if (!part || part["type"] !== "input_text" || typeof part["text"] !== "string") continue;
        if ("prompt_cache_breakpoint" in part) continue;
        const parts = partsValue.slice() as Array<Record<string, unknown>>;
        parts[j] = { ...part, ...MARKER };
        input[i] = { ...item, [field]: parts };
        marked += 1;
        break;
      }
      if (marked > 0 && input[i] !== item) break;
    }
  }
  return marked >= limit;
}

/** Consume a response body up to a byte cap; the verdict needs accept/reject only. */
async function readCappedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ProbeFailure("response-size-limit");
    }
  }
}

async function postStatus(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  opts: BreakpointProbeOpts,
): Promise<number> {
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { ...headers, accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: deadline,
    });
  } catch {
    if (deadline.aborted) throw new ProbeFailure("request-deadline");
    throw new ProbeFailure("request-failed");
  }
  try {
    if (!res.ok) throw new ProbeFailure(`HTTP ${res.status}`, res.status);
    await readCappedText(res.body, opts.maxBytes ?? RESPONSE_MAX_BYTES);
    return res.status;
  } finally {
    await res.body?.cancel().catch(() => {});
  }
}

async function send(
  blocks: number,
  markers: number,
  headers: Record<string, string>,
  url: string,
  opts: BreakpointProbeOpts,
): Promise<{ status: number; ok: boolean; error: string | null; stamped: number }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < blocks; i++) {
    messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `block ${i}: tiny probe text.` });
  }
  const body = responsesBody(MODEL, "You are a coding agent.", messages, [], {
    provider: "openai-codex",
    cacheKey: KEY,
    includeEncryptedReasoning: false,
  });
  const input = body["input"];
  if (!Array.isArray(input)) return { status: 0, ok: false, error: "serializer emitted no input array", stamped: 0 };
  const items = input as Array<Record<string, unknown>>;
  const stamped = stampMarkers(items, markers) ? markers : -1;
  try {
    const status = await postStatus(url, headers, body, opts);
    return { status, ok: true, error: null, stamped };
  } catch (error) {
    const status = error instanceof ProbeFailure ? error.status : null;
    const message = error instanceof ProbeFailure ? error.message : "request-failed";
    return { status: status ?? 0, ok: false, error: message, stamped };
  }
}

export async function runBreakpointProbe(
  args: string[] = process.argv.slice(2),
  opts: BreakpointProbeOpts = {},
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node --experimental-strip-types scripts/codex-breakpoint-probe.ts --live\n" +
        "Probe the Codex Responses route accept/reject boundary for explicit cache breakpoints.\n" +
        "Without --live, prints the plan and sends nothing.",
    );
    return 0;
  }
  if (!args.includes("--live")) {
    console.log(
      JSON.stringify({
        probe: "codex-breakpoint",
        model: MODEL,
        counts: COUNTS,
        maxRequests: COUNTS.length,
        live: false,
        note: "Pass --live to use provider quota.",
      }),
    );
    return 0;
  }
  assertProbeAuthPath();
  const auth = await resolveAuth("openai-codex", AbortSignal.timeout(10_000));
  if (!auth.ok) {
    console.log("verdict: credentials unavailable; no inference requests sent");
    return 2;
  }
  const url = protocolEndpoint(auth.baseUrl, MODEL, "openai-codex-responses", true);
  const headers = auth.headers as Record<string, string>;
  console.log(`route: ${url} key: ${KEY}`);

  let maxAccepted = 0;
  for (const count of COUNTS) {
    // One input_text part per block; use twice as many blocks as markers.
    const result = await send(count * 2, count, headers, url, opts);
    if (result.stamped !== count) {
      console.log(`count=${count}: could not stamp ${count} markers (serializer shape changed) — stopping`);
      break;
    }
    console.log(`count=${count}: status=${result.status} ${result.ok ? "ACCEPTED" : `REJECTED ${result.error}`}`);
    if (result.ok) maxAccepted = count;
    else break;
  }
  if (maxAccepted === 0) {
    console.log("verdict: route rejects even 1 explicit marker — explicit breakpoints unsupported here; serializer correctly withholds them");
  } else if (maxAccepted >= 80) {
    console.log("verdict: route accepts 80 markers — 50-vs-80 conflict moot on this route at this size; do not encode a limit");
  } else {
    console.log(`verdict: boundary between ${maxAccepted} and the next count — record maxAccepted=${maxAccepted} as the route/model observation, not a constant`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBreakpointProbe().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error("Probe failed; no credentials or raw provider payloads logged.");
      process.exitCode = 1;
    },
  );
}
