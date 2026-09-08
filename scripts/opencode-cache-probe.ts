/**
 * Live probe: cache behavior on the OpenCode Go relay (roadmap P0 §12).
 *
 * Zen defines protocol routing only, with no validated cache contract, and
 * relays remain unknown unless probed. This probe sends the canonical
 * `x-opencode-session` identity header on a ~1k-token prefix repeated twice
 * and reports acceptance plus any usage cache fields or billed-input delta.
 * Own probe seed, tiny outputs, no session state touched.
 *
 *   node --experimental-strip-types --no-warnings scripts/opencode-cache-probe.ts
 *
 * Costs a few cents at most (~1k input tokens x2 plus one-word outputs).
 */
import { cacheIdentityFor, cacheSessionHeaders, resolveAuth } from "../agent-core/auth.ts";
import { protocolEndpoint } from "../agent-core/auth/providers/endpoints.ts";
import { completionResultFromEvents, completionsBody } from "../agent-core/openai-compat.ts";

const MODEL = "glm-5.1";
const SEED = `probe-${Date.now().toString(36)}`;

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
    provider: "opencode-go",
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

const auth = await resolveAuth("opencode-go");
if (!auth.ok) {
  console.error(`auth: ${auth.error}`);
  process.exit(2);
}
const url = protocolEndpoint(auth.baseUrl, MODEL, "openai-completions", true);
const baseHeaders = auth.headers as Record<string, string>;
const identity = cacheIdentityFor({
  sessionSeed: SEED,
  role: "main",
  provider: "opencode-go",
  protocol: "openai-completions",
  route: "opencode.ai",
});
const sessionHeaders = identity ? cacheSessionHeaders(identity) : {};
console.log(`route: ${url} model: ${MODEL} session-header: ${Object.keys(sessionHeaders).join(",") || "(none derived)"}`);
const headers = { ...baseHeaders, ...sessionHeaders };

const tiny = await send([{ role: "user", content: "Reply with exactly the word ok." }], headers, url);
if (!tiny.ok) {
  console.log(`REJECTED status=${tiny.status} error=${tiny.error}`);
  console.log("verdict: relay rejects the session header — retry without it before concluding anything about caching");
  const bare = await send([{ role: "user", content: "Reply with exactly the word ok." }], baseHeaders, url);
  console.log(`bare-header retry: ${bare.ok ? `ACCEPTED usage=${JSON.stringify(bare.usage)}` : `REJECTED status=${bare.status}`}`);
  process.exit(1);
}
console.log(`ACCEPTED status=${tiny.status} usage=${JSON.stringify(tiny.usage)}`);

const filler = Array.from({ length: 150 }, (_, i) => `probe sentence ${i}: the session header pins repeated prefixes to warm state.`).join(" ");
const shared: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: filler }];
const first = await send([...shared, { role: "user", content: "First: reply yes." }], headers, url);
console.log(`first  usage=${JSON.stringify(first.usage)}`);
const second = await send([...shared, { role: "user", content: "Second: reply yes." }], headers, url);
console.log(`second usage=${JSON.stringify(second.usage)}`);
console.log("verdict: compare input/cache fields first-vs-second — a billed-input drop or cache field means the relay surfaces upstream caching; identical full billing means opaque, keep unknown and do not send cache-specific fields");
