import { describe, expect, it, vi } from "vitest";
import { WorldlineManager } from "../../../electron/worldlines/manager.ts";
import { createIndependentSession, loadIndependentSessions, type IndependentSessionHost } from "../../../electron/worldlines/independent-session.ts";

vi.mock("../../../electron/worldlines/bootstrap.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../electron/worldlines/bootstrap.ts")>(),
  admitWorldlineForkSource: vi.fn(async () => ({ ok: true })),
}));
import { ensureBoundDirectory } from "../../../electron/worldlines/promotion-recovery.ts";
import { boundPromotionCreateDirectory, boundPromotionWriteFile } from "../../../electron/worldline-git.ts";
import { MARKER } from "../../../electron/worldlines/limits.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComparisonManifest } from "../../../electron/worldlines/types.ts";

describe("independent session preparation", () => {
  it("keeps the durable role and origin during startup recovery", () => {
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
  it("does not charge running, failed or draining user sessions to the experiment quota", () => {
    const comparisons = new Map(["running", "error", "creating"].map((phase, id) => [`cmp-${id}`, {
      sourceRunId: null as string | null, phase, teardownPromise: phase === "error" ? Promise.resolve() : null, candidates: new Map([["A", {}]]),
    }]));
    comparisons.set("experiment", { sourceRunId: "run-1", phase: "running", teardownPromise: null, candidates: new Map([["A", {}], ["B", {}]]) });
    const manager = Object.assign(Object.create(WorldlineManager.prototype), { comparisons }) as WorldlineManager;
    expect((manager as unknown as { liveWorldlineCount(): number }).liveWorldlineCount()).toBe(2);
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

describe("independent task source fences", () => {
  function fixture() {
    const candidate = { label: "A", sessionDir: "/candidate/session", terminalId: "worker" };
    const comparison = { id: "cmp-1", candidates: new Map([["A", candidate]]) };
    const release = vi.fn();
    const host = {
      deps: {
        primaryRoot: "/source",
        preflight: vi.fn(async () => ({ ok: true })),
        getStore: vi.fn(async () => ({ sourceRoot: "/source", sourceGitDir: "/source/.git" })),
        workspaceAt: vi.fn(async () => ({ id: "source" })),
        acquireWriteLease: vi.fn(async () => ({ ok: true })),
        releaseWriteLease: vi.fn(), flushDirtyModels: vi.fn(async () => ({ ok: true })),
        trustHashes: vi.fn(async () => ({})), capturePrimary: vi.fn(async () => "base"),
      },
      acquireAdmission: vi.fn(async () => ({ ok: true, lease: { release } })),
      liveCount: () => 0, construct: vi.fn(async () => comparison),
      buildTemplate: vi.fn(async () => {}), clone: vi.fn(async () => {}), support: vi.fn(async () => {}),
      resources: vi.fn(async () => {}), ensureLive: vi.fn(), forkSession: vi.fn(),
      start: vi.fn(async () => {}), teardown: vi.fn(async () => {}),
    };
    return { host, release, comparison };
  }
  it.each([undefined, "Run selected task"])("uses canonical startup control for initial prompt %j", async (initialTask) => {
    const f = fixture(); const beforeSpawn = vi.fn(); const writeControl = vi.fn();
    const launchCandidate = vi.fn(async (_cmp, _cand, _state, admission) => { admission.beforeSpawn("worker"); });
    const manager = Object.assign(Object.create(WorldlineManager.prototype), {
      ready: Promise.resolve(), deps: f.host.deps,
      acquireUncertainComparisonAdmission: f.host.acquireAdmission,
      liveWorldlineCount: f.host.liveCount, constructComparison: f.host.construct,
      buildTemplateFromState: f.host.buildTemplate, cloneCandidates: f.host.clone,
      createSupportDirs: f.host.support, copyCoreResources: f.host.resources,
      ensureComparisonLive: f.host.ensureLive, teardown: f.host.teardown,
      writeControl, launch: { launchCandidate },
    }) as WorldlineManager;
    expect(await manager.createIndependentSession({ model: null, thinkingLevel: null, initialTask, beforeSpawn })).toEqual({ ok: true, terminalId: "worker" });
    expect(writeControl).toHaveBeenCalledExactlyOnceWith(f.comparison.candidates.get("A"), initialTask === undefined
      ? { opId: expect.any(String), action: "none" }
      : { opId: expect.any(String), action: "structured", content: [{ type: "text", text: initialTask }] });
    expect(beforeSpawn).toHaveBeenCalledExactlyOnceWith("worker", { comparisonId: "cmp-1", label: "A" });
    expect(launchCandidate).toHaveBeenCalledOnce();
  });
  it("captures persisted source without force-saving its dirty editor models", async () => {
    const f = fixture();
    const source = { disk: "persisted bytes", draft: "unsaved editor draft", dirty: true };
    f.host.deps.flushDirtyModels.mockImplementation(async () => {
      source.disk = source.draft;
      source.dirty = false;
      return { ok: true };
    });
    f.host.deps.capturePrimary.mockImplementation(async () => {
      expect(source.disk).toBe("persisted bytes");
      expect(f.host.deps.acquireWriteLease).toHaveBeenCalledExactlyOnceWith("source", expect.stringMatching(/^session:/), 5000);
      expect(f.host.deps.releaseWriteLease).not.toHaveBeenCalled();
      return "persisted-source-state";
    });
    expect(await createIndependentSession(f.host as unknown as IndependentSessionHost, {
      model: null, thinkingLevel: null, initialTask: "Named task",
    })).toEqual({ ok: true, terminalId: "worker" });
    expect(f.host.deps.flushDirtyModels).not.toHaveBeenCalled();
    expect(source).toEqual({ disk: "persisted bytes", draft: "unsaved editor draft", dirty: true });
    expect(f.host.construct).toHaveBeenCalledWith(expect.objectContaining({ baseStateId: "persisted-source-state" }));
    expect(f.host.deps.releaseWriteLease).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each(["acquireWriteLease", "trustHashes", "capturePrimary"] as const)("guards after %s and releases source ownership", async (stage) => {
    const f = fixture(); let stale = false;
    const previous = f.host.deps[stage].getMockImplementation()!;
    f.host.deps[stage].mockImplementation((async () => {
      const result = await previous(); stale = true; return result;
    }) as never);
    const result = await createIndependentSession(f.host as unknown as IndependentSessionHost, {
      model: null, thinkingLevel: null, initialTask: "Named task",
      assertCurrent: () => { if (stale) throw new Error("stale owner"); },
    });
    expect(result).toEqual({ ok: false, error: "stale owner" });
    expect(f.host.start).not.toHaveBeenCalled();
    expect(f.host.deps.releaseWriteLease).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
  });
  it.each(["buildTemplate", "clone", "support", "resources", "start"] as const)("tears down canonical retained data after a late %s fence", async (stage) => {
    const f = fixture(); let stale = false;
    f.host[stage].mockImplementation(async () => { stale = true; });
    const result = await createIndependentSession(f.host as unknown as IndependentSessionHost, {
      model: null, thinkingLevel: null, initialTask: "Named task",
      assertCurrent: () => { if (stale) throw new Error("stale owner"); },
    });
    expect(result).toEqual({ ok: false, error: "stale owner" });
    expect(f.host.teardown).toHaveBeenCalledExactlyOnceWith("cmp-1", "stale owner");
    expect(f.host.deps.releaseWriteLease).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
  });
});
