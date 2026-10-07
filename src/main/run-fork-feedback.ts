import { toast } from "../components/modals";
import type { ChallengeProfile } from "../../shared/types";

interface ForkPane {
  instanceId: string;
  generation: number;
}

interface ForkProject {
  id: string | null;
  generation: number;
}

/** Transient initiating-control feedback; main still owns admission. */
export function createRunForkFeedback<TPane extends ForkPane>(bindings: {
  getActivePane(): TPane | undefined;
  getPaneById(id: string): TPane | undefined;
  getActiveProject(): ForkProject;
  onChange(): void;
}): {
  isPending(pane: TPane): boolean;
  request(pane: TPane, runId: string, profile?: ChallengeProfile): Promise<void>;
} {
  type PendingFork = { terminalGeneration: number; project: ForkProject };
  const pending = new WeakMap<TPane, PendingFork>();

  function belongsToSource(pane: TPane, fork: PendingFork): boolean {
    const project = bindings.getActiveProject();
    return bindings.getPaneById(pane.instanceId) === pane
      && pane.generation === fork.terminalGeneration
      && project.id === fork.project.id
      && project.generation === fork.project.generation;
  }

  function isPending(pane: TPane): boolean {
    const fork = pending.get(pane);
    return fork !== undefined && belongsToSource(pane, fork);
  }

  async function request(pane: TPane, runId: string, profile?: ChallengeProfile): Promise<void> {
    if (isPending(pane)) return;
    const fork = { terminalGeneration: pane.generation, project: { ...bindings.getActiveProject() } };
    const isCurrent = (): boolean => pending.get(pane) === fork
      && bindings.getActivePane() === pane
      && belongsToSource(pane, fork);
    pending.set(pane, fork);
    bindings.onChange();
    const failure = profile ? "Challenge failed" : "Fork Run failed";
    try {
      const res = profile
        ? await window.termina.challengeRun(runId, profile)
        : await window.termina.forkRun(runId);
      // The candidate cards confirm success; don't flash another success toast.
      if (!res.ok && isCurrent()) toast(`${failure}: ${res.error ?? "unknown error"}`, "warning");
    } catch (err) {
      if (isCurrent()) toast(`${failure}: ${(err as Error).message}`, "warning");
    } finally {
      if (pending.get(pane) === fork) pending.delete(pane);
      bindings.onChange();
    }
  }

  return { isPending, request };
}
