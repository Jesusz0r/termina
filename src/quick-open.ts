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
  private input: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per search. A slow old search never renders over a newer one. */
  private searchSeq = 0;
  private mode: QuickOpenMode = "files";
  private selected = 0;
  private rows: Array<{ key: string; label: string; detail: string; line?: number; column?: number; matches?: number[] }> = [];

  private onOpenFile: (relPath: string) => void = () => {};
  private onOpenContentHit: (relPath: string, line: number, column: number) => void = () => {};
  /** Mirror of the last content search, so the Explorer can list it persistently. */
  private onContentResults: (pattern: string, hits: ContentHit[], truncated: boolean) => void = () => {};
  private onExecuteCommand: (command: CommandId) => void = () => {};
  private getShortcut: (command: CommandId) => string = () => "";

  bind(handlers: {
    onOpenFile: (relPath: string) => void;
    onOpenContentHit: (relPath: string, line: number, column: number) => void;
    onContentResults: (pattern: string, hits: ContentHit[], truncated: boolean) => void;
    onExecuteCommand: (command: CommandId) => void;
    getShortcut: (command: CommandId) => string;
  }): void {
    this.onOpenFile = handlers.onOpenFile;
    this.onOpenContentHit = handlers.onOpenContentHit;
    this.onContentResults = handlers.onContentResults;
    this.onExecuteCommand = handlers.onExecuteCommand;
    this.getShortcut = handlers.getShortcut;
  }

  open(mode: QuickOpenMode): void {
    this.mode = mode;
    this.selected = 0;
    this.rows = [];
    this.build();
    if (this.input) {
      this.input.value = "";
      this.input.placeholder = mode === "files" ? "Open a project file…" : mode === "content" ? "Search file contents…" : "Run a command…";
    }
    const title = this.root?.querySelector(".modal-title");
    if (title) title.textContent = mode === "files" ? "Quick Open" : mode === "content" ? "Search Contents" : "Command Palette";
    if (this.root) this.root.style.display = "flex";
    this.input?.focus();
    if (this.mode === "files") void this.runFileSearch("");
    else if (this.mode === "content") this.showEmpty("Type to search file contents.");
    else this.renderActions("");
  }

  private build(): void {
    if (this.root) return;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop search-modal";
    backdrop.style.display = "none";
    const modal = document.createElement("div");
    modal.className = "modal";

    const title = document.createElement("div");
    title.className = "modal-title";

    const input = document.createElement("input");
    input.className = "search-input";
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-haspopup", "listbox");
    input.setAttribute("aria-controls", QUICK_OPEN_RESULTS_ID);

    const results = document.createElement("div");
    results.className = "search-results";
    results.id = QUICK_OPEN_RESULTS_ID;
    results.setAttribute("role", "listbox");

    modal.append(title, input, results);
    backdrop.appendChild(modal);
    document.getElementById("modal-root")!.appendChild(backdrop);
    this.root = backdrop;
    this.input = input;
    this.resultsEl = results;

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.dismiss();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.dismiss();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.move(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.activate();
        this.dismiss();
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

  private dismiss(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.root) this.root.style.display = "none";
    this.input?.setAttribute("aria-expanded", "false");
    this.input?.removeAttribute("aria-activedescendant");
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

  private activate(): void {
    const row = this.rows[this.selected];
    if (!row) return;
    if (this.mode === "files") this.onOpenFile(row.key);
    else if (this.mode === "content") this.onOpenContentHit(row.key, row.line ?? 1, row.column ?? 1);
    else this.onExecuteCommand(row.key as CommandId);
  }

  private async runFileSearch(query: string): Promise<void> {
    const seq = ++this.searchSeq;
    const list = this.resultsEl;
    if (list) {
      list.replaceChildren();
      const loading = document.createElement("div");
      loading.className = "search-empty";
      loading.textContent = "searching…";
      list.appendChild(loading);
      this.syncComboboxAria();
    }
    let res;
    try {
      res = await window.termina.searchFiles(query, "quick-open");
    } catch (err) {
      if (seq !== this.searchSeq) return;
      this.showEmpty((err as Error).message);
      return;
    }
    if (seq !== this.searchSeq || (this.input?.value ?? "") !== query) return;
    this.selected = 0;
    this.rows = res.entries.map((e) => ({
      key: e.relPath,
      label: e.relPath.split("/").pop() ?? e.relPath,
      detail: e.relPath,
      matches: e.matches,
    }));
    this.renderRows(res.truncated ? `${res.entries.length}+ files (refine to narrow)` : null);
  }

  private async runContentSearch(pattern: string): Promise<void> {
    const seq = ++this.searchSeq;
    if (!pattern.trim()) {
      this.rows = [];
      this.selected = 0;
      this.showEmpty("Type to search file contents.");
      return;
    }
    const list = this.resultsEl;
    if (list) {
      list.replaceChildren();
      const loading = document.createElement("div");
      loading.className = "search-empty";
      loading.textContent = "searching…";
      list.appendChild(loading);
      this.syncComboboxAria();
    }
    let res;
    try {
      res = await window.termina.searchContent(pattern, "modal");
    } catch (err) {
      if (seq !== this.searchSeq) return;
      this.showEmpty((err as Error).message);
      return;
    }
    if (seq !== this.searchSeq || (this.input?.value ?? "") !== pattern) return;
    if (res.error) {
      this.rows = [];
      this.selected = 0;
      this.showEmpty(res.error);
      return;
    }
    this.selected = 0;
    this.rows = res.hits.map((h) => ({
      key: h.relPath,
      line: h.line,
      column: h.column,
      label: h.text || "(empty line)",
      detail: `${h.relPath}:${h.line}`,
    }));
    this.renderRows(res.truncated ? `${res.hits.length}+ matches (refine to narrow)` : null);
    this.onContentResults(pattern, res.hits, res.truncated ?? false);
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

  private renderRows(note: string | null): void {
    const list = this.resultsEl;
    if (!list) return;
    list.replaceChildren();
    if (note) {
      const el = document.createElement("div");
      el.className = "search-empty";
      el.textContent = note;
      list.appendChild(el);
    }
    if (this.rows.length === 0) {
      this.showEmpty("No matches.");
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
      // Match indices address the relPath; the label is its basename suffix.
      paintMatches(text, row.label, row.matches, row.detail.length - row.label.length);
      const detail = document.createElement("span");
      detail.className = "search-path";
      paintMatches(detail, row.detail, this.mode === "files" ? row.matches : undefined, 0);
      el.append(text, detail);
      el.addEventListener("click", () => {
        this.selected = i;
        this.activate();
        this.dismiss();
      });
      list.appendChild(el);
    }
    this.syncComboboxAria();
  }

  private showEmpty(message: string): void {
    const list = this.resultsEl;
    if (!list) return;
    list.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = message;
    list.appendChild(empty);
    this.syncComboboxAria();
  }
}
