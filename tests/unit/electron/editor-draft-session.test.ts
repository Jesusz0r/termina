import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorDraftStore } from "../../../electron/editor-drafts";
import { EditorDraftSession } from "../../../electron/main/editor-draft-session";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "termina-draft-session-"));
  roots.push(root);
  const store = new EditorDraftStore(join(root, "copies"));
  const session = new EditorDraftSession(store);
  const path = join(root, "project", "file.txt");
  const owner = { projectId: "project", workspaceId: "workspace" };
  const lease = session.issue(root, path, owner, "model");
  return { root, store, session, path, owner, lease };
}

describe("main-owned editor recovery access", () => {
  it("rejects foreign ownership, unknown tokens, invalid revisions and oversized content", async () => {
    const { root, store, session, path, owner, lease } = await fixture();
    expect((await session.checkpoint(lease.token, 1, "foreign", { ...owner, projectId: "other" })).ok).toBe(false);
    expect((await session.checkpoint("unknown", 1, "foreign", owner)).ok).toBe(false);
    for (const revision of [0, -1, NaN, Infinity, "1"]) {
      expect((await session.checkpoint(lease.token, revision, "bad", owner)).ok).toBe(false);
    }
    expect((await session.checkpoint(lease.token, 1, "x".repeat(2 * 1024 * 1024 + 1), owner)).ok).toBe(false);
    expect(await store.get(root, path)).toBeNull();
  });

  it("keeps the newest accepted revision and refuses late resurrection after clear", async () => {
    const { root, store, session, path, owner, lease } = await fixture();
    expect((await session.checkpoint(lease.token, 2, "latest", owner)).ok).toBe(true);
    expect((await session.checkpoint(lease.token, 1, "old", owner)).ok).toBe(false);
    expect((await session.checkpoint(lease.token, 3, null, owner)).ok).toBe(true);
    expect((await session.checkpoint(lease.token, 2, "old", owner)).ok).toBe(false);
    expect(await store.get(root, path)).toBeNull();
  });

  it("reopening a model fences old callbacks and late release cannot revoke the replacement", async () => {
    const { session, root, path, owner, lease } = await fixture();
    const next = session.issue(root, path, owner, "replacement");
    session.forget(lease.token, owner);
    expect((await session.checkpoint(lease.token, 1, "old", owner)).ok).toBe(false);
    expect((await session.checkpoint(next.token, 1, "new", owner)).ok).toBe(true);
    expect(session.issue(root, path, owner, "replacement")).toEqual({ token: next.token, revision: 1 });
  });

  it("refuses cross-project discard and only removes explicitly selected copies", async () => {
    const { root, store, session, path, owner, lease } = await fixture();
    await session.checkpoint(lease.token, 1, "keep", owner);
    await expect(session.discard([lease.token], "other")).rejects.toThrow("another project");
    expect((await store.get(root, path))?.content).toBe("keep");
    await session.discard([lease.token], owner.projectId);
    expect(await store.get(root, path)).toBeNull();
    expect((await session.checkpoint(lease.token, 2, "late", owner)).ok).toBe(false);
  });

  it("overlapping discards cannot prematurely unfreeze the same model", async () => {
    const { root, store, session, path, owner, lease } = await fixture();
    await session.checkpoint(lease.token, 1, "dirty", owner);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async (root, path) => { await paused; return get(root, path); });
    const first = session.discard([lease.token]);
    await expect(session.discard([lease.token])).rejects.toThrow("already closing");
    expect((await session.checkpoint(lease.token, 2, "still frozen", owner)).ok).toBe(false);
    release();
    await first;
    expect(await store.get(root, path)).toBeNull();
  });

  it("failed multi-draft removal unfreezes every surviving lease for re-protection", async () => {
    const { root, store, session, path, owner, lease } = await fixture();
    const secondPath = join(root, "second.ts");
    const second = session.issue(root, secondPath, owner, "second model");
    await session.checkpoint(lease.token, 1, "first", owner);
    await session.checkpoint(second.token, 1, "second", owner);
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementationOnce(put).mockRejectedValueOnce(new Error("EIO: second removal failed"));
    await expect(session.discard([lease.token, second.token], owner.projectId)).rejects.toThrow("EIO");
    expect(await store.get(root, path)).toBeNull();
    expect((await session.checkpoint(lease.token, 2, "first protected again", owner)).ok).toBe(true);
    expect((await session.checkpoint(second.token, 2, "second protected again", owner)).ok).toBe(true);
    expect((await store.get(root, path))?.content).toBe("first protected again");
    expect((await store.get(root, secondPath))?.content).toBe("second protected again");
  });

  it("workspace teardown retires only its own models without deleting recovery data", async () => {
    const { root, store, session, owner, lease } = await fixture();
    const otherOwner = { ...owner, workspaceId: "candidate" };
    const otherPath = join(root, "candidate.ts");
    const other = session.issue(root, otherPath, otherOwner, "candidate model");
    await session.checkpoint(lease.token, 1, "primary", owner);
    await session.checkpoint(other.token, 1, "candidate", otherOwner);
    session.forgetWorkspace(otherOwner);
    expect((await session.checkpoint(other.token, 2, "stale", otherOwner)).ok).toBe(false);
    expect((await session.checkpoint(lease.token, 2, "primary still current", owner)).ok).toBe(true);
    expect((await store.get(root, otherPath))?.content).toBe("candidate");
  });

  it("a discard cannot delete a replacement accepted during async validation", async () => {
    const { root, store, session, path, owner, lease } = await fixture();
    await session.checkpoint(lease.token, 1, "old", owner);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce(async (root, path) => { await paused; return get(root, path); });
    const discard = session.discard([lease.token], owner.projectId);
    expect(() => session.issue(root, path, owner, "replacement")).toThrow("closing");
    session.reset();
    const replacement = session.issue(root, path, owner, "new document");
    expect((await session.checkpoint(replacement.token, 1, "new", owner)).ok).toBe(true);
    release();
    await expect(discard).rejects.toThrow("ownership changed");
    expect((await store.get(root, path))?.content).toBe("new");
  });

  it("project teardown and renderer reset retire access but retain recovery data", async () => {
    const { root, store, session, path, owner, lease } = await fixture();
    await session.checkpoint(lease.token, 1, "keep", owner);
    session.forgetProject(owner.projectId);
    expect((await session.checkpoint(lease.token, 2, "late", owner)).ok).toBe(false);
    expect((await store.get(root, path))?.content).toBe("keep");
    const next = session.issue(root, path, owner, "next");
    session.reset();
    expect((await session.checkpoint(next.token, 1, "late", owner)).ok).toBe(false);
    expect((await store.get(root, path))?.content).toBe("keep");
  });
});
