/**
 * File explorer: shows the project folder tree, opens files in the
 * project editor, and supports create / rename / delete of files and folders.
 * Directories load lazily on expand; the tree refreshes from watcher events.
 * Entries drag onto folders to move (cut + paste); the move itself reuses
 * the explorer:paste backend, so no new IPC exists for drag-drop.
 */
import { pathBasename, type CommandId, type ContentHit, type ExplorerEntry } from "../../shared/types";
import {
  ancestorDirs,
  computeChangedSets,
  deleteConfirmMessage,
  fileIconKind,
  filterKeeps,
  filterVisibleSet,
  findTypeAheadIndex,
  normalizeRelPath,
  parentRowRel,
  rowLevel,
  splitExtension,
  targetDirRel,
} from "../explorer-file";
import { showContextMenu, closeContextMenu, type ContextMenuItem } from "./context-menu";
import { copyText, showConfirm, showInput, toast } from "./modals";

/** Matches the CSS transition on the focus ring; type-ahead resets after it. */
const TYPE_AHEAD_RESET_MS = 700;

/** Matches the Quick Open debounce; long enough to skip intermediate keystrokes. */
const FILTER_DEBOUNCE_MS = 150;

/** Icon element for a file row; the kind drives the CSS shape/color. */
function makeFileIcon(name: string): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "explorer-icon file-icon";
  icon.dataset.kind = fileIconKind(name);
  return icon;
}

/** Right-edge dot for a row the agent changed. Always occupies its width (the
 *  `.changed` class toggles opacity only), so marking never reflows the row. */
function makeChangeMark(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "explorer-change";
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

/** Non-interactive placeholder (loading, truncation). Not a button. */
function makeNote(text: string): HTMLElement {
  const note = document.createElement("div");
  note.className = "explorer-note";
  note.textContent = text;
  return note;
}

/** Name element; for files the extension is dimmed so the basename reads
 *  first. Directories stay single-tone (a dot is just part of the name). */
function makeNameEl(name: string, twoTone = true): HTMLElement {
  const el = document.createElement("span");
  el.className = "explorer-name";
  el.title = name;
  const { base, ext } = twoTone ? splitExtension(name) : { base: name, ext: "" };
  if (!ext) {
    el.textContent = name;
    return el;
  }
  const baseEl = document.createElement("span");
  baseEl.className = "explorer-name-base";
  baseEl.textContent = base;
  const extEl = document.createElement("span");
  extEl.className = "explorer-name-ext";
  extEl.textContent = ext;
  el.append(baseEl, extEl);
  return el;
}

interface DirState {
  expanded: boolean;
  loaded: boolean;
  /** Bumped per list. A slow listing never fills a newer expand. */
  loadSeq: number;
}

interface DirView {
  entry: ExplorerEntry;
  state: DirState;
  node: HTMLElement;
  children: HTMLElement;
  /** The row element and its chevron, so a keyboard toggle updates both. */
  row: HTMLElement;
  arrow: HTMLElement;
}

/**
 * ARIA treeitem attributes for a row. `aria-level` follows the tree depth and
 * `aria-expanded` exists only for directories (a file must not claim it).
 */
function applyRowA11y(row: HTMLElement, entry: ExplorerEntry, expanded?: boolean): void {
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(rowLevel(entry.relPath)));
  if (entry.type === "dir") row.setAttribute("aria-expanded", expanded ? "true" : "false");
  row.setAttribute("aria-selected", row.classList.contains("selected") ? "true" : "false");
  // Roving tabindex: exactly one row is tabbable, the rest are reachable by arrow.
  if (row.tabIndex !== 0) row.tabIndex = -1;
}

export class Explorer {
  private treeEl: HTMLElement;
  private dirs = new Map<string, DirState>(); // keyed by abs path
  /** Mounted directory nodes, so watcher refreshes can target one branch. */
  private dirViews = new Map<string, DirView>();
  private projectId: string | null = null;
  private projectCwd: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges = new Set<string>();
  private selected: ExplorerEntry | null = null;
  /** Project-relative entry waiting for Paste. */
  private clipboardEntry: { relPath: string; cut: boolean } | null = null;
  /** Entry being dragged; null outside a drag. Drop validity reads this. */
  private dragSrc: ExplorerEntry | null = null;
  /** Pending auto-expand of a collapsed folder hovered mid-drag. */
  private expandTimer: ReturnType<typeof setTimeout> | null = null;

  private onOpenFile: (absPath: string, preview?: boolean) => void = () => {};
  private onContentHit: (relPath: string, line: number, column: number) => void = () => {};
  /** Project-relative files the agent changed (row dot marker). */
  private changedRel = new Set<string>();
  /** Project-relative directories containing a changed file, so a collapsed
   *  branch still shows that something inside it changed. */
  private changedDirRel = new Set<string>();
  /** The row currently holding the roving tabindex (tabIndex 0). */
  private focusedRow: HTMLElement | null = null;
  /** Roving tabindex target: the project-relative path of the focused row. */
  private focusedPath: string | null = null;
  /** Filter box, when the host markup provides one. */
  private filterInput: HTMLInputElement | null = null;
  /** Rows an active filter keeps; null means no filter is active. */
  private filterVisible: Set<string> | null = null;
  /** Debounce for the project-wide search behind the filter. */
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Persistent content-search listing, fed by the Search Contents modal. */
  private contentSection: HTMLElement | null = null;
  private contentTitle: HTMLElement | null = null;
  private contentResults: HTMLElement | null = null;
  /** Pattern behind the listing; "" means the section is empty/hidden. */
  private contentPattern = "";
  /** Bumped per re-run. A slow old search never renders over a newer one. */
  private contentSeq = 0;
  /** Fences a superseded search: a slow reply never paints over a newer query. */
  private filterSeq = 0;
  /** Truncation note for the active filter ("50+ matches …"); null when complete. */
  private filterTruncatedNote: string | null = null;
  /** Type-ahead buffer and its reset timer (keyboard name search). */
  private typeBuffer = "";
  private typeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The entry behind each row, so keyboard actions act on the same object the
   *  mouse does. Keyed by element so a rebuilt row never inherits a stale one. */
  private readonly rowEntry = new WeakMap<HTMLElement, ExplorerEntry>();
  /** The row currently painted as selected, so `select` clears exactly one. */
  private selectedRow: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.treeEl = container.querySelector("#explorer-tree") as HTMLElement;
    this.filterInput = container.querySelector<HTMLInputElement>("#explorer-filter-input");
    this.filterInput?.addEventListener("input", () => this.setFilter(this.filterInput?.value ?? ""));
    this.filterInput?.addEventListener("keydown", (e) => {
      // Escape clears the filter and hands focus back to the tree, so the
      // arrow keys keep working without a mouse trip.
      if (e.key === "Escape" && this.filterInput?.value) {
        e.preventDefault();
        this.filterInput.value = "";
        this.setFilter("");
        this.restoreFocus();
        return;
      }
      // Down/Up leave the box for the tree, matching the filter-then-navigate flow.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const row = this.currentRow(this.visibleRows());
        if (!row) return;
        e.preventDefault();
        this.focusRow(row);
      }
    });
    this.treeEl.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".explorer-row")) return;
      e.preventDefault();
      if (!this.projectCwd) return;
      showContextMenu(this.rootMenuItems(), e.clientX, e.clientY);
    });
    this.treeEl.addEventListener("keydown", (e) => this.onKeyDown(e));
    // Focus can leave the tree (Tab away); keep the roving row in sync so
    // returning to the tree resumes where the user was.
    this.treeEl.addEventListener("focusout", () => this.storeFocusedRow());
    this.contentSection = container.querySelector("#explorer-content");
    this.contentTitle = container.querySelector("#explorer-content-title");
    this.contentResults = container.querySelector("#explorer-content-results");
    container.querySelector("#explorer-content-rerun")?.addEventListener("click", () => void this.rerunContentSearch());
    container.querySelector("#explorer-content-clear")?.addEventListener("click", () => this.clearContentResults());
    void this.renderRoot();
  }

  // ------------------------------------------------- keyboard + focus --

  /**
   * Rows the keyboard can reach, in DOM order (which is preorder traversal and
   * therefore visual order).
   *
   * Hidden rows are excluded: an active filter hides rows without unmounting
   * them, so without this the arrow keys and type-ahead would walk into rows the
   * user cannot see.
   */
  private visibleRows(): HTMLElement[] {
    return [...this.treeEl.querySelectorAll<HTMLElement>(".explorer-row:not([hidden])")];
  }

  private rowByRel(rel: string): HTMLElement | null {
    for (const row of this.visibleRows()) {
      if (row.dataset.relPath === rel) return row;
    }
    return null;
  }

  private currentRow(rows: HTMLElement[]): HTMLElement | null {
    if (rows.length === 0) return null;
    const byPath = this.focusedPath ? rows.find((r) => r.dataset.relPath === this.focusedPath) : undefined;
    return byPath ?? rows[0]!;
  }

  /** Remember the focused row and move the roving tabindex onto it. */
  /**
   * Move the roving tabindex onto `row`. O(1): only the previously focused row
   * and the new one change, so a keystroke on a 2000-entry tree does two DOM
   * writes instead of re-scanning every row.
   */
  private markFocus(row: HTMLElement): void {
    const previous = this.focusedRow;
    if (previous && previous !== row) previous.tabIndex = -1;
    row.tabIndex = 0;
    this.focusedRow = row;
    this.focusedPath = row.dataset.relPath ?? null;
  }

  private storeFocusedRow(): void {
    const active = document.activeElement as HTMLElement | null;
    if (active && this.treeEl.contains(active) && active.dataset.relPath !== undefined) {
      this.markFocus(active);
    }
  }

  /** Focus a row: selection follows focus, so rename/delete target it. */
  private focusRow(row: HTMLElement, focus = true): void {
    this.markFocus(row);
    if (focus) row.focus();
    const entry = this.rowEntry.get(row);
    if (entry) this.select(entry, row);
  }

  /**
   * Re-apply roving focus after the tree was rebuilt (refresh, expand,
   * collapse). Keeps DOM focus only when the tree already had it, so a
   * background watcher refresh never steals focus from the editor.
   */
  private restoreFocus(fallbackRel: string | null = null): void {
    // A rebuild can drop the selected entry (deleted on disk, filtered out).
    // Leaving it selected would aim rename/delete at a path that is gone.
    if (this.selectedRow && !this.selectedRow.isConnected) {
      this.selected = null;
      this.selectedRow = null;
    }
    const rows = this.visibleRows();
    if (rows.length === 0) return;
    const hadFocus = this.treeEl.contains(document.activeElement);
    const target =
      (this.focusedPath ? rows.find((r) => r.dataset.relPath === this.focusedPath) : undefined)
      ?? (fallbackRel !== null ? rows.find((r) => r.dataset.relPath === fallbackRel) : undefined)
      ?? rows[0]!;
    this.markFocus(target);
    if (hadFocus) target.focus();
  }

  /** Drop the type-ahead buffer. Navigation keys end a name search, so a stale
   *  buffer cannot combine with the next keystroke. */
  private resetTypeAhead(): void {
    this.typeBuffer = "";
    if (this.typeTimer) {
      clearTimeout(this.typeTimer);
      this.typeTimer = null;
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    // Modifier combos belong to the shortcut dispatcher and the browser.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The capture-phase shortcut dispatcher in main handles F2 when it is
    // bound; this fallback keeps rename working when it is unbound.
    if (e.key === "F2") {
      const row = this.currentRow(this.visibleRows());
      const entry = row ? this.rowEntry.get(row) : undefined;
      if (entry) {
        e.preventDefault();
        void this.renameAt(entry);
      }
      return;
    }
    const rows = this.visibleRows();
    const row = this.currentRow(rows);
    if (!row) return;
    const index = rows.indexOf(row);
    const entry = this.rowEntry.get(row);

    const move = (delta: number): void => {
      const next = rows[index + delta];
      if (next) this.focusRow(next);
    };

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.resetTypeAhead();
        move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        this.resetTypeAhead();
        move(-1);
        return;
      case "Home":
        e.preventDefault();
        this.resetTypeAhead();
        this.focusRow(rows[0]!);
        return;
      case "End":
        e.preventDefault();
        this.resetTypeAhead();
        this.focusRow(rows[rows.length - 1]!);
        return;
      case "ArrowRight": {
        if (!entry) return;
        e.preventDefault();
        this.resetTypeAhead();
        if (entry.type === "dir") {
          const view = this.dirViews.get(entry.path);
          if (view && !view.state.expanded) void this.setDirExpanded(entry.path, true);
          // Already open: step into the first child, if it is mounted.
          else {
            const next = rows[index + 1];
            if (next && Number(next.getAttribute("aria-level")) > Number(row.getAttribute("aria-level"))) {
              this.focusRow(next);
            }
          }
        }
        return;
      }
      case "ArrowLeft": {
        if (!entry) return;
        e.preventDefault();
        this.resetTypeAhead();
        const view = entry.type === "dir" ? this.dirViews.get(entry.path) : undefined;
        if (view?.state.expanded) {
          void this.setDirExpanded(entry.path, false);
          return;
        }
        const parentRel = parentRowRel(entry.relPath);
        if (parentRel !== null) {
          const parentRow = this.rowByRel(parentRel);
          if (parentRow) this.focusRow(parentRow);
        }
        return;
      }
      case "Enter": {
        if (!entry) return;
        e.preventDefault();
        this.resetTypeAhead();
        if (entry.type === "dir") {
          const view = this.dirViews.get(entry.path);
          void this.setDirExpanded(entry.path, !(view?.state.expanded ?? false));
        } else {
          // Same as double-click: open pinned, not as a preview.
          this.onOpenFile(entry.path, false);
        }
        return;
      }
      case "Delete": {
        // The root row has no relPath; there is nothing to delete.
        if (!entry || !entry.relPath) return;
        e.preventDefault();
        void this.deleteAt(entry);
        return;
      }
      case "Backspace": {
        // While a type-ahead search is active, Backspace edits the search
        // instead of arming a delete: a typo must never open a destructive
        // confirm in the middle of typing a file name.
        if (this.typeBuffer) {
          e.preventDefault();
          this.typeBuffer = this.typeBuffer.slice(0, -1);
          if (this.typeBuffer) this.applyTypeAhead(rows, index);
          return;
        }
        if (!entry || !entry.relPath) return;
        e.preventDefault();
        void this.deleteAt(entry);
        return;
      }
      default:
        break;
    }

    // Type-ahead: a printable single character jumps to the next matching name.
    if (e.key.length === 1 && e.key !== " ") {
      if (this.typeAhead(rows, index, e.key)) e.preventDefault();
    }
  }

  /** Focus the row matching the current buffer; false when nothing matches. */
  private applyTypeAhead(rows: HTMLElement[], index: number): boolean {
    const names = rows.map((r) => r.dataset.name ?? "");
    const found = findTypeAheadIndex(names, index, this.typeBuffer);
    const row = found === -1 ? undefined : rows[found];
    if (!row) return false;
    this.focusRow(row);
    return true;
  }

  /** Extend the type-ahead buffer and focus the next name that matches it. */
  private typeAhead(rows: HTMLElement[], index: number, char: string): boolean {
    this.typeBuffer += char;
    if (this.typeTimer) clearTimeout(this.typeTimer);
    this.typeTimer = setTimeout(() => {
      this.typeTimer = null;
      this.typeBuffer = "";
    }, TYPE_AHEAD_RESET_MS);
    return this.applyTypeAhead(rows, index);
  }

  bind(handlers: { onOpenFile: (absPath: string, preview?: boolean) => void; onContentHit: (relPath: string, line: number, column: number) => void }): void {
    this.onOpenFile = handlers.onOpenFile;
    this.onContentHit = handlers.onContentHit;
  }

  /** File-menu commands (File → New File / New Folder / Rename / Delete…). */
  handleCommand(command: CommandId): void {
    switch (command) {
      case "new-file":
        void this.createAt(this.createTargetRel(), "file");
        break;
      case "new-folder":
        void this.createAt(this.createTargetRel(), "dir");
        break;
      case "rename":
        this.withSelected((entry) => void this.renameAt(entry));
        break;
      case "delete":
        this.withSelected((entry) => void this.deleteAt(entry));
        break;
      case "refresh":
        void this.refresh();
        break;
    }
  }

  /**
   * Folder a File-menu create should land in: the selected folder, the parent of
   * the selected file, or the project root when nothing is selected. The context
   * menu offers the same targets, so both paths agree.
   */
  private createTargetRel(): string {
    return this.selected ? targetDirRel(this.selected) : "";
  }

  /** Called when the project folder changes. Null clears the tree. */
  setProject(projectId: string | null, cwd: string | null): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.projectId = projectId;
    this.projectCwd = cwd;
    this.dirs.clear();
    this.dirViews.clear();
    this.pendingChanges.clear();
    this.selected = null;
    this.selectedRow = null;
    // Clipboard entries are project-relative: they never survive a switch.
    this.clipboardEntry = null;
    this.dragSrc = null;
    // Change marks are project-relative too; main re-pushes them per project.
    this.changedRel = new Set<string>();
    this.changedDirRel = new Set<string>();
    // The filter is project-relative too; clear it rather than carry matches over.
    this.filterVisible = null;
    this.filterTruncatedNote = null;
    this.filterSeq++;
    if (this.filterTimer) {
      clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
    if (this.filterInput) this.filterInput.value = "";
    // Keyboard state is project-relative as well.
    this.focusedRow = null;
    this.focusedPath = null;
    this.resetTypeAhead();
    this.clearExpandTimer();
    // Content results are project-relative as well.
    this.clearContentResults();
    closeContextMenu();
    void this.renderRoot();
  }

  /**
   * List content-search hits grouped by file. Fed by the Search Contents
   * modal; the listing persists so many hits stay browsable after the modal
   * closes.
   */
  showContentResults(pattern: string, hits: ContentHit[], truncated: boolean): void {
    this.contentPattern = pattern;
    const section = this.contentSection;
    const title = this.contentTitle;
    const results = this.contentResults;
    if (!section || !title || !results) return;
    section.hidden = false;
    const label = hits.length === 1 ? "1 match" : `${hits.length} matches`;
    title.textContent = `${label} for "${pattern}"${truncated ? " (truncated)" : ""}`;
    title.title = pattern;
    results.replaceChildren();
    if (hits.length === 0) {
      results.appendChild(makeNote(`No matches for "${pattern}".`));
      return;
    }
    let currentFile: string | null = null;
    for (const hit of hits) {
      if (hit.relPath !== currentFile) {
        currentFile = hit.relPath;
        const file = document.createElement("div");
        file.className = "explorer-content-file";
        file.textContent = hit.relPath;
        file.title = hit.relPath;
        results.appendChild(file);
      }
      const row = document.createElement("div");
      row.className = "explorer-content-hit";
      row.title = `${hit.relPath}:${hit.line}`;
      const lineNo = document.createElement("span");
      lineNo.className = "explorer-content-line";
      lineNo.textContent = String(hit.line);
      const text = document.createElement("span");
      text.className = "explorer-content-text";
      text.textContent = hit.text || "(empty line)";
      row.append(lineNo, text);
      row.addEventListener("click", () => this.onContentHit(hit.relPath, hit.line, hit.column));
      results.appendChild(row);
    }
    if (truncated) results.appendChild(makeNote("More matches exist — refine to narrow."));
  }

  /** Hide the content listing and forget its pattern. */
  clearContentResults(): void {
    this.contentPattern = "";
    this.contentSeq++;
    if (this.contentSection) this.contentSection.hidden = true;
    this.contentResults?.replaceChildren();
  }

  /** Re-run the listing's pattern (it goes stale as files change). */
  private async rerunContentSearch(): Promise<void> {
    const pattern = this.contentPattern;
    const results = this.contentResults;
    if (!pattern || !results) return;
    const seq = ++this.contentSeq;
    results.replaceChildren();
    const loading = makeNote("searching…");
    results.appendChild(loading);
    let res;
    try {
      res = await window.termina.searchContent(pattern, "explorer");
    } catch (err) {
      if (seq !== this.contentSeq) return;
      results.replaceChildren();
      results.appendChild(makeNote((err as Error).message));
      return;
    }
    if (seq !== this.contentSeq) return;
    if (res.error) {
      results.replaceChildren();
      results.appendChild(makeNote(res.error));
      return;
    }
    this.showContentResults(pattern, res.hits, res.truncated ?? false);
  }

  /** A file/dir changed on disk (watcher events) — refresh lazily. */
  handleDiskChange(path?: string): void {
    if (path) this.pendingChanges.add(path);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const changes = [...this.pendingChanges];
      this.pendingChanges.clear();
      void this.refresh(changes);
    }, 250);
  }

  async refresh(changedPaths?: string[]): Promise<void> {
    if (!this.projectCwd) return;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (!changedPaths) this.pendingChanges.clear();
    if (!changedPaths || changedPaths.length === 0) {
      await this.renderRoot(true);
      await this.reloadMountedBranches();
      return;
    }
    await this.renderRoot(false);
    const directories = new Set<string>();
    for (const path of changedPaths) {
      if (!path || !this.projectCwd) continue;
      let directory: string = path === this.projectCwd ? path : parentPath(path);
      // If an ancestor is collapsed, its descendants are not mounted. Mark
      // the nearest mounted ancestor stale so the branch reloads on expand.
      while (!this.dirViews.has(directory) && directory !== this.projectCwd) {
        const parent = parentPath(directory);
        if (parent === directory) break;
        directory = parent;
      }
      directories.add(directory);
    }
    for (const path of directories) {
      const view = this.dirViews.get(path);
      if (!view) continue;
      if (view.state.expanded) await this.renderChildren(view.children, view.entry, view.state, true);
      else view.state.loaded = false;
    }
  }

  /**
   * Force-reload every mounted, expanded folder, leaving collapsed ones marked
   * stale so they reload on expand.
   *
   * A full refresh has to walk the whole visible tree, not just the root. A new
   * EMPTY folder produces no file event (the watcher records directories only to
   * detect their later deletion), so nothing else would ever reveal it: neither
   * the watcher nor a root-only reload sees it.
   */
  private async reloadMountedBranches(): Promise<void> {
    for (const path of [...this.dirViews.keys()]) {
      const view = this.dirViews.get(path);
      // The map mutates while reloading (nodes are added and forgotten).
      if (!view) continue;
      // The root is rendered by renderRoot.
      if (view.entry.relPath === "") continue;
      if (view.state.expanded) await this.renderChildren(view.children, view.entry, view.state, true);
      else view.state.loaded = false;
    }
    this.restoreFocus();
  }

  // -------------------------------------------------------------- filter --

  /**
   * Apply a filter query to the tree.
   *
   * The match set comes from the existing project-wide file search rather than
   * from the mounted rows: a filter that only saw mounted rows could never find
   * a file inside a collapsed folder, which is most of them. That search is
   * already bounded and cancellable (`searchProjectFiles`).
   */
  private setFilter(query: string): void {
    const trimmed = query.trim();
    if (this.filterTimer) {
      clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
    const seq = ++this.filterSeq;
    if (!trimmed) {
      this.filterVisible = null;
      this.filterTruncatedNote = null;
      this.applyFilter();
      return;
    }
    this.filterTimer = setTimeout(() => {
      this.filterTimer = null;
      void this.runFilter(trimmed, seq);
    }, FILTER_DEBOUNCE_MS);
  }

  private async runFilter(query: string, seq: number): Promise<void> {
    let matches: string[] = [];
    let truncatedNote: string | null = null;
    try {
      const res = await window.termina.searchFiles(query, "filter");
      matches = res.entries.map((entry) => entry.relPath);
      if (res.truncated) truncatedNote = `${matches.length}+ matches (refine to narrow)`;
    } catch {
      /* A failed search leaves the tree unfiltered rather than empty. */
      return;
    }
    // A newer query, a cleared box, or a project switch owns the tree now.
    if (seq !== this.filterSeq || !this.projectCwd) return;
    // Always a set: an empty one means "this query matched nothing", which is an
    // active filter showing no rows, not an unfiltered tree.
    this.filterVisible = filterVisibleSet(matches);
    this.filterTruncatedNote = truncatedNote;
    await this.expandToMatches(matches);
    if (seq !== this.filterSeq) return;
    this.applyFilter();
    // Row visibility changed, so re-seat focus on a row that is still shown.
    this.restoreFocus();
  }

  /**
   * Expand the ancestor chain of each match so its row mounts.
   *
   * Ancestors are expanded through the single toggle owner, so the chevron,
   * `aria-expanded` and the children block stay in step. Expansion is left in
   * place when the filter clears: those folders were genuinely opened, and
   * silently collapsing them would undo the user's own expansion.
   */
  private async expandToMatches(matches: readonly string[]): Promise<void> {
    for (const match of matches) {
      for (const dirRel of ancestorDirs(match)) {
        const mounted = this.mountedDirView(dirRel);
        if (mounted && !mounted.view.state.expanded) await this.setDirExpanded(mounted.absPath, true);
      }
    }
  }

  /** The mounted view for a project-relative directory, if it has one. */
  private mountedDirView(dirRel: string): { absPath: string; view: DirView } | null {
    for (const [absPath, view] of this.dirViews) {
      if (normalizeRelPath(view.entry.relPath) === dirRel) return { absPath, view };
    }
    return null;
  }

  /**
   * Hide every row the filter excludes. Rows are hidden rather than unmounted:
   * unmounting would drop `dirViews`/`DirState`, and expansion, selection and
   * change marks all key off state that must survive the filter.
   */
  private applyFilter(): void {
    const visible = this.filterVisible;
    for (const row of this.treeEl.querySelectorAll<HTMLElement>(".explorer-row")) {
      const rel = row.dataset.relPath;
      // Rows without a relPath (the empty/loading placeholder) are left alone.
      if (rel === undefined) continue;
      row.hidden = visible !== null && !filterKeeps(visible, rel);
    }
    this.treeEl.classList.toggle("filtered", visible !== null);
    // Flag a live query that matched nothing, so an empty tree is explained.
    // A truncated query keeps its count in the input's title instead.
    if (this.filterInput) {
      this.filterInput.classList.toggle("no-matches", visible !== null && visible.size === 0);
      const note = visible !== null ? this.filterTruncatedNote : null;
      this.filterInput.classList.toggle("truncated", note !== null);
      this.filterInput.title = note ?? "";
    }
  }

  // ------------------------------------------------------------- rendering --

  private async renderRoot(forceReload = false): Promise<void> {
    const cwd = this.projectCwd;
    if (!cwd) {
      this.dirViews.clear();
      this.treeEl.replaceChildren();
      // No tree to describe while there is no project; the action stands alone.
      this.treeEl.removeAttribute("role");
      this.treeEl.removeAttribute("aria-label");
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "explorer-empty";
      empty.textContent = "Open folder";
      empty.addEventListener("click", () => void window.termina.projectOpen());
      this.treeEl.appendChild(empty);
      return;
    }
    // A real tree: screen readers get the structure and the label.
    this.treeEl.setAttribute("role", "tree");
    this.treeEl.setAttribute("aria-label", "Project files");
    const name = pathBasename(cwd);
    const existing = this.dirViews.get(cwd);
    const node = existing?.node ?? this.makeDirRow({ name, path: cwd, relPath: "", type: "dir" }, true);
    if (!node.parentElement) this.treeEl.replaceChildren(node);
    const view = this.dirViews.get(cwd);
    if (view?.state.expanded && (forceReload || !view.state.loaded)) {
      await this.renderChildren(view.children, view.entry, view.state, forceReload);
    }
    this.applyFilter();
    this.restoreFocus();
  }

  private dirState(absPath: string): DirState {
    let state = this.dirs.get(absPath);
    if (!state) {
      state = { expanded: false, loaded: false, loadSeq: 0 };
      this.dirs.set(absPath, state);
    }
    return state;
  }

  /** A collapsed branch no longer needs expansion state for hidden descendants. */
  private pruneCollapsedDescendants(absPath: string): void {
    const slashPrefix = `${absPath}/`;
    const backslashPrefix = `${absPath}\\`;
    for (const path of this.dirs.keys()) {
      if (path.startsWith(slashPrefix) || path.startsWith(backslashPrefix)) {
        this.dirs.delete(path);
        this.dirViews.delete(path);
      }
    }
  }

  /**
   * Drop expansion state for the mounted descendants of a collapsed branch.
   * The nodes carry their own paths, so this stays exact where prefix
   * matching cannot: the root key may be non-canonical (/var vs
   * /private/var) and a prefix prune then silently misses every descendant,
   * leaving stale expanded+loaded states behind detached nodes that never
   * reload on re-expand.
   */
  private forgetMountedDescendants(children: HTMLElement): void {
    for (const el of children.querySelectorAll<HTMLElement>("[data-path]")) {
      const path = el.dataset.path;
      if (path) {
        this.dirs.delete(path);
        this.dirViews.delete(path);
      }
    }
  }

  /** Drop state for a directory that disappeared from its parent's listing. */
  private forgetDirectory(absPath: string): void {
    this.dirs.delete(absPath);
    this.dirViews.delete(absPath);
    this.pruneCollapsedDescendants(absPath);
  }

  /**
   * Replace the agent-changed set. Main owns the modified list and pushes it;
   * the explorer only marks rows, so the dot can never disagree with the
   * Modified panel. Paths are project-relative (as `ModifiedFile.relPath`).
   */
  setModifiedFiles(relPaths: readonly string[]): void {
    const { files, dirs } = computeChangedSets(relPaths);
    this.changedRel = files;
    this.changedDirRel = dirs;
    this.applyChangeMarks();
  }

  /** True when this entry (or, for a directory, something inside it) changed. */
  private isChanged(entry: ExplorerEntry): boolean {
    const rel = normalizeRelPath(entry.relPath);
    return entry.type === "dir" ? this.changedDirRel.has(rel) : this.changedRel.has(rel);
  }

  /** Re-mark every mounted row; toggles a class so the dot's width is fixed. */
  private applyChangeMarks(): void {
    for (const el of this.treeEl.querySelectorAll<HTMLElement>(".explorer-row")) {
      const rel = el.dataset.relPath;
      if (rel === undefined) continue;
      const changed = el.dataset.type === "dir"
        ? this.changedDirRel.has(normalizeRelPath(rel))
        : this.changedRel.has(normalizeRelPath(rel));
      el.classList.toggle("changed", changed);
    }
  }

  private makeDirRow(entry: ExplorerEntry, forceOpen = false): HTMLElement {
    const state = this.dirState(entry.path);
    if (forceOpen) {
      state.expanded = true;
    }

    // VS Code style: a node is a row, with the children indented BELOW it.
    const node = document.createElement("div");
    node.className = "explorer-node";

    const row = document.createElement("div");
    row.className = "explorer-row dir";
    row.dataset.path = entry.path;
    row.dataset.relPath = normalizeRelPath(entry.relPath);
    row.dataset.type = entry.type;
    row.dataset.name = entry.name || entry.path;
    if (this.isChanged(entry)) row.classList.add("changed");
    applyRowA11y(row, entry, state.expanded);

    const arrow = document.createElement("span");
    arrow.className = "explorer-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = state.expanded ? "▾" : "▸";

    const icon = document.createElement("span");
    icon.className = "explorer-icon dir-icon";
    icon.setAttribute("aria-hidden", "true");

    const name = makeNameEl(entry.name || entry.path, false);

    row.append(arrow, icon, name, makeChangeMark());
    row.addEventListener("click", () => {
      this.select(entry, row);
      this.markFocus(row);
      void this.setDirExpanded(entry.path, !state.expanded);
    });
    this.bindRowMenu(row, entry);
    this.setupDragSource(row, entry);

    const children = document.createElement("div");
    children.className = "explorer-children";
    children.setAttribute("role", "group");
    node.append(row, children);
    node.dataset.path = entry.path;
    node.dataset.type = entry.type;
    this.rowEntry.set(row, entry);
    this.dirViews.set(entry.path, { entry, state, node, children, row, arrow });
    // A refresh can rebuild this row; selection is owned here, not by the DOM.
    if (this.selected?.path === entry.path) this.select(entry, row);
    this.setupDirDrop(row, children, entry, state);
    return node;
  }

  /**
   * Expand or collapse a directory by its absolute path. One owner for the
   * toggle so the mouse, the keyboard and drop-to-expand cannot drift: it keeps
   * `state`, the chevron and `aria-expanded` in step, and drops the expansion
   * state of unmounted descendants when collapsing.
   */
  private async setDirExpanded(absPath: string, expanded: boolean): Promise<void> {
    const view = this.dirViews.get(absPath);
    if (!view || view.state.expanded === expanded) return;
    view.state.expanded = expanded;
    if (!expanded) {
      view.state.loadSeq += 1;
      view.state.loaded = false;
      this.forgetMountedDescendants(view.children);
    }
    view.arrow.textContent = expanded ? "▾" : "▸";
    applyRowA11y(view.row, view.entry, expanded);
    await this.renderChildren(view.children, view.entry, view.state);
    // Collapsing may unmount the focused row; fall back to the folder itself.
    this.restoreFocus(normalizeRelPath(view.entry.relPath));
  }

  private async renderChildren(children: HTMLElement, entry: ExplorerEntry, state: DirState, force = false): Promise<void> {
    if (!state.expanded) {
      children.replaceChildren();
      return;
    }
    if (state.loaded && !force) return;
    const seq = ++state.loadSeq;
    const hadContent = state.loaded;
    if (!hadContent) {
      children.replaceChildren();
      children.appendChild(makeNote("loading…"));
    }
    const projectId = this.projectId;
    const cwd = this.projectCwd;
    if (!projectId) return;
    let res: { entries: ExplorerEntry[]; error?: string; truncated?: boolean };
    try {
      res = await window.termina.listDir(projectId, entry.path);
    } catch (err) {
      if (!state.expanded || seq !== state.loadSeq || this.projectCwd !== cwd) return;
      state.loaded = false;
      if (!hadContent) children.replaceChildren();
      toast(`could not list ${entry.name}: ${(err as Error).message}`, "error");
      return;
    }
    if (!state.expanded || seq !== state.loadSeq || this.projectId !== projectId || this.projectCwd !== cwd) return;
    state.loaded = true;
    if (res.error) {
      state.loaded = false;
      if (!hadContent) children.replaceChildren();
      toast(res.error, "error");
      return;
    }
    const current = new Map<string, HTMLElement>();
    for (const node of children.querySelectorAll<HTMLElement>(":scope > [data-path]")) {
      const path = node.dataset.path;
      if (path) current.set(path, node);
    }
    const nextDirPaths = new Set(res.entries.filter((child) => child.type === "dir").map((child) => child.path));
    for (const [path, node] of current) {
      if (node.dataset.type === "dir" && !nextDirPaths.has(path)) this.forgetDirectory(path);
    }
    const next: HTMLElement[] = [];
    if (res.truncated) {
      next.push(makeNote("folder truncated (too many entries)"));
    }
    for (const child of res.entries) {
      const existing = current.get(child.path);
      const node = existing && existing.dataset.type === child.type
        ? existing
        : child.type === "dir" ? this.makeDirRow(child) : this.makeFileRow(child);
      if (child.type === "dir") {
        const view = this.dirViews.get(child.path);
        if (view) view.entry = child;
      }
      node.dataset.path = child.path;
      node.dataset.type = child.type;
      next.push(node);
    }
    children.replaceChildren(...next);
    // Rows were rebuilt: apply the filter first so focus lands on a row that
    // survived it, not on one this refresh hid.
    this.applyFilter();
    this.restoreFocus();
  }

  private makeFileRow(entry: ExplorerEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "explorer-row file";
    row.dataset.path = entry.path;
    row.dataset.relPath = normalizeRelPath(entry.relPath);
    row.dataset.type = entry.type;
    row.dataset.name = entry.name;
    if (this.isChanged(entry)) row.classList.add("changed");
    applyRowA11y(row, entry);
    const icon = makeFileIcon(entry.name);
    icon.setAttribute("aria-hidden", "true");
    const name = makeNameEl(entry.name);
    row.append(icon, name, makeChangeMark());
    this.rowEntry.set(row, entry);
    if (this.selected?.path === entry.path) this.select(entry, row);
    row.addEventListener("click", () => {
      this.select(entry, row);
      this.markFocus(row);
      this.onOpenFile(entry.path, true);
    });
    row.addEventListener("dblclick", () => {
      this.select(entry, row);
      this.markFocus(row);
      this.onOpenFile(entry.path, false);
    });
    this.bindRowMenu(row, entry);
    this.setupDragSource(row, entry);
    // Dropping onto a file moves alongside it (into its parent folder).
    this.setupFileDrop(row, entry);
    return row;
  }

  private bindRowMenu(row: HTMLElement, entry: ExplorerEntry): void {
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.select(entry, row);
      showContextMenu(this.entryMenuItems(entry), e.clientX, e.clientY);
    });
  }

  // ------------------------------------------------------------ drag-drop --

  /** The root never moves; every other row is a drag source. */
  private setupDragSource(row: HTMLElement, entry: ExplorerEntry): void {
    if (!entry.relPath) return;
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      closeContextMenu();
      this.dragSrc = entry;
      try {
        e.dataTransfer?.setData("text/plain", entry.relPath);
      } catch {
        /* some browsers throw when no data; validity uses dragSrc */
      }
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      this.dragSrc = null;
      row.classList.remove("dragging");
      this.clearDropHighlight();
    });
  }

  /** A folder row (plus its children block, so empty folders accept drops). */
  private setupDirDrop(
    row: HTMLElement,
    children: HTMLElement,
    entry: ExplorerEntry,
    state: DirState,
  ): void {
    const target = entry.relPath;
    const over = (e: DragEvent) => {
      if (!this.canDrop(target)) return;
      // Invalid inner targets return early WITHOUT stopping propagation,
      // so an outer folder can still accept the drop. A valid inner target
      // claims the event so ancestors don't highlight alongside it.
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      row.classList.add("drop-target");
      // Hovering a collapsed folder mid-drag expands it, like VS Code.
      if (!state.expanded && !this.expandTimer) {
        this.expandTimer = setTimeout(() => {
          this.expandTimer = null;
          if (!this.dragSrc || state.expanded) return;
          // Same toggle owner as click/keyboard: keeps the chevron and
          // aria-expanded in step with the state.
          void this.setDirExpanded(entry.path, true);
        }, 600);
      }
    };
    const leave = (e: DragEvent) => {
      // dragover/leaves fire between row and children; keep the highlight
      // while the pointer is still inside either one.
      const to = e.relatedTarget as Node | null;
      if (to && (row.contains(to) || children.contains(to))) return;
      row.classList.remove("drop-target");
      this.clearExpandTimer();
    };
    const drop = (e: DragEvent) => {
      if (!this.canDrop(target)) return;
      e.preventDefault();
      e.stopPropagation();
      const src = this.dragSrc;
      this.dragSrc = null;
      row.classList.remove("drop-target");
      this.clearExpandTimer();
      // Pre-expand a collapsed target: the post-move refresh rebuilds the
      // tree (detaching these nodes), so expansion must live in dir state,
      // which survives refresh and renders the moved entry visible.
      if (src) {
        void this.setDirExpanded(entry.path, true);
        void this.moveDragged(src, target);
      }
    };
    row.addEventListener("dragover", over);
    row.addEventListener("dragenter", over);
    row.addEventListener("dragleave", leave);
    row.addEventListener("drop", drop);
    children.addEventListener("dragover", over);
    children.addEventListener("dragenter", over);
    children.addEventListener("dragleave", leave);
    children.addEventListener("drop", drop);
  }

  private setupFileDrop(row: HTMLElement, entry: ExplorerEntry): void {
    const target = parentRel(entry.relPath);
    row.addEventListener("dragover", (e) => {
      if (!this.canDrop(target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      row.classList.add("drop-target");
    });
    row.addEventListener("dragenter", (e) => {
      if (!this.canDrop(target)) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && row.contains(to)) return;
      row.classList.remove("drop-target");
    });
    row.addEventListener("drop", (e) => {
      if (!this.canDrop(target)) return;
      e.preventDefault();
      e.stopPropagation();
      const src = this.dragSrc;
      this.dragSrc = null;
      row.classList.remove("drop-target");
      if (src) void this.moveDragged(src, target);
    });
  }

  /** False for no-ops the backend would turn into " copy" duplicates. */
  private canDrop(targetDirRel: string): boolean {
    const src = this.dragSrc;
    if (!src || !src.relPath) return false;
    if (targetDirRel === parentRel(src.relPath)) return false;
    if (src.type === "dir" && (targetDirRel === src.relPath || targetDirRel.startsWith(`${src.relPath}/`))) return false;
    return true;
  }

  private clearExpandTimer(): void {
    if (this.expandTimer) {
      clearTimeout(this.expandTimer);
      this.expandTimer = null;
    }
  }

  private clearDropHighlight(): void {
    this.clearExpandTimer();
    for (const r of this.treeEl.querySelectorAll(".explorer-row.drop-target")) {
      r.classList.remove("drop-target");
    }
  }

  /** Drag-drop is a cut + paste move; collisions keep the backend suffix. */
  private async moveDragged(src: ExplorerEntry, targetDirRel: string): Promise<boolean> {
    const projectId = this.projectId;
    if (!projectId) return false;
    const res = await window.termina.pasteEntry(projectId, targetDirRel, src.relPath, true);
    if (!res.ok) {
      toast(res.error ?? "move failed", "error");
      return false;
    }
    await this.refresh();
    return true;
  }

  /** Highlight the selected row; keeps it as the rename/delete target. */
  private select(entry: ExplorerEntry, row: HTMLElement): void {
    this.selected = entry;
    const previous = this.selectedRow;
    if (previous && previous !== row) {
      previous.classList.remove("selected");
      previous.setAttribute("aria-selected", "false");
    }
    row.classList.add("selected");
    row.setAttribute("aria-selected", "true");
    this.selectedRow = row;
  }

  private withSelected(run: (entry: ExplorerEntry) => void): void {
    if (this.selected) run(this.selected);
    else toast("Select a file or folder in the explorer first", "warning");
  }

  private rootMenuItems(): ContextMenuItem[] {
    return [
      { label: "New File", action: () => void this.createAt("", "file") },
      { label: "New Folder", action: () => void this.createAt("", "dir") },
      { separator: true },
      { label: "Paste", disabled: this.clipboardEntry === null, action: () => void this.pasteAt("") },
      { separator: true },
      { label: "Refresh", action: () => void this.refresh() },
      { label: "Copy Path", action: () => this.copyPath(this.projectCwd ?? "") },
    ];
  }

  private entryMenuItems(entry: ExplorerEntry): ContextMenuItem[] {
    const pasteTarget = targetDirRel(entry);
    const items: ContextMenuItem[] = [];
    if (entry.type === "file") {
      items.push({ label: "Open", action: () => this.onOpenFile(entry.path, false) });
    } else {
      items.push(
        { label: "New File", action: () => void this.createAt(targetDirRel(entry), "file") },
        { label: "New Folder", action: () => void this.createAt(targetDirRel(entry), "dir") },
        { separator: true },
      );
    }
    items.push(
      { label: "Cut", action: () => this.cutEntry(entry) },
      { label: "Copy", action: () => this.copyEntry(entry) },
      { label: "Paste", disabled: this.clipboardEntry === null, action: () => void this.pasteAt(pasteTarget) },
    );
    if (entry.type === "file") items.push({ separator: true });
    items.push(
      { label: "Copy Path", action: () => this.copyPath(entry.path) },
      { label: "Copy Relative Path", action: () => this.copyPath(entry.relPath) },
      { separator: true },
      { label: "Rename", action: () => void this.renameAt(entry) },
      { label: "Delete", action: () => void this.deleteAt(entry) },
    );
    if (entry.type === "dir") items.push({ label: "Refresh", action: () => void this.refresh() });
    return items;
  }

  // -------------------------------------------------------------- actions --

  private cutEntry(entry: ExplorerEntry): void {
    this.clipboardEntry = { relPath: entry.relPath, cut: true };
    toast(`Cut ${entry.relPath || entry.name} — paste to move`, "info");
  }

  private copyEntry(entry: ExplorerEntry): void {
    this.clipboardEntry = { relPath: entry.relPath, cut: false };
    toast(`Copied ${entry.relPath || entry.name} — paste to duplicate`, "info");
  }

  /** Paste the clipboard entry under targetDir ("" is the project root). */
  private async pasteAt(targetDirRel: string): Promise<void> {
    const clip = this.clipboardEntry;
    const projectId = this.projectId;
    if (!clip || !projectId) return;
    const res = await window.termina.pasteEntry(projectId, targetDirRel, clip.relPath, clip.cut);
    if (!res.ok) {
      toast(res.error ?? "paste failed", "error");
      return;
    }
    if (clip.cut) this.clipboardEntry = null; // a move pastes exactly once
    toast(`Pasted as ${res.name ?? "entry"}`, "info");
    await this.refresh();
  }

  private copyPath(path: string): void {
    copyText(path, "Path copied");
  }

  private toastIfFailed(res: { ok: boolean; error?: string }): void {
    if (!res.ok) toast(res.error ?? "failed", "error");
  }

  private async createAt(parentRel: string, kind: "file" | "dir"): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;
    const name = await showInput(kind === "file" ? "New file" : "New folder", "name", "");
    if (name.cancelled || !name.value?.trim()) return;
    const rel = parentRel ? `${parentRel}/${name.value.trim()}` : name.value.trim();
    this.toastIfFailed(await window.termina.createEntry(projectId, rel, kind));
    // Expand the target folder BEFORE refreshing, so an entry created in a
    // collapsed folder is revealed by the reload instead of staying hidden.
    await this.revealDirRel(parentRel);
    await this.refresh();
  }

  /**
   * Expand the folder at a project-relative path when it is already mounted.
   * A new EMPTY folder fires no watcher file event, so opening its target is
   * what makes the result visible.
   */
  private async revealDirRel(rel: string): Promise<void> {
    if (!rel) return;
    const mounted = this.mountedDirView(rel);
    if (mounted) await this.setDirExpanded(mounted.absPath, true);
  }

  private async renameAt(entry: ExplorerEntry): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;
    const res = await showInput("Rename", "new name", entry.name);
    if (res.cancelled || !res.value?.trim() || res.value.trim() === entry.name) return;
    this.toastIfFailed(await window.termina.renameEntry(projectId, entry.relPath, res.value.trim()));
    // Renames produce watcher delete+create events; refresh covers it.
    await this.refresh();
  }

  private async deleteAt(entry: ExplorerEntry): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;
    const ok = await showConfirm("Delete", deleteConfirmMessage(entry));
    if (!ok.confirmed) return;
    this.toastIfFailed(await window.termina.deleteEntry(projectId, entry.relPath));
    // The watcher fires file:deleted, which closes any open editor tab.
    await this.refresh();
  }
}

/** Parent folder of a project-relative path; "" is the project root. */
function parentRel(relPath: string): string {
  const at = relPath.lastIndexOf("/");
  return at === -1 ? "" : relPath.slice(0, at);
}

/** Parent directory for watcher paths, preserving the platform separator. */
function parentPath(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash <= 0) return path.slice(0, Math.max(1, slash));
  // Keep the separator after a Windows drive letter: `C:\\file` belongs to
  // `C:\\`, whereas slicing at the separator would produce `C:`.
  if (slash === 2 && path[1] === ":") return path.slice(0, 3);
  return path.slice(0, slash);
}
