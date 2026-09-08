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
 *   node --experimental-strip-types --no-warnings scripts/codex-breakpoint-probe.ts
 *
 * Rejected calls should not bill; accepted calls are a few dozen tokens each.
 */
import { resolveAuth } from "../agent-core/auth.ts";
import { protocolEndpoint } from "../agent-core/auth/providers/endpoints.ts";
import { responsesBody } from "../agent-core/openai-compat.ts";

const MODEL = "gpt-6-astra";
const KEY = `tc1_probe_${Date.now().toString(36)}`;
const MARKER = { prompt_cache_breakpoint: { mode: "explicit" as const } };
const COUNTS = [1, 4, 10, 20, 40, 50, 60, 80];

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

async function send(
  blocks: number,
  markers: number,
  headers: Record<string, string>,
  url: string,
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
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, error: res.ok ? null : text.slice(0, 300), stamped };
}

const auth = await resolveAuth("openai-codex");
if (!auth.ok) {
  console.error(`auth: ${auth.error}`);
  process.exit(2);
}
const url = protocolEndpoint(auth.baseUrl, MODEL, "openai-codex-responses", true);
const headers = auth.headers as Record<string, string>;
console.log(`route: ${url} key: ${KEY}`);

let maxAccepted = 0;
for (const count of COUNTS) {
  // One input_text part per block; use twice as many blocks as markers.
  const result = await send(count * 2, count, headers, url);
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
