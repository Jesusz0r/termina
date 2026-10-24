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
 * - main `durableReplaceFile`: Buffer + optional mode.
 *
 * Every writer above names its temp `<path>.<pid>.<uuid>.tmp`, so
 * `reapWriteTemps` is the one crash-litter reaper for all of them.
 */
import { randomUUID } from "node:crypto";
import { open as openFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { syncDirectoryAsync } from "./fsync.ts";
import { isErrno } from "./guards.ts";

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

/**
 * Best-effort reaper for crash litter: sibling `<base>.<pid>.<uuid>.tmp`
 * files whose pid tag is not alive. The shape match is strict (numeric pid
 * plus a UUID) so user files can never qualify, and live pids — including
 * our own — are never reaped, so a concurrent writer's in-flight temp is
 * never touched.
 */
export async function reapWriteTemps(path: string): Promise<void> {
  const dir = dirname(path);
  const base = basename(path);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(`${base}.`) || !name.endsWith(".tmp")) continue;
    const middle = name.slice(base.length + 1, -".tmp".length);
    const dot = middle.indexOf(".");
    if (dot <= 0) continue;
    const pid = Number(middle.slice(0, dot));
    const uuid = middle.slice(dot + 1);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) continue;
    if (pid === process.pid) continue;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      // ESRCH means a dead pid (safe to reap); any other failure —
      // notably EPERM for a live process we cannot signal — keeps it.
      alive = !isErrno(err, "ESRCH");
    }
    if (alive) continue;
    await unlink(join(dir, name)).catch(() => undefined);
  }
}
