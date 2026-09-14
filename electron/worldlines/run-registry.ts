/**
 * Settled-run catalog for live comparisons (worldlines owner).
 *
 * Owns run records keyed by id and terminal, bounded eviction, and durable
 * core-bundle reclamation. The manager keeps comparison pinning and delegates
 * run operations here. Extracted from manager.ts (issue #38) with no
 * behavior change.
 */
import { MAX_RETAINED_RUNS, MAX_RUNS_PER_TERMINAL } from "./limits.js";
import type { RunRecord } from "./types.js";
import type { RunSummary } from "../../shared/types.js";

/** A wedged native discard must not hang shutdown past this bound. */
const MAX_DISCARD_DRAIN_MS = 10_000;

/** Narrow manager capabilities the registry needs for reclamation. */
export interface RunRegistryDeps {
  releaseState(stateId: string): Promise<void>;
  removePromptPayload?(eventsDir: string, fileName: string): Promise<void>;
  discardCoreSession(runId: string): Promise<{ ok: boolean; error?: string }>;
  isCoreRun(run: { engine?: "core" }): boolean;
}

export class RunRegistry {
  private runsByTerminal = new Map<string, RunRecord[]>();
  private runsById = new Map<string, RunRecord>();
  private retainedSessionDiscards = new Set<Promise<unknown>>();

  constructor(private deps: RunRegistryDeps) {}

  /** Add the run to the project catalog. */
  record(run: RunRecord, pinned: Set<string>): void {
    this.runsById.set(run.id, run);
    let list = this.runsByTerminal.get(run.terminalId);
    if (!list) {
      list = [];
      this.runsByTerminal.set(run.terminalId, list);
    }
    list.push(run);
    this.evictOverflow(run.terminalId, pinned);
  }

  of(runId: string): RunRecord | null {
    return this.runsById.get(runId) ?? null;
  }

  private runsOf(terminalId?: string): RunRecord[] {
    if (terminalId) return [...(this.runsByTerminal.get(terminalId) ?? [])];
    const out: RunRecord[] = [];
    for (const list of this.runsByTerminal.values()) out.push(...list);
    return out;
  }

  summaries(terminalId?: string): RunSummary[] {
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

  covering(terminalId: string, ts: number): RunRecord | null {
    const runs = this.runsByTerminal.get(terminalId) ?? [];
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i];
      if (ts < run.startedAt) continue;
      if (run.settledAt !== null && ts > run.settledAt) continue;
      return run;
    }
    return null;
  }

  holdsState(stateId: string): boolean {
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
   * source of a live comparison. When nothing is disposable (only open
   * runs, e.g. a lost settle event), shed the oldest open runs' prompt
   * text instead: the records stay addressable while their bulk is freed.
   */
  private evictOverflow(terminalId: string, pinned: Set<string>): void {
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
    this.shedUnsettledPromptText();
  }

  /** Null the prompt bulk of over-cap open runs, oldest first. The records
   * (states, sessions, replay flags) stay intact; only display text goes. */
  private shedUnsettledPromptText(): void {
    const overage = this.runsById.size - MAX_RETAINED_RUNS;
    if (overage <= 0) return;
    const open = [...this.runsById.values()]
      .filter((run) => run.settledAt === null && run.promptText !== null)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const run of open.slice(0, overage)) {
      run.promptText = null;
    }
  }

  private discardRun(run: RunRecord | undefined): void {
    if (!run) return;
    this.runsById.delete(run.id);
    if (run.startStateId) void this.deps.releaseState(run.startStateId).catch(() => undefined);
    if (run.settledStateId && run.settledStateId !== run.startStateId) void this.deps.releaseState(run.settledStateId).catch(() => undefined);
    if (run.promptPayloadFile && run.promptEventsDir) {
      // The manager does not own the primary events-root capability. Delegate
      // to Main's bound leaf owner; when it is unavailable, retaining the
      // payload is safer than deleting a pathname replacement.
      const cleanup = this.deps.removePromptPayload?.(run.promptEventsDir, run.promptPayloadFile);
      if (cleanup) void cleanup.catch(() => undefined);
    }
    if (run.sessionBranchFile) {
      if (this.deps.isCoreRun(run)) {
        // Successful core finalization leaves a proven durable bundle after
        // its claim is removed. Route its reclamation through the same owner;
        // uncertainSessionFile is intentionally never treated as a valid
        // branch and is not passed here.
        const discard = this.deps.discardCoreSession(run.id).catch(() => undefined);
        this.retainedSessionDiscards.add(discard);
        void discard.finally(() => this.retainedSessionDiscards.delete(discard));
      }
      // Non-core branches are removed with no session discard: only core
      // sessions are recorded, so there is nothing else to reclaim.
    }
  }

  /** Drain native durable core-bundle reclamation before app shutdown. */
  async drainDiscards(): Promise<void> {
    // A wedged native discard must not hang shutdown: bound the drain.
    const deadline = Date.now() + MAX_DISCARD_DRAIN_MS;
    while (this.retainedSessionDiscards.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      });
      const drained = await Promise.race([
        Promise.all([...this.retainedSessionDiscards].map((task) => task.catch(() => undefined))).then((): "drained" => "drained"),
        timeout,
      ]);
      if (timer) clearTimeout(timer);
      if (drained === "timeout") break;
    }
  }

  clear(): void {
    for (const list of this.runsByTerminal.values()) {
      for (const run of list) this.discardRun(run);
    }
    this.runsByTerminal.clear();
    this.runsById.clear();
  }
}
