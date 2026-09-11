/**
 * One owner for crash-durability fsyncs. Two contracts, named so they cannot
 * be confused: `syncDirectory` fsyncs the directory it is given, while
 * `syncParentDir` fsyncs the directory CONTAINING the path it is given (for a
 * file just renamed into place).
 *
 * Node-only (node:fs): agent-core and electron may import this, the renderer
 * must not — same boundary as session-retention-lock.ts.
 */
import { closeSync, fsyncSync, openSync } from "node:fs";
import { open as openAsync } from "node:fs/promises";
import { dirname } from "node:path";

/** fsync the directory itself, so a rename inside it survives a crash. */
export function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Async variant of syncDirectory. A close failure after a successful sync is
 *  swallowed: durability was already delivered, so failing the write would be
 *  a false alarm. */
export async function syncDirectoryAsync(directory: string): Promise<void> {
  const handle = await openAsync(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** fsync the directory containing `path`. Takes the FILE path, not the dir. */
export function syncParentDir(path: string): void {
  syncDirectory(dirname(path));
}
