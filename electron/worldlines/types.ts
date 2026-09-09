/**
 * Shared internal types for the worldline owner (`electron/worldlines/`).
 * Pure types only; every runtime helper stays in its lifecycle module.
 * `worldlines.ts` re-exports the public surface during the extraction.
 */
import type { BoundPromotionExpectedLeaf, PromotionFsIdentity } from "../worldline-git.js";
import type { WorldlineState } from "../../shared/types.js";

export interface CandidateState {
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

export interface ComparisonState {
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
  /** The model and thinking level of the source run. */
  model: string | null;
  thinkingLevel: string | null;
  /** Which engine produced the source run. Core is the only engine. */
  engine: "core";
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

export type ComparisonManifestStatus = "creating" | "complete" | "uncertain";
export type ComparisonManifestCandidate = { pid: number | null; lstart: string | null; paths: string[] };
export type ComparisonManifest = {
  id: string;
  sourceRunId: string;
  createdAt: number;
  status: ComparisonManifestStatus;
  expectedCandidates: 1 | 2;
  candidates: Record<string, ComparisonManifestCandidate>;
  uncertainSessionArtifacts: Array<{ path: string; error: string }>;
};

export type UncertainComparisonMeasurement =
  | { ok: true; bytes: number; entries: number; proof: string }
  | { ok: false; error: string };

export type UncertainComparisonUsage = { count: number; bytes: number; entries: number };

export type UncertainComparisonIdentity = {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
};

export type UncertainComparisonLedgerEntry = {
  name: string;
  identity: UncertainComparisonIdentity;
  counted: boolean;
  bytes: number;
  entries: number;
  /** Metadata Merkle proof for every owned node, including nested children. */
  proof: string;
};

export type UncertainComparisonLedgerReservation = {
  token: string;
  pid: number;
  bytes: number;
};

export type UncertainComparisonUsageLedger = {
  version: 1;
  root: { dev: string; ino: string };
  entries: UncertainComparisonLedgerEntry[];
  reservations: UncertainComparisonLedgerReservation[];
  usage: UncertainComparisonUsage;
};

export type UncertainComparisonAdmissionLease = {
  release(): void;
  bind?(comparisonId: string): void;
};

export type UncertainComparisonAdmissionOwnerLease = {
  release(): void;
  bind?(comparisonId: string): void;
};

export type UncertainComparisonAdmissionOwnerResult =
  | { ok: true; lease: UncertainComparisonAdmissionOwnerLease }
  | { ok: false; error: string };

export type UncertainComparisonParticipant = () => ReadonlySet<string>;

export type PromotionRetentionUsage = { journalCount: number; bytes: bigint };

export type PromotionJournalUsageLedger = {
  version: 1;
  root: { dev: string; ino: string };
  usage: { journalCount: number; bytes: string };
  reservation: { token: string; pid: number; journalCount: number; bytes: string } | null;
};

export type PromotionJournalAdmissionLease = {
  release(): Promise<void>;
};

export type PromotionJournalAdmissionResult =
  | { ok: true; lease: PromotionJournalAdmissionLease }
  | { ok: false; error: string };

export type PromotionOperationBudget = { used: bigint; max: bigint };

export type TrackedSessionFork = {
  comparisonId: string;
  controller: AbortController;
  promise: Promise<unknown>;
};

export type CandidateReadyEvent = {
  bridgeId?: string;
  seq?: number;
  generation?: string;
  opId?: string;
};

export type CandidateLaunchAttempt = {
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

export type EvidenceAttempt = {
  id: string;
  comparisonId: string;
  controller: AbortController;
  promise: Promise<{ ok: boolean; error?: string }> | null;
};

export type PendingCandidateReady = {
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

export type PromotionArtifactEntry = { rel: string; dev: number; ino: number; state: PromotionEntryState };
export type PromotionArtifactManifest =
  | { status: "planned"; path: string }
  | { status: "created"; path: string; entries: PromotionArtifactEntry[] };

export type BoundPromotionDirectory = { path: string; dev: string; ino: string; capability?: string };

export type PromotionRootProvenance = {
  version: 1;
  path: string;
  parent: { dev: string; ino: string };
  root: { dev: string; ino: string };
};
export type PromotionDirectoryPlan = {
  path: string;
  components: string[];
  identity: PromotionFsIdentity | null;
  missingAt: number | null;
  prefixIdentities: PromotionFsIdentity[];
};
export type PromotionJournalBinding = {
  root: BoundPromotionDirectory;
  directory: BoundPromotionDirectory;
  name: string;
  journalFile: BoundPromotionExpectedLeaf | null;
};

export type PromotionEntryState =
  | { type: "missing" }
  | { type: "file"; mode?: number; hash: string }
  | { type: "symlink"; target: string }
  | { type: "directory"; mode: number }
  | { type: "other"; mode: number };

export type PromotionJournalPath = {
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
export type CanonicalPath = (absPath: string) => Promise<string>;

export type PromotionRecoveryContext = {
  primaryRoot: string;
};
export type PromotionRecoveryTestHook = (stage: "after-journal-validation", journalDir: string) => void | Promise<void>;

export interface PromoteSeed {
  paths: Array<{ rel: string; kind: "write" | "delete"; beforeExists: boolean }>;
  beforeDir: string;
  installedSession: string;
  primaryRoot: string;
  primaryWorkspaceId: string;
  comparisonId: string;
  label: "A" | "B";
  engine: "core";
}

/** One recorded run (WORLDLINES §6.5). */
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
  /** A core branch destination whose commit could not be proven. */
  uncertainSessionFile: string | null;
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
  engine?: "core";
}
