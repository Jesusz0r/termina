import type { AgentActivityView, CandidateRecoverySummary, TerminaBridge, WorkAttentionInspectResult, WorkAttentionItem, WorkOverview, WorkSummaryAction } from "../../shared/types";
import { presentBlockedLabel } from "../known-state";
import { ACTION_LABELS, ATTENTION_LABELS } from "./work-summary";
import { createProjectOverview, findOverviewTask } from "./project-overview";
import type { WorkSearchTarget } from "./work-search";

const PAGE_SIZE = 50;

/** Global read-only projection. Visiting a reason does not acknowledge or resolve it. */
export function createAttentionView(bindings: {
  element: HTMLElement;
  toggle: HTMLButtonElement;
  overviewToggle: HTMLButtonElement;
  workspace: readonly HTMLElement[];
  bridge: TerminaBridge;
  onOverview(overview: WorkOverview | null): void;
  onViewChange(overviewOpen: boolean): void;
  onInspect(result: Extract<WorkAttentionInspectResult, { ok: true }>, isCurrent: () => boolean): Promise<boolean>;
  onNavigate(projectId: string, action: WorkSummaryAction | null, isCurrent: () => boolean): Promise<boolean>;
  onReveal(projectId: string, action: WorkSummaryAction | null): void;
  onNewProject(): void;
  onFocusTerminal: Parameters<typeof createProjectOverview>[0]["onFocusTerminal"];
  onTerminalControl: Parameters<typeof createProjectOverview>[0]["onTerminalControl"];
  onCandidateRecovery(projectId: string, recovery: CandidateRecoverySummary, isCurrent: () => boolean): Promise<boolean>;
  onRevealCandidate(recovery: CandidateRecoverySummary): void;
}): {
  open(opener?: HTMLElement, mode?: "attention" | "overview"): void;
  revealWork(target: WorkSearchTarget, isCurrent: () => boolean): Promise<boolean>;
  close(restoreFocus?: boolean): void;
  dispose(): void;
} {
  const { element, toggle, overviewToggle, bridge } = bindings;
  const title = element.querySelector<HTMLElement>("#work-view-title")!;
  const projectContent = element.querySelector<HTMLElement>("#project-overview")!;
  const attentionHeading = element.querySelector<HTMLElement>("#overview-attention-heading")!;
  const workspaceInert = new Map<HTMLElement, boolean>();
  const projectOverview = createProjectOverview({
    element: projectContent,
    onNavigate: (projectId, action) => { void inspectProject(projectId, action); },
    getVerifyReport: (id, generation) => bridge.getVerifyReport(id, generation),
    getReviewFiles: (target, offset) => bridge.getReviewFiles(target, offset),
    getReviewDiff: (target, path) => bridge.getReviewDiff(target, path),
    onSelectionChange: () => { inspectSequence++; },
    onFocusTerminal: bindings.onFocusTerminal,
    onTerminalControl: bindings.onTerminalControl,
    onCandidateRecovery: (projectId, recovery) => { void navigateCandidate(projectId, recovery); },
    onFocusChange: (focused) => {
      element.classList.toggle("task-focus", focused);
      title.textContent = focused ? "Focused work" : mode === "overview" ? "All projects" : "Attention across all projects";
    },
    onNewProject: bindings.onNewProject,
  });
  const list = element.querySelector<HTMLElement>("#attention-list")!;
  const status = element.querySelector<HTMLElement>("#attention-status")!;
  const message = element.querySelector<HTMLElement>("#attention-message")!;
  const closeButton = element.querySelector<HTMLButtonElement>("#btn-close-attention")!;
  const refreshButton = element.querySelector<HTMLButtonElement>("#btn-refresh-attention")!;
  const moreButton = element.querySelector<HTMLButtonElement>("#btn-more-attention")!;
  const count = toggle.querySelector<HTMLElement>(".attention-count")!;
  const rows = new Map<string, { element: HTMLLIElement; title: HTMLElement; context: HTMLElement; area: HTMLElement; detail: HTMLElement; button: HTMLButtonElement; item: WorkAttentionItem }>();
  const activity = new Map<string, AgentActivityView>();
  const models = new Map<string, string | null>();
  let overview: WorkOverview | null = null;
  let unavailable = false;
  let opener: HTMLElement = toggle;
  let limit = PAGE_SIZE;
  let loadSequence = 0;
  let inspectSequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let mode: "attention" | "overview" = "attention";

  function restoreWorkspace(): void {
    for (const [node, inert] of workspaceInert) node.inert = inert;
    workspaceInert.clear();
  }

  function close(restoreFocus = true, preserveSelection = false): void {
    inspectSequence++;
    if (preserveSelection) projectOverview.leaveFocus();
    else projectOverview.clearSelection();
    element.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    overviewToggle.setAttribute("aria-expanded", "false");
    restoreWorkspace();
    bindings.onViewChange(false);
    if (restoreFocus) (opener.isConnected ? opener : toggle).focus();
  }

  async function navigateCandidate(projectId: string, recovery: CandidateRecoverySummary): Promise<void> {
    if (disposed || element.hidden) return;
    const sequence = ++inspectSequence;
    const isCurrent = (): boolean => !disposed && !element.hidden && sequence === inspectSequence;
    try {
      const navigated = await bindings.onCandidateRecovery(projectId, recovery, isCurrent);
      if (!isCurrent()) return;
      if (!navigated) { message.textContent = "Candidate recovery unavailable or changed. Refresh to inspect current work."; refresh(); return; }
      close(false, true);
      bindings.onRevealCandidate(recovery);
    } catch {
      if (isCurrent()) { message.textContent = "Candidate recovery unavailable. Refresh and try again."; refresh(); }
    }
  }

  async function inspectProject(projectId: string, action: WorkSummaryAction | null): Promise<void> {
    const sequence = ++inspectSequence;
    const isCurrent = (): boolean => !disposed && !element.hidden && sequence === inspectSequence;
    message.textContent = "Opening project context…";
    try {
      const opened = await bindings.onNavigate(projectId, action, isCurrent);
      if (!isCurrent()) return;
      if (opened) {
        close(false, !!action?.taskText || action?.kind === "verify");
        bindings.onReveal(projectId, action);
      } else {
        message.textContent = "The target changed or closed. Refresh work and choose its current owner.";
        refresh();
      }
    } catch {
      if (isCurrent()) {
        message.textContent = "Could not open this work. Refresh and try again.";
        refresh();
      }
    }
  }

  async function inspect(id: string): Promise<void> {
    const sequence = ++inspectSequence;
    const isCurrent = (): boolean => !disposed && !element.hidden && sequence === inspectSequence;
    message.textContent = "Opening the current owner…";
    try {
      const result = await bridge.inspectWorkAttention(id);
      if (!isCurrent()) return;
      if (!result.ok) {
        message.textContent = result.error;
        refresh();
        return;
      }
      const opened = await bindings.onInspect(result, isCurrent);
      if (!isCurrent()) return;
      if (opened) {
        close(false);
        bindings.onReveal(result.folder.projectId, result.action);
      } else message.textContent = "The target changed or closed. Refresh attention and choose its current owner.";
    } catch {
      if (isCurrent()) {
        message.textContent = "Could not open this item. Refresh attention and try again.";
        refresh();
      }
    }
  }

  function render(): void {
    if (!overview) return;
    if (mode === "overview") projectOverview.render(overview);
    attentionHeading.textContent = `Needs your attention · ${overview.items.length}`;
    const projects = new Map(overview.projects.map((project) => [project.projectId, project]));
    const visible = overview.items.slice(0, limit);
    const seen = new Set(visible.map((item) => item.id));
    // Prune before insertion so unchanged controls are not moved unnecessarily.
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      const focused = row.element.contains(document.activeElement);
      row.element.remove();
      rows.delete(id);
      if (focused && !element.hidden) refreshButton.focus();
    }
    visible.forEach((item, index) => {
      let row = rows.get(item.id);
      if (!row) {
        const node = document.createElement("li");
        node.className = "attention-item";
        node.dataset.id = item.id;
        node.dataset.projectId = item.projectId;
        const title = document.createElement("h3");
        const context = document.createElement("p");
        context.className = "attention-context";
        const area = document.createElement("p");
        area.className = "attention-area";
        const detail = document.createElement("p");
        detail.className = "attention-detail";
        context.id = `attention-context-${item.id}`;
        area.id = `attention-area-${item.id}`;
        detail.id = `attention-detail-${item.id}`;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "attention-inspect";
        button.setAttribute("aria-describedby", `${context.id} ${area.id} ${detail.id}`);
        const entry = { element: node, title, context, area, detail, button, item };
        button.addEventListener("click", () => { void inspect(entry.item.id); });
        node.append(title, context, area, detail, button);
        row = entry;
        rows.set(item.id, row);
      }
      row.item = item;
      const project = projects.get(item.projectId);
      row.title.textContent = ATTENTION_LABELS[item.reason];
      row.context.textContent = `${project?.name ?? "Project unavailable"} · ${project?.root ?? "path unavailable"}\n`
        + `${item.taskText ?? "No single task assignment recorded"} · ${item.terminalId} · ${item.model ?? "model unknown"}`;
      row.area.textContent = item.workArea
        ? `${item.workArea.kind === "project" ? "Shared project files" : "Separate candidate tree"} · ${item.workArea.root}` : "Assigned work area unavailable";
      row.detail.textContent = item.reason === "blocked" ? presentBlockedLabel(item.detail) : item.detail ?? "";
      row.detail.hidden = !row.detail.textContent;
      row.button.textContent = ACTION_LABELS[item.action.kind];
      const position = list.children[index];
      if (position !== row.element) {
        const focused = row.element.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
        list.insertBefore(row.element, position ?? null);
        focused?.focus({ preventScroll: true });
      }
    });
    moreButton.hidden = overview.items.length <= limit;
    moreButton.textContent = `Show more (${Math.max(0, overview.items.length - limit)} remaining)`;
    status.textContent = unavailable ? "Attention unavailable. Previous rows may be outdated. Refresh to load current facts."
      : overview.items.length ? `${overview.items.length} recorded attention item${overview.items.length === 1 ? "" : "s"} across all projects.`
      : "No recorded attention. Idle is not proof of task completion or review.";
  }

  function receiveOverview(value: WorkOverview): void {
    overview = value;
    unavailable = false;
    count.textContent = String(value.items.length);
    toggle.setAttribute("aria-label", `Attention across all projects: ${value.items.length} recorded items`);
    bindings.onOverview(value);
  }

  async function revealWork(target: WorkSearchTarget, externalCurrent: () => boolean): Promise<boolean> {
    if (disposed || !externalCurrent()) return false;
    const sequence = ++inspectSequence;
    const isCurrent = (): boolean => !disposed && sequence === inspectSequence && externalCurrent();
    // Revalidate against current owners, not the palette's earlier result rows.
    const revision = loadSequence;
    const value = await bridge.getWorkOverview();
    if (!isCurrent() || revision !== loadSequence) return false;
    if (target.kind === "project") {
      if (!value.projects.some((project) => project.projectId === target.projectId && project.root === target.root)) return false;
      const opened = await bindings.onNavigate(target.projectId, null, isCurrent);
      if (!opened || !isCurrent()) return false;
      close(false);
      bindings.onReveal(target.projectId, null);
      return true;
    }
    if (!findOverviewTask(value, target.task)) return false;
    const activated = await bindings.onNavigate(target.task.projectId, null, isCurrent);
    if (!activated || !isCurrent()) return false;
    // Activation is asynchronous: do not select an owner/source replaced during it.
    const activatedRevision = loadSequence;
    const current = await bridge.getWorkOverview();
    if (!isCurrent() || activatedRevision !== loadSequence || !findOverviewTask(current, target.task)) return false;
    loadSequence++;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    receiveOverview(current);
    open(overviewToggle, "overview");
    return projectOverview.selectTask(target.task);
  }

  async function load(): Promise<void> {
    timer = undefined;
    const sequence = ++loadSequence;
    try {
      const value = await bridge.getWorkOverview();
      if (disposed || sequence !== loadSequence) return;
      receiveOverview(value);
      if (!element.hidden) render();
    } catch {
      if (disposed || sequence !== loadSequence) return;
      unavailable = true;
      projectOverview.setUnavailable();
      count.textContent = "?";
      toggle.setAttribute("aria-label", "Attention across all projects: unavailable");
      bindings.onOverview(null);
      status.textContent = "Attention unavailable. Previous rows may be outdated. Refresh to load current facts.";
    }
  }

  function refresh(): void {
    if (disposed) return;
    loadSequence++;
    if (timer === undefined) timer = setTimeout(() => { void load(); }, 150);
  }

  function open(source: HTMLElement = toggle, nextMode: "attention" | "overview" = "attention"): void {
    if (disposed) return;
    inspectSequence++;
    if (mode !== nextMode) projectOverview.clearSelection();
    else projectOverview.leaveFocus();
    restoreWorkspace();
    mode = nextMode;
    opener = source;
    element.hidden = false;
    element.classList.toggle("work-overview", mode === "overview");
    element.setAttribute("aria-label", mode === "overview" ? "All projects" : "Attention across all projects");
    title.textContent = mode === "overview" ? "All projects" : "Attention across all projects";
    closeButton.setAttribute("aria-label", mode === "overview" ? "Return to workspace" : "Close attention");
    projectContent.hidden = mode !== "overview";
    attentionHeading.hidden = mode !== "overview";
    toggle.setAttribute("aria-expanded", String(mode === "attention"));
    overviewToggle.setAttribute("aria-expanded", String(mode === "overview"));
    if (mode === "overview") {
      for (const node of bindings.workspace) { workspaceInert.set(node, node.inert); node.inert = true; }
    }
    bindings.onViewChange(mode === "overview");
    if (overview) render();
    else status.textContent = unavailable ? "Attention unavailable. Refresh to load current facts." : "Loading attention across all projects…";
    closeButton.focus();
    refresh();
  }

  const onToggle = (): void => { if (element.hidden || mode !== "attention") open(); else close(); };
  const onClose = (): void => close();
  const onRefresh = (): void => { message.textContent = ""; refresh(); };
  const onMore = (): void => {
    const nextId = overview?.items[limit]?.id;
    limit += PAGE_SIZE;
    render();
    // The last page hides Show more; continue at the first newly revealed action.
    (nextId ? rows.get(nextId)?.button ?? refreshButton : refreshButton).focus();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented || (event.target as HTMLElement)?.closest(".focus-task-terminal")) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  toggle.addEventListener("click", onToggle);
  closeButton.addEventListener("click", onClose);
  refreshButton.addEventListener("click", onRefresh);
  moreButton.addEventListener("click", onMore);
  element.addEventListener("keydown", onKey);
  const unsubs = [
    bridge.onInstances((roster) => {
      projectOverview.invalidateEvidence();
      projectOverview.invalidateChangesForInstances(roster);
      activity.clear(); models.clear();
      for (const terminal of roster) {
        if (terminal.activity) activity.set(terminal.id, terminal.activity);
        models.set(terminal.id, terminal.model ?? null);
      }
      refresh();
    }),
    bridge.onPlanUpdate(({ instanceId }) => { projectOverview.invalidateEvidence(instanceId); projectOverview.invalidateChanges(instanceId); refresh(); }),
    bridge.onModifiedList(({ instanceId }) => { projectOverview.invalidateEvidence(instanceId); projectOverview.invalidateChanges(instanceId); refresh(); }),
    bridge.onFileChanged((owner) => { projectOverview.invalidateChanges(undefined, owner); }),
    bridge.onFileDeleted((owner) => { projectOverview.invalidateChanges(undefined, owner); }),
    bridge.onVerifyState(({ terminalId }) => { projectOverview.invalidateEvidence(terminalId); refresh(); }),
    bridge.onTimelineClear(({ terminalId }) => { projectOverview.invalidateEvidence(terminalId); projectOverview.invalidateChanges(terminalId); refresh(); }),
    bridge.onFolderOpened(refresh),
    bridge.onProjectClosed(() => { projectOverview.invalidateEvidence(); projectOverview.invalidateChanges(); refresh(); }),
    bridge.onAgentStatus(({ terminalId, model }) => {
      if (models.has(terminalId) && models.get(terminalId) === model) return;
      models.set(terminalId, model);
      refresh();
    }),
    bridge.onTimelinePrefix(({ terminalId, activity: next }) => {
      if (!next) return;
      const previous = activity.get(terminalId);
      if (previous?.state === next.state && previous.reason === next.reason) return;
      activity.set(terminalId, next);
      refresh();
    }),
  ];
  void load();
  return {
    open,
    revealWork,
    close,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      inspectSequence++; loadSequence++;
      if (timer !== undefined) clearTimeout(timer);
      restoreWorkspace();
      projectOverview.dispose();
      toggle.removeEventListener("click", onToggle);
      closeButton.removeEventListener("click", onClose);
      refreshButton.removeEventListener("click", onRefresh);
      moreButton.removeEventListener("click", onMore);
      element.removeEventListener("keydown", onKey);
      for (const unsub of unsubs) unsub();
      rows.clear(); activity.clear(); models.clear();
    },
  };
}
