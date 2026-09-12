/**
 * Session bundle open/list/probe/create machinery.
 *
 * Owns descriptor-bound bundle opening, segment listing, existence probes,
 * retained-staging ownership, admission-bounded creation, and sibling
 * rotate/create/recover helpers. Split from agent-core/session.ts (issue #38).
 */
import { errorCode } from "../../shared/guards.ts";
import { acquireSessionRetentionLock, releaseSessionRetentionLock, type SessionRetentionLock } from "../../shared/session-retention-lock.ts";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { anchoredChildPath, closeOpenSessionBundle, fsyncDirectory, fsyncDirectoryAndParent, fsyncDirectoryDescriptor, noFollowFlags, openDirectoryAnchor, sameVersion, statIdentity, validateDirectoryAnchor, validateSegment } from "./descriptors.ts";
import type { DirectoryAnchor, OpenSessionBundle, OpenSessionSegment, StableIdentity } from "./descriptors.ts";
import { ACTIVE_NAME, CORE_SESSION_ID, CURRENT_DIR, MAX_EMPTY_SESSION_ADMISSION_BYTES, MAX_EMPTY_SESSION_ADMISSION_ENTRIES, MAX_EMPTY_SESSION_ADMISSION_WORK_BYTES, MAX_RETAINED_EMPTY_SESSION_BUNDLES, READ_CHUNK, RETAINED_STAGING_OWNER_BYTES, RETAINED_STAGING_OWNER_NAME, TEMP_BUNDLE_NAME, UNBOUND_CLEANUP_ERROR, errMsg, inspectEntry, isCoreSessionId, isSafeImageName, parseSessionBundlePath, partFileName, partNumber, sessionRotateStamp } from "./primitives.ts";
import type { SessionBundlePaths, SessionFailure, SessionOperationOptions, SessionResult, SessionTestHooks } from "./primitives.ts";


/**
 * Associate an unremovable temporary sibling with the retention transaction
 * that created it.  The marker carries the original directory identity so a
 * later explicit discard can reject a replacement rather than deleting it.
 */
function writeRetainedStagingOwner(path: string, runId: string): void {
  if (!TEMP_BUNDLE_NAME.test(basename(path)) || !CORE_SESSION_ID.test(runId)) return;
  let directory;
  try {
    directory = lstatSync(path);
  } catch {
    return;
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) return;
  const marker = join(path, RETAINED_STAGING_OWNER_NAME);
  try {
    const existing = lstatSync(marker);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size > RETAINED_STAGING_OWNER_BYTES) {
      return;
    }
    // A marker is immutable evidence. Never overwrite a marker belonging to
    // another transaction, even when the staging pathname is reused.
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  try {
    const content = `${JSON.stringify({ runId, dev: directory.dev, ino: directory.ino })}\n`;
    writeFileSync(marker, content, { flag: "wx", mode: 0o600 });
    const fd = openSync(marker, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const synced = fsyncDirectory(path);
    if (!synced.ok) return;
  } catch {
    // The staging sibling remains evidence if its owner marker could not be
    // durably published. The retention owner will fail closed on recovery.
  }
}


/**
 * Node exposes no descriptor-relative recursive directory removal primitive.
 * Keep this boundary deliberately non-mutating: after a descriptor is closed
 * (or after a read-only proof), the pathname may name a different same-UID
 * object by the time a recursive remove resolves it.
 */
export function retainUnboundCleanup(path: string, hook?: (path: string) => void, retentionRunId?: string): SessionFailure {
  try {
    if (retentionRunId) writeRetainedStagingOwner(path, retentionRunId);
    hook?.(path);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  return { ok: false, error: UNBOUND_CLEANUP_ERROR };
}


type CurrentListing = {
  parts: Array<{ n: number; path: string; size: number }>;
  active: { path: string; size: number } | null;
  images: string[];
};


function currentListingBytes(listing: CurrentListing): SessionResult<{ bytes: number }> {
  let bytes = 0;
  const segments = [...listing.parts, ...(listing.active ? [listing.active] : [])];
  for (const segment of segments) {
    if (!Number.isSafeInteger(segment.size) || segment.size < 0 || bytes > Number.MAX_SAFE_INTEGER - segment.size) {
      return { ok: false, error: "session bundle byte count overflow" };
    }
    bytes += segment.size;
  }
  return { ok: true, bytes };
}


export function enforceSessionBundleLimit(listing: CurrentListing, limit: number): SessionResult<{ bytes: number }> {
  const counted = currentListingBytes(listing);
  if (!counted.ok) return counted;
  if (counted.bytes > limit) {
    return { ok: false, error: `session bundle exceeds MAX_SESSION_BUNDLE_BYTES (${counted.bytes} bytes)` };
  }
  return counted;
}


export function listCurrentSegments(currentDir: string): SessionResult<CurrentListing> {
  const current = inspectEntry(currentDir);
  if (!current) return { ok: false, error: "current directory is missing" };
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  let names: string[];
  try {
    names = readdirSync(currentDir);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  const parts: CurrentListing["parts"] = [];
  const seen = new Set<number>();
  let active: CurrentListing["active"] = null;
  const images: string[] = [];
  for (const name of names) {
    const path = join(currentDir, name);
    const info = inspectEntry(path);
    if (!info) continue;
    if (name.endsWith(".jsonl")) {
      if (info.kind === "symlink") return { ok: false, error: `jsonl is a symlink: ${name}` };
      if (info.kind !== "file") return { ok: false, error: `jsonl is not a file: ${name}` };
      if (name === ACTIVE_NAME) {
        active = { path, size: info.size };
        continue;
      }
      const n = partNumber(name);
      if (n === null) return { ok: false, error: `unexpected jsonl name: ${name}` };
      if (seen.has(n)) return { ok: false, error: `duplicate part number: ${name}` };
      seen.add(n);
      parts.push({ n, path, size: info.size });
      continue;
    }
    if (info.kind === "file" && isSafeImageName(name)) images.push(name);
  }
  parts.sort((a, b) => a.n - b.n);
  for (let index = 0; index < parts.length; index++) {
    const expected = index + 1;
    if (parts[index]!.n !== expected) {
      return { ok: false, error: `non-contiguous session part: expected ${partFileName(expected)}` };
    }
  }
  return { ok: true, parts, active, images };
}


export function currentHasContent(listing: CurrentListing): boolean {
  if (listing.images.length > 0) return true;
  if (listing.active && listing.active.size > 0) return true;
  return listing.parts.some((p) => p.size > 0);
}


function validateOpenSessionBundle(bundle: OpenSessionBundle): SessionResult {
  for (const anchor of bundle.anchors) {
    const valid = validateDirectoryAnchor(anchor);
    if (!valid.ok) return valid;
  }
  for (const segment of bundle.segments) {
    const valid = validateSegment(segment);
    if (!valid.ok) return valid;
  }
  const current = bundle.anchors[bundle.anchors.length - 1]!;
  const listing = listCurrentSegments(current.path);
  if (!listing.ok) return listing;
  const paths = [...listing.parts.map((part) => part.path), ...(listing.active ? [listing.active.path] : [])];
  if (paths.length !== bundle.segments.length || paths.some((path, index) => path !== bundle.segments[index]!.path)) {
    return { ok: false, error: "session segment set changed" };
  }
  return { ok: true };
}


export function validateOpenSegmentAccess(bundle: OpenSessionBundle, segment: OpenSessionSegment): SessionResult {
  for (const anchor of bundle.anchors) {
    const valid = validateDirectoryAnchor(anchor);
    if (!valid.ok) return valid;
  }
  return validateSegment(segment);
}


export function openStableSessionBundle(
  parsed: SessionBundlePaths,
  listing: CurrentListing,
  limit: number,
  options?: SessionOperationOptions,
): SessionResult<{ bundle: OpenSessionBundle }> {
  const bundle: OpenSessionBundle = { anchors: [], segments: [] };
  const fail = (error: string): SessionFailure => {
    closeOpenSessionBundle(bundle);
    return { ok: false, error };
  };
  for (const [path, label] of [
    [parsed.projectDir, "session project directory"],
    [parsed.bundleDir, "session bundle"],
    [parsed.currentDir, "session current directory"],
  ] as const) {
    const parent = bundle.anchors[bundle.anchors.length - 1];
    const opened = openDirectoryAnchor(path, label, parent ? anchoredChildPath(parent, basename(path), path) : path);
    if (!opened.ok) return fail(opened.error);
    bundle.anchors.push(opened.anchor);
  }
  const expected = [
    ...listing.parts.map((part) => ({ path: part.path, allowTruncatedTail: false })),
    ...(listing.active ? [{ path: listing.active.path, allowTruncatedTail: true }] : []),
  ];
  let total = 0;
  for (let index = 0; index < expected.length; index++) {
    const item = expected[index]!;
    for (const anchor of bundle.anchors) {
      const valid = validateDirectoryAnchor(anchor);
      if (!valid.ok) return fail(valid.error);
    }
    options?.testHooks?.beforeSegmentOpen?.(item.path, index);
    let fd: number | null = null;
    try {
      const currentAnchor = bundle.anchors[bundle.anchors.length - 1]!;
      fd = openSync(anchoredChildPath(currentAnchor, basename(item.path), item.path), noFollowFlags(fsConstants.O_RDONLY));
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.size < 0 || opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`invalid session segment: ${basename(item.path)}`);
      }
      const size = Number(opened.size);
      if (total > limit - size) throw new Error(`session bundle exceeds MAX_SESSION_BUNDLE_BYTES (${total + size} bytes)`);
      const segment: OpenSessionSegment = {
        path: item.path,
        name: basename(item.path),
        fd,
        size,
        identity: statIdentity(opened),
        allowTruncatedTail: item.allowTruncatedTail,
      };
      bundle.segments.push(segment);
      fd = null;
      total += size;
      const valid = validateSegment(segment);
      if (!valid.ok) return fail(valid.error);
    } catch (err) {
      if (fd !== null) closeSync(fd);
      return fail(errMsg(err));
    }
  }
  options?.testHooks?.afterSegmentsOpened?.(bundle.segments.map((segment) => segment.path));
  const stable = validateOpenSessionBundle(bundle);
  if (!stable.ok) return fail(stable.error);
  return { ok: true, bundle };
}


export function fingerprintOpenSessionBundle(bundle: OpenSessionBundle, limit: number): SessionResult<{ fingerprint: string }> {
  const stableBeforeBundle = validateOpenSessionBundle(bundle);
  if (!stableBeforeBundle.ok) return stableBeforeBundle;
  let remaining = limit;
  const fingerprints: string[] = [];
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  for (const segment of bundle.segments) {
    const stableBefore = validateOpenSegmentAccess(bundle, segment);
    if (!stableBefore.ok) return stableBefore;
    if (segment.size > remaining) return { ok: false, error: "session bundle exceeds MAX_SESSION_BUNDLE_BYTES" };
    const hash = createHash("sha256");
    let position = 0;
    while (position < segment.size) {
      const length = Math.min(chunk.length, segment.size - position, remaining);
      if (length < 1) return { ok: false, error: "session bundle exceeds MAX_SESSION_BUNDLE_BYTES" };
      const n = readSync(segment.fd, chunk, 0, length, position);
      if (n < 1) return { ok: false, error: `session segment changed while hashing: ${segment.name}` };
      hash.update(chunk.subarray(0, n));
      position += n;
      remaining -= n;
    }
    const stableAfter = validateOpenSegmentAccess(bundle, segment);
    if (!stableAfter.ok) return stableAfter;
    fingerprints.push(formatSegmentFingerprint(segment, hash.digest("hex")));
  }
  const stableAfterBundle = validateOpenSessionBundle(bundle);
  if (!stableAfterBundle.ok) return stableAfterBundle;
  return { ok: true, fingerprint: fingerprints.join("\n") };
}


function formatSegmentFingerprint(segment: OpenSessionSegment, digest: string): string {
  const id = segment.identity;
  return `${segment.name}:${id.dev}:${id.ino}:${id.size}:${id.mtimeNs}:${id.ctimeNs}:${digest}`;
}


export function combinedSegmentFingerprint(bundle: OpenSessionBundle, digests: readonly string[]): SessionResult<{ fingerprint: string }> {
  const stable = validateOpenSessionBundle(bundle);
  if (!stable.ok) return stable;
  if (digests.length !== bundle.segments.length) return { ok: false, error: "session segment fingerprint count changed" };
  return {
    ok: true,
    fingerprint: bundle.segments.map((segment, index) => formatSegmentFingerprint(segment, digests[index]!)).join("\n"),
  };
}


export function sessionBundleExists(sessionFile: string): boolean {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return false;
  const info = inspectEntry(parsed.currentDir);
  return info !== null && info.kind === "dir";
}


export function sessionBundleHasContent(sessionFile: string): boolean {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return false;
  const listing = listCurrentSegments(parsed.currentDir);
  if (!listing.ok) return inspectEntry(parsed.currentDir) !== null;
  return currentHasContent(listing);
}


export function sessionBundleBytes(sessionFile: string): number | null {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return null;
  const listing = listCurrentSegments(parsed.currentDir);
  if (!listing.ok) return null;
  const counted = currentListingBytes(listing);
  return counted.ok ? counted.bytes : null;
}


function uniqueSiblingDir(parent: string, prefix: string, stamp: string): string {
  let dest = join(parent, `${prefix}${stamp}`);
  let n = 0;
  while (existsSync(dest)) {
    n += 1;
    dest = join(parent, `${prefix}${stamp}-${n}`);
  }
  return dest;
}


export function renameCurrentUnique(currentDir: string, prefix: string, now = Date.now()): SessionResult<{ aside: string }> {
  const parent = dirname(currentDir);
  const stamp = sessionRotateStamp(now);
  let dest = uniqueSiblingDir(parent, prefix, stamp);
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } catch {
    /* rename still tries */
  }
  for (;;) {
    try {
      renameSync(currentDir, dest);
      const synced = fsyncDirectory(parent);
      if (!synced.ok) return synced;
      return { ok: true, aside: dest };
    } catch (err) {
      if (existsSync(dest)) {
        dest = uniqueSiblingDir(parent, prefix, stamp);
        continue;
      }
      return { ok: false, error: errMsg(err) };
    }
  }
}


export function createCurrentDir(currentDir: string, sessionFile: string): SessionResult {
  try {
    mkdirSync(dirname(currentDir), { recursive: true, mode: 0o700 });
    mkdirSync(currentDir, { recursive: true, mode: 0o700 });
    const fd = openSync(sessionFile, "wx", 0o600);
    closeSync(fd);
    return fsyncDirectoryAndParent(currentDir);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code === "EEXIST") {
      const info = inspectEntry(sessionFile);
      if (info && info.kind === "file") return { ok: true };
      if (!info) {
        try {
          const fd = openSync(sessionFile, "wx", 0o600);
          closeSync(fd);
          return fsyncDirectoryAndParent(currentDir);
        } catch (inner) {
          return { ok: false, error: errMsg(inner) };
        }
      }
    }
    return { ok: false, error: errMsg(err) };
  }
}


export function recoverActiveSegment(currentDir: string, sessionFile: string): SessionResult<CurrentListing> {
  const listing = listCurrentSegments(currentDir);
  if (!listing.ok) return listing;
  if (listing.active) return listing;
  const created = createCurrentDir(currentDir, sessionFile);
  if (!created.ok) return created;
  const again = listCurrentSegments(currentDir);
  if (!again.ok) return again;
  if (!again.active) return { ok: false, error: "could not create the active segment" };
  return again;
}


/**
 * Count only the exact empty-bundle shape that the unbound cleanup path
 * retains. A malformed or unreadable entry is an admission failure rather
 * than a reason to guess that there is room. This is deliberately bounded so
 * a hostile/accidental project directory cannot turn session creation into an
 * unbounded scan.
 */
type EmptySessionAdmission = {
  count: number;
  bytes: number;
  workBytes: number;
};


function emptySessionBundleAdmission(projectDir: string): SessionResult<EmptySessionAdmission> {
  const project = inspectEntry(projectDir);
  if (!project) return { ok: true, count: 0, bytes: 0, workBytes: 0 };
  if (project.kind === "symlink") return { ok: false, error: "session project directory is a symlink" };
  if (project.kind !== "dir") return { ok: false, error: "session project path is not a directory" };
  let names: string[];
  try {
    names = readdirSync(projectDir);
  } catch (err) {
    return { ok: false, error: `could not inspect retained empty sessions: ${errMsg(err)}` };
  }
  if (names.length > MAX_EMPTY_SESSION_ADMISSION_ENTRIES) {
    return {
      ok: false,
      error: `retained empty session admission is unreadable above ${MAX_EMPTY_SESSION_ADMISSION_ENTRIES} entries; explicitly reclaim retained sessions before retrying`,
    };
  }
  let count = 0;
  let bytes = 0;
  let workBytes = Buffer.byteLength(projectDir, "utf8") + 1;
  if (workBytes > MAX_EMPTY_SESSION_ADMISSION_WORK_BYTES) {
    return { ok: false, error: "retained empty session admission exceeded its bounded work budget" };
  }
  for (const name of names) {
    if (!isCoreSessionId(name)) continue;
    const bundleDir = join(projectDir, name);
    const bundleWork = Buffer.byteLength(bundleDir, "utf8") + 1;
    if (workBytes > MAX_EMPTY_SESSION_ADMISSION_WORK_BYTES - bundleWork) {
      return { ok: false, error: "retained empty session admission exceeded its bounded work budget" };
    }
    workBytes += bundleWork;
    const bundle = inspectEntry(bundleDir);
    if (!bundle) return { ok: false, error: "retained empty session admission changed while it was inspected" };
    // A poisoned/symlinked sibling is not an empty bundle that this admission
    // can reclaim. Leave it as evidence and continue counting only the exact
    // shape below; the requested session id is still rejected by ensureSessionBundle
    // if it names this sibling directly.
    if (bundle.kind === "symlink") continue;
    if (bundle.kind !== "dir") continue;
    let bundleNames: string[];
    try {
      bundleNames = readdirSync(bundleDir);
    } catch (err) {
      return { ok: false, error: `could not inspect retained empty session: ${errMsg(err)}` };
    }
    if (bundleNames.length !== 1 || bundleNames[0] !== CURRENT_DIR) continue;
    const currentDir = join(bundleDir, CURRENT_DIR);
    const currentWork = Buffer.byteLength(currentDir, "utf8") + 1;
    if (workBytes > MAX_EMPTY_SESSION_ADMISSION_WORK_BYTES - currentWork) {
      return { ok: false, error: "retained empty session admission exceeded its bounded work budget" };
    }
    workBytes += currentWork;
    const current = inspectEntry(currentDir);
    if (!current) return { ok: false, error: "retained empty session admission changed while it was inspected" };
    if (current.kind === "symlink") continue;
    if (current.kind !== "dir") continue;
    let currentNames: string[];
    try {
      currentNames = readdirSync(currentDir);
    } catch (err) {
      return { ok: false, error: `could not inspect retained empty session current: ${errMsg(err)}` };
    }
    if (currentNames.length !== 1 || currentNames[0] !== ACTIVE_NAME) continue;
    const activePath = join(currentDir, ACTIVE_NAME);
    const activeWork = Buffer.byteLength(activePath, "utf8") + 1;
    if (workBytes > MAX_EMPTY_SESSION_ADMISSION_WORK_BYTES - activeWork) {
      return { ok: false, error: "retained empty session admission exceeded its bounded work budget" };
    }
    workBytes += activeWork;
    const active = inspectEntry(activePath);
    if (active?.kind === "file" && active.size === 0) {
      count += 1;
      if (bytes > MAX_EMPTY_SESSION_ADMISSION_BYTES - active.size) {
        return { ok: false, error: "retained empty session admission exceeded its byte bound" };
      }
      bytes += active.size;
    }
  }
  return { ok: true, count, bytes, workBytes };
}


function emptySessionBundleWorkBytes(projectDir: string, sessionId: string): number | null {
  const paths = [
    projectDir,
    join(projectDir, sessionId),
    join(projectDir, sessionId, CURRENT_DIR),
    join(projectDir, sessionId, CURRENT_DIR, ACTIVE_NAME),
  ];
  let workBytes = 0;
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path, "utf8") + 1;
    if (!Number.isSafeInteger(pathBytes) || workBytes > MAX_EMPTY_SESSION_ADMISSION_WORK_BYTES - pathBytes) return null;
    workBytes += pathBytes;
  }
  return workBytes;
}


function admitNewEmptySessionBundle(projectDir: string, sessionId: string): SessionResult {
  const admission = emptySessionBundleAdmission(projectDir);
  if (!admission.ok) return admission;
  if (admission.count >= MAX_RETAINED_EMPTY_SESSION_BUNDLES) {
    return {
      ok: false,
      error: `retained empty sessions are at capacity (${MAX_RETAINED_EMPTY_SESSION_BUNDLES}); explicitly reclaim them through the native bound owner before retrying`,
    };
  }
  if (admission.bytes > MAX_EMPTY_SESSION_ADMISSION_BYTES) {
    return { ok: false, error: "retained empty session admission exceeded its byte bound; explicitly reclaim retained sessions before retrying" };
  }
  const requestedWork = emptySessionBundleWorkBytes(projectDir, sessionId);
  if (requestedWork === null || admission.workBytes > MAX_EMPTY_SESSION_ADMISSION_WORK_BYTES - requestedWork) {
    return { ok: false, error: "retained empty session admission exceeded its bounded work budget; explicitly reclaim retained sessions before retrying" };
  }
  return { ok: true };
}


function safeSessionChildName(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}


function openOrCreateSessionChildDirectory(
  parent: DirectoryAnchor,
  path: string,
  label: string,
): SessionResult<{ anchor: DirectoryAnchor; created: boolean }> {
  const name = basename(path);
  if (!safeSessionChildName(name)) return { ok: false, error: `${label} has an invalid child name` };
  const parentBefore = validateDirectoryAnchor(parent);
  if (!parentBefore.ok) return parentBefore;
  let created = false;
  const existing = inspectEntry(path);
  if (existing?.kind === "symlink") return { ok: false, error: `${label} is a symlink` };
  if (existing && existing.kind !== "dir") return { ok: false, error: `${label} is not a directory` };
  if (!existing) {
    const parentBeforeCreate = validateDirectoryAnchor(parent);
    if (!parentBeforeCreate.ok) return parentBeforeCreate;
    try {
      mkdirSync(anchoredChildPath(parent, name, path), { recursive: false, mode: 0o700 });
      created = true;
      const synced = fsyncDirectoryDescriptor(parent.fd);
      if (!synced.ok) return synced;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") return { ok: false, error: errMsg(err) };
      const raced = inspectEntry(path);
      if (!raced || raced.kind === "symlink" || raced.kind !== "dir") return { ok: false, error: `${label} changed while it was created` };
    }
  }
  const parentAfter = validateDirectoryAnchor(parent);
  if (!parentAfter.ok) return parentAfter;
  const opened = openDirectoryAnchor(path, label, anchoredChildPath(parent, name, path));
  if (!opened.ok) return opened;
  return { ok: true, anchor: opened.anchor, created };
}


function createCurrentDirBound(
  project: DirectoryAnchor,
  bundlePath: string,
  currentPath: string,
  sessionFile: string,
  hooks?: Pick<SessionTestHooks, "afterEmptySessionReservation">,
): SessionResult {
  let bundle: DirectoryAnchor | null = null;
  let current: DirectoryAnchor | null = null;
  try {
    const openedBundle = openOrCreateSessionChildDirectory(project, bundlePath, "session bundle");
    if (!openedBundle.ok) return openedBundle;
    bundle = openedBundle.anchor;
    const openedCurrent = openOrCreateSessionChildDirectory(bundle, currentPath, "session current directory");
    if (!openedCurrent.ok) return openedCurrent;
    current = openedCurrent.anchor;
    const activePath = anchoredChildPath(current, ACTIVE_NAME, sessionFile);
    let activeFd: number | null = null;
    let created = false;
    let activeIdentity: StableIdentity | null = null;
    try {
      activeFd = openSync(activePath, noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL), 0o600);
      created = true;
      fsyncSync(activeFd);
    } catch (err) {
      if (errorCode(err) !== "EEXIST") return { ok: false, error: errMsg(err) };
      const active = inspectEntry(sessionFile);
      if (!active || active.kind === "symlink" || active.kind !== "file") return { ok: false, error: "active session segment is not a regular file" };
    } finally {
      if (activeFd !== null) closeSync(activeFd);
    }
    try {
      const active = lstatSync(activePath, { bigint: true });
      if (active.isSymbolicLink() || !active.isFile()) return { ok: false, error: "active session segment is not a regular file" };
      activeIdentity = statIdentity(active);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    const currentSynced = fsyncDirectoryDescriptor(current.fd);
    if (!currentSynced.ok) return currentSynced;
    const bundleSynced = fsyncDirectoryDescriptor(bundle.fd);
    if (!bundleSynced.ok) return bundleSynced;
    const projectSynced = fsyncDirectoryDescriptor(project.fd);
    if (!projectSynced.ok) return projectSynced;
    for (const anchor of [project, bundle, current]) {
      const stable = validateDirectoryAnchor(anchor);
      if (!stable.ok) return stable;
    }
    if (created) {
      try {
        hooks?.afterEmptySessionReservation?.(sessionFile);
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    }
    try {
      const activeAfter = lstatSync(activePath, { bigint: true });
      if (activeAfter.isSymbolicLink() || !activeAfter.isFile() || activeIdentity === null || !sameVersion(activeIdentity, statIdentity(activeAfter))) {
        return { ok: false, error: "active session segment changed while it was published" };
      }
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    return { ok: true };
  } finally {
    if (current) closeSync(current.fd);
    if (bundle) closeSync(bundle.fd);
  }
}


/** Create a new empty bundle while holding the stable project-root admission
 * lock through project creation, count/byte/work admission, and publication. */
export function createSessionBundleWithAdmission(
  parsed: SessionBundlePaths,
  hooks?: Pick<SessionTestHooks, "afterSessionProjectCreated" | "afterEmptySessionReservation">,
): SessionResult {
  const rawAdmissionRoot = dirname(parsed.projectDir);
  const projectName = basename(parsed.projectDir);
  if (!safeSessionChildName(projectName)) return { ok: false, error: "session project directory has an invalid name" };
  // Canonicalize a symlinked admission parent (macOS /tmp → /private/tmp)
  // so the retention lock and directory anchors share one identity.
  // Final segments stay no-follow validated below; only parents resolve.
  let admissionRoot: string;
  try {
    admissionRoot = realpathSync(resolve(rawAdmissionRoot));
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  const projectDir = join(admissionRoot, projectName);
  const bundleDir = join(projectDir, basename(parsed.bundleDir));
  const currentDir = join(bundleDir, basename(parsed.currentDir));
  const sessionFile = join(currentDir, basename(parsed.sessionFile));
  const effective: SessionBundlePaths = { ...parsed, projectDir, bundleDir, currentDir, sessionFile };
  let lock: SessionRetentionLock;
  try {
    lock = acquireSessionRetentionLock(admissionRoot);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  let root: DirectoryAnchor | null = null;
  let project: DirectoryAnchor | null = null;
  try {
    const openedRoot = openDirectoryAnchor(admissionRoot, "session admission root");
    if (!openedRoot.ok) return openedRoot;
    root = openedRoot.anchor;
    const rootStable = validateDirectoryAnchor(root);
    if (!rootStable.ok) return rootStable;
    const openedProject = openOrCreateSessionChildDirectory(root, effective.projectDir, "session project directory");
    if (!openedProject.ok) return openedProject;
    project = openedProject.anchor;
    if (openedProject.created) {
      try {
        hooks?.afterSessionProjectCreated?.(effective.projectDir);
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    }
    const current = inspectEntry(effective.currentDir);
    if (current?.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
    if (current && current.kind !== "dir") return { ok: false, error: "current is not a directory" };
    if (current) {
      const active = inspectEntry(effective.sessionFile);
      if (active?.kind === "symlink") return { ok: false, error: "active session segment is a symlink" };
      if (active?.kind === "file") {
        const rootAfter = validateDirectoryAnchor(root);
        if (!rootAfter.ok) return rootAfter;
        const projectAfter = validateDirectoryAnchor(project);
        if (!projectAfter.ok) return projectAfter;
        return { ok: true };
      }
    }
    const admitted = admitNewEmptySessionBundle(effective.projectDir, effective.sessionId);
    if (!admitted.ok) return admitted;
    const created = createCurrentDirBound(project, effective.bundleDir, effective.currentDir, effective.sessionFile, hooks);
    if (!created.ok) return created;
    const rootAfter = validateDirectoryAnchor(root);
    if (!rootAfter.ok) return rootAfter;
    const projectAfter = validateDirectoryAnchor(project);
    if (!projectAfter.ok) return projectAfter;
    const rechecked = emptySessionBundleAdmission(effective.projectDir);
    if (!rechecked.ok) return rechecked;
    if (rechecked.count > MAX_RETAINED_EMPTY_SESSION_BUNDLES || rechecked.bytes > MAX_EMPTY_SESSION_ADMISSION_BYTES || rechecked.workBytes > MAX_EMPTY_SESSION_ADMISSION_WORK_BYTES) {
      return { ok: false, error: "retained empty session admission changed during publication; explicitly reclaim retained sessions before retrying" };
    }
    return { ok: true };
  } finally {
    if (project) closeSync(project.fd);
    if (root) closeSync(root.fd);
    releaseSessionRetentionLock(lock);
  }
}
