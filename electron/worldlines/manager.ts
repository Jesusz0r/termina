/**
 * Worldline comparison lifecycle owner (`electron/worldlines/`).
 * Owns comparisons, candidates, runs, evidence orchestration, and promotion
 * dispatch; durability primitives live in the sibling modules.
 */
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat as lstatPath, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildSandboxProfile, candidateSandboxLaunch, type SandboxPaths } from "../sandbox.js";
import {
  SnapshotStore,
  boundPromotionCopyTree,
  boundPromotionCreateDirectory,
  boundPromotionInstallDirectory,
  boundPromotionOpenDirectory,
  boundPromotionPrepareDirectory,
  boundPromotionRemoveTree,
  boundPromotionTransition,
  boundPromotionWriteFile,
  captureRootInRepo,
  gitCommitFile,
  gitCommitTree,
  gitCommittedChanges,
  gitCommonDir,
  gitHead,
  gitIgnoredFiles,
  gitTopLevel,
  gitWorkingChanges,
  type BoundPromotionExpectedLeaf,
  type PromotionFsIdentity,
} from "../worldline-git.js";
import { buildExportMarkdown, MAX_EXPORT_BUNDLES, MAX_EXPORT_FILES, type ExportPatchFile } from "./export.js";
import { EvidenceEngine, dependencyDiff, mineChangeReason, rankProfiles, type EvidenceDeps } from "../evidence.js";
import type {
  CoreSessionForkOpts,
  CoreSessionForkResult,
  SessionForkCallOptions,
} from "../session-fork.js";
import type {
  ChallengeProfile,
  DependencyChange,
  EvidenceRecord,
  EvidenceSummary,
  RunSummary,
  TimelineEvent,
  WorldlineChangedFile,
  WorldlineDetails,
  WorldlineState,
  WorldlineSummary,
} from "../../shared/types.js";
import {
  coreSessionFile,
  parseSessionBundlePath,
  sessionBundleBytes,
  sessionBundleHasContent,
} from "../../agent-core/session.js";
import { MAX_MCP_JSON_BYTES } from "../../agent-core/mcp.js";
import { thinkingStartupArgs } from "../../shared/terminal-control.js";
import {
  UncertainComparisonAdmissionOwner,
  boundedWorldlineEntries,
  comparisonManifestFor,
  parseComparisonManifest,
  releaseUncertainComparisonAdmissionOwner,
  uncertainComparisonAdmissionOwnerFor,
} from "./uncertain-comparison.js";
import {
  PromotionJournalAdmissionOwner,
  createPromotionOperationBudget,
  dirBytes,
  promotionJournalAdmissionOwnerFor,
  releasePromotionJournalAdmissionOwner,
  reservePromotionOperationBytes,
} from "./promotion-journal.js";
import {
  awaitAbortable,
  boundPromotionExpectedLeaf,
  copyBoundBeforeImage,
  copyBoundPrivateFile,
  createPromotionArtifactManifest,
  createSnapshotTemplateDirectory,
  ensureBoundChildDirectory,
  ensureBoundDirectory,
  isMaterializedPromotionState,
  isRestorablePromotionState,
  materializePromotionDirectoryPlan,
  probePromotionDirectory,
  processStartMatches,
  promotionDestination,
  promotionDestinationComponents,
  promotionParentIdentity,
  promotionSourceComponents,
  promotionStateHash,
  promotionStatesEqual,
  readComparisonManifestBound,
  readProcessStart,
  readPromotionEntry,
  refreshComparisonBindings,
  rollbackPromotion,
  sha256Hex,
  waitBounded,
  withPromotionTransaction,
  writeComparisonManifestBound,
  writeComparisonMarkerBound,
  writePromotionJournal,
} from "./promotion-recovery.js";
import {
  promotionIdentityOf,
  refreshBoundPromotionDirectory,
} from "./bindings.js";
import {
  isInside,
  parseStorageSeq,
} from "./guards.js";
import {
  type BoundPromotionDirectory,
  type CandidateLaunchAttempt,
  type CandidateReadyEvent,
  type CandidateState,
  type ComparisonManifest,
  type ComparisonState,
  type EvidenceAttempt,
  type PendingCandidateReady,
  type PromoteSeed,
  type PromotionDirectoryPlan,
  type PromotionJournalAdmissionResult,
  type PromotionJournalBinding,
  type PromotionJournalPath,
  type RunRecord,
  type TrackedSessionFork,
  type UncertainComparisonAdmissionLease,
} from "./types.js";
import {
  CANDIDATE_CLEANUP_TIMEOUT_MS,
  MARKER,
  MAX_CANDIDATE_BYTES,
  MAX_IGNORED_BYTES,
  MAX_IGNORED_FILES,
  MAX_AGENT_RESOURCE_BYTES,
  MAX_PROMPT_BYTES,
  MAX_RETAINED_RUNS,
  MAX_RUNS_PER_TERMINAL,
  MAX_STALE_SWEEP_BYTES,
  MAX_TEMPLATE_BYTES,
  MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES,
  MAX_WORLDLINE_FILE_BYTES,
  READY_TIMEOUT_MS,
  RUNTIME_ALLOWLIST,
} from "./limits.js";
/** Core is the only engine. A missing engine fails closed as non-core. */
function isCoreRun(run: { engine?: "core" }): boolean {
  return run.engine === "core";
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

export interface WorldlineDeps {
  worldsRoot: string;
  primaryRoot: string;
  primaryRootIdentity: PromotionFsIdentity;
  realHome: string;
  userData: string;
  primaryEventsDir: string;
  agentCorePath: string;
  electronExecPath: string;
  /** Candidate-only allowlisted environment, scoped to one model provider. */
  candidateEnv(provider: string | null): Record<string, string | undefined>;
  showThinking(): boolean;
  getStore(): Promise<SnapshotStore | null>;
  /** Read-only load paths for the sandboxed core (agent-core copy + electron + node). */
  appReadPaths(): string[];
  forkCoreSession(opts: CoreSessionForkOpts, callOptions?: SessionForkCallOptions): Promise<CoreSessionForkResult>;
  /** Build an export patch off the main thread (pure CPU over gathered contents). */
  buildExportPatch(files: ExportPatchFile[]): Promise<string>;
  /** Discard a proven durable core session bundle through the retention owner. */
  discardCoreSession(runId: string): Promise<{ ok: boolean; error?: string }>;
  createCandidate(opts: {
    root: string;
    workspaceId: string;
    engine?: "core";
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
  /** The trust-sensitive resource hashes of the project + agent dir. */
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
  primarySessionDir(cwd: string): Promise<string>;
  installPromoted(seed: PromoteSeed): Promise<{ terminalId: string }>;
}

const EVIDENCE_QUEUE_HIGH_WATER = 64;


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
  private releasePromotionAdmissionParticipant: (() => void) | null = null;
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
  private evidenceQueueDepth = 0;
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
      this.releasePromotionAdmissionParticipant = this.promotionAdmissionOwner.register();
      this.primaryRootBinding = await ensureBoundDirectory(
        this.deps.primaryRoot,
        "primary root",
        worldsRootBinding,
        { initialIdentity: this.deps.primaryRootIdentity },
      );
      await this.sweepStale();
    })().catch((error: unknown) => {
      this.readyError = error instanceof Error ? error : new Error(String(error));
      this.releaseAdmissionOwnership();
      throw this.readyError;
    });
    // Every manager observes readiness even when no later operation awaits it.
    // Public reads use readyError to fail closed after bootstrap fails.
    void this.ready.catch(() => undefined);
  }

  private releaseAdmissionOwnership(): void {
    this.releaseUncertainAdmissionParticipant?.();
    this.releaseUncertainAdmissionParticipant = null;
    this.releasePromotionAdmissionParticipant?.();
    this.releasePromotionAdmissionParticipant = null;
    if (this.uncertainAdmissionOwner) releaseUncertainComparisonAdmissionOwner(this.uncertainAdmissionOwner);
    if (this.promotionAdmissionOwner) releasePromotionJournalAdmissionOwner(this.promotionAdmissionOwner);
    this.uncertainAdmissionOwner = null;
    this.promotionAdmissionOwner = null;
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

  /** Drain tracked session forks before removing owned directories. */
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
      uncertainSessionFile: r.uncertainSessionFile,
      replayable: r.replayable,
      reason: r.reason,
      interrupted: r.interrupted,
      steering: r.steering,
      overlap: r.overlap,
      unownedEdits: r.unownedEdits,
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
      if (isCoreRun(run)) {
        // Successful core finalization leaves a proven durable bundle after
        // its claim is removed. Route its reclamation through the same owner;
        // uncertainSessionFile is intentionally never treated as a valid
        // branch and is not passed here.
        const discard = this.deps.discardCoreSession(run.id).catch(() => undefined);
        this.retainedSessionDiscards.add(discard);
        void discard.finally(() => this.retainedSessionDiscards.delete(discard));
      }
      // Non-core branches are removed with no session discard: no pi
      // sessions are recorded anymore, so there is nothing to reclaim.
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
    if (cmp.engine !== "core") return { ok: false, error: "pi comparisons are removed; core is the only engine" };
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
      markerLeaf,
      manifestLeaf,
      sourceRunId: cmp.sourceRunId,
      sourceGitDir: store.sourceGitDir,
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: cmp.baseStateId,
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
      const ignored = await gitIgnoredFiles(cand.dir);
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
          const changes = await gitWorkingChanges(cand.dir);
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
    const res = await gitCommitFile(anyCand.dir, cmp.baseCommit!, relPath);
    if (res === null) return { ok: false, error: "file not in the base" };
    if (res.byteLength > MAX_WORLDLINE_FILE_BYTES) return { ok: false, error: "the base file is too large" };
    return { ok: true, content: res.toString() };
  }

  /**
   * Export one candidate as a patch bundle: unified diff plus an evidence
   * summary for a PR body. No git mutation, no network — the bundle lands
   * in the app-owned exports directory for review, `git apply`, or paste.
   */
  async exportCandidate(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; path?: string; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (cand.state === "discarded" || cand.state === "error") {
      return { ok: false, error: "only a live candidate can be exported" };
    }
    // The directory name derives from renderer input: allow only the
    // manager-generated id shape even though lookup already gates it.
    if (!/^cmp-[0-9]+$/.test(comparisonId)) return { ok: false, error: "invalid comparison" };
    let changed: WorldlineChangedFile[];
    try {
      changed = (await this.changedFiles(cmp, cand)).files;
    } catch (err) {
      return { ok: false, error: `could not list candidate changes: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (changed.length === 0) return { ok: false, error: "the candidate has no changes to export" };
    // Bound per-file round-trips and patch size: extra files stay listed in
    // the summary but leave the patch.
    const capped = changed.slice(0, MAX_EXPORT_FILES);
    const patchFiles: ExportPatchFile[] = [];
    for (const file of capped) {
      if (!this.isSafeRelativePath(file.relPath)) continue;
      // Patch format cannot represent newline names; they stay listed only.
      if (file.relPath.includes("\n")) continue;
      let before: string | null = null;
      let after: string | null = null;
      if (file.status !== "created") {
        const base = await this.baseFileOf(comparisonId, file.relPath);
        if (base.ok) before = base.content ?? null;
      }
      if (file.status !== "deleted") {
        const head = await this.fileOf(comparisonId, label, file.relPath);
        if (head.ok) after = head.content ?? null;
      }
      // Unreadable on both sides: listed in the summary, absent from the patch.
      if (before === null && after === null) continue;
      patchFiles.push({ relPath: file.relPath, before, after });
    }
    if (patchFiles.length === 0) return { ok: false, error: "no exportable file contents" };
    const evidence = this.evidenceByComparison.get(comparisonId);
    const records = evidence?.byCandidate[label] ?? [];
    const bundle = buildExportMarkdown({
      comparisonId,
      label,
      role: cand.role,
      model: cmp.model,
      baseCommit: cmp.baseCommit,
      exportedAt: new Date().toISOString(),
      files: changed.map((file) => ({ relPath: file.relPath, status: file.status })),
      evidence: records.map((record) => ({ kind: record.kind, status: record.status, reason: record.reason })),
      profiles: (evidence?.profiles ?? []).map((profile) => ({ profile: profile.profile, winner: profile.winner })),
      truncatedFiles: changed.length > capped.length ? changed.length - capped.length : 0,
      evidenceStale: evidence?.stale === true,
    });
    let patch: string;
    try {
      patch = await this.deps.buildExportPatch(patchFiles);
    } catch (err) {
      return { ok: false, error: `could not build the export patch: ${err instanceof Error ? err.message : String(err)}` };
    }
    // The gather + patch window is long: refuse to write a bundle for a
    // candidate that was discarded while it ran.
    const fresh = this.comparisons.get(comparisonId)?.candidates.get(label);
    if (!fresh || fresh.state === "discarded" || fresh.state === "error") {
      return { ok: false, error: "the candidate was discarded during export" };
    }
    const exportsRoot = join(this.deps.worldsRoot, "exports");
    const dir = join(exportsRoot, `${comparisonId}-${label}`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // Confine the bundle inside the app-owned exports root even if a
      // same-user actor planted a symlink along the path.
      const [canonicalRoot, canonicalDir] = await Promise.all([realpath(exportsRoot), realpath(dir)]);
      if (!isInside(canonicalRoot, canonicalDir)) return { ok: false, error: "export bundle escaped its directory" };
      await writeFile(join(canonicalDir, "candidate.patch"), patch, { mode: 0o600 });
      await writeFile(join(canonicalDir, "pr-body.md"), bundle, { mode: 0o600 });
      await writeFile(join(canonicalDir, "metadata.json"), JSON.stringify({
        comparisonId,
        label,
        role: cand.role,
        model: cmp.model,
        baseCommit: cmp.baseCommit,
        exportedAt: new Date().toISOString(),
        files: changed.length,
        truncatedFiles: changed.length > capped.length ? changed.length - capped.length : 0,
      }, null, 2), { mode: 0o600 });
      await this.pruneExportBundles(canonicalRoot, canonicalDir);
    } catch (err) {
      return { ok: false, error: `could not write the export bundle: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, path: dir };
  }

  /** Keep only the newest export bundles. Best-effort; never fails export. */
  private async pruneExportBundles(exportsRoot: string, keepDir: string): Promise<void> {
    try {
      const names = await readdir(exportsRoot);
      if (names.length <= MAX_EXPORT_BUNDLES) return;
      const stamped: Array<{ dir: string; mtimeMs: number }> = [];
      for (const name of names) {
        // Only manager-generated bundle names are ever removed.
        if (!/^cmp-[0-9]+-[AB]$/.test(name)) continue;
        const full = join(exportsRoot, name);
        if (full === keepDir) continue;
        try {
          // lstat, not stat: a symlink never qualifies as a directory here.
          const info = await lstatPath(full);
          if (!info.isDirectory()) continue;
          stamped.push({ dir: full, mtimeMs: info.mtimeMs });
        } catch {
          continue;
        }
      }
      stamped.sort((a, b) => a.mtimeMs - b.mtimeMs);
      while (stamped.length >= MAX_EXPORT_BUNDLES) {
        const oldest = stamped.shift();
        if (!oldest) break;
        await rm(oldest.dir, { recursive: true, force: true });
      }
    } catch {
      /* Retention is best-effort. */
    }
  }

  private isSafeRelativePath(relPath: string): boolean {
    return relPath.length > 0 && relPath !== "." && relPath.indexOf("\0") === -1 && !isAbsolute(relPath) && !relPath.startsWith("/") && !relPath.split(/[\\/]/).includes("..");
  }

  /** Files differing from the base plus head-tree source statistics. */
  private async changedFiles(cmp: ComparisonState, cand: CandidateState): Promise<{ files: WorldlineChangedFile[]; sourceFiles: number; sourceBytes: number }> {
    // Working tree vs HEAD: staged, unstaged, and untracked changes.
    const status = await gitWorkingChanges(cand.dir);
    // Committed changes since the shared base (A's settled apply and any
    // agent commits; B usually has none).
    const committed = await gitCommittedChanges(cand.dir, cmp.baseCommit!, "HEAD");
    const tree = await gitCommitTree(cand.dir, "HEAD");
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
        const base = await gitCommitFile(cand.dir, cmp.baseCommit!, file);
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
    if (!isCoreRun(run)) {
      run.replayable = false;
      run.reason = "pi runs are not forkable; core is the only engine";
      return { ok: false, error: run.reason };
    }
    if (!run.startStateId || !run.settledStateId) return { ok: false, error: "the run has no complete source checkpoints" };
    if (!run.sessionBranchFile) return { ok: false, error: "the run has no session branch copy" };
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
    // Budgets (WORLDLINES §9): prompt payload caps.
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
      await this.copyCoreResources(cmp);
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
      markerLeaf,
      manifestLeaf,
      sourceRunId: run.id,
      sourceGitDir: "",
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: run.startStateId,
      model: run.model,
      thinkingLevel: run.thinkingLevel,
      engine: "core",
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

  /** Fork both session bundles through the session worker. */
  private async forkSessions(cmp: ComparisonState, run: RunRecord): Promise<void> {
    if (cmp.engine !== "core") throw new Error("pi candidates are removed; core is the only engine");
    await this.forkCoreSessions(cmp, run);
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
          if (info.isFile() && info.size <= MAX_AGENT_RESOURCE_BYTES) {
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
            maxBytes: MAX_AGENT_RESOURCE_BYTES,
          });
        } catch {
          /* Keep the candidate without user skills. */
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
      // Text-only prompt: prefilled and editable in the core editor.
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

  /** Launch both candidate agent terminals inside their sandboxes. */
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
    _extraArgs: string[],
  ): Promise<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> {
    await refreshComparisonBindings(cmp);
    // A moment comparison has a single candidate: no sibling to deny (the
    // worlds-root deny covers its tree anyway).
    const sibling = cmp.candidates.get(cand.label === "A" ? "B" : "A");
    if (cmp.engine !== "core") throw new Error("pi candidates are removed; core is the only engine");
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
      appReadPaths: this.deps.appReadPaths(),
      agentHomeDir: join(cand.homeDir, ".termina", "agent"),
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
      TERMINA_WORLDLINE_CANDIDATE: "1",
      ...(sessionBundleHasContent(cand.sessionFile!) ? { TERMINA_CORE_RESUME: "1" } : {}),
      ...(model && cut > 0
        ? { TERMINA_CORE_PROVIDER: model.slice(0, cut), TERMINA_CORE_MODEL: model.slice(cut + 1) }
        : {}),
    };
    const launch = candidateSandboxLaunch(cand.profilePath, [
      this.deps.electronExecPath,
      this.deps.agentCorePath,
      ...thinkingStartupArgs(this.deps.showThinking()),
    ]);
    return { ...launch, env };
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
    if (this.evidenceQueueDepth >= EVIDENCE_QUEUE_HIGH_WATER) {
      this.evidenceAttempts.delete(attempt.id);
      return Promise.resolve({ ok: false, error: "evidence queue is at its high-water mark; retry after pending work drains" });
    }
    this.evidenceQueueDepth += 1;
    const run = this.evidenceQueue.then(() => {
      if (attempt.controller.signal.aborted || this.closingComparisons.has(comparisonId)) {
        return { ok: false, error: "evidence was cancelled" };
      }
      return this.runEvidence(comparisonId, attempt);
    });
    const tracked = run.finally(() => {
      this.evidenceQueueDepth -= 1;
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
    if (comparison.engine !== "core") return { ok: false, error: "pi promotions are removed; core is the only engine" };
    const promoteEngine = "core" as const;

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
      installDir = await this.deps.primarySessionDir(this.deps.primaryRoot);
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
      // conflict instead of an accepted replacement tree.
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
      {
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
      {
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
        // matching agent session still belongs to this operation. In
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
    if (!isCoreRun(rootRun)) return { ok: false, error: "pi moments are not forkable; core is the only engine" };
    const opts = {
      terminalId,
      stateId: moment.stateId,
      entryId: moment.entryId,
      model: moment.model ?? rootRun.model,
      thinkingLevel: rootRun.thinkingLevel,
      sessionFile,
      sourceRunId: rootRun.id,
      baseStateId: rootRun.startStateId,
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
      markerLeaf,
      manifestLeaf,
      sourceRunId: opts.sourceRunId,
      sourceGitDir: store.sourceGitDir,
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: opts.baseStateId ?? null,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      engine: "core",
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
      {
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
  private async launchCandidate(cmp: ComparisonState, cand: CandidateState, extraArgs: string[], headStateId: string | null): Promise<void> {
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
      const { cmd, args, env } = await this.candidateLaunch(cmp, cand, extraArgs);
      this.ensureCandidateLaunchLive(cmp, cand, attempt);
      cand.headStateId = headStateId ?? cand.headStateId ?? cmp.baseStateId;
      const workspaceId = this.deps.createCandidateWorkspace(cand.dir, cand.headStateId, cmp.id);
      let routedTerminalId: string | null = null;
      const created = await this.deps.createCandidate({
        root: cand.dir,
        workspaceId,
        engine: "core",
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
      // it. Canonical sidecar metadata is required so a replayed line cannot
      // impersonate the new producer generation.
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
        engine: "core",
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
      sourceRunId: manifest.sourceRunId,
      sourceGitDir: this.deps.primaryRoot,
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: null,
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
    await this.promotionAdmissionOwner?.drain();
    this.releaseAdmissionOwnership();
    this.clearRuns();
    await this.drainRetainedSessionDiscards();
  }
}
