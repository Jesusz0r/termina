/**
 * Explorer tree refresh and directory state.
 *
 * Owns the disk-change debounce, refresh orchestration, root rendering, and
 * expansion-state bookkeeping. The Explorer owns rows and user operations;
 * this collaborator reloads branches through a narrow host. Split from
 * components/explorer.ts (issue #38) with no behavior change.
 */
import { isPathDescendant, parentPath } from "../explorer-file";
import { canonicalizePath } from "../../shared/canonical-path";
import { pathBasename } from "../../shared/types";
import { toast } from "./modals";
import type { ExplorerEntry } from "../../shared/types";
import type { DirState, DirView } from "./explorer-rows";

/** Narrow Explorer surface the refresh collaborator drives. */
interface ExplorerRefreshHost {
  treeEl: HTMLElement;
  projectCwd(): string | null;
  dirs: Map<string, DirState>;
  dirViews: Map<string, DirView>;
  renderChildren(children: HTMLElement, entry: ExplorerEntry, state: DirState, force?: boolean): Promise<void>;
  makeDirRow(entry: ExplorerEntry, forceOpen?: boolean): HTMLElement;
  applyFilter(): void;
  restoreFocus(): void;
}

export class ExplorerRefresh {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingChanges = new Set<string>();

  constructor(private host: ExplorerRefreshHost) {}

  /** Project root in the same form main already pushes (macOS aliases). */
  private projectRoot(): string | null {
    const cwd = this.host.projectCwd();
    return cwd === null ? null : canonicalizePath(cwd);
  }

  /** Drop pending disk-change work (project switch tears the tree down). */
  reset(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.pendingChanges.clear();
  }
  /** A file/dir changed on disk (watcher events) — refresh lazily. */
  handleDiskChange(path?: string): void {
    if (path) this.pendingChanges.add(canonicalizePath(path));
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const changes = [...this.pendingChanges];
      this.pendingChanges.clear();
      void this.refresh(changes);
    }, 250);
  }

  async refresh(changedPaths?: string[]): Promise<void> {
    const cwd = this.projectRoot();
    if (!cwd) return;
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
    for (const raw of changedPaths) {
      const live = this.projectRoot();
      if (!raw || !live) continue;
      const path = canonicalizePath(raw);
      let directory: string = path === live ? path : parentPath(path);
      // If an ancestor is collapsed, its descendants are not mounted. Mark
      // the nearest mounted ancestor stale so the branch reloads on expand.
      while (!this.host.dirViews.has(directory) && directory !== live) {
        const parent = parentPath(directory);
        if (parent === directory) break;
        directory = parent;
      }
      directories.add(directory);
    }
    for (const path of directories) {
      const view = this.host.dirViews.get(path);
      if (!view) continue;
      if (view.state.expanded) await this.host.renderChildren(view.children, view.entry, view.state, true);
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
  async reloadMountedBranches(): Promise<void> {
    for (const path of [...this.host.dirViews.keys()]) {
      const view = this.host.dirViews.get(path);
      // The map mutates while reloading (nodes are added and forgotten).
      if (!view) continue;
      // The root is rendered by renderRoot.
      if (view.entry.relPath === "") continue;
      if (view.state.expanded) await this.host.renderChildren(view.children, view.entry, view.state, true);
      else view.state.loaded = false;
    }
    this.host.restoreFocus();
  }

  // -------------------------------------------------------------- filter --

  async renderRoot(forceReload = false): Promise<void> {
    const cwd = this.projectRoot();
    if (!cwd) {
      this.host.dirViews.clear();
      this.host.treeEl.replaceChildren();
      // No tree to describe while there is no project; the action stands alone.
      this.host.treeEl.removeAttribute("role");
      this.host.treeEl.removeAttribute("aria-label");
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "explorer-empty";
      empty.textContent = "Open folder";
      empty.addEventListener("click", () => {
        void window.termina.projectOpen().catch((err) => {
          toast(`could not open a project: ${(err as Error).message}`, "warning");
        });
      });
      this.host.treeEl.appendChild(empty);
      return;
    }
    // A real tree: screen readers get the structure and the label.
    this.host.treeEl.setAttribute("role", "tree");
    this.host.treeEl.setAttribute("aria-label", "Project files");
    const name = pathBasename(cwd);
    const existing = this.host.dirViews.get(cwd);
    const node = existing?.node ?? this.host.makeDirRow({ name, path: cwd, relPath: "", type: "dir" }, true);
    if (!node.parentElement) this.host.treeEl.replaceChildren(node);
    const view = this.host.dirViews.get(cwd);
    if (view?.state.expanded && (forceReload || !view.state.loaded)) {
      await this.host.renderChildren(view.children, view.entry, view.state, forceReload);
    }
    this.host.applyFilter();
    this.host.restoreFocus();
  }

  dirState(absPath: string): DirState {
    const key = canonicalizePath(absPath);
    let state = this.host.dirs.get(key);
    if (!state) {
      state = { expanded: false, loaded: false, loadSeq: 0 };
      this.host.dirs.set(key, state);
    }
    return state;
  }

  /** A collapsed branch no longer needs expansion state for hidden descendants. */
  pruneCollapsedDescendants(absPath: string): void {
    const ancestor = canonicalizePath(absPath);
    for (const path of this.host.dirs.keys()) {
      if (isPathDescendant(path, ancestor)) {
        this.host.dirs.delete(path);
        this.host.dirViews.delete(path);
      }
    }
  }

  /** Drop expansion state for the mounted descendants of a collapsed branch. */
  forgetMountedDescendants(children: HTMLElement): void {
    const parent = children.parentElement?.dataset.path;
    if (parent) this.pruneCollapsedDescendants(parent);
  }

  /** Drop state for a directory that disappeared from its parent's listing. */
  forgetDirectory(absPath: string): void {
    const key = canonicalizePath(absPath);
    this.host.dirs.delete(key);
    this.host.dirViews.delete(key);
    this.pruneCollapsedDescendants(key);
  }
}
