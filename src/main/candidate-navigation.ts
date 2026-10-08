import type { CandidateRecoverySummary, ProjectWorkSummary, TerminaBridge, WorldlineSummary } from "../../shared/types";
import { findOverviewTask, type OverviewTaskTarget } from "./project-overview";

export type CandidateNavigationTarget =
  | { mode: "open" | "discard"; projectId: string; candidate: CandidateRecoverySummary }
  | { mode: "inspect"; projectId: string; task: OverviewTaskTarget };

/** Resolve only fresh authoritative context; inspection never synthesizes recovery facts. */
export async function prepareCandidateContext(
  target: CandidateNavigationTarget,
  bridge: Pick<TerminaBridge, "getProjectWorkSummary" | "getWorldlines">,
  isCurrent: () => boolean,
): Promise<WorldlineSummary | null> {
  const resolve = (work: ProjectWorkSummary | null) => {
    if (!work) return null;
    if (target.mode !== "inspect") {
      const expected = target.candidate;
      return work.candidateRecoveries.find((entry) => entry.comparisonId === expected.comparisonId
        && entry.label === expected.label && entry.root === expected.root && entry.version === expected.version
        && entry.recovery === expected.recovery) ?? null;
    }
    const card = findOverviewTask({ projects: [{ ...work, working: 0, attentionCount: 0 }], items: [] }, target.task);
    const candidate = card?.task?.candidate;
    const link = card?.task?.task.candidate;
    return candidate && link?.comparisonId === candidate.comparisonId && link.label === candidate.label ? candidate : null;
  };
  const work = await bridge.getProjectWorkSummary(target.projectId);
  if (!isCurrent()) return null;
  const candidate = resolve(work);
  if (!candidate) return null;
  const summaries = await bridge.getWorldlines(target.projectId);
  if (!isCurrent()) return null;
  // The task link may change while candidate data is loading (retry, close, or refresh).
  const fresh = resolve(await bridge.getProjectWorkSummary(target.projectId));
  if (!isCurrent() || !fresh || fresh.comparisonId !== candidate.comparisonId || fresh.label !== candidate.label
    || fresh.root !== candidate.root || fresh.version !== candidate.version) return null;
  return summaries.find((entry) => entry.comparisonId === candidate.comparisonId && entry.label === candidate.label
    && entry.root === candidate.root && entry.version === candidate.version) ?? null;
}
