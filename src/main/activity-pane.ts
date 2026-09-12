/**
 * Activity pane: plan board and modified-files panels with their IPC.
 * Owns plan/modified rendering, review marks, dispatch/clear/accept bindings,
 * and plan/modified pushes. Main wires pane callbacks and explorer, review,
 * handoff, and tab-badge effects; all activity state lives here.
 */
import { toast } from "../components/modals";
import type { ModifiedFile, PlanTask } from "../../shared/types";

export interface ActivityPaneState {
  instanceId: string;
  projectId: string | null;
  workspaceId: string;
  modified: ModifiedFile[];
  accepted: Map<string, number>;
  reverted: Set<string>;
  plan: PlanTask[];
  planLoaded: boolean;
  planLoadAttempts: number;
  planVersion: number;
}

export interface ActivityPaneElements {
  planPanel: HTMLElement;
  planList: HTMLElement;
  planCount: HTMLElement;
  btnDispatch: HTMLButtonElement;
  modifiedList: HTMLElement;
  modifiedPanel: HTMLElement;
  modifiedCount: HTMLElement;
  btnClearModified: HTMLButtonElement;
  btnAcceptAll: HTMLButtonElement;
}

export interface ActivityPaneBindings<TPane extends ActivityPaneState> {
  elements: ActivityPaneElements;
  getActivePane(): TPane | undefined;
  getActivePaneId(): string | null;
  getPaneById(id: string): TPane | undefined;
  getAllPanes(): Iterable<TPane>;
  onPlanContent(has: boolean, count: number, announce: boolean): void;
  onModifiedContent(has: boolean, count: number, announce: boolean): void;
  onReviewChanged(pane: TPane): void;
  onModifiedListChanged(pane: TPane): void;
  onShowWorker(workerId: string): void;
  openReview(pane: TPane, path: string, relPath: string): void;
}

export function createActivityPane<TPane extends ActivityPaneState>(
  bindings: ActivityPaneBindings<TPane>,
): {
  renderPlan(pane: TPane, announce?: boolean): void;
  renderModified(pane: TPane, announce?: boolean): void;
  pruneReviewMarks(pane: TPane): void;
  dropStaleAcceptMarks(path: string): void;
  clear(): void;
  dispose(): void;
} {
  const { elements } = bindings;
  let modifiedRenderedPaneId: string | null = null;

  /** Plan Board: the current run's tasks with live progress. */
  function renderPlan(pane: TPane, announce = true): void {
    if (!pane.planLoaded) {
      pane.planLoaded = true;
      const versionAtStart = pane.planVersion;
      void window.termina.getPlan(pane.instanceId).then((tasks) => {
        const p = bindings.getPaneById(pane.instanceId);
        if (!p) return;
        if (p.planVersion !== versionAtStart) return; // a push won the race
        p.plan = tasks;
        p.planLoadAttempts = 0;
        if (bindings.getActivePaneId() === pane.instanceId) renderPlan(p, announce);
      }).catch((err) => {
        const p = bindings.getPaneById(pane.instanceId);
        if (!p || p.planVersion !== versionAtStart) return;
        p.planLoaded = false;
        p.planLoadAttempts++;
        if (p.planLoadAttempts < 3) {
          const delay = 250 * (2 ** (p.planLoadAttempts - 1));
          setTimeout(() => {
            const current = bindings.getPaneById(p.instanceId);
            if (current === p && current.planVersion === versionAtStart && bindings.getActivePaneId() === current.instanceId) {
              renderPlan(current, announce);
            }
          }, delay);
          return;
        }
        toast(`could not load plan: ${(err as Error).message}`, "error");
      });
    }
    elements.planCount.textContent = pane.plan.length ? `(${pane.plan.length})` : "";
    elements.planList.replaceChildren();
    for (const task of pane.plan) {
      const li = document.createElement("li");
      li.className = `plan-task state-${task.state}`;
      const mark = document.createElement("span");
      mark.className = "plan-mark";
      mark.textContent = task.state === "done" ? "✓" : task.state === "active" ? "◐" : "○";
      const text = document.createElement("span");
      text.className = "plan-text";
      text.textContent = task.text;
      li.append(mark, text);
      if (task.workerId || (task.claimed && task.claimed.length > 0)) {
        const meta = document.createElement("span");
        meta.className = "plan-meta";
        const claim = (task.claimed ?? task.paths).join(", ");
        const status = task.state === "done" ? "settled" : task.workerId ?? "dispatch";
        meta.textContent = claim ? `${status} · ${claim}` : status;
        li.appendChild(meta);
      }
      if (task.state !== "done") {
        li.classList.add("dispatchable");
        li.title = task.workerId ? "show dispatch worker" : "dispatch this task";
        li.addEventListener("click", (e) => {
          e.stopPropagation();
          if (task.workerId) {
            bindings.onShowWorker(task.workerId);
            return;
          }
          // Success needs no toast: main re-sends the plan and the row shows the worker.
          void window.termina.dispatchRun(pane.instanceId, task.text).then((res) => {
            if (!res.ok) toast(res.error ?? "dispatch failed", "warning");
          });
        });
      }
      elements.planList.appendChild(li);
    }
    elements.planPanel.classList.toggle("collapsed", pane.plan.length === 0);
    bindings.onPlanContent(pane.plan.length > 0, pane.plan.length, announce);
    // Dispatch is possible when the plan has tasks. The button label shows
    // whether a dispatch is running (main re-sends the plan on settle).
    elements.btnDispatch.hidden = pane.plan.length === 0;
  }

  /** Drop review marks for paths main no longer lists. Clear (and any list
   *  replacement) forgets review state; without pruning, a re-added path would
   *  resurrect a stale ✓ from an earlier review. */
  function pruneReviewMarks(pane: TPane): void {
    const live = new Set(pane.modified.map((f) => f.path));
    for (const path of pane.accepted.keys()) {
      if (!live.has(path)) pane.accepted.delete(path);
    }
    for (const path of pane.reverted) {
      if (!live.has(path)) pane.reverted.delete(path);
    }
  }

  /** A disk change invalidates every accept mark on that file: the ✓ reviewed
   *  the bytes it no longer has. Paths are absolute, so no two panes can mean
   *  different files by the same key. */
  function dropStaleAcceptMarks(path: string): void {
    for (const pane of bindings.getAllPanes()) {
      if (!pane.accepted.delete(path)) continue;
      if (pane.instanceId === bindings.getActivePaneId()) {
        renderModified(pane);
        bindings.onReviewChanged(pane);
      }
    }
  }

  function renderModified(pane: TPane, announce = true): void {
    elements.modifiedCount.textContent = pane.modified.length ? `(${pane.modified.length})` : "";
    if (modifiedRenderedPaneId !== pane.instanceId) {
      elements.modifiedList.replaceChildren();
      modifiedRenderedPaneId = pane.instanceId;
    }
    const existing = new Map<string, HTMLLIElement>();
    for (const row of elements.modifiedList.querySelectorAll<HTMLLIElement>("li[data-path]")) {
      const path = row.dataset.path;
      if (path) existing.set(path, row);
    }
    const seen = new Set<string>();
    for (const f of pane.modified) {
      const current = existing.get(f.path);
      const isNew = !current;
      const li = current ?? document.createElement("li");
      li.dataset.path = f.path;
      li.dataset.relPath = f.relPath;
      let badge = li.querySelector<HTMLElement>(".status-badge");
      let path = li.querySelector<HTMLElement>(".path");
      if (!badge || !path) {
        li.replaceChildren();
        badge = document.createElement("span");
        path = document.createElement("span");
        badge.className = "status-badge";
        path.className = "path";
        li.append(badge, path);
      }
      badge.className = `status-badge ${f.status}`;
      badge.textContent = f.status === "created" ? "A" : f.status === "deleted" ? "D" : "M";
      path.textContent = f.relPath;
      path.title = f.path;
      for (const mark of li.querySelectorAll(".review-mark")) mark.remove();
      if (isNew) {
        li.addEventListener("click", () => {
          // The modified list is the review surface: clicking opens the diff.
          const projectId = pane.projectId;
          const workspaceId = pane.workspaceId;
          if (!projectId || !workspaceId) return;
          bindings.openReview(pane, li.dataset.path ?? f.path, li.dataset.relPath ?? f.relPath);
        });
      }
      const reviewedAt = pane.accepted.get(f.path);
      if (reviewedAt !== undefined) {
        const mark = document.createElement("span");
        mark.className = "review-mark accepted";
        mark.textContent = "✓";
        mark.title = `Reviewed ${new Date(reviewedAt).toLocaleString()}`;
        li.appendChild(mark);
      } else if (pane.reverted.has(f.path)) {
        const mark = document.createElement("span");
        mark.className = "review-mark reverted";
        mark.textContent = "↩";
        li.appendChild(mark);
      }
      elements.modifiedList.appendChild(li);
      seen.add(f.path);
    }
    for (const [path, row] of existing) {
      if (!seen.has(path)) row.remove();
    }
    elements.modifiedPanel.classList.toggle("collapsed", pane.modified.length === 0);
    bindings.onModifiedContent(pane.modified.length > 0, pane.modified.length, announce);
  }

  function clear(): void {
    elements.planList.replaceChildren();
    elements.planPanel.classList.add("collapsed");
    elements.modifiedList.replaceChildren();
    modifiedRenderedPaneId = null;
    elements.modifiedPanel.classList.add("collapsed");
    elements.btnDispatch.hidden = true;
    bindings.onPlanContent(false, 0, false);
    bindings.onModifiedContent(false, 0, false);
  }

  const onClearModified = (e: MouseEvent): void => {
    e.stopPropagation();
    const pane = bindings.getActivePane();
    if (!pane) return;
    // Main owns the list: clear it there or the next push resurrects it.
    void window.termina.clearModified(pane.instanceId).then((res) => {
      if (!res.ok) toast(res.error ?? "could not clear the list", "warning");
    });
  };

  const onAcceptAll = (e: MouseEvent): void => {
    e.stopPropagation();
    const pane = bindings.getActivePane();
    if (!pane || pane.modified.length === 0) return;
    // Accept every file: the list becomes the approved changes for a commit.
    const reviewedAt = Date.now();
    for (const f of pane.modified) {
      pane.accepted.set(f.path, reviewedAt);
      pane.reverted.delete(f.path);
    }
    renderModified(pane);
    bindings.onReviewChanged(pane);
    // No toast: the ✓ marks on the rows are the confirmation.
  };

  const onModifiedHeader = (): void => {
    elements.modifiedPanel.classList.toggle("collapsed");
  };

  const onPlanHeader = (e: Event): void => {
    if ((e.target as HTMLElement).closest("#btn-dispatch")) return;
    elements.planPanel.classList.toggle("collapsed");
  };

  const onDispatch = (): void => {
    const id = bindings.getActivePaneId();
    if (!id) return;
    // Success needs no toast: main re-sends the plan and each row shows its worker.
    void window.termina.dispatchRun(id).then((res) => {
      if (!res.ok) toast(res.error ?? "dispatch failed", "warning");
    });
  };

  elements.btnClearModified.addEventListener("click", onClearModified);
  elements.btnAcceptAll.addEventListener("click", onAcceptAll);
  const modifiedHeader = elements.modifiedPanel.querySelector(".panel-header");
  const planHeader = elements.planPanel.querySelector(".panel-header");
  modifiedHeader?.addEventListener("click", onModifiedHeader);
  planHeader?.addEventListener("click", onPlanHeader);
  elements.btnDispatch.addEventListener("click", onDispatch);

  const unsubs = [
    window.termina.onPlanUpdate(({ instanceId, tasks }) => {
      const pane = bindings.getPaneById(instanceId);
      if (!pane) return;
      pane.planVersion++;
      pane.plan = tasks;
      pane.planLoaded = true;
      pane.planLoadAttempts = 0;
      if (bindings.getActivePaneId() === instanceId) renderPlan(pane);
    }),
    window.termina.onModifiedList((p) => {
      const pane = bindings.getPaneById(p.instanceId);
      if (!pane) return;
      pane.modified = p.files;
      pruneReviewMarks(pane);
      if (bindings.getActivePaneId() === pane.instanceId) renderModified(pane);
      bindings.onModifiedListChanged(pane);
    }),
  ];

  function dispose(): void {
    elements.btnClearModified.removeEventListener("click", onClearModified);
    elements.btnAcceptAll.removeEventListener("click", onAcceptAll);
    modifiedHeader?.removeEventListener("click", onModifiedHeader);
    planHeader?.removeEventListener("click", onPlanHeader);
    elements.btnDispatch.removeEventListener("click", onDispatch);
    for (const unsub of unsubs) unsub();
  }

  return { renderPlan, renderModified, pruneReviewMarks, dropStaleAcceptMarks, clear, dispose };
}
