/**
 * Explorer tree filter.
 *
 * Owns filter state and the debounced project-wide search behind it. The
 * Explorer owns the tree data; this collaborator hides rows and expands to
 * matches through a narrow host. Split from components/explorer.ts
 * (issue #38) with no behavior change.
 */
import { filterKeeps, filterVisibleSet } from "../explorer-file";

/** Matches the Quick Open debounce; long enough to skip intermediate keystrokes. */
const FILTER_DEBOUNCE_MS = 150;

/** Narrow Explorer surface the filter collaborator drives. */
export interface ExplorerFilterHost {
  treeEl: HTMLElement;
  filterInput: HTMLInputElement | null;
  projectCwd(): string | null;
  expandToMatches(matches: readonly string[]): Promise<void>;
  restoreFocus(): void;
}

export class ExplorerFilter {
  /** Rows an active filter keeps; null means no filter is active. */
  private filterVisible: Set<string> | null = null;
  /** Debounce for the project-wide search behind the filter. */

  /** Debounce for the project-wide search behind the filter. */
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Persistent content-search listing, fed by the Search Contents modal. */

  /** Truncation note for the active filter ("50+ matches …"); null when complete. */
  private filterTruncatedNote: string | null = null;
  /** Type-ahead buffer and its reset timer (keyboard name search). */

  /** Fences a superseded search: a slow reply never paints over a newer query. */
  private filterSeq = 0;
  /** Truncation note for the active filter ("50+ matches …"); null when complete. */

  constructor(private host: ExplorerFilterHost) {}

  /** Clear the filter and cancel in-flight work (project switch). */
  reset(): void {
    this.filterVisible = null;
    this.filterTruncatedNote = null;
    this.filterSeq++;
    if (this.filterTimer) {
      clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
  }

  /**
   * Apply a filter query to the tree.
   *
   * The match set comes from the existing project-wide file search rather than
   * from the mounted rows: a filter that only saw mounted rows could never find
   * a file inside a collapsed folder, which is most of them. That search is
   * already bounded and cancellable (`searchProjectFiles`).
   */
  setFilter(query: string): void {
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
    if (seq !== this.filterSeq || !this.host.projectCwd()) return;
    // Always a set: an empty one means "this query matched nothing", which is an
    // active filter showing no rows, not an unfiltered tree.
    this.filterVisible = filterVisibleSet(matches);
    this.filterTruncatedNote = truncatedNote;
    await this.host.expandToMatches(matches);
    if (seq !== this.filterSeq) return;
    this.applyFilter();
    // Row visibility changed, so re-seat focus on a row that is still shown.
    this.host.restoreFocus();
  }

  /**
   * Expand the ancestor chain of each match so its row mounts.
   *
   * Ancestors are expanded through the single toggle owner, so the chevron,
   * `aria-expanded` and the children block stay in step. Expansion is left in
   * place when the filter clears: those folders were genuinely opened, and
   * silently collapsing them would undo the user's own expansion.
   */

  /**
   * Hide every row the filter excludes. Rows are hidden rather than unmounted:
   * unmounting would drop `dirViews`/`DirState`, and expansion, selection and
   * change marks all key off state that must survive the filter.
   */
  applyFilter(): void {
    const visible = this.filterVisible;
    for (const row of this.host.treeEl.querySelectorAll<HTMLElement>(".explorer-row")) {
      const rel = row.dataset.relPath;
      // Rows without a relPath (the empty/loading placeholder) are left alone.
      if (rel === undefined) continue;
      row.hidden = visible !== null && !filterKeeps(visible, rel);
    }
    this.host.treeEl.classList.toggle("filtered", visible !== null);
    // Flag a live query that matched nothing, so an empty tree is explained.
    // A truncated query keeps its count in the input's title instead.
    if (this.host.filterInput) {
      this.host.filterInput.classList.toggle("no-matches", visible !== null && visible.size === 0);
      const note = visible !== null ? this.filterTruncatedNote : null;
      this.host.filterInput.classList.toggle("truncated", note !== null);
      this.host.filterInput.title = note ?? "";
    }
  }

  // ------------------------------------------------------------- rendering --
}
