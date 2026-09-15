/**
 * Candidate launch / reopen handshake (worldlines owner).
 *
 * Owns launch-attempt maps, pending-ready timers, terminal routing for the
 * spawn/ready handshake, and process-identity cleanup of those attempts.
 * WorldlineManager keeps comparison maps, admission, promote, evidence, and
 * fork-run, and drives this collaborator through a narrow host.
 * Extracted from manager.ts (issue #382) with no behavior change.
 */
import { randomUUID } from "node:crypto";
import { boundPromotionRemoveTree } from "../worldline-git.js";
import { promotionIdentityOf, refreshBoundPromotionDirectory } from "./bindings.js";
import { CANDIDATE_CLEANUP_TIMEOUT_MS, READY_TIMEOUT_MS } from "./limits.js";
import {
  awaitAbortable,
  processStartMatches,
  readProcessStart,
  waitBounded,
} from "./promotion-recovery.js";
import type {
  CandidateLaunchAttempt,
  CandidateReadyEvent,
  CandidateState,
  ComparisonState,
  PendingCandidateReady,
} from "./types.js";
import type { WorldlineState } from "../../shared/types.js";

/** Narrow manager surface the handshake needs. Comparison maps stay here. */
export interface CandidateLaunchHost {
  comparisons: Map<string, ComparisonState>;
  closingComparisons: Set<string>;
  comparisonIsLive(cmp: ComparisonState): boolean;
  ensureComparisonLive(cmp: ComparisonState): void;
  pushUpdate(cmp: ComparisonState, cand: CandidateState): void;
  updateManifest(cmp: ComparisonState, cand: CandidateState, attempt?: CandidateLaunchAttempt): Promise<void>;
  candidateLaunch(cmp: ComparisonState, cand: CandidateState): Promise<{
    cmd: string;
    args: string[];
    env: Record<string, string | undefined>;
  }>;
  writeControl(cand: CandidateState, control: Record<string, unknown>): Promise<void>;
  teardown(comparisonId: string, state: WorldlineState, error: string | null): Promise<void>;
  createCandidate(opts: {
    root: string;
    workspaceId: string;
    engine?: "core";
    launch: { cmd: string; args: string[]; env: Record<string, string | undefined> };
    beforeSpawn?: (terminalId: string) => void;
    signal?: AbortSignal;
  }): Promise<{ terminalId: string; pid: number }>;
  createCandidateWorkspace(root: string, baseStateId: string | null, comparisonId: string): string;
  terminateCandidate?(terminalId: string): void;
  terminalLive(terminalId: string): boolean;
}

export class CandidateLaunch {
  /** Reopen readiness is a one-shot handshake keyed by the new terminal id. */
  pendingCandidateReadies = new Map<string, PendingCandidateReady>();
  /** Fresh candidate startup attempts stay addressable through teardown and
   *  a late process-start identity result. */
  candidateLaunchAttempts = new Map<string, CandidateLaunchAttempt>();
  terminalToComparison = new Map<string, { comparisonId: string; label: "A" | "B"; startupAttemptId?: string }>();
  private candidateLaunchGeneration = 0;

  constructor(private host: CandidateLaunchHost) {}

  /** Launch one candidate inside its sandbox (A or a moment candidate). */
  async launchCandidate(cmp: ComparisonState, cand: CandidateState, headStateId: string | null): Promise<void> {
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
      this.ensureLive(cmp, cand, attempt);
      const { cmd, args, env } = await this.host.candidateLaunch(cmp, cand);
      this.ensureLive(cmp, cand, attempt);
      cand.headStateId = headStateId ?? cand.headStateId ?? cmp.baseStateId;
      const workspaceId = this.host.createCandidateWorkspace(cand.dir, cand.headStateId, cmp.id);
      let routedTerminalId: string | null = null;
      const created = await this.host.createCandidate({
        root: cand.dir,
        workspaceId,
        engine: "core",
        launch: { cmd, args, env },
        signal: attempt.controller.signal,
        beforeSpawn: (terminalId) => {
          this.ensureLive(cmp, cand, attempt);
          routedTerminalId = terminalId;
          attempt.terminalId = terminalId;
          this.installCandidateRouting(cmp, cand, terminalId, undefined, attempt.opId);
        },
      });
      attempt.terminalId = attempt.terminalId ?? created.terminalId;
      attempt.pid = created.pid;
      this.ensureLive(cmp, cand, attempt);
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
            this.host.terminateCandidate?.(attempt.terminalId);
          }
        }
      }).catch(() => undefined);
      const lstart = await awaitAbortable(identity, attempt.controller.signal);
      attempt.lstart = lstart;
      this.ensureLive(cmp, cand, attempt);
      cand.lstart = lstart;
      await this.host.updateManifest(cmp, cand, attempt);
      this.ensureLive(cmp, cand, attempt);
      this.host.pushUpdate(cmp, cand);
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
  live(cmp: ComparisonState, cand: CandidateState, attempt: CandidateLaunchAttempt): boolean {
    return this.host.comparisonIsLive(cmp)
      && !attempt.cancelled
      && cand.startupAttemptId === attempt.opId
      && cand.startupGeneration === attempt.generation
      && this.candidateLaunchAttempts.get(attempt.opId) === attempt;
  }

  ensureLive(cmp: ComparisonState, cand: CandidateState, attempt: CandidateLaunchAttempt): void {
    if (!this.live(cmp, cand, attempt)) throw new Error("candidate startup was cancelled");
  }

  /** Cancel every fresh launch for a comparison before candidate cleanup. */
  async cancelLaunches(comparisonId: string): Promise<void> {
    const attempts = [...this.candidateLaunchAttempts.values()].filter((attempt) => attempt.comparisonId === comparisonId);
    for (const attempt of attempts) {
      attempt.cancelled = true;
      attempt.controller.abort();
      const cmp = this.host.comparisons.get(attempt.comparisonId);
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
          this.host.terminateCandidate?.(attempt.terminalId);
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
      this.host.terminateCandidate?.(attempt.terminalId);
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
            this.host.terminateCandidate?.(attempt.terminalId);
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
    this.host.ensureComparisonLive(cmp);
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

  /** The bridge consumed its startup control. */
  onSessionReady(terminalId: string, ok: boolean, error: string | null, event: CandidateReadyEvent = {}): void {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return;
    const cmp = this.host.comparisons.get(hit.comparisonId);
    const cand = cmp?.candidates.get(hit.label);
    if (!cmp || !cand) return;
    // A terminal callback can race the first teardown tick. Once comparison
    // admission closes, no startup event may mutate or publish stale state.
    if (!this.host.comparisonIsLive(cmp)) return;

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
      void this.host.teardown(cmp.id, "error", `the candidate session failed to start: ${error ?? "unknown"}`);
      return;
    }
    cand.state = "ready";
    cand.version++;
    this.host.pushUpdate(cmp, cand);
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

  /**
   * Consume a terminal exit that belongs to a fresh launch or reopen
   * handshake. Returns true when the caller must not settle the candidate.
   */
  consumeTerminalExit(cmp: ComparisonState, cand: CandidateState, terminalId: string): boolean {
    const launchAttempt = cand.startupAttemptId ? this.candidateLaunchAttempts.get(cand.startupAttemptId) : undefined;
    if (launchAttempt && launchAttempt.terminalId === terminalId && cand.startupGeneration === launchAttempt.generation) {
      launchAttempt.cancelled = true;
      launchAttempt.controller.abort();
      void this.cleanupCandidateLaunchAttempt(cmp, cand, launchAttempt);
      if (cmp.phase !== "error") void this.host.teardown(cmp.id, "error", "the candidate exited during startup");
      return true;
    }
    const pending = this.pendingCandidateReadies.get(terminalId);
    if (pending && (pending.state === "pending" || pending.state === "accepted")) {
      pending.state = "failed";
      pending.reject(new Error("the reopened candidate exited before startup completed"));
      return true;
    }
    return false;
  }

  /** Attach a live candidate terminal, or reopen one whose PTY is gone. */
  async openTerminal(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; error?: string; terminalId?: string }> {
    const cmp = this.host.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (!cand.sessionFile) return { ok: false, error: "the candidate has no session" };
    if (cand.state === "creating") return { ok: false, error: "candidate startup is already in progress" };
    // A mapped PTY is the session. State (promoting, settled-during-drain,
    // error) must not spawn a second candidate on the same tree.
    if (cand.terminalId && this.host.terminalLive(cand.terminalId)) {
      return { ok: true, terminalId: cand.terminalId };
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
    this.host.pushUpdate(cmp, cand);

    let routedTerminalId: string | null = null;
    let launchedPid: number | null = null;
    let launchedLstart: string | null = null;
    try {
      const { cmd, args, env } = await this.host.candidateLaunch(cmp, cand);
      // A reopen gets a new control operation. Matching this operation is the
      // durable identity boundary that excludes a stale/replayed ready line
      // from the previous candidate process.
      const opId = startupAttemptId;
      this.host.ensureComparisonLive(cmp);
      await this.host.writeControl(cand, { opId, action: "none" });
      const workspaceId = this.host.createCandidateWorkspace(cand.dir, cand.headStateId ?? cmp.baseStateId ?? null, cmp.id);
      const created = await this.host.createCandidate({
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
      this.host.ensureComparisonLive(cmp);
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
      this.host.ensureComparisonLive(cmp);
      cand.state = "ready";
      cand.version++;
      cand.error = null;
      await this.host.updateManifest(cmp, cand);
      this.host.ensureComparisonLive(cmp);
      if (pending.state !== "accepted") throw new Error("candidate exited before ready was published");
      if (this.terminalToComparison.get(terminalId)?.comparisonId !== cmp.id || this.terminalToComparison.get(terminalId)?.label !== label) {
        throw new Error("candidate terminal routing changed before ready was published");
      }
      this.host.pushUpdate(cmp, cand);
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
    if (cmp.phase !== "error" && !this.host.closingComparisons.has(cmp.id)) {
      cand.state = "error";
      cand.error = error;
      cand.version++;
      this.host.pushUpdate(cmp, cand);
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

  async terminateCandidateProcess(terminalId: string | null, pid: number | null, lstart: string | null): Promise<void> {
    await this.terminateCandidateGroup(pid, lstart);
    if (terminalId) this.host.terminateCandidate?.(terminalId);
  }

  /** Cancel reopen waiters when the owning comparison is closed. */
  cancelPending(comparisonId: string, error: string): void {
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

  clearRoutes(comparisonId: string): void {
    for (const [terminalId, hit] of [...this.terminalToComparison]) {
      if (hit.comparisonId === comparisonId) this.terminalToComparison.delete(terminalId);
    }
  }
}
