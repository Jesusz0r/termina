/**
 * Secure temp bundles for session forks.
 *
 * Owns temp-bundle creation, retained-temp accounting, destination
 * validation, and referenced-image copying. Split from agent-core/session.ts (issue #38).
 */
import { acquireSessionRetentionLock, releaseSessionRetentionLock, validateSessionRetentionLease, type SessionRetentionLock } from "../../shared/session-retention-lock.ts";
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, writeSync, type BigIntStats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { retainUnboundCleanup } from "./bundles.ts";
import { anchoredChildPath, fsyncDirectoryDescriptor, noFollowFlags, openDirectoryAnchor, sameVersion, statIdentity, validateDirectoryAnchor, validateReopenedDirectoryIdentity } from "./descriptors.ts";
import type { DirectoryAnchor } from "./descriptors.ts";
import { ACTIVE_NAME, CURRENT_DIR, MAX_RETAINED_TEMP_BUNDLES, MAX_RETAINED_TEMP_BYTES, MAX_RETAINED_TEMP_ROOT_ENTRIES, MAX_RETAINED_TEMP_SCAN_DEPTH, MAX_RETAINED_TEMP_SCAN_ENTRIES, MAX_RETAINED_TEMP_SCAN_PENDING, MAX_RETAINED_TEMP_SCAN_WORK_BYTES, READ_CHUNK, RETAINED_TEMP_ADMISSION_RESERVATION_BYTES, TEMP_BUNDLE_NAME, cancellation, errMsg, inspectEntry, isSafeImageName } from "./primitives.ts";
import type { ReplayMessage, SessionBundlePaths, SessionOperationOptions, SessionResult } from "./primitives.ts";


export function referencedImageNames(messages: ReplayMessage[]): SessionResult<{ names: string[] }> {
  const names = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "image" || !block.source || typeof block.source !== "object" || Array.isArray(block.source)) continue;
      const src = block.source as { type?: unknown; name?: unknown };
      if (src.type !== "file" || typeof src.name !== "string") continue;
      if (!isSafeImageName(src.name)) return { ok: false, error: `unsafe image name: ${src.name}` };
      names.add(src.name);
    }
  }
  return { ok: true, names: [...names] };
}


export type TempBundle = {
  path: string;
  currentDir: string;
  sessionFile: string;
  /** Bytes measured after exclusive staging admission; updated for own image writes. */
  retainedBytes: number;
  parent: DirectoryAnchor;
  temp: DirectoryAnchor;
  current: DirectoryAnchor;
  retentionLock: SessionRetentionLock;
  ownsRetentionLock: boolean;
};


type RetainedTempUsage = {
  count: number;
  bytes: number;
};


function retainedTreeBytes(path: string): SessionResult<{ bytes: number }> {
  const initialWorkBytes = Buffer.byteLength(path, "utf8");
  if (initialWorkBytes > MAX_RETAINED_TEMP_SCAN_WORK_BYTES) {
    return { ok: false, error: "retained temporary session path exceeds its bounded work budget" };
  }
  const pending: Array<{ path: string; depth: number; workBytes: number }> = [{ path, depth: 0, workBytes: initialWorkBytes }];
  let pendingWorkBytes = initialWorkBytes;
  let examined = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    pendingWorkBytes -= current.workBytes;
    if (current.depth > MAX_RETAINED_TEMP_SCAN_DEPTH) {
      return { ok: false, error: `retained temporary session exceeds the ${MAX_RETAINED_TEMP_SCAN_DEPTH}-level depth bound` };
    }
    let info: BigIntStats;
    try {
      info = lstatSync(current.path, { bigint: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { ok: false, error: `could not inspect retained temporary session: ${errMsg(err)}` };
    }
    examined += 1;
    if (examined > MAX_RETAINED_TEMP_SCAN_ENTRIES) {
      return { ok: false, error: `retained temporary session exceeds the ${MAX_RETAINED_TEMP_SCAN_ENTRIES}-entry inspection bound` };
    }
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      return { ok: false, error: "retained temporary session contains an unsupported entry" };
    }
    if (info.isDirectory()) {
      let directory: ReturnType<typeof opendirSync>;
      try {
        directory = opendirSync(current.path);
      } catch (err) {
        return { ok: false, error: `could not inspect retained temporary session: ${errMsg(err)}` };
      }
      try {
        let child = directory.readSync();
        while (child !== null) {
          const childPath = join(current.path, child.name);
          const workBytes = Buffer.byteLength(childPath, "utf8");
          if (workBytes > MAX_RETAINED_TEMP_SCAN_WORK_BYTES || pendingWorkBytes > MAX_RETAINED_TEMP_SCAN_WORK_BYTES - workBytes) {
            return { ok: false, error: "retained temporary session scan exceeded its bounded work budget" };
          }
          if (pending.length >= MAX_RETAINED_TEMP_SCAN_PENDING) {
            return { ok: false, error: `retained temporary session exceeds the ${MAX_RETAINED_TEMP_SCAN_PENDING}-entry pending bound` };
          }
          pending.push({ path: childPath, depth: current.depth + 1, workBytes });
          pendingWorkBytes += workBytes;
          child = directory.readSync();
        }
      } catch (err) {
        return { ok: false, error: `could not inspect retained temporary session: ${errMsg(err)}` };
      } finally {
        try {
          directory.closeSync();
        } catch {
          /* best effort after a read failure */
        }
      }
      continue;
    }
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { ok: false, error: "retained temporary session byte count overflow" };
    }
    const size = Number(info.size);
    if (bytes > MAX_RETAINED_TEMP_BYTES - size) {
      return { ok: false, error: `retained temporary session exceeds ${MAX_RETAINED_TEMP_BYTES} bytes` };
    }
    bytes += size;
  }
  return { ok: true, bytes };
}


export function retainedTempUsage(projectDir: string): SessionResult<RetainedTempUsage> {
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(projectDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, count: 0, bytes: 0 };
    return { ok: false, error: `could not inspect retained temporary sessions: ${errMsg(err)}` };
  }
  let count = 0;
  let bytes = 0;
  let rootEntries = 0;
  let rootNameBytes = 0;
  try {
    let entry = directory.readSync();
    while (entry !== null) {
      rootEntries += 1;
      if (rootEntries > MAX_RETAINED_TEMP_ROOT_ENTRIES) {
        return { ok: false, error: `retained temporary session root exceeds the ${MAX_RETAINED_TEMP_ROOT_ENTRIES}-entry bound` };
      }
      const nameBytes = Buffer.byteLength(entry.name, "utf8");
      if (rootNameBytes > MAX_RETAINED_TEMP_SCAN_WORK_BYTES - nameBytes) {
        return { ok: false, error: "retained temporary session root exceeds its bounded work budget" };
      }
      rootNameBytes += nameBytes;
      if (!TEMP_BUNDLE_NAME.test(entry.name)) {
        entry = directory.readSync();
        continue;
      }
      count += 1;
      if (count > MAX_RETAINED_TEMP_BUNDLES) {
        return { ok: false, error: `retained temporary sessions exceed the ${MAX_RETAINED_TEMP_BUNDLES}-bundle bound` };
      }
      const measured = retainedTreeBytes(join(projectDir, entry.name));
      if (!measured.ok) return measured;
      if (bytes > MAX_RETAINED_TEMP_BYTES - measured.bytes) {
        return { ok: false, error: `retained temporary sessions exceed ${MAX_RETAINED_TEMP_BYTES} bytes` };
      }
      bytes += measured.bytes;
      entry = directory.readSync();
    }
  } catch (err) {
    return { ok: false, error: `could not inspect retained temporary sessions: ${errMsg(err)}` };
  } finally {
    try {
      directory.closeSync();
    } catch {
      /* best effort after a read failure */
    }
  }
  return { ok: true, count, bytes };
}


export function closeTempBundle(temp: TempBundle): void {
  for (const anchor of [temp.current, temp.temp, temp.parent]) {
    try {
      closeSync(anchor.fd);
    } catch {
      /* already closed */
    }
  }
}


export function releaseTempRetentionLock(temp: TempBundle): void {
  if (temp.ownsRetentionLock) releaseSessionRetentionLock(temp.retentionLock);
}


export function validateTempBundle(temp: TempBundle): SessionResult {
  for (const anchor of [temp.parent, temp.temp, temp.current]) {
    const valid = validateDirectoryAnchor(anchor);
    if (!valid.ok) return valid;
  }
  return { ok: true };
}


function openOwnedDestinationParent(path: string): SessionResult<{ anchor: DirectoryAnchor }> {
  const opened = openDirectoryAnchor(path, "destination project directory");
  if (!opened.ok) return opened;
  try {
    const info = fstatSync(opened.anchor.fd, { bigint: true });
    const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    if (expectedUid !== null && info.uid !== expectedUid) throw new Error("destination project directory is not app-owned");
    if ((info.mode & 0o022n) !== 0n) throw new Error("destination project directory is writable by another account");
    return opened;
  } catch (err) {
    closeSync(opened.anchor.fd);
    return { ok: false, error: errMsg(err) };
  }
}


function ensureDestinationProjectDirectory(path: string): SessionResult {
  const existing = inspectEntry(path);
  if (existing) {
    if (existing.kind === "symlink") return { ok: false, error: "destination project directory is a symlink" };
    if (existing.kind !== "dir") return { ok: false, error: "destination project path is not a directory" };
    return { ok: true };
  }
  const parent = openOwnedDestinationParent(dirname(path));
  if (!parent.ok) return parent;
  try {
    const stable = validateDirectoryAnchor(parent.anchor);
    if (!stable.ok) return stable;
    mkdirSync(anchoredChildPath(parent.anchor, basename(path), path), { recursive: false, mode: 0o700 });
    return fsyncDirectoryDescriptor(parent.anchor.fd);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    closeSync(parent.anchor.fd);
  }
}


/**
 * Node does not expose portable openat/mkdirat. Linux operations use the
 * retained directory descriptor through /proc/self/fd; other platforms rely
 * on the product invariant that this app-owned, non-group/world-writable
 * parent is outside candidate write sandboxes. All platforms create an
 * unpredictable child exclusively and bracket path writes with retained
 * descriptor/path identity checks. No recursive creation crosses a missing
 * or untrusted ancestor.
 */
export function createSecureTempBundle(dest: SessionBundlePaths, options?: SessionOperationOptions): SessionResult<{ temp: TempBundle }> {
  const ensuredProject = ensureDestinationProjectDirectory(dest.projectDir);
  if (!ensuredProject.ok) return ensuredProject;
  const parent = openOwnedDestinationParent(dest.projectDir);
  if (!parent.ok) return parent;
  let retentionLock: SessionRetentionLock;
  let ownsRetentionLock = true;
  if (options?.retentionLease) {
    const validatedLease = validateSessionRetentionLease(dest.projectDir, options.retentionLease);
    if (validatedLease === null) {
      closeSync(parent.anchor.fd);
      return { ok: false, error: "retained session admission lease is invalid or no longer held" };
    }
    retentionLock = validatedLease;
    ownsRetentionLock = false;
  } else {
    try {
      retentionLock = acquireSessionRetentionLock(dest.projectDir);
    } catch (err) {
      closeSync(parent.anchor.fd);
      return { ok: false, error: errMsg(err) };
    }
  }
  const failBeforeTemp = (error: string): SessionResult<{ temp: TempBundle }> => {
    closeSync(parent.anchor.fd);
    if (ownsRetentionLock) releaseSessionRetentionLock(retentionLock);
    return { ok: false, error };
  };
  const destination = inspectEntry(dest.bundleDir);
  if (destination) {
    return failBeforeTemp(destination.kind === "symlink" ? "destination session bundle is a symlink" : "destination session bundle already exists");
  }
  const retained = retainedTempUsage(dest.projectDir);
  if (!retained.ok) {
    return failBeforeTemp(retained.error);
  }
  if (retained.count >= MAX_RETAINED_TEMP_BUNDLES) {
    return failBeforeTemp(`retained temporary sessions are at capacity (${MAX_RETAINED_TEMP_BUNDLES} bundles); resolve retained cleanup before retrying`);
  }
  // Reserve half the aggregate bound while the lock is held. A failed or
  // externally faulted staging operation can retain a large tree; this
  // durable reservation prevents a second process from admitting another
  // large tree based on a stale low-water scan.
  if (retained.bytes > MAX_RETAINED_TEMP_BYTES - RETAINED_TEMP_ADMISSION_RESERVATION_BYTES) {
    return failBeforeTemp(`retained temporary sessions would exceed ${MAX_RETAINED_TEMP_BYTES} bytes; resolve retained cleanup before retrying`);
  }
  for (let attempt = 0; attempt < 16; attempt++) {
    const path = join(dest.projectDir, `t-${randomBytes(16).toString("hex")}`);
    try {
      mkdirSync(anchoredChildPath(parent.anchor, basename(path), path), { recursive: false, mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      return failBeforeTemp(errMsg(err));
    }
    const tempAnchor = openDirectoryAnchor(
      path,
      "temporary session bundle",
      anchoredChildPath(parent.anchor, basename(path), path),
    );
    if (!tempAnchor.ok) {
      return failBeforeTemp(tempAnchor.error);
    }
    try {
      options?.testHooks?.afterTempCreated?.(path);
    } catch (err) {
      closeSync(tempAnchor.anchor.fd);
      closeSync(parent.anchor.fd);
      retainUnboundCleanup(path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
      if (ownsRetentionLock) releaseSessionRetentionLock(retentionLock);
      return { ok: false, error: errMsg(err) };
    }
    const parentStable = validateDirectoryAnchor(parent.anchor);
    const tempStable = validateDirectoryAnchor(tempAnchor.anchor);
    if (!parentStable.ok || !tempStable.ok) {
      closeSync(tempAnchor.anchor.fd);
      closeSync(parent.anchor.fd);
      retainUnboundCleanup(path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
      if (ownsRetentionLock) releaseSessionRetentionLock(retentionLock);
      if (!parentStable.ok) return parentStable;
      if (!tempStable.ok) return tempStable;
      return { ok: false, error: "temporary session bundle identity changed" };
    }
    const retainedAfterCreate = retainedTempUsage(dest.projectDir);
    if (!retainedAfterCreate.ok || retainedAfterCreate.bytes > MAX_RETAINED_TEMP_BYTES) {
      closeSync(tempAnchor.anchor.fd);
      closeSync(parent.anchor.fd);
      retainUnboundCleanup(path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
      if (ownsRetentionLock) releaseSessionRetentionLock(retentionLock);
      return { ok: false, error: retainedAfterCreate.ok ? `retained temporary sessions exceed ${MAX_RETAINED_TEMP_BYTES} bytes` : retainedAfterCreate.error };
    }
    const currentDir = join(path, CURRENT_DIR);
    try {
      mkdirSync(anchoredChildPath(tempAnchor.anchor, CURRENT_DIR, currentDir), { recursive: false, mode: 0o700 });
    } catch (err) {
      closeSync(tempAnchor.anchor.fd);
      closeSync(parent.anchor.fd);
      retainUnboundCleanup(path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
      if (ownsRetentionLock) releaseSessionRetentionLock(retentionLock);
      return { ok: false, error: errMsg(err) };
    }
    const currentAnchor = openDirectoryAnchor(
      currentDir,
      "temporary session current directory",
      anchoredChildPath(tempAnchor.anchor, CURRENT_DIR, currentDir),
    );
    if (!currentAnchor.ok) {
      closeSync(tempAnchor.anchor.fd);
      closeSync(parent.anchor.fd);
      retainUnboundCleanup(path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
      if (ownsRetentionLock) releaseSessionRetentionLock(retentionLock);
      return currentAnchor;
    }
    try {
      const active = openSync(
        anchoredChildPath(currentAnchor.anchor, ACTIVE_NAME, join(currentDir, ACTIVE_NAME)),
        noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
        0o600,
      );
      fsyncSync(active);
      closeSync(active);
    } catch (err) {
      closeSync(currentAnchor.anchor.fd);
      closeSync(tempAnchor.anchor.fd);
      closeSync(parent.anchor.fd);
      retainUnboundCleanup(path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
      if (ownsRetentionLock) releaseSessionRetentionLock(retentionLock);
      return { ok: false, error: errMsg(err) };
    }
    const temp: TempBundle = {
      path,
      currentDir,
      sessionFile: join(currentDir, ACTIVE_NAME),
      retainedBytes: retainedAfterCreate.bytes,
      parent: parent.anchor,
      temp: tempAnchor.anchor,
      current: currentAnchor.anchor,
      retentionLock,
      ownsRetentionLock,
    };
    const stable = validateTempBundle(temp);
    if (!stable.ok) {
      closeTempBundle(temp);
      retainUnboundCleanup(path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
      releaseTempRetentionLock(temp);
      return stable;
    }
    return { ok: true, temp };
  }
  closeSync(parent.anchor.fd);
  if (ownsRetentionLock) releaseSessionRetentionLock(retentionLock);
  return { ok: false, error: "could not reserve a temporary session bundle" };
}


export function removeEmptyAppOwnedClaim(
  path: string,
  parent: DirectoryAnchor,
  owned: DirectoryAnchor,
  options?: SessionOperationOptions,
): SessionResult {
  try {
    const stable = validateDirectoryAnchor(parent);
    if (!stable.ok) return stable;
    const stillOwned = validateReopenedDirectoryIdentity(owned, parent, false);
    if (!stillOwned.ok) return stillOwned;
    options?.testHooks?.afterDestinationCleanupIdentityProof?.(path);
    const ownedAfterProof = validateReopenedDirectoryIdentity(owned, parent, false);
    if (!ownedAfterProof.ok) return ownedAfterProof;
    // Node has no descriptor-relative rmdir/unlinkat primitive. A final
    // identity proof followed by a pathname removal would still resolve the
    // mutable leaf (and its ancestors) again, so a same-UID swap could delete
    // an unrelated replacement. Retain the claim and surface uncertainty
    // until cleanup can be bound to the retained directory descriptor.
    return retainUnboundCleanup(path, options?.testHooks?.beforeDestinationCleanupMutation);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}


export function validateCommittedDestination(temp: TempBundle, committed: DirectoryAnchor): SessionResult {
  for (const anchor of [temp.parent, temp.temp, temp.current, committed]) {
    const valid = validateDirectoryAnchor(anchor);
    if (!valid.ok) return valid;
  }
  const reopenedBundle = validateReopenedDirectoryIdentity(committed, temp.parent, true);
  if (!reopenedBundle.ok) return reopenedBundle;
  return validateReopenedDirectoryIdentity(temp.current, committed, true);
}


export async function copyReferencedImages(
  sourceCurrent: string,
  temp: TempBundle,
  names: string[],
  options?: SessionOperationOptions,
): Promise<SessionResult> {
  const source = openDirectoryAnchor(sourceCurrent, "source image directory");
  if (!source.ok) return source;
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    for (const name of names) {
      const cancelledBeforeCopy = cancellation(options?.signal);
      if (cancelledBeforeCopy) return cancelledBeforeCopy;
      const tempStable = validateTempBundle(temp);
      if (!tempStable.ok) return tempStable;
      const sourceStable = validateDirectoryAnchor(source.anchor);
      if (!sourceStable.ok) return sourceStable;
      const src = join(sourceCurrent, name);
      options?.testHooks?.beforeImageOpen?.(src);
      let sourceFd: number | null = null;
      let destinationFd: number | null = null;
      try {
        sourceFd = openSync(anchoredChildPath(source.anchor, name, src), noFollowFlags(fsConstants.O_RDONLY));
        const before = fstatSync(sourceFd, { bigint: true });
        const atPath = lstatSync(src, { bigint: true });
        if (!before.isFile() || atPath.isSymbolicLink() || !atPath.isFile()) throw new Error(`referenced image is not a stable file: ${name}`);
        const identity = statIdentity(before);
        if (!sameVersion(identity, statIdentity(atPath)) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(`referenced image changed while opening: ${name}`);
        }
        const sourceStillStable = validateDirectoryAnchor(source.anchor);
        if (!sourceStillStable.ok) throw new Error(sourceStillStable.error);
        const size = Number(before.size);
        if (temp.retainedBytes > MAX_RETAINED_TEMP_BYTES - size) {
          throw new Error(`retained temporary sessions would exceed ${MAX_RETAINED_TEMP_BYTES} bytes`);
        }
        destinationFd = openSync(
          anchoredChildPath(temp.current, name, join(temp.currentDir, name)),
          noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
          0o600,
        );
        let position = 0;
        while (position < size) {
          const read = readSync(sourceFd, chunk, 0, Math.min(chunk.length, size - position), position);
          if (read < 1) throw new Error(`referenced image changed while reading: ${name}`);
          let written = 0;
          while (written < read) {
            const count = writeSync(destinationFd, chunk, written, read - written);
            if (count < 1) throw new Error(`could not copy referenced image: ${name}`);
            written += count;
          }
          position += read;
        }
        fsyncSync(destinationFd);
        if (!sameVersion(identity, statIdentity(fstatSync(sourceFd, { bigint: true })))) {
          throw new Error(`referenced image changed while reading: ${name}`);
        }
        const finalPath = lstatSync(src, { bigint: true });
        if (finalPath.isSymbolicLink() || !sameVersion(identity, statIdentity(finalPath))) {
          throw new Error(`referenced image changed while reading: ${name}`);
        }
        temp.retainedBytes += size;
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      } finally {
        if (sourceFd !== null) closeSync(sourceFd);
        if (destinationFd !== null) closeSync(destinationFd);
      }
    }
    return validateTempBundle(temp);
  } finally {
    closeSync(source.anchor.fd);
  }
}


export function validateForkDestination(dest: SessionBundlePaths): SessionResult {
  const project = inspectEntry(dest.projectDir);
  if (!project) {
    const ancestor = openOwnedDestinationParent(dirname(dest.projectDir));
    if (!ancestor.ok) return ancestor;
    try {
      return validateDirectoryAnchor(ancestor.anchor);
    } finally {
      closeSync(ancestor.anchor.fd);
    }
  }
  if (project.kind === "symlink") return { ok: false, error: "destination project directory is a symlink" };
  if (project.kind !== "dir") return { ok: false, error: "destination project path is not a directory" };
  const parent = openOwnedDestinationParent(dest.projectDir);
  if (!parent.ok) return parent;
  try {
    const bundle = inspectEntry(dest.bundleDir);
    if (bundle?.kind === "symlink") return { ok: false, error: "destination session bundle is a symlink" };
    if (bundle) return { ok: false, error: "destination session bundle already exists" };
    return validateDirectoryAnchor(parent.anchor);
  } finally {
    closeSync(parent.anchor.fd);
  }
}
