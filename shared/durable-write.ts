/**
 * One crash-durable async file replace. `shared/fsync.ts` stays fsync-only.
 *
 * Sequence: exclusive sibling temp (`<path>.<pid>.<uuid>.tmp`, mode 0o600),
 * write, file sync, close, rename over `path`, parent-directory sync.
 *
 * Not this module: sidecar cursor publish (rename only, no fsync) and sync
 * agent tool writes (`main/file-ops.ts`, `atomicWriteJsonSync`).
 *
 * Private leftovers keep their own writers:
 * - roster save / prefs write: same exclusive-temp + file sync + rename,
 *   but parent-dir fsync is sync (`syncParentDir`) and each store owns
 *   commit/reset policy.
 * - main `durableReplaceFile`: Buffer + optional mode + crash-litter reaper.
 */
import { randomUUID } from "node:crypto";
import { open as openFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectoryAsync } from "./fsync.ts";

/** Failure after or before the dest name flipped. `renamed` is the dest flip. */
export class DurableAtomicWriteError extends Error {
  readonly renamed: boolean;

  constructor(cause: unknown, renamed: boolean) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DurableAtomicWriteError";
    this.renamed = renamed;
    if (cause instanceof Error) this.cause = cause;
  }
}

export async function durableAtomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  let renamed = false;
  try {
    handle = await openFile(temp, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    renamed = true;
    await syncDirectoryAsync(dirname(path));
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      /* best effort cleanup */
    }
    try {
      await unlink(temp);
    } catch {
      /* best effort cleanup */
    }
    throw new DurableAtomicWriteError(error, renamed);
  }
}
