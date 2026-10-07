import type { ProjectWorkSummary, TerminaBridge, TerminalWorkSummary, WorkAttentionReason, WorkSummaryAction } from "../../shared/types";
import { presentBlockedLabel } from "../known-state";

interface WorkContext {
  projectId: string;
  activationGeneration: number;
  terminalId: string;
  generation: number;
}

export const ATTENTION_LABELS: Record<WorkAttentionReason, string> = {
  blocked: "Agent blocked", "verify-failed": "Verify failed", "verify-timeout": "Verify timed out",
  "verify-stale": "Verify is outdated", "verify-cancelled": "Verify was cancelled",
  "task-incomplete": "Task attempt incomplete", "task-failed": "Task attempt failed",
  "task-interrupted": "Task attempt interrupted", "worker-unavailable": "Assigned worker unavailable",
};
export const ACTION_LABELS: Record<WorkSummaryAction["kind"], string> = {
  terminal: "Inspect terminal", plan: "Inspect plan", changes: "Inspect changes", evidence: "Inspect check",
};

/** One transient project projection; no execution, evidence or review ownership. */
export function createWorkSummary(bindings: {
  element: HTMLDetailsElement;
  bridge: TerminaBridge;
  getContext(): WorkContext | null;
  onNavigate(action: WorkSummaryAction, projectId: string): void;
}): { syncContext(): void; showCheck(): Promise<boolean>; dispose(): void } {
  const { element, bridge } = bindings;
  const heading = element.querySelector<HTMLElement>(".work-summary-heading")!;
  const content = element.querySelector<HTMLElement>(".work-summary-content")!;
  const facts = document.createElement("dl");
  const fields = new Map<string, HTMLElement>();
  for (const label of ["Project", "Agent", "Task", "Execution", "Work area", "Evidence", "Change Review", "Attention"]) {
    const term = document.createElement("dt");
    term.textContent = label;
    const value = document.createElement("dd");
    fields.set(label, value);
    facts.append(term, value);
  }
  const taskList = document.createElement("ul");
  taskList.className = "work-summary-tasks";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "work-summary-action";
  const report = document.createElement("pre");
  report.className = "work-summary-report";
  report.tabIndex = 0;
  report.setAttribute("aria-label", "Check execution details");
  report.hidden = true;
  const taskRows = new Map<string, { row: HTMLLIElement; text: HTMLElement; button: HTMLButtonElement }>();
  let contextKey = "";
  let projection: ProjectWorkSummary | null = null;
  let selected: TerminalWorkSummary | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestSequence = 0;
  let reportSequence = 0;
  let disposed = false;

  const keyOf = (context: WorkContext | null): string => context
    ? `${context.projectId}:${context.activationGeneration}:${context.terminalId}:${context.generation}` : "";
  const current = (key: string): boolean => !disposed && key === contextKey && key === keyOf(bindings.getContext());
  function field(label: string, value: string): void {
    const target = fields.get(label)!;
    if (target.textContent !== value) target.textContent = value;
  }

  async function inspectEvidence(): Promise<void> {
    const context = bindings.getContext();
    if (!context || !selected || !current(keyOf(context))) return;
    const key = contextKey;
    const sequence = ++reportSequence;
    report.hidden = false;
    report.textContent = "Loading check details…";
    try {
      const text = await bridge.getVerifyReport(selected.terminalId, selected.generation);
      if (!current(key) || sequence !== reportSequence) return;
      report.textContent = text ?? "Check details unavailable for this terminal generation.";
    } catch {
      if (current(key) && sequence === reportSequence) report.textContent = "Could not load check details. Inspect the terminal or try again.";
    }
  }

  function navigate(action: WorkSummaryAction): void {
    if (!projection || !current(contextKey)) return;
    if (action.kind === "evidence") void inspectEvidence();
    else bindings.onNavigate(action, projection.projectId);
  }
  const onNext = (): void => { if (selected) navigate(selected.nextAction); };
  next.addEventListener("click", onNext);

  function render(summary: ProjectWorkSummary, context: WorkContext): void {
    const previousVerify = selected?.verify;
    selected = summary.terminals.find((terminal) => terminal.terminalId === context.terminalId && terminal.generation === context.generation);
    if (JSON.stringify(previousVerify) !== JSON.stringify(selected?.verify)) {
      reportSequence++;
      report.hidden = true;
    }
    if (!selected) {
      heading.textContent = "Work context · terminal unavailable";
      content.hidden = true;
      return;
    }
    content.hidden = false;
    const terminal = selected;
    const unresolved = summary.terminals.reduce((count, item) => count + item.attention.length + item.tasks.reduce((n, task) => n + task.attention.length, 0), 0);
    const working = summary.terminals.filter((item) => item.activity?.state === "working").length;
    heading.textContent = `Project work · ${working} working · ${unresolved} attention reason${unresolved === 1 ? "" : "s"}`;
    field("Project", `${summary.name} · ${summary.root}`);
    field("Agent", `${terminal.terminalId} · ${terminal.type === "shell" ? "shell" : terminal.model ?? "model unknown"}`);
    const assignment = summary.terminals.flatMap((owner) => owner.tasks.map((task) => ({ owner, task })))
      .find(({ task }) => task.worker?.terminalId === terminal.terminalId && task.worker.generation === terminal.generation);
    field("Task", assignment ? `${assignment.task.task.text} · owner ${assignment.owner.terminalId}`
      : terminal.tasks.length ? `${terminal.tasks.length} Plan Board task${terminal.tasks.length === 1 ? "" : "s"} owned by ${terminal.terminalId}` : "No Plan Board task assigned");
    field("Execution", terminal.activity?.state === "blocked" ? presentBlockedLabel(terminal.activity.reason)
      : terminal.activity?.state ?? "Shell activity unknown");
    field("Work area", terminal.workArea
      ? `${terminal.workArea.kind === "project" ? "Shared project files" : "Separate candidate tree"} · ${terminal.workArea.root}` : "Assigned work area unavailable");
    const verify = terminal.verify;
    field("Evidence", verify ? `${verify.state === "untested" ? "Not run" : verify.state === "stale" ? "Outdated" : verify.state} · ${verify.command ?? "command not recorded"}`
      + (verify.state === "stale" && verify.result ? ` · historical ${verify.result.state} (exit ${verify.result.exitCode ?? "unknown"})` : "")
      + (verify.staleReason ? ` · ${verify.staleReason}` : "") : "Verify unavailable for shells");
    field("Change Review", `${terminal.trackedChanges} tracked path${terminal.trackedChanges === 1 ? "" : "s"} · not a review-completion or clean-tree claim`);
    const attention = [...terminal.attention, ...terminal.tasks.flatMap((task) => task.attention)];
    field("Attention", attention.length ? attention.map((reason) => ATTENTION_LABELS[reason]).join(" · ") : "No recorded blocker or failed attempt; idle is not task completion");
    const seen = new Set(terminal.tasks.map((task, index) => `${index}:${task.task.text}`));
    for (const [key, entry] of taskRows) {
      if (seen.has(key)) continue;
      entry.row.remove();
      taskRows.delete(key);
    }
    terminal.tasks.forEach((task, index) => {
      const key = `${index}:${task.task.text}`;
      let entry = taskRows.get(key);
      if (!entry) {
        const row = document.createElement("li");
        const text = document.createElement("span");
        const button = document.createElement("button");
        button.type = "button";
        button.addEventListener("click", () => {
          const latest = selected?.tasks[index];
          if (latest?.task.text === task.task.text) navigate(latest.nextAction);
        });
        row.append(text, button);
        taskList.appendChild(row);
        entry = { row, text, button };
        taskRows.set(key, entry);
      }
      entry.text.textContent = `${task.task.text} · marked ${task.task.state}`
        + (task.worker ? ` · worker ${task.worker.terminalId}` : " · no live worker assigned")
        + (task.task.dispatchResult ? ` · last ${task.task.dispatchResult.outcome} (${task.task.dispatchResult.workerId})` : "");
      entry.button.textContent = ACTION_LABELS[task.nextAction.kind];
      const position = taskList.children[index];
      if (position !== entry.row) taskList.insertBefore(entry.row, position ?? null);
    });
    next.textContent = ACTION_LABELS[terminal.nextAction.kind];
    // Check inspection remains available even when another reason owns the primary action.
    evidenceButton.hidden = !verify;
  }

  const evidenceButton = document.createElement("button");
  evidenceButton.type = "button";
  evidenceButton.className = "work-summary-action";
  evidenceButton.textContent = "Check details";
  const onEvidence = (): void => { void inspectEvidence(); };
  evidenceButton.addEventListener("click", onEvidence);
  content.append(facts, taskList, next, evidenceButton, report);

  async function load(): Promise<void> {
    timer = undefined;
    const context = bindings.getContext();
    if (!context || !current(keyOf(context))) return;
    const key = contextKey;
    const sequence = ++requestSequence;
    try {
      const summary = await bridge.getProjectWorkSummary(context.projectId);
      if (!current(key) || sequence !== requestSequence) return;
      if (!summary || summary.projectId !== context.projectId) throw new Error("project unavailable");
      projection = summary;
      render(summary, context);
    } catch {
      if (!current(key) || sequence !== requestSequence) return;
      projection = null;
      selected = undefined;
      heading.textContent = "Work context unavailable · try switching back to this terminal";
      content.hidden = true;
    }
  }

  function refresh(): void {
    if (disposed || !bindings.getContext()) return;
    requestSequence++;
    if (timer === undefined) timer = setTimeout(() => { void load(); }, 150);
  }

  function syncContext(): void {
    const context = bindings.getContext();
    const key = keyOf(context);
    if (key === contextKey) return;
    contextKey = key;
    requestSequence++;
    reportSequence++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    projection = null;
    selected = undefined;
    element.hidden = !context;
    report.hidden = true;
    content.hidden = true;
    heading.textContent = "Loading work context…";
    if (context) void load();
  }

  const belongsHere = (terminalId: string): boolean => projection?.terminals.some((terminal) => terminal.terminalId === terminalId)
    ?? bindings.getContext()?.terminalId === terminalId;
  const refreshOwner = ({ terminalId }: { terminalId: string }): void => { if (belongsHere(terminalId)) refresh(); };
  const unsubs = [
    bridge.onInstances(refresh),
    bridge.onPlanUpdate(({ instanceId }) => refreshOwner({ terminalId: instanceId })),
    bridge.onModifiedList(({ instanceId }) => refreshOwner({ terminalId: instanceId })),
    bridge.onVerifyState(({ terminalId }) => {
      if (!belongsHere(terminalId)) return;
      if (terminalId === selected?.terminalId) {
        reportSequence++;
        report.hidden = true;
      }
      refresh();
    }), bridge.onTimelineClear(refreshOwner),
    bridge.onAgentStatus(({ terminalId, model }) => {
      const terminal = projection?.terminals.find((terminal) => terminal.terminalId === terminalId);
      if (terminal && terminal.model !== model) refresh();
    }),
    bridge.onTimelinePrefix(({ terminalId, activity }) => {
      const previous = projection?.terminals.find((terminal) => terminal.terminalId === terminalId)?.activity;
      if (activity && previous && (previous.state !== activity.state || previous.reason !== activity.reason)) refresh();
    }),
  ];
  return {
    syncContext,
    showCheck: async () => {
      const key = contextKey;
      if (!key || !current(key)) return false;
      element.open = true;
      element.querySelector<HTMLElement>("summary")?.focus();
      if (!selected) await load();
      if (!current(key) || !selected) return false;
      await inspectEvidence();
      return current(key);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      requestSequence++;
      reportSequence++;
      if (timer !== undefined) clearTimeout(timer);
      next.removeEventListener("click", onNext);
      evidenceButton.removeEventListener("click", onEvidence);
      for (const unsub of unsubs) unsub();
    },
  };
}
