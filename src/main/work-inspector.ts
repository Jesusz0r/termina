import type { CandidateRecoverySummary, InstanceSummary, ProjectWorkSummary, ProjectWorkspaceRef, ReviewTarget, TerminalCloseResult, TerminaBridge, WorkSummaryAction } from "../../shared/types";
import { taskTarget, type OverviewTaskTarget, type OverviewCandidateCard, type OverviewCard, type OverviewWorkCard } from "./project-overview";
import { createWorkChanges } from "./work-changes";

const OPEN_LABELS: Record<WorkSummaryAction["kind"], string> = {
  terminal: "Open terminal", plan: "Open plan", changes: "Open changes", evidence: "Check details", verify: "Open Verify controls",
};

/** Selected projection with explicit controls delegated to canonical owners. Never acknowledges work. */
export function createWorkInspector(bindings: {
  element: HTMLElement;
  getVerifyReport: TerminaBridge["getVerifyReport"];
  getReviewFiles: TerminaBridge["getReviewFiles"];
  getReviewDiff: TerminaBridge["getReviewDiff"];
  startPlanTask: TerminaBridge["startPlanTask"];
  onNavigate(projectId: string, action: WorkSummaryAction): void;
  onTerminalControl(target: ReviewTarget, action: "interrupt" | "close"): Promise<TerminalCloseResult>;
  onCandidateRecovery(projectId: string, recovery: CandidateRecoverySummary): void;
  onCandidateInspect(target: OverviewTaskTarget): void;
  onFocus(): void;
  onClose(): void;
}): {
  render(project: ProjectWorkSummary, card: OverviewCard): void;
  unavailable(message: string): void;
  clear(): void;
  invalidateEvidence(terminalId?: string): void;
  invalidateChanges(terminalId?: string, owner?: ProjectWorkspaceRef): void;
  invalidateChangesForInstances(instances: InstanceSummary[]): void;
  invalidateStart(terminalId?: string, owner?: ProjectWorkspaceRef): void;
  focus(): void;
  setFocused(focused: boolean): void;
  dispose(): void;
} {
  const { element } = bindings;
  element.hidden = true;
  element.className = "overview-work-inspector";
  element.setAttribute("aria-label", "Selected work details");
  const header = document.createElement("header");
  const caption = document.createElement("p");
  caption.className = "overview-inspector-caption";
  caption.textContent = "Selected work";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "overview-inspector-close";
  close.textContent = "Close details";
  const title = document.createElement("h2");
  title.className = "overview-inspector-title";
  title.tabIndex = -1;
  const status = document.createElement("p");
  status.className = "overview-inspector-status";
  status.setAttribute("role", "status");
  const facts = document.createElement("dl");
  facts.className = "overview-inspector-facts";
  const fields = new Map<string, HTMLElement>();
  for (const label of ["Project", "Task state", "Execution", "Assigned context", "Declared task paths", "Evidence", "Attention"]) {
    const term = document.createElement("dt");
    term.textContent = label;
    const value = document.createElement("dd");
    fields.set(label, value);
    facts.append(term, value);
  }
  const actions = document.createElement("div");
  actions.className = "overview-inspector-actions";
  const button = (className: string, label: string): HTMLButtonElement => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    actions.append(node);
    return node;
  };
  const focusTask = button("overview-inspector-focus", "Focus task");
  const start = button("overview-inspector-start", "Start task");
  const startStatus = document.createElement("p");
  startStatus.className = "overview-inspector-start-status";
  startStatus.setAttribute("role", "status");
  startStatus.id = "overview-inspector-start-status";
  start.setAttribute("aria-describedby", startStatus.id);
  start.title = "Start only this task through Plan Board. The worker uses a separate sandboxed candidate. Nothing is automatically applied, staged or committed.";
  const primary = button("overview-inspector-primary", "");
  const candidateControl = button("overview-inspector-candidate", "Open candidate controls");
  const terminal = button("overview-inspector-terminal", "Open terminal");
  const plan = button("overview-inspector-plan", "Open plan");
  const check = button("overview-inspector-check", "Check details");
  const inspectChanges = button("overview-inspector-inspect-changes", "Inspect changes");
  const retry = button("overview-inspector-retry", "Retry in plan");
  const verifyControl = button("overview-inspector-verify", "Open Verify controls");
  const interrupt = button("overview-inspector-interrupt", "Send Ctrl+C");
  const closeTerminal = button("overview-inspector-close-terminal", "Close terminal");
  interrupt.title = "Confirm before interrupting this terminal. Separate workers, background children and checks are not directly stopped.";
  closeTerminal.title = "Review consequences before closing this terminal. Files are not reverted.";
  const changesElement = document.createElement("section");
  const changes = createWorkChanges({
    element: changesElement, getReviewFiles: bindings.getReviewFiles, getReviewDiff: bindings.getReviewDiff,
  });
  const report = document.createElement("pre");
  report.className = "overview-inspector-report";
  report.tabIndex = 0;
  report.setAttribute("aria-label", "Selected check details");
  report.hidden = true;
  const foot = document.createElement("p");
  foot.className = "overview-inspector-foot";
  foot.textContent = "Selecting or inspecting does not resolve attention. Marked task state, agent activity and check evidence are separate facts.";
  header.append(caption, close);
  element.append(header, title, status, facts, actions, startStatus, changesElement, report, foot);
  let selected: { projectId: string; projectRoot: string; project: ProjectWorkSummary; card: OverviewWorkCard } | null = null;
  let selectedRecovery: { projectId: string; card: OverviewCandidateCard } | null = null;
  let evidenceKey = "";
  let reportSequence = 0;
  let controlKey = "";
  let controlSequence = 0;
  let controlPending = false;
  let startKey = "";
  let startSequence = 0;
  let startPending = false;
  let startAvailable = false;
  let available = false;
  let focused = false;
  let disposed = false;

  function clearReport(): void {
    reportSequence++;
    report.hidden = true;
    report.textContent = "";
    report.setAttribute("aria-busy", "false");
    status.textContent = "";
  }

  async function inspectEvidence(): Promise<void> {
    if (disposed || !available || !selected?.card.terminal.verify || selected.card.task?.task.candidate &&
      (selected.card.task.worker?.terminalId !== selected.card.terminal.terminalId || selected.card.task.worker.generation !== selected.card.terminal.generation)) return;
    const target = selected.card.terminal;
    const key = evidenceKey;
    const sequence = ++reportSequence;
    const isCurrent = (): boolean => !disposed && available && !element.hidden
      && key === evidenceKey && sequence === reportSequence;
    report.hidden = false;
    report.textContent = "Loading check details…";
    report.setAttribute("aria-busy", "true");
    status.textContent = "Loading check details…";
    try {
      const text = await bindings.getVerifyReport(target.terminalId, target.generation);
      if (!isCurrent()) return;
      report.textContent = text ?? "Check details unavailable for this terminal generation. Refresh work or inspect the terminal.";
      status.textContent = text === null ? "Check details unavailable." : "Check details loaded.";
    } catch {
      if (!isCurrent()) return;
      report.textContent = "Could not load check details. Try again or open the terminal.";
      status.textContent = "Could not load check details.";
    } finally {
      if (isCurrent()) report.setAttribute("aria-busy", "false");
    }
  }

  function resetControl(): void {
    controlSequence++;
    controlPending = false;
  }

  async function controlTerminal(action: "interrupt" | "close"): Promise<void> {
    const control = action === "interrupt" ? interrupt : closeTerminal;
    const terminal = selected?.card.terminal;
    const area = terminal?.workArea;
    if (disposed || !available || !selected || !terminal || !area || control.hidden || control.disabled || controlPending) return;
    const target: ReviewTarget = { projectId: selected.projectId, workspaceId: area.workspaceId, root: area.root,
      terminalId: terminal.terminalId, generation: terminal.generation };
    const key = controlKey;
    const sequence = ++controlSequence;
    const isCurrent = (): boolean => !disposed && available && !element.hidden && sequence === controlSequence && key === controlKey;
    controlPending = true;
    interrupt.disabled = closeTerminal.disabled = true;
    status.textContent = "Waiting for terminal confirmation…";
    try {
      const result = await bindings.onTerminalControl(target, action);
      if (!isCurrent()) return;
      status.textContent = result.ok ? action === "interrupt" ? "Ctrl+C sent. Inspect the terminal for its outcome." : "Terminal closed."
        : result.cancelled ? "Terminal action cancelled." : result.error ?? "The terminal action could not be completed.";
    } catch {
      if (isCurrent()) status.textContent = "The terminal action could not be completed. Refresh work and try again.";
    } finally {
      if (isCurrent()) {
        controlPending = false;
        interrupt.disabled = closeTerminal.disabled = false;
      }
    }
  }

  function setStartDisabled(disabled: boolean): void {
    const hadFocus = document.activeElement === start;
    start.disabled = disabled;
    // Native disabled/hidden buttons lose keyboard focus; keep it in the inspector.
    if (disabled && hadFocus && !disposed && !element.hidden) title.focus({ preventScroll: true });
  }

  function resetStart(): void {
    startSequence++;
    startPending = false;
    startAvailable = false;
    setStartDisabled(true);
    startStatus.textContent = "";
    startStatus.hidden = true;
    start.setAttribute("aria-busy", "false");
  }

  function invalidateStart(terminalId?: string, owner?: ProjectWorkspaceRef): void {
    if (disposed || !selected) return;
    const target = selected.card.owner;
    if (terminalId && terminalId !== target.terminalId) return;
    if (owner && (owner.projectId !== selected.projectId || owner.workspaceId !== target.workArea?.workspaceId)) return;
    resetStart();
  }

  async function startTask(): Promise<void> {
    const task = selected?.card.task;
    const area = selected?.card.owner.workArea;
    if (disposed || !available || !startAvailable || !selected || !task || !area || start.hidden || start.disabled || startPending) return;
    const request = { projectRoot: selected.projectRoot,
      owner: { projectId: selected.projectId, workspaceId: area.workspaceId, root: area.root,
        terminalId: selected.card.owner.terminalId, generation: selected.card.owner.generation },
      task: structuredClone(task.task) };
    const key = startKey;
    const sequence = ++startSequence;
    const isCurrent = (): boolean => !disposed && available && startAvailable && !element.hidden
      && sequence === startSequence && key === startKey;
    startPending = true;
    setStartDisabled(true);
    start.setAttribute("aria-busy", "true");
    startStatus.hidden = false;
    startStatus.textContent = "Starting this task in a separate candidate…";
    let accepted = false;
    try {
      const result = await bindings.startPlanTask(request);
      if (!isCurrent()) return;
      accepted = result.ok;
      startStatus.textContent = result.ok ? "Task dispatched to a separate candidate. Its worker reports startup and execution separately. Nothing is automatically applied, staged or committed."
        : result.error ?? "The task could not be started. Refresh work and try again.";
    } catch {
      if (isCurrent()) startStatus.textContent = "The task could not be started. Refresh work and try again.";
    } finally {
      if (isCurrent()) {
        // Keep an accepted request disabled until its canonical assignment refreshes.
        startPending = accepted;
        setStartDisabled(startPending || selected?.card.task?.startError !== null);
        start.setAttribute("aria-busy", "false");
      }
    }
  }

  function navigate(action: WorkSummaryAction): void {
    if (disposed || !available || !selected) return;
    bindings.onNavigate(selected.projectId, action);
  }
  const onPrimary = (): void => {
    if (disposed || !available || primary.disabled) return;
    if (selectedRecovery) {
      bindings.onCandidateRecovery(selectedRecovery.projectId, selectedRecovery.card.recovery);
      return;
    }
    if (!selected) return;
    if (selected.card.action.kind === "evidence") void inspectEvidence();
    else navigate(selected.card.action);
  };
  const onTerminal = (): void => {
    const target = selected?.card.terminal;
    if (target && !terminal.hidden && !terminal.disabled) navigate({ kind: "terminal", terminalId: target.terminalId, generation: target.generation });
  };
  const onPlan = (): void => {
    const owner = selected?.card.owner;
    if (owner && selected?.card.task) navigate({ kind: "plan", terminalId: owner.terminalId, generation: owner.generation });
  };
  const onRetry = (): void => {
    if (!selected?.card.task || retry.hidden || retry.disabled) return;
    const owner = selected.card.owner;
    navigate({ kind: "plan", terminalId: owner.terminalId, generation: owner.generation, taskText: selected.card.task.task.text });
  };
  const onVerify = (): void => {
    const terminal = selected?.card.terminal;
    if (terminal && !verifyControl.hidden && !verifyControl.disabled) navigate({ kind: "verify", terminalId: terminal.terminalId, generation: terminal.generation });
  };
  const onCandidate = (): void => {
    if (!disposed && available && selected?.card.task?.candidate && !candidateControl.hidden && !candidateControl.disabled) {
      bindings.onCandidateInspect(taskTarget(selected.project, selected.card));
    }
  };
  const onStart = (): void => { void startTask(); };
  const onInterrupt = (): void => { void controlTerminal("interrupt"); };
  const onCloseTerminal = (): void => { void controlTerminal("close"); };
  const onCheck = (): void => { void inspectEvidence(); };
  const onFocus = (): void => { if (!disposed && available && !focusTask.disabled) bindings.onFocus(); };
  const onChanges = (): void => { if (!disposed && available) changes.open(); };
  const onClose = (): void => { if (!disposed) bindings.onClose(); };
  candidateControl.addEventListener("click", onCandidate);
  start.addEventListener("click", onStart);
  primary.addEventListener("click", onPrimary);
  terminal.addEventListener("click", onTerminal);
  plan.addEventListener("click", onPlan);
  check.addEventListener("click", onCheck);
  inspectChanges.addEventListener("click", onChanges);
  focusTask.addEventListener("click", onFocus);
  close.addEventListener("click", onClose);
  retry.addEventListener("click", onRetry);
  verifyControl.addEventListener("click", onVerify);
  interrupt.addEventListener("click", onInterrupt);
  closeTerminal.addEventListener("click", onCloseTerminal);

  function renderRecovery(project: ProjectWorkSummary, card: OverviewCandidateCard): void {
    clearReport();
    resetControl();
    resetStart();
    start.hidden = true;
    candidateControl.hidden = true;
    primary.classList.remove("is-secondary");
    changes.clear();
    selected = null;
    selectedRecovery = { projectId: project.projectId, card };
    evidenceKey = controlKey = "";
    available = true;
    element.hidden = facts.hidden = false;
    title.textContent = card.title;
    const values: Record<string, string> = {
      Project: `${project.name}\n${project.root}`, "Task state": "No Plan Board task assigned",
      Execution: card.execution, "Assigned context": card.context,
      "Declared task paths": "No Plan Board task assigned", Evidence: card.evidence,
      Attention: card.attention + (card.recovery.recovery === "discard"
        ? "\nThis comparison cannot be reopened. Inspect the existing discard controls."
        : "\nRetry opening resumes the retained session; it does not replay the task."),
    };
    for (const [label, value] of Object.entries(values)) fields.get(label)!.textContent = value;
    primary.hidden = false;
    primary.disabled = false;
    primary.textContent = card.recovery.recovery === "open" ? "Open candidate recovery" : "Open discard controls";
    for (const control of [focusTask, terminal, plan, check, inspectChanges, retry, verifyControl, interrupt, closeTerminal]) {
      control.hidden = true;
      control.disabled = true;
    }
  }

  return {
    render: (project, card) => {
      if (disposed) return;
      if ("recovery" in card) { renderRecovery(project, card); return; }
      selectedRecovery = null;
      focusTask.hidden = focused;
      primary.hidden = false;
      const resultOnly = !!card.task?.task.candidate && (card.task.worker?.terminalId !== card.terminal.terminalId
        || card.task.worker.generation !== card.terminal.generation);
      const verify = resultOnly ? null : card.terminal.verify;
      candidateControl.hidden = !card.task?.candidate;
      candidateControl.disabled = !card.task?.candidate;
      const nextControlKey = JSON.stringify([project.projectId, project.root, card.key, card.owner.terminalId, card.owner.generation,
        card.owner.workArea, card.terminal.terminalId, card.terminal.generation, card.terminal.workArea]);
      if (nextControlKey !== controlKey || !available) resetControl();
      controlKey = nextControlKey;
      const key = JSON.stringify([project.projectId, project.root, card.key, card.terminal.terminalId,
        card.terminal.generation, card.terminal.workArea, card.task?.task.candidate, card.task?.candidate, verify]);
      if (key !== evidenceKey || !available) clearReport();
      evidenceKey = key;
      const nextStartKey = JSON.stringify([project.projectId, project.root, card.key, card.owner.terminalId,
        card.owner.generation, card.owner.workArea, card.task?.task, card.task?.startError]);
      if (nextStartKey !== startKey || !available) resetStart();
      startKey = nextStartKey;
      startAvailable = true;
      start.hidden = !card.task || card.task.task.state !== "pending" || !!card.task.task.workerId
        || !!card.task.worker || !!card.task.task.dispatchResult;
      setStartDisabled(startPending || !card.owner.workArea || card.task?.startError !== null);
      startStatus.hidden = start.hidden;
      if (!start.hidden && !startStatus.textContent) startStatus.textContent = card.task?.startError
        ?? "Starts one worker in a separate sandboxed candidate. Nothing is automatically applied, staged or committed.";
      primary.classList.toggle("is-secondary", !start.hidden);
      const previousTrackedChanges = selected?.card.terminal.trackedChanges;
      selected = { projectId: project.projectId, projectRoot: project.root, project, card };
      const area = resultOnly ? null : card.terminal.workArea;
      changes.render(area ? {
        projectId: project.projectId, workspaceId: area.workspaceId, root: area.root,
        terminalId: card.terminal.terminalId, generation: card.terminal.generation,
      } : null, JSON.stringify([project.root, card.key, card.owner.terminalId, card.owner.generation,
        card.owner.workArea, card.terminal.workArea, card.task?.task.candidate, card.task?.candidate]));
      if (previousTrackedChanges !== undefined && previousTrackedChanges !== card.terminal.trackedChanges) changes.invalidate();
      inspectChanges.hidden = !area;
      inspectChanges.disabled = !area;
      available = true;
      element.hidden = false;
      facts.hidden = false;
      title.textContent = card.title;
      const values: Record<string, string> = {
        Project: `${project.name}\n${project.root}`,
        "Task state": card.state,
        Execution: card.execution,
        "Assigned context": card.context,
        "Declared task paths": card.task ? card.task.task.paths.join("\n") || "No task paths declared" : "No Plan Board task assigned",
        Evidence: card.evidence + (verify?.summary ? `\n${verify.summary}` : "")
          + (verify?.staleReason ? `\n${verify.staleReason}` : "")
          + (verify?.result ? `\n${verify.state === "stale" ? "Historical result" : "Recorded result"}: ${verify.result.state} · exit ${verify.result.exitCode ?? "unknown"}` : ""),
        Attention: card.attention || "No recorded attention for this work; not proof of completion or review",
      };
      for (const [label, value] of Object.entries(values)) {
        const field = fields.get(label)!;
        if (field.textContent !== value) field.textContent = value;
      }
      focusTask.textContent = card.task ? "Focus task" : "Focus context";
      focusTask.disabled = !area || !!card.task && (card.task.worker?.terminalId !== card.terminal.terminalId
        || card.task.worker.generation !== card.terminal.generation);
      focusTask.title = focusTask.disabled ? "No live worker assigned. Open the plan to inspect or retry this task." : "Use the existing terminal with changes and evidence";
      const hasEffectiveTerminal = !!area && (!card.task || card.task.worker?.terminalId === card.terminal.terminalId
        && card.task.worker.generation === card.terminal.generation);
      retry.hidden = !card.task || !!card.task.task.workerId || card.task.task.state === "done" || !card.task.task.dispatchResult;
      retry.disabled = false;
      verifyControl.hidden = !verify || !hasEffectiveTerminal;
      verifyControl.disabled = false;
      interrupt.hidden = !hasEffectiveTerminal || card.terminal.activity?.state !== "working" && card.terminal.activity?.state !== "blocked";
      closeTerminal.hidden = !hasEffectiveTerminal;
      interrupt.disabled = closeTerminal.disabled = controlPending;
      primary.textContent = OPEN_LABELS[card.action.kind];
      terminal.hidden = card.action.kind === "terminal";
      plan.hidden = !card.task || card.action.kind === "plan";
      check.hidden = !verify || card.action.kind === "evidence";
      for (const control of [primary, terminal, plan, check]) control.disabled = false;
      terminal.hidden = terminal.hidden || resultOnly;
      check.hidden = check.hidden || resultOnly;
      primary.disabled = resultOnly && card.action.kind !== "plan";
    },
    unavailable: (message) => {
      if (disposed || !selected && !selectedRecovery) return;
      available = false;
      resetControl();
      resetStart();
      clearReport();
      for (const control of [candidateControl, retry, verifyControl, interrupt, closeTerminal]) control.disabled = true;
      changes.unavailable();
      inspectChanges.disabled = true;
      focusTask.disabled = true;
      facts.hidden = true;
      status.textContent = message;
      for (const control of [primary, terminal, plan, check]) control.disabled = true;
    },
    clear: () => {
      resetControl();
      resetStart();
      startKey = "";
      controlKey = "";
      clearReport();
      changes.clear();
      selected = null;
      selectedRecovery = null;
      evidenceKey = "";
      available = false;
      element.hidden = true;
    },
    invalidateEvidence: (terminalId) => {
      if (!selected || disposed) return;
      if (terminalId && selected.card.owner.terminalId !== terminalId && selected.card.terminal.terminalId !== terminalId) return;
      clearReport();
    },
    invalidateChanges: (terminalId, owner) => {
      if (!selected || disposed) return;
      if (terminalId && selected.card.owner.terminalId !== terminalId && selected.card.terminal.terminalId !== terminalId) return;
      const area = selected.card.terminal.workArea;
      if (owner && (owner.projectId !== selected.projectId || owner.workspaceId !== area?.workspaceId)) return;
      changes.invalidate();
    },
    invalidateChangesForInstances: (instances) => {
      if (!selected || disposed) return;
      const byId = new Map(instances.map((instance) => [instance.id, instance]));
      for (const terminal of [selected.card.owner, selected.card.terminal]) {
        const current = byId.get(terminal.terminalId);
        if (!current || !terminal.workArea || current.generation !== terminal.generation || current.projectId !== selected.projectId
          || current.workspaceId !== terminal.workArea.workspaceId || current.cwd !== terminal.workArea.root) {
          changes.invalidate();
          invalidateStart();
          return;
        }
      }
    },
    invalidateStart,
    focus: () => { if (!disposed && !element.hidden) title.focus(); },
    setFocused: (nextFocused) => {
      focused = nextFocused;
      focusTask.hidden = focused || !!selectedRecovery;
      close.hidden = focused;
      caption.textContent = focused ? "Focused work" : "Selected work";
      if (focused && available) changes.open();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      resetControl();
      resetStart();
      clearReport();
      changes.dispose();
      selected = null;
      selectedRecovery = null;
      candidateControl.removeEventListener("click", onCandidate);
      start.removeEventListener("click", onStart);
      primary.removeEventListener("click", onPrimary);
      terminal.removeEventListener("click", onTerminal);
      plan.removeEventListener("click", onPlan);
      check.removeEventListener("click", onCheck);
      inspectChanges.removeEventListener("click", onChanges);
      focusTask.removeEventListener("click", onFocus);
      close.removeEventListener("click", onClose);
      retry.removeEventListener("click", onRetry);
      verifyControl.removeEventListener("click", onVerify);
      interrupt.removeEventListener("click", onInterrupt);
      closeTerminal.removeEventListener("click", onCloseTerminal);
    },
  };
}
