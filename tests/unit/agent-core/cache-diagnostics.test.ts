import { describe, expect, it } from "vitest";
import { cacheIdentityFor, cacheSessionSeed } from "../../../agent-core/auth.ts";
import { buildCacheRequestDiagnostics } from "../../../agent-core/main/cache-diagnostics.ts";
import { buildRequestOverlay, projectRequest, RequestOverlays } from "../../../agent-core/request-projection.ts";
import { responsesBody } from "../../../agent-core/openai-compat/responses.ts";
import { googleGenerateBody } from "../../../agent-core/openai-compat/google.ts";
import type { KernelMessage } from "../../../agent-core/openai-compat/types.ts";
import type { CacheRequestDiagnostics } from "../../../agent-core/cache.ts";

const user = (sseq: number, content = "fixture prompt") => ({ role: "user" as const, sseq, content });
const assistant = { role: "assistant" as const, sseq: 2, content: "fixture reply" };
function wire(messages: Parameters<typeof projectRequest>[0]["messages"], overlays: RequestOverlays) {
  const projected = projectRequest({ messages, overlays });
  if (!projected.ok) throw new Error(projected.error);
  return projected.messages as KernelMessage[];
}
const identity = cacheIdentityFor({
  sessionSeed: cacheSessionSeed("fixture-session"), role: "main", provider: "openai",
  protocol: "openai-responses", route: "api.openai.com",
})!;
function diagnostics(body: Record<string, unknown>, overlay: ReturnType<typeof buildRequestOverlay>, previous?: CacheRequestDiagnostics) {
  return buildCacheRequestDiagnostics({
    body, identity: { provider: "openai", protocol: "openai-responses", model: "fixture-model" },
    cacheIdentity: identity, overlay, hostContext: null, cacheKeySupported: false,
    codexTurnStateUsed: false, noiseFloorTokens: 64, previousDiagnostics: previous,
  });
}

describe("complete wire cache diagnostics", () => {
  it("compares every old item when a changed snapshot is appended", () => {
    const snapshots = new RequestOverlays();
    const old = buildRequestOverlay({ hostContext: "synthetic revision A" });
    snapshots.capture(1, old);
    const messages = [user(1), assistant];
    const body = responsesBody("fixture-model", "fixture instructions", wire(messages, snapshots), [], {});
    const before = diagnostics(body, old);
    const changed = buildRequestOverlay({ hostContext: "synthetic revision B" });
    snapshots.capture(3, changed);
    const nextBody = responsesBody("fixture-model", "fixture instructions", wire([...messages, user(3)], snapshots), [], {});
    const after = diagnostics(nextBody, changed, before);
    expect(before.reusablePrefixItems).toBe((body.input as unknown[]).length);
    expect(after.comparedPrefixHash).toBe(before.reusablePrefixHash);
    expect(after.comparedPrefixItems).toBe(before.reusablePrefixItems);
    expect(after.workingSetHash).not.toBe(before.workingSetHash);
    expect(JSON.stringify(after)).not.toMatch(/synthetic revision|fixture prompt|fixture instructions|fixture-session/);
  });

  it("detects rewriting an old snapshot even when durable history is identical", () => {
    const messages = [user(1), assistant];
    const old = buildRequestOverlay({ hostContext: "revision A" });
    const changed = buildRequestOverlay({ hostContext: "revision B" });
    const a = new RequestOverlays(), b = new RequestOverlays();
    a.capture(1, old);
    b.capture(1, changed);
    const before = diagnostics(responsesBody("fixture-model", "instructions", wire(messages, a), [], {}), old);
    const after = diagnostics(responsesBody("fixture-model", "instructions", wire(messages, b), [], {}), changed, before);
    expect(after.comparedPrefixItems).toBe(before.reusablePrefixItems);
    expect(after.comparedPrefixHash).not.toBe(before.reusablePrefixHash);
  });

  it("hashes actual Google contents, including coalesced snapshot and prompt", () => {
    const snapshots = new RequestOverlays();
    const old = buildRequestOverlay({ hostContext: "revision A" });
    snapshots.capture(1, old);
    const messages = [user(1), assistant];
    const googleIdentity = cacheIdentityFor({ sessionSeed: cacheSessionSeed("fixture-session"), role: "main",
      provider: "google", protocol: "google-generate", route: "generativelanguage.googleapis.com" })!;
    const diagnose = (contents: unknown[], overlay: typeof old, previous?: CacheRequestDiagnostics) => buildCacheRequestDiagnostics({
      body: { contents }, identity: { provider: "google", protocol: "google-generate", model: "fixture-model" },
      cacheIdentity: googleIdentity, overlay, hostContext: null, cacheKeySupported: false,
      codexTurnStateUsed: false, noiseFloorTokens: 64, previousDiagnostics: previous,
    });
    const contents = googleGenerateBody("", wire(messages, snapshots), []).contents as unknown[];
    expect(contents).toHaveLength(2); // Adjacent user snapshot/prompt coalesce.
    const before = diagnose(contents, old);
    expect(before.reusablePrefixItems).toBe(contents.length);
    expect(before.reusablePrefixHash).toEqual(expect.any(String));
    const changed = buildRequestOverlay({ hostContext: "revision B" });
    snapshots.capture(3, changed);
    const nextContents = googleGenerateBody("", wire([...messages, user(3)], snapshots), []).contents as unknown[];
    const after = diagnose(nextContents, changed, before);
    expect(after.comparedPrefixHash).toBe(before.reusablePrefixHash);
    expect(after.cacheKeyHash).toBeNull(); // No body key or session header is sent.
  });

  it("reports emitted Codex session identity without inventing retention guarantees", () => {
    const codexIdentity = cacheIdentityFor({ sessionSeed: cacheSessionSeed("fixture-session"), role: "main",
      provider: "openai-codex", protocol: "openai-codex-responses", route: "chatgpt.com/backend-api" })!;
    const result = buildCacheRequestDiagnostics({
      body: { input: [{ role: "user", content: "fixture" }] },
      identity: { provider: "openai-codex", protocol: "openai-codex-responses", model: "fixture-model" },
      cacheIdentity: codexIdentity, overlay: null, hostContext: null, cacheKeySupported: false,
      codexTurnStateUsed: false, noiseFloorTokens: 64,
    });
    expect(result.cacheKeyHash).toEqual(expect.any(String));
    expect(result.policy.effectiveMode).toBe("implicit");
    expect(result.policy.retentionKnown).toBeNull();
    expect(result.policy.effectiveTtlMs).toBeNull();
    expect(JSON.stringify(result)).not.toContain(codexIdentity.key);
  });
});
