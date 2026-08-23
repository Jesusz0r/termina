/**
 * File explorer: shows the project folder tree, opens files in the
 * project editor, and supports create / rename / delete of files and folders.
 * Directories load lazily on expand; the tree refreshes from watcher events.
 */
import { pathBasename, type CommandId, type ExplorerEntry } from "../../shared/types";
import { showContextMenu, closeContextMenu, type ContextMenuItem } from "./context-menu";
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
  /** The explorer clipboard: the entry waiting for a Paste. */
  private clip: { relPath: string; cut: boolean } | null = null;

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
    // Clipboard entries are project-relative: they never survive a switch.
    this.clip = null;
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
      showContextMenu(this.entryMenuItems(entry), e.clientX, e.clientY);
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
      showContextMenu(this.entryMenuItems(entry), e.clientX, e.clientY);
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

  private rootMenuItems(): ContextMenuItem[] {
    return [
      { label: "New File", action: () => void this.createAt("", "file") },
      { label: "New Folder", action: () => void this.createAt("", "dir") },
      { separator: true },
      { label: "Paste", disabled: this.clip === null, action: () => void this.pasteAt("") },
      { separator: true },
      { label: "Refresh", action: () => void this.refresh() },
      { label: "Copy Path", action: () => this.copyPath(this.projectCwd ?? "") },
    ];
  }

  private entryMenuItems(entry: ExplorerEntry): ContextMenuItem[] {
    const pasteTarget = entry.type === "dir" ? entry.relPath : dirnameRel(entry.relPath);
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
      { label: "Paste", disabled: this.clip === null, action: () => void this.pasteAt(pasteTarget) },
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
    this.clip = { relPath: entry.relPath, cut: true };
    toast(`Cut ${entry.relPath || entry.name} — paste to move`, "info");
  }

  private copyEntry(entry: ExplorerEntry): void {
    this.clip = { relPath: entry.relPath, cut: false };
    toast(`Copied ${entry.relPath || entry.name} — paste to duplicate`, "info");
  }

  /** Paste the clipboard entry under targetDir ("" is the project root). */
  private async pasteAt(targetDirRel: string): Promise<void> {
    const clip = this.clip;
    if (!clip) return;
    const res = await window.pi.pasteEntry(targetDirRel, clip.relPath, clip.cut);
    if (!res.ok) {
      toast(res.error ?? "paste failed", "error");
      return;
    }
    if (clip.cut) this.clip = null; // a move pastes exactly once
    toast(`Pasted as ${res.name ?? "entry"}`, "info");
    await this.refresh();
  }

  private copyPath(path: string): void {
    navigator.clipboard.writeText(path)
      .then(() => toast("Path copied", "info"))
      .catch(() => toast("could not copy the path", "error"));
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

/** The parent directory of a relative path; "" when top-level. */
function dirnameRel(relPath: string): string {
  const at = relPath.lastIndexOf("/");
  return at === -1 ? "" : relPath.slice(0, at);
}
