/**
 * Session bundle lifecycle operations.
 *
 * Owns ensure/prepare/clear/quarantine, empty-session inspection and
 * removal, logical session listing, and the append-only session writer.
 * Split from agent-core/session.ts (issue #38).
 */
import { errorCode } from "../../shared/guards.ts";
import { closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, readdirSync, renameSync, writeSync, type BigIntStats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createCurrentDir, createSessionBundleWithAdmission, currentHasContent, listCurrentSegments, recoverActiveSegment, renameCurrentUnique, retainUnboundCleanup } from "./bundles.ts";
import { anchoredChildPath, fsyncDirectory, openDirectoryAnchor, validateDirectoryAnchor } from "./descriptors.ts";
import type { DirectoryAnchor } from "./descriptors.ts";
import { ACTIVE_NAME, ARCHIVE_PREFIX, BAD_PREFIX, CURRENT_DIR, MAX_SESSION_RECORD_BYTES, MAX_SESSION_SEGMENT_BYTES, READ_CHUNK, errMsg, inspectEntry, isCoreSessionId, parseSessionBundlePath, partFileName, sessionBundleLimit, yieldToEventLoop } from "./primitives.ts";
import type { EmptySessionBundleInspection, LogicalSessionEntry, SessionBundlePaths, SessionOperationOptions, SessionResult, SessionTestHooks } from "./primitives.ts";


export function ensureSessionBundle(
  sessionFile: string,
  options?: Pick<SessionOperationOptions, "testHooks">,
): SessionResult<SessionBundlePaths> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const project = inspectEntry(parsed.projectDir);
  if (project?.kind === "symlink") return { ok: false, error: "session project directory is a symlink" };
  if (project && project.kind !== "dir") return { ok: false, error: "session project path is not a directory" };
  const bundle = inspectEntry(parsed.bundleDir);
  if (bundle?.kind === "symlink") return { ok: false, error: "session bundle is a symlink" };
  if (bundle && bundle.kind !== "dir") return { ok: false, error: "session bundle is not a directory" };
  const current = inspectEntry(parsed.currentDir);
  if (!current) {
    const created = createSessionBundleWithAdmission(parsed, options?.testHooks);
    if (!created.ok) return created;
    return { ok: true, ...parsed };
  }
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  const recovered = recoverActiveSegment(parsed.currentDir, parsed.sessionFile);
  if (!recovered.ok) return recovered;
  return { ok: true, ...parsed };
}


export function prepareFreshSession(sessionFile: string, now = Date.now()): SessionResult<{ archived: string | null }> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const project = inspectEntry(parsed.projectDir);
  if (project?.kind === "symlink") return { ok: false, error: "session project directory is a symlink" };
  if (project && project.kind !== "dir") return { ok: false, error: "session project path is not a directory" };
  const bundle = inspectEntry(parsed.bundleDir);
  if (bundle?.kind === "symlink") return { ok: false, error: "session bundle is a symlink" };
  if (bundle && bundle.kind !== "dir") return { ok: false, error: "session bundle is not a directory" };
  const current = inspectEntry(parsed.currentDir);
  if (!current) {
    const created = createSessionBundleWithAdmission(parsed);
    if (!created.ok) return created;
    return { ok: true, archived: null };
  }
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  const listing = listCurrentSegments(parsed.currentDir);
  if (!listing.ok) return listing;
  if (!currentHasContent(listing)) {
    if (!listing.active) {
      const created = createCurrentDir(parsed.currentDir, parsed.sessionFile);
      if (!created.ok) return created;
    }
    return { ok: true, archived: null };
  }
  const rotated = renameCurrentUnique(parsed.currentDir, ARCHIVE_PREFIX, now);
  if (!rotated.ok) return rotated;
  const created = createCurrentDir(parsed.currentDir, parsed.sessionFile);
  if (!created.ok) return created;
  return { ok: true, archived: rotated.aside };
}


export function clearSessionBundle(sessionFile: string, now = Date.now()): SessionResult<{ archived: string | null }> {
  return prepareFreshSession(sessionFile, now);
}


export function quarantineSessionBundle(sessionFile: string, now = Date.now()): SessionResult<{ aside: string }> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const current = inspectEntry(parsed.currentDir);
  if (!current) return { ok: false, error: "current directory is missing" };
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  return renameCurrentUnique(parsed.currentDir, BAD_PREFIX, now);
}


/**
 * Inspect the exact empty-bundle shape and retain the directory identities
 * required by the native bound cleanup owner.  This deliberately performs no
 * pathname mutation: callers without a native descriptor boundary must keep
 * the bundle as evidence and retry through the owner later.
 */
export async function inspectEmptySessionBundle(
  sessionFile: string,
  options?: SessionOperationOptions,
): Promise<EmptySessionBundleInspection> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const controls = sessionBundleLimit(options);
  if (!controls.ok) return controls;

  const project = inspectEntry(parsed.projectDir);
  if (!project) return { ok: true, empty: false };
  if (project.kind === "symlink") return { ok: false, error: "session project directory is a symlink" };
  if (project.kind !== "dir") return { ok: false, error: "session project path is not a directory" };
  const bundle = inspectEntry(parsed.bundleDir);
  if (!bundle) return { ok: true, empty: false };
  if (bundle.kind === "symlink") return { ok: false, error: "session bundle is not a directory" };
  if (bundle.kind !== "dir") return { ok: false, error: "session bundle is not a directory" };

  let projectAnchor: DirectoryAnchor | null = null;
  let bundleAnchor: DirectoryAnchor | null = null;
  let currentAnchor: DirectoryAnchor | null = null;
  try {
    const openedProject = openDirectoryAnchor(parsed.projectDir, "session project directory");
    if (!openedProject.ok) return openedProject;
    projectAnchor = openedProject.anchor;

    const openedBundle = openDirectoryAnchor(
      parsed.bundleDir,
      "session bundle",
      anchoredChildPath(projectAnchor, basename(parsed.bundleDir), parsed.bundleDir),
    );
    if (!openedBundle.ok) return openedBundle;
    bundleAnchor = openedBundle.anchor;

    let bundleNames: string[];
    try {
      bundleNames = readdirSync(bundleAnchor.path);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    if (bundleNames.length !== 1 || bundleNames[0] !== CURRENT_DIR) return { ok: true, empty: false };

    const currentEntry = inspectEntry(parsed.currentDir);
    if (!currentEntry) return { ok: true, empty: false };
    if (currentEntry.kind === "symlink") return { ok: false, error: "current is not a directory" };
    if (currentEntry.kind !== "dir") return { ok: false, error: "current is not a directory" };
    const openedCurrent = openDirectoryAnchor(
      parsed.currentDir,
      "session current directory",
      anchoredChildPath(bundleAnchor, basename(parsed.currentDir), parsed.currentDir),
    );
    if (!openedCurrent.ok) return openedCurrent;
    currentAnchor = openedCurrent.anchor;

    let currentNames: string[];
    try {
      currentNames = readdirSync(currentAnchor.path);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    if (currentNames.length !== 1 || currentNames[0] !== ACTIVE_NAME) return { ok: true, empty: false };

    let active: BigIntStats;
    try {
      active = lstatSync(
        anchoredChildPath(currentAnchor, ACTIVE_NAME, parsed.sessionFile),
        { bigint: true },
      );
    } catch (err) {
      if (errorCode(err) === "ENOENT") return { ok: true, empty: false };
      return { ok: false, error: errMsg(err) };
    }
    if (active.isSymbolicLink() || !active.isFile() || active.size !== 0n) return { ok: true, empty: false };

    for (const anchor of [projectAnchor, bundleAnchor, currentAnchor]) {
      const stable = validateDirectoryAnchor(anchor);
      if (!stable.ok) return stable;
    }
    return {
      ok: true,
      empty: true,
      proof: {
        sessionFile: parsed.sessionFile,
        bundleDir: parsed.bundleDir,
        projectDir: parsed.projectDir,
        rootIdentity: {
          dev: String(projectAnchor.identity.dev),
          ino: String(projectAnchor.identity.ino),
          birthtimeNs: String(projectAnchor.identity.birthtimeNs),
        },
        bundleIdentity: {
          dev: String(bundleAnchor.identity.dev),
          ino: String(bundleAnchor.identity.ino),
        },
      },
    };
  } finally {
    if (currentAnchor) closeSync(currentAnchor.fd);
    if (bundleAnchor) closeSync(bundleAnchor.fd);
    if (projectAnchor) closeSync(projectAnchor.fd);
  }
}


export async function removeEmptySessionBundle(
  sessionFile: string,
  options?: SessionOperationOptions,
): Promise<SessionResult<{ removed: boolean }>> {
  const inspected = await inspectEmptySessionBundle(sessionFile, options);
  if (!inspected.ok) return inspected;
  if (!inspected.empty) return { ok: true, removed: false };
  // Node has no descriptor-relative recursive remove. The proof above is
  // useful to a native owner, but this API intentionally remains non-mutating
  // when called without that owner. Retain bounded evidence for later native
  // reclaim rather than deleting an unrelated same-UID replacement.
  retainUnboundCleanup(inspected.proof.bundleDir, options?.testHooks?.beforeEmptySessionCleanupMutation);
  return { ok: true, removed: false };
}


export async function listLogicalSessions(projectDir: string): Promise<LogicalSessionEntry[]> {
  let names: string[];
  try {
    names = await readdir(projectDir);
  } catch {
    return [];
  }
  const out: LogicalSessionEntry[] = [];
  for (const name of names) {
    if (!isCoreSessionId(name)) continue;
    const bundleDir = join(projectDir, name);
    const info = inspectEntry(bundleDir);
    if (!info || info.kind !== "dir") continue;
    let children: string[];
    try {
      children = await readdir(bundleDir);
    } catch {
      continue;
    }
    for (const child of children) {
      if (child !== CURRENT_DIR && !child.startsWith(ARCHIVE_PREFIX)) continue;
      const dir = join(bundleDir, child);
      const dirInfo = inspectEntry(dir);
      if (!dirInfo || dirInfo.kind !== "dir") continue;
      const listing = listCurrentSegments(dir);
      if (!listing.ok) continue;
      const segments: string[] = listing.parts.map((p) => p.path);
      if (listing.active) segments.push(listing.active.path);
      let mtimeMs = 0;
      for (const path of segments) {
        try {
          const st = await stat(path);
          if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
        } catch {
          /* skip one segment */
        }
      }
      if (mtimeMs === 0) {
        try {
          const st = await stat(dir);
          mtimeMs = st.mtimeMs;
        } catch {
          continue;
        }
      }
      const sessionFile = join(dir, ACTIVE_NAME);
      out.push({
        path: sessionFile,
        name: child === CURRENT_DIR ? `${name}/${CURRENT_DIR}/${ACTIVE_NAME}` : `${name}/${child}/${ACTIVE_NAME}`,
        mtimeMs,
        kind: child === CURRENT_DIR ? "current" : "archive",
        sessionId: name,
        segments,
      });
    }
    await yieldToEventLoop();
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}


function discardIncompleteActiveTail(path: string): SessionResult<{ size: number }> {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r+");
    const size = fstatSync(fd).size;
    if (size === 0) return { ok: true, size: 0 };
    const last = Buffer.allocUnsafe(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return { ok: true, size };
    let cursor = size;
    while (cursor > 0) {
      const start = Math.max(0, cursor - READ_CHUNK);
      const chunk = Buffer.allocUnsafe(cursor - start);
      const read = readSync(fd, chunk, 0, chunk.length, start);
      const newline = chunk.subarray(0, read).lastIndexOf(0x0a);
      if (newline >= 0) {
        const durableSize = start + newline + 1;
        ftruncateSync(fd, durableSize);
        fsyncSync(fd);
        return { ok: true, size: durableSize };
      }
      cursor = start;
    }
    ftruncateSync(fd, 0);
    fsyncSync(fd);
    return { ok: true, size: 0 };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}


function encodeRecord(record: Record<string, unknown>): SessionResult<{ line: Buffer }> {
  let json: string;
  try {
    json = JSON.stringify(record);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  const line = Buffer.from(`${json}\n`, "utf8");
  if (line.length > MAX_SESSION_RECORD_BYTES) return { ok: false, error: "record exceeds MAX_SESSION_RECORD_BYTES" };
  return { ok: true, line };
}


export class SessionWriter {
  readonly sessionFile: string;
  readonly currentDir: string;
  private fd: number | null = null;
  private activeBytes = 0;
  private nextPart = 1;
  private lastStorageSeq: number;
  private poisoned = false;
  private readonly rollTestHook: SessionTestHooks["beforeSegmentRollRename"];

  private constructor(
    sessionFile: string,
    currentDir: string,
    lastStorageSeq: number,
    rollTestHook?: SessionTestHooks["beforeSegmentRollRename"],
  ) {
    this.sessionFile = sessionFile;
    this.currentDir = currentDir;
    this.lastStorageSeq = lastStorageSeq;
    this.rollTestHook = rollTestHook;
  }

  static open(
    sessionFile: string,
    lastStorageSeq: number,
    options?: Pick<SessionOperationOptions, "testHooks">,
  ): SessionResult<{ writer: SessionWriter }> {
    if (!Number.isInteger(lastStorageSeq) || lastStorageSeq < 0) return { ok: false, error: "invalid lastStorageSeq" };
    const controls = sessionBundleLimit(options);
    if (!controls.ok) return controls;
    const ensured = ensureSessionBundle(sessionFile, options);
    if (!ensured.ok) return ensured;
    const listing = listCurrentSegments(ensured.currentDir);
    if (!listing.ok) return listing;
    const recovered = listing.active ? listing : recoverActiveSegment(ensured.currentDir, ensured.sessionFile);
    if (!recovered.ok) return recovered;
    if (!recovered.active) return { ok: false, error: "active segment is missing" };
    const repaired = discardIncompleteActiveTail(ensured.sessionFile);
    if (!repaired.ok) return repaired;
    const writer = new SessionWriter(ensured.sessionFile, ensured.currentDir, lastStorageSeq, options?.testHooks?.beforeSegmentRollRename);
    writer.activeBytes = repaired.size;
    writer.nextPart = recovered.parts.length > 0 ? recovered.parts[recovered.parts.length - 1]!.n + 1 : 1;
    try {
      writer.fd = openSync(ensured.sessionFile, "a", 0o600);
      const info = fstatSync(writer.fd);
      writer.activeBytes = info.size;
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    return { ok: true, writer };
  }

  get activeSize(): number {
    return this.activeBytes;
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
  }

  private reopenActive(): SessionResult {
    this.close();
    try {
      this.fd = openSync(this.sessionFile, "a", 0o600);
      this.activeBytes = fstatSync(this.fd).size;
      const synced = fsyncDirectory(this.currentDir);
      if (!synced.ok) {
        this.close();
        return synced;
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  private roll(): SessionResult {
    this.close();
    const partPath = join(this.currentDir, partFileName(this.nextPart));
    try {
      const claim = openSync(partPath, "wx", 0o600);
      closeSync(claim);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    try {
      this.rollTestHook?.(partPath);
      renameSync(this.sessionFile, partPath);
    } catch (err) {
      // The exclusive claim may have been replaced while the source rename
      // was failing. Node has no descriptor-relative unlink; retaining the
      // claim is the only fail-closed outcome that cannot delete a competitor.
      return { ok: false, error: errMsg(err) };
    }
    const rolled = fsyncDirectory(this.currentDir);
    if (!rolled.ok) return rolled;
    try {
      const fd = openSync(this.sessionFile, "wx", 0o600);
      closeSync(fd);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    const activated = fsyncDirectory(this.currentDir);
    if (!activated.ok) return activated;
    this.nextPart += 1;
    this.activeBytes = 0;
    return this.reopenActive();
  }

  appendRecord(record: Record<string, unknown>): SessionResult<{ storageSeq: number }> {
    if (this.poisoned) return { ok: false, error: "session writer is poisoned after an append failure" };
    if (typeof record.storageSeq !== "number" || !Number.isInteger(record.storageSeq) || record.storageSeq < 1) {
      return { ok: false, error: "invalid storageSeq" };
    }
    if (record.storageSeq <= this.lastStorageSeq) {
      return { ok: false, error: record.storageSeq === this.lastStorageSeq ? "duplicate storageSeq" : "decreasing storageSeq" };
    }
    const encoded = encodeRecord(record);
    if (!encoded.ok) return encoded;
    if (this.activeBytes + encoded.line.length > MAX_SESSION_SEGMENT_BYTES) {
      const rolled = this.roll();
      if (!rolled.ok) return rolled;
    }
    if (this.fd === null) {
      const opened = this.reopenActive();
      if (!opened.ok) return opened;
    }
    let preWriteOffset = this.activeBytes;
    try {
      preWriteOffset = fstatSync(this.fd!).size;
      let offset = 0;
      while (offset < encoded.line.length) {
        const written = writeSync(this.fd!, encoded.line, offset, encoded.line.length - offset);
        if (written === 0) throw new Error("could not write the session record");
        offset += written;
      }
      fsyncSync(this.fd!);
      this.activeBytes = preWriteOffset + encoded.line.length;
      this.lastStorageSeq = record.storageSeq;
      return { ok: true, storageSeq: record.storageSeq };
    } catch (err) {
      // A short write or fsync failure must never leave a tail that can be
      // mistaken for a durable record. Roll it back, then poison this writer
      // even when rollback succeeds so the caller cannot reuse a sequence on
      // an uncertain durability boundary.
      const rollbackOffset = typeof preWriteOffset === "number" ? preWriteOffset : this.activeBytes;
      let rolledBack = false;
      try {
        if (this.fd !== null) {
          ftruncateSync(this.fd, rollbackOffset);
          fsyncSync(this.fd);
          this.activeBytes = rollbackOffset;
          rolledBack = true;
        }
      } catch {
        /* The descriptor may already be unusable; poisoning is fail-closed. */
      }
      this.poisoned = true;
      this.close();
      const suffix = rolledBack ? "" : "; session writer poisoned and rollback failed";
      return { ok: false, error: `${errMsg(err)}${suffix}` };
    }
  }
}
