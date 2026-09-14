import { describe, it, expect, vi, beforeEach } from "vitest";
import { changedFiles } from "../../../electron/worldlines/candidate-files.ts";
import { gitCommittedChanges, gitCommitTree, gitWorkingChanges } from "../../../electron/worldline-git.ts";
import { capChangedFileList, MAX_CHANGED_FILES } from "../../../shared/types.ts";
import type { CandidateState, ComparisonState } from "../../../electron/worldlines/types.ts";

vi.mock("../../../electron/worldline-git.ts", () => ({
  gitWorkingChanges: vi.fn(),
  gitCommittedChanges: vi.fn(),
  gitCommitTree: vi.fn(),
}));

const mockWorking = vi.mocked(gitWorkingChanges);
const mockCommitted = vi.mocked(gitCommittedChanges);
const mockTree = vi.mocked(gitCommitTree);

function states(working: Array<{ relPath: string; status: "created" | "modified" | "deleted" }>, committed: Array<{ relPath: string; status: "created" | "modified" | "deleted" }>) {
  mockWorking.mockResolvedValue(working);
  mockCommitted.mockResolvedValue(committed);
  mockTree.mockResolvedValue([]);
}

describe("changedFiles merge (issue #187)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function merged(): Promise<Array<{ relPath: string; status: string }>> {
    const cmp = { baseCommit: "base" } as ComparisonState;
    const cand = { dir: "/tmp/cand" } as CandidateState;
    return (await changedFiles(cmp, cand)).files;
  }

  it("reports a re-created file as created, not deleted", async () => {
    states(
      [{ relPath: "F.ts", status: "created" }],
      [{ relPath: "F.ts", status: "deleted" }],
    );
    expect(await merged()).toEqual([{ relPath: "F.ts", status: "created" }]);
  });

  it("keeps the reverse collision graceful (listed as deleted)", async () => {
    states(
      [{ relPath: "F.ts", status: "deleted" }],
      [{ relPath: "F.ts", status: "created" }],
    );
    expect(await merged()).toEqual([{ relPath: "F.ts", status: "deleted" }]);
  });

  it("merges non-colliding paths from both sides", async () => {
    states(
      [{ relPath: "w.ts", status: "modified" }],
      [{ relPath: "c.ts", status: "created" }],
    );
    expect(await merged()).toEqual([
      { relPath: "c.ts", status: "created" },
      { relPath: "w.ts", status: "modified" },
    ]);
  });

  it("fails closed when the comparison base is missing (issue #193)", async () => {
    states([], []);
    const cmp = { baseCommit: null } as ComparisonState;
    const cand = { dir: "/tmp/cand" } as CandidateState;
    await expect(changedFiles(cmp, cand)).rejects.toThrow(/comparison base is missing/);
    expect(mockWorking).not.toHaveBeenCalled();
  });

  it("caps 10k changed files and keeps the uncapped total (refs #213)", async () => {
    const working = Array.from({ length: 10_000 }, (_, i) => ({ relPath: `w-${String(i).padStart(5, "0")}.ts`, status: "modified" as const }));
    states(working, []);
    const cmp = { baseCommit: "base" } as ComparisonState;
    const cand = { dir: "/tmp/cand" } as CandidateState;
    const result = await changedFiles(cmp, cand);
    expect(result.files).toHaveLength(MAX_CHANGED_FILES);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(10_000);
    expect(result.files[0]?.relPath).toBe("w-00000.ts");
    expect(result.files.at(-1)?.relPath).toBe("w-00499.ts");
  });

  it("does not mark a listing at the cap as truncated", async () => {
    const working = Array.from({ length: MAX_CHANGED_FILES }, (_, i) => ({ relPath: `f-${i}.ts`, status: "modified" as const }));
    states(working, []);
    const result = await changedFiles({ baseCommit: "base" } as ComparisonState, { dir: "/tmp/cand" } as CandidateState);
    expect(result.files).toHaveLength(MAX_CHANGED_FILES);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(MAX_CHANGED_FILES);
  });
});

describe("capChangedFileList", () => {
  it("returns the same bound and truncated flag the listings share", () => {
    const files = Array.from({ length: 10_000 }, (_, i) => ({ relPath: `f-${i}.ts` }));
    const listed = capChangedFileList(files);
    expect(listed.files).toHaveLength(MAX_CHANGED_FILES);
    expect(listed.truncated).toBe(true);
    expect(listed.total).toBe(10_000);
  });
});
