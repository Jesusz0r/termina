/**
 * Session bundle primitives: budgets, paths, receipts, leaf helpers.
 *
 * Owns size budgets, bundle path shaping, reclaim-receipt validation, and
 * small shared helpers with no bundle-IO dependencies. Split from
 * agent-core/session.ts (issue #38).
 */
import { isRecord } from "../../shared/guards.ts";
import { type SessionRetentionLock } from "../../shared/session-retention-lock.ts";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";


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


export const CORE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const PART_NAME = /^part-([0-9]{6})\.jsonl$/;

export const ARCHIVE_PREFIX = "archive-";

export const BAD_PREFIX = "bad-";

export const TEMP_BUNDLE_NAME = /^t-[0-9a-f]{32}$/;

/** Durable owner marker written into a retained t-* staging sibling. */
export const RETAINED_STAGING_OWNER_NAME = ".termina-retained-staging-owner.json";

export const RETAINED_STAGING_OWNER_BYTES = 512;

export const MAX_RETAINED_TEMP_SCAN_ENTRIES = 250_000;

export const MAX_RETAINED_TEMP_ROOT_ENTRIES = MAX_RETAINED_TEMP_BUNDLES * 4;

export const MAX_RETAINED_TEMP_SCAN_DEPTH = 64;

export const MAX_RETAINED_TEMP_SCAN_PENDING = MAX_RETAINED_TEMP_SCAN_ENTRIES;

export const MAX_RETAINED_TEMP_SCAN_WORK_BYTES = 128 * 1024 * 1024;

export const MAX_EMPTY_SESSION_ADMISSION_ENTRIES = MAX_RETAINED_EMPTY_SESSION_BUNDLES * 4;

export const MAX_EMPTY_SESSION_ADMISSION_BYTES = MAX_RETAINED_EMPTY_SESSION_BUNDLES * MAX_SESSION_BUNDLE_BYTES;

export const MAX_EMPTY_SESSION_ADMISSION_WORK_BYTES = MAX_RETAINED_TEMP_SCAN_WORK_BYTES;

/** Reserve half the aggregate bound for each in-flight staging admission. */
export const RETAINED_TEMP_ADMISSION_RESERVATION_BYTES = MAX_RETAINED_TEMP_BYTES / 2;

export const ACTIVE_NAME = "session.jsonl";

export const CURRENT_DIR = "current";

const STORED_IMAGE_NAME = /^[A-Za-z0-9._-]+-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/;

export const READ_CHUNK = 64 * 1024;

export const YIELD_EVERY_BYTES = 256 * 1024;

export const YIELD_EVERY_RECORDS = 64;

export const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });


export type SessionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export type SessionFailure = { ok: false; error: string };


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
  /** Focused replay race seam, rejected outside TERMINA_CORE_TEST. */
  afterReplayRead?: (paths: readonly string[]) => void;
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
  afterDestinationReservation?: (path: string) => void;
  /** Focused first-project admission seam, rejected outside TERMINA_CORE_TEST. */
  afterSessionProjectCreated?: (path: string) => void;
  /** Focused first-empty-bundle publication seam, rejected outside TERMINA_CORE_TEST. */
  afterEmptySessionReservation?: (path: string) => void;
};


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
  /** Last-writer-wins kernel setting from `settings` records (e.g. effort). */
  effort: string | null;
  /** Last-writer-wins provider-qualified model from `settings` records. */
  model: string | null;
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

export const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const MAX_RECEIPT_TARGETS = 256;

const MAX_RECEIPT_METADATA_CHARS = 4096;


export function integerAtLeast(value: unknown, min: number): value is number {
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


export function cloneJson<T>(value: T): T {
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


export function recoveryKey(target: {
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


export function partNumber(name: string): number | null {
  const m = PART_NAME.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}


export function partFileName(n: number): string {
  return `part-${String(n).padStart(6, "0")}.jsonl`;
}


export function isSafeImageName(name: string): boolean {
  if (!STORED_IMAGE_NAME.test(name)) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name.includes("..")) return false;
  return true;
}


export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


export const UNBOUND_CLEANUP_ERROR = "session cleanup is not descriptor-bound";


export function cancellation(signal?: AbortSignal): SessionFailure | null {
  return signal?.aborted ? { ok: false, error: "session operation cancelled" } : null;
}


export function sessionBundleLimit(options?: SessionOperationOptions): SessionResult<{ limit: number }> {
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


export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}


export function inspectEntry(path: string): { kind: "file" | "dir" | "symlink" | "other"; size: number } | null {
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
