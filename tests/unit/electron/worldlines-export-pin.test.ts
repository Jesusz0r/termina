import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
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

async function makeCtx(heads: Head[], candState = "running", worldsRootOverride?: string): Promise<{ ctx: ExportCandidateContext; worldsRoot: string }> {
  const worldsRoot = worldsRootOverride ?? await mkdtemp(join(tmpdir(), "termina-export-pin-"));
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

  it("returns the canonical bundle path (issue #193)", async () => {
    const realRoot = await mkdtemp(join(tmpdir(), "termina-export-real-"));
    const link = `${realRoot}-link`;
    await symlink(realRoot, link);
    const worldsRoot = join(link, "worlds");
    const { ctx } = await makeCtx(
      [
        { ok: true, commit: "h1", tree: "t1" },
        { ok: true, commit: "h1", tree: "t1" },
      ],
      "running",
      worldsRoot,
    );
    try {
      const result = await exportCandidateRun(ctx, "cmp-191", "A");
      expect(result.ok).toBe(true);
      expect(result.path).not.toContain("-link");
      expect(result.path!.startsWith(await realpath(realRoot))).toBe(true);
      await readFile(join(result.path!, "candidate.patch"), "utf8");
    } finally {
      await rm(link, { force: true });
      await rm(realRoot, { recursive: true, force: true });
    }
  });

  it("gathers many files concurrently without loss or duplication (issue #193)", async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({ relPath: `m-${String(i).padStart(2, "0")}.ts`, status: "modified" as const }));
    mockWorking.mockResolvedValue(files);
    mockCommitted.mockResolvedValue([]);
    mockTree.mockResolvedValue([]);
    const { ctx, worldsRoot } = await makeCtx([
      { ok: true, commit: "h1", tree: "t1" },
      { ok: true, commit: "h1", tree: "t1" },
    ]);
    ctx.fileOf = async (_cid, _label, relPath) => ({ ok: true, content: `after-${relPath}\n` });
    ctx.baseFileOf = async (_cid, relPath) => ({ ok: true, content: `before-${relPath}\n` });
    try {
      const result = await exportCandidateRun(ctx, "cmp-191", "A");
      expect(result.ok).toBe(true);
      const patch = await readFile(join(result.path!, "candidate.patch"), "utf8");
      expect(patch.match(/diff --git/g)?.length).toBe(25);
      for (const file of files) {
        expect(patch).toContain(`diff --git a/${file.relPath} b/${file.relPath}`);
      }
      const metadata = JSON.parse(await readFile(join(result.path!, "metadata.json"), "utf8")) as { files?: number };
      expect(metadata.files).toBe(25);
    } finally {
      await rm(worldsRoot, { recursive: true, force: true });
    }
  });

  it("carries the executable bit into created-file modes (issue #193)", async () => {
    mockWorking.mockResolvedValue([{ relPath: "tool.sh", status: "created" }]);
    mockCommitted.mockResolvedValue([]);
    mockTree.mockResolvedValue([]);
    const { ctx, worldsRoot } = await makeCtx([
      { ok: true, commit: "h1", tree: "t1" },
      { ok: true, commit: "h1", tree: "t1" },
    ]);
    ctx.fileOf = async () => ({ ok: true, content: "x\n", mode: "100755" });
    try {
      const result = await exportCandidateRun(ctx, "cmp-191", "A");
      expect(result.ok).toBe(true);
      const patch = await readFile(join(result.path!, "candidate.patch"), "utf8");
      expect(patch).toContain("new file mode 100755");
    } finally {
      await rm(worldsRoot, { recursive: true, force: true });
    }
  });
});
