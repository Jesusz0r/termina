import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnifiedPatch } from "../../../electron/worldlines/export.ts";
import { exportCandidateRun, type ExportCandidateContext } from "../../../electron/worldlines/export-candidate.ts";
import type { CandidateState, ComparisonState } from "../../../electron/worldlines/types.ts";
import { gitCommittedChanges, gitCommitTree, gitWorkingChanges } from "../../../electron/worldline-git.ts";

vi.mock("../../../electron/worldline-git.ts", () => ({
  gitWorkingChanges: vi.fn(),
  gitCommittedChanges: vi.fn(),
  gitCommitTree: vi.fn(),
}));

const mockWorking = vi.mocked(gitWorkingChanges);
const mockCommitted = vi.mocked(gitCommittedChanges);
const mockTree = vi.mocked(gitCommitTree);

type Head = { ok: boolean; commit?: string; tree?: string; error?: string };

async function makeCtx(heads: Head[], candState = "running"): Promise<{ ctx: ExportCandidateContext; worldsRoot: string }> {
  const worldsRoot = await mkdtemp(join(tmpdir(), "termina-export-pin-"));
  const cand = { state: candState, role: "reference", dir: join(worldsRoot, "cand") } as CandidateState;
  const cmp = {
    baseCommit: "base",
    model: "test/model",
    candidates: new Map([["A", cand]]),
  } as unknown as ComparisonState;
  const queue = [...heads];
  const ctx: ExportCandidateContext = {
    comparisons: new Map([["cmp-191", cmp]]),
    evidenceByComparison: new Map(),
    buildExportPatch: async (files) => buildUnifiedPatch(files),
    worldsRoot,
    baseFileOf: async () => ({ ok: true, content: "a\nb\n" }),
    fileOf: async () => ({ ok: true, content: "a\nc\n" }),
    captureHead: async () => queue.shift() ?? { ok: false, error: "no more heads" },
  };
  return { ctx, worldsRoot };
}

describe("export head pinning (issue #191)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorking.mockResolvedValue([{ relPath: "F.ts", status: "modified" }]);
    mockCommitted.mockResolvedValue([]);
    mockTree.mockResolvedValue([]);
  });

  it("records the pinned head in metadata.json for a stable candidate", async () => {
    const { ctx, worldsRoot } = await makeCtx([
      { ok: true, commit: "h1", tree: "t1" },
      { ok: true, commit: "h1", tree: "t1" },
    ]);
    try {
      const result = await exportCandidateRun(ctx, "cmp-191", "A");
      expect(result.ok).toBe(true);
      const metadata = JSON.parse(await readFile(join(result.path!, "metadata.json"), "utf8")) as { headStateId?: string };
      expect(metadata.headStateId).toBe("h1");
      const patch = await readFile(join(result.path!, "candidate.patch"), "utf8");
      expect(patch).toContain("diff --git a/F.ts b/F.ts");
    } finally {
      await rm(worldsRoot, { recursive: true, force: true });
    }
  });

  it("refuses to write a bundle when the head moves mid-gather", async () => {
    const { ctx, worldsRoot } = await makeCtx([
      { ok: true, commit: "h1", tree: "t1" },
      { ok: true, commit: "h2", tree: "t2" },
    ]);
    try {
      const result = await exportCandidateRun(ctx, "cmp-191", "A");
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/changed during export/);
      await expect(readdir(join(worldsRoot, "exports"))).rejects.toThrow();
    } finally {
      await rm(worldsRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the head cannot be pinned or re-verified", async () => {
    const stable = await makeCtx([{ ok: false, error: "recording is not available" }]);
    try {
      const result = await exportCandidateRun(stable.ctx, "cmp-191", "A");
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/could not pin the candidate head/);
    } finally {
      await rm(stable.worldsRoot, { recursive: true, force: true });
    }
    const moved = await makeCtx([
      { ok: true, commit: "h1", tree: "t1" },
      { ok: false, error: "recording is not available" },
    ]);
    try {
      const result = await exportCandidateRun(moved.ctx, "cmp-191", "A");
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/could not re-verify the candidate head/);
    } finally {
      await rm(moved.worldsRoot, { recursive: true, force: true });
    }
  });

  it("still refuses discarded candidates before pinning", async () => {
    const { ctx, worldsRoot } = await makeCtx([], "discarded");
    try {
      const result = await exportCandidateRun(ctx, "cmp-191", "A");
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/only a live candidate can be exported/);
    } finally {
      await rm(worldsRoot, { recursive: true, force: true });
    }
  });
});
