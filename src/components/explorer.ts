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
  private menu: HTMLElement | null = null;

  private onOpenFile: (absPath: string, preview?: boolean) => void = () => {};

  constructor(container: HTMLElement) {
    this.treeEl = container.querySelector("#explorer-tree") as HTMLElement;
    this.treeEl.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".explorer-row")) return;
      e.preventDefault();
      if (!this.projectCwd) return;
      this.openMenu(e.clientX, e.clientY, this.rootMenuItems());
    });
    window.addEventListener("pointerdown", (e) => {
      if (!this.menu) return;
      if (this.menu.contains(e.target as Node)) return;
      this.closeMenu();
    });
    window.addEventListener("blur", () => this.closeMenu());
    void this.renderRoot();
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

    row.append(arrow, icon, name);
    row.addEventListener("click", () => {
      this.select(entry, row);
      state.expanded = !state.expanded;
      arrow.textContent = state.expanded ? "▾" : "▸";
      void this.renderChildren(children, entry, state);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.select(entry, row);
      this.openMenu(e.clientX, e.clientY, this.entryMenuItems(entry));
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
    row.append(icon, name);
    row.addEventListener("click", () => {
      this.select(entry, row);
      this.onOpenFile(entry.path, true);
    });
    row.addEventListener("dblclick", () => {
      this.select(entry, row);
      this.onOpenFile(entry.path, false);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.select(entry, row);
      this.openMenu(e.clientX, e.clientY, this.entryMenuItems(entry));
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

  private rootMenuItems(): Array<{ label: string; run: () => void }> {
    return [
      { label: "New file", run: () => void this.createAt("", "file") },
      { label: "New folder", run: () => void this.createAt("", "dir") },
      { label: "Refresh", run: () => void this.refresh() },
    ];
  }

  private entryMenuItems(entry: ExplorerEntry): Array<{ label: string; run: () => void }> {
    const items: Array<{ label: string; run: () => void }> = [];
    if (entry.type === "file") {
      items.push({ label: "Open", run: () => this.onOpenFile(entry.path, false) });
    } else {
      items.push(
        { label: "New file", run: () => void this.createAt(entry.relPath, "file") },
        { label: "New folder", run: () => void this.createAt(entry.relPath, "dir") },
      );
    }
    if (entry.relPath) {
      items.push(
        { label: "Rename", run: () => void this.renameAt(entry) },
        { label: "Delete", run: () => void this.deleteAt(entry) },
      );
    }
    if (entry.type === "dir") items.push({ label: "Refresh", run: () => void this.refresh() });
    return items;
  }

  private openMenu(x: number, y: number, items: Array<{ label: string; run: () => void }>): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "terminal-menu";
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "terminal-menu-item";
      const name = document.createElement("span");
      name.className = "terminal-menu-name";
      name.textContent = item.label;
      row.appendChild(name);
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeMenu();
        item.run();
      });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const pad = 8;
    const left = Math.max(pad, Math.min(x, window.innerWidth - menu.offsetWidth - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - menu.offsetHeight - pad));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    this.menu = menu;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
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