import { describe, it, expect, vi, beforeEach } from "vitest";
import { changedFiles } from "../../../electron/worldlines/candidate-files.ts";
import { gitCommittedChanges, gitCommitTree, gitWorkingChanges } from "../../../electron/worldline-git.ts";
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
});
