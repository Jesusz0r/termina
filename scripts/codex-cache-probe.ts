/**
 * Live probe: does the Codex backend route accept `prompt_cache_key`?
 *
 * Context: today's Codex sessions show bimodal prompt-cache reuse (median
 * read/prevTotal 0 on growing turns, occasional full hits). Live OpenAI docs
 * say per-machine KV routing overflows are mitigated by `prompt_cache_key`,
 * but our route is the undocumented `chatgpt.com/backend-api` and no docs
 * say it accepts the field — so probe, don't assume.
 *
 * The probe sends its own minimal `store:false` requests (no session state
 * touched, own `tc1_probe_*` key namespace) and reports accept/reject plus,
 * on acceptance, whether a repeated prefix actually reads from cache.
 *
 *   node --experimental-strip-types --no-warnings scripts/codex-cache-probe.ts
 *
 * Costs a few cents at most (phase 2 replays ~1.2k tokens twice).
 */
import { resolveAuth } from "../agent-core/auth.ts";
import { protocolEndpoint } from "../agent-core/auth/providers/endpoints.ts";
import { responsesBody, responsesResultFromEvents } from "../agent-core/openai-compat.ts";

const MODEL = "gpt-6-astra";
const KEY = `tc1_probe_${Date.now().toString(36)}`;

function sseEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const chunk of text.split("\n\n")) {
    for (const line of chunk.split("\n")) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : null;
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          events.push(parsed as Record<string, unknown>);
        }
      } catch {
        /* Non-JSON SSE payloads carry no usage. */
      }
    }
  }
  return events;
}

async function send(messages: Array<{ role: "user" | "assistant"; content: string }>, headers: Record<string, string>, url: string, turnState?: string): Promise<{
  ok: boolean;
  status: number;
  usage: Record<string, unknown> | null;
  error: string | null;
  turnState: string | null;
}> {
  const body = responsesBody(MODEL, "You are a coding agent.", messages, [], {
    provider: "openai-codex",
    cacheKey: KEY,
    includeEncryptedReasoning: false,
  });
  if (body.prompt_cache_key !== KEY) {
    return { ok: false, status: 0, usage: null, error: "local body builder did not emit prompt_cache_key", turnState: null };
  }
  const outgoing: Record<string, string> = { ...headers, accept: "text/event-stream", "content-type": "application/json" };
  if (turnState) outgoing["x-codex-turn-state"] = turnState;
  const res = await fetch(url, {
    method: "POST",
    headers: outgoing,
    body: JSON.stringify(body),
  });
  const state = res.headers.get("x-codex-turn-state")?.trim() || null;
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, usage: null, error: text.slice(0, 500), turnState: state };
  }
  const result = responsesResultFromEvents(sseEvents(text), () => {}, Date.now());
  const usage = result.usage ? { ...(result.usage as Record<string, unknown>) } : null;
  return { ok: true, status: res.status, usage, error: null, turnState: state };
}

function usageLine(label: string, usage: Record<string, unknown> | null): string {
  if (!usage) return `${label}: no usage parsed`;
  const raw = usage as {
    input?: unknown; cacheRead?: unknown; cacheWrite?: unknown; output?: unknown; reasoning?: unknown;
  };
  return `${label}: input=${String(raw.input)} cacheRead=${String(raw.cacheRead)} cacheWrite=${String(raw.cacheWrite)} output=${String(raw.output)}`;
}

const auth = await resolveAuth("openai-codex");
if (!auth.ok) {
  console.error(`auth: ${auth.error}`);
  process.exit(2);
}
const url = protocolEndpoint(auth.baseUrl, MODEL, "openai-codex-responses", true);
console.log(`route: ${url} key: ${KEY}`);

// Phase 1: acceptance with a tiny body (below cacheable minimum by design).
const tiny = await send([{ role: "user", content: "Reply with exactly the word ok." }], auth.headers as Record<string, string>, url);
if (!tiny.ok) {
  console.log(`REJECTED status=${tiny.status} error=${tiny.error}`);
  console.log("verdict: prompt_cache_key not accepted on the Codex route (mirrors recordRejectedCacheFields semantics)");
  process.exit(1);
}
console.log(`ACCEPTED status=${tiny.status} ${usageLine("tiny", tiny.usage)}`);

// Phase 2: same ~1.2k-token prefix twice; a routing-effective key shows
// cached_tokens on the second response.
const filler = Array.from({ length: 170 }, (_, i) => `probe sentence ${i}: the cache key routes repeated prefixes to one machine.`).join(" ");
const shared: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: filler }];
const first = await send([...shared, { role: "user", content: "First question: reply yes." }], auth.headers as Record<string, string>, url);
console.log(usageLine("first ", first.usage));
if (!first.ok) {
  console.log("verdict: accepted but the long-prefix request failed; inconclusive");
  process.exit(1);
}
const second = await send([...shared, { role: "user", content: "Second question: reply yes." }], auth.headers as Record<string, string>, url, first.turnState ?? undefined);
console.log(usageLine("second", second.usage));
const read = typeof second.usage?.cacheRead === "number" ? second.usage.cacheRead : null;
if (read !== null && read > 0) {
  console.log(`verdict: key accepted AND effective (second-response cacheRead=${read}) — wire prompt_cache_key on openai-codex`);
} else {
  console.log("verdict: key accepted but no cache read observed — key is tolerated, routing benefit unproven");
}

// Phase 3: same prefix chained through the backend turn-state header,
// mirroring real sessions (x-codex-turn-state from turn 2 onward).
if (second.turnState) {
  const third = await send([...shared, { role: "user", content: "Third question: reply yes." }], auth.headers as Record<string, string>, url, second.turnState);
  console.log(usageLine("third ", third.usage));
  const read3 = typeof third.usage?.cacheRead === "number" ? third.usage.cacheRead : null;
  if (read3 !== null && read3 > 0) {
    console.log(`verdict: turn-state chaining reads cache (${read3}) — affinity rides the state header, key optional`);
  } else {
    console.log("verdict: even turn-state chaining misses — backend routing is opaque; no client key/header fixes it");
  }
} else {
  console.log("note: backend returned no x-codex-turn-state; phase 3 skipped");
}
