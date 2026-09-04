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
  constants as fsConstants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  acquireSessionRetentionLock,
  releaseSessionRetentionLock,
  RETAINED_SESSION_ADMISSION_LOCK,
  validateSessionRetentionLease,
  type SessionRetentionLock,
} from "../shared/session-retention-lock.ts";

export const MAX_SESSION_SEGMENT_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_RECORD_BYTES = 1 * 1024 * 1024;
/** Aggregate JSONL budget for one logical core session bundle. */
export const MAX_SESSION_BUNDLE_BYTES = 64 * 1024 * 1024;
/** Durable bound for staging trees retained after an unproven cleanup. */
export const MAX_RETAINED_TEMP_BUNDLES = 128;
export const MAX_RETAINED_TEMP_BYTES = 4 * 1024 * 1024 * 1024;
/**
 * Darwin/Windows cannot perform the empty-bundle removal without the native
 * descriptor owner. Bound the number of unbound empty bundles admitted under
 * one project directory until that owner can reclaim them deterministically.
 */
export const MAX_RETAINED_EMPTY_SESSION_BUNDLES = 128;

const CORE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PART_NAME = /^part-([0-9]{6})\.jsonl$/;
const ARCHIVE_PREFIX = "archive-";
const BAD_PREFIX = "bad-";
const TEMP_BUNDLE_NAME = /^t-[0-9a-f]{32}$/;
/** Durable owner marker written into a retained t-* staging sibling. */
export const RETAINED_STAGING_OWNER_NAME = ".termina-retained-staging-owner.json";
const RETAINED_STAGING_OWNER_BYTES = 512;
const MAX_RETAINED_TEMP_SCAN_ENTRIES = 250_000;
const MAX_RETAINED_TEMP_ROOT_ENTRIES = MAX_RETAINED_TEMP_BUNDLES * 4;
const MAX_RETAINED_TEMP_SCAN_DEPTH = 64;
const MAX_RETAINED_TEMP_SCAN_PENDING = MAX_RETAINED_TEMP_SCAN_ENTRIES;
const MAX_RETAINED_TEMP_SCAN_WORK_BYTES = 128 * 1024 * 1024;
const MAX_EMPTY_SESSION_ADMISSION_ENTRIES = MAX_RETAINED_EMPTY_SESSION_BUNDLES * 4;
const MAX_EMPTY_SESSION_ADMISSION_BYTES = MAX_RETAINED_EMPTY_SESSION_BUNDLES * MAX_SESSION_BUNDLE_BYTES;
const MAX_EMPTY_SESSION_ADMISSION_WORK_BYTES = MAX_RETAINED_TEMP_SCAN_WORK_BYTES;
/** Reserve half the aggregate bound for each in-flight staging admission. */
const RETAINED_TEMP_ADMISSION_RESERVATION_BYTES = MAX_RETAINED_TEMP_BYTES / 2;
/** Per-file and aggregate bounds for Pi session copies. */
export const MAX_PI_SESSION_BYTES = MAX_SESSION_BUNDLE_BYTES;
export const MAX_PI_SESSION_COPY_COUNT = MAX_RETAINED_TEMP_BUNDLES;
export const MAX_PI_SESSION_COPY_BYTES = MAX_RETAINED_TEMP_BYTES;
/** Read+write work for a 64 MiB copy plus bounded path/enumeration overhead. */
export const MAX_PI_SESSION_COPY_WORK_BYTES = 256 * 1024 * 1024;
export const MAX_PI_SESSION_COPY_SCAN_ENTRIES = MAX_RETAINED_TEMP_SCAN_ENTRIES;
export const MAX_PI_SESSION_COPY_SCAN_DEPTH = MAX_RETAINED_TEMP_SCAN_DEPTH;
export const MAX_PI_SESSION_COPY_SCAN_WORK_BYTES = MAX_RETAINED_TEMP_SCAN_WORK_BYTES;
const ACTIVE_NAME = "session.jsonl";
const CURRENT_DIR = "current";
const STORED_IMAGE_NAME = /^[A-Za-z0-9._-]+-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/;
const READ_CHUNK = 64 * 1024;
const YIELD_EVERY_BYTES = 256 * 1024;
const YIELD_EVERY_RECORDS = 64;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type SessionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };
type SessionFailure = { ok: false; error: string };

export type SessionOperationOptions = {
  signal?: AbortSignal;
  /** Explicit lease held by the durable retention owner across a worker call. */
  retentionLease?: SessionRetentionLock;
  /** Smaller deterministic budget for tests; never allowed to raise the production cap. */
  testOnlyMaxBundleBytes?: number;
  /** Deterministic fault/race seams; rejected outside the focused test runtime. */
  testHooks?: SessionTestHooks;
  /** Holds the post-rename commit window open in worker integration tests. */
  testOnlyPostRenameDelayMs?: number;
};

export type SessionTestHooks = {
  beforeSegmentOpen?: (path: string, index: number) => void;
  beforeSegmentRollRename?: (path: string) => void;
  afterSegmentsOpened?: (paths: readonly string[]) => void;
  beforeImageOpen?: (path: string) => void;
  afterTempCreated?: (path: string) => void;
  beforeTemporaryCleanupMutation?: (path: string) => void;
  beforeDestinationClaim?: (path: string) => void;
  afterDestinationClaim?: (path: string) => void;
  beforeDestinationCurrentInstall?: (path: string) => void;
  afterDestinationCleanupIdentityProof?: (path: string) => void;
  beforeDestinationCleanupMutation?: (path: string) => void;
  beforeEmptySessionCleanupMutation?: (path: string) => void;
  afterDestinationRename?: (path: string) => void;
  beforeDestinationParentSync?: (path: string) => void;
  beforeDestinationVerify?: (path: string) => void;
  /** Focused Pi-copy seam, rejected outside TERMINA_CORE_TEST. */
  beforePiWorkspaceCreate?: (path: string) => void;
  beforePiCopyDestinationOpen?: (path: string) => void;
  afterDestinationReservation?: (path: string) => void;
  /** Focused first-project admission seam, rejected outside TERMINA_CORE_TEST. */
  afterSessionProjectCreated?: (path: string) => void;
  /** Focused first-empty-bundle publication seam, rejected outside TERMINA_CORE_TEST. */
  afterEmptySessionReservation?: (path: string) => void;
};

export type PiSessionCopyOptions = {
  /** The app-private directory whose aggregate copy budget is reserved. */
  workspaceDir: string;
  /**
   * Optional identity captured when a prior owner published the source.
   * Replay callers must provide it so a replaced pathname cannot become the
   * source of a new branch.
  */
  expectedSourceIdentity?: PiSessionCopyIdentity;
  /** Direct parent whose identity is embedded in expectedSourceIdentity. */
  expectedSourceWorkspaceDir?: string;
  /** Identity established by the native worker before a first workspace use. */
  expectedWorkspaceIdentity?: {
    dev: string;
    ino: string;
    birthtimeNs?: string;
  };
  signal?: AbortSignal;
  /** Focused smaller bounds; production callers use the fixed constants. */
  testOnlyMaxBytes?: number;
  testOnlyMaxCount?: number;
  testOnlyMaxWorkBytes?: number;
  testHooks?: Pick<SessionTestHooks, "beforePiWorkspaceCreate" | "beforePiCopyDestinationOpen" | "afterDestinationReservation">;
};

export type PiSessionCopyIdentity = {
  dev: string;
  ino: string;
  /** Leaf metadata closes same-inode hardlink/relink replacements. */
  nlink?: string;
  size?: string;
  mtimeNs?: string;
  ctimeNs?: string;
  /** Identity of the admitted workspace root, required for cleanup. */
  rootDev?: string;
  rootIno?: string;
  rootBirthtimeNs?: string;
};

export type PiSessionCopyResult =
  | { ok: true; sessionFile: string; bytes: number; workBytes: number; identity: PiSessionCopyIdentity }
  | { ok: false; error: string; path?: string; commit?: "uncertain" };

export type ForkSessionResult =
  | ({ ok: true } & { kept: number })
  | { ok: false; error: string; commit?: "uncertain" };

export type ReplaySessionBundleOptions = SessionOperationOptions & {
  throughSeq?: number;
};

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

/**
 * The proof needed to hand an empty bundle to the native bound remover.
 * Paths are retained only as names; the native owner reopens the root and
 * verifies these identities before it mutates anything.
 */
export type EmptySessionBundleProof = {
  sessionFile: string;
  bundleDir: string;
  projectDir: string;
  rootIdentity: { dev: string; ino: string; birthtimeNs: string };
  bundleIdentity: { dev: string; ino: string };
};

export type EmptySessionBundleInspection =
  | { ok: true; empty: false }
  | { ok: true; empty: true; proof: EmptySessionBundleProof }
  | SessionFailure;

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

function errorCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : null;
}

const UNBOUND_CLEANUP_ERROR = "session cleanup is not descriptor-bound";

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
function retainUnboundCleanup(path: string, hook?: (path: string) => void, retentionRunId?: string): SessionFailure {
  try {
    if (retentionRunId) writeRetainedStagingOwner(path, retentionRunId);
    hook?.(path);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  return { ok: false, error: UNBOUND_CLEANUP_ERROR };
}

function cancellation(signal?: AbortSignal): SessionFailure | null {
  return signal?.aborted ? { ok: false, error: "session operation cancelled" } : null;
}

function sessionBundleLimit(options?: SessionOperationOptions): SessionResult<{ limit: number }> {
  if ((options?.testHooks || options?.testOnlyPostRenameDelayMs !== undefined) && process.env.TERMINA_CORE_TEST !== "1") {
    return { ok: false, error: "test-only session operation controls are unavailable" };
  }
  if (
    options?.testOnlyPostRenameDelayMs !== undefined &&
    (!Number.isSafeInteger(options.testOnlyPostRenameDelayMs) ||
      options.testOnlyPostRenameDelayMs < 0 ||
      options.testOnlyPostRenameDelayMs > 5_000)
  ) {
    return { ok: false, error: "invalid test-only post-rename delay" };
  }
  const testLimit = options?.testOnlyMaxBundleBytes;
  if (testLimit === undefined) return { ok: true, limit: MAX_SESSION_BUNDLE_BYTES };
  if (process.env.TERMINA_CORE_TEST !== "1") {
    return { ok: false, error: "test-only session bundle limit is unavailable" };
  }
  if (!Number.isSafeInteger(testLimit) || testLimit < 1 || testLimit > MAX_SESSION_BUNDLE_BYTES) {
    return { ok: false, error: "invalid test-only session bundle limit" };
  }
  return { ok: true, limit: testLimit };
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
    return fsyncDirectoryDescriptor(fd);
  } catch (err) {
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

function fsyncDirectoryDescriptor(fd: number): SessionResult {
  try {
    fsyncSync(fd);
    return { ok: true };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EISDIR") {
      return { ok: true };
    }
    return { ok: false, error: errMsg(err) };
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

function enforceSessionBundleLimit(listing: CurrentListing, limit: number): SessionResult<{ bytes: number }> {
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

function currentHasContent(listing: CurrentListing): boolean {
  if (listing.images.length > 0) return true;
  if (listing.active && listing.active.size > 0) return true;
  return listing.parts.some((p) => p.size > 0);
}

type StableIdentity = {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
};

type DirectoryAnchor = {
  path: string;
  fd: number;
  identity: StableIdentity;
};

type OpenSessionSegment = {
  path: string;
  name: string;
  fd: number;
  size: number;
  identity: StableIdentity;
  allowTruncatedTail: boolean;
};

type OpenSessionBundle = {
  anchors: DirectoryAnchor[];
  segments: OpenSessionSegment[];
};

function statIdentity(info: BigIntStats): StableIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    mode: info.mode,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    birthtimeNs: info.birthtimeNs,
  };
}

function sameObject(left: StableIdentity, right: StableIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameObjectType(left: StableIdentity, right: StableIdentity): boolean {
  const typeMask = 0o170000n;
  return sameObject(left, right) && (left.mode & typeMask) === (right.mode & typeMask);
}

function sameVersion(left: StableIdentity, right: StableIdentity): boolean {
  return (
    sameObject(left, right) &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameDirectory(left: StableIdentity, right: StableIdentity): boolean {
  return sameObject(left, right) && left.mode === right.mode;
}

function noFollowFlags(base: number): number {
  return base | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
}

function anchoredChildPath(anchor: DirectoryAnchor, name: string, fallback: string): string {
  if (process.platform === "linux" && !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..") {
    return `/proc/self/fd/${anchor.fd}/${name}`;
  }
  return fallback;
}

function openDirectoryAnchor(path: string, label: string, descriptorPath = path): SessionResult<{ anchor: DirectoryAnchor }> {
  let fd: number | null = null;
  try {
    const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
    fd = openSync(descriptorPath, noFollowFlags(fsConstants.O_RDONLY | directoryFlag));
    const opened = fstatSync(fd, { bigint: true });
    const atPath = lstatSync(path, { bigint: true });
    if (!opened.isDirectory() || atPath.isSymbolicLink() || !atPath.isDirectory()) {
      throw new Error(`${label} is not a stable directory`);
    }
    const identity = statIdentity(opened);
    if (!sameDirectory(identity, statIdentity(atPath))) throw new Error(`${label} changed while it was opened`);
    return { ok: true, anchor: { path, fd, identity } };
  } catch (err) {
    if (fd !== null) closeSync(fd);
    return { ok: false, error: errMsg(err) };
  }
}

function validateDirectoryAnchor(anchor: DirectoryAnchor): SessionResult {
  try {
    const opened = fstatSync(anchor.fd, { bigint: true });
    const atPath = lstatSync(anchor.path, { bigint: true });
    if (!opened.isDirectory() || atPath.isSymbolicLink() || !atPath.isDirectory()) {
      return { ok: false, error: `session directory changed: ${anchor.path}` };
    }
    if (!sameDirectory(anchor.identity, statIdentity(opened)) || !sameDirectory(anchor.identity, statIdentity(atPath))) {
      return { ok: false, error: `session directory changed: ${anchor.path}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

function validateReopenedDirectoryIdentity(
  anchor: DirectoryAnchor,
  parent: DirectoryAnchor,
  exactMode: boolean,
): SessionResult {
  let reopenedFd: number | null = null;
  try {
    const retained = fstatSync(anchor.fd, { bigint: true });
    const descriptorPath = anchoredChildPath(parent, basename(anchor.path), anchor.path);
    const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
    reopenedFd = openSync(descriptorPath, noFollowFlags(fsConstants.O_RDONLY | directoryFlag));
    const reopened = fstatSync(reopenedFd, { bigint: true });
    const atPath = lstatSync(anchor.path, { bigint: true });
    if (!retained.isDirectory() || !reopened.isDirectory() || atPath.isSymbolicLink() || !atPath.isDirectory()) {
      return { ok: false, error: `session directory changed: ${anchor.path}` };
    }
    const matches = exactMode ? sameDirectory : sameObjectType;
    if (
      !matches(anchor.identity, statIdentity(retained)) ||
      !matches(anchor.identity, statIdentity(reopened)) ||
      !matches(anchor.identity, statIdentity(atPath))
    ) {
      return { ok: false, error: `session directory changed: ${anchor.path}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    if (reopenedFd !== null) closeSync(reopenedFd);
  }
}

function validateSegment(segment: OpenSessionSegment): SessionResult {
  try {
    const opened = fstatSync(segment.fd, { bigint: true });
    const atPath = lstatSync(segment.path, { bigint: true });
    if (!opened.isFile() || atPath.isSymbolicLink() || !atPath.isFile()) {
      return { ok: false, error: `session segment changed: ${segment.name}` };
    }
    if (!sameVersion(segment.identity, statIdentity(opened)) || !sameVersion(segment.identity, statIdentity(atPath))) {
      return { ok: false, error: `session segment changed: ${segment.name}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

function closeOpenSessionBundle(bundle: OpenSessionBundle): void {
  for (const segment of bundle.segments) {
    try {
      closeSync(segment.fd);
    } catch {
      /* already closed */
    }
  }
  for (const anchor of bundle.anchors) {
    try {
      closeSync(anchor.fd);
    } catch {
      /* already closed */
    }
  }
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

function validateOpenSegmentAccess(bundle: OpenSessionBundle, segment: OpenSessionSegment): SessionResult {
  for (const anchor of bundle.anchors) {
    const valid = validateDirectoryAnchor(anchor);
    if (!valid.ok) return valid;
  }
  return validateSegment(segment);
}

function openStableSessionBundle(
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

function fingerprintOpenSessionBundle(bundle: OpenSessionBundle, limit: number): SessionResult<{ fingerprint: string }> {
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
    const id = segment.identity;
    fingerprints.push(`${segment.name}:${id.dev}:${id.ino}:${id.size}:${id.mtimeNs}:${id.ctimeNs}:${hash.digest("hex")}`);
  }
  const stableAfterBundle = validateOpenSessionBundle(bundle);
  if (!stableAfterBundle.ok) return stableAfterBundle;
  return { ok: true, fingerprint: fingerprints.join("\n") };
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
function createSessionBundleWithAdmission(
  parsed: SessionBundlePaths,
  hooks?: Pick<SessionTestHooks, "afterSessionProjectCreated" | "afterEmptySessionReservation">,
): SessionResult {
  const admissionRoot = dirname(parsed.projectDir);
  const projectName = basename(parsed.projectDir);
  if (!safeSessionChildName(projectName)) return { ok: false, error: "session project directory has an invalid name" };
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
    const openedProject = openOrCreateSessionChildDirectory(root, parsed.projectDir, "session project directory");
    if (!openedProject.ok) return openedProject;
    project = openedProject.anchor;
    if (openedProject.created) {
      try {
        hooks?.afterSessionProjectCreated?.(parsed.projectDir);
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    }
    const current = inspectEntry(parsed.currentDir);
    if (current?.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
    if (current && current.kind !== "dir") return { ok: false, error: "current is not a directory" };
    if (current) {
      const active = inspectEntry(parsed.sessionFile);
      if (active?.kind === "symlink") return { ok: false, error: "active session segment is a symlink" };
      if (active?.kind === "file") {
        const rootAfter = validateDirectoryAnchor(root);
        if (!rootAfter.ok) return rootAfter;
        const projectAfter = validateDirectoryAnchor(project);
        if (!projectAfter.ok) return projectAfter;
        return { ok: true };
      }
    }
    const admitted = admitNewEmptySessionBundle(parsed.projectDir, parsed.sessionId);
    if (!admitted.ok) return admitted;
    const created = createCurrentDirBound(project, parsed.bundleDir, parsed.currentDir, parsed.sessionFile, hooks);
    if (!created.ok) return created;
    const rootAfter = validateDirectoryAnchor(root);
    if (!rootAfter.ok) return rootAfter;
    const projectAfter = validateDirectoryAnchor(project);
    if (!projectAfter.ok) return projectAfter;
    const rechecked = emptySessionBundleAdmission(parsed.projectDir);
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
  bundle: OpenSessionBundle,
  segment: OpenSessionSegment,
  readBudget: { remaining: number },
  state: ReplayState | null,
  throughSeq?: number,
  onRecord?: (record: unknown) => void,
  signal?: AbortSignal,
): Promise<SessionResult<{ bytes: number; records: number; stop: boolean }>> {
  const cancelledBeforeRead = cancellation(signal);
  if (cancelledBeforeRead) return cancelledBeforeRead;
  const stableBeforeRead = validateOpenSegmentAccess(bundle, segment);
  if (!stableBeforeRead.ok) return stableBeforeRead;
  let pending: Buffer = Buffer.alloc(0);
  const chunk = Buffer.alloc(READ_CHUNK);
  let position = 0;
  let bytes = 0;
  let records = 0;
  let sinceYieldBytes = 0;
  let sinceYieldRecords = 0;
  let stop = false;
  for (;;) {
    const cancelledBeforeChunk = cancellation(signal);
    if (cancelledBeforeChunk) return cancelledBeforeChunk;
    const remainingSegment = segment.size - position;
    if (remainingSegment < 0 || readBudget.remaining < 0) {
      return { ok: false, error: "session bundle exceeds MAX_SESSION_BUNDLE_BYTES" };
    }
    let n = 0;
    if (remainingSegment > 0) {
      const length = Math.min(chunk.length, remainingSegment, readBudget.remaining);
      if (length < 1) return { ok: false, error: "session bundle exceeds MAX_SESSION_BUNDLE_BYTES" };
      n = readSync(segment.fd, chunk, 0, length, position);
      if (n < 1) return { ok: false, error: `session segment changed while reading: ${segment.name}` };
      position += n;
      readBudget.remaining -= n;
    }
    const atEnd = position === segment.size;
    if (n > 0) pending = Buffer.concat([pending, chunk.subarray(0, n)]);
    for (;;) {
      const nl = pending.indexOf(0x0a);
      if (atEnd && nl < 0 && pending.length > 0) {
        if (pending.length > MAX_SESSION_RECORD_BYTES) {
          return { ok: false, error: "oversized session record" };
        }
        try {
          // Even a crash-truncated tail is decoded strictly. It may be
          // discarded as incomplete, but malformed UTF-8 is never replaced.
          UTF8_DECODER.decode(pending);
        } catch {
          return { ok: false, error: "invalid UTF-8 session record" };
        }
        if (!segment.allowTruncatedTail) return { ok: false, error: "truncated session record" };
        bytes += pending.length;
        pending = Buffer.alloc(0);
        break;
      }
      const taken = takeFramedLine(pending, atEnd && nl < 0, segment.allowTruncatedTail);
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
        const cancelledAfterYield = cancellation(signal);
        if (cancelledAfterYield) return cancelledAfterYield;
        const stableAfterYield = validateOpenSegmentAccess(bundle, segment);
        if (!stableAfterYield.ok) return stableAfterYield;
      }
      if (taken.done) break;
    }
    if (stop || atEnd) break;
  }
  const stableAfterRead = validateOpenSegmentAccess(bundle, segment);
  if (!stableAfterRead.ok) return stableAfterRead;
  return { ok: true, bytes, records, stop };
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
  opts?: ReplaySessionBundleOptions,
): Promise<SessionResult<{ messages: ReplayMessage[]; maxSeq: number; state: ReplayState; stopped: boolean; sourceFingerprint: string }>> {
  const limit = sessionBundleLimit(opts);
  if (!limit.ok) return limit;
  const cancelledBeforeReplay = cancellation(opts?.signal);
  if (cancelledBeforeReplay) return cancelledBeforeReplay;
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
  let lastRaceError = "session segments changed during replay";
  for (let attempt = 0; attempt < 3; attempt++) {
    const listing = listCurrentSegments(parsed.currentDir);
    if (!listing.ok) return listing;
    const recovered = listing.active ? listing : recoverActiveSegment(parsed.currentDir, parsed.sessionFile);
    if (!recovered.ok) return recovered;
    const withinLimit = enforceSessionBundleLimit(recovered, limit.limit);
    if (!withinLimit.ok) return withinLimit;
    const cancelledBeforeFingerprint = cancellation(opts?.signal);
    if (cancelledBeforeFingerprint) return cancelledBeforeFingerprint;
    const opened = openStableSessionBundle(parsed, recovered, limit.limit, opts);
    if (!opened.ok) {
      if (opened.error.includes("MAX_SESSION_BUNDLE_BYTES")) return opened;
      lastRaceError = opened.error;
      if (attempt < 2) continue;
      return opened;
    }
    try {
      const identity = fingerprintOpenSessionBundle(opened.bundle, limit.limit);
      if (!identity.ok) {
        if (identity.error.includes("MAX_SESSION_BUNDLE_BYTES")) return identity;
        lastRaceError = identity.error;
        if (attempt < 2) continue;
        return identity;
      }
      const state = createReplayState();
      const readBudget = { remaining: limit.limit };
      let stopped = false;
      let retry = false;
      for (const segment of opened.bundle.segments) {
        const got = await readSegmentIntoState(
          opened.bundle,
          segment,
          readBudget,
          state,
          opts?.throughSeq,
          undefined,
          opts?.signal,
        );
        if (!got.ok) {
          if (opts?.signal?.aborted) return got;
          if (got.error.includes("MAX_SESSION_BUNDLE_BYTES")) return got;
          lastRaceError = got.error;
          if (attempt < 2) retry = true;
          else return got;
          break;
        }
        if (got.stop) {
          stopped = true;
          break;
        }
      }
      if (retry) continue;
      const cancelledBeforeFinalFingerprint = cancellation(opts?.signal);
      if (cancelledBeforeFinalFingerprint) return cancelledBeforeFinalFingerprint;
      const afterIdentity = fingerprintOpenSessionBundle(opened.bundle, limit.limit);
      if (!afterIdentity.ok) {
        if (afterIdentity.error.includes("MAX_SESSION_BUNDLE_BYTES")) return afterIdentity;
        lastRaceError = afterIdentity.error;
        if (attempt < 2) continue;
        return afterIdentity;
      }
      if (identity.fingerprint === afterIdentity.fingerprint) {
        return {
          ok: true,
          messages: state.messages,
          maxSeq: state.maxSeq,
          state,
          stopped,
          sourceFingerprint: identity.fingerprint,
        };
      }
      lastRaceError = "session segments changed during replay";
    } finally {
      closeOpenSessionBundle(opened.bundle);
    }
  }
  return { ok: false, error: lastRaceError };
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
  options?: SessionOperationOptions,
): Promise<RecoveryScanResult> {
  const blocks = new Map<string, Record<string, unknown>>();
  if (targets.length === 0) return { ok: true, blocks };
  const limit = sessionBundleLimit(options);
  if (!limit.ok) return limit;
  const cancelledBeforeRecovery = cancellation(options?.signal);
  if (cancelledBeforeRecovery) return cancelledBeforeRecovery;
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const listing = listCurrentSegments(parsed.currentDir);
  if (!listing.ok) return listing;
  const withinLimit = enforceSessionBundleLimit(listing, limit.limit);
  if (!withinLimit.ok) return withinLimit;
  const opened = openStableSessionBundle(parsed, listing, limit.limit, options);
  if (!opened.ok) return opened;
  const beforeFingerprint = fingerprintOpenSessionBundle(opened.bundle, limit.limit);
  if (!beforeFingerprint.ok) {
    closeOpenSessionBundle(opened.bundle);
    return beforeFingerprint;
  }
  if (expectedFingerprint !== undefined && beforeFingerprint.fingerprint !== expectedFingerprint) {
    closeOpenSessionBundle(opened.bundle);
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
  try {
    const readBudget = { remaining: limit.limit };
    for (const segment of opened.bundle.segments) {
      const scanned = await readSegmentIntoState(
        opened.bundle,
        segment,
        readBudget,
        null,
        maxSseq,
        (record) => {
          if (!isRecord(record) || record.type !== "message" || typeof record.storageSeq !== "number") return;
          const entries = bySseq.get(record.storageSeq);
          if (!entries) return;
          const message = record.message;
          if (!isRecord(message) || !Array.isArray(message.content)) return;
          for (const entry of entries) {
            const block = message.content[entry.target.blockIndex];
            if (isRecord(block)) blocks.set(entry.key, cloneJson(block));
          }
        },
        options?.signal,
      );
      if (!scanned.ok) return scanned;
      if (scanned.stop) break;
    }
    const afterFingerprint = fingerprintOpenSessionBundle(opened.bundle, limit.limit);
    if (!afterFingerprint.ok) return afterFingerprint;
    if (
      afterFingerprint.fingerprint !== beforeFingerprint.fingerprint ||
      (expectedFingerprint !== undefined && afterFingerprint.fingerprint !== expectedFingerprint)
    ) {
      return { ok: false, error: "session segments changed during recovery" };
    }
  } finally {
    closeOpenSessionBundle(opened.bundle);
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

type PiCopyWorkspaceUsage = {
  count: number;
  bytes: number;
  workBytes: number;
};

type PiCopyControls = {
  sourceBytes: number;
  aggregateBytes: number;
  count: number;
  workBytes: number;
};

function piCopyControls(options: PiSessionCopyOptions): SessionResult<PiCopyControls> {
  const testControls = [options.testOnlyMaxBytes, options.testOnlyMaxCount, options.testOnlyMaxWorkBytes].some((value) => value !== undefined)
    || options.testHooks !== undefined;
  if (testControls && process.env.TERMINA_CORE_TEST !== "1") {
    return { ok: false, error: "test-only Pi session copy controls are unavailable" };
  }
  const aggregateBytes = options.testOnlyMaxBytes ?? MAX_PI_SESSION_COPY_BYTES;
  const sourceBytes = options.testOnlyMaxBytes ?? MAX_PI_SESSION_BYTES;
  const count = options.testOnlyMaxCount ?? MAX_PI_SESSION_COPY_COUNT;
  const workBytes = options.testOnlyMaxWorkBytes ?? MAX_PI_SESSION_COPY_WORK_BYTES;
  if (
    !Number.isSafeInteger(aggregateBytes) || aggregateBytes < 1 || aggregateBytes > MAX_PI_SESSION_COPY_BYTES
    || !Number.isSafeInteger(sourceBytes) || sourceBytes < 1 || sourceBytes > MAX_PI_SESSION_BYTES
    || !Number.isSafeInteger(count) || count < 1 || count > MAX_PI_SESSION_COPY_COUNT
    || !Number.isSafeInteger(workBytes) || workBytes < 1 || workBytes > MAX_PI_SESSION_COPY_WORK_BYTES
  ) {
    return { ok: false, error: "invalid Pi session copy admission bound" };
  }
  return { ok: true, sourceBytes, aggregateBytes, count, workBytes };
}

function piCopyPathBytes(path: string): number {
  return Buffer.byteLength(path, "utf8") + 1;
}

function piCopyWorkBytes(path: string, bytes: number): number | null {
  const pathBytes = piCopyPathBytes(path);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Math.floor((Number.MAX_SAFE_INTEGER - pathBytes) / 2)) return null;
  return bytes * 2 + pathBytes;
}

/**
 * Measure every regular file below a Pi scratch root.  The copy destination
 * itself is created before any source bytes are read, so this measurement is
 * also the durable reservation seen by the next process.  Images, dotfiles,
 * and unknown files are intentionally counted rather than silently ignored.
 */
function piCopyWorkspaceUsage(root: string, limit: PiCopyControls): SessionResult<PiCopyWorkspaceUsage> {
  const rootEntry = inspectEntry(root);
  if (!rootEntry || rootEntry.kind !== "dir") {
    return { ok: false, error: rootEntry?.kind === "symlink" ? "Pi session workspace is a symlink" : "Pi session workspace is not a directory" };
  }
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let entries = 0;
  let count = 0;
  let bytes = 0;
  let workBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_PI_SESSION_COPY_SCAN_DEPTH) {
      return { ok: false, error: `Pi session workspace exceeds its ${MAX_PI_SESSION_COPY_SCAN_DEPTH}-level depth bound` };
    }
    let names: string[];
    try {
      names = readdirSync(current.path);
    } catch (err) {
      return { ok: false, error: `could not inspect Pi session workspace: ${errMsg(err)}` };
    }
    for (const name of names) {
      // The shared lock is an admission primitive, not evidence. Never walk
      // its owner record or guard directory as if they were a copy.
      if (current.depth === 0 && name === RETAINED_SESSION_ADMISSION_LOCK) continue;
      entries += 1;
      if (entries > MAX_PI_SESSION_COPY_SCAN_ENTRIES) {
        return { ok: false, error: `Pi session workspace exceeds its ${MAX_PI_SESSION_COPY_SCAN_ENTRIES}-entry inspection bound` };
      }
      const child = join(current.path, name);
      const info = inspectEntry(child);
      if (!info) return { ok: false, error: "Pi session workspace changed while it was being measured" };
      if (info.kind === "symlink") return { ok: false, error: `Pi session workspace contains a symbolic link: ${name}` };
      if (info.kind === "dir") {
        pending.push({ path: child, depth: current.depth + 1 });
        continue;
      }
      if (info.kind !== "file") return { ok: false, error: `Pi session workspace contains an unsupported entry: ${name}` };
      count += 1;
      if (count > limit.count) return { ok: false, error: `Pi session workspace exceeds its ${limit.count}-copy count bound` };
      if (!Number.isSafeInteger(info.size) || info.size < 0 || bytes > limit.aggregateBytes - info.size) {
        return { ok: false, error: `Pi session workspace exceeds its ${limit.aggregateBytes}-byte bound` };
      }
      bytes += info.size;
      const fileWork = piCopyWorkBytes(child, info.size);
      if (fileWork === null || workBytes > limit.workBytes - fileWork) {
        return { ok: false, error: `Pi session workspace exceeds its ${limit.workBytes}-byte work bound` };
      }
      workBytes += fileWork;
    }
  }
  return { ok: true, count, bytes, workBytes };
}

function piCopyRootStable(root: DirectoryAnchor, lock: SessionRetentionLock): SessionResult {
  const lease = validateSessionRetentionLease(root.path, lock);
  if (lease === null) return { ok: false, error: "Pi session workspace admission lease changed" };
  const current = validateDirectoryAnchor(root);
  if (!current.ok) return current;
  if (String(root.identity.dev) !== String(lock.rootIdentity.dev) || String(root.identity.ino) !== String(lock.rootIdentity.ino)) {
    return { ok: false, error: "Pi session workspace identity changed" };
  }
  return { ok: true };
}

/** Remove one Pi scratch file with an identity proof; never recurse. */
function removePiSessionCopyLocked(
  path: string,
  root: DirectoryAnchor,
  lock: SessionRetentionLock,
  expectedIdentity: PiSessionCopyIdentity | undefined,
): SessionResult<{ removed: boolean }> {
  const rootStable = piCopyRootStable(root, lock);
  if (!rootStable.ok) return rootStable;
  if (expectedIdentity?.rootDev === undefined || expectedIdentity.rootIno === undefined) {
    return { ok: false, error: "Pi session copy cleanup has no workspace provenance; retained" };
  }
  if (
    String(root.identity.dev) !== expectedIdentity.rootDev
    || String(root.identity.ino) !== expectedIdentity.rootIno
  ) {
    return { ok: false, error: "Pi session workspace changed; retained" };
  }
  if (expectedIdentity.rootBirthtimeNs !== undefined && String(root.identity.birthtimeNs) !== expectedIdentity.rootBirthtimeNs) {
    return { ok: false, error: "Pi session workspace generation changed; retained" };
  }
  // Node does not expose unlinkat(2) on macOS/Windows.  A pathname unlink
  // after the descriptor proof would reopen the leaf and can delete an ABA
  // replacement, so unsupported hosts retain the bounded evidence.
  if (process.platform !== "linux") {
    return { ok: false, error: "descriptor-bound Pi session cleanup is unavailable; retained" };
  }
  let info: BigIntStats;
  try {
    info = lstatSync(path, { bigint: true });
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return expectedIdentity
        ? { ok: false, error: "Pi session copy cleanup target changed; retained" }
        : { ok: true, removed: false };
    }
    return { ok: false, error: errMsg(err) };
  }
  if (!info.isFile() || info.isSymbolicLink()) return { ok: false, error: "Pi session copy cleanup target is not a regular file" };
  const identity = { dev: String(info.dev), ino: String(info.ino) };
  if (expectedIdentity && (identity.dev !== expectedIdentity.dev || identity.ino !== expectedIdentity.ino)) {
    return { ok: false, error: "Pi session copy cleanup target changed; retained" };
  }
  if (
    (expectedIdentity?.nlink !== undefined && String(info.nlink) !== expectedIdentity.nlink)
    || (expectedIdentity?.size !== undefined && String(info.size) !== expectedIdentity.size)
    || (expectedIdentity?.mtimeNs !== undefined && String(info.mtimeNs) !== expectedIdentity.mtimeNs)
    || (expectedIdentity?.ctimeNs !== undefined && String(info.ctimeNs) !== expectedIdentity.ctimeNs)
  ) {
    return { ok: false, error: "Pi session copy cleanup target metadata changed; retained" };
  }
  const rootBeforeRemove = piCopyRootStable(root, lock);
  if (!rootBeforeRemove.ok) return rootBeforeRemove;
  let after: BigIntStats;
  try {
    after = lstatSync(path, { bigint: true });
  } catch (err) {
    return { ok: false, error: errorCode(err) === "ENOENT" ? "Pi session copy cleanup target changed; retained" : errMsg(err) };
  }
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || after.dev !== info.dev
    || after.ino !== info.ino
    || after.nlink !== info.nlink
    || after.size !== info.size
    || after.mtimeNs !== info.mtimeNs
    || after.ctimeNs !== info.ctimeNs
  ) {
    return { ok: false, error: "Pi session copy cleanup target changed; retained" };
  }
  try {
    const anchored = anchoredChildPath(root, basename(path), path);
    unlinkSync(anchored);
    const synced = fsyncDirectoryDescriptor(root.fd);
    if (!synced.ok) return synced;
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

type PiWorkspaceTransaction = {
  anchor: DirectoryAnchor;
  lock: SessionRetentionLock;
};

function piWorkspaceIdentityMatches(
  identity: StableIdentity,
  expected?: PiSessionCopyOptions["expectedWorkspaceIdentity"],
): boolean {
  if (!expected) return true;
  return String(identity.dev) === expected.dev
    && String(identity.ino) === expected.ino
    && (expected.birthtimeNs === undefined || String(identity.birthtimeNs) === expected.birthtimeNs);
}

/**
 * Establish one Pi workspace transaction before reading or writing a copy.
 * The parent lock serializes first creation with later users of the same
 * workspace; the child lock then remains held for the admission, copy, and
 * identity-bound cleanup. Missing parents are never recursively created.
 */
function openPiWorkspaceTransaction(
  path: string,
  expected?: PiSessionCopyOptions["expectedWorkspaceIdentity"],
  createIfMissing = true,
  hooks?: Pick<PiSessionCopyOptions, "testHooks">,
): SessionResult<PiWorkspaceTransaction> {
  const workspace = resolve(path);
  const parentPath = dirname(workspace);
  const name = basename(workspace);
  if (!safeSessionChildName(name)) return { ok: false, error: "Pi session workspace has an invalid name" };
  let parentLock: SessionRetentionLock;
  try {
    parentLock = acquireSessionRetentionLock(parentPath);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  let parent: DirectoryAnchor | null = null;
  let anchor: DirectoryAnchor | null = null;
  let lock: SessionRetentionLock | null = null;
  let transferred = false;
  try {
    const openedParent = openDirectoryAnchor(parentPath, "Pi session workspace parent");
    if (!openedParent.ok) return openedParent;
    parent = openedParent.anchor;
    const parentStable = validateDirectoryAnchor(parent);
    if (!parentStable.ok) return parentStable;
    const existing = inspectEntry(workspace);
    if (existing?.kind === "symlink") return { ok: false, error: "Pi session workspace is a symlink" };
    if (existing && existing.kind !== "dir") return { ok: false, error: "Pi session workspace is not a directory" };
    if (!existing) {
      if (!createIfMissing) return { ok: false, error: "Pi session workspace is missing; retained" };
      try {
        hooks?.testHooks?.beforePiWorkspaceCreate?.(workspace);
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
      const parentBeforeCreate = validateDirectoryAnchor(parent);
      if (!parentBeforeCreate.ok) return parentBeforeCreate;
      const afterHook = inspectEntry(workspace);
      if (afterHook?.kind === "symlink") return { ok: false, error: "Pi session workspace is a symlink" };
      if (afterHook && afterHook.kind !== "dir") return { ok: false, error: "Pi session workspace is not a directory" };
      if (!afterHook) {
        try {
          mkdirSync(anchoredChildPath(parent, name, workspace), { recursive: false, mode: 0o700 });
          const synced = fsyncDirectoryDescriptor(parent.fd);
          if (!synced.ok) return synced;
        } catch (err) {
          if (errorCode(err) !== "EEXIST") return { ok: false, error: errMsg(err) };
          const raced = inspectEntry(workspace);
          if (!raced || raced.kind === "symlink" || raced.kind !== "dir") return { ok: false, error: "Pi session workspace changed while it was created" };
        }
      }
    }
    const opened = openDirectoryAnchor(workspace, "Pi session workspace", anchoredChildPath(parent, name, workspace));
    if (!opened.ok) return opened;
    anchor = opened.anchor;
    const parentAfter = validateDirectoryAnchor(parent);
    if (!parentAfter.ok) return parentAfter;
    const anchorAfter = validateDirectoryAnchor(anchor);
    if (!anchorAfter.ok) return anchorAfter;
    if (!piWorkspaceIdentityMatches(anchor.identity, expected)) return { ok: false, error: "Pi session workspace identity changed; retained" };
    try {
      lock = acquireSessionRetentionLock(workspace);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    const lockedRoot = piCopyRootStable(anchor, lock);
    if (!lockedRoot.ok) return lockedRoot;
    if (!piWorkspaceIdentityMatches(anchor.identity, expected)) return { ok: false, error: "Pi session workspace identity changed; retained" };
    closeSync(parent.fd);
    parent = null;
    releaseSessionRetentionLock(parentLock);
    transferred = true;
    return { ok: true, anchor, lock };
  } finally {
    if (parent) closeSync(parent.fd);
    if (!transferred) {
      if (anchor) closeSync(anchor.fd);
      if (lock) releaseSessionRetentionLock(lock);
      releaseSessionRetentionLock(parentLock);
    }
  }
}

/**
 * Copy one Pi session into an app-private workspace with pre-copy admission.
 * The destination is exclusively created and sized before source bytes are
 * read; that file is the durable reservation visible to concurrent/restarted
 * owners. The worker later hands its identity to native bound cleanup.
 */
export async function copyPiSessionFile(
  sourcePath: string,
  destinationPath: string,
  options: PiSessionCopyOptions,
): Promise<PiSessionCopyResult> {
  const controls = piCopyControls(options);
  if (!controls.ok) return controls;
  const cancelledBeforeCopy = cancellation(options.signal);
  if (cancelledBeforeCopy) return cancelledBeforeCopy;
  const workspace = resolve(options.workspaceDir);
  const target = resolve(destinationPath);
  if (dirname(target) !== workspace) return { ok: false, error: "Pi session copy destination escaped its workspace" };
  const sourceName = resolve(sourcePath);
  let sourceFd: number | null = null;
  let destinationFd: number | null = null;
  let rootAnchor: DirectoryAnchor | null = null;
  let sourceRootAnchor: DirectoryAnchor | null = null;
  let lock: SessionRetentionLock | null = null;
  let destinationIdentity: PiSessionCopyIdentity | undefined;
  let destinationCreated = false;
  try {
    const transaction = openPiWorkspaceTransaction(workspace, options.expectedWorkspaceIdentity, true, { testHooks: options.testHooks });
    if (!transaction.ok) return transaction;
    rootAnchor = transaction.anchor;
    lock = transaction.lock;
    sourceFd = openSync(sourceName, noFollowFlags(fsConstants.O_RDONLY));
    const sourceOpened = fstatSync(sourceFd, { bigint: true });
    const sourceAtPath = lstatSync(sourceName, { bigint: true });
    if (!sourceOpened.isFile() || sourceAtPath.isSymbolicLink() || !sourceAtPath.isFile()) {
      return { ok: false, error: "Pi session source is not a regular file" };
    }
    if (sourceOpened.size > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: "Pi session source byte count overflow" };
    const sourceBytes = Number(sourceOpened.size);
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes > controls.sourceBytes) {
      return { ok: false, error: `Pi session source exceeds its ${controls.sourceBytes}-byte bound` };
    }
    const sourceIdentity = statIdentity(sourceOpened);
    if (!sameVersion(sourceIdentity, statIdentity(sourceAtPath))) return { ok: false, error: "Pi session source changed while it was opened" };
    const expectedSource = options.expectedSourceIdentity;
    if (expectedSource) {
      const expectedSourceWorkspace = options.expectedSourceWorkspaceDir
        ? resolve(options.expectedSourceWorkspaceDir)
        : null;
      if (
        expectedSourceWorkspace === null
        || dirname(sourceName) !== expectedSourceWorkspace
        || expectedSource.rootDev === undefined
        || expectedSource.rootIno === undefined
        || expectedSource.rootBirthtimeNs === undefined
      ) {
        return { ok: false, error: "Pi session source provenance is unavailable; retained" };
      }
      if (
        sourceIdentity.dev.toString() !== expectedSource.dev
        || sourceIdentity.ino.toString() !== expectedSource.ino
        || (expectedSource.nlink !== undefined && sourceIdentity.nlink?.toString() !== expectedSource.nlink)
        || (expectedSource.size !== undefined && sourceIdentity.size.toString() !== expectedSource.size)
        || (expectedSource.mtimeNs !== undefined && sourceIdentity.mtimeNs.toString() !== expectedSource.mtimeNs)
        || (expectedSource.ctimeNs !== undefined && sourceIdentity.ctimeNs.toString() !== expectedSource.ctimeNs)
      ) {
        return { ok: false, error: "Pi session source identity changed; retained" };
      }
    }
    const requestedWork = piCopyWorkBytes(target, sourceBytes);
    if (requestedWork === null || requestedWork > controls.workBytes) return { ok: false, error: `Pi session copy exceeds its ${controls.workBytes}-byte work bound` };
    const rootStable = piCopyRootStable(rootAnchor, lock);
    if (!rootStable.ok) return rootStable;
    if (expectedSource) {
      const expectedSourceWorkspace = resolve(options.expectedSourceWorkspaceDir!);
      const openedSourceRoot = openDirectoryAnchor(expectedSourceWorkspace, "Pi session source workspace");
      if (!openedSourceRoot.ok) return openedSourceRoot;
      sourceRootAnchor = openedSourceRoot.anchor;
      if (
        String(sourceRootAnchor.identity.dev) !== expectedSource.rootDev
        || String(sourceRootAnchor.identity.ino) !== expectedSource.rootIno
        || String(sourceRootAnchor.identity.birthtimeNs) !== expectedSource.rootBirthtimeNs
      ) {
        return { ok: false, error: "Pi session source workspace identity changed; retained" };
      }
      const sourceAtRoot = lstatSync(
        anchoredChildPath(sourceRootAnchor, basename(sourceName), sourceName),
        { bigint: true },
      );
      if (sourceAtRoot.isSymbolicLink() || !sourceAtRoot.isFile() || !sameVersion(sourceIdentity, statIdentity(sourceAtRoot))) {
        return { ok: false, error: "Pi session source identity changed; retained" };
      }
    }
    const usage = piCopyWorkspaceUsage(workspace, controls);
    if (!usage.ok) return usage;
    if (usage.count >= controls.count) return { ok: false, error: `Pi session workspace is at its ${controls.count}-copy bound` };
    if (usage.bytes > controls.aggregateBytes - sourceBytes) return { ok: false, error: `Pi session workspace would exceed its ${controls.aggregateBytes}-byte bound` };
    if (usage.workBytes > controls.workBytes - requestedWork) return { ok: false, error: `Pi session workspace would exceed its ${controls.workBytes}-byte work bound` };
    try {
      options.testHooks?.beforePiCopyDestinationOpen?.(target);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    const rootBeforeDestination = piCopyRootStable(rootAnchor, lock);
    if (!rootBeforeDestination.ok) return rootBeforeDestination;
    try {
      lstatSync(target);
      return { ok: false, error: "Pi session copy destination already exists" };
    } catch (err) {
      if (errorCode(err) !== "ENOENT") return { ok: false, error: errMsg(err) };
    }
    destinationFd = openSync(
      anchoredChildPath(rootAnchor, basename(target), target),
      noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    destinationCreated = true;
    ftruncateSync(destinationFd, sourceBytes);
    fsyncSync(destinationFd);
    const reserved = fstatSync(destinationFd, { bigint: true });
    destinationIdentity = {
      dev: String(reserved.dev),
      ino: String(reserved.ino),
      nlink: String(reserved.nlink),
      size: String(reserved.size),
      mtimeNs: String(reserved.mtimeNs),
      ctimeNs: String(reserved.ctimeNs),
      rootDev: String(rootAnchor.identity.dev),
      rootIno: String(rootAnchor.identity.ino),
      rootBirthtimeNs: String(rootAnchor.identity.birthtimeNs),
    };
    options.testHooks?.afterDestinationReservation?.(target);
    const cancelledAfterReservation = cancellation(options.signal);
    if (cancelledAfterReservation) throw new Error(cancelledAfterReservation.error);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < sourceBytes) {
      const cancelled = cancellation(options.signal);
      if (cancelled) throw new Error(cancelled.error);
      const read = readSync(sourceFd, chunk, 0, Math.min(chunk.length, sourceBytes - position), position);
      if (read < 1) throw new Error("Pi session source changed while it was being copied");
      let written = 0;
      while (written < read) {
        const count = writeSync(destinationFd, chunk, written, read - written, position + written);
        if (count < 1) throw new Error("could not copy Pi session source");
        written += count;
      }
      position += read;
    }
    if (!sameVersion(sourceIdentity, statIdentity(fstatSync(sourceFd, { bigint: true })))) throw new Error("Pi session source changed while it was being copied");
    const sourceAfter = lstatSync(sourceName, { bigint: true });
    if (sourceAfter.isSymbolicLink() || !sourceAfter.isFile() || !sameVersion(sourceIdentity, statIdentity(sourceAfter))) {
      throw new Error("Pi session source pathname changed while it was being copied");
    }
    if (sourceRootAnchor) {
      const sourceRootStable = validateDirectoryAnchor(sourceRootAnchor);
      if (!sourceRootStable.ok) throw new Error(sourceRootStable.error);
      const sourceAtRoot = lstatSync(
        anchoredChildPath(sourceRootAnchor, basename(sourceName), sourceName),
        { bigint: true },
      );
      if (sourceAtRoot.isSymbolicLink() || !sourceAtRoot.isFile() || !sameVersion(sourceIdentity, statIdentity(sourceAtRoot))) {
        throw new Error("Pi session source pathname changed while it was being copied");
      }
    }
    const destinationAfter = fstatSync(destinationFd, { bigint: true });
    if (!destinationAfter.isFile() || destinationAfter.size !== BigInt(sourceBytes)) throw new Error("Pi session copy destination size changed");
    destinationIdentity = {
      ...destinationIdentity,
      nlink: String(destinationAfter.nlink),
      size: String(destinationAfter.size),
      mtimeNs: String(destinationAfter.mtimeNs),
      ctimeNs: String(destinationAfter.ctimeNs),
    };
    const rootAfterCopy = piCopyRootStable(rootAnchor, lock);
    if (!rootAfterCopy.ok) throw new Error(rootAfterCopy.error);
    const destinationAtPath = lstatSync(
      anchoredChildPath(rootAnchor, basename(target), target),
      { bigint: true },
    );
    if (
      destinationAtPath.isSymbolicLink()
      || !destinationAtPath.isFile()
      || String(destinationAtPath.dev) !== destinationIdentity.dev
      || String(destinationAtPath.ino) !== destinationIdentity.ino
      || String(destinationAtPath.nlink) !== destinationIdentity.nlink
      || String(destinationAtPath.size) !== destinationIdentity.size
      || String(destinationAtPath.mtimeNs) !== destinationIdentity.mtimeNs
      || String(destinationAtPath.ctimeNs) !== destinationIdentity.ctimeNs
    ) throw new Error("Pi session copy destination pathname changed while it was copied");
    fsyncSync(destinationFd);
    const synced = fsyncDirectoryDescriptor(rootAnchor.fd);
    if (!synced.ok) throw new Error(synced.error);
    return { ok: true, sessionFile: target, bytes: sourceBytes, workBytes: requestedWork, identity: destinationIdentity };
  } catch (err) {
    const error = errMsg(err);
    if (destinationCreated && destinationIdentity && rootAnchor && lock) {
      if (destinationFd !== null) {
        try { closeSync(destinationFd); } catch { /* cleanup below owns the path */ }
        destinationFd = null;
      }
      const cleaned = removePiSessionCopyLocked(target, rootAnchor, lock, destinationIdentity);
      if (!cleaned.ok) return { ok: false, error: `${error}; Pi session copy cleanup retained: ${cleaned.error}`, path: target, commit: "uncertain" };
    }
    return { ok: false, error };
  } finally {
    if (destinationFd !== null) {
      try { closeSync(destinationFd); } catch { /* already closed */ }
    }
    if (sourceFd !== null) {
      try { closeSync(sourceFd); } catch { /* already closed */ }
    }
    if (rootAnchor) {
      try { closeSync(rootAnchor.fd); } catch { /* already closed */ }
    }
    if (sourceRootAnchor) {
      try { closeSync(sourceRootAnchor.fd); } catch { /* already closed */ }
    }
    if (lock) releaseSessionRetentionLock(lock);
  }
}

type TempBundle = {
  path: string;
  currentDir: string;
  sessionFile: string;
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

function retainedTempUsage(projectDir: string): SessionResult<RetainedTempUsage> {
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

function closeTempBundle(temp: TempBundle): void {
  for (const anchor of [temp.current, temp.temp, temp.parent]) {
    try {
      closeSync(anchor.fd);
    } catch {
      /* already closed */
    }
  }
}

function releaseTempRetentionLock(temp: TempBundle): void {
  if (temp.ownsRetentionLock) releaseSessionRetentionLock(temp.retentionLock);
}

function validateTempBundle(temp: TempBundle): SessionResult {
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
function createSecureTempBundle(dest: SessionBundlePaths, options?: SessionOperationOptions): SessionResult<{ temp: TempBundle }> {
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

function removeEmptyAppOwnedClaim(
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

function validateCommittedDestination(temp: TempBundle, committed: DirectoryAnchor): SessionResult {
  for (const anchor of [temp.parent, temp.temp, temp.current, committed]) {
    const valid = validateDirectoryAnchor(anchor);
    if (!valid.ok) return valid;
  }
  const reopenedBundle = validateReopenedDirectoryIdentity(committed, temp.parent, true);
  if (!reopenedBundle.ok) return reopenedBundle;
  return validateReopenedDirectoryIdentity(temp.current, committed, true);
}

async function copyReferencedImages(
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
        const retained = retainedTempUsage(dirname(temp.path));
        if (!retained.ok) throw new Error(retained.error);
        if (retained.bytes > MAX_RETAINED_TEMP_BYTES - size) {
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

function validateForkDestination(dest: SessionBundlePaths): SessionResult {
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

export async function writeForkedSession(
  sourcePath: string,
  destPath: string,
  throughSeq?: number,
  options?: SessionOperationOptions,
): Promise<ForkSessionResult> {
  if (throughSeq !== undefined && (!Number.isInteger(throughSeq) || throughSeq < 0)) {
    return { ok: false, error: "invalid throughSeq" };
  }
  const source = parseSessionBundlePath(sourcePath);
  const dest = parseSessionBundlePath(destPath);
  if (!source) return { ok: false, error: "source path is not a core session bundle" };
  if (!dest) return { ok: false, error: "destination path is not a core session bundle" };
  if (source.bundleDir === dest.bundleDir) return { ok: false, error: "source and destination session bundles must differ" };
  const limit = sessionBundleLimit(options);
  if (!limit.ok) return limit;
  const cancelledBeforeFork = cancellation(options?.signal);
  if (cancelledBeforeFork) return cancelledBeforeFork;
  const validDestination = validateForkDestination(dest);
  if (!validDestination.ok) return validDestination;
  const replayed = await replaySessionBundle(source.sessionFile, {
    ...(throughSeq === undefined ? {} : { throughSeq }),
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.testOnlyMaxBundleBytes === undefined
      ? {}
      : { testOnlyMaxBundleBytes: options.testOnlyMaxBundleBytes }),
    ...(options?.testHooks ? { testHooks: options.testHooks } : {}),
    ...(options?.testOnlyPostRenameDelayMs === undefined
      ? {}
      : { testOnlyPostRenameDelayMs: options.testOnlyPostRenameDelayMs }),
  });
  if (!replayed.ok) return replayed;
  const targetSeq = throughSeq ?? replayed.maxSeq;
  if (targetSeq === 0) return materializeEmptyFork(dest, options);
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
    options,
  );
}

async function materializeEmptyFork(dest: SessionBundlePaths, options?: SessionOperationOptions): Promise<ForkSessionResult> {
  const created = createSecureTempBundle(dest, options);
  if (!created.ok) return created;
  const temp = created.temp;
  try {
    const cancelledBeforeCreate = cancellation(options?.signal);
    if (cancelledBeforeCreate) return cancelledBeforeCreate;
    const stable = validateTempBundle(temp);
    if (!stable.ok) return stable;
    const currentSynced = fsyncDirectoryDescriptor(temp.current.fd);
    if (!currentSynced.ok) return currentSynced;
    const tempSynced = fsyncDirectoryDescriptor(temp.temp.fd);
    if (!tempSynced.ok) return tempSynced;
    const installed = await installTempBundle(temp, dest.bundleDir, options);
    if (!installed.ok) return installed;
    return { ok: true, kept: 0 };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    closeTempBundle(temp);
    retainUnboundCleanup(temp.path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
    releaseTempRetentionLock(temp);
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
  options?: SessionOperationOptions,
): Promise<ForkSessionResult> {
  const created = createSecureTempBundle(dest, options);
  if (!created.ok) return created;
  const temp = created.temp;
  try {
    const cancelledBeforeMaterialize = cancellation(options?.signal);
    if (cancelledBeforeMaterialize) return cancelledBeforeMaterialize;
    const stableBeforeWrite = validateTempBundle(temp);
    if (!stableBeforeWrite.ok) return stableBeforeWrite;
    const visibleSseqs = new Set(messages.map((message) => message.sseq));
    const visibleRecoveries = [...sourceState.recoveries.values()].filter((recovery) => visibleSseqs.has(recovery.sseq));
    const recoveredBlocks = await recoverSessionBlocks(source.sessionFile, visibleRecoveries, sourceFingerprint, options);
    if (!recoveredBlocks.ok) {
      return recoveredBlocks;
    }
    const recoveriesBySseq = new Map<number, ReplayRecovery[]>();
    for (const recovery of visibleRecoveries) {
      const entries = recoveriesBySseq.get(recovery.sseq) ?? [];
      entries.push(recovery);
      recoveriesBySseq.set(recovery.sseq, entries);
    }
    const childReceipts = new Map<string, { revisionSeq: number; targets: SessionReclaimReceiptTarget[] }>();
    const opened = SessionWriter.open(temp.sessionFile, 0, { testHooks: options?.testHooks });
    if (!opened.ok) {
      return opened;
    }
    try {
      for (let i = 0; i < messages.length; i++) {
        const cancelledBeforeRecord = cancellation(options?.signal);
        if (cancelledBeforeRecord) {
          opened.writer.close();
          return cancelledBeforeRecord;
        }
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
                return { ok: false, error: "missing source record" };
              }
              const restored = cloneJson(original);
              if (recovery.action === "drop") {
                if (recovery.blockIndex > content.length) {
                  opened.writer?.close();
                  return { ok: false, error: "stale recovery target" };
                }
                content.splice(recovery.blockIndex, 0, restored);
              } else {
                if (recovery.blockIndex >= content.length || !isRecord(content[recovery.blockIndex])) {
                  opened.writer?.close();
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
          return written;
        }
        if (i % YIELD_EVERY_RECORDS === YIELD_EVERY_RECORDS - 1) {
          await yieldToEventLoop();
          const cancelledAfterYield = cancellation(options?.signal);
          if (cancelledAfterYield) {
            opened.writer.close();
            return cancelledAfterYield;
          }
        }
      }
      let nextStorageSeq = messages.length + 1;
      const orderedChildReceipts = [...childReceipts.entries()].sort((a, b) => a[1].revisionSeq - b[1].revisionSeq);
      for (const [revisionId, group] of orderedChildReceipts) {
        const targets = group.targets.slice().sort((a, b) => a.sseq - b.sseq || b.blockIndex - a.blockIndex);
        if (nextStorageSeq > throughSeq) {
          opened.writer.close();
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
          return written;
        }
      }
      if (throughSeq >= nextStorageSeq) {
        const written = opened.writer.appendRecord({ storageSeq: throughSeq, type: "checkpoint" });
        if (!written.ok) {
          opened.writer.close();
          return written;
        }
      }
    } finally {
      opened.writer.close();
    }
    const stableAfterWrite = validateTempBundle(temp);
    if (!stableAfterWrite.ok) return stableAfterWrite;
    const copied = await copyReferencedImages(source.currentDir, temp, imageNames, options);
    if (!copied.ok) {
      return copied;
    }
    const currentSynced = fsyncDirectoryDescriptor(temp.current.fd);
    if (!currentSynced.ok) return currentSynced;
    const tempSynced = fsyncDirectoryDescriptor(temp.temp.fd);
    if (!tempSynced.ok) return tempSynced;
    const retainedBeforeInstall = retainedTempUsage(dest.projectDir);
    if (!retainedBeforeInstall.ok) return retainedBeforeInstall;
    if (retainedBeforeInstall.bytes > MAX_RETAINED_TEMP_BYTES) {
      return { ok: false, error: `retained temporary sessions exceed ${MAX_RETAINED_TEMP_BYTES} bytes` };
    }
    const installed = await installTempBundle(temp, dest.bundleDir, options);
    if (!installed.ok) return installed;
    return { ok: true, kept: messages.length };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    closeTempBundle(temp);
    retainUnboundCleanup(temp.path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
    releaseTempRetentionLock(temp);
  }
}

async function installTempBundle(
  temp: TempBundle,
  destBundle: string,
  options?: SessionOperationOptions,
): Promise<SessionResult<{ committed: true }> | { ok: false; error: string; commit: "uncertain" }> {
  const stable = validateTempBundle(temp);
  if (!stable.ok) return stable;
  const cancelledBeforeInstall = cancellation(options?.signal);
  if (cancelledBeforeInstall) return cancelledBeforeInstall;
  try {
    options?.testHooks?.beforeDestinationClaim?.(destBundle);
    mkdirSync(anchoredChildPath(temp.parent, basename(destBundle), destBundle), { recursive: false, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const destination = inspectEntry(destBundle);
      return {
        ok: false,
        error: destination?.kind === "symlink" ? "destination session bundle is a symlink" : "destination session bundle already exists",
      };
    }
    return { ok: false, error: errMsg(err) };
  }
  const claimed = openDirectoryAnchor(
    destBundle,
    "claimed destination session bundle",
    anchoredChildPath(temp.parent, basename(destBundle), destBundle),
  );
  if (!claimed.ok) return claimed;
  const committed = claimed.anchor;
  try {
    options?.testHooks?.afterDestinationClaim?.(destBundle);
    options?.testHooks?.beforeDestinationCurrentInstall?.(destBundle);
    await rename(
      anchoredChildPath(temp.temp, CURRENT_DIR, temp.currentDir),
      anchoredChildPath(committed, CURRENT_DIR, join(destBundle, CURRENT_DIR)),
    );
    temp.current.path = join(destBundle, CURRENT_DIR);
  } catch (err) {
    const cleaned = removeEmptyAppOwnedClaim(destBundle, temp.parent, committed, options);
    closeSync(committed.fd);
    if (cleaned.ok) return { ok: false, error: errMsg(err) };
    return {
      ok: false,
      error: `${errMsg(err)}; destination claim cleanup could not be proven: ${cleaned.error}`,
      commit: "uncertain",
    };
  }
  try {
    options?.testHooks?.afterDestinationRename?.(destBundle);
    if (options?.testOnlyPostRenameDelayMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, options.testOnlyPostRenameDelayMs));
    }
    // Rename is the commit point. A late cancellation cannot turn a durable
    // commit into a reported failure; disposal waits for this terminal reply.
    const destinationSynced = fsyncDirectoryDescriptor(committed.fd);
    if (!destinationSynced.ok) throw new Error(destinationSynced.error);
    options?.testHooks?.beforeDestinationParentSync?.(destBundle);
    const parentSynced = fsyncDirectoryDescriptor(temp.parent.fd);
    if (!parentSynced.ok) throw new Error(parentSynced.error);
    options?.testHooks?.beforeDestinationVerify?.(destBundle);
    const installed = validateCommittedDestination(temp, committed);
    if (!installed.ok) throw new Error(installed.error);
    return { ok: true, committed: true };
  } catch (err) {
    // Once current is installed, never recursively roll back through a
    // pathname. Keep the installed or replacement destination intact and
    // expose the commit ambiguity to the caller.
    return {
      ok: false,
      error: `${errMsg(err)}; committed destination was preserved`,
      commit: "uncertain",
    };
  } finally {
    try {
      closeSync(committed.fd);
    } catch {
      /* already closed */
    }
  }
}

export { CURRENT_DIR as SESSION_CURRENT_DIR, ACTIVE_NAME as SESSION_ACTIVE_NAME };
