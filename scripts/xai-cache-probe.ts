/**
 * Live probe: xAI stable-key acceptance and retention (roadmap P0 §9/§12).
 *
 * xAI documents a stable session key (`x-grok-conv-id` on Chat Completions)
 * with no validated TTL. This probe sends the canonical derived identity as
 * the header on a ~1k-token prefix repeated twice back-to-back (acceptance +
 * immediate hit), then once more after a 75s idle gap (retention signal).
 * Own probe seed, tiny outputs, no session state touched.
 *
 *   node --experimental-strip-types --no-warnings scripts/xai-cache-probe.ts
 *
 * Costs a few cents at most (~1k input tokens x3 plus one-word outputs).
 */
import { cacheIdentityFor, cacheSessionHeaders, resolveAuth } from "../agent-core/auth.ts";
import { protocolEndpoint } from "../agent-core/auth/providers/endpoints.ts";
import { completionResultFromEvents, completionsBody } from "../agent-core/openai-compat.ts";

const MODEL = "grok-4.6";
const SEED = process.env.XAI_PROBE_SEED ?? `probe-${Date.now().toString(36)}`;
const GAP_MS = Number(process.env.XAI_PROBE_GAP_MS ?? 75_000);

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

async function send(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  headers: Record<string, string>,
  url: string,
): Promise<{ ok: boolean; status: number; usage: Record<string, unknown> | null; error: string | null }> {
  const body = completionsBody(MODEL, "You are a coding agent.", messages, [], "max_tokens", {
    provider: "xai",
    maxTokens: 16,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, usage: null, error: text.slice(0, 500) };
  const result = completionResultFromEvents(sseEvents(text), () => {}, Date.now());
  const usage = result.usage ? { ...(result.usage as Record<string, unknown>) } : null;
  return { ok: true, status: res.status, usage, error: null };
}

const auth = await resolveAuth("xai");
if (!auth.ok) {
  console.error(`auth: ${auth.error}`);
  process.exit(2);
}
const url = protocolEndpoint(auth.baseUrl, MODEL, "openai-completions", true);
const baseHeaders = auth.headers as Record<string, string>;
const identity = cacheIdentityFor({
  sessionSeed: SEED,
  role: "main",
  provider: "xai",
  protocol: "openai-completions",
  route: "api.x.ai",
});
const sessionHeaders = identity ? cacheSessionHeaders(identity) : {};
console.log(`route: ${url} session-header: ${Object.keys(sessionHeaders).join(",") || "(none derived)"}`);
if (Object.keys(sessionHeaders).length === 0) {
  console.log("verdict: no session header derived — identity owner refuses this route; retention untestable, do not hand-roll a key");
  process.exit(1);
}
const headers = { ...baseHeaders, ...sessionHeaders };

const tiny = await send([{ role: "user", content: "Reply with exactly the word ok." }], headers, url);
if (!tiny.ok) {
  console.log(`REJECTED status=${tiny.status} error=${tiny.error}`);
  console.log("verdict: request with the session header rejected — record the rejection, do not retry with a different header");
  process.exit(1);
}
console.log(`ACCEPTED status=${tiny.status} usage=${JSON.stringify(tiny.usage)}`);

const filler = Array.from({ length: 150 }, (_, i) => `probe sentence ${i}: the session header pins repeated prefixes to warm state.`).join(" ");
const shared: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: filler }];
const first = await send([...shared, { role: "user", content: "First: reply yes." }], headers, url);
console.log(`first  usage=${JSON.stringify(first.usage)}`);
const second = await send([...shared, { role: "user", content: "Second: reply yes." }], headers, url);
console.log(`second usage=${JSON.stringify(second.usage)}`);

await new Promise((resolve) => setTimeout(resolve, GAP_MS));
const third = await send([...shared, { role: "user", content: "Third: reply yes." }], headers, url);
console.log(`third  usage=${JSON.stringify(third.usage)} (+${Math.round(GAP_MS / 1000)}s gap)`);
console.log("verdict: compare input/cache-hit fields across first/second/third — a warm second with a cold third bounds the TTL; warm throughout means retention exceeds the gap; all-cold means the header buys nothing on this route");
