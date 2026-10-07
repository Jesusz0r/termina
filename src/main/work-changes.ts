import type { ModifiedFile, ReviewTarget, TerminaBridge } from "../../shared/types";
import type { ReadOnlyReviewDiff } from "../review-diff";

/** Read-only, on-demand view of the terminal's canonical cumulative review list. */
export function createWorkChanges(bindings: {
  element: HTMLElement;
  getReviewFiles: TerminaBridge["getReviewFiles"];
  getReviewDiff: TerminaBridge["getReviewDiff"];
}): {
  render(target: ReviewTarget | null, selectionKey: string): void;
  open(): void;
  invalidate(): void;
  unavailable(): void;
  clear(): void;
  dispose(): void;
} {
  const { element } = bindings;
  element.hidden = true;
  element.className = "overview-work-changes";
  element.setAttribute("aria-label", "Terminal change review");
  const heading = document.createElement("h3");
  heading.textContent = "Terminal change review";
  const paragraph = (className: string): HTMLElement => {
    const node = document.createElement("p");
    node.className = `overview-changes-${className}`;
    return node;
  };
  const scope = paragraph("scope");
  const description = paragraph("description");
  description.textContent = "Cumulative terminal review, not an attribution to this task. Recorded paths may no longer differ. Diffs compare the captured baseline with current disk; unsaved editor text is not included.";
  const status = paragraph("status");
  status.setAttribute("role", "status");
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "overview-changes-reload";
  reload.textContent = "Reload changes";
  const list = document.createElement("ul");
  list.className = "overview-changes-list";
  list.setAttribute("aria-label", "Recorded terminal paths");
  const more = document.createElement("button");
  more.type = "button";
  more.className = "overview-changes-more";
  more.hidden = true;
  const diffSection = document.createElement("section");
  diffSection.className = "overview-changes-diff-section";
  diffSection.hidden = true;
  diffSection.setAttribute("aria-label", "Baseline to current disk diff");
  const diffHeading = document.createElement("h4");
  diffHeading.textContent = "Captured baseline → current disk";
  const filename = paragraph("filename");
  const diffStatus = paragraph("diff-status");
  diffStatus.setAttribute("role", "status");
  const focus = document.createElement("button");
  focus.type = "button";
  focus.className = "overview-changes-focus";
  focus.textContent = "Focus diff";
  focus.hidden = true;
  const diffElement = document.createElement("div");
  diffElement.className = "overview-changes-diff";
  diffElement.hidden = true;
  diffSection.append(diffHeading, filename, diffStatus, focus, diffElement);
  element.append(heading, scope, description, reload, status, list, more, diffSection);
  let target: ReviewTarget | null = null;
  let selection = "";
  let files: ModifiedFile[] = [];
  let total = 0;
  let filesSequence = 0;
  let diffSequence = 0;
  let selectedPath: string | null = null;
  let available = false;
  let disposed = false;
  let diffView: ReadOnlyReviewDiff | null = null;

  function clearDiff(): void {
    diffSequence++;
    selectedPath = null;
    diffView?.clear();
    diffSection.hidden = true;
    diffElement.hidden = true;
    diffSection.setAttribute("aria-busy", "false");
    filename.textContent = "";
    diffStatus.textContent = "";
    focus.hidden = true;
    for (const row of list.querySelectorAll("button")) row.removeAttribute("aria-current");
  }

  function reset(): void {
    filesSequence++;
    clearDiff();
    files = [];
    total = 0;
    list.replaceChildren();
    more.hidden = true;
    more.disabled = false;
    status.textContent = "";
    list.setAttribute("aria-busy", "false");
  }

  function isCurrent(sequence: number): boolean {
    return !disposed && available && !!target && !element.hidden && sequence === filesSequence;
  }

  function appendFiles(added: ModifiedFile[]): void {
    for (const file of added) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.path = file.path;
      const badge = document.createElement("span");
      badge.className = `status-badge ${file.status}`;
      badge.textContent = file.status === "created" ? "A" : file.status === "deleted" ? "D" : "M";
      const path = document.createElement("span");
      path.className = "overview-changes-path";
      path.textContent = file.relPath;
      button.title = file.path;
      button.setAttribute("aria-label", `${file.status} · ${file.relPath}`);
      button.addEventListener("click", () => { void loadDiff(file); });
      button.append(badge, path);
      row.append(button);
      list.append(row);
    }
  }

  async function loadFiles(offset: number): Promise<void> {
    if (disposed || !available || !target) return;
    if (offset === 0) reset();
    element.hidden = false;
    const sequence = ++filesSequence;
    list.setAttribute("aria-busy", "true");
    status.textContent = "Loading recorded terminal paths…";
    more.disabled = true;
    try {
      const result = await bindings.getReviewFiles(target, offset);
      if (!isCurrent(sequence)) return;
      if (!result.ok) { status.textContent = result.error; return; }
      files.push(...result.files);
      total = result.total;
      appendFiles(result.files);
      status.textContent = total === 0
        ? "No recorded paths for this terminal; not proof that the work area is unchanged."
        : `${files.length} of ${total} recorded terminal paths · recorded status, not task attribution`;
      more.hidden = files.length >= total;
      more.textContent = `Show more paths (${Math.max(0, total - files.length)} remaining)`;
      if (offset > 0) list.children[offset]?.querySelector<HTMLButtonElement>("button")?.focus();
    } catch {
      if (isCurrent(sequence)) status.textContent = "Could not load recorded paths. Reload changes or retry Show more.";
    } finally {
      if (isCurrent(sequence)) { list.setAttribute("aria-busy", "false"); more.disabled = false; }
    }
  }

  async function loadDiff(file: ModifiedFile): Promise<void> {
    if (disposed || !available || !target || element.hidden || !files.some((entry) => entry.path === file.path)) return;
    clearDiff();
    selectedPath = file.path;
    for (const row of list.querySelectorAll<HTMLButtonElement>("button")) {
      if (row.dataset.path === selectedPath) row.setAttribute("aria-current", "true");
    }
    const sequence = ++diffSequence;
    const isLatest = (): boolean => !disposed && available && !element.hidden && sequence === diffSequence;
    diffSection.hidden = false;
    filename.textContent = file.relPath;
    diffStatus.textContent = "Loading diff…";
    diffSection.setAttribute("aria-busy", "true");
    try {
      const result = await bindings.getReviewDiff(target, file.path);
      if (!isLatest()) return;
      if (!result.ok) { diffStatus.textContent = result.error; return; }
      if (result.path !== file.path) { diffStatus.textContent = "This file changed or is unavailable. Reload changes."; return; }
      if (!diffView) {
        const { ReadOnlyReviewDiff } = await import("../review-diff");
        if (!isLatest()) return;
        diffView = new ReadOnlyReviewDiff(diffElement, "work-inspector", false);
      }
      diffElement.hidden = false;
      diffView.setDiff(result.path, result.baseline ?? "", result.current);
      diffStatus.textContent = result.deleted ? "Deleted on disk · the captured baseline is shown as removed."
        : result.baseline === null ? "Created file · no file existed in the captured baseline."
        : result.baseline === result.current ? "No current text difference from the captured baseline."
        : "Read-only captured baseline to current disk diff.";
      focus.hidden = false;
    } catch {
      if (isLatest()) diffStatus.textContent = "Could not load this diff. Select the file to try again.";
    } finally {
      if (isLatest()) diffSection.setAttribute("aria-busy", "false");
    }
  }

  const onReload = (): void => { void loadFiles(0); };
  const onMore = (): void => { void loadFiles(files.length); };
  const onFocus = (): void => { if (!disposed && available && !diffElement.hidden) diffView?.focus(); };
  reload.addEventListener("click", onReload);
  more.addEventListener("click", onMore);
  focus.addEventListener("click", onFocus);
  return {
    render: (next, key) => {
      if (disposed) return;
      const nextSelection = JSON.stringify([key, next]);
      if (nextSelection !== selection) { reset(); element.hidden = true; }
      selection = nextSelection;
      target = next;
      available = !!next;
      reload.disabled = !available;
      scope.textContent = next ? `${next.terminalId} · ${next.root}` : "Assigned work area unavailable";
    },
    open: onReload,
    invalidate: () => {
      if (disposed) return;
      const restoreFocus = list.contains(document.activeElement) || diffSection.contains(document.activeElement);
      reset();
      if (!element.hidden) {
        status.textContent = "Recorded paths or source changed. Reload changes before inspecting.";
        if (restoreFocus) reload.focus();
      }
    },
    unavailable: () => { if (!disposed) { reset(); available = false; element.hidden = true; reload.disabled = true; } },
    clear: () => { reset(); target = null; selection = ""; available = false; element.hidden = true; },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      reset();
      diffView?.dispose(); diffView = null;
      target = null; available = false;
      reload.removeEventListener("click", onReload);
      more.removeEventListener("click", onMore);
      focus.removeEventListener("click", onFocus);
    },
  };
}
