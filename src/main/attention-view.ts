import type { AgentActivityView, TerminaBridge, WorkAttentionInspectResult, WorkAttentionItem, WorkOverview, WorkSummaryAction } from "../../shared/types";
import { presentBlockedLabel } from "../known-state";
import { ACTION_LABELS, ATTENTION_LABELS } from "./work-labels";
import { findWorkTask } from "./work-search";
import type { WorkSearchTarget } from "./work-search";

const PAGE_SIZE = 50;
const RETRY_DELAY_MS = 5000;

/** Global read-only projection. Visiting a reason does not acknowledge or resolve it. */
export function createAttentionView(bindings: {
  element: HTMLElement;
  heading: HTMLElement;
  bridge: TerminaBridge;
  onOverview(overview: WorkOverview | null): void;
  onInspect(result: Extract<WorkAttentionInspectResult, { ok: true }>, isCurrent: () => boolean): Promise<boolean>;
  onNavigate(projectId: string, action: WorkSummaryAction | null, isCurrent: () => boolean): Promise<boolean>;
  onReveal(projectId: string, action: WorkSummaryAction | null): void;
}): {
  focus(): void;
  revealWork(target: WorkSearchTarget, isCurrent: () => boolean): Promise<boolean>;
  cancelNavigation(): void;
  dispose(): void;
} {
  const { element, heading, bridge } = bindings;
  const list = element.querySelector<HTMLElement>("#attention-list")!;
  const status = element.querySelector<HTMLElement>("#attention-status")!;
  const message = element.querySelector<HTMLElement>("#attention-message")!;
  const moreButton = element.querySelector<HTMLButtonElement>("#btn-more-attention")!;
  const count = heading.querySelector<HTMLElement>(".attention-count")!;
  const rows = new Map<string, { element: HTMLLIElement; title: HTMLElement; context: HTMLElement; area: HTMLElement; detail: HTMLElement; button: HTMLButtonElement; item: WorkAttentionItem }>();
  const activity = new Map<string, AgentActivityView>();
  const models = new Map<string, string | null>();
  let overview: WorkOverview | null = null;
  let unavailable = false;
  let limit = PAGE_SIZE;
  let loadSequence = 0;
  let inspectSequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function cancelRetry(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function cancelNavigation(): void {
    inspectSequence++;
    message.textContent = "";
  }

  async function inspect(id: string): Promise<void> {
    const sequence = ++inspectSequence;
    const isCurrent = (): boolean => !disposed && sequence === inspectSequence;
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
        cancelNavigation();
        bindings.onReveal(result.folder.projectId, result.action);
      } else {
        message.textContent = "The target changed or closed. Choose its current owner.";
        refresh();
      }
    } catch {
      if (isCurrent()) {
        message.textContent = "Could not open this item. Try again.";
        refresh();
      }
    }
  }

  function render(): void {
    if (!overview) return;
    const projects = new Map(overview.projects.map((project) => [project.projectId, project]));
    const visible = overview.items.slice(0, limit);
    const seen = new Set(visible.map((item) => item.id));
    // Prune before insertion so unchanged controls are not moved unnecessarily.
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      const focused = row.element.contains(document.activeElement);
      row.element.remove();
      rows.delete(id);
      if (focused) heading.focus();
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
      row.area.textContent = item.candidate
        ? `Separate candidate result · ${item.candidate.root} · version ${item.candidate.version}`
        : item.workArea ? `${item.workArea.kind === "project" ? "Shared project files" : "Separate candidate tree"} · ${item.workArea.root}` : "Assigned work area unavailable";
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
    status.textContent = unavailable ? "Attention unavailable. Previous rows may be outdated. Retrying automatically…"
      : overview.items.length ? `${overview.items.length} recorded attention item${overview.items.length === 1 ? "" : "s"} across all projects.`
      : "No recorded attention.";
  }

  function receiveOverview(value: WorkOverview): void {
    cancelRetry();
    overview = value;
    unavailable = false;
    count.textContent = String(value.items.length);
    heading.setAttribute("aria-label", `Attention across all projects: ${value.items.length} recorded items`);
    bindings.onOverview(value);
    render();
  }

  function overviewUnavailable(): void {
    unavailable = true;
    count.textContent = "?";
    heading.setAttribute("aria-label", "Attention across all projects: unavailable");
    bindings.onOverview(null);
    status.textContent = "Attention unavailable. Previous rows may be outdated. Retrying automatically…";
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
      cancelNavigation();
      bindings.onReveal(target.projectId, null);
      return true;
    }
    const selected = findWorkTask(value, target.task);
    if (!selected) return false;
    const action: WorkSummaryAction = { kind: "plan", terminalId: selected.owner.terminalId,
      generation: selected.owner.generation, taskText: selected.task.task.text };
    const activated = await bindings.onNavigate(target.task.projectId, action, isCurrent);
    if (!activated || !isCurrent()) return false;
    // Activation is asynchronous: do not select an owner/source replaced during it.
    const activatedRevision = loadSequence;
    const current = await bridge.getWorkOverview();
    if (!isCurrent() || activatedRevision !== loadSequence || !findWorkTask(current, target.task)) return false;
    loadSequence++;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    receiveOverview(current);
    cancelNavigation();
    bindings.onReveal(target.task.projectId, action);
    return true;
  }

  async function load(): Promise<void> {
    timer = undefined;
    const sequence = ++loadSequence;
    try {
      const value = await bridge.getWorkOverview();
      if (disposed || sequence !== loadSequence) return;
      receiveOverview(value);
    } catch {
      if (disposed || sequence !== loadSequence) return;
      overviewUnavailable();
      // Successful views update from events; only unavailable facts retry.
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        refresh();
      }, RETRY_DELAY_MS);
    }
  }

  function refresh(): void {
    if (disposed) return;
    cancelRetry();
    loadSequence++;
    if (timer === undefined) timer = setTimeout(() => { void load(); }, 150);
  }

  function focus(): void {
    if (disposed) return;
    cancelNavigation();
    (list.querySelector<HTMLButtonElement>(".attention-inspect") ?? heading).focus();
  }
  const onMore = (): void => {
    const nextId = overview?.items[limit]?.id;
    limit += PAGE_SIZE;
    render();
    // The last page hides Show more; continue at the first newly revealed action.
    (nextId ? rows.get(nextId)?.button ?? heading : heading).focus();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    cancelNavigation();
  };
  moreButton.addEventListener("click", onMore);
  element.addEventListener("keydown", onKey);
  const unsubs = [
    bridge.onInstances((roster) => {
      activity.clear(); models.clear();
      for (const terminal of roster) {
        if (terminal.activity) activity.set(terminal.id, terminal.activity);
        models.set(terminal.id, terminal.model ?? null);
      }
      refresh();
    }),
    bridge.onPlanUpdate(refresh),
    bridge.onModifiedList(refresh),
    bridge.onFileChanged(refresh),
    bridge.onFileDeleted(refresh),
    bridge.onVerifyState(refresh),
    bridge.onTimelineClear(refresh),
    bridge.onFolderOpened(refresh),
    bridge.onProjectClosed(refresh),
    bridge.onWorldlineUpdate(refresh),
    bridge.onWorldlineRemoved(refresh),
    bridge.onWorldlineRunsChanged(refresh),
    bridge.onEvidenceUpdate(refresh),
    bridge.onPromotionOpened(refresh),
    bridge.onAgentStatus(({ terminalId, model }) => {
      if (models.has(terminalId) && models.get(terminalId) === model) return;
      models.set(terminalId, model);
      refresh();
    }),
    bridge.onTimelinePrefix(({ terminalId, activity: next }) => {
      if (!next) return;
      const previous = activity.get(terminalId);
      if (previous?.state === next.state && previous.reason === next.reason
        && previous.intervention?.requestId === next.intervention?.requestId
        && previous.intervention?.since === next.intervention?.since) return;
      activity.set(terminalId, next);
      refresh();
    }),
  ];
  void load();
  return {
    focus,
    revealWork,
    cancelNavigation,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      inspectSequence++; loadSequence++;
      if (timer !== undefined) clearTimeout(timer);
      cancelRetry();
      moreButton.removeEventListener("click", onMore);
      element.removeEventListener("keydown", onKey);
      for (const unsub of unsubs) unsub();
      rows.clear(); activity.clear(); models.clear();
    },
  };
}
