import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  gitTopLevel: vi.fn(),
}));

vi.mock("../../../electron/worldline-git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../electron/worldline-git.ts")>();
  return { ...actual, gitTopLevel: mocks.gitTopLevel };
});

import {
  GIT_NOT_A_REPO_REASON,
  GIT_UNREADABLE_REASON,
  classifyOpenedGitRoot,
  gitDirLooksPresent,
  worldlinePreflight,
} from "../../../electron/worldlines/bootstrap.ts";

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  mocks.gitTopLevel.mockReset();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("classifyOpenedGitRoot (refs #259)", () => {
  it("returns the top-level when core resolves a repo", async () => {
    mocks.gitTopLevel.mockResolvedValue("/repo");
    await expect(classifyOpenedGitRoot("/repo/src")).resolves.toEqual({ ok: true, top: "/repo" });
  });

  it("treats a thrown core/protocol error as unreadable, not as not-a-repo", async () => {
    const dir = await tempDir("termina-git-throw-");
    mocks.gitTopLevel.mockRejectedValue(new Error("snapshot core request timed out"));
    await expect(classifyOpenedGitRoot(dir)).resolves.toEqual({ ok: false, reason: GIT_UNREADABLE_REASON });
    expect(GIT_UNREADABLE_REASON).not.toBe(GIT_NOT_A_REPO_REASON);
  });

  it("treats a null top-level with no .git marker as not-a-repo", async () => {
    const dir = await tempDir("termina-git-none-");
    mocks.gitTopLevel.mockResolvedValue(null);
    expect(await gitDirLooksPresent(dir)).toBe(false);
    await expect(classifyOpenedGitRoot(dir)).resolves.toEqual({ ok: false, reason: GIT_NOT_A_REPO_REASON });
  });

  it("treats a null top-level with a local .git directory as unreadable", async () => {
    const dir = await tempDir("termina-git-dir-");
    await mkdir(join(dir, ".git"));
    mocks.gitTopLevel.mockResolvedValue(null);
    expect(await gitDirLooksPresent(dir)).toBe(true);
    await expect(classifyOpenedGitRoot(dir)).resolves.toEqual({ ok: false, reason: GIT_UNREADABLE_REASON });
  });

  it("treats a null top-level with a .git file (worktree) as unreadable", async () => {
    const dir = await tempDir("termina-git-file-");
    await writeFile(join(dir, ".git"), "gitdir: /elsewhere\n");
    mocks.gitTopLevel.mockResolvedValue(null);
    await expect(classifyOpenedGitRoot(dir)).resolves.toEqual({ ok: false, reason: GIT_UNREADABLE_REASON });
  });

  it("walks ancestors for a .git marker when core returns null", async () => {
    const repo = await tempDir("termina-git-parent-");
    await mkdir(join(repo, ".git"));
    const nested = join(repo, "src", "app");
    await mkdir(nested, { recursive: true });
    mocks.gitTopLevel.mockResolvedValue(null);
    expect(await gitDirLooksPresent(nested)).toBe(true);
    await expect(classifyOpenedGitRoot(nested)).resolves.toEqual({ ok: false, reason: GIT_UNREADABLE_REASON });
  });
});

describe("worldlinePreflight git mapping (refs #259)", () => {
  it("does not collapse a core throw to not-a-repo", async () => {
    const dir = await tempDir("termina-preflight-throw-");
    mocks.gitTopLevel.mockRejectedValue(new Error("snapshot core is disposed"));
    const result = await worldlinePreflight({ storePromise: Promise.resolve(null), worldsRoot: dir, primaryRoot: dir });
    expect(result.reasons).toContain(GIT_UNREADABLE_REASON);
    expect(result.reasons).not.toContain(GIT_NOT_A_REPO_REASON);
  });

  it("reports not-a-repo only when core returns null and no .git is present", async () => {
    const dir = await tempDir("termina-preflight-none-");
    mocks.gitTopLevel.mockResolvedValue(null);
    const result = await worldlinePreflight({ storePromise: Promise.resolve(null), worldsRoot: dir, primaryRoot: dir });
    expect(result.reasons).toContain(GIT_NOT_A_REPO_REASON);
    expect(result.reasons).not.toContain(GIT_UNREADABLE_REASON);
  });
});
