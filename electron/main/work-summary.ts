import { basename } from "node:path";
import { createHash } from "node:crypto";
import type {
  AgentActivityView, AgentIntervention, CandidateRecoverySummary, PlanTask, ProjectWorkSummary, TerminalWorkSummary,
  VerifyInfo, WorkAreaSummary, WorkAttentionItem, WorkAttentionReason, WorkOverview, WorkSummaryAction, WorldlineSummary,
} from "../../shared/types.js";

export interface WorkSummaryTerminalFacts {
  id: string;
  generation: number;
  type: "agent" | "shell";
  model: string | null;
  /** Null for a shell until external CLI activity is observed. */
  activity: AgentActivityView | null;
  workspace: { id: string; root: string; primary: boolean; comparisonId?: string } | null;
  verify: VerifyInfo;
  trackedChanges: number;
  plan: readonly PlanTask[];
  /** Live dispatcher provenance, never inferred from a task's persisted terminal id. */
  dispatchAssignment: { ownerId: string; taskText: string } | null;
}

/** Presentation projection only. Activity, tasks, source validity and lifecycle stay with their owners. */
export function projectWorkSummary(
  project: { id: string; cwd: string },
  facts: readonly WorkSummaryTerminalFacts[],
  candidateRecoveries: CandidateRecoverySummary[] = [],
  candidates: readonly WorldlineSummary[] = [],
): ProjectWorkSummary {
  const live = new Map(facts.map((terminal) => [terminal.id, terminal]));
  const areas = new Map(candidates.map((candidate) => [`${candidate.comparisonId}:${candidate.label}`, candidate]));
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
    const activity = terminal.activity;
    const attention: WorkAttentionReason[] = [];
    if (activity?.state === "blocked") attention.push("blocked");
    if (verify?.state === "fail") attention.push("verify-failed");
    if (verify?.state === "timeout") attention.push("verify-timeout");
    if (verify?.state === "stale") attention.push("verify-stale");
    if (verify?.state === "cancelled") attention.push("verify-cancelled");
    const tasks = terminal.plan.map((task) => {
      const assigned = task.workerId ? live.get(task.workerId) : undefined;
      const area = task.candidate ? areas.get(`${task.candidate.comparisonId}:${task.candidate.label}`) : undefined;
      const candidate = area ? { comparisonId: area.comparisonId, label: area.label, root: area.root,
        version: area.version, state: area.state, error: area.error, headStateId: area.headStateId } : null;
      // Only the dispatcher can certify a live assignment, including one on a separate candidate tree.
      const assignment = assigned?.dispatchAssignment;
      const sameSource = task.candidate ? area && assigned?.workspace?.primary === false
        && assigned.workspace.comparisonId === area.comparisonId && assigned.workspace.root === area.root
        : assigned?.workspace?.id === terminal.workspace?.id;
      const worker = terminal.workspace && assigned?.type === "agent" && assigned.workspace && sameSource
        && assignment?.ownerId === terminal.id && assignment.taskText === task.text
        ? { terminalId: assigned.id, generation: assigned.generation } : null;
      const taskAttention: WorkAttentionReason[] = [];
      if (task.workerId && !worker) taskAttention.push("worker-unavailable");
      if (!task.workerId && task.state !== "done") {
        if (task.dispatchResult?.outcome === "incomplete") taskAttention.push("task-incomplete");
        if (task.dispatchResult?.outcome === "failed") taskAttention.push("task-failed");
        if (task.dispatchResult?.outcome === "interrupted") taskAttention.push("task-interrupted");
      }
      // A completed attempt is a result to inspect, not human acceptance. Candidate
      // results additionally need a retained capture, never the owner's source checks.
      // Ready means the terminal is open, not that the recorded attempt is incomplete.
      if (terminal.type === "agent" && !task.workerId && task.state !== "active" && task.dispatchResult?.outcome === "completed"
        && (task.candidate ? candidate?.headStateId && ["ready", "settled", "verifying", "conflict"].includes(candidate.state)
          : terminal.workspace?.primary)) taskAttention.push("pending-review");
      return {
        task,
        worker,
        candidate,
        attention: taskAttention,
        nextAction: worker ? { kind: "terminal" as const, ...worker } : { ...action("plan"), taskText: task.text },
      };
    });
    return {
      terminalId: terminal.id, generation: terminal.generation, type: terminal.type,
      model: terminal.type === "agent" ? terminal.model : null,
      activity, workArea: area, verify, trackedChanges: terminal.trackedChanges,
      tasks, attention,
    };
  });
  return { projectId: project.id, name: basename(project.cwd) || project.cwd, root: project.cwd, terminals, candidateRecoveries };
}

const ATTENTION_PRIORITY: Record<WorkAttentionReason, number> = {
  blocked: 0, "worker-unavailable": 0,
  "task-incomplete": 1, "task-failed": 1, "task-interrupted": 1,
  "verify-failed": 2, "verify-timeout": 2, "verify-stale": 2, "verify-cancelled": 2,
  "pending-review": 3,
};

/** Compose canonical project summaries. This adds no execution or attention state. */
export function workOverview(summaries: readonly ProjectWorkSummary[]): WorkOverview {
  const items: WorkAttentionItem[] = [];
  const interventions = new Map<string, AgentIntervention>();
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
      const append = (reason: WorkAttentionReason, taskText: string | null, taskIdentity: unknown, detail: string | null,
        action: WorkSummaryAction, candidate?: WorkAttentionItem["candidate"]) => {
        // Opaque content identity, not a capability or registry token. Recompute to validate.
        const intervention = reason === "blocked" ? terminal.activity?.intervention ?? null : null;
        const identity = [project.projectId, project.root, terminal.terminalId, terminal.generation,
          terminal.workArea, taskIdentity, taskText, reason, action, candidate ?? null, intervention];
        const id = `work-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
        if (intervention) interventions.set(id, intervention);
        items.push({ id, projectId: project.projectId, terminalId: terminal.terminalId,
          generation: terminal.generation, model: terminal.model, taskText, reason, detail,
          workArea: terminal.workArea, action, ...(candidate ? { candidate } : {}) });
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
      terminal.tasks.forEach(({ task, attention, nextAction, candidate }, index) => {
        for (const reason of attention) {
          const detail = reason === "worker-unavailable" ? `Assigned worker ${task.workerId} is unavailable.`
            : reason === "pending-review" ? `Completed attempt (worker ${task.dispatchResult!.workerId}). Human review is not recorded. `
              + (candidate ? "The captured candidate result is not applied to the project. Inspect its changes and checks."
                : "This attempt used shared project files. Inspect the current changes and exact checks; completion does not establish acceptance.")
              : task.dispatchResult ? `Previous attempt ${task.dispatchResult.outcome} (worker ${task.dispatchResult.workerId}).` : null;
          append(reason, task.text, [terminal.terminalId, index, task.workerId ?? null, task.dispatchResult ?? null], detail, nextAction, candidate ?? undefined);
          // Task model is an explicit override; otherwise it inherits the owner.
          items[items.length - 1]!.model = task.model ?? terminal.model;
        }
      });
    }
    return { ...project,
      working: project.terminals.filter((terminal) => terminal.activity?.state === "working").length,
      attentionCount: items.length - start };
  });
  // Human pickers come first, oldest first. Ties and other categories keep stable owner order.
  items.sort((a, b) => {
    const left = interventions.get(a.id);
    const right = interventions.get(b.id);
    if (left && right) return left.since - right.since;
    if (left) return -1;
    if (right) return 1;
    return ATTENTION_PRIORITY[a.reason] - ATTENTION_PRIORITY[b.reason];
  });
  return { projects, items };
}
