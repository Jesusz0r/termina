/**
 * File explorer: shows the project folder tree, opens files in the
 * project editor, and supports create / rename / delete of files and folders.
 * Directories load lazily on expand; the tree refreshes from watcher events.
 */
import { pathBasename, type ExplorerEntry } from "../../shared/types";
import { showConfirm, showInput, toast } from "./modals";

interface DirState {
  expanded: boolean;
  loaded: boolean;
  /** Bumped per list. A slow listing never fills a newer expand. */
  loadSeq: number;
}

export class Explorer {
  private treeEl: HTMLElement;
  private dirs = new Map<string, DirState>(); // keyed by abs path
  private projectCwd: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private selected: ExplorerEntry | null = null;

  private onOpenFile: (absPath: string, preview?: boolean) => void = () => {};

  constructor(container: HTMLElement) {
    this.treeEl = container.querySelector("#explorer-tree") as HTMLElement;
    void this.renderRoot(); // show the empty state before any project is opened
  }

  bind(handlers: { onOpenFile: (absPath: string, preview?: boolean) => void }): void {
    this.onOpenFile = handlers.onOpenFile;
  }

  /** File-menu commands (File → New File / New Folder / Rename / Delete…). */
  handleCommand(command: "new-file" | "new-folder" | "rename" | "delete" | "refresh"): void {
    switch (command) {
      case "new-file":
        void this.createAt("", "file");
        break;
      case "new-folder":
        void this.createAt("", "dir");
        break;
      case "rename":
        if (this.selected) void this.renameAt(this.selected);
        else toast("Select a file or folder in the explorer first", "warning");
        break;
      case "delete":
        if (this.selected) void this.deleteAt(this.selected);
        else toast("Select a file or folder in the explorer first", "warning");
        break;
      case "refresh":
        void this.refresh();
        break;
    }
  }

  /** Called when the project folder changes. Null clears the tree. */
  setProject(cwd: string | null): void {
    this.projectCwd = cwd;
    this.dirs.clear();
    this.selected = null;
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
    let s = this.dirs.get(absPath);
    if (!s) {
      s = { expanded: false, loaded: false, loadSeq: 0 };
      this.dirs.set(absPath, s);
    }
    return s;
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

    const actions = this.makeActions(entry);

    row.append(arrow, icon, name, actions);
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".explorer-actions")) return;
      this.select(entry, row);
      state.expanded = !state.expanded;
      arrow.textContent = state.expanded ? "▾" : "▸";
      void this.renderChildren(children, entry, state);
    });

    const children = document.createElement("div");
    children.className = "explorer-children";
    node.append(row, children);
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
    let res: { entries: ExplorerEntry[]; error?: string; truncated?: boolean };
    try {
      res = await window.pi.listDir(entry.path);
    } catch (err) {
      if (!state.expanded || seq !== state.loadSeq) return;
      children.replaceChildren();
      toast(`could not list ${entry.name}: ${(err as Error).message}`, "error");
      return;
    }
    if (!state.expanded || seq !== state.loadSeq) return;
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
    const actions = this.makeActions(entry);
    row.append(icon, name, actions);
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".explorer-actions")) return;
      this.select(entry, row);
      this.onOpenFile(entry.path, true); // preview
    });
    row.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".explorer-actions")) return;
      this.select(entry, row);
      this.onOpenFile(entry.path, false); // pin as a permanent tab
    });
    return row;
  }

  /** Highlight the selected row; keeps it as the rename/delete target. */
  private select(entry: ExplorerEntry, row: HTMLElement): void {
    this.selected = entry;
    for (const r of this.treeEl.querySelectorAll(".explorer-row.selected")) {
      r.classList.remove("selected");
    }
    row.classList.add("selected");
  }

  private makeActions(entry: ExplorerEntry): HTMLElement {
    const actions = document.createElement("span");
    actions.className = "explorer-actions";
    if (entry.type === "dir") {
      actions.appendChild(this.actionBtn("+", "New file", () => void this.createAt(entry.relPath, "file")));
      actions.appendChild(this.actionBtn("+/", "New folder", () => void this.createAt(entry.relPath, "dir")));
    }
    actions.appendChild(this.actionBtn("Aa", "Rename", () => void this.renameAt(entry)));
    actions.appendChild(this.actionBtn("×", "Delete", () => void this.deleteAt(entry)));
    return actions;
  }

  private actionBtn(label: string, title: string, onClick: () => void): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "explorer-action";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  // -------------------------------------------------------------- actions --

  private async createAt(parentRel: string, kind: "file" | "dir"): Promise<void> {
    const name = await showInput(kind === "file" ? "New file" : "New folder", "name", "");
    if (name.cancelled || !name.value?.trim()) return;
    const rel = parentRel ? `${parentRel}/${name.value.trim()}` : name.value.trim();
    const res = await window.pi.createEntry(rel, kind);
    if (!res.ok) toast(res.error ?? "failed", "error");
    await this.refresh();
  }

  private async renameAt(entry: ExplorerEntry): Promise<void> {
    const res = await showInput("Rename", "new name", entry.name);
    if (res.cancelled || !res.value?.trim() || res.value.trim() === entry.name) return;
    const r = await window.pi.renameEntry(entry.relPath, res.value.trim());
    if (!r.ok) toast(r.error ?? "failed", "error");
    // Renames produce watcher delete+create events; refresh covers it.
    await this.refresh();
  }

  private async deleteAt(entry: ExplorerEntry): Promise<void> {
    const ok = await showConfirm("Delete", `Delete "${entry.relPath || entry.name}"?`);
    if (!ok.confirmed) return;
    const res = await window.pi.deleteEntry(entry.relPath);
    if (!res.ok) toast(res.error ?? "failed", "error");
    // The watcher fires file:deleted, which closes any open editor tab.
    await this.refresh();
  }
}