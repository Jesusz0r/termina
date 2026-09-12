/**
 * Background schedule tick.
 *
 * Once a minute, fire due scheduled plan tasks (`@every` / `@at` markers)
 * through the normal worker dispatch path. Main owns authoritative app state;
 * this module owns the tick algorithm, the per-task next-run map, and the
 * timer behind the ScheduleTickHost seam. The tick never throws.
 */
import { SCHEDULE_TICK_MS, nextScheduleRun, type ScheduleSpec } from "./plan-board.js";

/** One pending scheduled plan task, with live owner reads. */
export interface ScheduleTickTask {
  readonly ownerId: string;
  readonly text: string;
  readonly spec: ScheduleSpec;
  isBusy(): boolean;
}

/** Live reads into main-owned state, evaluated at call time. The task
 * traversal is lazy, so mid-tick interleaving matches the inline loop. */
export interface ScheduleTickHost {
  isDisposed(): boolean;
  agentTasks(): Iterable<ScheduleTickTask>;
  dispatchRun(ownerId: string, taskText: string): Promise<{ ok: boolean; error?: string }>;
}

export class ScheduleRunner {
  private scheduledNextRuns = new Map<string, number>();
  /** Background schedule tick. Cleared on dispose. */
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: ScheduleTickHost) {}

  /**
   * Fire due scheduled plan tasks (`@every` / `@at` markers). One tick per
   * minute across projects: prune dead entries, skip busy owners and full
   * dispatch boards, and dispatch through the normal worker path so briefing,
   * settle notes, and auto-verify apply unchanged. Never throws.
   */
  async tick(now: number = Date.now()): Promise<void> {
    if (this.host.isDisposed()) return;
    try {
      const live = new Set<string>();
      for (const task of this.host.agentTasks()) {
        const key = `${task.ownerId}\n${task.text}`;
        live.add(key);
        const next = this.scheduledNextRuns.get(key);
        if (next === undefined) {
          this.scheduledNextRuns.set(key, nextScheduleRun(task.spec, now, true));
          continue;
        }
        if (next > now) continue;
        // Reschedule first: a slow dispatch must not pile up ticks.
        this.scheduledNextRuns.set(key, nextScheduleRun(task.spec, now, false));
        if (task.isBusy()) continue;
        const result = await this.host.dispatchRun(task.ownerId, task.text);
        if (!result.ok) {
          console.warn(`[main] scheduled dispatch skipped: ${result.error}`);
        }
      }
      for (const key of [...this.scheduledNextRuns.keys()]) {
        if (!live.has(key)) this.scheduledNextRuns.delete(key);
      }
    } catch (err) {
      console.warn(`[main] schedule tick failed: ${(err as Error).message}`);
    }
  }

  start(): void {
    if (this.scheduleTimer) return;
    this.scheduleTimer = setInterval(() => {
      void this.tick();
    }, SCHEDULE_TICK_MS);
  }

  stop(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }
}
