/**
 * Opt-in, synthetic diagnostic comparison on the Codex Responses route.
 *
 *   node --experimental-strip-types --no-warnings scripts/codex-comparison-probe.ts --live
 *
 * Without --live (or when imported), no credentials or network are accessed.
 * Replay an identical request, changing only comparison_response_id. Reuse
 * canonical auth, request construction, and the bounded cache-probe transport.
 * At most two inference requests, no retries, 20-second request deadlines and
 * a 60-second overall deadline. Never print response IDs, raw provider payloads,
 * credentials, or session content. Missing diagnostics remain inconclusive.
 * https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAuth } from "../agent-core/auth.ts";
import { responsesBody, usageFromOpenAI } from "../agent-core/openai-compat.ts";
import { assertProbeAuthPath, hash, MODEL, probeEndpoint } from "./codex-cache-probe.ts";
import { httpTransport, ProbeFailure, type Json, type ProbeTransport } from "./codex-cache-probe-transport.ts";

// Only documented enum values and finite counts may reach stdout. Provider
// strings outside this allowlist (including error bodies) are never printed.
const DIAGNOSTIC_TYPES = new Set(["cache_hit", "cache_miss", "comparison_response_not_found", "unavailable"]);
const DIAGNOSTIC_REASONS = new Set([
  "model_changed", "prompt_cache_key_changed", "service_tier_changed", "tools_changed",
  "text_format_changed", "reasoning_effort_changed", "verbosity_changed", "context_compacted", "input_changed",
]);
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function reportUsage(label: string, response: Json): void {
  const usage = usageFromOpenAI(response.usage as Json | undefined);
  console.log(`${label}: input=${count(usage?.input)} cacheRead=${count(usage?.cacheRead)} cacheWrite=${count(usage?.cacheWrite)} output=${count(usage?.output)}`);
}

function reportDiagnostics(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    console.log("verdict: comparison accepted without prompt_cache_diagnostics — inconclusive; no backend policy inferred");
    return;
  }
  const raw = value as Json;
  const type = typeof raw.type === "string" && DIAGNOSTIC_TYPES.has(raw.type) ? raw.type : "unknown";
  const reason = typeof raw.reason === "string" && DIAGNOSTIC_REASONS.has(raw.reason) ? raw.reason : null;
  console.log(`diagnostics: ${JSON.stringify({
    type, reason,
    comparison_reusable_tokens: count(raw.comparison_reusable_tokens),
    cache_missed_tokens: count(raw.cache_missed_tokens),
  })}`);
  console.log(`verdict: backend comparison=${type}, reason=${reason ?? "not supplied"}; no global cache policy inferred`);
}

export async function runComparisonProbe(args = process.argv.slice(2)): Promise<number> {
  if (!args.includes("--live")) {
    console.log("Dry run: pass --live to use provider quota (at most two synthetic requests).");
    return 0;
  }
  let transport: ProbeTransport | undefined;
  let phase = "setup";
  try {
    assertProbeAuthPath();
    const signal = AbortSignal.timeout(60_000);
    const auth = await resolveAuth("openai-codex", AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    if (!auth.ok) {
      console.log("verdict: credentials unavailable; no inference requests sent");
      return 2;
    }
    transport = httpTransport(probeEndpoint(auth.baseUrl, "openai-codex"), auth.headers, signal);
    const filler = Array.from({ length: 170 }, (_, i) =>
      `probe sentence ${i}: the comparison id asks the backend to classify the cache miss.`,
    ).join(" ");
    const body = responsesBody(MODEL, "You are a coding agent.", [
      { role: "user", content: filler }, { role: "user", content: "Reply with exactly yes." },
    ], [], { provider: "openai-codex", includeEncryptedReasoning: false });
    const fingerprint = hash(body);
    phase = "baseline";
    console.log(`request sha256=${fingerprint} (excluding comparison id)`);
    const first = await transport.send(body);
    reportUsage("first", first.response);
    const comparisonId = first.response.id;
    if (typeof comparisonId !== "string" || !comparisonId) {
      console.log("verdict: baseline returned no response id; inconclusive");
      return 1;
    }
    phase = "comparison";
    console.log(`request sha256=${fingerprint} (excluding comparison id)`);
    const second = await transport.send({ ...body, prompt_cache_options: { comparison_response_id: comparisonId } });
    reportUsage("second", second.response);
    reportDiagnostics(second.response.prompt_cache_diagnostics);
    return 0;
  } catch (error) {
    const status = error instanceof ProbeFailure ? count(error.status) : null;
    console.log(`verdict: ${phase} failed status=${status ?? "unknown"}; cache behavior remains inconclusive`);
    return 1;
  } finally {
    transport?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runComparisonProbe().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Probe failed; no credentials or raw provider payloads logged.");
    process.exitCode = 1;
  });
}
