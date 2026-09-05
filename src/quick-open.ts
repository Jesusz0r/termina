/**
 * Quick Open (files) and Command Palette (actions) modal.
 * Triggered by View → Quick Open / Command Palette (Cmd+P / Cmd+K).
 */
import { COMMAND_DEFINITIONS, type CommandId } from "../shared/commands";

export type QuickOpenMode = "files" | "actions";

export class QuickOpen {
  private root: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per search. A slow old search never renders over a newer one. */
  private searchSeq = 0;
  private mode: QuickOpenMode = "files";
  private selected = 0;
  private rows: Array<{ key: string; label: string; detail: string }> = [];

  private onOpenFile: (relPath: string) => void = () => {};
  private onExecuteCommand: (command: CommandId) => void = () => {};
  private getShortcut: (command: CommandId) => string = () => "";

  bind(handlers: {
    onOpenFile: (relPath: string) => void;
    onExecuteCommand: (command: CommandId) => void;
    getShortcut: (command: CommandId) => string;
  }): void {
    this.onOpenFile = handlers.onOpenFile;
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
      this.input.placeholder = mode === "files" ? "Open a project file…" : "Run a command…";
    }
    const title = this.root?.querySelector(".modal-title");
    if (title) title.textContent = mode === "files" ? "Quick Open" : "Command Palette";
    if (this.root) this.root.style.display = "flex";
    this.input?.focus();
    if (this.mode === "files") void this.runFileSearch("");
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

    const results = document.createElement("div");
    results.className = "search-results";

    modal.append(title, input, results);
    backdrop.appendChild(modal);
    document.getElementById("modal-root")!.appendChild(backdrop);
    this.root = backdrop;
    this.input = input;
    this.resultsEl = results;

    const close = (): void => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      backdrop.style.display = "none";
    };
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.move(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.activate();
        close();
      }
    });
    input.addEventListener("input", () => {
      if (this.mode === "actions") {
        this.renderActions(input.value);
        return;
      }
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.runFileSearch(input.value), 150);
    });
  }

  private move(delta: 1 | -1): void {
    if (this.rows.length === 0) return;
    this.selected = (this.selected + delta + this.rows.length) % this.rows.length;
    this.highlight();
  }

  private highlight(): void {
    const kids = this.resultsEl?.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) kids[i]!.classList.toggle("selected", i === this.selected);
    kids[this.selected]?.scrollIntoView({ block: "nearest" });
  }

  private activate(): void {
    const row = this.rows[this.selected];
    if (!row) return;
    if (this.mode === "files") this.onOpenFile(row.key);
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
    }
    let res;
    try {
      res = await window.pi.searchFiles(query);
    } catch (err) {
      if (seq !== this.searchSeq) return;
      this.showEmpty((err as Error).message);
      return;
    }
    if (seq !== this.searchSeq || (this.input?.value ?? "") !== query) return;
    this.selected = 0;
    this.rows = res.entries.map((e) => ({ key: e.relPath, label: e.relPath.split("/").pop() ?? e.relPath, detail: e.relPath }));
    this.renderRows(res.truncated ? `${res.entries.length}+ files (refine to narrow)` : null);
  }

  private renderActions(query: string): void {
    const q = query.trim().toLowerCase();
    this.rows = COMMAND_DEFINITIONS.filter(
      (d) => !q || d.label.toLowerCase().includes(q) || d.command.includes(q) || d.description.toLowerCase().includes(q),
    ).map((d) => {
      const shortcut = this.getShortcut(d.command as CommandId);
      return { key: d.command, label: d.label, detail: shortcut ? `${d.category} · ${shortcut}` : d.category };
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
      const text = document.createElement("span");
      text.className = "search-text";
      text.textContent = row.label;
      const detail = document.createElement("span");
      detail.className = "search-path";
      detail.textContent = row.detail;
      el.append(text, detail);
      el.addEventListener("click", () => {
        this.selected = i;
        this.activate();
        this.root!.style.display = "none";
      });
      list.appendChild(el);
    }
  }

  private showEmpty(message: string): void {
    const list = this.resultsEl;
    if (!list) return;
    list.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = message;
    list.appendChild(empty);
  }
}
