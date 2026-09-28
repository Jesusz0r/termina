/**
 * Quick Open (files), Content Search (grep), and Command Palette (actions) modal.
 * Triggered by View → Quick Open / Search File Contents / Command Palette.
 */
import { COMMAND_DEFINITIONS, QUICK_OPEN_TERMINAL_NOTE, type CommandId } from "../shared/commands";
import type { ContentHit } from "../shared/types";

type QuickOpenMode = "files" | "actions" | "content";

/**
 * Render text with the matched characters wrapped in <mark>, one element per
 * consecutive run. Indices address the full match string; `offset` is where
 * `text` starts inside it (the basename within the relPath).
 */
const CONTENT_HINT = "Type a regular expression to search file contents.";
const CUT_SHORT = "No matches in the files searched. Results were cut short — refine and try again.";

export function contentSearchMessage(error: string): string {
  const text = error.replace(/^error:\s*/i, "");
  if (/unsafe regular expression/i.test(text)) {
    return "Unsafe regular expression. Use one simple repeat and no groups; escape parentheses to search for them.";
  }
  if (/invalid regular expression/i.test(text)) return "Invalid regular expression.";
  if (/pattern length/i.test(text)) return "Pattern must be 1–256 characters.";
  return text;
}

function rangeIndices(offset: number, length: number): number[] | undefined {
  if (length <= 0 || offset < 0) return undefined;
  const indices: number[] = [];
  const end = offset + length;
  for (let i = offset; i < end; i++) indices.push(i);
  return indices;
}

function canRestoreFocus(value: unknown): value is { focus(): void; isConnected: boolean } {
  if (!value || typeof value !== "object") return false;
  const el = value as { focus?: unknown; isConnected?: unknown };
  return typeof el.focus === "function" && typeof el.isConnected === "boolean";
}

function paintMatches(el: HTMLElement, text: string, indices: readonly number[] | undefined, offset: number): void {
  if (!indices || indices.length === 0) {
    el.textContent = text;
    return;
  }
  const hits = new Set<number>();
  for (const i of indices) {
    const local = i - offset;
    if (local >= 0 && local < text.length) hits.add(local);
  }
  if (hits.size === 0) {
    el.textContent = text;
    return;
  }
  let plain = "";
  let run = "";
  const flush = (): void => {
    if (plain) {
      el.appendChild(document.createTextNode(plain));
      plain = "";
    }
    if (run) {
      const mark = document.createElement("mark");
      mark.textContent = run;
      el.appendChild(mark);
      run = "";
    }
  };
  for (let i = 0; i < text.length; i++) {
    if (hits.has(i)) run += text[i];
    else {
      if (run) flush();
      plain += text[i];
    }
  }
  flush();
}

/**
 * Palette row detail: `category · shortcut`, with the terminal split
 * appended for Quick Open (its chord cycles models in a core terminal).
 * Pure so the split copy stays unit-testable without a modal.
 */
export function paletteRowDetail(command: CommandId, category: string, shortcut: string): string {
  const base = shortcut ? `${category} · ${shortcut}` : category;
  return command === "quick-open" ? `${base} · ${QUICK_OPEN_TERMINAL_NOTE}` : base;
}

const QUICK_OPEN_RESULTS_ID = "quick-open-results";

function optionId(index: number): string {
  return `quick-open-opt-${index}`;
}

export class QuickOpen {
  private root: HTMLElement | null = null;
  private modalEl: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per search. A slow old search never renders over a newer one. */
  private searchSeq = 0;
  /** The search currently awaiting IPC, or 0. Enter must not activate older rows. */
  private inflightSeq = 0;
  /** Query the current rows belong to. Stale rows are not activated. */
  private rowsQuery = "";
  private mode: QuickOpenMode = "files";
  private selected = 0;
  private rows: Array<{
    key: string;
    label: string;
    detail: string;
    line?: number;
    column?: number;
    matches?: number[];
    matchOffset?: number;
    matchLength?: number;
  }> = [];
  /** Focus to restore when the modal is cancelled, not when a row is opened. */
  private restoreFocus: { focus(): void; isConnected: boolean } | null = null;

  private onOpenFile: (relPath: string) => void = () => {};
  private onOpenContentHit: (relPath: string, line: number, column: number) => void = () => {};
  /** Mirror of the last content search, so the Explorer can list it persistently. */
  private onContentResults: (pattern: string, hits: ContentHit[], truncated: boolean, error?: string) => void = () => {};
  private onExecuteCommand: (command: CommandId) => void = () => {};
  private getShortcut: (command: CommandId) => string = () => "";
  /** Bumped by Explorer clear so a late modal result cannot repaint a dismissed listing. */
  private contentGeneration: () => number = () => 0;

  bind(handlers: {
    onOpenFile: (relPath: string) => void;
    onOpenContentHit: (relPath: string, line: number, column: number) => void;
    onContentResults: (pattern: string, hits: ContentHit[], truncated: boolean, error?: string) => void;
    onExecuteCommand: (command: CommandId) => void;
    getShortcut: (command: CommandId) => string;
    contentGeneration?: () => number;
  }): void {
    this.onOpenFile = handlers.onOpenFile;
    this.onOpenContentHit = handlers.onOpenContentHit;
    this.onContentResults = handlers.onContentResults;
    this.onExecuteCommand = handlers.onExecuteCommand;
    this.getShortcut = handlers.getShortcut;
    this.contentGeneration = handlers.contentGeneration ?? (() => 0);
  }

  open(mode: QuickOpenMode): void {
    const active = document.activeElement;
    if (active !== this.input && canRestoreFocus(active)) this.restoreFocus = active;
    this.mode = mode;
    this.selected = 0;
    this.rows = [];
    this.rowsQuery = "";
    // A mode switch must not paint the previous query's rows into this one.
    this.searchSeq++;
    this.inflightSeq = 0;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.build();
    this.modalEl?.classList.toggle("search-content", mode === "content");
    if (this.input) {
      this.input.value = "";
      this.input.placeholder = mode === "files" ? "Open a project file…" : mode === "content" ? "Regular expression…" : "Run a command…";
      this.input.removeAttribute("aria-invalid");
    }
    const title = this.root?.querySelector(".modal-title");
    if (title) title.textContent = mode === "files" ? "Quick Open" : mode === "content" ? "Search Contents" : "Command Palette";
    if (this.root) this.root.style.display = "flex";
    this.input?.focus();
    if (this.mode === "files") void this.runFileSearch("");
    else if (this.mode === "content") this.showEmpty(CONTENT_HINT);
    else this.renderActions("");
  }

  /** Hide the modal and drop an in-flight search. Used on project switch. */
  close(): void {
    this.searchSeq++;
    this.inflightSeq = 0;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (!this.root || this.root.style.display === "none") return;
    this.dismiss(true);
  }

  private build(): void {
    if (this.root) return;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop search-modal";
    backdrop.style.display = "none";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const title = document.createElement("div");
    title.className = "modal-title";
    title.id = "quick-open-title";
    modal.setAttribute("aria-labelledby", title.id);

    const input = document.createElement("input");
    input.className = "search-input";
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-haspopup", "listbox");
    input.setAttribute("aria-controls", QUICK_OPEN_RESULTS_ID);
    input.setAttribute("aria-labelledby", title.id);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("spellcheck", "false");
    input.spellcheck = false;

    const status = document.createElement("div");
    status.className = "search-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const results = document.createElement("div");
    results.className = "search-results";
    results.id = QUICK_OPEN_RESULTS_ID;
    results.setAttribute("role", "listbox");
    results.setAttribute("aria-label", "Search results");

    modal.append(title, input, status, results);
    backdrop.appendChild(modal);
    document.getElementById("modal-root")!.appendChild(backdrop);
    this.root = backdrop;
    this.modalEl = modal;
    this.input = input;
    this.statusEl = status;
    this.resultsEl = results;

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.dismiss(true);
    });
    input.addEventListener("keydown", (e) => {
      // The first Enter/Escape belongs to the IME, not the modal.
      if (e.isComposing || e.key === "Process") return;
      if (e.key === "Escape") {
        e.stopPropagation();
        this.dismiss(true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.move(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        this.selectIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        this.selectIndex(this.rows.length - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.commit();
      }
    });
    input.addEventListener("input", () => {
      if (this.mode === "actions") {
        this.renderActions(input.value);
        return;
      }
      if (this.searchTimer) clearTimeout(this.searchTimer);
      // Content search scans file bodies: debounce longer than name search.
      const delay = this.mode === "content" ? 250 : 150;
      this.searchTimer = setTimeout(() => {
        if (this.mode === "content") void this.runContentSearch(input.value);
        else void this.runFileSearch(input.value);
      }, delay);
    });
  }

  private dismiss(restore: boolean): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.root) this.root.style.display = "none";
    this.input?.setAttribute("aria-expanded", "false");
    this.input?.removeAttribute("aria-activedescendant");
    const target = this.restoreFocus;
    this.restoreFocus = null;
    if (restore && target?.isConnected) target.focus();
  }

  /** Run a debounced search now. Enter must not activate rows from the previous query. */
  private flushPendingSearch(): void {
    if (!this.searchTimer) return;
    clearTimeout(this.searchTimer);
    this.searchTimer = null;
    const value = this.input?.value ?? "";
    if (this.mode === "content") void this.runContentSearch(value);
    else if (this.mode === "files") void this.runFileSearch(value);
  }

  private commit(): void {
    if (this.searchTimer) {
      this.flushPendingSearch();
      return;
    }
    if (this.inflightSeq !== 0) return;
    if (this.mode !== "actions" && (this.input?.value ?? "") !== this.rowsQuery) return;
    if (this.activate()) this.dismiss(false);
  }

  private finishInflight(seq: number): void {
    if (this.inflightSeq === seq) this.inflightSeq = 0;
  }

  private optionEls(): HTMLElement[] {
    if (!this.resultsEl) return [];
    return [...this.resultsEl.querySelectorAll<HTMLElement>('[role="option"]')];
  }

  private move(delta: 1 | -1): void {
    if (this.rows.length === 0) return;
    this.selected = (this.selected + delta + this.rows.length) % this.rows.length;
    this.syncComboboxAria();
  }

  private selectIndex(index: number): void {
    if (this.rows.length === 0) return;
    this.selected = Math.max(0, Math.min(index, this.rows.length - 1));
    this.syncComboboxAria();
  }

  /** Keep highlight class, aria-selected, and aria-activedescendant in lockstep. */
  private syncComboboxAria(): void {
    const input = this.input;
    if (!input) return;
    const options = this.optionEls();
    const shown = options.length > 0;
    input.setAttribute("aria-expanded", shown ? "true" : "false");
    for (let i = 0; i < options.length; i++) {
      const selected = i === this.selected;
      options[i]!.classList.toggle("selected", selected);
      options[i]!.setAttribute("aria-selected", selected ? "true" : "false");
    }
    const active = shown ? options[this.selected] : undefined;
    if (active) {
      input.setAttribute("aria-activedescendant", active.id);
      if (typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  private activate(): boolean {
    const row = this.rows[this.selected];
    if (!row) return false;
    if (this.mode === "files") this.onOpenFile(row.key);
    else if (this.mode === "content") this.onOpenContentHit(row.key, row.line ?? 1, row.column ?? 1);
    else this.onExecuteCommand(row.key as CommandId);
    return true;
  }

  private async runFileSearch(query: string): Promise<void> {
    const seq = ++this.searchSeq;
    this.inflightSeq = seq;
    try {
      this.setStatus("Searching…");
      this.resultsEl?.replaceChildren();
      this.syncComboboxAria();
      let res;
      try {
        res = await window.termina.searchFiles(query, "quick-open");
      } catch (err) {
        if (seq !== this.searchSeq) return;
        this.rowsQuery = query;
        this.showEmpty((err as Error).message);
        return;
      }
      if (seq !== this.searchSeq || (this.input?.value ?? "") !== query) return;
      this.rowsQuery = query;
      this.selected = 0;
      this.rows = res.entries.map((e) => ({
        key: e.relPath,
        label: e.relPath.split("/").pop() ?? e.relPath,
        detail: e.relPath,
        matches: e.matches,
      }));
      this.renderRows(res.truncated ? `${res.entries.length}+ files (refine to narrow)` : null);
    } finally {
      this.finishInflight(seq);
    }
  }

  private async runContentSearch(pattern: string): Promise<void> {
    const seq = ++this.searchSeq;
    this.inflightSeq = seq;
    const generation = this.contentGeneration();
    try {
      if (!pattern.trim()) {
        this.rows = [];
        this.selected = 0;
        this.rowsQuery = pattern;
        this.input?.removeAttribute("aria-invalid");
        this.showEmpty(CONTENT_HINT);
        return;
      }
      this.input?.removeAttribute("aria-invalid");
      this.setStatus("Searching…");
      this.resultsEl?.replaceChildren();
      this.syncComboboxAria();
      let res;
      try {
        res = await window.termina.searchContent(pattern, "modal");
      } catch (err) {
        if (seq !== this.searchSeq) return;
        this.rowsQuery = pattern;
        this.showEmpty((err as Error).message);
        return;
      }
      if (seq !== this.searchSeq || (this.input?.value ?? "") !== pattern) return;
      this.rowsQuery = pattern;
      if (res.error) {
        this.rows = [];
        this.selected = 0;
        const message = contentSearchMessage(res.error);
        this.input?.setAttribute("aria-invalid", "true");
        this.showEmpty(message);
        if (generation === this.contentGeneration()) this.onContentResults(pattern, [], false, message);
        return;
      }
      this.selected = 0;
      this.rows = res.hits.map((h) => ({
        key: h.relPath,
        line: h.line,
        column: h.column,
        label: h.text || "(empty line)",
        detail: `${h.relPath}:${h.line}:${h.column}`,
        matchOffset: h.matchOffset,
        matchLength: h.matchLength,
      }));
      const truncated = res.truncated ?? false;
      const note = this.rows.length === 0
        ? (truncated ? CUT_SHORT : null)
        : truncated
          ? `${this.rows.length}+ matches (refine to narrow)`
          : this.rows.length === 1 ? "1 match" : `${this.rows.length} matches`;
      this.renderRows(note);
      if (generation === this.contentGeneration()) this.onContentResults(pattern, res.hits, truncated);
    } finally {
      this.finishInflight(seq);
    }
  }

  private renderActions(query: string): void {
    const q = query.trim().toLowerCase();
    // Renderer handlers only exist for renderer-scope commands; main-scope
    // commands stay in the menu (executing them here would silently no-op).
    this.rows = COMMAND_DEFINITIONS.filter(
      (d) =>
        d.scope === "renderer" &&
        (!q || d.label.toLowerCase().includes(q) || d.command.includes(q) || d.description.toLowerCase().includes(q)),
    ).map((d) => {
      const shortcut = this.getShortcut(d.command as CommandId);
      return { key: d.command, label: d.label, detail: paletteRowDetail(d.command as CommandId, d.category, shortcut) };
    });
    this.selected = 0;
    this.renderRows(null);
  }

  private setStatus(message: string): void {
    if (this.statusEl) this.statusEl.textContent = message;
  }

  private renderRows(note: string | null): void {
    const list = this.resultsEl;
    if (!list) return;
    this.setStatus(note ?? (this.rows.length === 0 ? "No matches." : ""));
    list.replaceChildren();
    if (this.rows.length === 0) {
      this.syncComboboxAria();
      return;
    }
    for (const [i, row] of this.rows.entries()) {
      const el = document.createElement("div");
      el.className = "search-hit clickable" + (i === this.selected ? " selected" : "");
      el.id = optionId(i);
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", i === this.selected ? "true" : "false");
      const text = document.createElement("span");
      text.className = "search-text";
      text.title = row.label;
      const indices = this.mode === "content"
        ? rangeIndices(row.matchOffset ?? 0, row.matchLength ?? 0)
        : row.matches;
      const offset = this.mode === "files" ? row.detail.length - row.label.length : 0;
      paintMatches(text, row.label, indices, offset);
      const detail = document.createElement("span");
      detail.className = "search-path";
      detail.title = row.detail;
      paintMatches(detail, row.detail, this.mode === "files" ? row.matches : undefined, 0);
      el.append(text, detail);
      el.addEventListener("click", () => {
        this.selected = i;
        if (this.activate()) this.dismiss(false);
      });
      list.appendChild(el);
    }
    this.syncComboboxAria();
  }

  private showEmpty(message: string): void {
    this.rows = [];
    this.setStatus(message);
    this.resultsEl?.replaceChildren();
    this.syncComboboxAria();
  }
}
