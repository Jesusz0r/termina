/**
 * Worldline manager (WORLDLINES §6.5, §6.6).
 *
 * Fork Run creates two isolated candidates from a completed run:
 * Candidate A preserves the settled source state and session; Candidate B
 * restores the run-start source state and the effective task. Pair
 * creation is all-or-nothing: any failure cancels both candidates and
 * removes every app-owned resource.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { constants as fsConstants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat as lstatPath, open as openFile, opendir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildSandboxProfile, candidateSandboxLaunch, type SandboxPaths } from "./sandbox.js";
import { coreClient } from "./core-client.js";
import {
  boundPromotionCopyFile,
  boundPromotionCreateDirectory,
  boundPromotionCreateSymlink,
  boundPromotionCopyTree,
  boundPromotionEnsureDirectory,
  boundPromotionInstallDirectory,
  boundPromotionListDirectories,
  boundPromotionOpenDirectory,
  boundPromotionPrepareDirectory,
  boundPromotionRemoveTree,
  boundPromotionTransition,
  boundPromotionWriteFile,
  boundPromotionWriteJsonFile,
  boundPromotionReadFile,
  captureRootInRepo,
  gitCommonDir,
  gitHead,
  gitTopLevel,
  readBoundPromotionJournal,
  type BoundPromotionExpectedLeaf,
  type PromotionFsIdentity,
  type SnapshotStore,
} from "./worldline-git.js";
import { EvidenceEngine, dependencyDiff, mineChangeReason, rankProfiles, type EvidenceDeps, type EvidenceRecord, type EvidenceSummary } from "./evidence.js";
import type {
  CoreSessionForkOpts,
  CoreSessionForkResult,
  PiSessionCopyIdentity,
  PiSessionDiscardResult,
  SessionForkCallOptions,
  SessionForkOpts,
  SessionForkResult,
} from "./session-fork.js";
import type { ChallengeProfile, DependencyChange, RunSummary, TimelineEvent, WorldlineChangedFile, WorldlineDetails, WorldlineState, WorldlineSummary } from "../shared/types.js";
import {
  coreSessionFile,
  parseSessionBundlePath,
  sessionBundleBytes,
  sessionBundleHasContent,
} from "../agent-core/session.js";
import { MAX_MCP_JSON_BYTES } from "../agent-core/mcp.js";
import { quoteShellArg, thinkingStartupArgs } from "../shared/terminal-control.js";
import {
  acquireSessionRetentionLock,
  releaseSessionRetentionLock,
  type SessionRetentionLock,
} from "../shared/session-retention-lock.js";

export { quoteShellArg };
export type { WorldlineState, WorldlineSummary };

interface CandidateState {
  label: "A" | "B";
  role: "reference" | "alternative" | "challenge" | "moment";
  dir: string;
  supportDir: string;
  /** Native identity of the allocated candidate root. */
  rootIdentity?: PromotionFsIdentity;
  /** Descriptor identity retained for every candidate-owned mutation. */
  rootBinding?: BoundPromotionDirectory;
  supportBinding?: BoundPromotionDirectory;
  homeBinding?: BoundPromotionDirectory;
  sessionBinding?: BoundPromotionDirectory;
  eventsBinding?: BoundPromotionDirectory;
  tmpBinding?: BoundPromotionDirectory;
  cacheBinding?: BoundPromotionDirectory;
  controlLeaf?: BoundPromotionExpectedLeaf;
  profileLeaf?: BoundPromotionExpectedLeaf;
  homeDir: string;
  sessionDir: string;
  eventsDir: string;
  tmpDir: string;
  cacheDir: string;
  profilePath: string;
  sessionFile: string | null;
  /** The shared base state for this comparison. */
  comparisonBaseStateId: string | null;
  /** The root state used for promotion. */
  promotionBaseStateId: string | null;
  /** The latest captured state of this candidate. */
  headStateId: string | null;
  /** Serializes head updates with the matching workspace state. */
  headCommit: Promise<void>;
  terminalId: string | null;
  pid: number | null;
  lstart: string | null;
  /** One-shot reopen attempt identity; never persisted in the manifest. */
  startupAttemptId?: string;
  /** In-memory startup generation paired with startupAttemptId. */
  startupGeneration?: number;
  /** The startup control operation consumed by a fresh candidate, if any. */
  startupControlOpId?: string;
  state: WorldlineState;
  version: number;
  error: string | null;
}

interface ComparisonState {
  id: string;
  dir: string;
  /** Native identity of the allocated comparison root. */
  rootIdentity?: PromotionFsIdentity;
  /** Descriptor identity retained for every comparison-owned mutation. */
  rootBinding?: BoundPromotionDirectory;
  templateDir: string;
  /** Native identity of the descriptor-bound template root. */
  templateIdentity?: PromotionFsIdentity;
  templateBinding?: BoundPromotionDirectory;
  profilesBinding?: BoundPromotionDirectory;
  sessionWorkspaceDir: string;
  sessionWorkspaceBinding?: BoundPromotionDirectory;
  markerLeaf?: BoundPromotionExpectedLeaf;
  manifestLeaf?: BoundPromotionExpectedLeaf;
  sourceRunId: string;
  /** The source Git common dir, resolved at fork time. */
  sourceGitDir: string;
  /** The primary project root, resolved at fork time. */
  primaryRoot: string;
  /** The shared comparison base commit inside the candidate repos. */
  baseCommit: string | null;
  /** The store-side shared base (R) of the lineage. */
  baseStateId: string | null;
  /** Candidates inherit one-process trust when the source was trusted. */
  inheritTrust: boolean;
  /** The model and thinking level of the source run. */
  model: string | null;
  thinkingLevel: string | null;
  /** Which engine produced the source run. */
  engine: "pi" | "core";
  /** Number of candidate launch records required before stale deletion is safe. */
  expectedCandidates: 1 | 2;
  /** A destination that may have committed after a core fork became uncertain. */
  uncertainSessionArtifacts: Array<{ path: string; error: string }>;
  /** The manifest could not be durably updated; retain the comparison. */
  manifestWriteFailed: boolean;
  /** Teardown has closed admission and is draining worker-backed forks. */
  teardownPromise: Promise<void> | null;
  /** Admission lease held while this comparison is being created. */
  uncertainAdmissionLease: UncertainComparisonAdmissionLease | null;
  removeUncertainRequested: boolean;
  /** When the pair started (ms epoch). */
  createdAt: number;
  candidates: Map<"A" | "B", CandidateState>;
  phase: "creating" | "running" | "error";
  error: string | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
}

/** One recorded run (WORLDLINES §6.5). */
export interface RunRecord {
  id: string;
  terminalId: string;
  workspaceId: string;
  startStateId: string | null;
  settledStateId: string | null;
  promptPayloadFile: string | null;
  promptEventsDir: string | null;
  promptText: string | null;
  promptEntryId: string | null;
  promptParentEntryId: string | null;
  settledEntryId: string | null;
  sessionFile: string | null;
  sessionBranchFile: string | null;
  /** Exact identity/provenance of the finalized Pi branch copy. */
  sessionBranchIdentity: PiSessionCopyIdentity | null;
  /** A core branch destination whose commit could not be proven. */
  uncertainSessionFile: string | null;
  trusted: boolean | null;
  model: string | null;
  thinkingLevel: string | null;
  replayable: boolean;
  reason: string | null;
  interrupted: boolean;
  steering: boolean;
  overlap: boolean;
  unownedEdits: number;
  startedAt: number;
  settledAt: number | null;
  trustHashes: Record<string, string> | null;
  engine?: "pi" | "core";
}

function runEngine(run: { engine?: "pi" | "core" }): "pi" | "core" {
  return run.engine === "core" ? "core" : "pi";
}

const CHALLENGE_CONSTRAINTS: Record<ChallengeProfile, string> = {
  "fewer-dependencies": "Do not add dependencies. Prefer existing dependencies and platform APIs.",
  "preserve-api": "Preserve existing public APIs and externally visible behavior unless the task explicitly requires a change.",
  "simpler-implementation": "Prefer the smallest implementation: minimize touched files, changed lines, and new abstractions.",
  "performance-first": "Prioritize runtime performance and validate performance-sensitive choices with the existing benchmark when available.",
};

function challengedPrompt(text: string, profile: ChallengeProfile): string {
  return `${text}\n\nChallenge constraint (${profile}): ${CHALLENGE_CONSTRAINTS[profile]}`;
}

function parseStorageSeq(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function isInside(parent: string, child: string): boolean {
  const rel = child.startsWith(parent) ? child.slice(parent.length) : null;
  return rel !== null && (rel.startsWith("/") || rel === "");
}

export interface PromoteSeed {
  paths: Array<{ rel: string; kind: "write" | "delete"; beforeExists: boolean }>;
  beforeDir: string;
  installedSession: string;
  primaryRoot: string;
  primaryWorkspaceId: string;
  comparisonId: string;
  label: "A" | "B";
  engine: "pi" | "core";
}

export interface WorldlineDeps {
  worldsRoot: string;
  primaryRoot: string;
  realHome: string;
  userData: string;
  primaryEventsDir: string;
  bridgePath: string;
  piBin: string;
  agentCorePath: string;
  electronExecPath: string;
  /** Candidate-only allowlisted environment, scoped to one model provider. */
  candidateEnv(provider: string | null): Record<string, string | undefined>;
  showThinking(): boolean;
  getStore(): Promise<SnapshotStore | null>;
  /** Read-only load paths for the sandboxed pi (app package + node). */
  appReadPaths(): string[];
  forkSession(opts: SessionForkOpts, callOptions?: SessionForkCallOptions): Promise<SessionForkResult>;
  forkCoreSession(opts: CoreSessionForkOpts, callOptions?: SessionForkCallOptions): Promise<CoreSessionForkResult>;
  /** Discard a proven durable core session bundle through the retention owner. */
  discardCoreSession(runId: string): Promise<{ ok: boolean; error?: string }>;
  /** Discard a finalized Pi branch only through its copied-file identity. */
  discardPiSession(sessionFile: string, identity: PiSessionCopyIdentity): Promise<PiSessionDiscardResult>;
  createCandidate(opts: {
    root: string;
    workspaceId: string;
    engine?: "pi" | "core";
    launch: { cmd: string; args: string[]; env: Record<string, string | undefined> };
    /** Install candidate routing before the PTY is allowed to spawn. */
    beforeSpawn?: (terminalId: string) => void;
    /** Cancel the spawn/read lifecycle when comparison teardown wins. */
    signal?: AbortSignal;
  }): Promise<{ terminalId: string; pid: number }>;
  /** Close one exact candidate terminal after a failed startup handshake. */
  terminateCandidate?(terminalId: string): void;
  createCandidateWorkspace(root: string, baseStateId: string | null, comparisonId: string): string;
  onUpdate(summary: WorldlineSummary): void;
  onCandidateState(root: string, stateId: string): void | Promise<void>;
  onRemoved(comparisonId: string): void;
  /** The fork preflight (WORLDLINES §4): repo, platform, disk. */
  preflight(): Promise<{ ok: boolean; reasons: string[] }>;
  /** The trust-sensitive resource hashes of the project + pi agent dir. */
  trustHashes(): Promise<Record<string, string>>;
  /** Capture a candidate head off the main thread. */
  captureHead(root: string, gitDir: string, parent: string | null): Promise<{ commit: string; tree: string }>;
  /** Capture the current primary state (details conflict status). */
  capturePrimary(): Promise<string | null>;
  /** Release a temporary state reference after a comparison operation. */
  releaseState(stateId: string): Promise<void>;
  terminalBusy(terminalId: string): boolean;
  terminalVerifying(terminalId: string): boolean;
  workspaceAt(root: string): Promise<{ id: string; generation: number; lastStateCommit: string | null } | null>;
  acquireWriteLease(workspaceId: string, requester: string, timeoutMs: number): Promise<{ ok: boolean; error?: string; generation?: number }>;
  releaseWriteLease(workspaceId: string, requester: string): void;
  flushDirtyModels(requester: string, workspaceId: string, timeoutMs?: number): Promise<{ ok: boolean }>;
  canonicalPath(absPath: string): Promise<string>;
  mineFiles(): ReadonlySet<string>;
  drainMineUpdates(): Promise<void>;
  /** Remove one recorded prompt payload through the app-owned events binding. */
  removePromptPayload?(eventsDir: string, fileName: string): Promise<void>;
  runSandboxedEvidence(
    cand: { root: string; profilePath: string; homeDir: string; tmpDir: string; profileBinding?: BoundPromotionDirectory; profileLeaf?: BoundPromotionExpectedLeaf },
    command: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ code: number; stdout: string; timedOut: boolean }>;
  sourceFilesOf(root: string): Promise<Array<{ relPath: string; content: string }>>;
  createEvidenceHome(): Promise<string>;
  /** Remove an evidence home only when its creation binding still matches. */
  removeEvidenceHome(path: string): Promise<boolean>;
  detectTestFromState(store: SnapshotStore, stateId: string): Promise<{ command: string; args: string[]; label: string } | null>;
  benchmarkConfigFrom(store: SnapshotStore, stateId: string): Promise<{
    command: string[];
    unit: string;
    direction: "lower" | "higher";
    samples: number;
    thresholdPct: number;
  } | null>;
  onEvidenceUpdate(summary: EvidenceSummary): void;
  onPromotionApply(relPaths: string[] | null): void;
  primarySessionDir(cwd: string, engine: "pi" | "core"): Promise<string>;
  installPromoted(seed: PromoteSeed): Promise<{ terminalId: string }>;
}

const RUNTIME_ALLOWLIST = ["node_modules", ".venv", "venv"];
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_BYTES = 20 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 1024 * 1024 * 1024;
const READY_TIMEOUT_MS = 90000;
/** Bound candidate cleanup when a startup hook ignores cancellation. */
const CANDIDATE_CLEANUP_TIMEOUT_MS = 2500;
const MAX_PI_RESOURCE_BYTES = 200 * 1024 * 1024;
const MAX_WORLDLINE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RUNS_PER_TERMINAL = 20;
const MAX_RETAINED_RUNS = 200;
const MAX_IGNORED_FILES = 5000;
const MAX_IGNORED_BYTES = 200 * 1024 * 1024;
/** Retained promotion evidence is never auto-deleted; admission is bounded. */
const MAX_PROMOTION_JOURNALS = 32;
const MAX_PROMOTION_JOURNAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PROMOTION_JOURNAL_OVERHEAD_BYTES = 32 * 1024 * 1024;
const MAX_PROMOTION_OPERATION_BYTES = MAX_TEMPLATE_BYTES * 2 + MAX_SESSION_BYTES + MAX_PROMOTION_JOURNAL_OVERHEAD_BYTES;
const MAX_PROMOTION_JOURNAL_ROOT_ENTRIES = MAX_PROMOTION_JOURNALS * 4;
/** Durable, root-scoped admission state for promotion journals. */
const PROMOTION_JOURNAL_USAGE_LEDGER = ".termina-promotion-journal-usage.json";
const PROMOTION_JOURNAL_USAGE_LEDGER_VERSION = 1;
/** Uncertain comparisons are recovery evidence; never auto-delete at this bound. */
const MAX_UNCERTAIN_COMPARISONS = 128;
const MAX_UNCERTAIN_COMPARISON_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_UNCERTAIN_COMPARISON_ENTRIES = 250_000;
/** Bound startup enumeration/accounting for adjacent stale world roots. */
const MAX_STALE_SWEEP_BYTES = MAX_UNCERTAIN_COMPARISON_BYTES;
/** Minimum durable session envelope reserved for every creator transaction. */
const MIN_UNCERTAIN_COMPARISON_RESERVATION_BYTES = MAX_SESSION_BYTES;
/** Atomic root-scoped usage ledger for uncertain comparison evidence. */
export const UNCERTAIN_COMPARISON_USAGE_LEDGER = ".termina-uncertain-comparison-usage.json";
const UNCERTAIN_COMPARISON_USAGE_LEDGER_VERSION = 1;
const MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES = MAX_UNCERTAIN_COMPARISONS * 4;
const MAX_PROMOTION_SCAN_ENTRIES = MAX_UNCERTAIN_COMPARISON_ENTRIES;
const MAX_PROMOTION_SCAN_DEPTH = 64;
const MAX_PROMOTION_SCAN_PENDING = MAX_PROMOTION_SCAN_ENTRIES;
const MAX_PROMOTION_SCAN_WORK_BYTES = 128 * 1024 * 1024;
const MAX_UNCERTAIN_SCAN_DEPTH = 64;
const MAX_UNCERTAIN_SCAN_PENDING = MAX_UNCERTAIN_COMPARISON_ENTRIES;
const MAX_UNCERTAIN_SCAN_WORK_BYTES = 128 * 1024 * 1024;

/** The app-owned marker that proves a worlds dir belongs to the app. */
const MARKER = ".termina-world";

type ComparisonManifestStatus = "creating" | "complete" | "uncertain";
type ComparisonManifestCandidate = { pid: number | null; lstart: string | null; paths: string[] };
type ComparisonManifest = {
  id: string;
  sourceRunId: string;
  createdAt: number;
  status: ComparisonManifestStatus;
  expectedCandidates: 1 | 2;
  candidates: Record<string, ComparisonManifestCandidate>;
  uncertainSessionArtifacts: Array<{ path: string; error: string }>;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Parse only a complete manifest shape; null is deliberately fail-closed. */
function parseComparisonManifest(value: unknown): ComparisonManifest | null {
  const record = objectRecord(value);
  if (!record || typeof record.id !== "string" || record.id.length === 0 || typeof record.sourceRunId !== "string" || record.sourceRunId.length === 0) return null;
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || record.createdAt <= 0) return null;
  if (record.status !== "creating" && record.status !== "complete" && record.status !== "uncertain") return null;
  if (record.expectedCandidates !== 1 && record.expectedCandidates !== 2) return null;
  const candidatesRecord = objectRecord(record.candidates);
  if (!candidatesRecord) return null;
  const candidates: Record<string, ComparisonManifestCandidate> = {};
  for (const [label, rawCandidate] of Object.entries(candidatesRecord)) {
    if (label !== "A" && label !== "B") return null;
    const candidate = objectRecord(rawCandidate);
    if (!candidate || (typeof candidate.pid !== "number" && candidate.pid !== null) || (typeof candidate.pid === "number" && (!Number.isInteger(candidate.pid) || candidate.pid < 0))) return null;
    if (typeof candidate.lstart !== "string" && candidate.lstart !== null) return null;
    if (!Array.isArray(candidate.paths) || candidate.paths.length === 0 || candidate.paths.some((path) => typeof path !== "string" || !isAbsolute(path))) return null;
    candidates[label] = { pid: candidate.pid as number | null, lstart: candidate.lstart as string | null, paths: [...candidate.paths] as string[] };
  }
  if (Object.keys(candidates).length > record.expectedCandidates) return null;
  if (!Array.isArray(record.uncertainSessionArtifacts)) return null;
  const uncertainSessionArtifacts: Array<{ path: string; error: string }> = [];
  for (const rawArtifact of record.uncertainSessionArtifacts) {
    const artifact = objectRecord(rawArtifact);
    if (!artifact || typeof artifact.path !== "string" || !isAbsolute(artifact.path) || artifact.path.length === 0 || typeof artifact.error !== "string" || artifact.error.length === 0) return null;
    uncertainSessionArtifacts.push({ path: artifact.path, error: artifact.error });
  }
  if (record.status === "complete" && (Object.keys(candidates).length !== record.expectedCandidates || uncertainSessionArtifacts.length > 0)) return null;
  if (record.status === "uncertain" && uncertainSessionArtifacts.length === 0) return null;
  return {
    id: record.id,
    sourceRunId: record.sourceRunId,
    createdAt: record.createdAt,
    status: record.status,
    expectedCandidates: record.expectedCandidates,
    candidates,
    uncertainSessionArtifacts,
  };
}

function comparisonManifestFor(cmp: ComparisonState, status: ComparisonManifestStatus = "creating"): ComparisonManifest {
  const candidates: Record<string, ComparisonManifestCandidate> = {};
  for (const [label, cand] of cmp.candidates) {
    candidates[label] = { pid: cand.pid, lstart: cand.lstart, paths: [cand.dir, cand.supportDir] };
  }
  return {
    id: cmp.id,
    sourceRunId: cmp.sourceRunId,
    createdAt: cmp.createdAt,
    status,
    expectedCandidates: cmp.expectedCandidates,
    candidates,
    uncertainSessionArtifacts: [...cmp.uncertainSessionArtifacts],
  };
}

function readComparisonManifest(dir: string): ComparisonManifest | null {
  try {
    return parseComparisonManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  } catch {
    return null;
  }
}

type UncertainComparisonMeasurement =
  | { ok: true; bytes: number; entries: number; proof: string }
  | { ok: false; error: string };

type UncertainComparisonUsage = { count: number; bytes: number; entries: number };

type UncertainComparisonIdentity = {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
};

type UncertainComparisonLedgerEntry = {
  name: string;
  identity: UncertainComparisonIdentity;
  counted: boolean;
  bytes: number;
  entries: number;
  /** Metadata Merkle proof for every owned node, including nested children. */
  proof: string;
};

type UncertainComparisonLedgerReservation = {
  token: string;
  pid: number;
  bytes: number;
};

type UncertainComparisonUsageLedger = {
  version: 1;
  root: { dev: string; ino: string };
  entries: UncertainComparisonLedgerEntry[];
  reservations: UncertainComparisonLedgerReservation[];
  usage: UncertainComparisonUsage;
};

type UncertainComparisonAdmissionLease = {
  release(): void;
  bind?(comparisonId: string): void;
};

/** Count every entry in an uncertain comparison tree, including files that
 * are not part of the normal candidate/session schema. Symlinks, special
 * entries, unreadable paths, and arithmetic overflow fail closed. */
async function measureUncertainComparisonTree(root: string): Promise<UncertainComparisonMeasurement> {
  const digest = createHash("sha256");
  const initialWorkBytes = Buffer.byteLength(root, "utf8") + 1;
  if (initialWorkBytes > MAX_UNCERTAIN_SCAN_WORK_BYTES) {
    return { ok: false, error: "uncertain comparison evidence path exceeds its bounded work budget; explicitly discard or export it before retrying" };
  }
  const pending: Array<{ path: string; relative: string; depth: number; workBytes: number }> = [{ path: root, relative: ".", depth: 0, workBytes: initialWorkBytes }];
  let pendingWorkBytes = initialWorkBytes;
  let entries = 0;
  let bytes = 0n;
  const limit = BigInt(MAX_UNCERTAIN_COMPARISON_BYTES);
  while (pending.length > 0) {
    const current = pending.pop()!;
    pendingWorkBytes -= current.workBytes;
    if (current.depth > MAX_UNCERTAIN_SCAN_DEPTH) {
      return { ok: false, error: "uncertain comparison evidence exceeds its depth bound; explicitly discard or export it before retrying" };
    }
    let info;
    try {
      info = await lstatPath(current.path, { bigint: true });
    } catch {
      return { ok: false, error: "uncertain comparison evidence is unreadable or partial; explicitly discard or export it before retrying" };
    }
    entries++;
    if (entries > MAX_UNCERTAIN_COMPARISON_ENTRIES) {
      return { ok: false, error: "uncertain comparison evidence contains too many entries; explicitly discard or export it before retrying" };
    }
    if (info.isSymbolicLink()) {
      return { ok: false, error: "uncertain comparison evidence contains a symbolic link; explicitly discard or export it before retrying" };
    }
    if (!info.isDirectory() && !info.isFile()) {
      return { ok: false, error: "uncertain comparison evidence contains an unsupported entry; explicitly discard or export it before retrying" };
    }
    bytes += info.size;
    if (bytes > limit) {
      return { ok: false, error: "uncertain comparison evidence exceeds its 4 GB bound; explicitly discard or export it before retrying" };
    }
    digest.update(`${current.relative}\0${info.isDirectory() ? "d" : "f"}\0${JSON.stringify(uncertainIdentityOf(info))}\n`);
    if (!info.isDirectory()) {
      if ((entries & 63) === 0) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      continue;
    }
    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      return { ok: false, error: "uncertain comparison evidence is unreadable or partial; explicitly discard or export it before retrying" };
    }
    try {
      const children: string[] = [];
      let childNameBytes = 0;
      for await (const child of directory) {
        const nameBytes = Buffer.byteLength(child.name, "utf8");
        if (childNameBytes > MAX_UNCERTAIN_SCAN_WORK_BYTES - nameBytes) {
          return { ok: false, error: "uncertain comparison evidence scan exceeded its bounded work budget; explicitly discard or export it before retrying" };
        }
        childNameBytes += nameBytes;
        children.push(child.name);
        if (children.length > MAX_UNCERTAIN_COMPARISON_ENTRIES) {
          return { ok: false, error: "uncertain comparison evidence contains too many entries; explicitly discard or export it before retrying" };
        }
      }
      children.sort().reverse();
      for (const name of children) {
        if (pending.length >= MAX_UNCERTAIN_SCAN_PENDING) {
          return { ok: false, error: "uncertain comparison evidence contains too many pending entries; explicitly discard or export it before retrying" };
        }
        const childPath = join(current.path, name);
        const childRelative = current.relative === "." ? name : `${current.relative}/${name}`;
        const workBytes = Buffer.byteLength(childPath, "utf8") + Buffer.byteLength(childRelative, "utf8");
        if (workBytes > MAX_UNCERTAIN_SCAN_WORK_BYTES || pendingWorkBytes > MAX_UNCERTAIN_SCAN_WORK_BYTES - workBytes) {
          return { ok: false, error: "uncertain comparison evidence scan exceeded its bounded work budget; explicitly discard or export it before retrying" };
        }
        pending.push({
          path: childPath,
          relative: childRelative,
          depth: current.depth + 1,
          workBytes,
        });
        pendingWorkBytes += workBytes;
      }
    } catch {
      return { ok: false, error: "uncertain comparison evidence is unreadable or partial; explicitly discard or export it before retrying" };
    } finally {
      try {
        await directory.close();
      } catch {
        /* iterator close is best effort */
      }
    }
  }
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "uncertain comparison evidence byte count overflow; explicitly discard or export it before retrying" };
  }
  return { ok: true, bytes: Number(bytes), entries, proof: digest.digest("hex") };
}

async function boundedWorldlineEntries(path: string, limit: number, message: string): Promise<string[]> {
  let directory;
  try {
    directory = await opendir(path);
  } catch {
    throw new Error(message);
  }
  const names: string[] = [];
  let nameBytes = 0;
  try {
    for await (const entry of directory) {
      const addedNameBytes = Buffer.byteLength(entry.name, "utf8");
      if (nameBytes > MAX_PROMOTION_SCAN_WORK_BYTES - addedNameBytes) throw new Error(message);
      nameBytes += addedNameBytes;
      names.push(entry.name);
      if (names.length > limit) throw new Error(message);
      if ((names.length & 63) === 0) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    }
    return names;
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error;
    throw new Error(message);
  } finally {
    try {
      await directory.close();
    } catch {
      /* iterator close is best effort */
    }
  }
}

function isSafeComparisonId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function uncertainIdentityOf(info: BigIntStats): UncertainComparisonIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}

function sameUncertainIdentity(left: UncertainComparisonIdentity, right: UncertainComparisonIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function uncertainComparisonRootNames(root: string): Promise<string[]> {
  const names = await boundedWorldlineEntries(
    root,
    MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES,
    `uncertain comparison evidence root contains too many entries (${MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES}); explicitly discard retained recovery evidence before retrying`,
  );
  const marked: string[] = [];
  for (const name of names) {
    const dir = join(root, name);
    let info: BigIntStats;
    try {
      info = await lstatPath(dir, { bigint: true });
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      throw new Error("uncertain comparison evidence root is unreadable; explicitly discard retained recovery evidence before retrying");
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    try {
      await lstatPath(join(dir, MARKER), { bigint: true });
      marked.push(name);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw new Error("uncertain comparison marker is unreadable; explicitly discard retained recovery evidence before retrying");
    }
  }
  return marked.sort();
}

function uncertainComparisonIsSafe(root: string, name: string, safeIds: ReadonlySet<string>): boolean {
  if (!safeIds.has(name)) return false;
  const dir = join(root, name);
  let marker;
  try {
    marker = lstatSync(join(dir, MARKER));
  } catch {
    return false;
  }
  if (!marker.isFile() || marker.isSymbolicLink()) return false;
  const manifest = readComparisonManifest(dir);
  return manifest !== null && manifest.status !== "uncertain" && manifest.uncertainSessionArtifacts.length === 0;
}

async function buildUncertainComparisonLedgerEntry(root: string, name: string, safeIds: ReadonlySet<string>): Promise<UncertainComparisonLedgerEntry | null> {
  let info: BigIntStats;
  try {
    info = await lstatPath(join(root, name), { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new Error("uncertain comparison evidence is unreadable or partial; explicitly discard retained recovery evidence before retrying");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  try {
    await lstatPath(join(root, name, MARKER), { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new Error("uncertain comparison marker is unreadable; explicitly discard retained recovery evidence before retrying");
  }
  if (uncertainComparisonIsSafe(root, name, safeIds)) {
    return { name, identity: uncertainIdentityOf(info), counted: false, bytes: 0, entries: 0, proof: "0".repeat(64) };
  }
  const measured = await measureUncertainComparisonTree(join(root, name));
  if (!measured.ok) throw new Error(measured.error);
  return { name, identity: uncertainIdentityOf(info), counted: true, bytes: measured.bytes, entries: measured.entries, proof: measured.proof };
}

function uncertainComparisonUsageFromEntries(entries: readonly UncertainComparisonLedgerEntry[]): UncertainComparisonUsage {
  let count = 0;
  let bytes = 0;
  let entryCount = 0;
  for (const entry of entries) {
    if (!entry.counted) continue;
    count++;
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || bytes > MAX_UNCERTAIN_COMPARISON_BYTES - entry.bytes) {
      throw new Error("uncertain comparison evidence exceeds its 4 GB bound; explicitly discard retained recovery evidence before retrying");
    }
    bytes += entry.bytes;
    if (!Number.isSafeInteger(entry.entries) || entry.entries < 0 || entryCount > MAX_UNCERTAIN_COMPARISON_ENTRIES - entry.entries) {
      throw new Error("uncertain comparison evidence contains too many entries; explicitly discard retained recovery evidence before retrying");
    }
    entryCount += entry.entries;
  }
  if (count > MAX_UNCERTAIN_COMPARISONS) {
    throw new Error(`uncertain comparisons are at capacity (${MAX_UNCERTAIN_COMPARISONS}); explicitly discard retained recovery evidence before retrying`);
  }
  return { count, bytes, entries: entryCount };
}

function validUncertainLedgerIdentity(value: unknown): value is UncertainComparisonIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => typeof record[key] === "string" && /^\d+$/.test(record[key] as string));
}

function validUncertainLedgerEntry(value: unknown): value is UncertainComparisonLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string"
    || !isSafeComparisonId(record.name)
    || !validUncertainLedgerIdentity(record.identity)
    || typeof record.counted !== "boolean"
    || typeof record.bytes !== "number"
    || !Number.isSafeInteger(record.bytes)
    || record.bytes < 0
    || record.bytes > MAX_UNCERTAIN_COMPARISON_BYTES
    || typeof record.entries !== "number"
    || !Number.isSafeInteger(record.entries)
    || record.entries < 0
    || record.entries > MAX_UNCERTAIN_COMPARISON_ENTRIES
    || typeof record.proof !== "string"
    || !/^[0-9a-f]{64}$/.test(record.proof)) return false;
  return record.counted
    ? (record.bytes > 0 || record.entries > 0)
    : record.bytes === 0 && record.entries === 0;
}

function validUncertainLedgerReservation(value: unknown): value is UncertainComparisonLedgerReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.token === "string"
    && record.token.length > 0
    && record.token.length <= 128
    && typeof record.pid === "number"
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.bytes === "number"
    && Number.isSafeInteger(record.bytes)
    && record.bytes >= 0
    && record.bytes <= MAX_UNCERTAIN_COMPARISON_BYTES;
}

function validUncertainUsage(value: unknown): value is UncertainComparisonUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.count === "number" && Number.isSafeInteger(record.count) && record.count >= 0 && record.count <= MAX_UNCERTAIN_COMPARISONS
    && typeof record.bytes === "number" && Number.isSafeInteger(record.bytes) && record.bytes >= 0 && record.bytes <= MAX_UNCERTAIN_COMPARISON_BYTES
    && typeof record.entries === "number" && Number.isSafeInteger(record.entries) && record.entries >= 0 && record.entries <= MAX_UNCERTAIN_COMPARISON_ENTRIES;
}

async function writeUncertainComparisonUsageLedger(root: BoundPromotionDirectory, ledger: UncertainComparisonUsageLedger): Promise<void> {
  await boundPromotionWriteJsonFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: [UNCERTAIN_COMPARISON_USAGE_LEDGER],
    parentIdentity: promotionIdentityOf(root),
    value: ledger,
    maxBytes: 8 * 1024 * 1024,
    mode: 0o600,
  });
}

async function readUncertainComparisonUsageLedger(root: string, safeIds: ReadonlySet<string>): Promise<UncertainComparisonUsageLedger | null> {
  const path = join(root, UNCERTAIN_COMPARISON_USAGE_LEDGER);
  let info: BigIntStats;
  try {
    info = await lstatPath(path, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    return null;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8n * 1024n * 1024n) return null;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== UNCERTAIN_COMPARISON_USAGE_LEDGER_VERSION
    || !record.root || typeof record.root !== "object" || Array.isArray(record.root)
    || typeof (record.root as Record<string, unknown>).dev !== "string"
    || !/^\d+$/.test((record.root as Record<string, unknown>).dev as string)
    || typeof (record.root as Record<string, unknown>).ino !== "string"
    || !/^\d+$/.test((record.root as Record<string, unknown>).ino as string)
    || !Array.isArray(record.entries)
    || record.entries.length > MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES
    || !record.entries.every(validUncertainLedgerEntry)
    || !Array.isArray(record.reservations)
    || record.reservations.length > 1
    || !record.reservations.every(validUncertainLedgerReservation)
    || record.reservations.length !== 0
    || !validUncertainUsage(record.usage)) return null;
  const entries = record.entries as UncertainComparisonLedgerEntry[];
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) return null;
  let usage: UncertainComparisonUsage;
  try {
    usage = uncertainComparisonUsageFromEntries(entries);
  } catch {
    return null;
  }
  if (JSON.stringify(usage) !== JSON.stringify(record.usage)) return null;
  const rootInfo = await lstatPath(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null;
  const rootRecord = record.root as Record<string, unknown>;
  if (String(rootInfo.dev) !== rootRecord.dev || String(rootInfo.ino) !== rootRecord.ino) return null;
  const markedNames = await uncertainComparisonRootNames(root);
  if (JSON.stringify(markedNames) !== JSON.stringify(entries.map((entry) => entry.name).sort())) return null;
  for (const entry of entries) {
    let current: BigIntStats;
    try {
      current = await lstatPath(join(root, entry.name), { bigint: true });
    } catch {
      return null;
    }
    const safe = uncertainComparisonIsSafe(root, entry.name, safeIds);
    if (entry.counted !== !safe) return null;
    if (!entry.counted) {
      if (entry.proof !== "0".repeat(64)) return null;
      continue;
    }
    if (!sameUncertainIdentity(uncertainIdentityOf(current), entry.identity)) return null;
    const measured = await measureUncertainComparisonTree(join(root, entry.name));
    if (!measured.ok || measured.bytes !== entry.bytes || measured.entries !== entry.entries || measured.proof !== entry.proof) return null;
  }
  return {
    version: 1,
    root: { dev: rootRecord.dev as string, ino: rootRecord.ino as string },
    entries,
    reservations: [],
    usage,
  };
}

async function buildUncertainComparisonUsageLedger(root: string, safeIds: ReadonlySet<string>, rootBinding: BoundPromotionDirectory, persist = true): Promise<UncertainComparisonUsageLedger> {
  const rootInfo = await lstatPath(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("uncertain comparison evidence root is not an owned directory");
  const names = await uncertainComparisonRootNames(root);
  const entries: UncertainComparisonLedgerEntry[] = [];
  for (const name of names) {
    const entry = await buildUncertainComparisonLedgerEntry(root, name, safeIds);
    if (entry) entries.push(entry);
  }
  const usage = uncertainComparisonUsageFromEntries(entries);
  const ledger: UncertainComparisonUsageLedger = {
    version: 1,
    root: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
    entries,
    reservations: [],
    usage,
  };
  if (persist) await writeUncertainComparisonUsageLedger(rootBinding, ledger);
  return ledger;
}

async function loadUncertainComparisonUsageLedger(
  root: string,
  safeIds: ReadonlySet<string>,
  rootBinding: BoundPromotionDirectory,
  options: { persist?: boolean } = {},
): Promise<UncertainComparisonUsageLedger> {
  const existing = await readUncertainComparisonUsageLedger(root, safeIds);
  return existing ?? buildUncertainComparisonUsageLedger(root, safeIds, rootBinding, options.persist !== false);
}

async function uncertainLedgerFileIdentity(root: string): Promise<UncertainComparisonIdentity | null> {
  try {
    return uncertainIdentityOf(await lstatPath(join(root, UNCERTAIN_COMPARISON_USAGE_LEDGER), { bigint: true }));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

function sameUncertainLedgerFileIdentity(left: UncertainComparisonIdentity | null, right: UncertainComparisonIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  return sameUncertainIdentity(left, right);
}

type UncertainComparisonAdmissionOwnerLease = {
  release(): void;
  bind?(comparisonId: string): void;
};

type UncertainComparisonAdmissionOwnerResult =
  | { ok: true; lease: UncertainComparisonAdmissionOwnerLease }
  | { ok: false; error: string };

type UncertainComparisonParticipant = () => ReadonlySet<string>;

/**
 * One admission owner for one worlds root. The queue is shared by every
 * WorldlineManager in this process and the durable generation lock extends
 * the same transaction across a second process. A manager contributes only
 * its known live, uncertainty-free comparison ids; every other marked tree,
 * including an orphan or malformed manifest, remains accounted fail-closed.
 */
class UncertainComparisonAdmissionOwner {
  private queueTail: Promise<void> = Promise.resolve();
  private participants = new Set<UncertainComparisonParticipant>();

  constructor(private rootBinding: BoundPromotionDirectory) {}

  register(participant: UncertainComparisonParticipant): () => void {
    this.participants.add(participant);
    return () => this.participants.delete(participant);
  }

  private safeIds(): Set<string> {
    const safeIds = new Set<string>();
    for (const participant of this.participants) {
      for (const id of participant()) safeIds.add(id);
    }
    return safeIds;
  }

  async acquire(isClosing: () => boolean): Promise<UncertainComparisonAdmissionOwnerResult> {
    const previous = this.queueTail;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    this.queueTail = previous.then(() => gate, () => gate);
    await previous;
    const finishWithoutLease = () => releaseGate();
    if (isClosing()) {
      finishWithoutLease();
      return { ok: false, error: "worldline manager disposed" };
    }
    let lock: SessionRetentionLock;
    let rootBinding: BoundPromotionDirectory;
    let preparedLedger: UncertainComparisonUsageLedger;
    let preparedFileIdentity: UncertainComparisonIdentity | null;
    try {
      rootBinding = await refreshBoundPromotionDirectory(this.rootBinding);
      this.rootBinding = rootBinding;
      const safeIds = this.safeIds();
      // Rebuild/prove outside the global lock. If another process commits
      // while this work is in flight, the ledger file identity check below
      // selects its already-durable result instead of rescanning under lock.
      preparedFileIdentity = await uncertainLedgerFileIdentity(rootBinding.path);
      preparedLedger = await loadUncertainComparisonUsageLedger(rootBinding.path, safeIds, rootBinding, { persist: false });
    } catch (error) {
      finishWithoutLease();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      // The lock is held until the returned lease is released. No second
      // manager/process can publish against a stale root binding.
      lock = acquireSessionRetentionLock(rootBinding.path);
      if (String(lock.rootIdentity.dev) !== rootBinding.dev || String(lock.rootIdentity.ino) !== rootBinding.ino) {
        throw new Error("uncertain comparison worlds root identity changed before admission");
      }
    } catch (error) {
      finishWithoutLease();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    let held = true;
    const releaseLock = () => {
      if (!held) return;
      held = false;
      releaseSessionRetentionLock(lock);
    };
    try {
      const currentFileIdentity = await uncertainLedgerFileIdentity(rootBinding.path);
      const ledger = sameUncertainLedgerFileIdentity(preparedFileIdentity, currentFileIdentity)
        ? preparedLedger
        : await loadUncertainComparisonUsageLedger(rootBinding.path, this.safeIds(), rootBinding);
      const usage = ledger.usage;
      if (usage.count >= MAX_UNCERTAIN_COMPARISONS) {
        releaseLock();
        finishWithoutLease();
        return { ok: false, error: `uncertain comparisons are at capacity (${MAX_UNCERTAIN_COMPARISONS}); explicitly discard retained recovery evidence before retrying` };
      }
      if (usage.bytes > MAX_UNCERTAIN_COMPARISON_BYTES - MIN_UNCERTAIN_COMPARISON_RESERVATION_BYTES) {
        releaseLock();
        finishWithoutLease();
        return { ok: false, error: "uncertain comparison evidence exceeds its 4 GB bound; explicitly discard retained recovery evidence before retrying" };
      }
      const token = randomUUID();
      const reservation: UncertainComparisonLedgerReservation = {
        token,
        pid: process.pid,
        bytes: MIN_UNCERTAIN_COMPARISON_RESERVATION_BYTES,
      };
      const reservedLedger: UncertainComparisonUsageLedger = {
        ...ledger,
        reservations: [reservation],
      };
      await writeUncertainComparisonUsageLedger(rootBinding, reservedLedger);
      let boundComparisonId: string | null = null;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        void this.reconcileRelease(rootBinding, ledger, reservation, () => boundComparisonId, this.safeIds())
          .catch(() => undefined)
          .finally(() => {
            releaseLock();
            finishWithoutLease();
          });
      };
      return {
        ok: true,
        lease: {
          bind: (comparisonId: string) => {
            if (!released && isSafeComparisonId(comparisonId)) boundComparisonId = comparisonId;
          },
          release,
        },
      };
    } catch (error) {
      releaseLock();
      finishWithoutLease();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async reconcileRelease(
    initialRootBinding: BoundPromotionDirectory,
    base: UncertainComparisonUsageLedger,
    reservation: UncertainComparisonLedgerReservation,
    boundId: () => string | null,
    safeIds: ReadonlySet<string>,
  ): Promise<void> {
    const rootBinding = await refreshBoundPromotionDirectory(initialRootBinding);
    this.rootBinding = rootBinding;
    const root = rootBinding.path;
    const names = await uncertainComparisonRootNames(root);
    const entriesByName = new Map(base.entries.map((entry) => [entry.name, entry]));
    const id = boundId();
    // A lease that is not bound to a manager-created comparison is the
    // low-level recovery seam used during crash/ABA checks. Re-measure every
    // existing uncertain tree there so out-of-band evidence changes cannot be
    // hidden behind a shallow directory identity. Normal creators bind their
    // newly allocated id; only that new tree is measured at release.
    const rescanExisting = id === null;
    if (id !== null) {
      const entry = await buildUncertainComparisonLedgerEntry(root, id, safeIds);
      if (entry) entriesByName.set(id, entry);
    }
    for (const name of names) {
      const existing = entriesByName.get(name);
      if (!existing) {
        const entry = await buildUncertainComparisonLedgerEntry(root, name, safeIds);
        if (entry) entriesByName.set(name, entry);
        continue;
      }
      if (name === id) continue;
      let current: BigIntStats;
      try {
        current = await lstatPath(join(root, name), { bigint: true });
      } catch {
        entriesByName.delete(name);
        continue;
      }
      const safe = uncertainComparisonIsSafe(root, name, safeIds);
      if (safe) {
        entriesByName.set(name, { name, identity: uncertainIdentityOf(current), counted: false, bytes: 0, entries: 0, proof: "0".repeat(64) });
      } else if (rescanExisting || !existing.counted || !sameUncertainIdentity(uncertainIdentityOf(current), existing.identity)) {
        const entry = await buildUncertainComparisonLedgerEntry(root, name, safeIds);
        if (entry) entriesByName.set(name, entry);
        else entriesByName.delete(name);
      }
    }
    for (const name of [...entriesByName.keys()]) {
      if (!names.includes(name)) entriesByName.delete(name);
    }
    const entries = [...entriesByName.values()].sort((left, right) => left.name.localeCompare(right.name));
    const next: UncertainComparisonUsageLedger = {
      version: 1,
      root: base.root,
      entries,
      reservations: [],
      usage: uncertainComparisonUsageFromEntries(entries),
    };
    // The reservation is intentionally consumed only after the committed
    // comparison has been reconciled. If this write fails, the old durable
    // reservation remains and the next admission rebuilds fail-closed.
    void reservation;
    await writeUncertainComparisonUsageLedger(rootBinding, next);
  }

  async drain(): Promise<void> {
    await this.queueTail;
  }
}

const uncertainComparisonAdmissionOwners = new Map<string, UncertainComparisonAdmissionOwner>();

function uncertainComparisonAdmissionOwnerFor(rootBinding: BoundPromotionDirectory): UncertainComparisonAdmissionOwner {
  const root = realpathSync(resolve(rootBinding.path));
  let owner = uncertainComparisonAdmissionOwners.get(root);
  if (!owner) {
    owner = new UncertainComparisonAdmissionOwner(rootBinding);
    uncertainComparisonAdmissionOwners.set(root, owner);
  }
  return owner;
}

/** The logical size of a directory tree (`du`, in a child process). */
export async function dirBytes(dir: string): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn("du", ["-sk", dir], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let overflow = false;
    child.stdout.on("data", (data: Buffer) => {
      if (out.length < 128) out += data.toString("utf8").slice(0, 128 - out.length);
      else overflow = true;
    });
    child.on("error", () => resolvePromise(Number.POSITIVE_INFINITY));
    child.on("close", (code) => {
      const m = /^(\d+)/.exec(out.trim());
      resolvePromise(code === 0 && !overflow && m ? Number(m[1]) * 1024 : Number.POSITIVE_INFINITY);
    });
  });
}

type PromotionRetentionUsage = { journalCount: number; bytes: bigint };

async function measurePromotionTreeBytes(path: string, limit: bigint): Promise<bigint> {
  let bytes = 0n;
  let visited = 0;
  const initialWorkBytes = Buffer.byteLength(path, "utf8");
  if (initialWorkBytes > MAX_PROMOTION_SCAN_WORK_BYTES) throw new Error("promotion journal retention scan path exceeds its bounded work budget");
  const pending: Array<{ path: string; depth: number; workBytes: number }> = [{ path, depth: 0, workBytes: initialWorkBytes }];
  let pendingWorkBytes = initialWorkBytes;
  while (pending.length > 0 && bytes < limit) {
    const current = pending.pop()!;
    pendingWorkBytes -= current.workBytes;
    if (current.depth > MAX_PROMOTION_SCAN_DEPTH) throw new Error(`promotion journal retention scan exceeded its ${MAX_PROMOTION_SCAN_DEPTH}-level depth bound`);
    visited++;
    if (visited > MAX_PROMOTION_SCAN_ENTRIES) throw new Error(`promotion journal retention scan exceeded its ${MAX_PROMOTION_SCAN_ENTRIES}-entry bound`);
    const info = await lstatPath(current.path, { bigint: true });
    bytes = bytes >= limit - info.size ? limit : bytes + info.size;
    if (info.isSymbolicLink() || !info.isDirectory() || bytes >= limit) continue;
    let directory: Awaited<ReturnType<typeof opendir>>;
    try {
      directory = await opendir(current.path);
    } catch (error) {
      throw new Error(`promotion journal retention scan could not open a child directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      for await (const entry of directory) {
        const childPath = join(current.path, entry.name);
        const workBytes = Buffer.byteLength(childPath, "utf8");
        if (workBytes > MAX_PROMOTION_SCAN_WORK_BYTES || pendingWorkBytes > MAX_PROMOTION_SCAN_WORK_BYTES - workBytes) {
          throw new Error("promotion journal retention scan exceeded its bounded work budget");
        }
        if (pending.length >= MAX_PROMOTION_SCAN_PENDING) {
          throw new Error(`promotion journal retention scan exceeded its ${MAX_PROMOTION_SCAN_PENDING}-entry pending bound`);
        }
        pending.push({ path: childPath, depth: current.depth + 1, workBytes });
        pendingWorkBytes += workBytes;
      }
    } finally {
      try {
        await directory.close();
      } catch {
        /* iterator close is best effort */
      }
    }
  }
  return bytes;
}

/**
 * Measure app-owned promotion evidence without following any symlink. This is
 * admission accounting only: no unresolved journal is ever removed here.
 * Once the byte ceiling is crossed, the scan saturates because the caller
 * already has to fail closed.
 */
async function measurePromotionRetention(worldsRoot: string): Promise<PromotionRetentionUsage> {
  const root = resolve(worldsRoot, "promotion-journal");
  let rootInfo;
  try {
    rootInfo = await lstatPath(root, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { journalCount: 0, bytes: 0n };
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("promotion journal root is not an owned directory");

  const limit = BigInt(MAX_PROMOTION_JOURNAL_BYTES + MAX_PROMOTION_OPERATION_BYTES);
  let bytes = rootInfo.size;
  const entries = await boundedWorldlineEntries(
    root,
    MAX_PROMOTION_JOURNAL_ROOT_ENTRIES,
    `promotion journal root contains too many entries (${MAX_PROMOTION_JOURNAL_ROOT_ENTRIES})`,
  );
  for (const name of entries) {
    const child = join(root, name);
    const remaining = limit > bytes ? limit - bytes : 0n;
    bytes += await measurePromotionTreeBytes(child, remaining);
    if (bytes >= limit) break;
  }
  return { journalCount: entries.length, bytes };
}

type PromotionJournalUsageLedger = {
  version: 1;
  root: { dev: string; ino: string };
  usage: { journalCount: number; bytes: string };
  reservation: { token: string; pid: number; journalCount: number; bytes: string } | null;
};

type PromotionJournalAdmissionLease = {
  release(): Promise<void>;
};

type PromotionJournalAdmissionResult =
  | { ok: true; lease: PromotionJournalAdmissionLease }
  | { ok: false; error: string };

/**
 * One admission owner for one worlds root. The in-process queue prevents
 * managers in this Electron process from overlapping; the durable root lock
 * extends that same critical section across processes sharing the root.
 * Journal usage is rebuilt from the directory on every acquisition, so a
 * process crash cannot leave a stale reservation that is mistaken for live
 * evidence (or silently free a reservation for a journal that did publish).
 */
class PromotionJournalAdmissionOwner {
  private queueTail: Promise<void> = Promise.resolve();

  constructor(private rootBinding: BoundPromotionDirectory) {}

  private async currentUsage(root: string): Promise<PromotionRetentionUsage> {
    const rootInfo = await lstatPath(root, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("promotion worlds root is not an owned directory");
    }
    return measurePromotionRetention(root);
  }

  private async writeLedger(
    root: BoundPromotionDirectory,
    usage: PromotionRetentionUsage,
    reservation: PromotionJournalUsageLedger["reservation"],
  ): Promise<void> {
    const ledger: PromotionJournalUsageLedger = {
      version: PROMOTION_JOURNAL_USAGE_LEDGER_VERSION,
      root: { dev: root.dev, ino: root.ino },
      usage: { journalCount: usage.journalCount, bytes: usage.bytes.toString() },
      reservation,
    };
    await boundPromotionWriteJsonFile({
      root: root.path,
      rootIdentity: promotionIdentityOf(root),
      components: [PROMOTION_JOURNAL_USAGE_LEDGER],
      parentIdentity: promotionIdentityOf(root),
      value: ledger,
      maxBytes: 8 * 1024 * 1024,
      mode: 0o600,
    });
  }

  private async enter(): Promise<{ binding: BoundPromotionDirectory; leave: () => void }> {
    const previous = this.queueTail;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    this.queueTail = previous.then(() => gate, () => gate);
    await previous;
    let binding: BoundPromotionDirectory;
    let lock: SessionRetentionLock;
    try {
      binding = await refreshBoundPromotionDirectory(this.rootBinding);
      this.rootBinding = binding;
      lock = acquireSessionRetentionLock(binding.path);
      if (String(lock.rootIdentity.dev) !== binding.dev || String(lock.rootIdentity.ino) !== binding.ino) {
        throw new Error("promotion worlds root identity changed before admission");
      }
    } catch (error) {
      releaseGate();
      throw error;
    }
    let released = false;
    return { binding, leave: () => {
      if (released) return;
      released = true;
      releaseSessionRetentionLock(lock);
      releaseGate();
    } };
  }

  async acquire(): Promise<PromotionJournalAdmissionResult> {
    let leave: (() => void) | null = null;
    let binding: BoundPromotionDirectory | null = null;
    try {
      const entered = await this.enter();
      leave = entered.leave;
      binding = entered.binding;
      const usage = await this.currentUsage(binding.path);
      const projectedBytes = usage.bytes + BigInt(MAX_PROMOTION_OPERATION_BYTES);
      if (usage.journalCount >= MAX_PROMOTION_JOURNALS || projectedBytes > BigInt(MAX_PROMOTION_JOURNAL_BYTES)) {
        leave();
        leave = null;
        return {
          ok: false,
          error: `promotion recovery evidence is at capacity (${usage.journalCount}/${MAX_PROMOTION_JOURNALS} journals, ${promotionRetentionBytes(usage.bytes)}/${promotionRetentionBytes(BigInt(MAX_PROMOTION_JOURNAL_BYTES))}); resolve or export retained/conflicting journals under ${resolve(binding.path, "promotion-journal")} before retrying`,
        };
      }
      const reservation = {
        token: randomUUID(),
        pid: process.pid,
        journalCount: 1,
        bytes: BigInt(MAX_PROMOTION_OPERATION_BYTES).toString(),
      };
      // Persist the reservation before the caller is allowed to create the
      // journal root/operation. A second process cannot enter until release.
      await this.writeLedger(binding, usage, reservation);
      let done = false;
      const release = async (): Promise<void> => {
        if (done) return;
        done = true;
        try {
          // Re-measure actual journals: a successful operation has removed its
          // journal, while a failed/uncertain operation remains accounted.
          const actual = await this.currentUsage(binding!.path);
          await this.writeLedger(binding!, actual, null);
        } finally {
          leave?.();
          leave = null;
        }
      };
      return { ok: true, lease: { release } };
    } catch (error) {
      leave?.();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Serialize recovery/ledger reconciliation without reserving a new op. */
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const entered = await this.enter();
    const { binding, leave } = entered;
    try {
      return await operation();
    } finally {
      try {
        const actual = await this.currentUsage(binding.path);
        await this.writeLedger(binding, actual, null);
      } finally {
        leave();
      }
    }
  }

  async drain(): Promise<void> {
    await this.queueTail;
  }
}

const promotionJournalAdmissionOwners = new Map<string, PromotionJournalAdmissionOwner>();

function promotionJournalAdmissionOwnerFor(rootBinding: BoundPromotionDirectory): PromotionJournalAdmissionOwner {
  const root = realpathSync(resolve(rootBinding.path));
  let owner = promotionJournalAdmissionOwners.get(root);
  if (!owner) {
    owner = new PromotionJournalAdmissionOwner(rootBinding);
    promotionJournalAdmissionOwners.set(root, owner);
  }
  return owner;
}

function promotionRetentionBytes(bytes: bigint): string {
  return `${Number(bytes / 1_048_576n).toLocaleString()} MiB`;
}

type PromotionOperationBudget = { used: bigint; max: bigint };

/** Reserve the new promotion's bounded merged tree/session/evidence envelope. */
async function createPromotionOperationBudget(mergedDir: string): Promise<PromotionOperationBudget> {
  const max = BigInt(MAX_PROMOTION_OPERATION_BYTES);
  const mergedBytes = await measurePromotionTreeBytes(mergedDir, max);
  const reserved = mergedBytes + BigInt(MAX_SESSION_BYTES + MAX_PROMOTION_JOURNAL_OVERHEAD_BYTES);
  if (reserved > max) {
    throw new Error(`promotion recovery evidence for this operation exceeds its ${promotionRetentionBytes(max)} bound; reduce the promotion size and retry`);
  }
  return { used: reserved, max };
}

function reservePromotionOperationBytes(budget: PromotionOperationBudget, bytes: number, label: string): void {
  const next = budget.used + BigInt(bytes);
  if (next > budget.max) {
    throw new Error(`promotion recovery evidence for ${label} exceeds its ${promotionRetentionBytes(budget.max)} bound; resolve retained evidence before retrying`);
  }
  budget.used = next;
}

type TrackedSessionFork = {
  comparisonId: string;
  controller: AbortController;
  promise: Promise<unknown>;
};

type CandidateReadyEvent = {
  bridgeId?: string;
  seq?: number;
  generation?: string;
  opId?: string;
};

type CandidateLaunchAttempt = {
  comparisonId: string;
  label: "A" | "B";
  /** Fresh local operation identity; never persisted in the manifest. */
  opId: string;
  /** Exact startup-control opId, when the control was durably written. */
  controlOpId: string | null;
  /** Manager generation, distinct from the sidecar writer generation. */
  generation: number;
  controller: AbortController;
  terminalId: string | null;
  pid: number | null;
  lstart: string | null;
  identityPromise: Promise<string | null> | null;
  cancelled: boolean;
  cleanupPromise: Promise<void> | null;
  fallbackRequested: boolean;
  directCleanupRequested: boolean;
  sessionReady: boolean;
  sidecarGeneration: string | null;
  operation: Promise<void> | null;
};

type EvidenceAttempt = {
  id: string;
  comparisonId: string;
  controller: AbortController;
  promise: Promise<{ ok: boolean; error?: string }> | null;
};

type PendingCandidateReady = {
  comparisonId: string;
  label: "A" | "B";
  terminalId: string;
  expectedOpId: string;
  state: "pending" | "accepted" | "failed";
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class WorldlineManager {
  private comparisons = new Map<string, ComparisonState>();
  private seq = 0;
  private ready: Promise<void>;
  private worldsRootBinding: BoundPromotionDirectory | null = null;
  private primaryRootBinding: BoundPromotionDirectory | null = null;
  private sessionForks = new Set<TrackedSessionFork>();
  private sessionForkClosing = false;
  /**
   * Serializes uncertain-comparison admission through the complete creator
   * transaction. A plain async scan is not enough: two callers can both pass
   * the scan, then materialize their trees concurrently. The gate remains
   * closed until the caller has either published a live comparison or its
   * teardown has finished, so committed evidence and the reservation cannot
   * be observed as two independent transactions.
   */
  /** One root-scoped owner shared by every manager/process using worldsRoot. */
  private uncertainAdmissionOwner: UncertainComparisonAdmissionOwner | null = null;
  /** One root-scoped owner for promotion journal count/byte admission. */
  private promotionAdmissionOwner: PromotionJournalAdmissionOwner | null = null;
  private releaseUncertainAdmissionParticipant: (() => void) | null = null;
  private retainedSessionDiscards = new Set<Promise<unknown>>();
  private closingComparisons = new Set<string>();
  private terminalToComparison = new Map<string, { comparisonId: string; label: "A" | "B"; startupAttemptId?: string }>();
  /** Reopen readiness is a one-shot handshake keyed by the new terminal id. */
  private pendingCandidateReadies = new Map<string, PendingCandidateReady>();
  /** Fresh candidate startup attempts stay addressable through teardown and
   *  a late process-start identity result. */
  private candidateLaunchAttempts = new Map<string, CandidateLaunchAttempt>();
  private candidateLaunchGeneration = 0;
  /** Source comparison ids with a challenge launch in flight. */
  private challengeInFlight = new Set<string>();
  private evidenceByComparison = new Map<string, EvidenceSummary>();
  private evidenceQueue: Promise<unknown> = Promise.resolve();
  /** Every queued/running evidence operation is owned by its comparison. */
  private evidenceAttempts = new Map<string, EvidenceAttempt>();
  private runsByTerminal = new Map<string, RunRecord[]>();
  private runsById = new Map<string, RunRecord>();
  private readyError: Error | null = null;

  constructor(private deps: WorldlineDeps) {
    this.ready = (async () => {
      // Establish app roots from descriptor-bound parent proofs. A
      // pathname-only mkdir/open could turn an ancestor replacement into the
      // first trust anchor for promotion state.
      const worldsRootBinding = await ensureBoundDirectory(this.deps.worldsRoot, "worlds root");
      this.worldsRootBinding = worldsRootBinding;
      this.uncertainAdmissionOwner = uncertainComparisonAdmissionOwnerFor(worldsRootBinding);
      this.promotionAdmissionOwner = promotionJournalAdmissionOwnerFor(worldsRootBinding);
      this.releaseUncertainAdmissionParticipant = this.uncertainAdmissionOwner.register(() => this.safeUncertainComparisonIds());
      // Constructing a manager is the explicit admission boundary for the
      // user-selected project. Bind that existing tree natively, then persist
      // its identity below the already bound worlds root.
      this.primaryRootBinding = await ensureBoundDirectory(
        this.deps.primaryRoot,
        "primary root",
        worldsRootBinding,
        { bootstrapExisting: true },
      );
      await this.sweepStale();
    })().catch((error: unknown) => {
      this.readyError = error instanceof Error ? error : new Error(String(error));
      throw this.readyError;
    });
    // Every manager observes readiness even when no later operation awaits it.
    // Public reads use readyError to fail closed after bootstrap fails.
    void this.ready.catch(() => undefined);
  }

  /** Track worker-backed session operations so teardown cannot race a write. */
  private trackSessionFork<T>(comparisonId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.sessionForkClosing || this.closingComparisons.has(comparisonId)) {
      return Promise.reject(new Error(this.sessionForkClosing ? "worldline manager disposed" : "comparison is closing"));
    }
    const controller = new AbortController();
    let task: Promise<T>;
    try {
      task = operation(controller.signal);
    } catch (error) {
      return Promise.reject(error);
    }
    const tracked: TrackedSessionFork = { comparisonId, controller, promise: task };
    this.sessionForks.add(tracked);
    void task.then(
      () => this.sessionForks.delete(tracked),
      () => this.sessionForks.delete(tracked),
    );
    return task;
  }

  /** Drain both Pi and core session forks before removing owned directories. */
  async drainSessionForks(comparisonId?: string): Promise<void> {
    while (true) {
      const pending = [...this.sessionForks].filter((fork) => comparisonId === undefined || fork.comparisonId === comparisonId);
      if (pending.length === 0) return;
      await Promise.all(pending.map((fork) => fork.promise.catch(() => undefined)));
    }
  }

  private async cancelSessionForks(comparisonId: string): Promise<void> {
    for (const fork of this.sessionForks) {
      if (fork.comparisonId === comparisonId) fork.controller.abort();
    }
    await this.drainSessionForks(comparisonId);
  }

  private comparisonIsLive(cmp: ComparisonState): boolean {
    return !this.sessionForkClosing && this.comparisons.get(cmp.id) === cmp && cmp.phase !== "error" && !this.closingComparisons.has(cmp.id);
  }

  private ensureComparisonLive(cmp: ComparisonState): void {
    if (!this.comparisonIsLive(cmp)) throw new Error("comparison is no longer live");
  }

  private forkSession(cmp: ComparisonState, opts: SessionForkOpts): Promise<SessionForkResult> {
    return this.trackSessionFork(cmp.id, async (signal) => {
      const result = await this.deps.forkSession(opts, { signal });
      if (!result.ok) return result;
      this.ensureComparisonLive(cmp);
      return result;
    });
  }

  private forkCoreSession(cmp: ComparisonState, opts: CoreSessionForkOpts): Promise<CoreSessionForkResult> {
    return this.trackSessionFork(cmp.id, async (signal) => {
      const result = await this.deps.forkCoreSession(opts, { signal });
      if (!result.ok) {
        // Record before the tracked promise resolves. Teardown can therefore
        // recompute retention even if the caller's continuation is delayed.
        await this.recordUncertainSession(cmp, result.sessionFile, result.error);
        return result;
      }
      this.ensureComparisonLive(cmp);
      return result;
    });
  }

  // ------------------------------------------------------------ listing ----

  list(): WorldlineSummary[] {
    if (this.readyError) return [];
    const out: WorldlineSummary[] = [];
    for (const cmp of this.comparisons.values()) {
      for (const cand of cmp.candidates.values()) {
        out.push(this.summaryOf(cmp, cand));
      }
    }
    return out;
  }

  /** Hydrate the renderer with candidate summaries and current evidence. */
  listWithEvidence(): WorldlineSummary[] {
    const out = this.list();
    const attached = new Set<string>();
    for (const summary of out) {
      if (attached.has(summary.comparisonId)) continue;
      const evidence = this.evidenceByComparison.get(summary.comparisonId);
      if (evidence) summary.evidence = evidence;
      attached.add(summary.comparisonId);
    }
    return out;
  }

  /** Add the run to the project catalog. */
  recordRun(run: RunRecord): void {
    this.runsById.set(run.id, run);
    let list = this.runsByTerminal.get(run.terminalId);
    if (!list) {
      list = [];
      this.runsByTerminal.set(run.terminalId, list);
    }
    list.push(run);
    this.evictOverflow(run.terminalId);
  }

  runOf(runId: string): RunRecord | null {
    return this.runsById.get(runId) ?? null;
  }

  private runsOf(terminalId?: string): RunRecord[] {
    if (terminalId) return [...(this.runsByTerminal.get(terminalId) ?? [])];
    const out: RunRecord[] = [];
    for (const list of this.runsByTerminal.values()) out.push(...list);
    return out;
  }

  runSummaries(terminalId?: string): RunSummary[] {
    return this.runsOf(terminalId).map((r) => ({
      id: r.id,
      terminalId: r.terminalId,
      workspaceId: r.workspaceId,
      startStateId: r.startStateId,
      settledStateId: r.settledStateId,
      promptText: r.promptText,
      promptEntryId: r.promptEntryId,
      promptParentEntryId: r.promptParentEntryId,
      settledEntryId: r.settledEntryId,
      sessionFile: r.sessionFile,
      sessionBranchFile: r.sessionBranchFile,
      sessionBranchIdentity: r.sessionBranchIdentity,
      uncertainSessionFile: r.uncertainSessionFile,
      replayable: r.replayable,
      reason: r.reason,
      interrupted: r.interrupted,
      steering: r.steering,
      overlap: r.overlap,
      unownedEdits: r.unownedEdits,
      trusted: r.trusted,
      model: r.model,
      thinkingLevel: r.thinkingLevel,
      startedAt: r.startedAt,
      settledAt: r.settledAt,
    }));
  }

  runCovering(terminalId: string, ts: number): RunRecord | null {
    const runs = this.runsByTerminal.get(terminalId) ?? [];
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i];
      if (ts < run.startedAt) continue;
      if (run.settledAt !== null && ts > run.settledAt) continue;
      return run;
    }
    return null;
  }

  holdsRunState(stateId: string): boolean {
    for (const run of this.runsById.values()) {
      if (run.startStateId === stateId || run.settledStateId === stateId) return true;
    }
    return false;
  }

  promptPayloadsOf(terminalId: string): Set<string> {
    const keep = new Set<string>();
    for (const run of this.runsByTerminal.get(terminalId) ?? []) {
      if (run.promptPayloadFile) keep.add(run.promptPayloadFile);
    }
    return keep;
  }

  /** Run ids that a live comparison still needs (promote, evidence, nested fork). */
  private pinnedRunIds(): Set<string> {
    const pinned = new Set<string>();
    for (const cmp of this.comparisons.values()) {
      if (cmp.sourceRunId) pinned.add(cmp.sourceRunId);
    }
    return pinned;
  }

  /** IDs of live uncertainty-free comparisons excluded from retained usage. */
  private safeUncertainComparisonIds(): ReadonlySet<string> {
    const safe = new Set<string>();
    for (const cmp of this.comparisons.values()) {
      if (
        cmp.phase !== "error"
        && !this.closingComparisons.has(cmp.id)
        && !cmp.manifestWriteFailed
        && cmp.uncertainSessionArtifacts.length === 0
      ) safe.add(cmp.id);
    }
    return safe;
  }

  /**
  * Reserve one uncertain-comparison slot and a durable session byte envelope.
  * The root-scoped owner holds its in-process queue and cross-process lock
  * through publish or rollback. The resulting comparison is then measured as
  * committed evidence on the next admission. This is the one owner for
  * fork-run, challenge, and fork-point admission.
  */
  private async acquireUncertainComparisonAdmission(): Promise<{ ok: true; lease: UncertainComparisonAdmissionLease } | { ok: false; error: string }> {
    const owner = this.uncertainAdmissionOwner;
    if (!owner) return { ok: false, error: "worldline roots are not bound yet" };
    const admission = await owner.acquire(() => this.sessionForkClosing);
    if (!admission.ok) return admission;
    return admission;
  }

  /** Reserve one promotion journal envelope before creating its journal root. */
  private async acquirePromotionJournalAdmission(): Promise<PromotionJournalAdmissionResult> {
    const owner = this.promotionAdmissionOwner;
    if (!owner) return { ok: false, error: "worldline roots are not bound yet" };
    try {
      return await owner.acquire();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private boundWorldsRootPath(): string {
    if (!this.worldsRootBinding) throw new Error("worlds root is not bound");
    return this.worldsRootBinding.path;
  }

  /** Allocate a comparison directory atomically below the bound worlds root. */
  private async allocateComparisonDirectory(): Promise<{ id: string; dir: string; identity: PromotionFsIdentity }> {
    const root = this.worldsRootBinding;
    if (!root) throw new Error("worlds root is not bound");
    while (this.seq < Number.MAX_SAFE_INTEGER) {
      const id = `cmp-${++this.seq}`;
      try {
        const identity = await boundPromotionCreateDirectory({
          root: root.path,
          rootIdentity: promotionIdentityOf(root),
          components: [id],
          parentIdentity: promotionIdentityOf(root),
          requireMissing: true,
        });
        return { id, dir: join(root.path, id), identity };
      } catch (error) {
        // A persisted comparison may occupy this sequence after restart, or
        // another manager may have claimed it under the shared admission
        // lease. Native requireMissing is the collision boundary; advance
        // without ever opening or recursively reusing the existing tree.
        if (/already exists/i.test(error instanceof Error ? error.message : String(error))) continue;
        throw error;
      }
    }
    throw new Error("comparison id allocation exhausted");
  }

  private canDiscard(run: RunRecord, pinned: Set<string>): boolean {
    return run.settledAt !== null && !pinned.has(run.id);
  }

  private oldestDiscardable(pinned: Set<string>): RunRecord | null {
    let oldest: RunRecord | null = null;
    for (const records of this.runsByTerminal.values()) {
      for (const run of records) {
        if (!this.canDiscard(run, pinned)) continue;
        if (!oldest || run.startedAt < oldest.startedAt) oldest = run;
      }
    }
    return oldest;
  }

  /**
   * Drop the oldest disposable records. Never drop an open run or the
   * source of a live comparison.
   */
  private evictOverflow(terminalId: string): void {
    const pinned = this.pinnedRunIds();
    const list = this.runsByTerminal.get(terminalId);
    if (list) {
      while (list.length > MAX_RUNS_PER_TERMINAL) {
        const idx = list.findIndex((run) => this.canDiscard(run, pinned));
        if (idx < 0) break;
        this.discardRun(list.splice(idx, 1)[0]);
      }
    }
    while (this.runsById.size > MAX_RETAINED_RUNS) {
      const victim = this.oldestDiscardable(pinned);
      if (!victim) break;
      const records = this.runsByTerminal.get(victim.terminalId);
      if (!records) break;
      const idx = records.indexOf(victim);
      if (idx >= 0) records.splice(idx, 1);
      if (records.length === 0) this.runsByTerminal.delete(victim.terminalId);
      this.discardRun(victim);
    }
  }

  private discardRun(run: RunRecord | undefined): void {
    if (!run) return;
    this.runsById.delete(run.id);
    if (run.startStateId) void this.deps.releaseState(run.startStateId);
    if (run.settledStateId && run.settledStateId !== run.startStateId) void this.deps.releaseState(run.settledStateId);
    if (run.promptPayloadFile && run.promptEventsDir) {
      // The manager does not own the primary events-root capability. Delegate
      // to Main's bound leaf owner; when it is unavailable, retaining the
      // payload is safer than deleting a pathname replacement.
      const cleanup = this.deps.removePromptPayload?.(run.promptEventsDir, run.promptPayloadFile);
      if (cleanup) void cleanup.catch(() => undefined);
    }
    if (run.sessionBranchFile) {
      if (runEngine(run) === "core") {
        // Successful core finalization leaves a proven durable bundle after
        // its claim is removed. Route its reclamation through the same owner;
        // uncertainSessionFile is intentionally never treated as a valid
        // branch and is not passed here.
        const discard = this.deps.discardCoreSession(run.id).catch(() => undefined);
        this.retainedSessionDiscards.add(discard);
        void discard.finally(() => this.retainedSessionDiscards.delete(discard));
      } else {
        // A finalized Pi branch is app-private, but its pathname is not an
        // authority. Keep the copy when its published identity is missing or
        // changed; the worker/native owner is the only cleanup path.
        if (!run.sessionBranchIdentity) return;
        const discard = this.deps.discardPiSession(run.sessionBranchFile, run.sessionBranchIdentity).catch(() => ({ ok: false }));
        this.retainedSessionDiscards.add(discard);
        void discard.finally(() => this.retainedSessionDiscards.delete(discard));
      }
    }
  }

  /** Drain native durable core-bundle reclamation before app shutdown. */
  private async drainRetainedSessionDiscards(): Promise<void> {
    while (this.retainedSessionDiscards.size > 0) {
      await Promise.all([...this.retainedSessionDiscards].map((task) => task.catch(() => undefined)));
    }
  }

  private clearRuns(): void {
    for (const list of this.runsByTerminal.values()) {
      for (const run of list) this.discardRun(run);
    }
    this.runsByTerminal.clear();
    this.runsById.clear();
  }

  private summaryOf(cmp: ComparisonState, cand: CandidateState): WorldlineSummary {
    return {
      id: `${cmp.id}-${cand.label.toLowerCase()}`,
      comparisonId: cmp.id,
      label: cand.label,
      role: cand.role,
      comparisonBaseStateId: cand.comparisonBaseStateId,
      promotionBaseStateId: cand.promotionBaseStateId,
      headStateId: cand.headStateId,
      sourceRunId: cmp.sourceRunId,
      terminalId: cand.terminalId,
      version: cand.version,
      state: cand.state,
      error: cand.error,
      root: cand.dir,
      sessionFile: cand.sessionFile,
      model: cmp.model,
      thinkingLevel: cmp.thinkingLevel,
      createdAt: cmp.createdAt,
    };
  }

  /** The candidate events dir of a terminal, or null. */
  eventsDirOf(terminalId: string): string | null {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return null;
    return this.comparisons.get(hit.comparisonId)?.candidates.get(hit.label)?.eventsDir ?? null;
  }

  /** Native provenance for one candidate events directory, if it is live. */
  eventsBindingOf(terminalId: string): BoundPromotionDirectory | null {
    const hit = this.terminalToComparison.get(terminalId);
    const binding = hit
      ? this.comparisons.get(hit.comparisonId)?.candidates.get(hit.label)?.eventsBinding
      : undefined;
    return binding ? { path: binding.path, dev: binding.dev, ino: binding.ino } : null;
  }

  /** Update the latest captured state of a candidate. */
  async updateHeadState(terminalId: string, stateId: string): Promise<void> {
    const hit = this.terminalToComparison.get(terminalId);
    if (hit) await this.setCandidateHead(hit.comparisonId, hit.label, stateId);
  }

  /** Record a captured candidate state from an on-demand operation. */
  setCandidateHead(comparisonId: string, label: "A" | "B", stateId: string): Promise<void> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return this.deps.releaseState(stateId);
    const inactive = (): boolean => this.comparisons.get(comparisonId)?.candidates.get(label) !== cand || cmp.phase === "error";
    if (inactive()) return this.deps.releaseState(stateId);
    const commit = cand.headCommit.catch(() => undefined).then(async () => {
      if (inactive() || cand.headStateId === stateId) {
        await this.deps.releaseState(stateId);
        return;
      }
      const previousStateId = cand.headStateId;
      try {
        await this.deps.onCandidateState(cand.dir, stateId);
      } catch (err) {
        await this.deps.releaseState(stateId);
        throw err;
      }
      if (inactive()) {
        await this.deps.releaseState(stateId);
        return;
      }
      cand.headStateId = stateId;
      if (previousStateId) void this.deps.releaseState(previousStateId);
      cand.version++;
      this.pushUpdate(cmp, cand);
    });
    cand.headCommit = commit;
    return commit;
  }

  /**
   * Return the candidate version and head state used to validate evidence.
   */
  evidenceVersion(comparisonId: string, label: "A" | "B"): { version: number; headStateId: string | null } | null {
    const cand = this.comparisons.get(comparisonId)?.candidates.get(label);
    return cand ? { version: cand.version, headStateId: cand.headStateId } : null;
  }

  /**
   * Challenge an existing candidate (WORLDLINES §6.9): the candidate is
   * snapshotted as the new reference A; the challenger B starts from the
   * recorded comparison base and the pre-task session anchor with the
   * original task. The root promotion base stays unchanged.
   */
  async challengeFromCandidate(comparisonId: string, label: "A" | "B", profile: ChallengeProfile): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
    await this.ready;
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (cmp.phase !== "running" && cmp.phase !== "creating") {
      return { ok: false, error: "this comparison is no longer live" };
    }
    if (this.challengeInFlight.has(comparisonId)) return { ok: false, error: "a challenge is already launching" };
    if (!cand.sessionFile) return { ok: false, error: "the candidate has no session" };
    if (cand.state === "running" || cand.state === "creating" || cand.state === "promoting") {
      return { ok: false, error: "wait for the candidate to settle before Challenge" };
    }
    const store = await this.deps.getStore();
    if (!store) return { ok: false, error: "recording is not available" };
    if (!cmp.baseStateId) return { ok: false, error: "the comparison base is missing" };
    const run = this.runOf(cmp.sourceRunId);
    if (!run?.promptPayloadFile) {
      return { ok: false, error: "the run has no captured task or pre-task anchor" };
    }
    if (cmp.engine !== "core" && !run.promptParentEntryId) {
      return { ok: false, error: "the run has no captured task or pre-task anchor" };
    }
    // This comparison is replaced by the challenge pair, so its live
    // candidates free their budget slots.
    if (this.liveWorldlineCount() - cmp.candidates.size + 2 > 3) {
      return { ok: false, error: "the live worldline budget is exhausted" };
    }
    const uncertaintyAdmission = await this.acquireUncertainComparisonAdmission();
    if (!uncertaintyAdmission.ok) return { ok: false, error: uncertaintyAdmission.error };
    const admissionLease = uncertaintyAdmission.lease;
    this.challengeInFlight.add(comparisonId);
    try {
    // Snapshot the candidate head as the new reference A.
    const wHead = await this.deps.captureHead(cand.dir, join(cand.dir, ".git"), cmp.baseStateId);
    const { id, dir, identity: rootIdentity } = await this.allocateComparisonDirectory();
    const rootBinding: BoundPromotionDirectory = { path: dir, dev: rootIdentity.dev, ino: rootIdentity.ino, capability: rootIdentity.capability };
    admissionLease.bind?.(id);
    const markerLeaf = await writeComparisonMarkerBound(rootBinding);
    const manifestLeaf = await writeComparisonManifestBound(rootBinding, {
      id,
      sourceRunId: cmp.sourceRunId,
      createdAt: Date.now(),
      status: "creating",
      expectedCandidates: 2,
      candidates: {},
      uncertainSessionArtifacts: [],
    }, { state: { type: "missing" } });
    const ncmp: ComparisonState = {
      id,
      dir,
      rootIdentity,
      rootBinding,
      templateDir: join(dir, "template"),
      sessionWorkspaceDir: join(dir, "session-workspace"),
      markerLeaf,
      manifestLeaf,
      sourceRunId: cmp.sourceRunId,
      sourceGitDir: store.sourceGitDir,
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: cmp.baseStateId,
      inheritTrust: cmp.inheritTrust,
      model: cmp.model,
      thinkingLevel: cmp.thinkingLevel,
      engine: cmp.engine,
      expectedCandidates: 2,
      uncertainSessionArtifacts: [],
      manifestWriteFailed: false,
      teardownPromise: null,
      uncertainAdmissionLease: admissionLease,
      removeUncertainRequested: false,
      createdAt: Date.now(),
      candidates: new Map(),
      phase: "creating",
      error: null,
      readyTimer: null,
    };
    const mk = (l: "A" | "B", role: "reference" | "challenge"): CandidateState => ({
      label: l,
      role,
      dir: join(dir, l),
      supportDir: join(dir, `${l}-support`),
      homeDir: join(dir, `${l}-support`, "home"),
      sessionDir: join(dir, `${l}-support`, "sessions"),
      eventsDir: join(dir, `${l}-support`, "events"),
      tmpDir: join(dir, `${l}-support`, "tmp"),
      cacheDir: join(dir, `${l}-support`, "cache"),
      profilePath: join(dir, "profiles", `${l}.sb`),
      sessionFile: null,
      comparisonBaseStateId: null,
      promotionBaseStateId: null,
      headStateId: null,
      headCommit: Promise.resolve(),
      terminalId: null,
      pid: null,
      lstart: null,
      state: "creating",
      version: 1,
      error: null,
    });
    const nA = mk("A", "reference");
    const nB = mk("B", "challenge");
    ncmp.candidates.set("A", nA);
    ncmp.candidates.set("B", nB);
    for (const candidate of ncmp.candidates.values()) {
      candidate.comparisonBaseStateId = ncmp.baseStateId;
      candidate.promotionBaseStateId = ncmp.baseStateId;
    }
    nA.headStateId = wHead.commit;
    nB.headStateId = ncmp.baseStateId;
    this.comparisons.set(id, ncmp);
    try {
      const payload = await this.readPromptPayload(run);
      await this.createSupportDirs(ncmp);
      // The template is the SHARED BASE (R), not the reference head: the
      // challenger starts from the recorded base. Every directory and tree
      // mutation remains below the retained native comparison binding.
      await this.buildTemplateFromState(ncmp, store, cmp.baseStateId);
      await this.cloneCandidates(ncmp);
      // The reference A receives the candidate head state.
      if (!nA.rootBinding) throw new Error("challenge reference candidate is not natively bound");
      await store.applyState({ stateId: wHead.commit, targetDir: nA.dir, preserveTopLevel: RUNTIME_ALLOWLIST, boundRootIdentity: promotionIdentityOf(nA.rootBinding) });
      // A's session continues from the candidate leaf; B's session branches
      // at the pre-task anchor (the original run's prompt parent).
      if (ncmp.engine === "core") {
        if (!cand.sessionFile) throw new Error("could not fork the reference session");
        const destA = coreSessionFile(nA.sessionDir, "session");
        const destB = coreSessionFile(nB.sessionDir, "session");
        const forkA = await this.forkCoreSession(ncmp, {
          sourceSessionFile: cand.sessionFile,
          destinationSessionFile: destA,
        });
        if (!forkA.ok) {
          const uncertain = await this.recordUncertainSession(ncmp, forkA.sessionFile, forkA.error);
          throw new Error(`could not fork the reference session: ${uncertain}`);
        }
        this.ensureComparisonLive(ncmp);
        const throughB = parseStorageSeq(run.promptParentEntryId) ?? 0;
        const sourceB = run.sessionBranchFile ?? run.sessionFile ?? cand.sessionFile;
        const forkB = await this.forkCoreSession(ncmp, {
          sourceSessionFile: sourceB,
          destinationSessionFile: destB,
          throughSeq: throughB,
        });
        if (!forkB.ok) {
          const uncertain = await this.recordUncertainSession(ncmp, forkB.sessionFile, forkB.error);
          throw new Error(`could not fork the challenger session: ${uncertain}`);
        }
        this.ensureComparisonLive(ncmp);
        nA.sessionFile = destA;
        nB.sessionFile = destB;
        await this.copyCoreResources(ncmp);
      } else {
        const forkA = await this.forkSession(ncmp, {
          sourceSessionFile: cand.sessionFile,
          entryId: null,
          sessionWorkspaceDir: ncmp.sessionWorkspaceDir,
          candidateRoot: nA.dir,
          candidateSessionDir: nA.sessionDir,
          relocationNote: `The source project lived at ${this.deps.primaryRoot}. In this candidate, that path maps to ${nA.dir}.`,
        });
        if (!forkA.ok || !forkA.sessionFile) throw new Error("could not fork the reference session");
        const forkB = await this.forkSession(ncmp, {
          sourceSessionFile: run.sessionBranchFile ?? run.sessionFile ?? cand.sessionFile,
          ...(run.sessionBranchFile && run.sessionBranchIdentity ? { sourceSessionIdentity: run.sessionBranchIdentity } : {}),
          entryId: run.promptParentEntryId,
          sessionWorkspaceDir: ncmp.sessionWorkspaceDir,
          candidateRoot: nB.dir,
          candidateSessionDir: nB.sessionDir,
          contextText: payload.context || undefined,
        });
        if (!forkB.ok || !forkB.sessionFile) throw new Error("could not fork the challenger session");
        this.ensureComparisonLive(ncmp);
        nA.sessionFile = forkA.sessionFile;
        nB.sessionFile = forkB.sessionFile;
        await this.copyPiResources(ncmp);
      }
      this.ensureComparisonLive(ncmp);
      // B replays the original task automatically (structured control).
      await this.writeControl(nA, { opId: randomUUID(), action: "none" });
      await this.writeControl(nB, {
        opId: randomUUID(),
        action: "structured",
        content: [{ type: "text", text: challengedPrompt(payload.text, profile) }, ...payload.images],
      });
      await this.launchCandidate(ncmp, nA, [], wHead.commit);
      await this.launchCandidate(ncmp, nB, cmp.model && cmp.model.includes("/") ? ["--model", cmp.model] : [], ncmp.baseStateId);
      ncmp.phase = "running";
      ncmp.readyTimer = setTimeout(() => {
        if (ncmp.phase !== "running") return;
        void this.teardown(ncmp.id, "error", "the candidates did not become ready in time");
      }, READY_TIMEOUT_MS);
      // Drop the source from the live budget immediately. Teardown waits
      // on process group signals; do not hold the IPC handler for that.
      cmp.phase = "error";
      void this.teardown(comparisonId, "discarded", null);
      return { ok: true, comparisonId: id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.teardown(ncmp.id, "error", message);
      await this.deps.releaseState(wHead.commit);
      return { ok: false, error: message };
    }
    } finally {
      admissionLease.release();
      this.challengeInFlight.delete(comparisonId);
    }
  }

  /** The ignored/generated writes a promotion would exclude (metadata).
   *  The runtime allowlist (node_modules, .venv, venv) is a template input,
   *  not a candidate write: it never counts. */
  async ignoredWrites(comparisonId: string, label: "A" | "B"): Promise<{ count: number; bytes: number }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { count: 0, bytes: 0 };
    try {
      const ignored = await coreClient.lsIgnored(cand.dir);
      let count = 0;
      let bytes = 0;
      for (const p of ignored) {
        if (!p || count >= MAX_IGNORED_FILES || bytes >= MAX_IGNORED_BYTES) continue;
        if (RUNTIME_ALLOWLIST.includes(p.split(/[\\/]/)[0])) continue;
        count++;
        try {
          bytes = Math.min(MAX_IGNORED_BYTES, bytes + (await lstatPath(join(cand.dir, p))).size);
        } catch {
          /* The file can disappear before it is measured. */
        }
      }
      return { count, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }

  /** True when a candidate has source changes or session activity (§6.11). */
  async activeCandidates(): Promise<number> {
    let active = 0;
    for (const cmp of this.comparisons.values()) {
      for (const cand of cmp.candidates.values()) {
        if (cand.state === "discarded" || cand.state === "error" || cand.state === "promoted") continue;
        try {
          const changes = await coreClient.repoStatus(cand.dir);
          if (changes.length > 0) {
            active++;
            continue;
          }
        } catch {
          /* unreachable — count as active */
          active++;
          continue;
        }
        // Session activity beyond the fork: the session file has entries
        // past the initial control marker.
        const bytes = cand.sessionFile ? sessionBundleBytes(cand.sessionFile) : null;
        if (bytes === null || bytes > 1024) active++;
      }
    }
    return active;
  }

  /** The comparison and candidate behind one terminal, or null. */
  candidateContextOf(terminalId: string): { sourceRunId: string; sessionFile: string | null } | null {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return null;
    const cmp = this.comparisons.get(hit.comparisonId);
    const cand = cmp?.candidates.get(hit.label);
    if (!cmp || !cand) return null;
    return { sourceRunId: cmp.sourceRunId, sessionFile: cand.sessionFile };
  }

  /** The sandbox launch facts of a candidate terminal, or null. */
  candidateSandboxOf(terminalId: string): {
    root: string;
    profilePath: string;
    homeDir: string;
    tmpDir: string;
    eventsDir: string;
    profileBinding?: BoundPromotionDirectory;
    profileLeaf?: BoundPromotionExpectedLeaf;
  } | null {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return null;
    const cand = this.comparisons.get(hit.comparisonId)?.candidates.get(hit.label);
    if (!cand) return null;
    const profileRoot = this.comparisons.get(hit.comparisonId)?.profilesBinding;
    const profileBinding = profileRoot
      ? { path: profileRoot.path, dev: profileRoot.dev, ino: profileRoot.ino }
      : undefined;
    return { root: cand.dir, profilePath: cand.profilePath, homeDir: cand.homeDir, tmpDir: cand.tmpDir, eventsDir: cand.eventsDir, profileBinding, profileLeaf: cand.profileLeaf };
  }

  // ------------------------------------------------------ details on demand ----

  /** Compute one candidate's comparison details (WORLDLINES §6.9). */
  async details(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; details?: WorldlineDetails; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (!cmp.baseCommit) return { ok: false, error: "the comparison base is missing" };
    let primaryCommit: string | null = null;
    try {
      const changedFiles = await this.changedFiles(cmp, cand);
      // Provenance: the unowned edits of the source run (§6.9).
      const unownedEdits = this.runOf(cmp.sourceRunId)?.unownedEdits ?? 0;
      // Ignored/generated runtime fingerprints: metadata only, bounded.
      const ignored = await this.ignoredWrites(comparisonId, label);
      // Conflict status against the current primary source: capture P and
      // merge the candidate head against it (on demand, WORLDLINES §6.9).
      let conflicts: string[] = [];
      primaryCommit = await this.deps.capturePrimary();
      if (primaryCommit && cmp.baseStateId) {
        try {
          const store = await this.deps.getStore();
          if (store) {
            const wHead = await this.deps.captureHead(cand.dir, join(cand.dir, ".git"), cmp.baseStateId);
            await this.setCandidateHead(cmp.id, label, wHead.commit);
            const merged = await store.merge3(wHead.commit, primaryCommit);
            if (!merged.ok && merged.tree) conflicts = merged.conflicts;
            else if (!merged.ok && !merged.tree) conflicts = [merged.reason ?? "merge failed"];
          }
        } catch {
          /* Conflict status can be incomplete. */
        }
      }
      return {
        ok: true,
        details: {
          id: `${cmp.id}-${label.toLowerCase()}`,
          comparisonId: cmp.id,
          label,
          state: cand.state,
          error: cand.error,
          sourceRunId: cmp.sourceRunId,
          comparisonBaseStateId: cand.comparisonBaseStateId,
          promotionBaseStateId: cand.promotionBaseStateId,
          headStateId: cand.headStateId,
          model: cmp.model,
          thinkingLevel: cmp.thinkingLevel,
          createdAt: cmp.createdAt,
          sourceFiles: changedFiles.sourceFiles,
          sourceBytes: changedFiles.sourceBytes,
          changedFiles: changedFiles.files,
          dependencies: await this.dependencyChanges(cmp, cand),
          unownedEdits,
          ignoredFiles: ignored.count,
          ignoredBytes: ignored.bytes,
          primaryConflicts: conflicts,
          ageMs: Date.now() - cmp.createdAt,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (primaryCommit) await this.deps.releaseState(primaryCommit);
    }
  }

  /** Read one file from a candidate tree. */
  async fileOf(comparisonId: string, label: "A" | "B", relPath: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (!this.isSafeRelativePath(relPath)) return { ok: false, error: "invalid candidate path" };
    const root = resolve(cand.dir);
    const target = resolve(root, relPath);
    if (!isInside(root, target)) return { ok: false, error: "path escapes the candidate tree" };
    try {
      const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
      if (!isInside(canonicalRoot, canonicalTarget)) return { ok: false, error: "path escapes the candidate tree" };
      const info = await stat(canonicalTarget);
      if (!info.isFile()) return { ok: false, error: "the candidate path is not a file" };
      if (info.size > MAX_WORLDLINE_FILE_BYTES) return { ok: false, error: "the candidate file is too large" };
      return { ok: true, content: await readFile(canonicalTarget, "utf8") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Read one file from the shared comparison base commit. */
  async baseFileOf(comparisonId: string, relPath: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp || !cmp.baseCommit) return { ok: false, error: "the comparison base is missing" };
    if (!this.isSafeRelativePath(relPath)) return { ok: false, error: "invalid base path" };
    const anyCand = cmp.candidates.get("A") ?? cmp.candidates.get("B");
    if (!anyCand) return { ok: false, error: "candidate not found" };
    const res = await coreClient.repoFile(anyCand.dir, cmp.baseCommit!, relPath);
    if (res === null) return { ok: false, error: "file not in the base" };
    if (res.byteLength > MAX_WORLDLINE_FILE_BYTES) return { ok: false, error: "the base file is too large" };
    return { ok: true, content: res.toString() };
  }

  private isSafeRelativePath(relPath: string): boolean {
    return relPath.length > 0 && relPath !== "." && relPath.indexOf("\0") === -1 && !isAbsolute(relPath) && !relPath.startsWith("/") && !relPath.split(/[\\/]/).includes("..");
  }

  /** Files differing from the base plus head-tree source statistics. */
  private async changedFiles(cmp: ComparisonState, cand: CandidateState): Promise<{ files: WorldlineChangedFile[]; sourceFiles: number; sourceBytes: number }> {
    // Working tree vs HEAD: staged, unstaged, and untracked changes.
    const status = await coreClient.repoStatus(cand.dir);
    // Committed changes since the shared base (A's settled apply and any
    // agent commits; B usually has none).
    const committed = await coreClient.repoDiff(cand.dir, cmp.baseCommit!, "HEAD");
    const tree = await coreClient.repoTree(cand.dir, "HEAD");
    const byPath = new Map<string, WorldlineChangedFile>();
    const set = (relPath: string, status: "created" | "modified" | "deleted"): void => {
      const prev = byPath.get(relPath);
      // A later state wins: deleted beats modified, created beats deleted.
      if (!prev || (status === "deleted" && prev.status !== "deleted") || (status === "created" && prev.status !== "deleted")) {
        byPath.set(relPath, { relPath, status });
      }
    };
    for (const change of status) {
      set(change.relPath, change.status);
    }
    for (const change of committed) {
      set(change.relPath, change.status);
    }
    let sourceFiles = tree.length;
    let sourceBytes = 0;
    for (const entry of tree) {
      sourceBytes += entry.size;
    }
    const files = [...byPath.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { files, sourceFiles, sourceBytes };
  }

  /** Declared dependency differences between base and head. */
  private async dependencyChanges(cmp: ComparisonState, cand: CandidateState): Promise<DependencyChange[]> {
    const out: DependencyChange[] = [];
    for (const file of ["package.json", "pyproject.toml"]) {
      try {
        const base = await coreClient.repoFile(cand.dir, cmp.baseCommit!, file);
        const head = await this.fileOf(cmp.id, cand.label, file);
        if (base === null || !head.ok || head.content === undefined) continue;
        const diff = this.dependencyChangeOf(file, base.toString(), head.content);
        if (diff) out.push(diff);
      } catch {
        /* the file is not comparable */
      }
    }
    return out;
  }

  /** One dependency difference record, or null when nothing changed. */
  private dependencyChangeOf(file: string, baseText: string, headText: string): DependencyChange | null {
    try {
      const diff = dependencyDiff(baseText, headText);
      if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) return null;
      return { file, added: diff.added, removed: diff.removed, changed: diff.changed };
    } catch {
      return null;
    }
  }

  /** The sandbox facts the evidence engine needs for one candidate. */
  evidenceTarget(comparisonId: string, label: "A" | "B"): {
    root: string;
    profilePath: string;
    homeDir: string;
    tmpDir: string;
    state: WorldlineState;
    terminalId: string | null;
    eventsDir: string;
    profileBinding?: BoundPromotionDirectory;
    profileLeaf?: BoundPromotionExpectedLeaf;
    version: number;
    headStateId: string | null;
  } | null {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return null;
    return {
      root: cand.dir,
      profilePath: cand.profilePath,
      homeDir: cand.homeDir,
      tmpDir: cand.tmpDir,
      state: cand.state,
      terminalId: cand.terminalId,
      eventsDir: cand.eventsDir,
      profileBinding: cmp.profilesBinding
        ? { path: cmp.profilesBinding.path, dev: cmp.profilesBinding.dev, ino: cmp.profilesBinding.ino }
        : undefined,
      profileLeaf: cand.profileLeaf,
      version: cand.version,
      headStateId: cand.headStateId,
    };
  }

  // ------------------------------------------------------------ fork-run ----

  async challenge(runId: string, profile: ChallengeProfile): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
    const run = this.runOf(runId);
    if (!run) return { ok: false, error: "run not found" };
    if (!run.promptPayloadFile) return { ok: false, error: "the run has no captured task to replay" };
    const inFlightKey = `run:${runId}`;
    if (this.challengeInFlight.has(inFlightKey)) return { ok: false, error: "a challenge is already launching" };
    this.challengeInFlight.add(inFlightKey);
    try {
      return await this.forkRun(runId, { challengeProfile: profile });
    } finally {
      this.challengeInFlight.delete(inFlightKey);
    }
  }

  async forkRun(runId: string, opts: { challengeProfile?: ChallengeProfile } = {}): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
    await this.ready;
    const run = this.runOf(runId);
    if (!run) return { ok: false, error: "run not found" };
    // Eligibility (WORLDLINES §6.5): replayable run with complete states.
    if (!run.replayable) return { ok: false, error: run.reason ?? "the run is not replayable" };
    if (!run.startStateId || !run.settledStateId) return { ok: false, error: "the run has no complete source checkpoints" };
    if (!run.sessionBranchFile) return { ok: false, error: "the run has no session branch copy" };
    if (runEngine(run) !== "core" && !run.sessionBranchIdentity) {
      run.replayable = false;
      run.reason = "the finalized Pi session branch has no identity-bound provenance";
      return { ok: false, error: run.reason };
    }
    if (this.liveWorldlineCount() + 2 > 3) return { ok: false, error: "the live worldline budget is exhausted" };
    // The fork preflight (WORLDLINES §4): repository, platform, disk.
    const pre = await this.deps.preflight();
    if (!pre.ok) return { ok: false, error: pre.reasons.join("; ") };
    const store = await this.deps.getStore();
    if (!store) return { ok: false, error: "recording is not available" };
    if (resolve(store.sourceRoot) !== resolve(this.deps.primaryRoot)) {
      return { ok: false, error: "the source repository identity changed since the run" };
    }
    // Trust-sensitive resources must still match the run's capture (§6.5).
    if (run.trustHashes) {
      const now = await this.deps.trustHashes();
      const changed = Object.keys(run.trustHashes).filter((k) => now[k] !== run.trustHashes![k]);
      if (changed.length > 0) {
        return { ok: false, error: `trust-sensitive resources changed since the run: ${changed.slice(0, 3).join(", ")}` };
      }
    }
    // Budgets (WORLDLINES §9): session and prompt payload caps.
    if (run.sessionBranchFile && runEngine(run) !== "core") {
      try {
        if ((await stat(run.sessionBranchFile)).size > MAX_SESSION_BYTES) {
          return { ok: false, error: "the session branch exceeds the 64 MB budget" };
        }
      } catch {
        /* unreadable — the eligibility checks above already cover it */
      }
    }
    if (run.promptPayloadFile) {
      if (run.promptPayloadFile.includes("/") || run.promptPayloadFile.includes("\\")) {
        return { ok: false, error: "the prompt payload path is invalid" };
      }
      const payloadPath = await this.safePromptPayloadPath(run);
      if (!payloadPath) return { ok: false, error: "the prompt payload is unavailable" };
      try {
        if ((await stat(payloadPath)).size > MAX_PROMPT_BYTES) {
          return { ok: false, error: "the prompt payload exceeds the 20 MB budget" };
        }
      } catch {
        return { ok: false, error: "the prompt payload is unavailable" };
      }
    }

    const uncertaintyAdmission = await this.acquireUncertainComparisonAdmission();
    if (!uncertaintyAdmission.ok) return { ok: false, error: uncertaintyAdmission.error };
    let cmp: ComparisonState;
    try {
      cmp = await this.createComparison(run, opts.challengeProfile, uncertaintyAdmission.lease);
    } catch (error) {
      uncertaintyAdmission.lease.release();
      throw error;
    }
    try {
      cmp.sourceGitDir = store.sourceGitDir;
      cmp.primaryRoot = store.sourceRoot;
      await this.buildTemplate(cmp, store, run);
      const templateBytes = await dirBytes(cmp.templateDir);
      if (templateBytes > MAX_TEMPLATE_BYTES) {
        throw new Error(`the comparison template exceeds the 2 GB budget (${(templateBytes / 1e9).toFixed(1)} GB)`);
      }
      await this.cloneCandidates(cmp);
      await this.applySettledToA(cmp, store, run);
      const aBytes = await dirBytes(cmp.candidates.get("A")!.dir);
      if (aBytes > MAX_CANDIDATE_BYTES) {
        throw new Error(`candidate A exceeds the 1 GB budget (${(aBytes / 1e9).toFixed(1)} GB)`);
      }
      await this.forkSessions(cmp, run);
      await this.createSupportDirs(cmp);
      if (cmp.engine === "core") await this.copyCoreResources(cmp);
      else await this.copyPiResources(cmp);
      await this.writeStartupControls(cmp, run, opts.challengeProfile);
      await this.launchCandidates(cmp, run);
      cmp.phase = "running";
      // Readiness arrives through the bridge session_ready events.
      cmp.readyTimer = setTimeout(() => {
        if (cmp.phase !== "running") return;
        void this.teardown(cmp.id, "error", "the candidates did not become ready in time");
      }, READY_TIMEOUT_MS);
      return { ok: true, comparisonId: cmp.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.teardown(cmp.id, "error", message);
      return { ok: false, error: message };
    } finally {
      uncertaintyAdmission.lease.release();
    }
  }

  private async createComparison(run: RunRecord, challengeProfile?: ChallengeProfile, uncertainAdmissionLease: UncertainComparisonAdmissionLease | null = null): Promise<ComparisonState> {
    const { id, dir, identity: rootIdentity } = await this.allocateComparisonDirectory();
    const rootBinding: BoundPromotionDirectory = { path: dir, dev: rootIdentity.dev, ino: rootIdentity.ino, capability: rootIdentity.capability };
    uncertainAdmissionLease?.bind?.(id);
    // The marker proves ownership before any cleanup deletes the dir.
    const markerLeaf = await writeComparisonMarkerBound(rootBinding);
    const manifestLeaf = await writeComparisonManifestBound(rootBinding, {
      id,
      sourceRunId: run.id,
      createdAt: Date.now(),
      status: "creating",
      expectedCandidates: 2,
      candidates: {},
      uncertainSessionArtifacts: [],
    }, { state: { type: "missing" } });
    const cmp: ComparisonState = {
      id,
      dir,
      rootIdentity,
      rootBinding,
      templateDir: join(dir, "template"),
      sessionWorkspaceDir: join(dir, "session-workspace"),
      markerLeaf,
      manifestLeaf,
      sourceRunId: run.id,
      sourceGitDir: "",
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: run.startStateId,
      inheritTrust: run.trusted === true && run.trustHashes !== null,
      model: run.model,
      thinkingLevel: run.thinkingLevel,
      engine: runEngine(run),
      expectedCandidates: 2,
      uncertainSessionArtifacts: [],
      manifestWriteFailed: false,
      teardownPromise: null,
      uncertainAdmissionLease,
      removeUncertainRequested: false,
      createdAt: Date.now(),
      candidates: new Map(),
      phase: "creating",
      error: null,
      readyTimer: null,
    };
    for (const label of ["A", "B"] as const) {
      cmp.candidates.set(label, {
        label,
        role: label === "A" ? "reference" : challengeProfile ? "challenge" : "alternative",
        dir: join(dir, label),
        supportDir: join(dir, `${label}-support`),
        homeDir: join(dir, `${label}-support`, "home"),
        sessionDir: join(dir, `${label}-support`, "sessions"),
        eventsDir: join(dir, `${label}-support`, "events"),
        tmpDir: join(dir, `${label}-support`, "tmp"),
        cacheDir: join(dir, `${label}-support`, "cache"),
        profilePath: join(dir, "profiles", `${label}.sb`),
        sessionFile: null,
        comparisonBaseStateId: null,
        promotionBaseStateId: null,
        headStateId: null,
        headCommit: Promise.resolve(),
        terminalId: null,
        pid: null,
        lstart: null,
        state: "creating",
        version: 1,
        error: null,
      });
    }
    for (const cand of cmp.candidates.values()) {
      cand.comparisonBaseStateId = cmp.baseStateId;
      cand.promotionBaseStateId = cmp.baseStateId;
      cand.headStateId = cand.label === "A" ? run.settledStateId : run.startStateId;
    }
    this.comparisons.set(id, cmp);
    return cmp;
  }

  /** The comparison template: base source bytes plus independent git. */
  private async buildTemplate(cmp: ComparisonState, store: SnapshotStore, run: RunRecord): Promise<void> {
    await this.buildTemplateFromState(cmp, store, run.startStateId!);
  }

  /** Build a descriptor-bound template from one store state. */
  private async buildTemplateFromState(cmp: ComparisonState, store: SnapshotStore, stateId: string | null): Promise<void> {
    if (!stateId) throw new Error("comparison template state is missing");
    await refreshComparisonBindings(cmp);
    const templateBinding = await createSnapshotTemplateDirectory(cmp);
    const baseCommit = await store.template({
      stateId,
      targetDir: cmp.templateDir,
      sourceObjectsDir: join(cmp.sourceGitDir, "objects"),
      boundRootIdentity: promotionIdentityOf(templateBinding),
    });
    // The template repo has exactly one commit ("termina base"). Its SHA
    // is the shared comparison base for both candidates.
    cmp.baseCommit = baseCommit;
    // Copy the fixed runtime allowlist into the template.
    const sourceRoot = this.primaryRootBinding;
    if (!sourceRoot) throw new Error("primary root is not natively bound");
    for (const name of RUNTIME_ALLOWLIST) {
      const sourcePlan = await boundPromotionPrepareDirectory({
        root: sourceRoot.path,
        rootIdentity: promotionIdentityOf(sourceRoot),
        components: [name],
        allowMissing: true,
      });
      if (!sourcePlan.identity) continue;
      const sourceBinding: BoundPromotionDirectory = {
        path: join(sourceRoot.path, name),
        dev: sourcePlan.identity.dev,
        ino: sourcePlan.identity.ino,
        capability: sourcePlan.identity.capability,
      };
      const destinationBinding = await ensureBoundChildDirectory(templateBinding, name, true);
      await boundPromotionCopyTree({
        sourceRoot: sourceBinding.path,
        sourceRootIdentity: promotionIdentityOf(sourceBinding),
        destinationRoot: destinationBinding.path,
        destinationRootIdentity: promotionIdentityOf(destinationBinding),
        maxBytes: MAX_TEMPLATE_BYTES,
      });
    }
  }

  /** CoW clone the template into A and B when the volume supports it. */
  private async cloneCandidates(cmp: ComparisonState): Promise<void> {
    await refreshComparisonBindings(cmp);
    const template = cmp.templateBinding;
    const root = cmp.rootBinding;
    if (!template || !root) throw new Error("comparison roots are not natively bound");
    for (const cand of cmp.candidates.values()) {
      const binding = await ensureBoundChildDirectory(root, cand.label, true);
      cand.rootBinding = binding;
      cand.rootIdentity = promotionIdentityOf(binding);
      await boundPromotionCopyTree({
        sourceRoot: template.path,
        sourceRootIdentity: promotionIdentityOf(template),
        destinationRoot: binding.path,
        destinationRootIdentity: promotionIdentityOf(binding),
        maxBytes: MAX_CANDIDATE_BYTES,
      });
    }
  }

  /** Candidate A receives the settled source state. */
  private async applySettledToA(cmp: ComparisonState, store: SnapshotStore, run: RunRecord): Promise<void> {
    const a = cmp.candidates.get("A")!;
    await refreshComparisonBindings(cmp);
    if (!a.rootBinding) throw new Error("candidate A root is not natively bound");
    await store.applyState({ stateId: run.settledStateId!, targetDir: a.dir, preserveTopLevel: RUNTIME_ALLOWLIST, boundRootIdentity: promotionIdentityOf(a.rootBinding) });
  }

  /** Fork both sessions. Pi uses SessionManager; core materializes bundles. */
  private async forkSessions(cmp: ComparisonState, run: RunRecord): Promise<void> {
    if (cmp.engine === "core") {
      await this.forkCoreSessions(cmp, run);
      return;
    }
    const payload = await this.readPromptPayload(run);
    const a = cmp.candidates.get("A")!;
    const b = cmp.candidates.get("B")!;
    const forkA = await this.forkSession(cmp, {
      sourceSessionFile: run.sessionBranchFile!,
      sourceSessionIdentity: run.sessionBranchIdentity!,
      entryId: run.settledEntryId,
      sessionWorkspaceDir: cmp.sessionWorkspaceDir,
      candidateRoot: a.dir,
      candidateSessionDir: a.sessionDir,
      relocationNote: `The source project lived at ${this.deps.primaryRoot}. In this candidate, that path maps to ${a.dir}.`,
    });
    if (!forkA.ok || !forkA.sessionFile) throw new Error("could not fork the reference session");
    const forkB = await this.forkSession(cmp, {
      sourceSessionFile: run.sessionBranchFile!,
      sourceSessionIdentity: run.sessionBranchIdentity!,
      entryId: run.promptParentEntryId,
      sessionWorkspaceDir: cmp.sessionWorkspaceDir,
      candidateRoot: b.dir,
      candidateSessionDir: b.sessionDir,
      contextText: payload.context || undefined,
    });
    if (!forkB.ok || !forkB.sessionFile) throw new Error("could not fork the alternative session");
    this.ensureComparisonLive(cmp);
    a.sessionFile = forkA.sessionFile;
    b.sessionFile = forkB.sessionFile;
  }

  private async forkCoreSessions(cmp: ComparisonState, run: RunRecord): Promise<void> {
    const source = run.sessionBranchFile!;
    const a = cmp.candidates.get("A")!;
    const b = cmp.candidates.get("B")!;
    const destA = coreSessionFile(a.sessionDir, "session");
    const destB = coreSessionFile(b.sessionDir, "session");
    const throughA = parseStorageSeq(run.settledEntryId);
    if (throughA === null || throughA < 1) throw new Error("the settled session address is missing");
    const throughB = parseStorageSeq(run.promptParentEntryId) ?? 0;
    const forkA = await this.forkCoreSession(cmp, {
      sourceSessionFile: source,
      destinationSessionFile: destA,
      throughSeq: throughA,
    });
    if (!forkA.ok) {
      const uncertain = await this.recordUncertainSession(cmp, forkA.sessionFile, forkA.error);
      throw new Error(`could not fork the reference session: ${uncertain}`);
    }
    const forkB = await this.forkCoreSession(cmp, {
      sourceSessionFile: source,
      destinationSessionFile: destB,
      throughSeq: throughB,
    });
    if (!forkB.ok) {
      const uncertain = await this.recordUncertainSession(cmp, forkB.sessionFile, forkB.error);
      throw new Error(`could not fork the alternative session: ${uncertain}`);
    }
    this.ensureComparisonLive(cmp);
    a.sessionFile = destA;
    b.sessionFile = destB;
  }

  private async safePromptPayloadPath(run: { promptPayloadFile: string | null; promptEventsDir?: string | null }): Promise<string | null> {
    const file = run.promptPayloadFile;
    if (!file || file.includes("/") || file.includes("\\")) return null;
    try {
      const dir = run.promptEventsDir ?? this.deps.primaryEventsDir;
      const [canonicalDir, canonicalFile] = await Promise.all([realpath(dir), realpath(join(dir, file))]);
      const rel = relative(canonicalDir, canonicalFile);
      return rel && !rel.startsWith("..") && !isAbsolute(rel) ? canonicalFile : null;
    } catch {
      return null;
    }
  }

  /** Read the prompt payload file (text, images, injected context). */
  private async readPromptPayload(run: { promptPayloadFile: string | null; promptEventsDir?: string | null }): Promise<{ text: string; images: unknown[]; context: string }> {
    const path = await this.safePromptPayloadPath(run);
    if (!path) return { text: "", images: [], context: "" };
    try {
      const info = await stat(path);
      if (info.size > MAX_PROMPT_BYTES) return { text: "", images: [], context: "" };
      const raw = await readFile(path, "utf8");
      const payload = JSON.parse(raw) as { prompt?: unknown; images?: unknown; context?: unknown };
      return {
        text: String(payload.prompt ?? "").slice(0, 64000),
        images: Array.isArray(payload.images) ? payload.images : [],
        context: String(payload.context ?? "").slice(0, 16000),
      };
    } catch {
      return { text: "", images: [], context: "" };
    }
  }

  /** Support directories: home, sessions, events, tmp, cache. */
  private async createSupportDirs(cmp: ComparisonState): Promise<void> {
    await refreshComparisonBindings(cmp);
    const root = cmp.rootBinding;
    if (!root) throw new Error("comparison root is not natively bound");
    if (!cmp.profilesBinding) cmp.profilesBinding = await ensureBoundChildDirectory(root, "profiles", true);
    if (!cmp.sessionWorkspaceBinding) cmp.sessionWorkspaceBinding = await ensureBoundChildDirectory(root, "session-workspace", true);
    for (const cand of cmp.candidates.values()) {
      if (!cand.supportBinding) cand.supportBinding = await ensureBoundChildDirectory(root, `${cand.label}-support`, true);
      if (!cand.homeBinding) cand.homeBinding = await ensureBoundChildDirectory(cand.supportBinding, "home", true);
      if (!cand.sessionBinding) cand.sessionBinding = await ensureBoundChildDirectory(cand.supportBinding, "sessions", true);
      if (!cand.eventsBinding) cand.eventsBinding = await ensureBoundChildDirectory(cand.supportBinding, "events", true);
      if (!cand.tmpBinding) cand.tmpBinding = await ensureBoundChildDirectory(cand.supportBinding, "tmp", true);
      if (!cand.cacheBinding) cand.cacheBinding = await ensureBoundChildDirectory(cand.supportBinding, "cache", true);
    }
  }

  /** Copy agent-core auth and user skills into each candidate home. */
  private async copyCoreResources(cmp: ComparisonState): Promise<void> {
    const authSrc = join(this.deps.realHome, ".termina", "agent", "auth.json");
    const mcpSrc = join(this.deps.realHome, ".termina", "agent", "mcp.json");
    const agentsSrc = join(this.deps.realHome, ".agents");
    for (const cand of cmp.candidates.values()) {
      if (!cand.homeBinding) throw new Error(`candidate ${cand.label} home is not natively bound`);
      const authDstDir = await ensureBoundChildDirectory(
        await ensureBoundChildDirectory(cand.homeBinding, ".termina", true),
        "agent",
        true,
      );
      if (existsSync(authSrc)) {
        try {
          const info = await stat(authSrc);
          if (info.isFile() && info.size <= MAX_PI_RESOURCE_BYTES) {
            await copyBoundPrivateFile(authSrc, authDstDir, "auth.json");
          }
        } catch {
          /* Keep the candidate without this file. */
        }
      }
      if (existsSync(mcpSrc)) {
        try {
          const info = await stat(mcpSrc);
          if (info.isFile() && info.size <= MAX_MCP_JSON_BYTES) {
            await copyBoundPrivateFile(mcpSrc, authDstDir, "mcp.json");
          }
        } catch {
          /* Keep the candidate without this file. */
        }
      }
      if (existsSync(agentsSrc)) {
        try {
          const sourceBinding = await boundPromotionOpenDirectory({ path: agentsSrc });
          const destination = await ensureBoundChildDirectory(cand.homeBinding, ".agents", true);
          await boundPromotionCopyTree({
            sourceRoot: agentsSrc,
            sourceRootIdentity: sourceBinding,
            destinationRoot: destination.path,
            destinationRootIdentity: promotionIdentityOf(destination),
            maxBytes: MAX_PI_RESOURCE_BYTES,
          });
        } catch {
          /* Keep the candidate without user skills. */
        }
      }
    }
  }

  /** Copy the resolved Pi resources into each candidate home. */
  private async copyPiResources(cmp: ComparisonState): Promise<void> {
    const agentSrc = join(this.deps.realHome, ".pi", "agent");
    for (const cand of cmp.candidates.values()) {
      if (!cand.homeBinding) throw new Error(`candidate ${cand.label} home is not natively bound`);
      const agentDst = await ensureBoundChildDirectory(
        await ensureBoundChildDirectory(cand.homeBinding, ".pi", true),
        "agent",
        true,
      );
      for (const name of ["auth.json", "settings.json", "models.json", "models-store.json"]) {
        const src = join(agentSrc, name);
        if (!existsSync(src)) continue;
        try {
          const info = await stat(src);
          if (!info.isFile() || info.size > MAX_PI_RESOURCE_BYTES) continue;
          await copyBoundPrivateFile(src, agentDst, name);
        } catch {
          /* Keep the candidate without this file. */
        }
      }
      for (const name of ["skills", "prompts", "themes", "extensions"]) {
        const src = join(agentSrc, name);
        if (!existsSync(src)) continue;
        try {
          const sourceBinding = await boundPromotionOpenDirectory({ path: src });
          const destination = await ensureBoundChildDirectory(agentDst, name, true);
          await boundPromotionCopyTree({
            sourceRoot: src,
            sourceRootIdentity: sourceBinding,
            destinationRoot: destination.path,
            destinationRootIdentity: promotionIdentityOf(destination),
            maxBytes: MAX_PI_RESOURCE_BYTES,
          });
        } catch {
          /* Keep the candidate without this resource. */
        }
      }
    }
  }

  /** The startup control files: what the bridge does on session start. */
  private async writeStartupControls(cmp: ComparisonState, run: RunRecord, challengeProfile?: ChallengeProfile): Promise<void> {
    const payload = await this.readPromptPayload(run);
    const promptText = challengeProfile ? challengedPrompt(payload.text, challengeProfile) : payload.text;
    const a = cmp.candidates.get("A")!;
    const b = cmp.candidates.get("B")!;
    await this.writeControl(a, { opId: randomUUID(), action: "none" });
    // A challenge replays the original task with one action; a
    // plain fork prefills it as editable text.
    if (payload.images.length > 0 || challengeProfile) {
      // A challenge appends only its selected fixed constraint; image blocks
      // and the captured task stay unchanged.
      await this.writeControl(b, {
        opId: randomUUID(),
        action: "structured",
        content: [{ type: "text", text: promptText }, ...payload.images],
      });
    } else {
      // Text-only prompt: prefilled and editable in the Pi editor.
      await this.writeControl(b, { opId: randomUUID(), action: "prefill", text: promptText });
    }
  }

  private async writeControl(cand: CandidateState, control: Record<string, unknown>): Promise<void> {
    if (typeof control.opId === "string" && control.opId.length > 0) cand.startupControlOpId = control.opId;
    const events = cand.eventsBinding;
    if (!events) throw new Error(`candidate ${cand.label} events directory is not natively bound`);
    const fresh = await refreshBoundPromotionDirectory(events);
    cand.eventsBinding = fresh;
    cand.controlLeaf = await boundPromotionWriteFile({
      root: fresh.path,
      rootIdentity: promotionIdentityOf(fresh),
      components: ["startup-control.json"],
      parentIdentity: promotionIdentityOf(fresh),
      expectedDestination: cand.controlLeaf ?? { state: { type: "missing" } },
      content: Buffer.from(JSON.stringify(control)),
      mode: 0o600,
    });
  }

  /** Launch both candidate Pi terminals inside their sandboxes. */
  private async launchCandidates(cmp: ComparisonState, run: RunRecord): Promise<void> {
    for (const cand of cmp.candidates.values()) {
      // Candidate B replays with the captured model and thinking level.
      // A bare model id is ambiguous across providers; pass only the
      // provider-qualified form.
      const extra: string[] = [];
      if (cand.label === "B" && run.model && run.model.includes("/")) extra.push("--model", run.model);
      if (cand.label === "B" && run.thinkingLevel) extra.push("--thinking", run.thinkingLevel);
      // The moment chain of each candidate seeds from its own head: A is
      // the settled state, B is the run start.
      const head = cand.label === "A" ? run.settledStateId : run.startStateId;
      await this.launchCandidate(cmp, cand, extra, head);
    }
  }

  /** Record a core destination that may have committed after an uncertain result. */
  private async recordUncertainSession(cmp: ComparisonState, sessionFile: string, error: string): Promise<string> {
    if (!cmp.uncertainSessionArtifacts.some((artifact) => artifact.path === sessionFile)) {
      cmp.uncertainSessionArtifacts.push({ path: sessionFile, error });
    }
    const root = cmp.rootBinding;
    if (!root) {
      cmp.manifestWriteFailed = true;
      return `commit uncertain at ${sessionFile}: ${error}`;
    }
    let manifest: ComparisonManifest;
    let expected: BoundPromotionExpectedLeaf | { state: { type: "missing" } };
    try {
      const freshRoot = await refreshBoundPromotionDirectory(root);
      cmp.rootBinding = freshRoot;
      cmp.rootIdentity = promotionIdentityOf(freshRoot);
      const existing = await readComparisonManifestBound(freshRoot, cmp.manifestLeaf);
      manifest = existing.manifest.id === cmp.id && existing.manifest.sourceRunId === cmp.sourceRunId
        ? existing.manifest
        : comparisonManifestFor(cmp);
      expected = existing.leaf;
    } catch {
      manifest = comparisonManifestFor(cmp);
      expected = cmp.manifestLeaf ?? { state: { type: "missing" } };
    }
    manifest.status = "uncertain";
    manifest.uncertainSessionArtifacts = [...cmp.uncertainSessionArtifacts];
    try {
      cmp.manifestLeaf = await writeComparisonManifestBound(cmp.rootBinding!, manifest, expected);
    } catch {
      // The in-memory comparison and its marker are retained. Startup treats
      // the old/missing manifest as unproven and never deletes the directory.
      cmp.manifestWriteFailed = true;
    }
    return `commit uncertain at ${sessionFile}: ${error}`;
  }

  /** The sandboxed launch command for one candidate. */
  private async candidateLaunch(
    cmp: ComparisonState,
    cand: CandidateState,
    extraPiArgs: string[],
  ): Promise<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> {
    await refreshComparisonBindings(cmp);
    // A moment comparison has a single candidate: no sibling to deny (the
    // worlds-root deny covers its tree anyway).
    const sibling = cmp.candidates.get(cand.label === "A" ? "B" : "A");
    const core = cmp.engine === "core";
    const modelCut = cmp.model?.indexOf("/") ?? -1;
    const provider = modelCut > 0 ? cmp.model!.slice(0, modelCut) : null;
    const baseEnv = this.deps.candidateEnv(provider);
    const worldsRoot = this.boundWorldsRootPath();
    const paths: SandboxPaths = {
      candidateRoot: cand.dir,
      candidateSupport: cand.supportDir,
      siblingDir: sibling?.dir ?? join(worldsRoot, "__none__"),
      templateDir: cmp.templateDir,
      worldsRoot,
      primaryRoot: cmp.primaryRoot,
      sourceObjectsDir: join(cmp.sourceGitDir, "objects"),
      realHome: this.deps.realHome,
      storeDir: join(this.deps.userData, "worldlines"),
      primaryEventsDir: this.deps.primaryEventsDir,
      userData: this.deps.userData,
      bridgePath: this.deps.bridgePath,
      appReadPaths: this.deps.appReadPaths(),
      agentHomeDir: join(cand.homeDir, core ? ".termina" : ".pi", "agent"),
      denyNetwork: false,
    };
    const profiles = cmp.profilesBinding;
    if (!profiles) throw new Error("comparison profiles directory is not natively bound");
    const freshProfiles = await refreshBoundPromotionDirectory(profiles);
    cmp.profilesBinding = freshProfiles;
    cand.profileLeaf = await boundPromotionWriteFile({
      root: freshProfiles.path,
      rootIdentity: promotionIdentityOf(freshProfiles),
      components: [`${cand.label}.sb`],
      parentIdentity: promotionIdentityOf(freshProfiles),
      expectedDestination: cand.profileLeaf ?? { state: { type: "missing" } },
      content: Buffer.from(buildSandboxProfile(paths)),
      mode: 0o600,
    });
    if (core) {
      const session = cand.sessionFile ? parseSessionBundlePath(cand.sessionFile) : null;
      if (!session) throw new Error("the candidate session path is invalid");
      const model = cmp.model && cmp.model.includes("/") ? cmp.model : null;
      const cut = model ? model.indexOf("/") : -1;
      const env: Record<string, string | undefined> = {
        ...baseEnv,
        HOME: cand.homeDir,
        TMPDIR: cand.tmpDir,
        TERMINA_EVENTS_DIR: cand.eventsDir,
        ELECTRON_RUN_AS_NODE: "1",
        TERMINA_CORE_SESSION_FILE: cand.sessionFile ?? undefined,
        TERMINA_CORE_SESSION_ID: session.sessionId,
        TERMINA_CORE_APPROVE: "all",
        ...(sessionBundleHasContent(cand.sessionFile!) ? { TERMINA_CORE_RESUME: "1" } : {}),
        ...(model && cut > 0
          ? { TERMINA_CORE_PROVIDER: model.slice(0, cut), TERMINA_CORE_MODEL: model.slice(cut + 1) }
          : {}),
        ...(cmp.inheritTrust ? { TERMINA_INHERIT_TRUST: "1" } : {}),
      };
      const launch = candidateSandboxLaunch(cand.profilePath, [
        this.deps.electronExecPath,
        this.deps.agentCorePath,
        ...thinkingStartupArgs(this.deps.showThinking()),
      ]);
      return { ...launch, env };
    }
    const piArgs = ["--session", cand.sessionFile!, "-e", this.deps.bridgePath, ...extraPiArgs];
    const launch = candidateSandboxLaunch(cand.profilePath, [this.deps.piBin, ...piArgs]);
    return {
      ...launch,
      env: {
        ...baseEnv,
        HOME: cand.homeDir,
        TMPDIR: cand.tmpDir,
        TERMINA_EVENTS_DIR: cand.eventsDir,
        ...(cmp.inheritTrust ? { TERMINA_INHERIT_TRUST: "1" } : {}),
      },
    };
  }

  private async updateManifest(cmp: ComparisonState, cand: CandidateState, attempt?: CandidateLaunchAttempt): Promise<void> {
    try {
      if (attempt) this.ensureCandidateLaunchLive(cmp, cand, attempt);
      if (!cmp.rootBinding) throw new Error("comparison root is not natively bound");
      const freshRoot = await refreshBoundPromotionDirectory(cmp.rootBinding);
      if (attempt) this.ensureCandidateLaunchLive(cmp, cand, attempt);
      cmp.rootBinding = freshRoot;
      cmp.rootIdentity = promotionIdentityOf(freshRoot);
      const loaded = await readComparisonManifestBound(freshRoot, cmp.manifestLeaf);
      if (attempt) this.ensureCandidateLaunchLive(cmp, cand, attempt);
      const manifest = loaded.manifest;
      if (manifest.id !== cmp.id || manifest.sourceRunId !== cmp.sourceRunId) throw new Error("comparison manifest is not complete");
      manifest.candidates[cand.label] = { pid: cand.pid, lstart: cand.lstart, paths: [cand.dir, cand.supportDir] };
      manifest.uncertainSessionArtifacts = [...cmp.uncertainSessionArtifacts];
      manifest.status = manifest.uncertainSessionArtifacts.length > 0
        ? "uncertain"
        : Object.keys(manifest.candidates).length === cmp.expectedCandidates
          ? "complete"
          : "creating";
      if (attempt) this.ensureCandidateLaunchLive(cmp, cand, attempt);
      cmp.manifestLeaf = await writeComparisonManifestBound(freshRoot, manifest, loaded.leaf);
    } catch (error) {
      if (attempt && !this.candidateLaunchLive(cmp, cand, attempt)) throw error;
      // An unproven manifest makes the comparison retention-only at teardown.
      cmp.manifestWriteFailed = true;
    }
  }

  /** The comparison and candidate behind one terminal, or null. */
  promotionTarget(comparisonId: string, label: "A" | "B"): {
    root: string;
    sessionFile: string | null;
    terminalId: string | null;
    eventsDir: string;
    sourceRunId: string;
    state: WorldlineState;
  } | null {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return null;
    return {
      root: cand.dir,
      sessionFile: cand.sessionFile,
      terminalId: cand.terminalId,
      eventsDir: cand.eventsDir,
      sourceRunId: cmp.sourceRunId,
      state: cand.state,
    };
  }

  /** The pair enters the promoting lifecycle state. */
  markPromoting(comparisonId: string, label: "A" | "B"): void {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return;
    cand.state = "promoting";
    cand.version++;
    this.pushUpdate(cmp, cand);
  }

  private isPromoting(cmp: ComparisonState): boolean {
    for (const cand of cmp.candidates.values()) {
      if (cand.state === "promoting") return true;
    }
    return false;
  }

  /** Promotion finished: tear the pair down ("promoted") or release. */
  async finishPromotion(comparisonId: string, ok: boolean, error: string | null): Promise<void> {
    if (ok) {
      await this.teardown(comparisonId, "promoted", null);
    } else {
      // A rejected promotion leaves the pair usable (promote the other
      // candidate, verify, or discard); the error shows on the card.
      const cmp = this.comparisons.get(comparisonId);
      if (!cmp) return;
      for (const cand of cmp.candidates.values()) {
        if (cand.state !== "promoting") continue;
        cand.state = "ready";
        cand.error = error;
        cand.version++;
        this.pushUpdate(cmp, cand);
      }
    }
  }

  // ---------------------------------------------------------- evidence ----

  markEvidenceStale(comparisonId: string | undefined): EvidenceSummary | null {
    if (!comparisonId) return null;
    if (!this.comparisons.has(comparisonId) || this.closingComparisons.has(comparisonId)) return null;
    const summary = this.evidenceByComparison.get(comparisonId);
    if (!summary || summary.stale) return null;
    summary.stale = true;
    this.deps.onEvidenceUpdate(summary);
    return summary;
  }

  holdsEvidenceState(stateId: string): boolean {
    for (const summary of this.evidenceByComparison.values()) {
      for (const records of Object.values(summary.byCandidate)) {
        if (records.some((record) => record.stateId === stateId)) return true;
      }
    }
    return false;
  }

  measureEvidence(comparisonId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.comparisons.has(comparisonId) || this.closingComparisons.has(comparisonId)) {
      return Promise.resolve({ ok: false, error: "comparison is no longer live" });
    }
    const attempt: EvidenceAttempt = {
      id: randomUUID(),
      comparisonId,
      controller: new AbortController(),
      promise: null,
    };
    this.evidenceAttempts.set(attempt.id, attempt);
    const run = this.evidenceQueue.then(() => {
      if (attempt.controller.signal.aborted || this.closingComparisons.has(comparisonId)) {
        return { ok: false, error: "evidence was cancelled" };
      }
      return this.runEvidence(comparisonId, attempt);
    });
    const tracked = run.finally(() => {
      if (this.evidenceAttempts.get(attempt.id) === attempt) this.evidenceAttempts.delete(attempt.id);
    });
    attempt.promise = tracked;
    this.evidenceQueue = tracked.catch(() => undefined);
    return tracked;
  }

  async drainEvidence(): Promise<void> {
    await this.evidenceQueue.catch(() => undefined);
  }

  /** Abort and await only the evidence workers owned by one comparison. */
  private async cancelEvidence(comparisonId: string): Promise<void> {
    while (true) {
      const attempts = [...this.evidenceAttempts.values()].filter((attempt) => attempt.comparisonId === comparisonId);
      if (attempts.length === 0) return;
      for (const attempt of attempts) attempt.controller.abort();
      await Promise.all(attempts.map((attempt) => attempt.promise?.catch(() => undefined) ?? Promise.resolve()));
    }
  }

  private async dropEvidence(comparisonId: string): Promise<void> {
    const summary = this.evidenceByComparison.get(comparisonId);
    this.evidenceByComparison.delete(comparisonId);
    if (summary) await this.releaseSummaryStates(summary);
  }

  private async releaseSummaryStates(summary: EvidenceSummary): Promise<void> {
    const states = new Set<string>();
    for (const records of Object.values(summary.byCandidate)) {
      for (const record of records) states.add(record.stateId);
    }
    for (const stateId of states) await this.deps.releaseState(stateId);
  }

  private evidenceAttemptLive(cmp: ComparisonState, attempt: EvidenceAttempt): boolean {
    return !attempt.controller.signal.aborted
      && this.comparisons.get(cmp.id) === cmp
      && cmp.phase !== "error"
      && !this.closingComparisons.has(cmp.id)
      && this.evidenceAttempts.get(attempt.id) === attempt;
  }

  private async runEvidence(comparisonId: string, attempt: EvidenceAttempt): Promise<{ ok: boolean; error?: string }> {
    if (!this.comparisons.has(comparisonId)) return { ok: false, error: "comparison not found" };
    const store = await this.deps.getStore();
    const cmp = this.comparisons.get(comparisonId);
    const baseStateId = this.runOf(cmp?.sourceRunId ?? "")?.startStateId ?? null;
    if (!cmp || !store || !baseStateId) return { ok: false, error: !cmp ? "comparison not found" : "recording is not available" };
    if (!this.evidenceAttemptLive(cmp, attempt)) return { ok: false, error: "evidence was cancelled" };
    const targets = new Map<"A" | "B", NonNullable<ReturnType<WorldlineManager["evidenceTarget"]>>>();
    const generations = new Map<"A" | "B", number>();
    const leases: Array<{ workspaceId: string; requesterId: string }> = [];
    const releaseLeases = (): void => {
      for (const lease of leases) this.deps.releaseWriteLease(lease.workspaceId, lease.requesterId);
    };
    for (const label of ["A", "B"] as const) {
      if (!this.evidenceAttemptLive(cmp, attempt)) {
        releaseLeases();
        return { ok: false, error: "evidence was cancelled" };
      }
      const target = this.evidenceTarget(comparisonId, label);
      if (!target) {
        releaseLeases();
        return { ok: false, error: "candidate not found" };
      }
      if ((target.terminalId && this.deps.terminalBusy(target.terminalId)) || target.state === "running" || target.state === "verifying") {
        releaseLeases();
        return { ok: false, error: `candidate ${label} is active` };
      }
      const workspace = await this.deps.workspaceAt(target.root);
      if (!this.evidenceAttemptLive(cmp, attempt)) {
        releaseLeases();
        return { ok: false, error: "evidence was cancelled" };
      }
      if (!workspace) {
        releaseLeases();
        return { ok: false, error: "candidate workspace not found" };
      }
      const requesterId = `evidence:${comparisonId}:${label}`;
      const lease = await this.deps.acquireWriteLease(workspace.id, requesterId, 2000);
      if (!this.evidenceAttemptLive(cmp, attempt)) {
        releaseLeases();
        return { ok: false, error: "evidence was cancelled" };
      }
      if (!lease.ok) {
        releaseLeases();
        return { ok: false, error: lease.error ?? "a candidate workspace is busy" };
      }
      leases.push({ workspaceId: workspace.id, requesterId });
      targets.set(label, target);
      generations.set(label, workspace.generation);
    }
    let tc: { command: string; args: string[]; label: string } | null;
    let bm: { command: string[]; unit: string; direction: "lower" | "higher"; samples: number; thresholdPct: number } | null;
    let evidenceHome: string | null = null;
    try {
      tc = await this.deps.detectTestFromState(store, baseStateId);
      bm = await this.deps.benchmarkConfigFrom(store, baseStateId);
      evidenceHome = await this.deps.createEvidenceHome();
      if (!this.evidenceAttemptLive(cmp, attempt)) {
        releaseLeases();
        if (evidenceHome) await this.deps.removeEvidenceHome(evidenceHome).catch(() => false);
        return { ok: false, error: "evidence was cancelled" };
      }
    } catch (err) {
      releaseLeases();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!evidenceHome) {
      releaseLeases();
      return { ok: false, error: "evidence home is unavailable" };
    }
    const evidenceRoot = evidenceHome;
    const capturedStates = new Set<string>();
    const capturedTrees = new Map<string, string>();
    const deps: EvidenceDeps = {
      store,
      baseStateId,
      primaryRoot: this.deps.primaryRoot,
      mineFiles: new Set(this.deps.mineFiles()),
      captureHead: async (root, gitDir, parent) => {
        const state = await this.deps.captureHead(root, gitDir, parent);
        capturedStates.add(state.commit);
        capturedTrees.set(state.commit, state.tree);
        return state;
      },
      runSandboxed: (cand, command, timeoutMs, signal) => this.deps.runSandboxedEvidence(cand, command, timeoutMs, signal ?? attempt.controller.signal),
      baseTestCommand: () => tc,
      benchmarkConfig: () => bm,
      sourceFilesOf: (root) => this.deps.sourceFilesOf(root),
    };
    const engine = new EvidenceEngine(deps);
    const byCandidate: Record<"A" | "B", EvidenceRecord[]> = { A: [], B: [] };
    const mineReason: Record<"A" | "B", string | null> = { A: null, B: null };
    const retainedStates = new Set<string>();
    const expectedVersions = new Map<"A" | "B", number>();
    const cands: Record<"A" | "B", { root: string; profilePath: string; homeDir: string; tmpDir: string; shell: string; eventsDir: string; terminalId: string | null; profileBinding?: BoundPromotionDirectory; profileLeaf?: BoundPromotionExpectedLeaf }> = {
      A: { root: targets.get("A")!.root, profilePath: targets.get("A")!.profilePath, homeDir: evidenceRoot, tmpDir: join(evidenceRoot, "tmp", "A"), shell: "", eventsDir: targets.get("A")!.eventsDir, terminalId: targets.get("A")!.terminalId, profileBinding: targets.get("A")!.profileBinding, profileLeaf: targets.get("A")!.profileLeaf },
      B: { root: targets.get("B")!.root, profilePath: targets.get("B")!.profilePath, homeDir: evidenceRoot, tmpDir: join(evidenceRoot, "tmp", "B"), shell: "", eventsDir: targets.get("B")!.eventsDir, terminalId: targets.get("B")!.terminalId, profileBinding: targets.get("B")!.profileBinding, profileLeaf: targets.get("B")!.profileLeaf },
    };
    let result: { ok: boolean; error?: string };
    try {
      result = { ok: true };
      for (const label of ["A", "B"] as const) {
        const target = targets.get(label)!;
        byCandidate[label] = await engine.measure(label, cands[label]);
        if (!this.evidenceAttemptLive(cmp, attempt)) return { ok: false, error: "evidence was cancelled" };
        const finalState = await deps.captureHead(target.root, join(target.root, ".git"), null);
        if (!this.evidenceAttemptLive(cmp, attempt)) return { ok: false, error: "evidence was cancelled" };
        const workspace = await this.deps.workspaceAt(target.root);
        const current = this.evidenceVersion(comparisonId, label);
        if (!workspace || workspace.generation !== generations.get(label) || !current || current.version !== target.version) {
          result = { ok: false, error: `candidate ${label} changed during evidence` };
          break;
        }
        const head = byCandidate[label].find((record) => record.kind === "verify") ?? byCandidate[label][0];
        if (head && capturedTrees.get(head.stateId) !== finalState.tree) {
          result = { ok: false, error: `candidate ${label} changed during evidence` };
          break;
        }
        if (head) {
          if (!this.evidenceAttemptLive(cmp, attempt)) return { ok: false, error: "evidence was cancelled" };
          retainedStates.add(head.stateId);
          await this.setCandidateHead(comparisonId, label, head.stateId);
          if (!this.evidenceAttemptLive(cmp, attempt)) return { ok: false, error: "evidence was cancelled" };
          expectedVersions.set(label, this.evidenceVersion(comparisonId, label)?.version ?? target.version);
          mineReason[label] = await mineChangeReason(store, baseStateId, head.stateId, deps.primaryRoot, deps.mineFiles, (p) => realpath(p));
        } else {
          expectedVersions.set(label, target.version);
        }
      }
      if (result.ok) {
        if (!this.evidenceAttemptLive(cmp, attempt)) return { ok: false, error: "evidence was cancelled" };
        const benches = await engine.measureBenchmarks(cands, {
          A: byCandidate.A.find((r) => r.kind === "verify")?.stateId ?? byCandidate.A[0]?.stateId ?? "",
          B: byCandidate.B.find((r) => r.kind === "verify")?.stateId ?? byCandidate.B[0]?.stateId ?? "",
        });
        if (!this.evidenceAttemptLive(cmp, attempt)) return { ok: false, error: "evidence was cancelled" };
        byCandidate.A.push(benches.A);
        byCandidate.B.push(benches.B);
      }
      if (result.ok) {
        for (const label of ["A", "B"] as const) {
          const target = targets.get(label)!;
          const workspace = await this.deps.workspaceAt(target.root);
          const current = this.evidenceVersion(comparisonId, label);
          if (!workspace || workspace.generation !== generations.get(label) || !current || current.version !== expectedVersions.get(label)) {
            result = { ok: false, error: `candidate ${label} changed during evidence` };
            break;
          }
        }
      }
      if (!result.ok) return result;
      if (!this.evidenceAttemptLive(cmp, attempt)) return { ok: false, error: "evidence was cancelled" };
      const summary: EvidenceSummary = {
        comparisonId,
        ts: Date.now(),
        byCandidate,
        profiles: rankProfiles(byCandidate, mineReason, bm?.thresholdPct ?? 0.05),
        error: null,
        stale: false,
      };
      const previous = this.evidenceByComparison.get(comparisonId);
      this.evidenceByComparison.set(comparisonId, summary);
      if (previous) await this.releaseSummaryStates(previous);
      if (!this.evidenceAttemptLive(cmp, attempt)) return { ok: false, error: "evidence was cancelled" };
      this.deps.onEvidenceUpdate(summary);
      return result;
    } finally {
      for (const stateId of capturedStates) {
        if (!retainedStates.has(stateId)) await this.deps.releaseState(stateId);
      }
      releaseLeases();
      if (evidenceHome) await this.deps.removeEvidenceHome(evidenceHome).catch(() => false);
    }
  }

  // ---------------------------------------------------------- promote ----

  async promote(comparisonId: string, label: "A" | "B", force = false): Promise<{ ok: boolean; error?: string; confirm?: string; terminalId?: string }> {
    return withPromotionTransaction(() => this.promoteUnderTransaction(comparisonId, label, force));
  }

  private async promoteUnderTransaction(comparisonId: string, label: "A" | "B", force: boolean): Promise<{ ok: boolean; error?: string; confirm?: string; terminalId?: string }> {
    await this.ready;
    const target = this.promotionTarget(comparisonId, label);
    if (!target) return { ok: false, error: "candidate not found" };
    if (!target.sessionFile) return { ok: false, error: "the candidate has no session" };
    if (!["ready", "running", "settled"].includes(target.state)) {
      return { ok: false, error: `cannot promote from state ${target.state}` };
    }
    if (target.terminalId && this.deps.terminalBusy(target.terminalId)) return { ok: false, error: "the candidate agent is busy" };
    if (target.terminalId && this.deps.terminalVerifying(target.terminalId)) {
      return { ok: false, error: "the candidate is verifying" };
    }
    await this.deps.drainMineUpdates();
    const store = await this.deps.getStore();
    if (!store) return { ok: false, error: "recording is not available" };
    const primary = await this.deps.workspaceAt(this.deps.primaryRoot);
    if (!primary) return { ok: false, error: "no primary workspace" };
    const baseState = this.runOf(target.sourceRunId)?.startStateId ?? null;
    if (!baseState) return { ok: false, error: "the source run base is missing" };
    const candWs = await this.deps.workspaceAt(target.root);
    const candGen = candWs?.generation ?? 0;
    const comparison = this.comparisons.get(comparisonId);
    if (!comparison) return { ok: false, error: "comparison not found" };
    const promoteEngine = comparison.engine === "core" ? "core" : "pi";

    // The admission reservation is the cross-process boundary. It must be
    // acquired before creating promotion-journal (or any operation below it),
    // and it remains held through publish, rollback, or retained evidence.
    const journalAdmission = await this.acquirePromotionJournalAdmission();
    if (!journalAdmission.ok) return { ok: false, error: journalAdmission.error };
    try {

    // Bind all promotion roots before flushing/capturing or inspecting the
    // mutable trees.  These identities come from descriptors opened by Core,
    // never from a TypeScript lstat/realpath walk that an ancestor swap could
    // redirect.  Later native calls must continue to report a mismatch if
    // any of these roots is replaced.
    let primaryRootBinding: BoundPromotionDirectory;
    let journalRoot: BoundPromotionDirectory;
    let worldsRootPath: string;
    let installDir: string;
    let installBinding: BoundPromotionDirectory;
    try {
      worldsRootPath = this.boundWorldsRootPath();
      const worldsIdentity = this.worldsRootBinding ?? await ensureBoundDirectory(worldsRootPath, "worlds root");
      primaryRootBinding = this.primaryRootBinding ?? await ensureBoundDirectory(this.deps.primaryRoot, "primary root", worldsIdentity);
      const journalIdentity = await boundPromotionPrepareDirectory({
        root: worldsRootPath,
        rootIdentity: promotionIdentityOf(worldsIdentity),
        components: ["promotion-journal"],
        createMissing: true,
      });
      if (!journalIdentity.identity) throw new Error("promotion journal root was not bound");
      journalRoot = {
        path: join(worldsRootPath, "promotion-journal"),
        dev: journalIdentity.identity.dev,
        ino: journalIdentity.identity.ino,
        capability: journalIdentity.identity.capability,
      };
      installDir = await this.deps.primarySessionDir(this.deps.primaryRoot, promoteEngine);
      installBinding = await ensureBoundDirectory(installDir, "primary session directory", worldsIdentity);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const opId = `promote-${randomUUID()}`;
    const requester = `promote:${opId}`;
    const journalDir = join(worldsRootPath, "promotion-journal", opId);
    const journal: Record<string, unknown> = {
      opId,
      comparisonId,
      label,
      stateR: baseState,
      primaryRoot: this.deps.primaryRoot,
      phase: "prepared",
      createdAt: Date.now(),
      paths: [],
      stagedSession: null,
      installedSession: null,
      installedSessionTemp: null,
      installedSessionManifest: null,
      installedSessionTempManifest: null,
      uncertainSessionArtifacts: [],
      rollbackTemps: [],
      engine: promoteEngine,
    };
    let journalBinding: PromotionJournalBinding | null = null;

    const leaseP = await this.deps.acquireWriteLease(primary.id, requester, 12000);
    if (!leaseP.ok) return { ok: false, error: leaseP.error ?? "the primary workspace is busy" };
    let candLease = true;
    if (candWs) {
      const l = await this.deps.acquireWriteLease(candWs.id, requester, 8000);
      candLease = l.ok;
    }
    if (!candLease) {
      this.deps.releaseWriteLease(primary.id, requester);
      return { ok: false, error: "the candidate workspace is busy" };
    }
    const releaseLeases = (): void => {
      this.deps.releaseWriteLease(primary.id, requester);
      if (candWs) this.deps.releaseWriteLease(candWs.id, requester);
    };
    const fail = async (message: string): Promise<{ ok: false; error: string }> => {
      releaseLeases();
      if (journalBinding) {
        await boundPromotionRemoveTree({
          root: journalBinding.root.path,
          rootIdentity: promotionIdentityOf(journalBinding.root),
          components: [journalBinding.name],
          parentIdentity: promotionIdentityOf(journalBinding.root),
          expectedIdentity: { dev: journalBinding.directory.dev, ino: journalBinding.directory.ino },
        }).catch((error) => console.warn(`[worldline] promotion evidence cleanup retained: ${error instanceof Error ? error.message : String(error)}`));
      }
      await this.finishPromotion(comparisonId, false, message);
      return { ok: false, error: message };
    };
    const askConfirm = async (message: string): Promise<{ ok: false; confirm: string }> => {
      releaseLeases();
      if (journalBinding) {
        await boundPromotionRemoveTree({
          root: journalBinding.root.path,
          rootIdentity: promotionIdentityOf(journalBinding.root),
          components: [journalBinding.name],
          parentIdentity: promotionIdentityOf(journalBinding.root),
          expectedIdentity: { dev: journalBinding.directory.dev, ino: journalBinding.directory.ino },
        }).catch((error) => console.warn(`[worldline] promotion evidence cleanup retained: ${error instanceof Error ? error.message : String(error)}`));
      }
      await this.finishPromotion(comparisonId, false, null);
      return { ok: false, confirm: message };
    };

    try {
      const operation = await ensureBoundChildDirectory(journalRoot, opId, true);
      journalBinding = { root: journalRoot, directory: operation, name: opId, journalFile: null };
      await writePromotionJournal(journalBinding, journal);
      const flush = await this.deps.flushDirtyModels(requester, primary.id, 8000);
      if (!flush.ok) return fail("could not save editor changes");
      this.markPromoting(comparisonId, label);
      const candGitDir = await gitCommonDir(target.root);
      const [wState, pState] = await Promise.all([
        store.capture(await gitHead(target.root), baseState, {}, {}, { root: target.root, gitDir: candGitDir ?? target.root }),
        store.capture(await gitHead(this.deps.primaryRoot), primary.lastStateCommit ?? null),
      ]);
      await this.deps.onCandidateState(this.deps.primaryRoot, pState.commit);
      const primaryNow = await this.deps.workspaceAt(this.deps.primaryRoot);
      if (!primaryNow || primaryNow.generation !== leaseP.generation) return fail("the primary changed during promotion preflight");
      if (candWs && (await this.deps.workspaceAt(target.root))?.generation !== candGen) return fail("the candidate changed during promotion preflight");
      const top = await gitTopLevel(this.deps.primaryRoot);
      if (!top || !captureRootInRepo(await this.deps.canonicalPath(store.sourceRoot), await this.deps.canonicalPath(top))) {
        return fail("the source repository identity changed");
      }

      const changed = await store.diffTree(baseState, wState.commit);
      // Capture every currently-existing destination parent from a native
      // descriptor before any mutable pathname preflight.  Missing tails are
      // recorded as an expected absence and can only be materialized later by
      // Core with that exact missing index; a same-UID pre-creation is then a
      // conflict instead of an adopted replacement tree.
      const pPaths = await store.treePaths(pState.commit);
      const parentPlans = new Map<string, PromotionDirectoryPlan>();
      const parentPaths = new Set<string>();
      for (const rel of [...changed.map((entry) => entry.relPath), ...pPaths]) {
        parentPaths.add(resolve(dirname(join(this.deps.primaryRoot, rel))));
      }
      for (const parentPath of parentPaths) {
        const plan = await probePromotionDirectory(primaryRootBinding, parentPath, "promotion parent");
        parentPlans.set(resolve(parentPath), plan);
      }
      for (const c of changed) {
        const abs = join(this.deps.primaryRoot, c.relPath);
        if (this.deps.mineFiles().has(await this.deps.canonicalPath(abs))) {
          return fail(`the candidate changes a file you own: ${c.relPath}`);
        }
        const link = await store.symlinkTarget(wState.commit, c.relPath);
        if (link) {
          try {
            if (this.deps.mineFiles().has(realpathSync(join(dirname(abs), link)))) {
              return fail(`the candidate aliases a file you own through a symlink: ${c.relPath}`);
            }
          } catch {
            /* A broken symlink cannot alias a Mine path. */
          }
        }
      }

      const merge = await store.merge3(wState.commit, pState.commit);
      if (!merge.ok || !merge.tree) {
        const reason = merge.reason ?? `the merge conflicts on: ${merge.conflicts.join(", ")}`;
        return fail(reason);
      }
      if (!force) {
        const summary = this.evidenceByComparison.get(comparisonId);
        const recs = summary?.byCandidate[label] ?? [];
        const verify = recs.find((r) => r.kind === "verify");
        const evidenceOk = verify?.status === "pass" && summary?.stale !== true;
        const ignored = await this.ignoredWrites(comparisonId, label);
        if (!evidenceOk) {
          const why = !verify ? "no evidence has been computed for this candidate" : summary?.stale ? "the evidence is stale (the candidate ran again)" : `the evidence is ${verify?.status}`;
          return askConfirm(`promote without current passing evidence? (${why})`);
        }
        if ((ignored?.count ?? 0) > 0) {
          return askConfirm(`${ignored!.count} ignored/generated file(s) (${((ignored!.bytes ?? 0) / 1024).toFixed(0)} kB) will be excluded from the promotion`);
        }
      }

      const mergedBinding = await ensureBoundChildDirectory(journalBinding!.directory, "merged", true);
      const mergedDir = mergedBinding.path;
      await store.materialize(merge.tree, mergedDir, {
        boundRootIdentity: promotionIdentityOf(mergedBinding),
      });
      const promotionBudget = await createPromotionOperationBudget(mergedDir);
      const mergedPaths = await store.treePaths(merge.tree);
      const beforeBinding = await ensureBoundChildDirectory(journalBinding!.directory, "before", true);
      const beforeDir = beforeBinding.path;
      const canonicalPrimaryRoot = await this.deps.canonicalPath(this.deps.primaryRoot);
      const paths: PromotionJournalPath[] = [];
      for (const rel of [...mergedPaths].sort()) {
        const abs = await promotionDestination(this.deps.primaryRoot, canonicalPrimaryRoot, rel, this.deps.canonicalPath);
        const before = await readPromotionEntry(abs);
        const after = await readPromotionEntry(join(mergedDir, rel));
        if (!isRestorablePromotionState(before.state) || !isMaterializedPromotionState(after.state)) {
          throw new Error(`unsupported filesystem object in promotion: ${rel}`);
        }
        const record: PromotionJournalPath = {
          rel,
          kind: "write",
          beforeHash: promotionStateHash(before.state),
          afterHash: promotionStateHash(after.state),
          beforeExists: before.state.type !== "missing",
          beforeState: before.state,
          afterState: after.state,
        };
        paths.push(record);
        journal.paths = paths;
        await writePromotionJournal(journalBinding!, journal);
        if (before.state.type === "file") {
          reservePromotionOperationBytes(promotionBudget, before.bytes!.byteLength, `before-image ${rel}`);
          const sourceParentPlan = parentPlans.get(resolve(dirname(abs)));
          if (!sourceParentPlan) throw new Error(`promotion before-image parent was not pre-bound: ${dirname(abs)}`);
          const sourceParent = await promotionParentIdentity(abs, canonicalPrimaryRoot, this.deps.canonicalPath, sourceParentPlan);
          const sourceExpected = await boundPromotionExpectedLeaf(abs, before.state, `promotion before-image ${rel}`);
          const copied = await copyBoundBeforeImage(
            primaryRootBinding,
            promotionSourceComponents(rel),
            { path: sourceParent.path, dev: String(sourceParent.dev), ino: String(sourceParent.ino), capability: sourceParent.capability },
            journalBinding!.directory,
            ["before", ...promotionSourceComponents(rel)],
            sourceExpected,
          );
          record.beforeImageIdentity = copied.identity;
          if (copied.state.type !== "file") throw new Error(`before-image copy changed type at ${rel}`);
          record.beforeImageSize = copied.state.size;
          journal.paths = paths;
          await writePromotionJournal(journalBinding!, journal);
        }
      }
      for (const rel of [...pPaths].filter((p) => !mergedPaths.has(p)).sort()) {
        const abs = await promotionDestination(this.deps.primaryRoot, canonicalPrimaryRoot, rel, this.deps.canonicalPath);
        const before = await readPromotionEntry(abs);
        if (!isRestorablePromotionState(before.state)) throw new Error(`unsupported filesystem object in promotion: ${rel}`);
        const record: PromotionJournalPath = {
          rel,
          kind: "delete",
          beforeHash: promotionStateHash(before.state),
          afterHash: sha256Hex(Buffer.alloc(0)),
          beforeExists: before.state.type !== "missing",
          beforeState: before.state,
          afterState: { type: "missing" },
        };
        paths.push(record);
        journal.paths = paths;
        await writePromotionJournal(journalBinding!, journal);
        if (before.state.type === "file") {
          reservePromotionOperationBytes(promotionBudget, before.bytes!.byteLength, `before-image ${rel}`);
          // A deletion is retired into journal-owned evidence during apply;
          // reserve that second file copy as well so the operation cap covers
          // both rollback input and preservation-first retention.
          reservePromotionOperationBytes(promotionBudget, before.bytes!.byteLength, `retained delete ${rel}`);
          const sourceParentPlan = parentPlans.get(resolve(dirname(abs)));
          if (!sourceParentPlan) throw new Error(`promotion before-image parent was not pre-bound: ${dirname(abs)}`);
          const sourceParent = await promotionParentIdentity(abs, canonicalPrimaryRoot, this.deps.canonicalPath, sourceParentPlan);
          const sourceExpected = await boundPromotionExpectedLeaf(abs, before.state, `promotion before-image ${rel}`);
          const copied = await copyBoundBeforeImage(
            primaryRootBinding,
            promotionSourceComponents(rel),
            { path: sourceParent.path, dev: String(sourceParent.dev), ino: String(sourceParent.ino), capability: sourceParent.capability },
            journalBinding!.directory,
            ["before", ...promotionSourceComponents(rel)],
            sourceExpected,
          );
          record.beforeImageIdentity = copied.identity;
          if (copied.state.type !== "file") throw new Error(`before-image copy changed type at ${rel}`);
          record.beforeImageSize = copied.state.size;
          journal.paths = paths;
          await writePromotionJournal(journalBinding!, journal);
        }
      }
      if (paths.length > 2000) throw new Error("the promotion touches too many paths");
      journal.paths = paths;
      const retainedBinding = paths.some((p) => p.kind === "delete" && p.beforeState!.type !== "missing")
        ? await ensureBoundChildDirectory(journalBinding!.directory, "retained", true)
        : null;

      const sessionBinding = await ensureBoundChildDirectory(journalBinding!.directory, "session", true);
      const sessionDir = sessionBinding.path;
      if (promoteEngine === "core") {
        if (!target.sessionFile) throw new Error("the candidate has no session");
        const staged = coreSessionFile(sessionDir, "staged");
        const fork = await this.forkCoreSession(comparison, {
          sourceSessionFile: target.sessionFile,
          destinationSessionFile: staged,
        });
        if (!fork.ok) {
          journal.uncertainSessionArtifacts = [{ path: fork.sessionFile, error: fork.error }];
          await writePromotionJournal(journalBinding!, journal);
          throw new Error(`could not stage the promoted session: commit uncertain at ${fork.sessionFile}: ${fork.error}`);
        }
        this.ensureComparisonLive(comparison);
        journal.stagedSession = staged;
      } else {
        const fork = await this.forkSession(comparison, {
          sourceSessionFile: target.sessionFile,
          entryId: null,
          sessionWorkspaceDir: sessionDir,
          candidateRoot: this.deps.primaryRoot,
          candidateSessionDir: sessionDir,
          relocationNote: `The candidate project lived at ${target.root}. In this promoted session, that path maps to ${this.deps.primaryRoot}.`,
        });
        if (!fork.sessionFile) throw new Error("the promoted session fork produced no file");
        this.ensureComparisonLive(comparison);
        journal.stagedSession = fork.sessionFile;
      }
      await writePromotionJournal(journalBinding!, journal);

      for (const p of paths) {
        const abs = await promotionDestination(this.deps.primaryRoot, canonicalPrimaryRoot, p.rel, this.deps.canonicalPath);
        if (!promotionStatesEqual((await readPromotionEntry(abs)).state, p.beforeState!)) {
          return fail(`the primary changed at ${p.rel} during promotion`);
        }
      }
      if ((await this.deps.workspaceAt(this.deps.primaryRoot))?.generation !== leaseP.generation) {
        return fail("the primary changed during promotion apply");
      }

      const nativePrimaryRootIdentity = promotionIdentityOf(primaryRootBinding);
      const nativeMergedRootIdentity = promotionIdentityOf(mergedBinding);
      const nativeJournalRootIdentity = promotionIdentityOf(journalBinding!.directory);
      const nativeRetainedParentIdentity = retainedBinding
        ? promotionIdentityOf(retainedBinding)
        : null;
      journal.phase = "applying";
      await writePromotionJournal(journalBinding!, journal);
      this.deps.onPromotionApply(paths.map((p) => p.rel));
      try {
        for (const p of paths) {
          const staged = join(mergedDir, p.rel);
          // The native install re-reads and hashes the staged descriptor. A
          // pathname fsync here would reopen a potentially swapped ancestor.
          let abs = await promotionDestination(this.deps.primaryRoot, canonicalPrimaryRoot, p.rel, this.deps.canonicalPath);
          if (p.kind === "delete" && p.beforeState!.type === "missing") continue;
          const destinationParentPath = dirname(abs);
          const destinationPlan = parentPlans.get(resolve(destinationParentPath));
          if (!destinationPlan) throw new Error(`promotion destination parent was not pre-bound: ${destinationParentPath}`);
          const destinationParent = p.kind === "write"
            ? await materializePromotionDirectoryPlan(primaryRootBinding, destinationPlan, "promotion destination parent")
            : await promotionParentIdentity(abs, canonicalPrimaryRoot, this.deps.canonicalPath, destinationPlan).then((value) => ({ path: value.path, dev: String(value.dev), ino: String(value.ino), capability: value.capability }));
          const parentIdentity = promotionIdentityOf(destinationParent);
          if (p.kind === "delete") {
            const retainedName = basename(p.retainedName ?? `.termina-promotion-retained-${sha256Hex(Buffer.from(`${opId}:${p.rel}`)).slice(0, 24)}.tmp`);
            if (!p.retainedName) {
              p.retainedName = retainedName;
              journal.paths = paths;
              await writePromotionJournal(journalBinding!, journal);
            }
            const result = await boundPromotionTransition({
              primaryRoot: this.deps.primaryRoot,
              primaryRootIdentity: nativePrimaryRootIdentity,
              destinationComponents: promotionDestinationComponents(this.deps.primaryRoot, destinationParent.path, p.rel),
              parentIdentity,
              transition: {
                kind: "retire",
                retainedName,
                retainedRoot: journalBinding!.directory.path,
                retainedRootIdentity: nativeJournalRootIdentity,
                retainedComponents: ["retained", retainedName],
                retainedParentIdentity: nativeRetainedParentIdentity!,
                expectedDestination: await boundPromotionExpectedLeaf(abs, p.beforeState!, `promotion destination ${p.rel}`),
              },
            });
            if (result.outcome !== "applied" || !result.durable) throw new Error(result.error ?? `promotion retire conflict at ${p.rel}`);
          } else {
            const sourceParent = dirname(staged);
            const sourceParentPlan = await probePromotionDirectory(mergedBinding, sourceParent, "promotion merged parent");
            if (!sourceParentPlan.identity) throw new Error(`promotion merged parent is missing: ${sourceParent}`);
            const sourceParentIdentity = sourceParentPlan.identity;
            const expectedDestination = p.beforeState!.type === "missing"
              ? { state: { type: "missing" as const } }
              : await boundPromotionExpectedLeaf(abs, p.beforeState!, `promotion destination ${p.rel}`);
            const result = await boundPromotionTransition({
              primaryRoot: this.deps.primaryRoot,
              primaryRootIdentity: nativePrimaryRootIdentity,
              destinationComponents: promotionDestinationComponents(this.deps.primaryRoot, destinationParent.path, p.rel),
              parentIdentity,
              transition: {
                kind: "install",
                sourceRoot: mergedDir,
                sourceRootIdentity: nativeMergedRootIdentity,
                sourceComponents: promotionSourceComponents(p.rel),
                sourceParentIdentity,
                expectedSource: await boundPromotionExpectedLeaf(staged, p.afterState!, `staged promotion ${p.rel}`),
                expectedDestination,
              },
            });
            if (result.outcome !== "applied" || !result.durable) throw new Error(result.error ?? `promotion install conflict at ${p.rel}`);
          }
        }
      } finally {
        this.deps.onPromotionApply(null);
      }
      journal.phase = "applied";
      await writePromotionJournal(journalBinding!, journal);

      let installed: string;
      if (promoteEngine === "core") {
        const sessionId = `core-${randomUUID()}`;
        const stagedBundle = join(sessionDir, sessionId);
        installed = coreSessionFile(installBinding.path, sessionId);
        journal.installedSession = installed;
        journal.installedSessionManifest = { status: "planned", path: dirname(dirname(installed)) };
        await writePromotionJournal(journalBinding!, journal);
        const fork = await this.forkCoreSession(comparison, {
          sourceSessionFile: String(journal.stagedSession),
          destinationSessionFile: coreSessionFile(sessionDir, sessionId),
        });
        if (!fork.ok) {
          journal.uncertainSessionArtifacts = [{ path: fork.sessionFile, error: fork.error }];
          await writePromotionJournal(journalBinding!, journal);
          throw new Error(`could not install the promoted session: commit uncertain at ${fork.sessionFile}: ${fork.error}`);
        }
        this.ensureComparisonLive(comparison);
        const bundleInfo = await lstatPath(stagedBundle, { bigint: true });
        if (!bundleInfo.isDirectory() || bundleInfo.isSymbolicLink()) throw new Error(`staged core session is not a directory: ${stagedBundle}`);
        const moved = await boundPromotionInstallDirectory({
          sourceRoot: sessionBinding.path,
          sourceRootIdentity: promotionIdentityOf(sessionBinding),
          sourceComponents: [sessionId],
          sourceParentIdentity: promotionIdentityOf(sessionBinding),
          expectedSource: {
            identity: { dev: String(bundleInfo.dev), ino: String(bundleInfo.ino) },
            mode: Number(bundleInfo.mode & 0o777n),
          },
          destinationRoot: installBinding.path,
          destinationRootIdentity: promotionIdentityOf(installBinding),
          destinationComponents: [sessionId],
          destinationParentIdentity: promotionIdentityOf(installBinding),
        });
        if (moved.outcome !== "applied" || !moved.durable) throw new Error(moved.error ?? "could not install the promoted core session bundle");
        const bundleDir = parseSessionBundlePath(installed)?.bundleDir ?? dirname(installed);
        journal.installedSessionManifest = await createPromotionArtifactManifest(bundleDir);
        await writePromotionJournal(journalBinding!, journal);
      } else {
        const sessionName = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`;
        installed = join(installBinding.path, sessionName);
        journal.installedSession = installed;
        journal.installedSessionTemp = null;
        journal.installedSessionManifest = { status: "planned", path: installed };
        journal.installedSessionTempManifest = null;
        await writePromotionJournal(journalBinding!, journal);
        const staged = String(journal.stagedSession);
        const stagedRelative = relative(sessionBinding.path, staged);
        if (!stagedRelative || stagedRelative.startsWith("..") || isAbsolute(stagedRelative)) throw new Error("staged Pi session escaped the promotion session root");
        const sourceParentPath = dirname(staged);
        const sourceParentPlan = await probePromotionDirectory(sessionBinding, sourceParentPath, "staged Pi session parent");
        if (!sourceParentPlan.identity) throw new Error(`staged Pi session parent is missing: ${sourceParentPath}`);
        const sourceParentInfo = sourceParentPlan.identity;
        const installedResult = await boundPromotionTransition({
          primaryRoot: installBinding.path,
          primaryRootIdentity: promotionIdentityOf(installBinding),
          destinationComponents: [sessionName],
          parentIdentity: promotionIdentityOf(installBinding),
          transition: {
            kind: "install",
            sourceRoot: sessionBinding.path,
            sourceRootIdentity: promotionIdentityOf(sessionBinding),
            sourceComponents: promotionSourceComponents(stagedRelative),
            sourceParentIdentity: sourceParentInfo,
            expectedSource: await boundPromotionExpectedLeaf(staged, { type: "file", hash: sha256Hex(await readFile(staged)) }, "staged Pi session"),
            expectedDestination: { state: { type: "missing" } },
          },
        });
        if (installedResult.outcome !== "applied" || !installedResult.durable) throw new Error(installedResult.error ?? "could not install the promoted Pi session");
        journal.installedSessionTempManifest = null;
        journal.installedSessionManifest = await createPromotionArtifactManifest(installed);
        await writePromotionJournal(journalBinding!, journal);
      }
      journal.phase = "done";
      await writePromotionJournal(journalBinding!, journal);

      const opened = await this.deps.installPromoted({
        paths,
        beforeDir,
        installedSession: installed,
        primaryRoot: this.deps.primaryRoot,
        primaryWorkspaceId: primary.id,
        comparisonId,
        label,
        engine: promoteEngine,
      });
      await this.finishPromotion(comparisonId, true, null);
      releaseLeases();
      if (journalBinding) {
        await boundPromotionRemoveTree({
          root: journalBinding.root.path,
          rootIdentity: promotionIdentityOf(journalBinding.root),
          components: [journalBinding.name],
          parentIdentity: promotionIdentityOf(journalBinding.root),
          expectedIdentity: { dev: journalBinding.directory.dev, ino: journalBinding.directory.ino },
        });
      }
      return { ok: true, terminalId: opened.terminalId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (String(journal.phase) === "done") {
        // The primary already has the merged bytes and the session file.
        releaseLeases();
        await this.finishPromotion(comparisonId, true, null);
        if (journalBinding) {
          await boundPromotionRemoveTree({
            root: journalBinding.root.path,
            rootIdentity: promotionIdentityOf(journalBinding.root),
            components: [journalBinding.name],
            parentIdentity: promotionIdentityOf(journalBinding.root),
            expectedIdentity: { dev: journalBinding.directory.dev, ino: journalBinding.directory.ino },
          }).catch((error) => console.warn(`[worldline] promotion evidence cleanup retained: ${error instanceof Error ? error.message : String(error)}`));
        }
        return { ok: false, error: `the source was promoted, but the new session did not open: ${message}` };
      }
      try {
        await rollbackPromotion(journalDir, journal, this.deps.primaryRoot, this.deps.canonicalPath, journalBinding ?? undefined, primaryRootBinding);
        // Session artifacts are intentionally retained on a failed promotion.
        // A journal manifest is recovery evidence, not proof that a currently
        // matching Pi/core session still belongs to this operation. In
        // particular, never delete a replacement at a predictable session
        // name merely because the in-memory journal once described it.
      } catch (rollbackError) {
        console.warn(`[worldline] promotion rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      releaseLeases();
      await this.finishPromotion(comparisonId, false, message);
      return { ok: false, error: message };
    }
    } finally {
      await journalAdmission.lease.release().catch(() => undefined);
    }
  }

  // ------------------------------------------------------- fork any moment ----

  /**
   * Fork one candidate from a timeline moment (WORLDLINES §6): the exact
   * captured source state and the session branched at the dot's entry.
   * A nested moment uses the candidate session and the root run start as
   * the promotion lineage base.
   */
  async forkPoint(terminalId: string, moment: TimelineEvent | null): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
    await this.ready;
    if (!moment) return { ok: false, error: "timeline moment not found" };
    if (!moment.stateId || !moment.entryId || moment.evicted) {
      return { ok: false, error: moment.evicted ? "this moment's source state was evicted" : "this moment is not forkable" };
    }
    const nested = this.candidateContextOf(terminalId);
    const covering = this.runCovering(terminalId, moment.ts);
    const rootRun = nested ? this.runOf(nested.sourceRunId) : covering;
    const sessionFile = nested?.sessionFile ?? covering?.sessionFile;
    if (!rootRun) return { ok: false, error: "the source run is unavailable" };
    if (!sessionFile) return { ok: false, error: "the run session is unavailable" };
    const opts = {
      terminalId,
      stateId: moment.stateId,
      entryId: moment.entryId,
      model: moment.model ?? rootRun.model,
      thinkingLevel: rootRun.thinkingLevel,
      sessionFile,
      sourceRunId: rootRun.id,
      baseStateId: rootRun.startStateId,
      inheritTrust: rootRun.trusted === true,
    };
    if (this.liveWorldlineCount() + 1 > 3) return { ok: false, error: "the live worldline budget is exhausted" };
    const store = await this.deps.getStore();
    if (!store) return { ok: false, error: "recording is not available" };
    const uncertaintyAdmission = await this.acquireUncertainComparisonAdmission();
    if (!uncertaintyAdmission.ok) return { ok: false, error: uncertaintyAdmission.error };
    const admissionLease = uncertaintyAdmission.lease;
    let id: string;
    let dir: string;
    let rootIdentity: PromotionFsIdentity;
    let rootBinding: BoundPromotionDirectory;
    let markerLeaf: BoundPromotionExpectedLeaf;
    let manifestLeaf: BoundPromotionExpectedLeaf;
    try {
      ({ id, dir, identity: rootIdentity } = await this.allocateComparisonDirectory());
      rootBinding = { path: dir, dev: rootIdentity.dev, ino: rootIdentity.ino, capability: rootIdentity.capability };
      admissionLease.bind?.(id);
      markerLeaf = await writeComparisonMarkerBound(rootBinding);
      manifestLeaf = await writeComparisonManifestBound(rootBinding, {
        id,
        sourceRunId: opts.sourceRunId,
        createdAt: Date.now(),
        status: "creating",
        expectedCandidates: 1,
        candidates: {},
        uncertainSessionArtifacts: [],
      }, { state: { type: "missing" } });
    } catch (error) {
      admissionLease.release();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const cmp: ComparisonState = {
      id,
      dir,
      rootIdentity,
      rootBinding,
      templateDir: join(dir, "template"),
      sessionWorkspaceDir: join(dir, "session-workspace"),
      markerLeaf,
      manifestLeaf,
      sourceRunId: opts.sourceRunId,
      sourceGitDir: store.sourceGitDir,
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: opts.baseStateId ?? null,
      inheritTrust: opts.inheritTrust ?? false,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      engine: runEngine(rootRun),
      expectedCandidates: 1,
      uncertainSessionArtifacts: [],
      manifestWriteFailed: false,
      teardownPromise: null,
      uncertainAdmissionLease: admissionLease,
      removeUncertainRequested: false,
      createdAt: Date.now(),
      candidates: new Map(),
      phase: "creating",
      error: null,
      readyTimer: null,
    };
    const cand: CandidateState = {
      label: "A",
      role: "moment",
      dir: join(dir, "A"),
      supportDir: join(dir, "A-support"),
      homeDir: join(dir, "A-support", "home"),
      sessionDir: join(dir, "A-support", "sessions"),
      eventsDir: join(dir, "A-support", "events"),
      tmpDir: join(dir, "A-support", "tmp"),
      cacheDir: join(dir, "A-support", "cache"),
      profilePath: join(dir, "profiles", "A.sb"),
      sessionFile: null,
      comparisonBaseStateId: null,
      promotionBaseStateId: null,
      headStateId: null,
      headCommit: Promise.resolve(),
      terminalId: null,
      pid: null,
      lstart: null,
      state: "creating",
      version: 1,
      error: null,
    };
    cmp.candidates.set("A", cand);
    cand.comparisonBaseStateId = cmp.baseStateId;
    cand.promotionBaseStateId = cmp.baseStateId;
    cand.headStateId = opts.stateId;
    this.comparisons.set(id, cmp);
    try {
      // The template IS the moment state: build it, then clone one candidate.
      await this.buildTemplateFromState(cmp, store, opts.stateId);
      await this.cloneCandidates(cmp);
      // The session branches at the dot's entry: later entries stay out.
      await this.createSupportDirs(cmp);
      if (cmp.engine === "core") {
        const through = parseStorageSeq(opts.entryId);
        if (through === null) throw new Error("this moment has no session address");
        const dest = coreSessionFile(cand.sessionDir, "session");
        const fork = await this.forkCoreSession(cmp, {
          sourceSessionFile: opts.sessionFile,
          destinationSessionFile: dest,
          throughSeq: through,
        });
        if (!fork.ok) {
          const uncertain = await this.recordUncertainSession(cmp, fork.sessionFile, fork.error);
          throw new Error(`could not fork the moment session: ${uncertain}`);
        }
        this.ensureComparisonLive(cmp);
        cand.sessionFile = dest;
        await this.copyCoreResources(cmp);
      } else {
        const fork = await this.forkSession(cmp, {
          sourceSessionFile: opts.sessionFile,
          entryId: opts.entryId,
          sessionWorkspaceDir: cmp.sessionWorkspaceDir,
          candidateRoot: cand.dir,
          candidateSessionDir: cand.sessionDir,
          relocationNote: `The source project lived at ${this.deps.primaryRoot}. In this candidate, that path maps to ${cand.dir}.`,
        });
        if (!fork.ok || !fork.sessionFile) throw new Error("could not fork the moment session");
        this.ensureComparisonLive(cmp);
        cand.sessionFile = fork.sessionFile;
        await this.copyPiResources(cmp);
      }
      this.ensureComparisonLive(cmp);
      // A moment candidate starts with no prompt: the user continues it.
      // Replay the captured model and thinking level of that moment.
      await this.writeControl(cand, { opId: randomUUID(), action: "none" });
      const extra: string[] = [];
      if (opts.model && opts.model.includes("/")) extra.push("--model", opts.model);
      if (opts.thinkingLevel) extra.push("--thinking", opts.thinkingLevel);
      await this.launchCandidate(cmp, cand, extra, opts.stateId);
      cmp.phase = "running";
      cmp.readyTimer = setTimeout(() => {
        if (cmp.phase !== "running") return;
        void this.teardown(cmp.id, "error", "the candidate did not become ready in time");
      }, READY_TIMEOUT_MS);
      return { ok: true, comparisonId: id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[worldlines] fork-point pipeline failed: ${(err as Error).stack ?? message}`);
      await this.teardown(cmp.id, "error", message);
      return { ok: false, error: message };
    } finally {
      admissionLease.release();
    }
  }

  /** Launch one candidate inside its sandbox (A or a moment candidate). */
  private async launchCandidate(cmp: ComparisonState, cand: CandidateState, extraPiArgs: string[], headStateId: string | null): Promise<void> {
    const attempt: CandidateLaunchAttempt = {
      comparisonId: cmp.id,
      label: cand.label,
      opId: cand.startupControlOpId ?? randomUUID(),
      controlOpId: cand.startupControlOpId ?? null,
      generation: ++this.candidateLaunchGeneration,
      controller: new AbortController(),
      terminalId: null,
      pid: null,
      lstart: null,
      identityPromise: null,
      cancelled: false,
      cleanupPromise: null,
      fallbackRequested: false,
      directCleanupRequested: false,
      sessionReady: false,
      sidecarGeneration: null,
      operation: null,
    };
    cand.startupAttemptId = attempt.opId;
    cand.startupGeneration = attempt.generation;
    this.candidateLaunchAttempts.set(attempt.opId, attempt);

    const operation = (async (): Promise<void> => {
      this.ensureCandidateLaunchLive(cmp, cand, attempt);
      const { cmd, args, env } = await this.candidateLaunch(cmp, cand, extraPiArgs);
      this.ensureCandidateLaunchLive(cmp, cand, attempt);
      cand.headStateId = headStateId ?? cand.headStateId ?? cmp.baseStateId;
      const workspaceId = this.deps.createCandidateWorkspace(cand.dir, cand.headStateId, cmp.id);
      let routedTerminalId: string | null = null;
      const created = await this.deps.createCandidate({
        root: cand.dir,
        workspaceId,
        engine: cmp.engine,
        launch: { cmd, args, env },
        signal: attempt.controller.signal,
        beforeSpawn: (terminalId) => {
          this.ensureCandidateLaunchLive(cmp, cand, attempt);
          routedTerminalId = terminalId;
          attempt.terminalId = terminalId;
          this.installCandidateRouting(cmp, cand, terminalId, undefined, attempt.opId);
        },
      });
      attempt.terminalId = attempt.terminalId ?? created.terminalId;
      attempt.pid = created.pid;
      this.ensureCandidateLaunchLive(cmp, cand, attempt);
      const { terminalId, pid } = created;
      if (routedTerminalId !== terminalId) throw new Error("candidate terminal routing was not installed before spawn");
      cand.terminalId = terminalId;
      cand.pid = pid;
      // Register the terminal before the asynchronous process-identity lookup.
      // The candidate tailer is armed before spawn, so an immediate
      // session_ready may already be queued while this launch continuation is
      // still awaiting ps(). Dropping that boundary would leave the candidate
      // in "starting" until the readiness timeout.
      this.terminalToComparison.set(terminalId, { comparisonId: cmp.id, label: cand.label, startupAttemptId: attempt.opId });
      // `cand.lstart = await readProcessStart(pid)` is represented by the
      // observed promise below so teardown can cancel the waiter safely.
      const identity = pid > 0 ? readProcessStart(pid) : Promise.resolve(null);
      attempt.identityPromise = identity;
      // Teardown may have to use the late start identity after the launch
      // waiter has already been cancelled. Keep observing the original ps()
      // operation without allowing it to publish anything.
      void identity.then(async (lstart) => {
        attempt.lstart = lstart;
        if (attempt.cancelled && lstart && !attempt.directCleanupRequested) {
          attempt.directCleanupRequested = true;
          await this.terminateCandidateGroup(attempt.pid, lstart);
          if (attempt.terminalId && !attempt.fallbackRequested) {
            attempt.fallbackRequested = true;
            this.deps.terminateCandidate?.(attempt.terminalId);
          }
        }
      }).catch(() => undefined);
      const lstart = await awaitAbortable(identity, attempt.controller.signal);
      attempt.lstart = lstart;
      this.ensureCandidateLaunchLive(cmp, cand, attempt);
      cand.lstart = lstart;
      await this.updateManifest(cmp, cand, attempt);
      this.ensureCandidateLaunchLive(cmp, cand, attempt);
      this.pushUpdate(cmp, cand);
    })();
    attempt.operation = operation;
    try {
      await operation;
      if (!this.candidateLaunchAttempts.has(attempt.opId)) return;
      cand.startupAttemptId = undefined;
      if (cand.startupGeneration === attempt.generation) cand.startupGeneration = undefined;
      cand.startupControlOpId = undefined;
      this.candidateLaunchAttempts.delete(attempt.opId);
    } catch (error) {
      await this.cleanupCandidateLaunchAttempt(cmp, cand, attempt);
      throw error;
    }
  }

  /** A fresh launch may publish only while its exact attempt still owns the
   *  candidate. This fence is checked after every asynchronous boundary. */
  private candidateLaunchLive(cmp: ComparisonState, cand: CandidateState, attempt: CandidateLaunchAttempt): boolean {
    return this.comparisonIsLive(cmp)
      && !attempt.cancelled
      && cand.startupAttemptId === attempt.opId
      && cand.startupGeneration === attempt.generation
      && this.candidateLaunchAttempts.get(attempt.opId) === attempt;
  }

  private ensureCandidateLaunchLive(cmp: ComparisonState, cand: CandidateState, attempt: CandidateLaunchAttempt): void {
    if (!this.candidateLaunchLive(cmp, cand, attempt)) throw new Error("candidate startup was cancelled");
  }

  /** Cancel every fresh launch for a comparison before candidate cleanup. */
  private async cancelCandidateLaunches(comparisonId: string): Promise<void> {
    const attempts = [...this.candidateLaunchAttempts.values()].filter((attempt) => attempt.comparisonId === comparisonId);
    for (const attempt of attempts) {
      attempt.cancelled = true;
      attempt.controller.abort();
      const cmp = this.comparisons.get(attempt.comparisonId);
      const cand = cmp?.candidates.get(attempt.label) ?? null;
      await this.cleanupCandidateLaunchAttempt(cmp ?? null, cand, attempt);
    }
    // The operation itself is normally released by the abort race above. A
    // bounded wait prevents teardown from retaining a comparison forever if a
    // provider-specific startup hook ignores its signal.
    await Promise.all(attempts.map((attempt) => attempt.operation
      ? waitBounded(attempt.operation.catch(() => undefined), CANDIDATE_CLEANUP_TIMEOUT_MS)
      : Promise.resolve()));
  }

  /** Cancel one launch and retain enough identity to clean up a late pid. */
  private async cleanupCandidateLaunchAttempt(
    cmp: ComparisonState | null,
    cand: CandidateState | null,
    attempt: CandidateLaunchAttempt,
  ): Promise<void> {
    attempt.cancelled = true;
    attempt.controller.abort();
    if (!attempt.cleanupPromise) {
      attempt.cleanupPromise = (async (): Promise<void> => {
        if (attempt.pid && attempt.pid > 0 && attempt.lstart) {
          attempt.directCleanupRequested = true;
          await this.terminateCandidateGroup(attempt.pid, attempt.lstart);
        }
        if (attempt.terminalId && !attempt.fallbackRequested) {
          attempt.fallbackRequested = true;
          this.deps.terminateCandidate?.(attempt.terminalId);
        }
        const hit = attempt.terminalId ? this.terminalToComparison.get(attempt.terminalId) : undefined;
        if (
          attempt.terminalId
          && hit?.comparisonId === attempt.comparisonId
          && hit.label === attempt.label
          && hit.startupAttemptId === attempt.opId
        ) {
          this.terminalToComparison.delete(attempt.terminalId);
        }
        if (cmp && cand && cand.startupAttemptId === attempt.opId) {
          cand.startupAttemptId = undefined;
          if (cand.startupGeneration === attempt.generation) cand.startupGeneration = undefined;
          cand.startupControlOpId = undefined;
          if (cand.terminalId === attempt.terminalId) cand.terminalId = null;
          if (cand.pid === attempt.pid) cand.pid = null;
          if (cand.lstart === attempt.lstart) cand.lstart = null;
        }
      })();
    }
    await attempt.cleanupPromise;
    // A dependency that returns a late terminal identity after cancellation
    // must still be closed. The first cleanup may have run before create() had
    // published its pid, so re-check the attempt's immutable fields here.
    if (attempt.pid && attempt.pid > 0 && attempt.lstart && !attempt.directCleanupRequested) {
      attempt.directCleanupRequested = true;
      await this.terminateCandidateGroup(attempt.pid, attempt.lstart);
    }
    if (attempt.terminalId && !attempt.fallbackRequested) {
      attempt.fallbackRequested = true;
      this.deps.terminateCandidate?.(attempt.terminalId);
    }
    // If ps() was still in flight, its callback owns the late identity cleanup
    // and cannot touch a replacement candidate because it uses the old
    // process-start value, never the mutable CandidateState pid.
    if (attempt.identityPromise) {
      void attempt.identityPromise.then(async (lstart) => {
        attempt.lstart = lstart;
        if (attempt.cancelled && lstart && !attempt.directCleanupRequested) {
          attempt.directCleanupRequested = true;
          await this.terminateCandidateGroup(attempt.pid, lstart);
          if (attempt.terminalId && !attempt.fallbackRequested) {
            attempt.fallbackRequested = true;
            this.deps.terminateCandidate?.(attempt.terminalId);
          }
        }
      }).catch(() => undefined);
    }
    if (cmp && cand && cand.startupAttemptId === attempt.opId) {
      cand.startupAttemptId = undefined;
      if (cand.startupGeneration === attempt.generation) cand.startupGeneration = undefined;
      cand.startupControlOpId = undefined;
      if (cand.terminalId === attempt.terminalId) cand.terminalId = null;
      if (cand.pid === attempt.pid) cand.pid = null;
      if (cand.lstart === attempt.lstart) cand.lstart = null;
    }
    if (this.candidateLaunchAttempts.get(attempt.opId) === attempt) this.candidateLaunchAttempts.delete(attempt.opId);
  }

  /** Install routing and, for a reopen, arm the exact startup handshake. */
  private installCandidateRouting(
    cmp: ComparisonState,
    cand: CandidateState,
    terminalId: string,
    expectedOpId?: string,
    startupAttemptId?: string,
  ): void {
    this.ensureComparisonLive(cmp);
    const existing = this.terminalToComparison.get(terminalId);
    if (existing && (existing.comparisonId !== cmp.id || existing.label !== cand.label)) {
      throw new Error(`candidate terminal id ${terminalId} is already routed`);
    }
    if (expectedOpId && this.pendingCandidateReadies.has(terminalId)) {
      throw new Error(`candidate terminal ${terminalId} already has a startup handshake`);
    }
    cand.terminalId = terminalId;
    this.terminalToComparison.set(terminalId, {
      comparisonId: cmp.id,
      label: cand.label,
      ...(startupAttemptId || expectedOpId ? { startupAttemptId: startupAttemptId ?? expectedOpId } : {}),
    });
    if (!expectedOpId) return;

    let pending!: PendingCandidateReady;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    pending = {
      comparisonId: cmp.id,
      label: cand.label,
      terminalId,
      expectedOpId,
      state: "pending",
      timer: setTimeout(() => {
        if (pending.state !== "pending") return;
        pending.state = "failed";
        rejectPromise(new Error("the reopened candidate did not become ready in time"));
      }, READY_TIMEOUT_MS),
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    // Clearing a timer from either promise outcome keeps the manager quiescent
    // after a fast session_ready or a deterministic startup failure. The
    // rejection handler is explicit so a failed handshake is never unhandled.
    void promise.then(
      () => clearTimeout(pending.timer),
      () => clearTimeout(pending.timer),
    );
    this.pendingCandidateReadies.set(terminalId, pending);
  }

  // ------------------------------------------------------- session ready ----

  /** The bridge consumed its startup control. */
  onSessionReady(terminalId: string, ok: boolean, error: string | null, event: CandidateReadyEvent = {}): void {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return;
    const cmp = this.comparisons.get(hit.comparisonId);
    const cand = cmp?.candidates.get(hit.label);
    if (!cmp || !cand) return;
    // A terminal callback can race the first teardown tick. Once comparison
    // admission closes, no startup event may mutate or publish stale state.
    if (!this.comparisonIsLive(cmp)) return;

    const pending = this.pendingCandidateReadies.get(terminalId);
    if (pending) {
      // Only the startup-control operation created for this reopen can settle
      // it. Canonical sidecar metadata is required so a legacy/replayed line
      // cannot impersonate the new producer generation.
      const eventGeneration = event.generation;
      const eventSeq = event.seq;
      if (
        pending.state !== "pending"
        || pending.comparisonId !== cmp.id
        || pending.label !== cand.label
        || cand.terminalId !== terminalId
        || event.opId !== pending.expectedOpId
        || typeof event.bridgeId !== "string"
        || event.bridgeId.length === 0
        || typeof eventGeneration !== "string"
        || eventGeneration.length === 0
        || typeof eventSeq !== "number"
        || !Number.isSafeInteger(eventSeq)
        || eventSeq < 1
      ) return;
      if (!ok) {
        pending.state = "failed";
        pending.reject(new Error(`the candidate session failed to start: ${error ?? "unknown"}`));
        return;
      }
      pending.state = "accepted";
      pending.resolve();
      // Keep the accepted record until openTerminal publishes ready. A
      // replay arriving in that gap must not fall through to the ordinary
      // (non-reopen) handler and publish early.
      return;
    }
    const launchAttempt = cand.startupAttemptId ? this.candidateLaunchAttempts.get(cand.startupAttemptId) : undefined;
    // The route retains the completed startup identity for the terminal's
    // lifetime. Once its attempt has been retired, a replayed startup record
    // cannot re-enter the ordinary ready handler or emit another update.
    if (!launchAttempt && hit.startupAttemptId) return;
    if (launchAttempt) {
      // Fresh startup accepts only the control operation and sidecar writer
      // generation belonging to this exact attempt. A delayed record from a
      // prior process must never fail or ready the replacement.
      if (
        launchAttempt.comparisonId !== cmp.id
        || launchAttempt.label !== cand.label
        || launchAttempt.terminalId !== terminalId
        || launchAttempt.cancelled
        || cand.startupGeneration !== launchAttempt.generation
        || (launchAttempt.controlOpId && event.opId !== launchAttempt.controlOpId)
        || typeof event.bridgeId !== "string"
        || event.bridgeId.length === 0
        || typeof event.generation !== "string"
        || event.generation.length === 0
        || typeof event.seq !== "number"
        || !Number.isSafeInteger(event.seq)
        || event.seq < 1
      ) return;
      if (launchAttempt.sidecarGeneration && launchAttempt.sidecarGeneration !== event.generation) return;
      launchAttempt.sidecarGeneration = event.generation;
      launchAttempt.sessionReady = ok;
    }
    if (!ok) {
      void this.teardown(cmp.id, "error", `the candidate session failed to start: ${error ?? "unknown"}`);
      return;
    }
    cand.state = "ready";
    cand.version++;
    this.pushUpdate(cmp, cand);
      // Both ready: the pair is complete.
      if ([...cmp.candidates.values()].every((c) => c.state === "ready")) {
      if (cmp.readyTimer) clearTimeout(cmp.readyTimer);
      void (async () => {
        try {
          if (!cmp.rootBinding || !cmp.templateBinding) return;
          const root = await refreshBoundPromotionDirectory(cmp.rootBinding);
          const template = await refreshBoundPromotionDirectory(cmp.templateBinding);
          await boundPromotionRemoveTree({
            root: root.path,
            rootIdentity: promotionIdentityOf(root),
            components: ["template"],
            parentIdentity: promotionIdentityOf(root),
            expectedIdentity: { dev: template.dev, ino: template.ino },
          });
          cmp.rootBinding = root;
          cmp.rootIdentity = promotionIdentityOf(root);
          cmp.templateBinding = undefined;
          cmp.templateIdentity = undefined;
        } catch (error) {
          // A leaf/root/ancestor swap retains the template as evidence; it is
          // never removed through a pathname fallback.
          console.warn(`[worldlines] template cleanup retained: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
      cmp.phase = "running";
    }
  }

  /** A candidate terminal exited. */
  terminalExited(terminalId: string): void {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return;
    const cmp = this.comparisons.get(hit.comparisonId);
    const cand = cmp?.candidates.get(hit.label);
    if (!cmp || !cand) return;
    const launchAttempt = cand.startupAttemptId ? this.candidateLaunchAttempts.get(cand.startupAttemptId) : undefined;
    if (launchAttempt && launchAttempt.terminalId === terminalId && cand.startupGeneration === launchAttempt.generation) {
      launchAttempt.cancelled = true;
      launchAttempt.controller.abort();
      void this.cleanupCandidateLaunchAttempt(cmp, cand, launchAttempt);
      if (cmp.phase !== "error") void this.teardown(cmp.id, "error", "the candidate exited during startup");
      return;
    }
    const pending = this.pendingCandidateReadies.get(terminalId);
    if (pending && (pending.state === "pending" || pending.state === "accepted")) {
      pending.state = "failed";
      pending.reject(new Error("the reopened candidate exited before startup completed"));
      return;
    }
    if (cand.state === "ready" || cand.state === "running") {
      cand.state = "settled";
      cand.version++;
      this.pushUpdate(cmp, cand);
    }
  }

  // ------------------------------------------------------------- control ----

  /** Abort pair creation; all-or-nothing cleanup. */
  async cancel(comparisonId: string): Promise<{ ok: boolean; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp) return { ok: false, error: "comparison not found" };
    if (this.isPromoting(cmp)) return { ok: false, error: "a promotion is in progress" };
    await this.teardown(comparisonId, "cancelled", null);
    return { ok: true };
  }

  /** Discard a live comparison and remove every app-owned resource. */
  async discard(comparisonId: string): Promise<{ ok: boolean; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp) return { ok: false, error: "comparison not found" };
    if (this.isPromoting(cmp)) return { ok: false, error: "a promotion is in progress" };
    await this.teardown(comparisonId, "discarded", null, true);
    return { ok: true };
  }

  /** Open a new terminal for an existing candidate (reopen). */
  async openTerminal(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; error?: string; terminalId?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (!cand.sessionFile) return { ok: false, error: "the candidate has no session" };
    if (cand.state === "creating") return { ok: false, error: "candidate startup is already in progress" };
    if (cand.terminalId && (cand.state === "ready" || cand.state === "running")) {
      return { ok: false, error: "candidate terminal is already open" };
    }

    const previousTerminalId = cand.terminalId;
    if (previousTerminalId) {
      // The old terminal identity must not be allowed to satisfy the new
      // startup. Its process has normally already exited; removing only the
      // routing is deliberate so a late old record cannot mark this reopen.
      this.terminalToComparison.delete(previousTerminalId);
      const previousPending = this.pendingCandidateReadies.get(previousTerminalId);
      if (previousPending) {
        previousPending.state = "failed";
        clearTimeout(previousPending.timer);
        this.pendingCandidateReadies.delete(previousTerminalId);
        previousPending.reject(new Error("candidate startup was superseded"));
      }
    }
    cand.terminalId = null;
    cand.pid = null;
    cand.lstart = null;
    const startupAttemptId = randomUUID();
    cand.startupAttemptId = startupAttemptId;
    cand.state = "creating";
    cand.error = null;
    cand.version++;
    this.pushUpdate(cmp, cand);

    let routedTerminalId: string | null = null;
    let launchedPid: number | null = null;
    let launchedLstart: string | null = null;
    try {
      const { cmd, args, env } = await this.candidateLaunch(cmp, cand, []);
      // A reopen gets a new control operation. Matching this operation is the
      // durable identity boundary that excludes a stale/replayed ready line
      // from the previous candidate process.
      const opId = startupAttemptId;
      this.ensureComparisonLive(cmp);
      await this.writeControl(cand, { opId, action: "none" });
      const workspaceId = this.deps.createCandidateWorkspace(cand.dir, cand.headStateId ?? cmp.baseStateId ?? null, cmp.id);
      const created = await this.deps.createCandidate({
        root: cand.dir,
        workspaceId,
        engine: cmp.engine,
        launch: { cmd, args, env },
        beforeSpawn: (terminalId) => {
          routedTerminalId = terminalId;
          this.installCandidateRouting(cmp, cand, terminalId, opId);
        },
      });
      launchedPid = created.pid;
      if (routedTerminalId === null) {
        routedTerminalId = created.terminalId;
        throw new Error("candidate terminal routing was not installed before spawn");
      }
      if (routedTerminalId !== created.terminalId) throw new Error("candidate terminal identity changed during startup");
      const terminalId = routedTerminalId;
      cand.terminalId = terminalId;
      cand.pid = created.pid;
      this.ensureComparisonLive(cmp);
      const pending = this.pendingCandidateReadies.get(terminalId);
      if (!pending) throw new Error("candidate startup handshake was not armed");
      await pending.promise;
      if (pending.state !== "accepted") throw new Error("candidate startup handshake did not complete");
      cand.lstart = created.pid > 0 ? await readProcessStart(created.pid) : null;
      launchedLstart = cand.lstart;
      if (pending.state !== "accepted") throw new Error("candidate exited during startup identity lookup");
      if (this.terminalToComparison.get(terminalId)?.comparisonId !== cmp.id || this.terminalToComparison.get(terminalId)?.label !== label) {
        throw new Error("candidate terminal routing changed during startup");
      }
      // Publish ready only after routing, process identity, and the exact
      // session_ready handshake have all completed.
      this.ensureComparisonLive(cmp);
      cand.state = "ready";
      cand.version++;
      cand.error = null;
      await this.updateManifest(cmp, cand);
      this.ensureComparisonLive(cmp);
      if (pending.state !== "accepted") throw new Error("candidate exited before ready was published");
      if (this.terminalToComparison.get(terminalId)?.comparisonId !== cmp.id || this.terminalToComparison.get(terminalId)?.label !== label) {
        throw new Error("candidate terminal routing changed before ready was published");
      }
      this.pushUpdate(cmp, cand);
      clearTimeout(pending.timer);
      this.pendingCandidateReadies.delete(terminalId);
      cand.startupAttemptId = undefined;
      return { ok: true, terminalId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.cleanupReopenedCandidate(cmp, cand, startupAttemptId, routedTerminalId, launchedPid, launchedLstart, message);
      return { ok: false, error: message };
    }
  }

  /** Remove one failed reopen and terminate only its exact process identity. */
  private async cleanupReopenedCandidate(
    cmp: ComparisonState,
    cand: CandidateState,
    startupAttemptId: string,
    terminalId: string | null,
    pid: number | null,
    lstart: string | null,
    error: string,
  ): Promise<void> {
    const pending = terminalId ? this.pendingCandidateReadies.get(terminalId) : undefined;
    if (pending) {
      if (pending.state === "pending") {
        pending.state = "failed";
        pending.reject(new Error(error));
      }
      clearTimeout(pending.timer);
      this.pendingCandidateReadies.delete(terminalId!);
    }
    if (terminalId) {
      const hit = this.terminalToComparison.get(terminalId);
      if (hit?.comparisonId === cmp.id && hit.label === cand.label && hit.startupAttemptId === startupAttemptId) {
        this.terminalToComparison.delete(terminalId);
      }
    }
    const ownsCandidate = cand.startupAttemptId === startupAttemptId;
    if (!ownsCandidate) {
      // A later reopen may already own the candidate. It is still safe to
      // terminate this failed attempt, but never let its error overwrite the
      // newer candidate lifecycle.
      await this.terminateCandidateProcess(terminalId, pid, lstart);
      return;
    }
    cand.startupAttemptId = undefined;
    cand.terminalId = null;
    cand.pid = null;
    cand.lstart = null;
    // Teardown owns the terminal's final lifecycle once cancellation or
    // discard has closed comparison admission. Do not overwrite that state
    // with a late startup error, although the exact process still needs the
    // same identity-checked cleanup below.
    if (cmp.phase !== "error" && !this.closingComparisons.has(cmp.id)) {
      cand.state = "error";
      cand.error = error;
      cand.version++;
      this.pushUpdate(cmp, cand);
    }
    await this.terminateCandidateProcess(terminalId, pid, lstart);
  }

  /** Process-group cleanup is identity-checked; the main owner closes the
   * terminal as a fallback when ps() cannot prove a start time. */
  private async terminateCandidateGroup(pid: number | null, lstart: string | null): Promise<void> {
    if (!pid || pid <= 0 || !lstart || !(await processStartMatches(pid, lstart))) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* The process can exit before the signal. */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    if (await processStartMatches(pid, lstart)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* The process can exit before the signal. */
      }
    }
  }

  private async terminateCandidateProcess(terminalId: string | null, pid: number | null, lstart: string | null): Promise<void> {
    await this.terminateCandidateGroup(pid, lstart);
    if (terminalId) this.deps.terminateCandidate?.(terminalId);
  }

  /** Cancel reopen waiters when the owning comparison is closed. */
  private cancelPendingCandidateReadies(comparisonId: string, error: string): void {
    for (const [terminalId, pending] of [...this.pendingCandidateReadies]) {
      if (pending.comparisonId !== comparisonId) continue;
      if (pending.state === "pending") {
        pending.state = "failed";
        pending.reject(new Error(error));
      }
      clearTimeout(pending.timer);
      this.pendingCandidateReadies.delete(terminalId);
    }
  }

  /** Mark the whole comparison failed and clean up. */
  private async teardown(comparisonId: string, state: WorldlineState, error: string | null, removeUncertain = false): Promise<void> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp) return;
    if (removeUncertain) cmp.removeUncertainRequested = true;
    if (cmp.teardownPromise) {
      await cmp.teardownPromise;
      return;
    }
    if (cmp.readyTimer) clearTimeout(cmp.readyTimer);
    cmp.phase = "error";
    cmp.error = error;
    this.cancelPendingCandidateReadies(comparisonId, error ?? `comparison ${state}`);
    this.closingComparisons.add(comparisonId);
    const teardown = (async (): Promise<void> => {
      // Close admission before aborting. Every request already handed to the
      // shared worker is cancelled and drained before its directory is even
      // considered for deletion. Candidate startup has the same exact
      // attempt fence, including a late process-start identity callback.
      await this.cancelCandidateLaunches(comparisonId);
      await this.cancelEvidence(comparisonId);
      await this.cancelSessionForks(comparisonId);
      await Promise.all([...cmp.candidates.values()].map((cand) => cand.headCommit.catch(() => undefined)));
      if (this.comparisons.get(comparisonId) !== cmp) return;

      // 1. Mark both candidates and push the final update.
      for (const cand of cmp.candidates.values()) {
        if (cand.state === "discarded") continue;
        cand.state = state;
        cand.error = error;
        cand.version++;
        this.pushUpdate(cmp, cand);
      }
      // 2. Terminate the exact candidate terminals/process groups. The main
      // owner is the safe fallback when a process-start proof is unavailable.
      await Promise.all([...cmp.candidates.values()].map((cand) =>
        this.terminateCandidateProcess(cand.terminalId, cand.pid, cand.lstart),
      ));

      // 3. Recompute after the drain: a worker may have reported an
      // uncertain commit while cancellation was in flight. A manifest write
      // failure is itself evidence that deletion cannot be proven safe.
      const retainUncertainArtifacts = (cmp.uncertainSessionArtifacts.length > 0 || cmp.manifestWriteFailed) && !cmp.removeUncertainRequested;
      let removed = false;
      if (!retainUncertainArtifacts) {
        removed = await this.removeOwnedDir(cmp.dir).catch((cleanupError) => {
          console.warn(`[worldlines] comparison cleanup retained: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          return false;
        });
      }
      if (retainUncertainArtifacts || !removed) {
        // A later explicit discard may start a second, already-closed drain.
        cmp.teardownPromise = null;
        return;
      }
      // 4. Release the bookkeeping.
      for (const [terminalId, hit] of [...this.terminalToComparison]) {
        if (hit.comparisonId === comparisonId) this.terminalToComparison.delete(terminalId);
      }
      this.comparisons.delete(comparisonId);
      this.closingComparisons.delete(comparisonId);
      await this.dropEvidence(comparisonId);
      this.deps.onRemoved(comparisonId);
    })();
    cmp.teardownPromise = teardown;
    await teardown;
  }

  /** Remove a worlds dir only when it is app-owned and canonical. */
  private async removeOwnedDir(dir: string): Promise<boolean> {
    // All mutation must stay below the descriptor-bound physical root. The
    // configured pathname can be replaced after startup; resolving it here
    // would let cleanup inspect or mutate an unrelated replacement tree.
    const worldsRoot = this.boundWorldsRootPath();
    const target = resolve(dir);
    let requestedTarget;
    try {
      requestedTarget = await lstatPath(target, { bigint: true });
    } catch {
      return false;
    }
    if (!requestedTarget.isDirectory() || requestedTarget.isSymbolicLink()) return false;
    let canonicalRoot: string;
    let canonicalTarget: string;
    try {
      [canonicalRoot, canonicalTarget] = await Promise.all([realpath(worldsRoot), realpath(target)]);
    } catch {
      return false;
    }
    if (!isInside(canonicalRoot, canonicalTarget)) return false;
    const rel = relative(canonicalRoot, canonicalTarget);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
    const components = rel.split(/[\\/]+/).filter(Boolean);
    if (components.length === 0 || components.some((component) => component === "." || component === ".." || component.includes("\0"))) return false;
    const parentPath = dirname(canonicalTarget);
    if (!isInside(canonicalRoot, parentPath)) return false;
    let rootInfo;
    let parentInfo;
    let targetInfo;
    let markerInfo;
    try {
      rootInfo = await lstatPath(canonicalRoot, { bigint: true });
      parentInfo = await lstatPath(parentPath, { bigint: true });
      targetInfo = await lstatPath(canonicalTarget, { bigint: true });
      markerInfo = await lstatPath(join(canonicalTarget, MARKER), { bigint: true });
    } catch {
      return false;
    }
    if (
      !rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()
      || !targetInfo.isDirectory() || targetInfo.isSymbolicLink()
      || !markerInfo.isFile() || markerInfo.isSymbolicLink()
    ) return false;
    const boundRoot = this.worldsRootBinding;
    if (!boundRoot || resolve(boundRoot.path) !== resolve(canonicalRoot)) return false;
    await boundPromotionRemoveTree({
      root: canonicalRoot,
      rootIdentity: promotionIdentityOf(boundRoot),
      components,
      parentIdentity: { dev: String(parentInfo.dev), ino: String(parentInfo.ino) },
      expectedIdentity: { dev: String(targetInfo.dev), ino: String(targetInfo.ino) },
    });
    return true;
  }

  /** Rehydrate retained uncertain evidence so an operator can explicitly discard it after restart. */
  private rehydrateUncertainComparison(manifest: ComparisonManifest, dir: string): void {
    if (this.comparisons.has(manifest.id)) return;
    const candidates = new Map<"A" | "B", CandidateState>();
    for (const label of ["A", "B"] as const) {
      const recorded = manifest.candidates[label];
      if (!recorded) continue;
      const fallbackDir = join(dir, label);
      const fallbackSupport = join(dir, `${label}-support`);
      const recordedDir = resolve(recorded.paths[0] ?? fallbackDir);
      const recordedSupport = resolve(recorded.paths[1] ?? fallbackSupport);
      const candidateDir = isInside(dir, recordedDir) ? recordedDir : fallbackDir;
      const supportDir = isInside(dir, recordedSupport) ? recordedSupport : fallbackSupport;
      candidates.set(label, {
        label,
        role: manifest.expectedCandidates === 1 ? "moment" : label === "A" ? "reference" : "alternative",
        dir: candidateDir,
        supportDir,
        homeDir: join(supportDir, "home"),
        sessionDir: join(supportDir, "sessions"),
        eventsDir: join(supportDir, "events"),
        tmpDir: join(supportDir, "tmp"),
        cacheDir: join(supportDir, "cache"),
        profilePath: join(dir, "profiles", `${label}.sb`),
        // An uncertain destination is deliberately not a valid session path.
        sessionFile: null,
        comparisonBaseStateId: null,
        promotionBaseStateId: null,
        headStateId: null,
        headCommit: Promise.resolve(),
        terminalId: null,
        pid: recorded.pid,
        lstart: recorded.lstart,
        state: "error",
        version: 1,
        error: manifest.uncertainSessionArtifacts[0]?.error ?? "retained uncertain comparison",
      });
    }
    const cmp: ComparisonState = {
      id: manifest.id,
      dir,
      templateDir: join(dir, "template"),
      sessionWorkspaceDir: join(dir, "session-workspace"),
      sourceRunId: manifest.sourceRunId,
      sourceGitDir: this.deps.primaryRoot,
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: null,
      inheritTrust: false,
      model: null,
      thinkingLevel: null,
      engine: "core",
      expectedCandidates: manifest.expectedCandidates,
      uncertainSessionArtifacts: [...manifest.uncertainSessionArtifacts],
      manifestWriteFailed: false,
      teardownPromise: null,
      uncertainAdmissionLease: null,
      removeUncertainRequested: false,
      createdAt: manifest.createdAt,
      candidates,
      phase: "error",
      error: manifest.uncertainSessionArtifacts[0]?.error ?? "retained uncertain comparison",
      readyTimer: null,
    };
    this.comparisons.set(cmp.id, cmp);
  }

  private pushUpdate(cmp: ComparisonState, cand: CandidateState): void {
    this.deps.onUpdate(this.summaryOf(cmp, cand));
  }

  private liveWorldlineCount(): number {
    let n = 0;
    for (const cmp of this.comparisons.values()) {
      if (cmp.phase === "running" || cmp.phase === "creating") n += cmp.candidates.size;
    }
    return n;
  }

  // ------------------------------------------------------- stale sweep ----

  /** After a crash, terminate stale candidate groups and remove their dirs. */
  private async sweepStale(): Promise<void> {
    const worldsRoot = this.boundWorldsRootPath();
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(worldsRoot);
    } catch {
      return;
    }
    let entries: string[];
    try {
      entries = await boundedWorldlineEntries(
        worldsRoot,
        MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES,
        `worldline root contains too many entries (${MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES}); resolve retained recovery evidence before retrying`,
      );
    } catch {
      return;
    }
    let adjacentBytes = 0n;
    for (const name of entries) {
      const dir = join(worldsRoot, name);
      let adjacentInfo: BigIntStats;
      try {
        adjacentInfo = await lstatPath(dir, { bigint: true });
      } catch {
        continue;
      }
      adjacentBytes += BigInt(Buffer.byteLength(name, "utf8")) + adjacentInfo.size;
      if (adjacentBytes > BigInt(MAX_STALE_SWEEP_BYTES)) return;
      let canonicalDir: string;
      try {
        canonicalDir = await realpath(dir);
      } catch {
        continue;
      }
      if (!isInside(canonicalRoot, canonicalDir) || !existsSync(join(canonicalDir, MARKER))) continue;
      let manifest: ComparisonManifest | null = null;
      try {
        const manifestPath = join(canonicalDir, "manifest.json");
        const manifestInfo = await lstatPath(manifestPath, { bigint: true });
        if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > BigInt(MAX_WORLDLINE_FILE_BYTES)) return;
        adjacentBytes += manifestInfo.size;
        if (adjacentBytes > BigInt(MAX_STALE_SWEEP_BYTES)) return;
        manifest = parseComparisonManifest(JSON.parse(await readFile(manifestPath, "utf8")));
      } catch {
        manifest = null;
      }
      if (!manifest) {
        console.warn(`[worldlines] unproven comparison manifest retained: ${canonicalDir}`);
        continue;
      }
      for (const candidate of Object.values(manifest.candidates)) {
        if (candidate.pid !== null && candidate.lstart && (await processStartMatches(candidate.pid, candidate.lstart))) {
          try {
            process.kill(-candidate.pid, "SIGKILL");
          } catch {
            /* The process can exit before the signal. */
          }
        }
      }
      if (manifest.status === "uncertain") {
        // Keep the comparison addressable after restart. It is intentionally
        // rehydrated as phase:error with no valid session paths; only explicit
        // discard may remove the retained directory and its evidence.
        this.rehydrateUncertainComparison(manifest, canonicalDir);
        continue;
      }
      if (manifest.status !== "complete" || manifest.uncertainSessionArtifacts.length > 0) continue;
      await this.removeOwnedDir(canonicalDir).catch(() => undefined);
    }
  }

  /** Discard every live comparison. */
  async dispose(): Promise<void> {
    this.sessionForkClosing = true;
    for (const fork of this.sessionForks) fork.controller.abort();
    await this.ready;
    await this.drainSessionForks();
    await Promise.all([...this.comparisons.values()].map((cmp) => this.teardown(cmp.id, "discarded", null)));
    // A creator can be between its source validation and comparison
    // materialization. Wait for the root-scoped owner lease to release so
    // shutdown cannot finish while that continuation still owns worldsRoot.
    await this.uncertainAdmissionOwner?.drain();
    this.releaseUncertainAdmissionParticipant?.();
    this.releaseUncertainAdmissionParticipant = null;
    this.clearRuns();
    await this.drainRetainedSessionDiscards();
  }
}

function waitBounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolvePromise(undefined);
    }, timeoutMs);
    void promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(undefined);
    });
  });
}

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("candidate startup was cancelled"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(new Error("candidate startup was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

/** Read the process start time without blocking the main process. */
function readProcessStart(pid: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    try {
      execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
        resolvePromise(error ? null : stdout.trim() || null);
      });
    } catch {
      // A restricted host may reject process inspection synchronously. The
      // caller remains fail-closed (no proven identity means no direct kill).
      resolvePromise(null);
    }
  });
}

/** Check that a pid still names the same process start time. */
async function processStartMatches(pid: number, lstart: string): Promise<boolean> {
  const current = await readProcessStart(pid);
  return current !== null && current === lstart;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

let promotionTransactionTail: Promise<void> = Promise.resolve();

/** Serialize every live promotion and startup/project-open recovery in this process. */
export async function withPromotionTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const previous = promotionTransactionTail;
  let release!: () => void;
  promotionTransactionTail = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

type PromotionArtifactEntry = { rel: string; dev: number; ino: number; state: PromotionEntryState };
type PromotionArtifactManifest =
  | { status: "planned"; path: string }
  | { status: "created"; path: string; entries: PromotionArtifactEntry[] };

async function createPromotionArtifactManifest(path: string): Promise<PromotionArtifactManifest> {
  const entries: PromotionArtifactEntry[] = [];
  const initialWorkBytes = Buffer.byteLength(path, "utf8");
  if (initialWorkBytes > MAX_PROMOTION_SCAN_WORK_BYTES) throw new Error("promotion artifact path exceeds its bounded work budget");
  const pending: Array<{ path: string; relative: string; depth: number; workBytes: number }> = [{ path, relative: ".", depth: 0, workBytes: initialWorkBytes }];
  let pendingWorkBytes = initialWorkBytes;
  let measuredBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    pendingWorkBytes -= current.workBytes;
    if (current.depth > MAX_PROMOTION_SCAN_DEPTH) throw new Error(`promotion artifact exceeds its ${MAX_PROMOTION_SCAN_DEPTH}-level depth bound`);
    const info = await lstatPath(current.path);
    if (!Number.isSafeInteger(info.size) || measuredBytes > MAX_PROMOTION_OPERATION_BYTES - info.size) throw new Error("promotion artifact exceeds its bounded byte budget");
    measuredBytes += info.size;
    const observed = await readPromotionEntry(current.path);
    const after = await lstatPath(current.path);
    if (!statIdentityEqual(info, after)) {
      throw new Error(`promotion artifact changed while recording: ${current.path}`);
    }
    if (entries.length >= MAX_PROMOTION_SCAN_ENTRIES) throw new Error(`promotion artifact exceeds its ${MAX_PROMOTION_SCAN_ENTRIES}-entry bound`);
    entries.push({ rel: current.relative, dev: info.dev, ino: info.ino, state: observed.state });
    if (!info.isDirectory()) continue;
    const names = await boundedWorldlineEntries(current.path, MAX_PROMOTION_SCAN_ENTRIES, `promotion artifact contains too many child entries`);
    names.sort().reverse();
    for (const name of names) {
      if (pending.length >= MAX_PROMOTION_SCAN_PENDING) throw new Error(`promotion artifact exceeds its ${MAX_PROMOTION_SCAN_PENDING}-entry pending bound`);
      const childPath = join(current.path, name);
      const childRelative = current.relative === "." ? name : join(current.relative, name);
      const workBytes = Buffer.byteLength(childPath, "utf8") + Buffer.byteLength(childRelative, "utf8");
      if (workBytes > MAX_PROMOTION_SCAN_WORK_BYTES || pendingWorkBytes > MAX_PROMOTION_SCAN_WORK_BYTES - workBytes) {
        throw new Error("promotion artifact scan exceeded its bounded work budget");
      }
      pending.push({ path: childPath, relative: childRelative, depth: current.depth + 1, workBytes });
      pendingWorkBytes += workBytes;
    }
  }
  return { status: "created", path, entries };
}

function parsePromotionArtifactManifest(value: unknown, field: string): PromotionArtifactManifest | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${field} manifest`);
  const manifest = value as Record<string, unknown>;
  if (manifest.status === "planned" && exactObjectKeys(manifest, ["status", "path"]) && typeof manifest.path === "string" && isAbsolute(manifest.path)) {
    return { status: "planned", path: manifest.path };
  }
  if (manifest.status !== "created" || !exactObjectKeys(manifest, ["status", "path", "entries"]) || typeof manifest.path !== "string" || !isAbsolute(manifest.path) || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_PROMOTION_SCAN_ENTRIES) {
    throw new Error(`invalid ${field} manifest`);
  }
  const entries = manifest.entries.map((value, index): PromotionArtifactEntry => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${field} manifest entry ${index}`);
    const entry = value as Record<string, unknown>;
    if (!exactObjectKeys(entry, ["rel", "dev", "ino", "state"]) || typeof entry.rel !== "string" || (entry.rel !== "." && !isSafePromotionRelativePath(entry.rel)) || !Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino)) {
      throw new Error(`invalid ${field} manifest entry ${index}`);
    }
    let state: PromotionEntryState;
    const raw = entry.state as Record<string, unknown> | null;
    if (raw?.type === "directory" && exactObjectKeys(raw, ["type", "mode"]) && Number.isInteger(raw.mode) && Number(raw.mode) >= 0 && Number(raw.mode) <= 0o777) {
      state = { type: "directory", mode: Number(raw.mode) };
    } else {
      state = parsePromotionJournalState(entry.state, entry.rel, "artifact");
      if (!isMaterializedPromotionState(state)) throw new Error(`invalid ${field} manifest state ${index}`);
    }
    return { rel: entry.rel, dev: Number(entry.dev), ino: Number(entry.ino), state };
  });
  if (entries.length === 0 || entries[0]?.rel !== "." || new Set(entries.map((entry) => entry.rel)).size !== entries.length) throw new Error(`invalid ${field} manifest entries`);
  return { status: "created", path: manifest.path, entries };
}

async function writePromotionJournal(binding: PromotionJournalBinding, journal: Record<string, unknown>): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(journal, null, 2));
  binding.journalFile = await boundPromotionWriteFile({
    root: binding.directory.path,
    rootIdentity: promotionIdentityOf(binding.directory),
    components: ["journal.json"],
    parentIdentity: promotionIdentityOf(binding.directory),
    expectedDestination: binding.journalFile ?? { state: { type: "missing" } },
    content: bytes,
    mode: 0o600,
  });
}

export type BoundPromotionDirectory = { path: string; dev: string; ino: string; capability?: string };
const PROMOTION_ROOT_PROVENANCE_VERSION = 1;
const PROMOTION_ROOT_PROVENANCE_PREFIX = ".termina-promotion-root-";
const PROMOTION_ROOT_PROVENANCE_MAX_BYTES = 4096;
type PromotionRootProvenance = {
  version: 1;
  path: string;
  parent: { dev: string; ino: string };
  root: { dev: string; ino: string };
};
type PromotionDirectoryPlan = {
  path: string;
  components: string[];
  identity: PromotionFsIdentity | null;
  missingAt: number | null;
  prefixIdentities: PromotionFsIdentity[];
};
type PromotionJournalBinding = {
  root: BoundPromotionDirectory;
  directory: BoundPromotionDirectory;
  name: string;
  journalFile: BoundPromotionExpectedLeaf | null;
};

async function writeComparisonManifestBound(
  root: BoundPromotionDirectory,
  manifest: ComparisonManifest,
  expectedDestination: BoundPromotionExpectedLeaf | { state: { type: "missing" } },
): Promise<BoundPromotionExpectedLeaf> {
  return boundPromotionWriteFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: ["manifest.json"],
    parentIdentity: promotionIdentityOf(root),
    expectedDestination,
    content: Buffer.from(JSON.stringify(manifest, null, 2)),
    mode: 0o600,
  });
}

async function writeComparisonMarkerBound(root: BoundPromotionDirectory): Promise<BoundPromotionExpectedLeaf> {
  return boundPromotionWriteFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: [MARKER],
    parentIdentity: promotionIdentityOf(root),
    expectedDestination: { state: { type: "missing" } },
    content: Buffer.from(randomUUID()),
    mode: 0o600,
  });
}

async function readComparisonManifestBound(
  root: BoundPromotionDirectory,
  expected: BoundPromotionExpectedLeaf | undefined,
): Promise<{ manifest: ComparisonManifest; leaf: BoundPromotionExpectedLeaf }> {
  const result = await boundPromotionReadFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: ["manifest.json"],
    parentIdentity: promotionIdentityOf(root),
    ...(expected ? { expectedIdentity: expected.identity } : {}),
    maxBytes: MAX_WORLDLINE_FILE_BYTES,
  });
  const parsed = parseComparisonManifest(JSON.parse(result.content.toString("utf8")) as unknown);
  if (!parsed) throw new Error("comparison manifest is invalid");
  return {
    manifest: parsed,
    leaf: {
      identity: result.identity,
      state: { type: "file", mode: 0o600, size: String(result.content.byteLength), sha256: sha256Hex(result.content) },
    },
  };
}

async function refreshBoundPromotionDirectory(bound: BoundPromotionDirectory): Promise<BoundPromotionDirectory> {
  let identity: PromotionFsIdentity;
  try {
    identity = await boundPromotionOpenDirectory({
      path: bound.path,
      expectedIdentity: { dev: bound.dev, ino: bound.ino },
      ...(bound.capability ? { capability: bound.capability } : {}),
    });
  } catch {
    // The native core may have restarted and forgotten its in-memory token.
    // Rebind only with the persisted identity; a replacement root still
    // fails this check before any ledger or admission write is attempted.
    identity = await boundPromotionOpenDirectory({
      path: bound.path,
      expectedIdentity: { dev: bound.dev, ino: bound.ino },
    });
  }
  return { path: bound.path, dev: identity.dev, ino: identity.ino, capability: identity.capability };
}

/** Rebind every retained comparison root after a native core restart. */
async function refreshComparisonBindings(cmp: ComparisonState): Promise<void> {
  if (cmp.rootBinding) {
    cmp.rootBinding = await refreshBoundPromotionDirectory(cmp.rootBinding);
    cmp.rootIdentity = promotionIdentityOf(cmp.rootBinding);
  }
  if (cmp.templateBinding) {
    cmp.templateBinding = await refreshBoundPromotionDirectory(cmp.templateBinding);
    cmp.templateIdentity = promotionIdentityOf(cmp.templateBinding);
  }
  if (cmp.profilesBinding) cmp.profilesBinding = await refreshBoundPromotionDirectory(cmp.profilesBinding);
  if (cmp.sessionWorkspaceBinding) cmp.sessionWorkspaceBinding = await refreshBoundPromotionDirectory(cmp.sessionWorkspaceBinding);
  for (const cand of cmp.candidates.values()) {
    if (cand.rootBinding) {
      cand.rootBinding = await refreshBoundPromotionDirectory(cand.rootBinding);
      cand.rootIdentity = promotionIdentityOf(cand.rootBinding);
    }
    for (const key of ["supportBinding", "homeBinding", "sessionBinding", "eventsBinding", "tmpBinding", "cacheBinding"] as const) {
      const binding = cand[key];
      if (binding) cand[key] = await refreshBoundPromotionDirectory(binding);
    }
  }
}

function assertBoundPromotionDirectory(bound: BoundPromotionDirectory): void {
  const info = lstatSync(bound.path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== bound.dev || String(info.ino) !== bound.ino) throw new Error(`promotion journal directory changed: ${bound.path}`);
}

function promotionIdentityOf(bound: BoundPromotionDirectory): PromotionFsIdentity {
  return {
    dev: bound.dev,
    ino: bound.ino,
    ...(bound.capability ? { capability: bound.capability } : {}),
  };
}

/** Create a new template root below the natively allocated comparison. */
async function createSnapshotTemplateDirectory(cmp: ComparisonState): Promise<BoundPromotionDirectory> {
  const root = cmp.rootBinding;
  if (!root) throw new Error("comparison root is not natively bound");
  const identity = await boundPromotionCreateDirectory({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: ["template"],
    parentIdentity: promotionIdentityOf(root),
    requireMissing: true,
  });
  cmp.templateIdentity = identity;
  const binding = { path: join(root.path, "template"), dev: identity.dev, ino: identity.ino, capability: identity.capability };
  cmp.templateBinding = binding;
  return binding;
}

/** Build a descriptor-bound parent proof for a first root bind. The native
 * opener validates this parent identity before opening or creating the leaf;
 * the mutable leaf itself is never used as its own trust anchor. */
async function trustedPromotionParent(path: string, field: string): Promise<{ path: string; identity: PromotionFsIdentity; name: string }> {
  const parentPath = dirname(path);
  const name = basename(path);
  if (!name || name === "." || name === ".." || name.includes("\0")) throw new Error(`${field} has an invalid leaf name`);
  const info = await lstatPath(parentPath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${field} parent is not a private directory`);
  return { path: parentPath, identity: { dev: String(info.dev), ino: String(info.ino) }, name };
}

/**
 * Establish a retained-root parent from the nearest existing ancestor.  The
 * ancestor identity is only a discovery hint; native prepare reopens it with
 * that exact identity and creates the missing tail descriptor-relatively.
 * This keeps the legacy `mkdir -p` behavior without making a mutable
 * pathname the trust anchor for the retained root transaction.
 */
async function ensureRetainedRootParent(path: string, field: string): Promise<BoundPromotionDirectory> {
  let current = resolve(path);
  const missing: string[] = [];
  let workBytes = Buffer.byteLength(current, "utf8");
  if (workBytes > MAX_PROMOTION_SCAN_WORK_BYTES) throw new Error(`${field} parent path exceeds its bounded work budget`);
  while (true) {
    let info;
    try {
      info = await lstatPath(current, { bigint: true });
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`${field} parent has no existing trusted ancestor`);
      if (missing.length >= MAX_PROMOTION_SCAN_DEPTH) throw new Error(`${field} parent exceeds its ${MAX_PROMOTION_SCAN_DEPTH}-level depth bound`);
      const component = basename(current);
      const componentBytes = Buffer.byteLength(component, "utf8");
      if (workBytes > MAX_PROMOTION_SCAN_WORK_BYTES - componentBytes) throw new Error(`${field} parent exceeds its bounded work budget`);
      workBytes += componentBytes;
      missing.unshift(component);
      current = parent;
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${field} parent is not an app-owned directory`);
    const canonical = await realpath(current);
    const ancestor: BoundPromotionDirectory = {
      path: canonical,
      dev: String(info.dev),
      ino: String(info.ino),
    };
    const probe = await boundPromotionPrepareDirectory({
      root: ancestor.path,
      rootIdentity: promotionIdentityOf(ancestor),
      components: missing,
      allowMissing: true,
    });
    let parentBinding: BoundPromotionDirectory;
    if (probe.identity) {
      parentBinding = {
        path: join(ancestor.path, ...missing),
        dev: probe.identity.dev,
        ino: probe.identity.ino,
        capability: probe.identity.capability,
      };
    } else {
      if (probe.missingAt === null) throw new Error(`${field} parent identity is unavailable`);
      const materialized = await boundPromotionPrepareDirectory({
        root: ancestor.path,
        rootIdentity: promotionIdentityOf(ancestor),
        components: missing,
        createMissing: true,
        expectedMissingAt: probe.missingAt,
        expectedChain: probe.chain,
      });
      if (!materialized.identity) throw new Error(`${field} parent could not be materialized`);
      parentBinding = {
        path: join(ancestor.path, ...missing),
        dev: materialized.identity.dev,
        ino: materialized.identity.ino,
        capability: materialized.identity.capability,
      };
    }
    return parentBinding;
  }
}

/** Store root provenance outside, never inside, the mutable root leaf. */
function promotionRootProvenancePath(path: string, provenanceDirectory?: BoundPromotionDirectory): string {
  const digest = createHash("sha256").update(path).digest("hex");
  return join(provenanceDirectory?.path ?? dirname(path), `${PROMOTION_ROOT_PROVENANCE_PREFIX}${digest}.json`);
}

function promotionRootProvenanceIdentity(value: unknown, field: string): { dev: string; ino: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${field}`);
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || typeof record.dev !== "string"
    || !/^\d+$/.test(record.dev)
    || typeof record.ino !== "string"
    || !/^\d+$/.test(record.ino)
  ) throw new Error(`invalid ${field}`);
  return { dev: record.dev, ino: record.ino };
}

async function readPromotionRootProvenance(
  absolute: string,
  parent: { path: string; identity: PromotionFsIdentity; name: string },
  field: string,
  provenanceDirectory?: BoundPromotionDirectory,
): Promise<PromotionRootProvenance | null> {
  const provenancePath = promotionRootProvenancePath(absolute, provenanceDirectory);
  let info;
  try {
    info = await lstatPath(provenancePath, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0n || info.size > BigInt(PROMOTION_ROOT_PROVENANCE_MAX_BYTES)) {
    throw new Error(`${field} root provenance is not a bounded regular file`);
  }
  const provenanceParent = provenanceDirectory ?? parent;
  const provenanceParentIdentity = provenanceDirectory
    ? promotionIdentityOf(provenanceDirectory)
    : parent.identity;
  const read = await boundPromotionReadFile({
    root: provenanceParent.path,
    rootIdentity: provenanceParentIdentity,
    components: [basename(provenancePath)],
    parentIdentity: provenanceParentIdentity,
    expectedIdentity: { dev: String(info.dev), ino: String(info.ino) },
    maxBytes: PROMOTION_ROOT_PROVENANCE_MAX_BYTES,
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.content)) as unknown;
  } catch {
    throw new Error(`${field} root provenance is malformed`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} root provenance is malformed`);
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4
    || record.version !== PROMOTION_ROOT_PROVENANCE_VERSION
    || record.path !== absolute
  ) throw new Error(`${field} root provenance is malformed`);
  const parentIdentity = promotionRootProvenanceIdentity(record.parent, `${field} root provenance parent`);
  const rootIdentity = promotionRootProvenanceIdentity(record.root, `${field} root provenance root`);
  if (parentIdentity.dev !== parent.identity.dev || parentIdentity.ino !== parent.identity.ino) {
    throw new Error(`${field} root provenance parent identity changed`);
  }
  return { version: 1, path: absolute, parent: parentIdentity, root: rootIdentity };
}

/** Create a directory component through the native descriptor boundary. */
async function ensureBoundChildDirectory(parent: BoundPromotionDirectory, name: string, requireMissing = false): Promise<BoundPromotionDirectory> {
  const identity = await boundPromotionCreateDirectory({
    root: parent.path,
    rootIdentity: promotionIdentityOf(parent),
    components: [name],
    parentIdentity: promotionIdentityOf(parent),
    requireMissing,
  });
  return { path: join(parent.path, name), dev: identity.dev, ino: identity.ino, capability: identity.capability };
}

/** Copy one optional private resource through both bound parent descriptors. */
async function copyBoundPrivateFile(
  sourcePath: string,
  destination: BoundPromotionDirectory,
  name: string,
): Promise<void> {
  const sourceInfo = await lstatPath(sourcePath, { bigint: true });
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("private resource is not a regular file");
  const sourceParentPath = dirname(sourcePath);
  const sourceParentInfo = await lstatPath(sourceParentPath, { bigint: true });
  if (!sourceParentInfo.isDirectory() || sourceParentInfo.isSymbolicLink()) throw new Error("private resource parent is not a real directory");
  const sourceParent = await boundPromotionOpenDirectory({
    path: sourceParentPath,
    expectedIdentity: { dev: String(sourceParentInfo.dev), ino: String(sourceParentInfo.ino) },
  });
  const source = await boundPromotionReadFile({
    root: sourceParentPath,
    rootIdentity: sourceParent,
    components: [basename(sourcePath)],
    parentIdentity: sourceParent,
    maxBytes: MAX_PI_RESOURCE_BYTES,
  });
  if (source.content.byteLength !== Number(sourceInfo.size)) throw new Error("private resource changed while reading");
  await boundPromotionCopyFile({
    sourceRoot: sourceParentPath,
    sourceRootIdentity: sourceParent,
    sourceComponents: [basename(sourcePath)],
    sourceParentIdentity: sourceParent,
    expectedSource: {
      identity: source.identity,
      state: {
        type: "file",
        mode: Number(sourceInfo.mode & 0o777n),
        size: String(source.content.byteLength),
        sha256: sha256Hex(source.content),
      },
    },
    destinationRoot: destination.path,
    destinationRootIdentity: promotionIdentityOf(destination),
    destinationComponents: [name],
    destinationParentIdentity: promotionIdentityOf(destination),
  });
}

/** Create every missing tail component below a read-only discovered root. */
async function ensureBoundDirectory(
  path: string,
  field: string,
  provenanceDirectory?: BoundPromotionDirectory,
  options: { bootstrapExisting?: boolean; initialIdentity?: PromotionFsIdentity } = {},
): Promise<BoundPromotionDirectory> {
  const requested = resolve(path);
  const canonicalParent = await filesystemCanonicalPath(dirname(requested));
  const absolute = join(canonicalParent, basename(requested));
  if (!isAbsolute(absolute)) throw new Error(`${field} must be absolute`);
  const trustedParent = await trustedPromotionParent(absolute, field);
  // A few narrow owner-level harnesses intentionally use the same directory
  // for worlds and primary roots. In that degenerate case the provenance
  // record cannot live inside its own mutable root; use the trusted parent
  // boundary (the normal worlds-root bootstrap path) instead.
  const rootProvenanceDirectory = provenanceDirectory && resolve(provenanceDirectory.path) !== absolute
    ? provenanceDirectory
    : undefined;
  const provenance = await readPromotionRootProvenance(absolute, trustedParent, field, rootProvenanceDirectory);
  if (provenance) {
    const identity = await boundPromotionEnsureDirectory({
      path: absolute,
      expectedIdentity: provenance.root,
    }).catch((error) => {
      throw new Error(`${field} could not be rebound natively: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (identity.dev !== provenance.root.dev || identity.ino !== provenance.root.ino) {
      throw new Error(`${field} root identity changed during rebind`);
    }
    return { path: absolute, dev: identity.dev, ino: identity.ino, capability: identity.capability };
  }
  const provenancePath = promotionRootProvenancePath(absolute, rootProvenanceDirectory);
  const provenanceParent = rootProvenanceDirectory ?? trustedParent;
  const provenanceParentIdentity = rootProvenanceDirectory
    ? promotionIdentityOf(rootProvenanceDirectory)
    : trustedParent.identity;
  // The sole migration path for pre-provenance app data. The native
  // descriptor-bound transaction creates a missing leaf exclusively or, only
  // when this explicit option is set, adopts an existing legacy leaf below
  // the verified parent. It persists external provenance while both
  // descriptors remain held, so a pathname replacement cannot be published.
  const identity = await boundPromotionEnsureDirectory({
    path: absolute,
    ...(options.initialIdentity ? { expectedIdentity: options.initialIdentity } : {}),
    trustedParent,
    ...(options.bootstrapExisting ? { bootstrapExisting: true } : {}),
    provenance: {
      name: basename(provenancePath),
      parent: {
        path: provenanceParent.path,
        identity: provenanceParentIdentity,
      },
    },
  }).catch((error) => {
    throw new Error(`${field} could not be bound natively: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { path: absolute, dev: identity.dev, ino: identity.ino, capability: identity.capability };
}

/**
 * Bind the retained-session root through the native create/adopt transaction.
 * The retained marker is mutable evidence, not provenance: the native
 * operation validates or creates it while the exact parent/leaf descriptors
 * remain open, and persists the external identity record in the same call.
 */
export async function ensureBoundRetainedRoot(
  path: string,
  field: string,
  marker: { name: string; content: Buffer; mode?: number },
  testHook?: { stage: string; readyPath: string; releasePath: string },
): Promise<BoundPromotionDirectory> {
  const requested = resolve(path);
  const parentBinding = await ensureRetainedRootParent(dirname(requested), field);
  const leafName = basename(requested);
  if (!leafName || leafName === "." || leafName === ".." || leafName.includes("\0")) throw new Error(`${field} has an invalid leaf name`);
  const trustedParent = { path: parentBinding.path, identity: promotionIdentityOf(parentBinding), name: leafName };
  const absolute = join(parentBinding.path, leafName);
  if (!isAbsolute(absolute)) throw new Error(`${field} must be absolute`);
  const provenancePath = promotionRootProvenancePath(absolute);
  const provenance = await readPromotionRootProvenance(absolute, trustedParent, field);
  const identity = await boundPromotionEnsureDirectory({
    path: absolute,
    ...(provenance ? { expectedIdentity: provenance.root } : {}),
    trustedParent,
    // A retained root is the one narrow legacy-disk bootstrap. The native
    // validator requires a real retained child for an existing unproven root,
    // so a copied marker/empty pathname can never be adopted.
    bootstrapExisting: true,
    provenance: {
      name: basename(provenancePath),
      parent: {
        path: trustedParent.path,
        identity: trustedParent.identity,
      },
    },
    marker,
    ...(testHook ? { testHook } : {}),
  }).catch((error) => {
    throw new Error(`${field} could not be bound natively: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (provenance && (identity.dev !== provenance.root.dev || identity.ino !== provenance.root.ino)) {
    throw new Error(`${field} root identity changed during rebind`);
  }
  return { path: absolute, dev: identity.dev, ino: identity.ino, capability: identity.capability };
}

function promotionDirectoryComponents(root: string, target: string, field: string): string[] {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (rel === "" || rel === ".") return [];
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${field} escapes its bound root`);
  const components = rel.split(/[\\/]+/).filter(Boolean);
  if (components.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error(`invalid ${field} components`);
  }
  return components;
}

/** Capture a parent identity from a native descriptor before path preflight. */
async function probePromotionDirectory(root: BoundPromotionDirectory, target: string, field: string): Promise<PromotionDirectoryPlan> {
  const path = resolve(target);
  const components = promotionDirectoryComponents(root.path, path, field);
  const result = await boundPromotionPrepareDirectory({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components,
    allowMissing: true,
  });
  const prefixLength = result.missingAt ?? components.length;
  if (result.chain.length !== prefixLength) throw new Error(`${field} native identity chain is incomplete`);
  return { path, components, identity: result.identity, missingAt: result.missingAt, prefixIdentities: result.chain };
}

/** Create a previously absent parent only from the trusted native root. */
async function materializePromotionDirectoryPlan(root: BoundPromotionDirectory, plan: PromotionDirectoryPlan, field: string): Promise<BoundPromotionDirectory> {
  if (plan.identity) return { path: plan.path, dev: plan.identity.dev, ino: plan.identity.ino, capability: plan.identity.capability };
  if (plan.missingAt === null) throw new Error(`${field} has no bound identity`);
  const identity = await boundPromotionPrepareDirectory({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: plan.components,
    createMissing: true,
    expectedMissingAt: plan.missingAt,
    expectedChain: plan.prefixIdentities,
  });
  if (!identity.identity) throw new Error(`${field} was not materialized`);
  return { path: plan.path, dev: identity.identity.dev, ino: identity.identity.ino, capability: identity.identity.capability };
}

/** Resolve/create a relative directory under an already bound directory. */
async function ensureBoundRelativeDirectory(root: BoundPromotionDirectory, components: string[], field: string): Promise<BoundPromotionDirectory> {
  let current = root;
  for (const name of components) {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw new Error(`invalid ${field} component`);
    current = await ensureBoundChildDirectory(current, name);
  }
  return current;
}

type PromotionEntryState =
  | { type: "missing" }
  | { type: "file"; mode?: number; hash: string }
  | { type: "symlink"; target: string }
  | { type: "directory"; mode: number }
  | { type: "other"; mode: number };

type PromotionJournalPath = {
  rel: string;
  kind: "write" | "delete";
  beforeHash: string;
  afterHash: string;
  beforeExists: boolean;
  retainedName?: string;
  beforeImageIdentity?: PromotionFsIdentity;
  beforeImageSize?: string;
  beforeState?: PromotionEntryState;
  afterState?: PromotionEntryState;
};
type CanonicalPath = (absPath: string) => Promise<string>;
export type PromotionRecoveryContext = {
  primaryRoot: string;
  piSessionRoot: string;
  coreSessionRoot: string;
  /** One-time migration for the default app-owned worlds directory only. */
  bootstrapExistingWorldsRoot?: boolean;
  /** Admit the user-selected project root on its first provenance bind. */
  bootstrapExistingPrimaryRoot?: boolean;
};
type PromotionRecoveryTestHook = (stage: "after-journal-validation", journalDir: string) => void | Promise<void>;
let promotionRecoveryTestHook: PromotionRecoveryTestHook | null = null;

/** Test-only deterministic interleaving seam; never exposed through IPC. */
export function setPromotionRecoveryTestHookForTest(hook: PromotionRecoveryTestHook | null): void {
  promotionRecoveryTestHook = hook;
}

async function runPromotionRecoveryTestHook(stage: "after-journal-validation", journalDir: string): Promise<void> {
  await promotionRecoveryTestHook?.(stage, journalDir);
}

type PromotionRollbackTemp =
  | { status: "planned"; rel: string; path: string; parent: string; parentDev: number; parentIno: number }
  | { status: "created"; rel: string; path: string; parent: string; parentDev: number; parentIno: number; dev: number; ino: number; state: PromotionEntryState };
type PromotionParentIdentity = { path: string; dev: number; ino: number; capability?: string };
const EMPTY_PROMOTION_HASH = sha256Hex(Buffer.alloc(0));
const SHA256_HEX = /^[0-9a-f]{64}$/;

function errnoCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function statIdentityEqual(a: { dev: number; ino: number; mode: number; size: number; mtimeMs: number }, b: { dev: number; ino: number; mode: number; size: number; mtimeMs: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function readPromotionEntry(abs: string): Promise<{ state: PromotionEntryState; bytes?: Buffer }> {
  let pathInfo;
  try {
    pathInfo = await lstatPath(abs);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { state: { type: "missing" } };
    throw error;
  }
  if (pathInfo.isSymbolicLink()) {
    const target = await readlink(abs);
    const after = await lstatPath(abs);
    if (!after.isSymbolicLink() || !statIdentityEqual(pathInfo, after)) throw new Error(`filesystem entry changed while reading: ${abs}`);
    return { state: { type: "symlink", target } };
  }
  if (pathInfo.isFile()) {
    const handle = await openFile(abs, fsConstants.O_RDONLY | promotionNoFollowFlag());
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error(`filesystem entry changed type while reading: ${abs}`);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const pathAfter = await lstatPath(abs);
      if (!after.isFile() || !pathAfter.isFile() || !statIdentityEqual(before, after) || before.dev !== pathAfter.dev || before.ino !== pathAfter.ino) {
        throw new Error(`filesystem entry changed while reading: ${abs}`);
      }
      return { state: { type: "file", mode: before.mode & 0o777, hash: sha256Hex(bytes) }, bytes };
    } finally {
      await handle.close();
    }
  }
  if (pathInfo.isDirectory()) return { state: { type: "directory", mode: pathInfo.mode & 0o777 } };
  return { state: { type: "other", mode: pathInfo.mode & 0o777 } };
}

function promotionStateHash(state: PromotionEntryState): string {
  if (state.type === "file") return state.hash;
  if (state.type === "symlink") return sha256Hex(Buffer.from(state.target));
  return sha256Hex(Buffer.alloc(0));
}

function isRestorablePromotionState(state: PromotionEntryState): state is Exclude<PromotionEntryState, { type: "directory" | "other" }> {
  return state.type === "missing" || state.type === "file" || state.type === "symlink";
}

function isMaterializedPromotionState(state: PromotionEntryState): state is Extract<PromotionEntryState, { type: "file" | "symlink" }> {
  return state.type === "file" || state.type === "symlink";
}

function promotionStatesEqual(actual: PromotionEntryState, expected: PromotionEntryState): boolean {
  if (actual.type !== expected.type) return false;
  if (actual.type === "missing") return true;
  if (actual.type === "file" && expected.type === "file") {
    return actual.hash === expected.hash && (expected.mode === undefined || actual.mode === expected.mode);
  }
  if (actual.type === "symlink" && expected.type === "symlink") return actual.target === expected.target;
  if (actual.type === "directory" && expected.type === "directory") return actual.mode === expected.mode;
  if (actual.type === "other" && expected.type === "other") return actual.mode === expected.mode;
  return false;
}

function promotionNoFollowFlag(): number {
  const flag = (fsConstants as Record<string, unknown>).O_NOFOLLOW;
  if (typeof flag !== "number" || flag === 0) throw new Error("promotion recovery requires O_NOFOLLOW support");
  return flag;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parsePromotionJournalState(value: unknown, rel: string, position: string): PromotionEntryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${position}-state at ${rel}`);
  const state = value as Record<string, unknown>;
  if (state.type === "missing" && exactObjectKeys(state, ["type"])) return { type: "missing" };
  if (
    state.type === "file"
    && exactObjectKeys(state, ["type", "mode", "hash"])
    && Number.isInteger(state.mode)
    && Number(state.mode) >= 0
    && Number(state.mode) <= 0o777
    && typeof state.hash === "string"
    && SHA256_HEX.test(state.hash)
  ) {
    return { type: "file", mode: Number(state.mode), hash: state.hash };
  }
  if (state.type === "symlink" && exactObjectKeys(state, ["type", "target"]) && typeof state.target === "string" && !state.target.includes("\0")) {
    return { type: "symlink", target: state.target };
  }
  throw new Error(`invalid ${position}-state at ${rel}`);
}

function validatePromotionJournalPaths(journal: Record<string, unknown>): PromotionJournalPath[] {
  if (!Array.isArray(journal.paths) || journal.paths.length > 2000) throw new Error("invalid promotion journal paths");
  const seen = new Set<string>();
  return journal.paths.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid promotion path record ${index}`);
    const record = value as Record<string, unknown>;
    const legacy = exactObjectKeys(record, ["rel", "kind", "beforeHash", "afterHash", "beforeExists"]);
    const current = exactObjectKeys(record, ["rel", "kind", "beforeHash", "afterHash", "beforeExists", "beforeState", "afterState"]);
    const currentWithRetained = exactObjectKeys(record, ["rel", "kind", "beforeHash", "afterHash", "beforeExists", "beforeState", "afterState", "retainedName"]);
    const currentWithBeforeImage = exactObjectKeys(record, ["rel", "kind", "beforeHash", "afterHash", "beforeExists", "beforeState", "afterState", "beforeImageIdentity", "beforeImageSize"]);
    const currentWithRetainedBeforeImage = exactObjectKeys(record, ["rel", "kind", "beforeHash", "afterHash", "beforeExists", "beforeState", "afterState", "retainedName", "beforeImageIdentity", "beforeImageSize"]);
    if (!legacy && !current && !currentWithRetained && !currentWithBeforeImage && !currentWithRetainedBeforeImage) throw new Error(`invalid promotion path schema ${index}`);
    if (
      typeof record.rel !== "string"
      || !isSafePromotionRelativePath(record.rel)
      || (record.kind !== "write" && record.kind !== "delete")
      || typeof record.beforeHash !== "string"
      || !SHA256_HEX.test(record.beforeHash)
      || typeof record.afterHash !== "string"
      || !SHA256_HEX.test(record.afterHash)
      || typeof record.beforeExists !== "boolean"
    ) {
      throw new Error(`invalid promotion path fields ${index}`);
    }
    if (record.retainedName !== undefined && (typeof record.retainedName !== "string" || !record.retainedName.startsWith(".termina-promotion-retained-") || !record.retainedName.endsWith(".tmp") || record.retainedName.includes("/") || record.retainedName.includes("\\"))) {
      throw new Error(`invalid promotion retained name ${index}`);
    }
    let beforeImageIdentity: PromotionFsIdentity | undefined;
    if (record.beforeImageIdentity !== undefined) {
      const identity = record.beforeImageIdentity as Record<string, unknown> | null;
      if (!identity || typeof identity !== "object" || Array.isArray(identity) || Object.keys(identity).length !== 2 || typeof identity.dev !== "string" || !/^\d+$/.test(identity.dev) || typeof identity.ino !== "string" || !/^\d+$/.test(identity.ino)) {
        throw new Error(`invalid before-image identity ${index}`);
      }
      beforeImageIdentity = { dev: identity.dev, ino: identity.ino };
    }
    let beforeImageSize: string | undefined;
    if (record.beforeImageSize !== undefined) {
      if (typeof record.beforeImageSize !== "string" || !/^\d+$/.test(record.beforeImageSize)) throw new Error(`invalid before-image size ${index}`);
      beforeImageSize = record.beforeImageSize;
    }
    if (seen.has(record.rel)) throw new Error(`duplicate promotion path: ${record.rel}`);
    seen.add(record.rel);

    let beforeState: PromotionEntryState;
    let afterState: PromotionEntryState;
    if (current || currentWithRetained) {
      beforeState = parsePromotionJournalState(record.beforeState, record.rel, "before");
      afterState = parsePromotionJournalState(record.afterState, record.rel, "after");
      if (!isRestorablePromotionState(beforeState) || !isRestorablePromotionState(afterState)) {
        throw new Error(`unsupported promotion state at ${record.rel}`);
      }
    } else {
      beforeState = record.beforeExists ? { type: "file", hash: record.beforeHash } : { type: "missing" };
      afterState = record.kind === "write" ? { type: "file", hash: record.afterHash } : { type: "missing" };
    }
    if ((beforeState.type !== "missing") !== record.beforeExists || promotionStateHash(beforeState) !== record.beforeHash) {
      throw new Error(`inconsistent before-state at ${record.rel}`);
    }
    if (record.kind === "write" && !isMaterializedPromotionState(afterState)) throw new Error(`invalid write after-state at ${record.rel}`);
    if (record.kind === "delete" && afterState.type !== "missing") throw new Error(`invalid delete after-state at ${record.rel}`);
    if (promotionStateHash(afterState) !== record.afterHash || (record.kind === "delete" && record.afterHash !== EMPTY_PROMOTION_HASH)) {
      throw new Error(`inconsistent after-state at ${record.rel}`);
    }
    return {
      rel: record.rel,
      kind: record.kind,
      beforeHash: record.beforeHash,
      afterHash: record.afterHash,
      beforeExists: record.beforeExists,
      retainedName: typeof record.retainedName === "string" ? record.retainedName : undefined,
      beforeImageIdentity,
      beforeImageSize,
      beforeState,
      afterState,
    };
  });
}

function validatePromotionRollbackTemps(journal: Record<string, unknown>): PromotionRollbackTemp[] {
  if (journal.rollbackTemps === undefined) return [];
  if (!Array.isArray(journal.rollbackTemps) || journal.rollbackTemps.length > 2000) throw new Error("invalid promotion rollback temps");
  return journal.rollbackTemps.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid rollback temp ${index}`);
    const record = value as Record<string, unknown>;
    const planned = record.status === "planned" && exactObjectKeys(record, ["status", "rel", "path", "parent", "parentDev", "parentIno"]);
    const created = record.status === "created" && exactObjectKeys(record, ["status", "rel", "path", "parent", "parentDev", "parentIno", "dev", "ino", "state"]);
    if (
      (!planned && !created)
      || typeof record.rel !== "string"
      || !isSafePromotionRelativePath(record.rel)
      || typeof record.path !== "string"
      || !isAbsolute(record.path)
      || typeof record.parent !== "string"
      || !isAbsolute(record.parent)
      || dirname(record.path) !== record.parent
      || !basename(record.path).startsWith(".termina-promotion-")
      || !basename(record.path).endsWith(".tmp")
      || !Number.isSafeInteger(record.parentDev)
      || !Number.isSafeInteger(record.parentIno)
    ) {
      throw new Error(`invalid rollback temp fields ${index}`);
    }
    const base = { status: record.status, rel: record.rel, path: record.path, parent: record.parent, parentDev: Number(record.parentDev), parentIno: Number(record.parentIno) };
    if (planned) return base as PromotionRollbackTemp;
    if (!Number.isSafeInteger(record.dev) || !Number.isSafeInteger(record.ino)) throw new Error(`invalid rollback temp identity ${index}`);
    const state = parsePromotionJournalState(record.state, record.rel, "before");
    if (!isMaterializedPromotionState(state)) throw new Error(`invalid rollback temp state ${index}`);
    return { ...base, status: "created", dev: Number(record.dev), ino: Number(record.ino), state };
  });
}

function validatePromotionJournalHeader(journal: Record<string, unknown>, primaryRoot: string): void {
  if (!isAbsolute(primaryRoot) || journal.primaryRoot !== primaryRoot) throw new Error("invalid promotion primary root");
  if (journal.phase !== "prepared" && journal.phase !== "applying" && journal.phase !== "applied") throw new Error("invalid active promotion phase");
  if (journal.engine !== undefined && journal.engine !== "pi" && journal.engine !== "core") throw new Error("invalid promotion engine");
  for (const field of ["stagedSession", "installedSession", "installedSessionTemp"] as const) {
    if (journal[field] !== undefined && journal[field] !== null && typeof journal[field] !== "string") {
      throw new Error(`invalid promotion ${field}`);
    }
  }
  if (typeof journal.installedSessionTemp === "string") {
    if (
      typeof journal.installedSession !== "string"
      || dirname(journal.installedSessionTemp) !== dirname(journal.installedSession)
      || basename(journal.installedSessionTemp) !== `.${basename(journal.installedSession)}.tmp`
    ) {
      throw new Error("invalid promotion installedSessionTemp");
    }
  }
  const installedManifest = parsePromotionArtifactManifest(journal.installedSessionManifest, "installedSession");
  const tempManifest = parsePromotionArtifactManifest(journal.installedSessionTempManifest, "installedSessionTemp");
  if ((typeof journal.installedSession === "string") !== Boolean(installedManifest)) throw new Error("installed session is missing its identity manifest");
  if ((typeof journal.installedSessionTemp === "string") !== Boolean(tempManifest)) throw new Error("installed session temp is missing its identity manifest");
}

async function assertPromotionState(abs: string, expected: PromotionEntryState, message: string): Promise<void> {
  if (!promotionStatesEqual((await readPromotionEntry(abs)).state, expected)) throw new Error(message);
}

async function copyBoundBeforeImage(
  sourceRoot: BoundPromotionDirectory,
  sourceComponents: string[],
  sourceParent: BoundPromotionDirectory,
  destinationRoot: BoundPromotionDirectory,
  destinationComponents: string[],
  expectedSource: BoundPromotionExpectedLeaf,
): Promise<BoundPromotionExpectedLeaf> {
  const destinationParent = await ensureBoundRelativeDirectory(
    destinationRoot,
    destinationComponents.slice(0, -1),
    "before-image",
  );
  return boundPromotionCopyFile({
    sourceRoot: sourceRoot.path,
    sourceRootIdentity: promotionIdentityOf(sourceRoot),
    sourceComponents,
    sourceParentIdentity: promotionIdentityOf(sourceParent),
    expectedSource,
    destinationRoot: destinationRoot.path,
    destinationRootIdentity: promotionIdentityOf(destinationRoot),
    destinationComponents,
    destinationParentIdentity: promotionIdentityOf(destinationParent),
  });
}

function isSafePromotionRelativePath(rel: string): boolean {
  return rel.length > 0 && rel !== "." && rel.indexOf("\0") === -1 && !isAbsolute(rel) && !rel.startsWith("/") && !rel.split(/[\\/]/).includes("..");
}

async function promotionDestination(primaryRoot: string, canonicalRoot: string, rel: string, canonicalPath: CanonicalPath): Promise<string> {
  if (!isAbsolute(primaryRoot) || !isSafePromotionRelativePath(rel)) {
    throw new Error(`promotion path escapes the primary project: ${rel}`);
  }
  const abs = join(primaryRoot, rel);
  if (!isInside(canonicalRoot, await canonicalPath(abs))) {
    throw new Error(`promotion path escapes the primary project: ${rel}`);
  }
  // This rejects stationary symlink escapes for policy/preflight reads. The
  // actual promotion mutation is descriptor-relative in the native core; the
  // path result is never passed to a destructive rm/rename sink.
  return abs;
}

async function filesystemCanonicalPath(absPath: string): Promise<string> {
  let tail = "";
  let current = absPath;
  while (true) {
    try {
      const canonical = await realpath(current);
      return tail ? join(canonical, tail) : canonical;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return absPath;
      tail = tail ? join(basename(current), tail) : basename(current);
      current = parent;
    }
  }
}

async function promotionParentIdentity(abs: string, canonicalRoot: string, canonicalPath: CanonicalPath, prebound: PromotionDirectoryPlan): Promise<PromotionParentIdentity> {
  const parent = await canonicalPath(dirname(abs));
  if (!isInside(canonicalRoot, parent)) throw new Error(`promotion parent escapes the primary project: ${abs}`);
  if (resolve(prebound.path) !== resolve(parent)) {
    throw new Error(`promotion parent binding does not match the requested path: ${abs}`);
  }
  const identity = prebound.identity;
  if (!identity) throw new Error(`promotion parent is not present: ${parent}`);
  return { path: parent, dev: Number(identity.dev), ino: Number(identity.ino), capability: identity.capability };
}

async function boundPromotionExpectedLeaf(abs: string, expected: PromotionEntryState, field: string): Promise<BoundPromotionExpectedLeaf> {
  if (!isMaterializedPromotionState(expected)) throw new Error(`${field} is not a materialized promotion state`);
  const observed = await readPromotionEntry(abs);
  if (!promotionStatesEqual(observed.state, expected)) throw new Error(`${field} changed before native transition`);
  const info = await lstatPath(abs, { bigint: true });
  const identity = { dev: String(info.dev), ino: String(info.ino) };
  if (expected.type === "file") {
    if (!observed.bytes) throw new Error(`${field} file bytes were not read`);
    return {
      identity,
      state: {
        type: "file",
        mode: expected.mode ?? Number(info.mode & 0o777n),
        size: String(observed.bytes.byteLength),
        sha256: expected.hash,
      },
    };
  }
  return { identity, state: { type: "symlink", target: expected.target } };
}

function promotionDestinationComponents(primaryRoot: string, parent: string, rel: string): string[] {
  const parentRel = relative(primaryRoot, parent);
  const parts = parentRel ? parentRel.split(/[\\/]+/).filter(Boolean) : [];
  const destination = basename(rel);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0")) || !destination || destination === "." || destination === "..") {
    throw new Error(`invalid native promotion destination: ${rel}`);
  }
  return [...parts, destination];
}

function promotionParentComponents(root: string, parent: string): string[] {
  const parentRel = relative(root, parent);
  if (!parentRel) return [];
  const parts = parentRel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) throw new Error(`invalid native promotion parent: ${parent}`);
  return parts;
}

function promotionSourceComponents(rel: string): string[] {
  if (!isSafePromotionRelativePath(rel)) throw new Error(`invalid native promotion source: ${rel}`);
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0")) || parts.length === 0) {
    throw new Error(`invalid native promotion source: ${rel}`);
  }
  return parts;
}

async function rollbackPromotionPaths(
  journalDir: string,
  journal: Record<string, unknown>,
  primaryRoot: string,
  canonicalPath: CanonicalPath,
  journalBinding?: PromotionJournalBinding,
  primaryRootBinding?: BoundPromotionDirectory,
  readonlyJournal = false,
): Promise<boolean> {
  const persistJournal = async (): Promise<void> => {
    if (readonlyJournal) return;
    if (!journalBinding) throw new Error("promotion journal binding is missing");
    await writePromotionJournal(journalBinding, journal);
  };
  const persistConflict = async (value: unknown): Promise<void> => {
    if (readonlyJournal) return;
    if (!journalBinding) throw new Error("promotion journal binding is missing");
    await boundPromotionWriteFile({
      root: journalBinding.directory.path,
      rootIdentity: promotionIdentityOf(journalBinding.directory),
      components: ["conflict.json"],
      parentIdentity: promotionIdentityOf(journalBinding.directory),
      expectedDestination: { state: { type: "missing" } },
      content: Buffer.from(JSON.stringify(value, null, 2)),
      mode: 0o600,
    });
  };
  if (journalBinding) assertBoundPromotionDirectory(journalBinding.directory);
  validatePromotionJournalHeader(journal, primaryRoot);
  const paths = validatePromotionJournalPaths(journal);
  validatePromotionRollbackTemps(journal);
  // Bind the recovery root and every currently-existing destination parent
  // before reading mutable primary entries.  Recovery must not turn a journal
  // path into a fresh trust decision after an ancestor swap.
  const primaryRootBindingResolved = primaryRootBinding ?? await ensureBoundDirectory(primaryRoot, "promotion recovery primary root");
  const parentPlans = new Map<string, PromotionDirectoryPlan>();
  for (const path of paths) {
    const parentPath = resolve(dirname(join(primaryRoot, path.rel)));
    if (!parentPlans.has(parentPath)) {
      parentPlans.set(parentPath, await probePromotionDirectory(primaryRootBindingResolved, parentPath, "promotion recovery parent"));
    }
  }
  const canonicalRoot = await canonicalPath(primaryRoot);
  // Rollback temps are retained evidence. Removing one by pathname after an
  // identity check is a check-to-use race and can delete a replacement; the
  // native exchange/retire boundary below preserves both operands instead.
  const conflictPaths: string[] = [];
  for (const p of paths) {
    let restoreTmp: string | null = null;
    let restoreRecord: PromotionRollbackTemp | null = null;
    let restoreExpected: BoundPromotionExpectedLeaf | null = null;
    try {
      const beforeState = p.beforeState!;
      const afterState = p.afterState!;
      let abs = await promotionDestination(primaryRoot, canonicalRoot, p.rel, canonicalPath);
      const current = (await readPromotionEntry(abs)).state;
      if (promotionStatesEqual(current, beforeState)) continue;
      if (!promotionStatesEqual(current, afterState)) throw new Error(`filesystem state conflicts at ${p.rel}`);

      let beforeExpected: BoundPromotionExpectedLeaf | null = null;
      if (beforeState.type === "file") {
        const savedPath = join(journalDir, "before", p.rel);
        if (!journalBinding) throw new Error(`before-image journal binding is missing at ${p.rel}`);
        assertBoundPromotionDirectory(journalBinding.directory);
        if (p.beforeImageIdentity && p.beforeImageSize) {
          beforeExpected = {
            identity: p.beforeImageIdentity,
            state: {
              type: "file",
              mode: beforeState.mode ?? 0o644,
              size: p.beforeImageSize,
              sha256: beforeState.hash,
            },
          };
        } else {
          // Journals written before the native evidence boundary have no
          // persisted image identity. Read only to derive a one-time expected
          // descriptor; the native copy below still rejects a replacement.
          const saved = await readPromotionEntry(savedPath);
          if (saved.state.type !== "file" || saved.state.hash !== beforeState.hash || !saved.bytes) throw new Error(`before-image is corrupt at ${p.rel}`);
          beforeExpected = await boundPromotionExpectedLeaf(savedPath, beforeState, `before-image ${p.rel}`);
        }
      }
      if (beforeState.type === "file" || beforeState.type === "symlink") {
        const parentPlan = parentPlans.get(resolve(dirname(abs)));
        if (!parentPlan) throw new Error(`promotion recovery parent was not pre-bound: ${dirname(abs)}`);
        const parent = await promotionParentIdentity(abs, canonicalRoot, canonicalPath, parentPlan);
        restoreTmp = join(parent.path, `.termina-promotion-${randomUUID()}.tmp`);
        restoreRecord = { status: "planned", rel: p.rel, path: restoreTmp, parent: parent.path, parentDev: parent.dev, parentIno: parent.ino };
        journal.rollbackTemps = [restoreRecord];
        await persistJournal();
        const primaryRootInfo = primaryRootBindingResolved;
        const primaryParent: BoundPromotionDirectory = { path: parent.path, dev: String(parent.dev), ino: String(parent.ino) };
        const tempComponents = [...promotionParentComponents(primaryRoot, parent.path), basename(restoreTmp)];
        if (beforeState.type === "file") {
          if (!beforeExpected || !journalBinding) throw new Error(`before-image expectation is missing at ${p.rel}`);
          const beforeParent = await ensureBoundRelativeDirectory(journalBinding.directory, ["before", ...promotionSourceComponents(p.rel).slice(0, -1)], "before-image rollback parent");
          restoreExpected = await boundPromotionCopyFile({
            sourceRoot: journalBinding.directory.path,
            sourceRootIdentity: promotionIdentityOf(journalBinding.directory),
            sourceComponents: ["before", ...promotionSourceComponents(p.rel)],
            sourceParentIdentity: promotionIdentityOf(beforeParent),
            expectedSource: beforeExpected,
            destinationRoot: primaryRootInfo.path,
            destinationRootIdentity: promotionIdentityOf(primaryRootInfo),
            destinationComponents: tempComponents,
            destinationParentIdentity: promotionIdentityOf(primaryParent),
          });
        } else {
          const created = await boundPromotionCreateSymlink({
            root: primaryRootInfo.path,
            rootIdentity: promotionIdentityOf(primaryRootInfo),
            components: tempComponents,
            parentIdentity: promotionIdentityOf(primaryParent),
            target: beforeState.target,
          });
          restoreExpected = created;
        }
        if (!restoreExpected) throw new Error(`rollback temp was not created at ${p.rel}`);
        const restoreState: PromotionEntryState = restoreExpected.state.type === "file"
          ? { type: "file", mode: restoreExpected.state.mode, hash: restoreExpected.state.sha256 }
          : { type: "symlink", target: restoreExpected.state.target };
        restoreRecord = { ...restoreRecord, status: "created", dev: Number(restoreExpected.identity.dev), ino: Number(restoreExpected.identity.ino), state: restoreState };
        journal.rollbackTemps = [restoreRecord];
        await persistJournal();
      }

      abs = await promotionDestination(primaryRoot, canonicalRoot, p.rel, canonicalPath);
      const finalParentPlan = parentPlans.get(resolve(dirname(abs)));
      if (!finalParentPlan) throw new Error(`promotion recovery parent was not pre-bound: ${dirname(abs)}`);
      const finalParent = await promotionParentIdentity(abs, canonicalRoot, canonicalPath, finalParentPlan);
      if (restoreRecord && (finalParent.path !== restoreRecord.parent || finalParent.dev !== restoreRecord.parentDev || finalParent.ino !== restoreRecord.parentIno)) {
        throw new Error(`promotion parent changed before rollback at ${p.rel}`);
      }
      if (beforeState.type === "missing") {
        await assertPromotionState(abs, afterState, `filesystem state changed before rollback at ${p.rel}`);
        const rootIdentity = promotionIdentityOf(primaryRootBindingResolved);
        const parentIdentity = { dev: String(finalParent.dev), ino: String(finalParent.ino) };
        const retainedName = basename(p.retainedName ?? `.termina-promotion-retained-${sha256Hex(Buffer.from(`${journal.opId ?? "promotion"}:${p.rel}`)).slice(0, 24)}.tmp`);
        if (!p.retainedName) {
          p.retainedName = retainedName;
          journal.paths = paths;
          await persistJournal();
        }
        const result = await boundPromotionTransition({
          primaryRoot,
          primaryRootIdentity: rootIdentity,
          destinationComponents: promotionDestinationComponents(primaryRoot, finalParent.path, p.rel),
          parentIdentity,
          transition: {
            kind: "retire",
            retainedName,
            expectedDestination: await boundPromotionExpectedLeaf(abs, afterState, `promotion destination ${p.rel}`),
          },
        });
        if (result.outcome !== "applied" || !result.durable) throw new Error(result.error ?? `promotion retire conflict at ${p.rel}`);
        p.retainedName = retainedName;
      } else if (restoreTmp) {
        if (!restoreRecord || restoreRecord.status !== "created") throw new Error(`rollback temp was not committed at ${p.rel}`);
        await assertPromotionState(abs, afterState, `filesystem state changed before rollback at ${p.rel}`);
        const rootIdentity = promotionIdentityOf(primaryRootBindingResolved);
        const parentIdentity = { dev: String(finalParent.dev), ino: String(finalParent.ino) };
        if (!restoreExpected) throw new Error(`rollback temp expectation is missing at ${p.rel}`);
        const expectedSource = restoreExpected;
        const result = afterState.type === "missing"
          ? await boundPromotionTransition({
              primaryRoot,
              primaryRootIdentity: rootIdentity,
              destinationComponents: promotionDestinationComponents(primaryRoot, finalParent.path, p.rel),
              parentIdentity,
              transition: {
                kind: "install",
                sourceRoot: primaryRoot,
                sourceRootIdentity: rootIdentity,
                sourceComponents: promotionSourceComponents(relative(primaryRoot, restoreTmp)),
                sourceParentIdentity: parentIdentity,
                expectedSource,
                expectedDestination: { state: { type: "missing" } },
              },
            })
          : await boundPromotionTransition({
              primaryRoot,
              primaryRootIdentity: rootIdentity,
              destinationComponents: promotionDestinationComponents(primaryRoot, finalParent.path, p.rel),
              parentIdentity,
              transition: {
                kind: "exchange",
                sourceName: basename(restoreTmp),
                expectedSource,
                expectedDestination: await boundPromotionExpectedLeaf(abs, afterState, `promotion destination ${p.rel}`),
              },
            });
        if (result.outcome !== "applied" || !result.durable) throw new Error(result.error ?? `promotion exchange conflict at ${p.rel}`);
      } else {
        throw new Error(`unsupported before-state at ${p.rel}`);
      }
      await assertPromotionState(abs, beforeState, `rollback verification failed at ${p.rel}`);
    } catch {
      conflictPaths.push(typeof p.rel === "string" ? p.rel : "<invalid path>");
    }
  }
  const conflicted = conflictPaths.length > 0;
  if (conflicted) {
    journal.phase = "conflict";
    await persistJournal();
    await persistConflict({ at: Date.now(), paths: conflictPaths });
    return false;
  }
  return true;
}

async function rollbackPromotion(
  journalDir: string,
  journal: Record<string, unknown>,
  primaryRoot: string,
  canonicalPath: CanonicalPath,
  journalBinding?: PromotionJournalBinding,
  primaryRootBinding?: BoundPromotionDirectory,
): Promise<boolean> {
  const phase = String(journal.phase ?? "prepared");
  if (!["prepared", "applying", "applied"].includes(phase)) {
    // A failed live promotion retains unexpected-phase evidence as well. The
    // directory pathname is not deletion provenance once control left the
    // creation step; only the successful completion path removes its own
    // freshly created journal.
    return false;
  }
  return rollbackPromotionPaths(journalDir, journal, primaryRoot, canonicalPath, journalBinding, primaryRootBinding);
}

/** Startup recovery: finish or roll back every pending promotion journal. */
export async function recoverPromotionJournals(worldsRoot: string, context: PromotionRecoveryContext): Promise<void> {
  // The context is the only explicit migration authority. An unconditional
  // bootstrap here would adopt an existing unproven worlds root before the
  // strict inner recovery bind gets a chance to reject missing/corrupt
  // outside-root provenance.
  const binding = await ensureBoundDirectory(
    worldsRoot,
    "worlds root",
    undefined,
    { bootstrapExisting: context.bootstrapExistingWorldsRoot === true },
  );
  const owner = promotionJournalAdmissionOwnerFor(binding);
  return withPromotionTransaction(() => owner.withLock(() => recoverPromotionJournalsUnderTransaction(worldsRoot, context)));
}

/**
 * Establish the current-format promotion roots for a freshly-created fixture.
 *
 * This deliberately delegates to the same strict binder used by startup and
 * recovery: missing leaves are created below a trusted parent and receive a
 * persisted identity; an existing unproven leaf is rejected rather than
 * adopted. Production startup never calls this setup helper.
 */
export async function ensurePromotionRoots(worldsRoot: string, primaryRoot: string): Promise<void> {
  return withPromotionTransaction(async () => {
    const worldsRootBinding = await ensureBoundDirectory(worldsRoot, "worlds root");
    await ensureBoundDirectory(primaryRoot, "primary root", worldsRootBinding);
  });
}

/** Stop the shared native helper when a focused Worldline harness exits. */
export function disposeWorldlineCoreClient(): void {
  coreClient.dispose();
}

async function recoverPromotionJournalsUnderTransaction(worldsRoot: string, context: PromotionRecoveryContext): Promise<void> {
  let root: BoundPromotionDirectory;
  let primaryRootBinding: BoundPromotionDirectory;
  let entries: Array<{ name: string; identity: PromotionFsIdentity }>;
  try {
    // Bind the app-owned worlds root from its trusted parent first. The
    // recovery journal itself is then opened as a child of that capability;
    // no first identity is accepted from a mutable journal pathname.
    const worldsRootBinding = await ensureBoundDirectory(
      worldsRoot,
      "worlds root",
      undefined,
      { bootstrapExisting: context.bootstrapExistingWorldsRoot === true },
    );
    primaryRootBinding = await ensureBoundDirectory(
      context.primaryRoot,
      "promotion recovery primary root",
      worldsRootBinding,
      { bootstrapExisting: context.bootstrapExistingPrimaryRoot === true },
    );
    const rootPath = join(worldsRootBinding.path, "promotion-journal");
    const identity = await boundPromotionPrepareDirectory({
      root: worldsRootBinding.path,
      rootIdentity: promotionIdentityOf(worldsRootBinding),
      components: ["promotion-journal"],
      createMissing: true,
    });
    if (!identity.identity) return;
    root = {
      path: rootPath,
      dev: identity.identity.dev,
      ino: identity.identity.ino,
      capability: identity.identity.capability,
    };
    entries = await boundPromotionListDirectories({
      root: root.path,
      rootIdentity: promotionIdentityOf(root),
    });
  } catch (error) {
    console.warn(`[worldline] promotion root bind failed closed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const entry of entries) {
    let dir: BoundPromotionDirectory;
    try {
      assertBoundPromotionDirectory(root);
      dir = { path: join(root.path, entry.name), dev: entry.identity.dev, ino: entry.identity.ino };
    } catch {
      continue;
    }
    let journal: Record<string, unknown> | null = null;
    try {
      assertBoundPromotionDirectory(dir);
      await runPromotionRecoveryTestHook("after-journal-validation", dir.path);
      const journalBytes = await readBoundPromotionJournal({
        journalRoot: root.path,
        journalRootIdentity: promotionIdentityOf(root),
        operationName: basename(dir.path),
        operationIdentity: { dev: dir.dev, ino: dir.ino },
      });
      journal = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(journalBytes)) as Record<string, unknown>;
    } catch {
      // Recovery never writes a marker into a journal-selected path. A bound
      // directory can still be swapped after a path identity check, and Node
      // offers no descriptor-relative atomic marker creation here.
      console.warn(`[worldline] unreadable promotion journal retained: ${dir.path}`);
      continue;
    }
    try {
      const phase = String(journal.phase ?? "prepared");
      const primaryRoot = String(journal.primaryRoot ?? "");
      if (primaryRoot !== context.primaryRoot) continue;
      if (!["prepared", "applying", "applied"].includes(phase)) {
        if (phase === "conflict") continue;
        if (phase === "done" || phase === "rolled-back") continue;
        console.warn(`[worldline] promotion journal with unknown phase retained: ${dir.path}`);
        continue;
      }
      const recoveryBinding: PromotionJournalBinding = {
        root,
        directory: dir,
        name: entry.name,
        journalFile: null,
      };
      const rolledBack = await rollbackPromotionPaths(
        dir.path,
        journal,
        primaryRoot,
        filesystemCanonicalPath,
        recoveryBinding,
        primaryRootBinding,
        true,
      );
      if (rolledBack) {
        // Do not delete installed sessions, rollback temps, or the journal in
        // recovery. Journal-provided paths/manifests are not sufficient
        // provenance to destroy a live Pi/core session, and Node cannot make
        // the final remove sink descriptor-relative.
        console.warn(`[worldline] promotion journal recovered with artifacts retained: ${dir.path}`);
      } else {
        console.warn(`[worldline] promotion recovery conflict: ${dir.path} — kept every version`);
      }
    } catch {
      console.warn(`[worldline] promotion recovery failed closed: ${dir.path}`);
    }
  }
}
