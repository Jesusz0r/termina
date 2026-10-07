import { describe, expect, it, vi } from "vitest";
import { WorldlineManager } from "../../../electron/worldlines/manager.ts";
import { loadIndependentSessions } from "../../../electron/worldlines/independent-session.ts";
import { ensureBoundDirectory } from "../../../electron/worldlines/promotion-recovery.ts";
import { boundPromotionCreateDirectory, boundPromotionWriteFile } from "../../../electron/worldline-git.ts";
import { MARKER } from "../../../electron/worldlines/limits.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComparisonManifest } from "../../../electron/worldlines/types.ts";

describe("independent session preparation", () => {
  it("keeps the durable role and origin even when startup recovery is capped", () => {
    const manager = Object.assign(Object.create(WorldlineManager.prototype), {
      comparisons: new Map(), deps: { primaryRoot: "/source" },
    }) as WorldlineManager;
    const manifest: ComparisonManifest = { id: "cmp-4", sourceRunId: null, createdAt: 4, status: "complete", expectedCandidates: 1,
      session: { primaryRoot: "/source", baseStateId: "base", sourceGitDir: "/source/.git", model: null, thinkingLevel: null,
        sourceSessionFile: "/legacy/current/active.jsonl" },
      candidates: { A: { pid: null, lstart: null, paths: ["/worlds/cmp-4/A", "/worlds/cmp-4/A-support"] } }, uncertainSessionArtifacts: [] };
    const internal = manager as unknown as { rehydrateUncertainComparison(manifest: ComparisonManifest, dir: string): void;
      comparisons: Map<string, { sourceSessionFile: string; baseStateId: string; candidates: Map<string, { role: string }> }> };
    internal.rehydrateUncertainComparison(manifest, "/worlds/cmp-4");
    const retained = internal.comparisons.get(manifest.id)!;
    expect(retained.candidates.get("A")!.role).toBe("session");
    expect(retained.sourceSessionFile).toBe(manifest.session!.sourceSessionFile);
    expect(retained.baseStateId).toBe("base");
  });
  it("counts retained failed user areas before another startup can allocate", () => {
    const manager = Object.assign(Object.create(WorldlineManager.prototype), {
      comparisons: new Map([1, 2, 3].map((id) => [`cmp-${id}`, {
        sourceRunId: null, phase: "error", teardownPromise: null, candidates: new Map([["A", {}]]),
      }])),
    }) as WorldlineManager;
    const count = (manager as unknown as { liveWorldlineCount(): number }).liveWorldlineCount();
    expect(count).toBe(3);
  });
  it("checks the real sandbox before allocating or launching a session", async () => {
    const constructComparison = vi.fn();
    const manager = Object.assign(Object.create(WorldlineManager.prototype), {
      ready: Promise.resolve(),
      deps: { preflight: async () => ({ ok: false, reasons: ["sandbox unavailable"] }) },
      constructComparison,
    }) as WorldlineManager;
    const result = await manager.createIndependentSession({ model: null, thinkingLevel: null });
    expect(result).toEqual({ ok: false, error: "sandbox unavailable" });
    expect(constructComparison).not.toHaveBeenCalled();
  });

  it("loads a native candidate manifest for its project without a source run", async () => {
    const path = await mkdtemp(join(tmpdir(), "termina-independent-"));
    try {
      const root = await ensureBoundDirectory(join(path, "worlds"), "test worlds");
      const identity = await boundPromotionCreateDirectory({ root: root.path, rootIdentity: root, components: ["cmp-1"], parentIdentity: root, requireMissing: true });
      const dir = join(root.path, "cmp-1");
      const manifest = { id: "cmp-1", sourceRunId: null, createdAt: 1, status: "complete", expectedCandidates: 1,
        session: { primaryRoot: root.path, baseStateId: "base", sourceGitDir: join(root.path, ".git"), model: null, thinkingLevel: null },
        candidates: { A: { pid: null, lstart: null, paths: [join(dir, "A"), join(dir, "A-support")] } }, uncertainSessionArtifacts: [] };
      for (const [name, content] of [[MARKER, "owned"], ["manifest.json", JSON.stringify(manifest)]]) {
        await boundPromotionWriteFile({ root: dir, rootIdentity: identity, components: [name!], parentIdentity: identity,
          expectedDestination: { state: { type: "missing" } }, content: Buffer.from(content!), mode: 0o600 });
      }
      expect((await loadIndependentSessions(root, root.path)).sessions.map((s) => s.manifest)).toEqual([manifest]);
      expect((await loadIndependentSessions(root, join(root.path, "other-project"))).sessions).toEqual([]);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
});
