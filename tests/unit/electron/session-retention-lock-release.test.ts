import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRetentionOwner } from "../../../electron/session-retention.ts";
import { disposeWorldlineGitCore } from "../../../electron/worldline-git.ts";
import type { RetainedRootBinding } from "../../../electron/session-retention/primitives.ts";
import type { SessionRetentionLock } from "../../../shared/session-retention-lock.ts";

afterAll(() => disposeWorldlineGitCore());

describe("retention admission lock ownership", () => {
  it.each(["list", "discard", "transact"] as const)("releases the lock when %s root validation throws", async (operation) => {
    const work = await mkdtemp(join(tmpdir(), "termina-retention-lock-release-"));
    const owner = new SessionRetentionOwner(join(work, "retained"));
    const boundary = owner as unknown as {
      assertLockRoot(lock: SessionRetentionLock, root: RetainedRootBinding): void;
    };
    const validate = boundary.assertLockRoot.bind(owner);
    const spy = vi.spyOn(boundary, "assertLockRoot").mockImplementationOnce((lock, root) => {
      // Exercise the real mismatch assertion after the real lock is acquired.
      // Only its observed binding changes, so release still owns the lock.
      validate(lock, { ...root, identity: { ...root.identity, ino: "0" } });
    });
    try {
      const publish = vi.fn(async () => "unreachable");
      const result = operation === "list" ? owner.list()
        : operation === "discard" ? owner.discard("run-1")
        : owner.transact("run-1", publish);
      await expect(result).rejects.toThrow("root identity changed before admission");
      expect(publish).not.toHaveBeenCalled();
      // A fresh owner uses the same on-disk lock rather than this owner's queue.
      const next = new SessionRetentionOwner(join(work, "retained"));
      await expect(next.list()).resolves.toEqual([]);
      await next.drain();
    } finally {
      spy.mockRestore();
      await owner.drain();
      await rm(work, { recursive: true, force: true });
    }
  });
});
