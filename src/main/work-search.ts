import type { PlanWorkSummary, ProjectWorkSummary, TerminalWorkSummary, WorkOverview } from "../../shared/types";
import { presentBlockedLabel } from "../known-state";

export interface WorkTaskTarget {
  projectId: string;
  root: string;
  key: string;
  /** Content identity, not permission to execute a task or control a terminal. */
  scope: string;
}

export type WorkSearchTarget =
  | { kind: "project"; projectId: string; root: string }
  | { kind: "task"; task: WorkTaskTarget };

export interface WorkSearchRow {
  target: WorkSearchTarget;
  label: string;
  detail: string;
}

interface WorkTaskMatch {
  owner: TerminalWorkSummary;
  terminal: TerminalWorkSummary;
  task: PlanWorkSummary;
  target: WorkTaskTarget;
}

const MAX_RESULTS = 50;

/** Plan owner and source identity are shared by search and its fresh revalidation. */
function* projectTasks(project: ProjectWorkSummary): Generator<WorkTaskMatch> {
  const live = new Map(project.terminals.map((terminal) => [terminal.terminalId, terminal]));
  for (const owner of project.terminals) {
    const occurrences = new Map<string, number>();
    for (const task of owner.tasks) {
      const occurrence = occurrences.get(task.task.text) ?? 0;
      occurrences.set(task.task.text, occurrence + 1);
      const assigned = task.worker ? live.get(task.worker.terminalId) : undefined;
      const terminal = assigned && assigned.generation === task.worker?.generation ? assigned : owner;
      yield { owner, terminal, task, target: {
        projectId: project.projectId, root: project.root,
        key: JSON.stringify([owner.terminalId, owner.generation, task.task.text, occurrence]),
        scope: JSON.stringify([owner.workArea, terminal.terminalId, terminal.generation,
          terminal.workArea, task.task.paths, task.worker, task.task.candidate, task.candidate]),
      } };
    }
  }
}

export function findWorkTask(overview: WorkOverview, target: WorkTaskTarget): WorkTaskMatch | null {
  const project = overview.projects.find((entry) => entry.projectId === target.projectId && entry.root === target.root);
  if (!project) return null;
  for (const match of projectTasks(project)) {
    if (match.target.key === target.key && match.target.scope === target.scope) return match;
  }
  return null;
}

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
    for (const { owner, terminal, task, target } of projectTasks(project)) {
      if (!matches(`${identity}\n${task.task.text}`)) continue;
      const execution = task.worker && terminal !== owner
        ? `${terminal.activity?.reason === "outcome-unknown" ? "idle · turn end unconfirmed" : terminal.activity?.state === "blocked" ? presentBlockedLabel(terminal.activity.reason) : terminal.activity?.state ?? "Shell activity unknown"} · worker ${terminal.terminalId}`
        : "No live worker assigned";
      rows.push({
        target: { kind: "task", task: target },
        label: task.task.text,
        detail: `Task · ${project.name} · ${project.root} · Plan owner ${owner.terminalId}`
          + ` · Marked ${task.task.state} · ${execution}`
          + (task.task.dispatchResult ? ` · Previous attempt ${task.task.dispatchResult.outcome} (${task.task.dispatchResult.workerId})` : "")
          + (terminal.workArea?.kind === "candidate" ? ` · Separate candidate tree ${terminal.workArea.root}` : ""),
      });
      if (rows.length > MAX_RESULTS) return { rows: rows.slice(0, MAX_RESULTS), truncated: true };
    }
    if (rows.length > MAX_RESULTS) return { rows: rows.slice(0, MAX_RESULTS), truncated: true };
  }
  return { rows, truncated: false };
}
