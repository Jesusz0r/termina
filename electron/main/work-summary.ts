import { basename } from "node:path";
import { createHash } from "node:crypto";
import type {
  AgentActivityView, PlanTask, ProjectWorkSummary, TerminalWorkSummary,
  VerifyInfo, WorkAreaSummary, WorkAttentionItem, WorkAttentionReason, WorkOverview, WorkSummaryAction,
} from "../../shared/types.js";

export interface WorkSummaryTerminalFacts {
  id: string;
  generation: number;
  type: "agent" | "shell";
  model: string | null;
  activity: AgentActivityView;
  workspace: { id: string; root: string; primary: boolean; comparisonId?: string } | null;
  verify: VerifyInfo;
  trackedChanges: number;
  plan: readonly PlanTask[];
}

/** Presentation projection only. Activity, tasks, source validity and lifecycle stay with their owners. */
export function projectWorkSummary(
  project: { id: string; cwd: string },
  facts: readonly WorkSummaryTerminalFacts[],
): ProjectWorkSummary {
  const live = new Map(facts.map((terminal) => [terminal.id, terminal]));
  const terminals = facts.map((terminal): TerminalWorkSummary => {
    const area: WorkAreaSummary | null = terminal.workspace ? {
      workspaceId: terminal.workspace.id,
      root: terminal.workspace.root,
      kind: terminal.workspace.primary ? "project" : "candidate",
      comparisonId: terminal.workspace.comparisonId ?? null,
    } : null;
    const action = (kind: WorkSummaryAction["kind"]): WorkSummaryAction => ({
      kind, terminalId: terminal.id, generation: terminal.generation,
    });
    const verify = terminal.type === "agent" ? terminal.verify : null;
    const activity = terminal.type === "agent" ? terminal.activity : null;
    const attention: WorkAttentionReason[] = [];
    if (activity?.state === "blocked") attention.push("blocked");
    if (verify?.state === "fail") attention.push("verify-failed");
    if (verify?.state === "timeout") attention.push("verify-timeout");
    if (verify?.state === "stale") attention.push("verify-stale");
    if (verify?.state === "cancelled") attention.push("verify-cancelled");
    const tasks = terminal.plan.map((task) => {
      const assigned = task.workerId ? live.get(task.workerId) : undefined;
      // An id outside this project/source scope is not a live task assignment.
      const worker = terminal.workspace && assigned?.type === "agent" && assigned.workspace?.id === terminal.workspace.id
        ? { terminalId: assigned.id, generation: assigned.generation } : null;
      const taskAttention: WorkAttentionReason[] = [];
      if (task.workerId && !worker) taskAttention.push("worker-unavailable");
      if (!task.workerId && task.state !== "done") {
        if (task.dispatchResult?.outcome === "incomplete") taskAttention.push("task-incomplete");
        if (task.dispatchResult?.outcome === "failed") taskAttention.push("task-failed");
        if (task.dispatchResult?.outcome === "interrupted") taskAttention.push("task-interrupted");
      }
      return {
        task,
        worker,
        attention: taskAttention,
        nextAction: worker ? { kind: "terminal" as const, ...worker } : action("plan"),
      };
    });
    const nextAction = activity?.state === "blocked" ? action("terminal")
      : attention.length > 0 ? action("evidence")
      : tasks.some((task) => task.attention.length > 0) ? action("plan")
      : terminal.trackedChanges > 0 ? action("changes") : action("terminal");
    return {
      terminalId: terminal.id, generation: terminal.generation, type: terminal.type,
      model: terminal.type === "agent" ? terminal.model : null,
      activity, workArea: area, verify, trackedChanges: terminal.trackedChanges,
      tasks, attention, nextAction,
    };
  });
  return { projectId: project.id, name: basename(project.cwd) || project.cwd, root: project.cwd, terminals };
}

const ATTENTION_PRIORITY: Record<WorkAttentionReason, number> = {
  blocked: 0, "worker-unavailable": 0,
  "task-incomplete": 1, "task-failed": 1, "task-interrupted": 1,
  "verify-failed": 2, "verify-timeout": 2, "verify-stale": 2, "verify-cancelled": 2,
};

/** Compose canonical project summaries. This adds no execution or attention state. */
export function workOverview(summaries: readonly ProjectWorkSummary[]): WorkOverview {
  const items: WorkAttentionItem[] = [];
  const projects = summaries.map((project) => {
    const start = items.length;
    // Attribute worker attention to its live, source-fenced Plan Board assignment.
    const assignments = new Map<string, { owner: TerminalWorkSummary; index: number; task: PlanTask } | null>();
    for (const owner of project.terminals) {
      owner.tasks.forEach(({ task, worker }, index) => {
        if (!worker) return;
        const key = `${worker.terminalId}:${worker.generation}`;
        assignments.set(key, assignments.has(key) ? null : { owner, index, task });
      });
    }
    for (const terminal of project.terminals) {
      const append = (reason: WorkAttentionReason, taskText: string | null, taskIdentity: unknown, detail: string | null, action: WorkSummaryAction) => {
        // Opaque content identity, not a capability or registry token. Recompute to validate.
        const identity = [project.projectId, project.root, terminal.terminalId, terminal.generation,
          terminal.workArea, taskIdentity, taskText, reason, action];
        const id = `work-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
        items.push({ id, projectId: project.projectId, terminalId: terminal.terminalId,
          generation: terminal.generation, model: terminal.model, taskText, reason, detail,
          workArea: terminal.workArea, action });
      };
      const assignment = assignments.get(`${terminal.terminalId}:${terminal.generation}`);
      for (const reason of terminal.attention) {
        const verify = terminal.verify;
        const detail = reason === "blocked" ? terminal.activity?.reason ?? null
          : [verify?.command, verify?.staleReason ?? verify?.summary].filter(Boolean).join(": ") || null;
        append(reason, assignment?.task.text ?? null, assignment
          ? [assignment.owner.terminalId, assignment.owner.generation, assignment.owner.workArea, assignment.index] : null,
          detail, { kind: reason === "blocked" ? "terminal" : "evidence", terminalId: terminal.terminalId, generation: terminal.generation });
      }
      terminal.tasks.forEach(({ task, attention, nextAction }, index) => {
        for (const reason of attention) {
          const detail = reason === "worker-unavailable" ? `Assigned worker ${task.workerId} is unavailable.`
            : task.dispatchResult ? `Previous attempt ${task.dispatchResult.outcome} (worker ${task.dispatchResult.workerId}).` : null;
          append(reason, task.text, [terminal.terminalId, index, task.workerId ?? null, task.dispatchResult ?? null], detail, nextAction);
          // Task model is an explicit override; otherwise it inherits the owner.
          items[items.length - 1]!.model = task.model ?? terminal.model;
        }
      });
    }
    return { projectId: project.projectId, name: project.name, root: project.root,
      working: project.terminals.filter((terminal) => terminal.activity?.state === "working").length,
      attentionCount: items.length - start };
  });
  // Stable sort keeps original project, terminal, task and reason order within categories.
  items.sort((a, b) => ATTENTION_PRIORITY[a.reason] - ATTENTION_PRIORITY[b.reason]);
  return { projects, items };
}
