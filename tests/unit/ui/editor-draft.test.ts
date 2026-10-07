import { describe, expect, it, vi } from "vitest";
import { EditorDraftCheckpoint } from "../../../src/editor-draft";

const owner = { projectId: "project", workspaceId: "workspace" };

describe("editor recovery checkpoints", () => {
  it("coalesces edits and waits for the newest copy, not just the submitted one", async () => {
    let release!: (result: { ok: boolean }) => void;
    const first = new Promise<{ ok: boolean }>((resolve) => { release = resolve; });
    const checkpoint = vi.fn().mockReturnValueOnce(first).mockResolvedValue({ ok: true });
    const status = vi.fn();
    const draft = new EditorDraftCheckpoint("token", 0, owner, { checkpoint, status });
    draft.update("one");
    await Promise.resolve();
    draft.update("two");
    draft.update("three");
    let flushed = false;
    const flush = draft.flush().then((ok) => { flushed = true; return ok; });
    expect(flushed).toBe(false);
    release({ ok: true });
    expect(await flush).toBe(true);
    expect(checkpoint.mock.calls).toEqual([
      ["token", 1, "one", owner], ["token", 3, "three", owner],
    ]);
    expect(status.mock.calls.filter(([state]) => state === "saved")).toEqual([["saved"]]);
  });

  it("does not resurrect queued edits after explicit discard", async () => {
    const checkpoint = vi.fn().mockResolvedValue({ ok: true });
    const draft = new EditorDraftCheckpoint("token", 4, owner, { checkpoint, status: vi.fn() });
    draft.update("unsaved");
    draft.update(null);
    expect(await draft.flush()).toBe(true);
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith("token", 6, null, owner);
  });

  it("keeps post-save typing rather than clearing the newer copy", async () => {
    const checkpoint = vi.fn().mockResolvedValue({ ok: true });
    const draft = new EditorDraftCheckpoint("token", 0, owner, { checkpoint, status: vi.fn() });
    draft.update(null);
    draft.update("typed after save");
    expect(await draft.flush()).toBe(true);
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith("token", 2, "typed after save", owner);
  });

  it("reports rejected persistence and allows a later edit to recover", async () => {
    const checkpoint = vi.fn().mockResolvedValueOnce({ ok: false, error: "disk full" }).mockResolvedValue({ ok: true });
    const status = vi.fn();
    const draft = new EditorDraftCheckpoint("token", 0, owner, { checkpoint, status });
    draft.update("one");
    expect(await draft.flush()).toBe(false);
    expect(status).toHaveBeenLastCalledWith("failed", "disk full");
    draft.update("two");
    expect(await draft.flush()).toBe(true);
    expect(status).toHaveBeenLastCalledWith("saved");
  });

  it("handles synchronous bridge failure without an endless flush", async () => {
    const draft = new EditorDraftCheckpoint("token", 0, owner, {
      checkpoint: () => { throw new Error("bridge unavailable"); }, status: vi.fn(),
    });
    draft.update("one");
    expect(await draft.flush()).toBe(false);
  });
});
