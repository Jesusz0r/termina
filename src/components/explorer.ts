/**
 * File explorer: shows the project folder tree, opens files in the
 * project editor, and supports create / rename / delete of files and folders.
 * Directories load lazily on expand; the tree refreshes from watcher events.
 * Entries drag onto folders to move (cut + paste); the move itself reuses
 * the explorer:paste backend, so no new IPC exists for drag-drop.
 */
import { pathBasename, type CommandId, type ExplorerEntry } from "../../shared/types";
import { showContextMenu, closeContextMenu, type ContextMenuItem } from "./context-menu";
import { copyText, showConfirm, showInput, toast } from "./modals";

interface DirState {
  expanded: boolean;
  loaded: boolean;
  /** Bumped per list. A slow listing never fills a newer expand. */
  loadSeq: number;
}

export class Explorer {
  private treeEl: HTMLElement;
  private dirs = new Map<string, DirState>(); // keyed by abs path
  private projectId: string | null = null;
  private projectCwd: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private selected: ExplorerEntry | null = null;
  /** Project-relative entry waiting for Paste. */
  private clipboardEntry: { relPath: string; cut: boolean } | null = null;
  /** Entry being dragged; null outside a drag. Drop validity reads this. */
  private dragSrc: ExplorerEntry | null = null;
  /** Pending auto-expand of a collapsed folder hovered mid-drag. */
  private expandTimer: ReturnType<typeof setTimeout> | null = null;

  private onOpenFile: (absPath: string, preview?: boolean) => void = () => {};

  constructor(container: HTMLElement) {
    this.treeEl = container.querySelector("#explorer-tree") as HTMLElement;
    this.treeEl.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".explorer-row")) return;
      e.preventDefault();
      if (!this.projectCwd) return;
      showContextMenu(this.rootMenuItems(), e.clientX, e.clientY);
    });
    void this.renderRoot();
  }

  bind(handlers: { onOpenFile: (absPath: string, preview?: boolean) => void }): void {
    this.onOpenFile = handlers.onOpenFile;
  }

  /** File-menu commands (File → New File / New Folder / Rename / Delete…). */
  handleCommand(command: CommandId): void {
    switch (command) {
      case "new-file":
        void this.createAt("", "file");
        break;
      case "new-folder":
        void this.createAt("", "dir");
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

  /** Called when the project folder changes. Null clears the tree. */
  setProject(projectId: string | null, cwd: string | null): void {
    this.projectId = projectId;
    this.projectCwd = cwd;
    this.dirs.clear();
    this.selected = null;
    // Clipboard entries are project-relative: they never survive a switch.
    this.clipboardEntry = null;
    this.dragSrc = null;
    this.clearExpandTimer();
    closeContextMenu();
    void this.renderRoot();
  }

  /** A file/dir changed on disk (watcher events) — refresh lazily. */
  handleDiskChange(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 250);
  }

  async refresh(): Promise<void> {
    if (this.projectCwd) await this.renderRoot();
  }

  // ------------------------------------------------------------- rendering --

  private async renderRoot(): Promise<void> {
    const cwd = this.projectCwd;
    this.treeEl.replaceChildren();
    if (!cwd) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "explorer-empty";
      empty.textContent = "Open folder";
      empty.addEventListener("click", () => void window.pi.projectOpen());
      this.treeEl.appendChild(empty);
      return;
    }
    const name = pathBasename(cwd);
    const node = this.makeDirRow({ name, path: cwd, relPath: "", type: "dir" }, true);
    this.treeEl.appendChild(node);
  }

  private dirState(absPath: string): DirState {
    let state = this.dirs.get(absPath);
    if (!state) {
      state = { expanded: false, loaded: false, loadSeq: 0 };
      this.dirs.set(absPath, state);
    }
    return state;
  }

  private makeDirRow(entry: ExplorerEntry, forceOpen = false): HTMLElement {
    const state = this.dirState(entry.path);
    if (forceOpen) {
      state.expanded = true;
      state.loaded = false; // root always re-lists
    }

    // VS Code style: a node is a row, with the children indented BELOW it.
    const node = document.createElement("div");
    node.className = "explorer-node";

    const row = document.createElement("div");
    row.className = "explorer-row dir";
    row.dataset.path = entry.path;

    const arrow = document.createElement("span");
    arrow.className = "explorer-arrow";
    arrow.textContent = state.expanded ? "▾" : "▸";

    const icon = document.createElement("span");
    icon.className = "explorer-icon dir-icon";

    const name = document.createElement("span");
    name.className = "explorer-name";
    name.textContent = entry.name || entry.path;

    row.append(arrow, icon, name);
    row.addEventListener("click", () => {
      this.select(entry, row);
      state.expanded = !state.expanded;
      arrow.textContent = state.expanded ? "▾" : "▸";
      void this.renderChildren(children, entry, state);
    });
    this.bindRowMenu(row, entry);
    this.setupDragSource(row, entry);

    const children = document.createElement("div");
    children.className = "explorer-children";
    node.append(row, children);
    this.setupDirDrop(row, children, entry, state, arrow);
    if (state.expanded) {
      void this.renderChildren(children, entry, state);
    }
    return node;
  }

  private async renderChildren(children: HTMLElement, entry: ExplorerEntry, state: DirState): Promise<void> {
    if (!state.expanded) {
      children.replaceChildren();
      return;
    }
    const seq = ++state.loadSeq;
    children.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "explorer-empty";
    loading.textContent = "loading…";
    children.appendChild(loading);
    const projectId = this.projectId;
    if (!projectId) return;
    let res: { entries: ExplorerEntry[]; error?: string; truncated?: boolean };
    try {
      res = await window.pi.listDir(projectId, entry.path);
    } catch (err) {
      if (!state.expanded || seq !== state.loadSeq) return;
      children.replaceChildren();
      toast(`could not list ${entry.name}: ${(err as Error).message}`, "error");
      return;
    }
    if (!state.expanded || seq !== state.loadSeq || this.projectId !== projectId) return;
    state.loaded = true;
    if (res.error) {
      children.replaceChildren();
      toast(res.error, "error");
      return;
    }
    children.replaceChildren();
    if (res.truncated) {
      const note = document.createElement("div");
      note.className = "explorer-empty";
      note.textContent = "folder truncated (too many entries)";
      children.appendChild(note);
    }
    for (const child of res.entries) {
      const node = child.type === "dir" ? this.makeDirRow(child) : this.makeFileRow(child);
      children.appendChild(node);
    }
  }

  private makeFileRow(entry: ExplorerEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "explorer-row file";
    row.dataset.path = entry.path;
    const icon = document.createElement("span");
    icon.className = "explorer-icon file-icon";
    const name = document.createElement("span");
    name.className = "explorer-name";
    name.textContent = entry.name;
    row.append(icon, name);
    row.addEventListener("click", () => {
      this.select(entry, row);
      this.onOpenFile(entry.path, true);
    });
    row.addEventListener("dblclick", () => {
      this.select(entry, row);
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
    arrow: HTMLElement,
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
          state.expanded = true;
          arrow.textContent = "▾";
          void this.renderChildren(children, entry, state);
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
        state.expanded = true;
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
    const res = await window.pi.pasteEntry(projectId, targetDirRel, src.relPath, true);
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
    for (const r of this.treeEl.querySelectorAll(".explorer-row.selected")) {
      r.classList.remove("selected");
    }
    row.classList.add("selected");
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
    const pasteTarget = pasteTargetRel(entry);
    const items: ContextMenuItem[] = [];
    if (entry.type === "file") {
      items.push({ label: "Open", action: () => this.onOpenFile(entry.path, false) });
    } else {
      items.push(
        { label: "New File", action: () => void this.createAt(entry.relPath, "file") },
        { label: "New Folder", action: () => void this.createAt(entry.relPath, "dir") },
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
    const res = await window.pi.pasteEntry(projectId, targetDirRel, clip.relPath, clip.cut);
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
    this.toastIfFailed(await window.pi.createEntry(projectId, rel, kind));
    await this.refresh();
  }

  private async renameAt(entry: ExplorerEntry): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;
    const res = await showInput("Rename", "new name", entry.name);
    if (res.cancelled || !res.value?.trim() || res.value.trim() === entry.name) return;
    this.toastIfFailed(await window.pi.renameEntry(projectId, entry.relPath, res.value.trim()));
    // Renames produce watcher delete+create events; refresh covers it.
    await this.refresh();
  }

  private async deleteAt(entry: ExplorerEntry): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;
    const ok = await showConfirm("Delete", `Delete "${entry.relPath || entry.name}"?`);
    if (!ok.confirmed) return;
    this.toastIfFailed(await window.pi.deleteEntry(projectId, entry.relPath));
    // The watcher fires file:deleted, which closes any open editor tab.
    await this.refresh();
  }
}

/** Folder that receives Paste for this row. Files paste into their parent. */
function pasteTargetRel(entry: ExplorerEntry): string {
  if (entry.type === "dir") return entry.relPath;
  return parentRel(entry.relPath);
}

/** Parent folder of a project-relative path; "" is the project root. */
function parentRel(relPath: string): string {
  const at = relPath.lastIndexOf("/");
  return at === -1 ? "" : relPath.slice(0, at);
}
