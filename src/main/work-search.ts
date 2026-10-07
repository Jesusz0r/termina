import type { WorkOverview } from "../../shared/types";
import { projectCards, taskTarget, type OverviewTaskTarget } from "./project-overview";

export type WorkSearchTarget =
  | { kind: "project"; projectId: string; root: string }
  | { kind: "task"; task: OverviewTaskTarget };

export interface WorkSearchRow {
  target: WorkSearchTarget;
  label: string;
  detail: string;
}

const MAX_RESULTS = 50;

/** Search the canonical lightweight projection. No persistent index or execution state. */
export function searchWork(overview: WorkOverview, query: string): { rows: WorkSearchRow[]; truncated: boolean } {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string): boolean => {
    const value = text.toLocaleLowerCase();
    return terms.every((term) => value.includes(term));
  };
  const rows: WorkSearchRow[] = [];
  for (const project of overview.projects) {
    const identity = `${project.name}\n${project.root}`;
    if (matches(identity)) rows.push({
      target: { kind: "project", projectId: project.projectId, root: project.root },
      label: project.name,
      detail: `Project · ${project.root}`,
    });
    for (const card of projectCards(project)) {
      if ("recovery" in card || !card.task || !matches(`${identity}\n${card.title}`)) continue;
      rows.push({
        target: { kind: "task", task: taskTarget(project, card) },
        label: card.title,
        detail: `Task · ${project.name} · ${project.root} · Plan owner ${card.owner.terminalId}`
          + ` · ${card.state} · ${card.execution}`
          + (card.terminal.workArea?.kind === "candidate" ? ` · Separate candidate tree ${card.terminal.workArea.root}` : ""),
      });
      if (rows.length > MAX_RESULTS) return { rows: rows.slice(0, MAX_RESULTS), truncated: true };
    }
    if (rows.length > MAX_RESULTS) return { rows: rows.slice(0, MAX_RESULTS), truncated: true };
  }
  return { rows, truncated: false };
}
