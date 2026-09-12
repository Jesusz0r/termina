/**
 * File explorer: shows the project folder tree, opens files in the
 * project editor, and supports create / rename / delete of files and folders.
 * Directories load lazily on expand; the tree refreshes from watcher events.
 * Entries drag onto folders to move (cut + paste); the move itself reuses
 * the explorer:paste backend, so no new IPC exists for drag-drop.
 */
import { type CommandId, type ContentHit, type ExplorerEntry } from "../../shared/types";
import {
  ancestorDirs,
  canDropEntry,
  computeChangedSets,
  deleteConfirmMessage,
  isMarkedChanged,
  normalizeRelPath,
  parentRel,
  targetDirRel,
} from "../explorer-file";
import { showContextMenu, closeContextMenu, type ContextMenuItem } from "./context-menu";
import { copyText, showConfirm, showInput, toast } from "./modals";
import { ExplorerContent } from "./explorer-content";
import { ExplorerFilter } from "./explorer-filter";
import { ExplorerKeyboard } from "./explorer-keyboard";
import { ExplorerRefresh } from "./explorer-refresh";
import {
  applyRowA11y,
  makeChangeMark,
  makeFileIcon,
  makeNameEl,
  makeNote,
  type DirState,
  type DirView,
} from "./explorer-rows";





export class Explorer {
  private treeEl: HTMLElement;
  private dirs = new Map<string, DirState>(); // keyed by abs path
  /** Mounted directory nodes, so watcher refreshes can target one branch. */
  private dirViews = new Map<string, DirView>();
  private projectId: string | null = null;
  private projectCwd: string | null = null;
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
  private filterInput: HTMLInputElement | null = null;
  /** The entry behind each row, so keyboard actions act on the same object the
   *  mouse does. Keyed by element so a rebuilt row never inherits a stale one. */
  private readonly rowEntry = new WeakMap<HTMLElement, ExplorerEntry>();
  /** The row currently painted as selected, so `select` clears exactly one. */
  private selectedRow: HTMLElement | null = null;
  private keyboard!: ExplorerKeyboard;
  private filter!: ExplorerFilter;
  private tree!: ExplorerRefresh;
  private content!: ExplorerContent;

  constructor(container: HTMLElement) {
    this.treeEl = container.querySelector("#explorer-tree") as HTMLElement;
    this.filterInput = container.querySelector<HTMLInputElement>("#explorer-filter-input");
    this.filterInput?.addEventListener("input", () => this.filter.setFilter(this.filterInput?.value ?? ""));
    this.filterInput?.addEventListener("keydown", (e) => {
      // Escape clears the filter and hands focus back to the tree, so the
      // arrow keys keep working without a mouse trip.
      if (e.key === "Escape" && this.filterInput?.value) {
        e.preventDefault();
        this.filterInput.value = "";
        this.filter.setFilter("");
        this.keyboard.restoreFocus();
        return;
      }
      // Down/Up leave the box for the tree, matching the filter-then-navigate flow.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const row = this.keyboard.currentRow(this.keyboard.visibleRows());
        if (!row) return;
        e.preventDefault();
        this.keyboard.focusRow(row);
      }
    });
    this.treeEl.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".explorer-row")) return;
      e.preventDefault();
      if (!this.projectCwd) return;
      showContextMenu(this.rootMenuItems(), e.clientX, e.clientY);
    });
    this.keyboard = new ExplorerKeyboard({
      treeEl: this.treeEl,
      rowEntry: this.rowEntry,
      dirViews: this.dirViews,
      select: (entry, row) => this.select(entry, row),
      invalidateDisconnectedSelection: () => {
        if (this.selectedRow && !this.selectedRow.isConnected) {
          this.selected = null;
          this.selectedRow = null;
        }
      },
      setDirExpanded: (absPath, expanded) => this.setDirExpanded(absPath, expanded),
      deleteAt: (entry) => this.deleteAt(entry),
      renameAt: (entry) => this.renameAt(entry),
      openFile: (absPath, preview) => this.onOpenFile(absPath, preview),
    });
    this.filter = new ExplorerFilter({
      treeEl: this.treeEl,
      filterInput: this.filterInput,
      projectCwd: () => this.projectCwd,
      expandToMatches: (matches) => this.expandToMatches(matches),
      restoreFocus: () => this.keyboard.restoreFocus(),
    });
    this.tree = new ExplorerRefresh({
      treeEl: this.treeEl,
      projectCwd: () => this.projectCwd,
      dirs: this.dirs,
      dirViews: this.dirViews,
      renderChildren: (children, entry, state, force) => this.renderChildren(children, entry, state, force),
      makeDirRow: (entry, forceOpen) => this.makeDirRow(entry, forceOpen),
      applyFilter: () => this.filter.applyFilter(),
      restoreFocus: () => this.keyboard.restoreFocus(),
    });
    this.treeEl.addEventListener("keydown", (e) => this.keyboard.onKeyDown(e));
    // Focus can leave the tree (Tab away); keep the roving row in sync so
    // returning to the tree resumes where the user was.
    this.treeEl.addEventListener("focusout", () => this.keyboard.storeFocusedRow());
    this.content = new ExplorerContent(container, {
      onContentHit: (relPath, line, column) => this.onContentHit(relPath, line, column),
    });
    void this.tree.renderRoot();
  }

  // ------------------------------------------------- keyboard + focus --

  async reveal(relPath: string): Promise<void> {
    const rel = normalizeRelPath(relPath);
    if (!rel || !this.projectCwd) return;
    await this.expandToMatches([rel]);
    const row = this.keyboard.rowByRel(rel);
    if (!row) return;
    this.keyboard.markFocus(row);
    const entry = this.rowEntry.get(row);
    if (entry) this.select(entry, row);
    row.scrollIntoView({ block: "nearest" });
  }

  /** A file/dir changed on disk (watcher events) — refresh lazily. */
  handleDiskChange(path?: string): void {
    this.tree.handleDiskChange(path);
  }

  async refresh(changedPaths?: string[]): Promise<void> {
    await this.tree.refresh(changedPaths);
  }

  showContentResults(pattern: string, hits: ContentHit[], truncated: boolean): void {
    this.content.showContentResults(pattern, hits, truncated);
  }

  clearContentResults(): void {
    this.content.clearContentResults();
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
    this.tree.reset();
    this.projectId = projectId;
    this.projectCwd = cwd;
    this.dirs.clear();
    this.dirViews.clear();
    this.selected = null;
    this.selectedRow = null;
    // Clipboard entries are project-relative: they never survive a switch.
    this.clipboardEntry = null;
    this.dragSrc = null;
    // Change marks are project-relative too; main re-pushes them per project.
    this.changedRel = new Set<string>();
    this.changedDirRel = new Set<string>();
    // The filter is project-relative too; clear it rather than carry matches over.
    this.filter.reset();
    if (this.filterInput) this.filterInput.value = "";
    // Keyboard state is project-relative as well.
    this.keyboard.reset();
    this.clearExpandTimer();
    // Content results are project-relative as well.
    this.clearContentResults();
    closeContextMenu();
    void this.tree.renderRoot();
  }

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
    return isMarkedChanged(entry.type, entry.relPath, this.changedRel, this.changedDirRel);
  }

  /** Re-mark every mounted row; toggles a class so the dot's width is fixed. */
  private applyChangeMarks(): void {
    for (const el of this.treeEl.querySelectorAll<HTMLElement>(".explorer-row")) {
      const rel = el.dataset.relPath;
      if (rel === undefined) continue;
      el.classList.toggle("changed", isMarkedChanged(el.dataset.type, rel, this.changedRel, this.changedDirRel));
    }
  }

  private makeDirRow(entry: ExplorerEntry, forceOpen = false): HTMLElement {
    const state = this.tree.dirState(entry.path);
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
      this.keyboard.markFocus(row);
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
      this.tree.forgetMountedDescendants(view.children);
    }
    view.arrow.textContent = expanded ? "▾" : "▸";
    applyRowA11y(view.row, view.entry, expanded);
    await this.renderChildren(view.children, view.entry, view.state);
    // Collapsing may unmount the focused row; fall back to the folder itself.
    this.keyboard.restoreFocus(normalizeRelPath(view.entry.relPath));
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
      if (node.dataset.type === "dir" && !nextDirPaths.has(path)) this.tree.forgetDirectory(path);
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
    this.filter.applyFilter();
    this.keyboard.restoreFocus();
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
      this.keyboard.markFocus(row);
      this.onOpenFile(entry.path, true);
    });
    row.addEventListener("dblclick", () => {
      this.select(entry, row);
      this.keyboard.markFocus(row);
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
    return canDropEntry(this.dragSrc, targetDirRel);
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
