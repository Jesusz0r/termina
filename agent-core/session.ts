/**
 * Segmented append-only agent-core session bundle.
 *
 * Layout:
 *   <project-session-dir>/<session-id>/
 *     current/{part-NNNNNN.jsonl, session.jsonl, images}
 *     archive-<stamp>/
 *     bad-<stamp>/
 *
 * sessionFile is the stable address of the active JSONL segment:
 *   .../<session-id>/current/session.jsonl
 *
 * Worldlines and Session Search call these helpers. They do not read or
 * copy core session JSONL themselves.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const MAX_SESSION_SEGMENT_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_RECORD_BYTES = 1 * 1024 * 1024;

const CORE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PART_NAME = /^part-([0-9]{6})\.jsonl$/;
const ARCHIVE_PREFIX = "archive-";
const BAD_PREFIX = "bad-";
const ACTIVE_NAME = "session.jsonl";
const CURRENT_DIR = "current";
const STORED_IMAGE_NAME = /^[A-Za-z0-9._-]+-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/;
const READ_CHUNK = 64 * 1024;
const YIELD_EVERY_BYTES = 256 * 1024;
const YIELD_EVERY_RECORDS = 64;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type SessionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export type ReplayContent = string | Array<Record<string, unknown>>;

export type ReplayMessage = {
  role: "user" | "assistant";
  content: ReplayContent;
  sseq: number;
};

/**
 * Structural boundary shared with reclaim.ts.  Keep this shape local to the
 * session owner rather than importing reclaim.ts at runtime: session replay is
 * the durable protocol and must remain usable by itself.
 */
export type SessionReclaimOriginal = {
  type: string;
  chars: number;
  bytes: number;
  sha256: string;
};

export type SessionReclaimRecovery = {
  source: "session-record";
  tool: string;
  repro: string | null;
};

export type SessionReclaimReceiptTarget = {
  /** Sequence of the message record in the session being replayed. */
  sseq: number;
  /** Optional source sequence retained when a fork densely renumbers records. */
  sourceSseq?: number;
  blockIndex: number;
  action: "stub" | "drop";
  original: SessionReclaimOriginal;
  reclaimedTokens: number;
  tool?: string;
  repro?: string;
  /** Explicit fallback mode persisted by the canonical session owner. */
  fallback?: "full-read";
  revisionId: string;
  recovery: SessionReclaimRecovery;
};

export type SessionReclaimReceipt = {
  revisionId: string;
  targets: SessionReclaimReceiptTarget[];
};

export type ReplayRecovery = SessionReclaimReceiptTarget & {
  fallback: "full-read";
  /** Storage sequence of the revision that applied this target. */
  revisionSeq: number;
  revisionId: string;
};

export type ReplayState = {
  messages: ReplayMessage[];
  bySeq: Map<number, ReplayMessage>;
  /** Durable reclaim targets keyed by revision and content identity. */
  recoveries: Map<string, ReplayRecovery>;
  /** Revision ids are durable identities and cannot be reused in one bundle. */
  receiptRevisionIds: Set<string>;
  lastSeq: number;
  maxSeq: number;
};

export type LogicalSessionEntry = {
  path: string;
  name: string;
  mtimeMs: number;
  kind: "current" | "archive";
  sessionId: string;
  segments: string[];
};

export type SessionBundlePaths = {
  sessionFile: string;
  currentDir: string;
  bundleDir: string;
  projectDir: string;
  sessionId: string;
};

const SESSION_HASH = /^[0-9a-f]{64}$/;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RECEIPT_TARGETS = 256;
const MAX_RECEIPT_METADATA_CHARS = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integerAtLeast(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function safeMetadataText(value: unknown, required: boolean): value is string {
  if (typeof value !== "string" || value.length > MAX_RECEIPT_METADATA_CHARS) return false;
  if (required && value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sessionBlockJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
  } catch {
    return null;
  }
}

/** Exact UTF-8 byte length of a JSON value, used by receipt verification. */
export function sessionBlockBytes(value: unknown): number | null {
  const json = sessionBlockJson(value);
  return json === null ? null : Buffer.byteLength(json, "utf8");
}

/** SHA-256 of the exact JSON representation stored in a session record. */
export function sessionBlockHash(value: unknown): string | null {
  const json = sessionBlockJson(value);
  return json === null ? null : createHash("sha256").update(json, "utf8").digest("hex");
}

function recoveryKey(target: {
  revisionId: string;
  sseq: number;
  sourceSseq?: number;
  blockIndex: number;
  original: { sha256: string };
}): string {
  const source = target.sourceSseq ?? target.sseq;
  // A fork can densely renumber local records. Keep both identities so two
  // targets cannot overwrite one another merely because their source sseqs
  // happen to match.
  // JSON tuple encoding also prevents delimiter ambiguity because revision ids
  // intentionally allow ':' and '.'.
  return JSON.stringify([target.revisionId, target.sseq, source, target.blockIndex, target.original.sha256]);
}

function normalizeReceiptTarget(value: unknown): SessionResult<{ target: SessionReclaimReceiptTarget }> {
  if (!isRecord(value)) return { ok: false, error: "invalid recovery receipt target" };
  const sourceSseq = value.sourceSseq;
  const original = value.original;
  const recovery = value.recovery;
  const validOriginal =
    isRecord(original) &&
    (original.type === "tool_result" || original.type === "thinking" || original.type === "redacted_thinking") &&
    integerAtLeast(original.chars, 0) &&
    integerAtLeast(original.bytes, 1) &&
    original.bytes >= original.chars &&
    original.bytes <= MAX_SESSION_RECORD_BYTES &&
    typeof original.sha256 === "string" &&
    SESSION_HASH.test(original.sha256);
  const validRecovery =
    isRecord(recovery) &&
    recovery.source === "session-record" &&
    safeMetadataText(recovery.tool, true) &&
    (recovery.repro === null || safeMetadataText(recovery.repro, false));
  if (
    !integerAtLeast(value.sseq, 1) ||
    (sourceSseq !== undefined && !integerAtLeast(sourceSseq, 1)) ||
    !integerAtLeast(value.blockIndex, 0) ||
    (value.action !== "stub" && value.action !== "drop") ||
    typeof value.revisionId !== "string" ||
    !RECEIPT_ID.test(value.revisionId) ||
    !validOriginal ||
    !integerAtLeast(value.reclaimedTokens, 1) ||
    (value.tool !== undefined && !safeMetadataText(value.tool, true)) ||
    (value.repro !== undefined && !safeMetadataText(value.repro, false)) ||
    (value.fallback !== undefined && value.fallback !== "full-read") ||
    !validRecovery ||
    (value.tool !== undefined && recovery.tool !== value.tool) ||
    (value.repro !== undefined && recovery.repro !== value.repro) ||
    (value.action === "stub" && original.type !== "tool_result") ||
    (value.action === "drop" && original.type !== "thinking" && original.type !== "redacted_thinking")
  ) {
    return { ok: false, error: "invalid recovery receipt target" };
  }
  const normalizedOriginal = original as SessionReclaimOriginal;
  const normalizedRecovery = recovery as SessionReclaimRecovery;
  const normalizedSourceSseq = sourceSseq === undefined ? undefined : (sourceSseq as number);
  const normalizedTool = value.tool === undefined ? undefined : (value.tool as string);
  const normalizedRepro = value.repro === undefined ? undefined : (value.repro as string);
  const normalizedFallback = value.fallback === undefined ? undefined : (value.fallback as "full-read");
  return {
    ok: true,
    target: {
      sseq: value.sseq,
      ...(normalizedSourceSseq === undefined ? {} : { sourceSseq: normalizedSourceSseq }),
      blockIndex: value.blockIndex,
      action: value.action,
      original: {
        type: normalizedOriginal.type,
        chars: normalizedOriginal.chars,
        bytes: normalizedOriginal.bytes,
        sha256: normalizedOriginal.sha256,
      },
      reclaimedTokens: value.reclaimedTokens,
      ...(normalizedTool === undefined ? {} : { tool: normalizedTool }),
      ...(normalizedRepro === undefined ? {} : { repro: normalizedRepro }),
      ...(normalizedFallback === undefined ? {} : { fallback: normalizedFallback }),
      revisionId: value.revisionId,
      recovery: {
        source: "session-record",
        tool: normalizedRecovery.tool,
        repro: normalizedRecovery.repro,
      },
    },
  };
}

function hasUnsafeBlockIndexShift(targets: readonly SessionReclaimReceiptTarget[]): boolean {
  const perMessage = new Map<number, { dropIndex: number | null }>();
  const ordered = targets.slice().sort((left, right) => left.sseq - right.sseq || left.blockIndex - right.blockIndex);
  for (const target of ordered) {
    const state = perMessage.get(target.sseq) ?? { dropIndex: null };
    if (target.action === "drop") {
      // A later drop addresses a post-splice index, so its source identity is
      // ambiguous. Keep revisions atomic and require one drop at most per
      // message, just as the planner does.
      if (state.dropIndex !== null) return true;
      state.dropIndex = target.blockIndex;
    } else if (state.dropIndex !== null && target.blockIndex > state.dropIndex) {
      // A stub after a lower-index drop would likewise address a shifted
      // block. The caller must split that work into another revision.
      return true;
    }
    perMessage.set(target.sseq, state);
  }
  return false;
}

/** Validate and canonicalize the frozen reclaim receipt shape. */
export function validateSessionReclaimReceipt(value: unknown): SessionResult<{ receipt: SessionReclaimReceipt }> {
  if (!isRecord(value) || typeof value.revisionId !== "string" || !RECEIPT_ID.test(value.revisionId)) {
    return { ok: false, error: "invalid recovery receipt" };
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0 || value.targets.length > MAX_RECEIPT_TARGETS) {
    return { ok: false, error: "invalid recovery receipt targets" };
  }
  const targets: SessionReclaimReceiptTarget[] = [];
  const seenTargets = new Set<string>();
  const seenSources = new Set<string>();
  for (const raw of value.targets) {
    const normalized = normalizeReceiptTarget(raw);
    if (!normalized.ok) return { ok: false, error: "error" in normalized ? normalized.error : "invalid recovery receipt target" };
    const target = normalized.target;
    if (target.revisionId !== value.revisionId) return { ok: false, error: "recovery receipt revision mismatch" };
    const targetKey = `${target.sseq}:${target.blockIndex}`;
    const sourceKey = `${target.sourceSseq ?? target.sseq}:${target.blockIndex}`;
    if (seenTargets.has(targetKey) || seenSources.has(sourceKey)) return { ok: false, error: "duplicate recovery receipt target" };
    seenTargets.add(targetKey);
    seenSources.add(sourceKey);
    targets.push(target);
  }
  if (hasUnsafeBlockIndexShift(targets)) return { ok: false, error: "unsafe recovery receipt target order" };
  targets.sort((a, b) => (a.sseq - b.sseq) || (a.blockIndex - b.blockIndex) || a.original.sha256.localeCompare(b.original.sha256));
  return { ok: true, receipt: { revisionId: value.revisionId, targets } };
}

/** Session ids that are safe as a single path segment. */
export function isCoreSessionId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && CORE_SESSION_ID.test(value);
}

/** Filesystem-safe stamp for archive and quarantine directory names. */
export function sessionRotateStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function formatStub(opts: { chars: number; tool: string; sseq: number; repro?: string }): string {
  const repro = opts.repro ? ` — reproduce: ${opts.repro}` : "";
  return `[cleared: ${opts.chars} chars of ${opts.tool} — storageSeq ${opts.sseq}${repro}]`;
}

export function coreSessionFile(projectDir: string, sessionId: string): string {
  return join(projectDir, sessionId, CURRENT_DIR, ACTIVE_NAME);
}

/**
 * Derive the active segment path from a project directory and session id.
 * Ignore an old flat roster path. Accept a valid bundle path only when it
 * matches this session id.
 */
export function resolveSessionFile(projectDir: string, sessionId: string, override?: string): string | null {
  if (!isCoreSessionId(sessionId)) return null;
  const explicit = override?.trim() || "";
  if (explicit) {
    const parsed = parseSessionBundlePath(explicit);
    if (parsed && parsed.sessionId === sessionId) return parsed.sessionFile;
  }
  const root = projectDir.trim();
  if (!root) return null;
  return coreSessionFile(root, sessionId);
}

/** True when path is .../<session-id>/current/session.jsonl. */
export function isCoreSessionBundleFile(path: string): boolean {
  return parseSessionBundlePath(path) !== null;
}

export function parseSessionBundlePath(sessionFile: string): SessionBundlePaths | null {
  if (!sessionFile || basename(sessionFile) !== ACTIVE_NAME) return null;
  const currentDir = dirname(sessionFile);
  if (basename(currentDir) !== CURRENT_DIR) return null;
  const bundleDir = dirname(currentDir);
  const sessionId = basename(bundleDir);
  if (!isCoreSessionId(sessionId)) return null;
  return {
    sessionFile,
    currentDir,
    bundleDir,
    projectDir: dirname(bundleDir),
    sessionId,
  };
}

function partNumber(name: string): number | null {
  const m = PART_NAME.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function partFileName(n: number): string {
  return `part-${String(n).padStart(6, "0")}.jsonl`;
}

function isSafeImageName(name: string): boolean {
  if (!STORED_IMAGE_NAME.test(name)) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name.includes("..")) return false;
  return true;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function inspectEntry(path: string): { kind: "file" | "dir" | "symlink" | "other"; size: number } | null {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return { kind: "symlink", size: info.size };
    if (info.isFile()) return { kind: "file", size: info.size };
    if (info.isDirectory()) return { kind: "dir", size: info.size };
    return { kind: "other", size: info.size };
  } catch {
    return null;
  }
}

/**
 * Persist a directory entry update when the host supports directory fsync.
 * Linux and macOS expose slightly different unsupported-operation errors, so
 * only those known capability errors are treated as a successful no-op;
 * permission, lookup, and descriptor failures remain fatal.
 */
function fsyncDirectory(path: string): SessionResult {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
    return { ok: true };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EISDIR") {
      return { ok: true };
    }
    return { ok: false, error: errMsg(err) };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* the directory descriptor may already be closed by the host */
      }
    }
  }
}

function fsyncDirectoryAndParent(path: string): SessionResult {
  const directory = fsyncDirectory(path);
  if (!directory.ok) return directory;
  return fsyncDirectory(dirname(path));
}

type CurrentListing = {
  parts: Array<{ n: number; path: string; size: number }>;
  active: { path: string; size: number } | null;
  images: string[];
};

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

function currentHasContent(listing: CurrentListing): boolean {
  if (listing.images.length > 0) return true;
  if (listing.active && listing.active.size > 0) return true;
  return listing.parts.some((p) => p.size > 0);
}

/**
 * Fingerprint the bytes that replay is about to consume.  Segment names alone
 * do not protect against an in-place rewrite that keeps the same path (or
 * even the same length), so include both metadata and a content digest.
 */
function fingerprintFile(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
    }
    const after = fstatSync(fd);
    return `${path}:${after.size}:${after.mtimeMs}:${after.ino}:${hash.digest("hex")}:${before.size}:${before.mtimeMs}`;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function segmentIdentity(listing: CurrentListing): string | null {
  const paths = [...listing.parts.map((part) => part.path), ...(listing.active ? [listing.active.path] : [])];
  const fingerprints: string[] = [];
  for (const path of paths) {
    const fingerprint = fingerprintFile(path);
    if (fingerprint === null) return null;
    fingerprints.push(fingerprint);
  }
  return fingerprints.join("\n");
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
  return listing.parts.reduce((total, part) => total + part.size, listing.active?.size ?? 0);
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

function renameCurrentUnique(currentDir: string, prefix: string, now = Date.now()): SessionResult<{ aside: string }> {
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

function createCurrentDir(currentDir: string, sessionFile: string): SessionResult {
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

function recoverActiveSegment(currentDir: string, sessionFile: string): SessionResult<CurrentListing> {
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

export function ensureSessionBundle(sessionFile: string): SessionResult<SessionBundlePaths> {
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
    const created = createCurrentDir(parsed.currentDir, parsed.sessionFile);
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
    const created = createCurrentDir(parsed.currentDir, parsed.sessionFile);
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

export async function removeSessionBundle(sessionFile: string): Promise<SessionResult> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  try {
    await rm(parsed.bundleDir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

export async function removeEmptySessionBundle(sessionFile: string): Promise<SessionResult<{ removed: boolean }>> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  try {
    const bundle = await lstat(parsed.bundleDir);
    if (bundle.isSymbolicLink() || !bundle.isDirectory()) return { ok: false, error: "session bundle is not a directory" };
    const [bundleNames, currentNames, current, active] = await Promise.all([
      readdir(parsed.bundleDir),
      readdir(parsed.currentDir),
      lstat(parsed.currentDir),
      lstat(parsed.sessionFile),
    ]);
    if (bundleNames.length !== 1 || bundleNames[0] !== CURRENT_DIR) return { ok: true, removed: false };
    if (current.isSymbolicLink() || !current.isDirectory()) return { ok: false, error: "current is not a directory" };
    if (currentNames.length !== 1 || currentNames[0] !== ACTIVE_NAME) return { ok: true, removed: false };
    if (active.isSymbolicLink() || !active.isFile() || active.size !== 0) return { ok: true, removed: false };
    await rm(parsed.bundleDir, { recursive: true, force: true });
    return { ok: true, removed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, removed: false };
    return { ok: false, error: errMsg(err) };
  }
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

function isReplayContent(content: unknown): content is ReplayContent {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.every((block) => {
    return Boolean(block) && typeof block === "object" && !Array.isArray(block) && typeof (block as { type?: unknown }).type === "string";
  });
}

function isThinkingBlock(b: { type?: string }): boolean {
  return b.type === "thinking" || b.type === "redacted_thinking";
}

function blockChars(b: Record<string, unknown>): number {
  if (typeof b.chars === "number") return b.chars;
  if (b.type === "text") return String(b.text ?? "").length;
  if (b.type === "tool_result") return String(b.content ?? "").length;
  if (b.type === "tool_use") return JSON.stringify(b.input ?? {}).length;
  if (b.type === "thinking" || b.type === "redacted_thinking") {
    return String(b.thinking ?? JSON.stringify(b)).length;
  }
  if (b.type === "image") return 8_000;
  return 0;
}

function dropIndexedMessage(state: ReplayState, message: ReplayMessage): void {
  state.bySeq.delete(message.sseq);
}

export function createReplayState(): ReplayState {
  return {
    messages: [],
    bySeq: new Map(),
    recoveries: new Map(),
    receiptRevisionIds: new Set(),
    lastSeq: 0,
    maxSeq: 0,
  };
}

type PruneTarget = { sseq: number; blockIndex: number; action: "drop" | "stub" };

function commitSequence(state: ReplayState, storageSeq: number): void {
  state.lastSeq = storageSeq;
  state.maxSeq = storageSeq;
}

function normalizePruneTargets(value: unknown): SessionResult<{ targets: PruneTarget[] }> {
  if (!Array.isArray(value)) return { ok: false, error: "invalid prune targets" };
  const targets: PruneTarget[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) || !integerAtLeast(raw.sseq, 1) || !integerAtLeast(raw.blockIndex, 0) || (raw.action !== "drop" && raw.action !== "stub")) {
      return { ok: false, error: "invalid prune target" };
    }
    const target: PruneTarget = { sseq: raw.sseq, blockIndex: raw.blockIndex, action: raw.action };
    const key = `${target.sseq}:${target.blockIndex}`;
    if (seen.has(key)) return { ok: false, error: "duplicate prune target" };
    seen.add(key);
    targets.push(target);
  }
  targets.sort((a, b) => a.sseq - b.sseq || b.blockIndex - a.blockIndex);
  return { ok: true, targets };
}

function samePruneTargets(left: readonly PruneTarget[], right: readonly SessionReclaimReceiptTarget[]): boolean {
  if (left.length !== right.length) return false;
  const a = left.slice().sort((x, y) => x.sseq - y.sseq || x.blockIndex - y.blockIndex);
  const b = right.slice().sort((x, y) => x.sseq - y.sseq || x.blockIndex - y.blockIndex);
  return a.every((target, index) => {
    const receiptTarget = b[index]!;
    return target.sseq === receiptTarget.sseq && target.blockIndex === receiptTarget.blockIndex && target.action === receiptTarget.action;
  });
}

function receiptForPruneRevision(e: {
  targets?: unknown;
  revisionId?: unknown;
}): SessionResult<{ targets: PruneTarget[]; receipt: SessionReclaimReceipt }> {
  const rawTargets = e.targets;
  if (!Array.isArray(rawTargets)) return { ok: false, error: "invalid prune targets" };
  if (typeof e.revisionId !== "string") return { ok: false, error: "invalid recovery receipt revision" };
  const checked = validateSessionReclaimReceipt({ revisionId: e.revisionId, targets: rawTargets });
  if (!checked.ok) return { ok: false, error: "error" in checked ? checked.error : "invalid recovery receipt" };
  const targets = normalizePruneTargets(checked.receipt.targets);
  if (!targets.ok) return { ok: false, error: "error" in targets ? targets.error : "invalid prune targets" };
  if (!samePruneTargets(targets.targets, checked.receipt.targets)) return { ok: false, error: "recovery receipt target mismatch" };
  return { ok: true, targets: targets.targets, receipt: checked.receipt };
}

function applyReceiptPrune(
  state: ReplayState,
  storageSeq: number,
  targets: readonly PruneTarget[],
  receipt: SessionReclaimReceipt,
): SessionResult {
  if (state.receiptRevisionIds.has(receipt.revisionId)) return { ok: false, error: "duplicate recovery revision" };
  const receiptByTarget = new Map<string, SessionReclaimReceiptTarget>();
  for (const target of receipt.targets) receiptByTarget.set(`${target.sseq}:${target.blockIndex}`, target);
  const working = new Map<number, Record<string, unknown>[]>();
  const pendingRecoveries: ReplayRecovery[] = [];

  for (const target of targets) {
    const receiptTarget = receiptByTarget.get(`${target.sseq}:${target.blockIndex}`);
    if (!receiptTarget) return { ok: false, error: "missing recovery receipt target" };
    const message = state.bySeq.get(target.sseq);
    if (!message || typeof message.content === "string") return { ok: false, error: "missing recovery source" };
    let blocks = working.get(target.sseq);
    if (!blocks) {
      blocks = message.content.map((block) => cloneJson(block));
      working.set(target.sseq, blocks);
    }
    const block = blocks[target.blockIndex];
    if (!isRecord(block)) return { ok: false, error: "stale recovery target" };
    const originalBytes = sessionBlockBytes(block);
    const originalHash = sessionBlockHash(block);
    if (
      originalBytes !== receiptTarget.original.bytes ||
      originalHash !== receiptTarget.original.sha256 ||
      blockChars(block) !== receiptTarget.original.chars
    ) {
      return { ok: false, error: "recovery hash mismatch" };
    }
    if (target.action === "stub") {
      if (block.type !== "tool_result" || block.stubbed) return { ok: false, error: "stale recovery target" };
      const stubText = formatStub({
        chars: receiptTarget.original.chars,
        tool: receiptTarget.recovery.tool,
        sseq: message.sseq,
        repro: receiptTarget.recovery.repro ?? undefined,
      });
      const stub: Record<string, unknown> = { ...block, content: stubText, chars: stubText.length, stubbed: true };
      blocks[target.blockIndex] = stub;
    } else {
      if (!isThinkingBlock(block)) return { ok: false, error: "stale recovery target" };
      if (blocks.filter((candidate) => !isThinkingBlock(candidate)).length === 0) {
        return { ok: false, error: "cannot drop the only visible block" };
      }
      blocks.splice(target.blockIndex, 1);
    }
    pendingRecoveries.push({
      ...receiptTarget,
      fallback: "full-read",
      revisionSeq: storageSeq,
      revisionId: receipt.revisionId,
    });
  }

  // Every target and its replacement was validated against the pre-revision
  // view before any visible message is changed.
  for (const [sseq, blocks] of working) {
    const message = state.bySeq.get(sseq);
    if (message) message.content = blocks;
  }
  commitSequence(state, storageSeq);
  state.receiptRevisionIds.add(receipt.revisionId);
  for (const recovery of pendingRecoveries) state.recoveries.set(recoveryKey(recovery), recovery);
  return { ok: true };
}

export function applySessionRecord(state: ReplayState, rec: unknown): SessionResult {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { ok: false, error: "malformed session record" };
  const e = rec as {
    storageSeq?: unknown;
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
    kind?: unknown;
    targets?: unknown;
    revisionId?: unknown;
    dropped?: unknown;
    evicted?: unknown;
    summarySseq?: unknown;
  };
  if (typeof e.storageSeq !== "number" || !Number.isInteger(e.storageSeq) || e.storageSeq < 1) {
    return { ok: false, error: "invalid storageSeq" };
  }
  if (e.storageSeq <= state.lastSeq) {
    return { ok: false, error: e.storageSeq === state.lastSeq ? "duplicate storageSeq" : "decreasing storageSeq" };
  }
  if (e.type === "checkpoint") {
    if ("message" in e) return { ok: false, error: "checkpoint contains a message" };
    commitSequence(state, e.storageSeq);
    return { ok: true };
  }
  if (e.type === "message") {
    const role = e.message?.role;
    if (role !== "user" && role !== "assistant") return { ok: false, error: "invalid message role" };
    if (!e.message || !isReplayContent(e.message.content)) return { ok: false, error: "invalid message content" };
    const m: ReplayMessage = { role, content: e.message.content, sseq: e.storageSeq };
    state.messages.push(m);
    state.bySeq.set(m.sseq, m);
    commitSequence(state, e.storageSeq);
    return { ok: true };
  }
  if (e.type === "revision" && e.kind === "prune") {
    const parsed = receiptForPruneRevision(e);
    if (!parsed.ok) return parsed;
    return applyReceiptPrune(state, e.storageSeq, parsed.targets, parsed.receipt);
  }
  if (e.type === "revision" && e.kind === "truncate" && typeof e.dropped === "number") {
    if (!Number.isInteger(e.dropped) || e.dropped < 0 || e.dropped > state.messages.length) {
      return { ok: false, error: "invalid truncate revision" };
    }
    const removed = state.messages.splice(0, e.dropped);
    for (const m of removed) dropIndexedMessage(state, m);
    commitSequence(state, e.storageSeq);
    return { ok: true };
  }
  if (e.type === "revision" && e.kind === "summarize") {
    if (e.summarySseq !== e.storageSeq) {
      return { ok: false, error: "invalid summarize revision" };
    }
    if (typeof e.evicted !== "number" || !Number.isInteger(e.evicted) || e.evicted < 0 || e.evicted > state.messages.length) {
      return { ok: false, error: "invalid summarize revision" };
    }
    if (e.message?.role !== "user" || !isReplayContent(e.message.content)) {
      return { ok: false, error: "invalid summarize handoff" };
    }
    const removed = state.messages.splice(0, e.evicted);
    for (const m of removed) dropIndexedMessage(state, m);
    const handoff: ReplayMessage = { role: "user", content: e.message.content, sseq: e.storageSeq };
    state.messages.unshift(handoff);
    state.bySeq.set(handoff.sseq, handoff);
    commitSequence(state, e.storageSeq);
    return { ok: true };
  }
  return { ok: false, error: "unknown session record type" };
}

type FramedRecord =
  | { ok: true; rec: unknown; bytes: number }
  | { ok: true; skip: true; bytes: number }
  | { ok: false; error: string };

function takeFramedLine(
  pending: Buffer,
  atEnd: boolean,
  allowTruncatedTail: boolean,
): { line: Buffer | null; rest: Buffer; done?: FramedRecord } {
  const nl = pending.indexOf(0x0a);
  if (nl < 0) {
    if (pending.length > MAX_SESSION_RECORD_BYTES) {
      return { line: null, rest: pending, done: { ok: false, error: "oversized session record" } };
    }
    if (atEnd) {
      if (pending.length === 0) return { line: null, rest: pending };
      const parsed = parseFramedLine(pending);
      if (parsed.ok && !("skip" in parsed && parsed.skip)) {
        return { line: null, rest: Buffer.alloc(0), done: parsed };
      }
      if (allowTruncatedTail) return { line: null, rest: Buffer.alloc(0), done: { ok: true, skip: true, bytes: pending.length } };
      return { line: null, rest: pending, done: { ok: false, error: "truncated session record" } };
    }
    return { line: null, rest: pending };
  }
  if (nl + 1 > MAX_SESSION_RECORD_BYTES) {
    return { line: null, rest: pending, done: { ok: false, error: "oversized session record" } };
  }
  const line = pending.subarray(0, nl + 1);
  const rest = pending.subarray(nl + 1);
  return { line, rest };
}

function parseFramedLine(line: Buffer): FramedRecord {
  let text: string;
  try {
    text = UTF8_DECODER.decode(line);
  } catch {
    return { ok: false, error: "invalid UTF-8 session record" };
  }
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.trim() === "") return { ok: true, skip: true, bytes: line.length };
  try {
    return { ok: true, rec: JSON.parse(body) as unknown, bytes: line.length };
  } catch {
    return { ok: false, error: "malformed session record" };
  }
}

async function readSegmentIntoState(
  path: string,
  state: ReplayState | null,
  allowTruncatedTail: boolean,
  throughSeq?: number,
  onRecord?: (record: unknown) => void,
): Promise<SessionResult<{ bytes: number; records: number; stop: boolean }>> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  let pending: Buffer = Buffer.alloc(0);
  const chunk = Buffer.alloc(READ_CHUNK);
  let bytes = 0;
  let records = 0;
  let sinceYieldBytes = 0;
  let sinceYieldRecords = 0;
  let stop = false;
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      const atEnd = n === 0;
      if (n > 0) pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      for (;;) {
        const nl = pending.indexOf(0x0a);
        if (atEnd && nl < 0 && pending.length > 0) {
          if (pending.length > MAX_SESSION_RECORD_BYTES) {
            return { ok: false, error: "oversized session record" };
          }
          try {
            // Even a crash-truncated tail is decoded strictly.  It may be
            // discarded as incomplete, but malformed UTF-8 is never silently
            // replaced before that decision.
            UTF8_DECODER.decode(pending);
          } catch {
            return { ok: false, error: "invalid UTF-8 session record" };
          }
          if (!allowTruncatedTail) return { ok: false, error: "truncated session record" };
          bytes += pending.length;
          pending = Buffer.alloc(0);
          break;
        }
        const taken = takeFramedLine(pending, atEnd && nl < 0, allowTruncatedTail);
        pending = taken.rest;
        const parsed = taken.done ?? (taken.line ? parseFramedLine(taken.line) : null);
        if (taken.done && !taken.done.ok) return taken.done;
        if (!parsed) break;
        if (!parsed.ok) return parsed;
        bytes += parsed.bytes;
        sinceYieldBytes += parsed.bytes;
        if ("skip" in parsed && parsed.skip) {
          if (taken.done) break;
          continue;
        }
        const rec = (parsed as { rec: unknown }).rec;
        const seq = rec && typeof rec === "object" && !Array.isArray(rec) ? (rec as { storageSeq?: unknown }).storageSeq : undefined;
        if (typeof throughSeq === "number" && typeof seq === "number" && seq > throughSeq) {
          stop = true;
          break;
        }
        onRecord?.(rec);
        if (state) {
          const applied = applySessionRecord(state, rec);
          if (!applied.ok) return applied;
        }
        records += 1;
        sinceYieldRecords += 1;
        if (sinceYieldBytes >= YIELD_EVERY_BYTES || sinceYieldRecords >= YIELD_EVERY_RECORDS) {
          sinceYieldBytes = 0;
          sinceYieldRecords = 0;
          await yieldToEventLoop();
        }
        if (taken.done) break;
      }
      if (stop || atEnd) break;
    }
    return { ok: true, bytes, records, stop };
  } finally {
    closeSync(fd);
  }
}

function applyFramed(state: ReplayState, framed: FramedRecord): SessionResult | "skip" {
  if (!framed.ok) return framed;
  if ("skip" in framed && framed.skip) return "skip";
  if (!("rec" in framed)) return "skip";
  return applySessionRecord(state, framed.rec);
}

export function replaySessionRecords(text: string): SessionResult<{ messages: ReplayMessage[]; maxSeq: number }> {
  const state = createReplayState();
  const buf = Buffer.from(text, "utf8");
  let pending: Buffer = buf;
  for (;;) {
    const nl = pending.indexOf(0x0a);
    const taken = takeFramedLine(pending, nl < 0, true);
    pending = taken.rest;
    if (taken.done) {
      const applied = applyFramed(state, taken.done);
      if (applied !== "skip" && !applied.ok) return applied;
      break;
    }
    if (!taken.line) break;
    const parsed = parseFramedLine(taken.line);
    const applied = applyFramed(state, parsed);
    if (applied !== "skip" && !applied.ok) return applied;
  }
  return { ok: true, messages: state.messages, maxSeq: state.maxSeq };
}

export async function replaySessionBundle(
  sessionFile: string,
  opts?: { throughSeq?: number },
): Promise<SessionResult<{ messages: ReplayMessage[]; maxSeq: number; state: ReplayState; stopped: boolean; sourceFingerprint: string }>> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const project = inspectEntry(parsed.projectDir);
  if (!project) return { ok: false, error: "session project directory is missing" };
  if (project.kind === "symlink") return { ok: false, error: "session project directory is a symlink" };
  if (project.kind !== "dir") return { ok: false, error: "session project path is not a directory" };
  const bundle = inspectEntry(parsed.bundleDir);
  if (!bundle) return { ok: false, error: "session bundle is missing" };
  if (bundle.kind === "symlink") return { ok: false, error: "session bundle is a symlink" };
  if (bundle.kind !== "dir") return { ok: false, error: "session bundle is not a directory" };
  const current = inspectEntry(parsed.currentDir);
  if (!current) return { ok: false, error: "current directory is missing" };
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const listing = listCurrentSegments(parsed.currentDir);
    if (!listing.ok) return listing;
    const recovered = listing.active ? listing : recoverActiveSegment(parsed.currentDir, parsed.sessionFile);
    if (!recovered.ok) return recovered;
    const identity = segmentIdentity(recovered);
    if (identity === null) {
      if (attempt < 2) continue;
      return { ok: false, error: "could not fingerprint session segments" };
    }
    const state = createReplayState();
    let stopped = false;
    let retry = false;
    for (const part of recovered.parts) {
      const got = await readSegmentIntoState(part.path, state, false, opts?.throughSeq);
      if (!got.ok) {
        if (attempt < 2) {
          retry = true;
          break;
        }
        return got;
      }
      if (got.stop) {
        stopped = true;
        break;
      }
    }
    if (retry) continue;
    if (!stopped && recovered.active) {
      const got = await readSegmentIntoState(recovered.active.path, state, true, opts?.throughSeq);
      if (!got.ok) {
        if (attempt < 2) continue;
        return got;
      }
      stopped = got.stop;
    }
    const after = listCurrentSegments(parsed.currentDir);
    if (!after.ok) return after;
    const afterIdentity = segmentIdentity(after);
    if (afterIdentity === null) {
      if (attempt < 2) continue;
      return { ok: false, error: "could not fingerprint session segments" };
    }
    if (identity === afterIdentity) {
      return {
        ok: true,
        messages: state.messages,
        maxSeq: state.maxSeq,
        state,
        stopped,
        sourceFingerprint: identity,
      };
    }
  }
  return { ok: false, error: "session segments changed during replay" };
}

export type SessionRecoveryTarget = {
  revisionId: string;
  sseq: number;
  blockIndex: number;
};

function validRecoveryTarget(value: unknown): value is SessionRecoveryTarget {
  return (
    isRecord(value) &&
    typeof value.revisionId === "string" &&
    RECEIPT_ID.test(value.revisionId) &&
    integerAtLeast(value.sseq, 1) &&
    integerAtLeast(value.blockIndex, 0)
  );
}

type RecoveryScanResult = SessionResult<{ blocks: Map<string, Record<string, unknown>> }>;

/**
 * Recover a set of blocks with one ordered session scan.  Fork materialization
 * can carry many receipts; indexing by source storage sequence prevents a
 * receipt-by-receipt full-session walk.
 */
async function recoverSessionBlocks(
  sessionFile: string,
  targets: readonly ReplayRecovery[],
  expectedFingerprint?: string,
): Promise<RecoveryScanResult> {
  const blocks = new Map<string, Record<string, unknown>>();
  if (targets.length === 0) return { ok: true, blocks };
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const listing = listCurrentSegments(parsed.currentDir);
  if (!listing.ok) return listing;
  const beforeFingerprint = segmentIdentity(listing);
  if (beforeFingerprint === null) return { ok: false, error: "could not fingerprint session segments" };
  if (expectedFingerprint !== undefined && beforeFingerprint !== expectedFingerprint) {
    return { ok: false, error: "session segments changed before recovery" };
  }
  const bySseq = new Map<number, Array<{ key: string; target: ReplayRecovery }>>();
  let maxSseq = 0;
  for (const target of targets) {
    const key = recoveryKey(target);
    const entries = bySseq.get(target.sseq) ?? [];
    entries.push({ key, target });
    bySseq.set(target.sseq, entries);
    if (target.sseq > maxSseq) maxSseq = target.sseq;
  }
  const segments = [
    ...listing.parts.map((part) => ({ path: part.path, allowTruncatedTail: false })),
    ...(listing.active ? [{ path: listing.active.path, allowTruncatedTail: true }] : []),
  ];
  for (const segment of segments) {
    const scanned = await readSegmentIntoState(segment.path, null, segment.allowTruncatedTail, maxSseq, (record) => {
      if (!isRecord(record) || record.type !== "message" || typeof record.storageSeq !== "number") return;
      const entries = bySseq.get(record.storageSeq);
      if (!entries) return;
      const message = record.message;
      if (!isRecord(message) || !Array.isArray(message.content)) return;
      for (const entry of entries) {
        const block = message.content[entry.target.blockIndex];
        if (isRecord(block)) blocks.set(entry.key, cloneJson(block));
      }
    });
    if (!scanned.ok) return scanned;
    if (scanned.stop) break;
  }
  const afterListing = listCurrentSegments(parsed.currentDir);
  if (!afterListing.ok) return afterListing;
  const afterFingerprint = segmentIdentity(afterListing);
  if (afterFingerprint === null) return { ok: false, error: "could not fingerprint session segments" };
  if (afterFingerprint !== beforeFingerprint || (expectedFingerprint !== undefined && afterFingerprint !== expectedFingerprint)) {
    return { ok: false, error: "session segments changed during recovery" };
  }
  for (const target of targets) {
    const key = recoveryKey(target);
    const block = blocks.get(key);
    if (!block) return { ok: false, error: "missing source record" };
    const bytes = sessionBlockBytes(block);
    const hash = sessionBlockHash(block);
    if (bytes !== target.original.bytes || hash !== target.original.sha256 || blockChars(block) !== target.original.chars) {
      return { ok: false, error: "recovery hash mismatch" };
    }
  }
  return { ok: true, blocks };
}

/**
 * Recover one pruned block from the original durable message record.
 *
 * The caller may address a target by its original source sequence after a
 * fork.  The receipt's local `sseq` is then used only as the child-record
 * lookup, so recovery does not assume that parent and child sequences match.
 */
export async function recoverSessionBlock(
  sessionFile: string,
  target: unknown,
): Promise<SessionResult<{ block: Record<string, unknown>; recoveredFrom: "source-record"; receipt: ReplayRecovery }>> {
  if (!validRecoveryTarget(target)) return { ok: false, error: "invalid recovery target" };
  const replayed = await replaySessionBundle(sessionFile);
  if (!replayed.ok) return replayed;
  const revisionTargets = [...replayed.state.recoveries.values()].filter((entry) => entry.revisionId === target.revisionId);
  if (revisionTargets.length === 0) return { ok: false, error: "missing recovery receipt" };
  const matched = revisionTargets.find(
    (entry) =>
      entry.blockIndex === target.blockIndex &&
      (entry.sseq === target.sseq || entry.sourceSseq === target.sseq),
  );
  if (!matched) return { ok: false, error: "stale recovery target" };
  const recovered = await recoverSessionBlocks(sessionFile, [matched], replayed.sourceFingerprint);
  if (!recovered.ok) return recovered;
  const original = recovered.blocks.get(recoveryKey(matched));
  if (!original) return { ok: false, error: "missing source record" };
  return { ok: true, block: original, recoveredFrom: "source-record", receipt: matched };
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

  private constructor(sessionFile: string, currentDir: string, lastStorageSeq: number) {
    this.sessionFile = sessionFile;
    this.currentDir = currentDir;
    this.lastStorageSeq = lastStorageSeq;
  }

  static open(sessionFile: string, lastStorageSeq: number): SessionResult<{ writer: SessionWriter }> {
    if (!Number.isInteger(lastStorageSeq) || lastStorageSeq < 0) return { ok: false, error: "invalid lastStorageSeq" };
    const ensured = ensureSessionBundle(sessionFile);
    if (!ensured.ok) return ensured;
    const listing = listCurrentSegments(ensured.currentDir);
    if (!listing.ok) return listing;
    const recovered = listing.active ? listing : recoverActiveSegment(ensured.currentDir, ensured.sessionFile);
    if (!recovered.ok) return recovered;
    if (!recovered.active) return { ok: false, error: "active segment is missing" };
    const repaired = discardIncompleteActiveTail(ensured.sessionFile);
    if (!repaired.ok) return repaired;
    const writer = new SessionWriter(ensured.sessionFile, ensured.currentDir, lastStorageSeq);
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
      renameSync(this.sessionFile, partPath);
    } catch (err) {
      try {
        unlinkSync(partPath);
      } catch {
        /* the exclusive part name stays claimed */
      }
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

function referencedImageNames(messages: ReplayMessage[]): SessionResult<{ names: string[] }> {
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

async function copyReferencedImages(sourceCurrent: string, destCurrent: string, names: string[]): Promise<SessionResult> {
  for (const name of names) {
    const src = join(sourceCurrent, name);
    const info = inspectEntry(src);
    if (!info) return { ok: false, error: `missing referenced image: ${name}` };
    if (info.kind === "symlink") return { ok: false, error: `referenced image is a symlink: ${name}` };
    if (info.kind !== "file") return { ok: false, error: `referenced image is not a file: ${name}` };
    try {
      await copyFile(src, join(destCurrent, name));
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
  return { ok: true };
}

function validateNoSymlinkPath(path: string, label: string): SessionResult {
  let cursor = path;
  for (;;) {
    const info = inspectEntry(cursor);
    if (info) {
      if (info.kind === "symlink") return { ok: false, error: `${label} is a symlink` };
      if (info.kind !== "dir") return { ok: false, error: `${label} is not a directory` };
      return { ok: true };
    }
    const parent = dirname(cursor);
    if (parent === cursor) return { ok: true };
    cursor = parent;
  }
}

function validateForkDestination(dest: SessionBundlePaths): SessionResult {
  const project = validateNoSymlinkPath(dest.projectDir, "destination project directory");
  if (!project.ok) return project;
  const bundle = inspectEntry(dest.bundleDir);
  if (bundle?.kind === "symlink") return { ok: false, error: "destination session bundle is a symlink" };
  if (bundle) return { ok: false, error: "destination session bundle already exists" };
  return { ok: true };
}

export async function writeForkedSession(
  sourcePath: string,
  destPath: string,
  throughSeq?: number,
): Promise<SessionResult<{ kept: number }>> {
  if (throughSeq !== undefined && (!Number.isInteger(throughSeq) || throughSeq < 0)) {
    return { ok: false, error: "invalid throughSeq" };
  }
  const source = parseSessionBundlePath(sourcePath);
  const dest = parseSessionBundlePath(destPath);
  if (!source) return { ok: false, error: "source path is not a core session bundle" };
  if (!dest) return { ok: false, error: "destination path is not a core session bundle" };
  if (source.bundleDir === dest.bundleDir) return { ok: false, error: "source and destination session bundles must differ" };
  const validDestination = validateForkDestination(dest);
  if (!validDestination.ok) return validDestination;
  if (throughSeq === 0) {
    return materializeEmptyFork(dest);
  }
  const replayed = await replaySessionBundle(source.sessionFile, throughSeq === undefined ? undefined : { throughSeq });
  if (!replayed.ok) return replayed;
  const targetSeq = throughSeq ?? replayed.maxSeq;
  if (targetSeq === 0) return materializeEmptyFork(dest);
  if (targetSeq > replayed.maxSeq && !replayed.stopped) return { ok: false, error: "fork point is beyond the source maximum" };
  const images = referencedImageNames(replayed.messages);
  if (!images.ok) return images;
  return materializeVisibleFork(
    source,
    dest,
    replayed.state,
    replayed.messages,
    targetSeq,
    images.names,
    replayed.sourceFingerprint,
  );
}

async function materializeEmptyFork(dest: SessionBundlePaths): Promise<SessionResult<{ kept: number }>> {
  const tmp = uniqueSiblingDir(dest.projectDir, `${dest.sessionId}.tmp-`, sessionRotateStamp(Date.now()));
  try {
    await mkdir(join(tmp, CURRENT_DIR), { recursive: true, mode: 0o700 });
    const fd = openSync(join(tmp, CURRENT_DIR, ACTIVE_NAME), "wx", 0o600);
    closeSync(fd);
    const synced = fsyncDirectoryAndParent(join(tmp, CURRENT_DIR));
    if (!synced.ok) throw new Error(synced.error);
    await installTempBundle(tmp, dest.bundleDir);
    return { ok: true, kept: 0 };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: errMsg(err) };
  }
}

async function materializeVisibleFork(
  source: SessionBundlePaths,
  dest: SessionBundlePaths,
  sourceState: ReplayState,
  messages: ReplayMessage[],
  throughSeq: number,
  imageNames: string[],
  sourceFingerprint: string,
): Promise<SessionResult<{ kept: number }>> {
  const tmp = uniqueSiblingDir(dest.projectDir, `${dest.sessionId}.tmp-`, sessionRotateStamp(Date.now()));
  const tmpCurrent = join(tmp, CURRENT_DIR);
  const tmpFile = join(tmpCurrent, ACTIVE_NAME);
  try {
    await mkdir(tmpCurrent, { recursive: true, mode: 0o700 });
    const visibleSseqs = new Set(messages.map((message) => message.sseq));
    const visibleRecoveries = [...sourceState.recoveries.values()].filter((recovery) => visibleSseqs.has(recovery.sseq));
    const recoveredBlocks = await recoverSessionBlocks(source.sessionFile, visibleRecoveries, sourceFingerprint);
    if (!recoveredBlocks.ok) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      return recoveredBlocks;
    }
    const recoveriesBySseq = new Map<number, ReplayRecovery[]>();
    for (const recovery of visibleRecoveries) {
      const entries = recoveriesBySseq.get(recovery.sseq) ?? [];
      entries.push(recovery);
      recoveriesBySseq.set(recovery.sseq, entries);
    }
    const childReceipts = new Map<string, { revisionSeq: number; targets: SessionReclaimReceiptTarget[] }>();
    const opened = SessionWriter.open(tmpFile, 0);
    if (!opened.ok) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      return opened;
    }
    try {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        const childSseq = i + 1;
        let content: ReplayContent = typeof m.content === "string" ? m.content : m.content.map((block) => cloneJson(block));
        if (typeof content !== "string") {
          const messageRecoveries = recoveriesBySseq.get(m.sseq) ?? [];
          const byRevision = new Map<number, ReplayRecovery[]>();
          for (const recovery of messageRecoveries) {
            const entries = byRevision.get(recovery.revisionSeq) ?? [];
            entries.push(recovery);
            byRevision.set(recovery.revisionSeq, entries);
          }
          // Undo revisions newest-first.  This restores the exact pre-prune
          // index before the child writes the message, including drop targets
          // whose indexes shifted after an earlier revision.
          const revisions = [...byRevision.entries()].sort((a, b) => b[0] - a[0]);
          for (const [, revisionsTargets] of revisions) {
            revisionsTargets.sort((a, b) => a.blockIndex - b.blockIndex);
            for (const recovery of revisionsTargets) {
              const original = recoveredBlocks.blocks.get(recoveryKey(recovery));
              if (!original) {
                opened.writer?.close();
                await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
                return { ok: false, error: "missing source record" };
              }
              const restored = cloneJson(original);
              if (recovery.action === "drop") {
                if (recovery.blockIndex > content.length) {
                  opened.writer?.close();
                  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
                  return { ok: false, error: "stale recovery target" };
                }
                content.splice(recovery.blockIndex, 0, restored);
              } else {
                if (recovery.blockIndex >= content.length || !isRecord(content[recovery.blockIndex])) {
                  opened.writer?.close();
                  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
                  return { ok: false, error: "stale recovery target" };
                }
                content[recovery.blockIndex] = restored;
              }
            }
          }
          for (const recovery of messageRecoveries) {
            const group = childReceipts.get(recovery.revisionId) ?? { revisionSeq: recovery.revisionSeq, targets: [] };
            group.targets.push({
              sseq: childSseq,
              sourceSseq: recovery.sourceSseq ?? recovery.sseq,
              blockIndex: recovery.blockIndex,
              action: recovery.action,
              original: { ...recovery.original },
              reclaimedTokens: recovery.reclaimedTokens,
              ...(recovery.tool === undefined ? {} : { tool: recovery.tool }),
              ...(recovery.repro === undefined ? {} : { repro: recovery.repro }),
              fallback: "full-read",
              revisionId: recovery.revisionId,
              recovery: { ...recovery.recovery },
            });
            childReceipts.set(recovery.revisionId, group);
          }
        }
        const written = opened.writer.appendRecord({
          storageSeq: childSseq,
          type: "message",
          message: { role: m.role, content },
        });
        if (!written.ok) {
          opened.writer.close();
          await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
          return written;
        }
        if (i % YIELD_EVERY_RECORDS === YIELD_EVERY_RECORDS - 1) await yieldToEventLoop();
      }
      let nextStorageSeq = messages.length + 1;
      const orderedChildReceipts = [...childReceipts.entries()].sort((a, b) => a[1].revisionSeq - b[1].revisionSeq);
      for (const [revisionId, group] of orderedChildReceipts) {
        const targets = group.targets.slice().sort((a, b) => a.sseq - b.sseq || b.blockIndex - a.blockIndex);
        if (nextStorageSeq > throughSeq) {
          opened.writer.close();
          await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
          return { ok: false, error: "fork recovery mapping exceeds fork point" };
        }
        const written = opened.writer.appendRecord({
          storageSeq: nextStorageSeq,
          type: "revision",
          kind: "prune",
          revisionId,
          targets,
        });
        nextStorageSeq += 1;
        if (!written.ok) {
          opened.writer.close();
          await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
          return written;
        }
      }
      if (throughSeq >= nextStorageSeq) {
        const written = opened.writer.appendRecord({ storageSeq: throughSeq, type: "checkpoint" });
        if (!written.ok) {
          opened.writer.close();
          await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
          return written;
        }
      }
    } finally {
      opened.writer.close();
    }
    const copied = await copyReferencedImages(source.currentDir, tmpCurrent, imageNames);
    if (!copied.ok) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      return copied;
    }
    const synced = fsyncDirectoryAndParent(tmpCurrent);
    if (!synced.ok) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      return synced;
    }
    await installTempBundle(tmp, dest.bundleDir);
    return { ok: true, kept: messages.length };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: errMsg(err) };
  }
}

async function installTempBundle(tmpDir: string, destBundle: string): Promise<void> {
  const parent = validateNoSymlinkPath(dirname(destBundle), "destination session parent");
  if (!parent.ok) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(parent.error);
  }
  const temp = inspectEntry(tmpDir);
  if (!temp || temp.kind !== "dir") {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("temporary session bundle is not a directory");
  }
  const destination = inspectEntry(destBundle);
  if (destination) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    if (destination.kind === "symlink") throw new Error("destination session bundle is a symlink");
    throw new Error("destination session bundle already exists");
  }
  await rename(tmpDir, destBundle);
  const synced = fsyncDirectory(dirname(destBundle));
  if (!synced.ok) throw new Error(synced.error);
  const installed = inspectEntry(destBundle);
  if (!installed || installed.kind !== "dir") {
    throw new Error("installed session bundle is not a directory");
  }
}

export { CURRENT_DIR as SESSION_CURRENT_DIR, ACTIVE_NAME as SESSION_ACTIVE_NAME };
