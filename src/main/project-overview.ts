import type { CandidateRecoverySummary, InstanceSummary, PlanWorkSummary, ProjectWorkspaceRef, ReviewTarget, TerminalWorkSummary, TerminaBridge, WorkOverview, WorkSummaryAction } from "../../shared/types";
import { presentBlockedLabel } from "../known-state";
import { ATTENTION_LABELS } from "./work-summary";
import { createWorkInspector } from "./work-inspector";

const PAGE_SIZE = 50;
type Project = WorkOverview["projects"][number];
export interface OverviewWorkCard {
  owner: TerminalWorkSummary;
  terminal: TerminalWorkSummary;
  task: PlanWorkSummary | null;
  key: string;
  title: string;
  state: string;
  execution: string;
  context: string;
  evidence: string;
  attention: string;
  action: WorkSummaryAction;
}

export interface OverviewCandidateCard extends Pick<OverviewWorkCard, "key" | "title" | "state" | "execution" | "context" | "evidence" | "attention"> {
  task: null;
  recovery: CandidateRecoverySummary;
}
export type OverviewCard = OverviewWorkCard | OverviewCandidateCard;

function execution(terminal: TerminalWorkSummary): string {
  return terminal.activity?.state === "blocked" ? presentBlockedLabel(terminal.activity.reason)
    : terminal.activity?.state ?? "Shell activity unknown";
}

function context(terminal: TerminalWorkSummary, model: string | null): string {
  const area = terminal.workArea;
  return `${terminal.terminalId} · ${terminal.type === "shell" ? "shell" : model ?? "model unknown"}\n`
    + (area ? `${area.kind === "project" ? "Shared project files" : "Separate candidate tree"} · ${area.root}` : "Assigned work area unavailable");
}

function evidence(terminal: TerminalWorkSummary, label = "Check"): string {
  const verify = terminal.verify;
  return `${label}: ${verify ? verify.state === "untested" ? "Not run" : verify.state === "stale" ? "Outdated" : verify.state : "unavailable for shells"}`
    + (verify?.command ? ` · ${verify.command}` : "")
    + (verify?.state === "stale" && verify.result ? ` · historical ${verify.result.state}` : "")
    + `\n${terminal.trackedChanges} tracked path${terminal.trackedChanges === 1 ? "" : "s"} · not a review-completion claim`;
}

function taskCard(owner: TerminalWorkSummary, task: PlanWorkSummary, occurrence: number, live: Map<string, TerminalWorkSummary>): OverviewWorkCard {
  const assigned = task.worker ? live.get(task.worker.terminalId) : undefined;
  const worker = assigned?.generation === task.worker?.generation ? assigned : undefined;
  const terminal = worker ?? owner;
  const reasons = [...task.attention, ...(worker?.attention ?? [])];
  return {
    owner, terminal, task,
    key: JSON.stringify([owner.terminalId, owner.generation, task.task.text, occurrence]),
    title: task.task.text,
    state: `Marked ${task.task.state}`,
    execution: (worker ? `${execution(worker)} · worker ${worker.terminalId}` : "No live worker assigned")
      + (task.task.dispatchResult ? ` · Previous attempt ${task.task.dispatchResult.outcome} (${task.task.dispatchResult.workerId})` : ""),
    context: `Plan owner ${owner.terminalId}\n${context(terminal, terminal.model)}`
      + (task.task.model ? `\nTask model pin ${task.task.model}` : ""),
    evidence: evidence(terminal, worker ? "Worker check" : "Owner check"),
    attention: reasons.map((reason) => ATTENTION_LABELS[reason]).join(" · "),
    action: task.nextAction,
  };
}

export function projectCards(project: Project): OverviewCard[] {
  const live = new Map(project.terminals.map((terminal) => [terminal.terminalId, terminal]));
  const assigned = new Set(project.terminals.flatMap((owner) => owner.tasks.flatMap(({ worker }) =>
    worker ? [`${worker.terminalId}:${worker.generation}`] : [])));
  const cards: OverviewCard[] = project.terminals.flatMap((terminal) => {
    if (terminal.tasks.length) {
      // Text is the Plan Board identity. Occurrence only separates repeated rendered entries.
      const occurrences = new Map<string, number>();
      return terminal.tasks.map((task) => {
        const occurrence = occurrences.get(task.task.text) ?? 0;
        occurrences.set(task.task.text, occurrence + 1);
        return taskCard(terminal, task, occurrence, live);
      });
    }
    // A live worker is represented by its real task, not a duplicate invented task.
    if (assigned.has(`${terminal.terminalId}:${terminal.generation}`)) return [];
    return [{
      owner: terminal, terminal, task: null,
      key: JSON.stringify([terminal.terminalId, terminal.generation]),
      title: `${terminal.type === "shell" ? "Shell" : "Agent"} · ${terminal.terminalId}`,
      state: "No Plan Board task assigned", execution: execution(terminal), context: context(terminal, terminal.model),
      evidence: evidence(terminal), attention: terminal.attention.map((reason) => ATTENTION_LABELS[reason]).join(" · "),
      action: terminal.nextAction,
    }];
  });
  for (const recovery of project.candidateRecoveries) cards.push({
    key: JSON.stringify(["candidate-recovery", recovery.comparisonId, recovery.label]), task: null, recovery,
    title: `Candidate ${recovery.label} · startup recovery`, state: "Startup failed",
    execution: "No live candidate terminal",
    context: `Separate candidate tree · ${recovery.root}`,
    evidence: "No live terminal check to inspect",
    attention: recovery.error ?? "Candidate startup failed",
  });
  return cards;
}

export interface OverviewTaskTarget {
  projectId: string;
  root: string;
  key: string;
  /** Content identity only, not permission to execute a task or control a terminal. */
  scope: string;
}

export function taskTarget(project: Project, card: OverviewWorkCard): OverviewTaskTarget {
  return {
    projectId: project.projectId, root: project.root, key: card.key,
    scope: JSON.stringify([card.owner.workArea, card.terminal.terminalId, card.terminal.generation,
      card.terminal.workArea, card.task?.task.paths, card.task?.worker]),
  };
}

export function findOverviewTask(overview: WorkOverview, target: OverviewTaskTarget): OverviewWorkCard | null {
  const project = overview.projects.find((entry) => entry.projectId === target.projectId && entry.root === target.root);
  if (!project) return null;
  const card = projectCards(project).find((entry) => entry.key === target.key);
  return card && !("recovery" in card) && card.task && taskTarget(project, card).scope === target.scope ? card : null;
}

/** Read-only cards from the global owner's projection. No independent IPC, task or attention state. */
export function createProjectOverview(bindings: {
  element: HTMLElement;
  onNavigate(projectId: string, action: WorkSummaryAction | null): void;
  getVerifyReport: TerminaBridge["getVerifyReport"];
  getReviewFiles: TerminaBridge["getReviewFiles"];
  getReviewDiff: TerminaBridge["getReviewDiff"];
  onSelectionChange(): void;
  onFocusTerminal(target: ReviewTarget, slot: HTMLElement, isCurrent: () => boolean): Promise<(() => void) | null>;
  onFocusChange(focused: boolean): void;
  onTerminalControl: Parameters<typeof createWorkInspector>[0]["onTerminalControl"];
  onCandidateRecovery(projectId: string, recovery: CandidateRecoverySummary): void;
  onNewProject(): void;
}): {
  render(overview: WorkOverview): void;
  clearSelection(restoreFocus?: boolean): boolean;
  selectTask(target: OverviewTaskTarget): boolean;
  leaveFocus(): void;
  setUnavailable(): void;
  invalidateEvidence(terminalId?: string): void;
  invalidateChanges(terminalId?: string, owner?: ProjectWorkspaceRef): void;
  invalidateChangesForInstances(instances: InstanceSummary[]): void;
  dispose(): void;
} {
  const { element } = bindings;
  const toolbar = document.createElement("div");
  toolbar.className = "overview-toolbar";
  const heading = document.createElement("h2");
  heading.textContent = "Work overview";
  const filter = document.createElement("input");
  filter.type = "search";
  filter.placeholder = "Filter projects and tasks…";
  filter.setAttribute("aria-label", "Filter projects and tasks");
  const status = document.createElement("p");
  status.className = "overview-status";
  status.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "overview-projects";
  const empty = document.createElement("p");
  empty.className = "overview-empty";
  const newProject = document.createElement("button");
  newProject.type = "button";
  newProject.className = "overview-new-project";
  newProject.textContent = "Open a project";
  toolbar.append(heading, filter);
  const workspace = document.createElement("div");
  workspace.className = "overview-workspace";
  const content = document.createElement("div");
  content.className = "overview-work-list";
  content.append(toolbar, status, empty, newProject, list);
  const focusContent = document.createElement("section");
  focusContent.className = "focus-task";
  focusContent.hidden = true;
  focusContent.setAttribute("aria-label", "Focused work terminal");
  const back = document.createElement("button");
  back.type = "button";
  back.className = "focus-task-back";
  back.textContent = "Back to overview";
  const focusHeading = document.createElement("h2");
  focusHeading.textContent = "One task. Full context.";
  const focusContext = document.createElement("p");
  focusContext.className = "focus-task-context";
  const focusStatus = document.createElement("p");
  focusStatus.className = "focus-task-status";
  focusStatus.setAttribute("role", "status");
  const terminalSlot = document.createElement("div");
  terminalSlot.className = "focus-task-terminal";
  terminalSlot.setAttribute("aria-label", "Existing task terminal");
  focusContent.append(back, focusHeading, focusContext, focusStatus, terminalSlot);
  const inspectorElement = document.createElement("aside");
  inspectorElement.id = "project-work-inspector";
  const inspector = createWorkInspector({
    element: inspectorElement,
    getVerifyReport: bindings.getVerifyReport,
    getReviewFiles: bindings.getReviewFiles,
    getReviewDiff: bindings.getReviewDiff,
    onNavigate: bindings.onNavigate,
    onTerminalControl: bindings.onTerminalControl,
    onCandidateRecovery: bindings.onCandidateRecovery,
    onFocus: () => { void focusWork(); },
    onClose: () => { clearSelection(true); },
  });
  workspace.append(content, focusContent, inspectorElement);
  element.append(workspace);
  type CardRow = { element: HTMLElement; title: HTMLElement; state: HTMLElement; execution: HTMLElement; context: HTMLElement; evidence: HTMLElement; attention: HTMLElement; button: HTMLButtonElement };
  type Lane = { element: HTMLElement; name: HTMLElement; path: HTMLElement; counts: HTMLElement; list: HTMLElement; empty: HTMLElement; more: HTMLButtonElement; rows: Map<string, CardRow>; limit: number };
  const lanes = new Map<string, Lane>();
  let overview: WorkOverview | null = null;
  let nextDescription = 0;
  let disposed = false;
  let available = true;
  let selection: { projectId: string; key: string } | null = null;
  let selectedNavigationKey = "";
  let selectedWork: { project: Project; card: OverviewCard } | null = null;
  let focusSequence = 0;
  let focusTarget: ReviewTarget | null = null;
  let releaseTerminal: (() => void) | null = null;
  let focusOpener: HTMLElement | null = null;

  function targetOf(work: { project: Project; card: OverviewCard } | null): ReviewTarget | null {
    if (!work || "recovery" in work.card) return null;
    const area = work.card.terminal.workArea;
    return work && area ? {
      projectId: work.project.projectId, workspaceId: area.workspaceId, root: area.root,
      terminalId: work.card.terminal.terminalId, generation: work.card.terminal.generation,
    } : null;
  }

  function returnToOverview(restoreFocus = false): void {
    focusSequence++;
    releaseTerminal?.();
    releaseTerminal = null;
    focusTarget = null;
    content.hidden = false;
    focusContent.hidden = true;
    workspace.classList.remove("is-focused");
    inspector.setFocused(false);
    bindings.onFocusChange(false);
    if (restoreFocus) {
      if (focusOpener?.isConnected) focusOpener.focus();
      else inspector.focus();
    }
    focusOpener = null;
  }

  async function focusWork(): Promise<void> {
    const target = targetOf(selectedWork);
    if (disposed || !available || !target || focusTarget) return;
    const sequence = ++focusSequence;
    focusTarget = target;
    focusOpener = document.activeElement as HTMLElement | null;
    content.hidden = true;
    focusContent.hidden = false;
    workspace.classList.add("is-focused");
    inspector.setFocused(true);
    focusHeading.textContent = selectedWork?.card.task ? "One task. Full context." : "One context. Full terminal.";
    focusContext.textContent = `${target.terminalId} · ${target.root}`;
    focusStatus.textContent = "Opening the existing terminal…";
    bindings.onFocusChange(true);
    const isCurrent = (): boolean => !disposed && available && sequence === focusSequence && focusTarget === target;
    try {
      const release = await bindings.onFocusTerminal(target, terminalSlot, isCurrent);
      if (!isCurrent()) { release?.(); return; }
      if (!release) {
        returnToOverview(true);
        status.textContent = "This terminal changed or closed. Refresh work and select its current context.";
        return;
      }
      releaseTerminal = release;
      focusStatus.textContent = "Real terminal · the same running session. Background work continues.";
    } catch {
      if (!isCurrent()) return;
      returnToOverview(true);
      status.textContent = "Could not open the existing terminal. Refresh work and try again.";
    }
  }

  function clearSelection(restoreFocus = false): boolean {
    if (!selection) return false;
    returnToOverview();
    selectedWork = null;
    const button = lanes.get(selection.projectId)?.rows.get(selection.key)?.button;
    selection = null;
    selectedNavigationKey = "";
    bindings.onSelectionChange();
    inspector.clear();
    workspace.classList.remove("has-inspector");
    render();
    if (restoreFocus) (button?.isConnected ? button : filter).focus();
    return true;
  }

  function removeNode(node: HTMLElement): void {
    const focused = node.contains(document.activeElement);
    node.remove();
    if (focused) filter.focus();
  }

  function position(parent: HTMLElement, node: HTMLElement, index: number): void {
    const at = parent.children[index];
    if (at === node) return;
    const focused = node.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    parent.insertBefore(node, at ?? null);
    focused?.focus({ preventScroll: true });
  }

  function createLane(project: Project): Lane {
    const node = document.createElement("section");
    node.className = "overview-project";
    node.dataset.projectId = project.projectId;
    const header = document.createElement("header");
    header.className = "overview-project-heading";
    const identity = document.createElement("div");
    const name = document.createElement("h3");
    const path = document.createElement("p");
    path.className = "overview-project-path";
    path.id = `overview-project-path-${project.projectId}`;
    const counts = document.createElement("p");
    counts.className = "overview-project-counts";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "overview-open-project";
    open.textContent = "Open project";
    open.setAttribute("aria-describedby", path.id);
    identity.append(name, path, counts);
    header.append(identity, open);
    const cards = document.createElement("div");
    cards.className = "overview-task-grid";
    const empty = document.createElement("p");
    empty.className = "overview-empty";
    empty.textContent = "No live terminals or Plan Board tasks. Open the project to start work.";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "overview-more";
    more.setAttribute("aria-describedby", path.id);
    node.append(header, cards, empty, more);
    return { element: node, name, path, counts, list: cards, empty, more, rows: new Map(), limit: PAGE_SIZE };
  }

  function renderCards(lane: Lane, cards: OverviewCard[], projectId: string): void {
    const visible = cards.slice(0, lane.limit);
    const seen = new Set(visible.map((card) => card.key));
    for (const [key, row] of lane.rows) {
      if (seen.has(key)) continue;
      removeNode(row.element);
      lane.rows.delete(key);
    }
    visible.forEach((card, index) => {
      let row = lane.rows.get(card.key);
      if (!row) {
        const node = document.createElement("article");
        node.className = "overview-work-card";
        node.dataset.key = card.key;
        const state = document.createElement("p");
        state.className = "overview-work-state";
        const title = document.createElement("h4");
        title.id = `overview-work-title-${++nextDescription}`;
        const execution = document.createElement("p");
        const context = document.createElement("p");
        context.className = "overview-work-context";
        context.id = `overview-work-context-${nextDescription}`;
        const evidence = document.createElement("p");
        evidence.className = "overview-work-evidence";
        const attention = document.createElement("p");
        attention.className = "overview-work-attention";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "overview-inspect";
        button.setAttribute("aria-controls", inspectorElement.id);
        button.setAttribute("aria-describedby", `${title.id} ${context.id}`);
        node.append(state, title, execution, context, evidence, attention, button);
        row = { element: node, title, state, execution, context, evidence, attention, button };
        lane.rows.set(card.key, row);
      }
      row.title.textContent = card.title;
      row.state.textContent = card.state;
      row.execution.textContent = card.execution;
      row.context.textContent = card.context;
      row.evidence.textContent = card.evidence;
      row.attention.textContent = card.attention;
      row.attention.hidden = !card.attention;
      row.element.classList.toggle("has-attention", !!card.attention);
      const selected = selection?.projectId === projectId && selection.key === card.key;
      row.element.classList.toggle("is-selected", selected);
      row.button.setAttribute("aria-expanded", String(selected));
      row.button.textContent = "recovery" in card ? "Recovery details" : card.task ? "Task details" : "Context details";
      position(lane.list, row.element, index);
    });
    lane.empty.hidden = cards.length > 0;
    lane.more.hidden = cards.length <= lane.limit;
    lane.more.textContent = `Show more work (${Math.max(0, cards.length - lane.limit)} remaining)`;
  }

  function render(): void {
    if (!overview || disposed) return;
    const query = filter.value.trim().toLocaleLowerCase();
    const all = overview.projects.map((project) => ({ project, cards: projectCards(project) }));
    if (selection) {
      const selectedProject = all.find(({ project }) => project.projectId === selection!.projectId);
      const selectedCard = selectedProject?.cards.find((card) => card.key === selection!.key);
      selectedWork = available && selectedProject && selectedCard ? { project: selectedProject.project, card: selectedCard } : null;
      if (focusTarget && JSON.stringify(focusTarget) !== JSON.stringify(targetOf(selectedWork))) returnToOverview();
      const navigationKey = JSON.stringify([selection, available && selectedProject && selectedCard
        ? [selectedProject.project.root, "recovery" in selectedCard ? selectedCard.recovery : [selectedCard.owner.generation, selectedCard.owner.workArea,
          selectedCard.terminal.terminalId, selectedCard.terminal.generation, selectedCard.terminal.workArea, selectedCard.action]] : null]);
      if (navigationKey !== selectedNavigationKey) {
        selectedNavigationKey = navigationKey;
        bindings.onSelectionChange();
      }
      if (selectedProject && selectedCard) {
        inspector.render(selectedProject.project, selectedCard);
        if (!available) inspector.unavailable("Work overview unavailable. Refresh to load the current context.");
      } else inspector.unavailable("This work changed or closed. Select its current card to continue.");
    }
    workspace.classList.toggle("has-inspector", !!selection);
    const projects = all.flatMap(({ project, cards }) => {
      const projectMatch = `${project.name}\n${project.root}`.toLocaleLowerCase().includes(query);
      const matching = projectMatch ? cards : cards.filter((card) =>
        `${card.title}\n${card.context}`.toLocaleLowerCase().includes(query));
      return projectMatch || matching.length ? [{ project, cards: matching }] : [];
    });
    const seen = new Set(projects.map(({ project }) => project.projectId));
    for (const [id, lane] of lanes) {
      if (seen.has(id)) continue;
      removeNode(lane.element);
      lanes.delete(id);
    }
    projects.forEach(({ project, cards }, index) => {
      let lane = lanes.get(project.projectId);
      if (!lane) { lane = createLane(project); lanes.set(project.projectId, lane); }
      const tasks = project.terminals.reduce((sum, terminal) => sum + terminal.tasks.length, 0);
      lane.name.textContent = project.name;
      lane.path.textContent = project.root;
      lane.counts.textContent = `${tasks} Plan Board task${tasks === 1 ? "" : "s"} · ${project.working} working · ${project.attentionCount} attention`
        + (project.candidateRecoveries.length ? ` · ${project.candidateRecoveries.length} candidate startup issue${project.candidateRecoveries.length === 1 ? "" : "s"}` : "");
      renderCards(lane, cards, project.projectId);
      position(list, lane.element, index);
    });
    const tasks = overview.projects.reduce((sum, project) => sum + project.terminals.reduce((n, terminal) => n + terminal.tasks.length, 0), 0);
    status.textContent = `${overview.projects.length} project${overview.projects.length === 1 ? "" : "s"} · ${tasks} Plan Board task${tasks === 1 ? "" : "s"}`
      + (query ? ` · ${projects.length} matching project${projects.length === 1 ? "" : "s"}` : "")
      + " · Marked task state, agent activity and check evidence are separate facts.";
    empty.hidden = projects.length > 0;
    empty.textContent = overview.projects.length ? "No projects or tasks match. Clear the filter to see all work." : "Open a project to see its work. Agents keep running when you switch views.";
    newProject.hidden = overview.projects.length > 0;
  }

  const onInput = (): void => { for (const lane of lanes.values()) lane.limit = PAGE_SIZE; render(); };
  const onClick = (event: MouseEvent): void => {
    if (disposed) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".overview-new-project")) { bindings.onNewProject(); return; }
    const projectId = target?.closest<HTMLElement>(".overview-project")?.dataset.projectId;
    const lane = projectId ? lanes.get(projectId) : undefined;
    if (!projectId || !lane) return;
    if (target?.closest(".overview-open-project")) bindings.onNavigate(projectId, null);
    else if (target?.closest(".overview-more")) {
      const before = lane.list.children.length;
      lane.limit += PAGE_SIZE;
      render();
      lane.list.children[before]?.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (target?.closest(".overview-work-card")) {
      const key = target.closest<HTMLElement>(".overview-work-card")?.dataset.key;
      if (key && lane.rows.has(key)) {
        if (focusTarget) returnToOverview();
        selection = { projectId, key };
        selectedNavigationKey = "";
        render();
        inspector.focus();
      }
    }
  };
  const onBack = (): void => returnToOverview(true);
  const onKey = (event: KeyboardEvent): void => {
    // Escape belongs to the real TUI while typing in it.
    if (event.key !== "Escape" || event.defaultPrevented || terminalSlot.contains(event.target as Node)) return;
    if (focusTarget) returnToOverview(true);
    else if (!clearSelection(true)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  back.addEventListener("click", onBack);
  filter.addEventListener("input", onInput);
  element.addEventListener("click", onClick);
  element.addEventListener("keydown", onKey);
  return {
    render: (value) => { if (!disposed) { overview = value; available = true; render(); } },
    clearSelection,
    selectTask: (target) => {
      if (disposed || !available || !overview || !findOverviewTask(overview, target)) return false;
      returnToOverview();
      // An explicit global jump reveals its card even if a local filter hid it.
      filter.value = "";
      selection = { projectId: target.projectId, key: target.key };
      selectedNavigationKey = "";
      render();
      const project = overview.projects.find((entry) => entry.projectId === target.projectId)!;
      const index = projectCards(project).findIndex((card) => card.key === target.key);
      const lane = lanes.get(target.projectId)!;
      lane.limit = Math.max(lane.limit, index + 1);
      render();
      lane.rows.get(target.key)?.element.scrollIntoView({ block: "nearest" });
      inspector.focus();
      return true;
    },
    leaveFocus: () => returnToOverview(false),
    setUnavailable: () => { if (!disposed) { available = false; render(); } },
    invalidateEvidence: inspector.invalidateEvidence,
    invalidateChanges: inspector.invalidateChanges,
    invalidateChangesForInstances: (instances) => {
      if (focusTarget && !instances.some((instance) => instance.id === focusTarget!.terminalId
        && instance.generation === focusTarget!.generation && instance.projectId === focusTarget!.projectId
        && instance.workspaceId === focusTarget!.workspaceId && instance.cwd === focusTarget!.root)) returnToOverview();
      inspector.invalidateChangesForInstances(instances);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      returnToOverview();
      back.removeEventListener("click", onBack);
      filter.removeEventListener("input", onInput);
      element.removeEventListener("click", onClick);
      element.removeEventListener("keydown", onKey);
      inspector.dispose();
      lanes.clear(); overview = null; selection = null;
    },
  };
}
