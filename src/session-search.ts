/**
 * Session Search: a modal that searches the project's past agent
 * sessions and opens the files the hits mention. Triggered by View →
 * Search Sessions.
 */
import type { SessionHit } from "../shared/types";

export class SessionSearch {
  private root: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per search. A slow old search never renders over a newer one. */
  private searchSeq = 0;
  private selected = 0;
  private rows: SessionHit[] = [];

  private onOpenFile: (path: string) => void = () => {};

  bind(handlers: { onOpenFile: (path: string) => void }): void {
    this.onOpenFile = handlers.onOpenFile;
  }

  open(): void {
    this.build();
    this.input?.focus();
    this.input?.select();
  }

  private build(): void {
    if (this.root) {
      this.root.style.display = "flex";
      return;
    }
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop search-modal";
    const modal = document.createElement("div");
    modal.className = "modal";

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Search Sessions";

    const input = document.createElement("input");
    input.className = "search-input";
    input.type = "text";
    input.placeholder = "Search past sessions (min 2 chars)…";

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
        if (this.activate()) close();
      }
    });
    input.addEventListener("input", () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.runSearch(), 250);
    });
  }

  /** Debounced search; renders the hits under the input. */
  private async runSearch(): Promise<void> {
    const query = this.input?.value ?? "";
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
      res = await window.termina.searchSessions(query);
    } catch (err) {
      if (seq !== this.searchSeq || (this.input?.value ?? "") !== query) return;
      this.rows = [];
      this.selected = 0;
      if (list) {
        list.replaceChildren();
        const empty = document.createElement("div");
        empty.className = "search-empty";
        empty.textContent = (err as Error).message;
        list.appendChild(empty);
      }
      return;
    }
    if (seq !== this.searchSeq || (this.input?.value ?? "") !== query) return;
    this.render(res.hits, query, res.error);
  }

  private move(delta: 1 | -1): void {
    if (this.rows.length === 0) return;
    this.selected = (this.selected + delta + this.rows.length) % this.rows.length;
    this.highlight();
  }

  private highlight(): void {
    const rows = this.resultsEl?.querySelectorAll(".search-hit");
    if (!rows) return;
    rows.forEach((el, i) => el.classList.toggle("selected", i === this.selected));
    rows[this.selected]?.scrollIntoView({ block: "nearest" });
  }

  /** Open the selected hit. False when it links no file (the modal stays open). */
  private activate(): boolean {
    const hit = this.rows[this.selected];
    if (!hit?.filePath) return false;
    this.onOpenFile(hit.filePath);
    return true;
  }

  private render(hits: SessionHit[], query: string, error?: string): void {
    const list = this.resultsEl;
    if (!list) return;
    list.replaceChildren();
    this.rows = hits;
    this.selected = 0;
    if (error) {
      const note = document.createElement("div");
      note.className = "search-empty";
      note.textContent = error;
      list.appendChild(note);
      if (hits.length === 0) return;
    }
    if (hits.length === 0) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = query.trim().length < 2 ? "Type at least 2 characters." : "No matches.";
      list.appendChild(empty);
      return;
    }
    for (const [i, hit] of hits.entries()) {
      const row = document.createElement("div");
      row.className = "search-hit" + (i === this.selected ? " selected" : "");
      const when = document.createElement("span");
      when.className = "search-when";
      when.textContent = hit.ts ? new Date(hit.ts).toLocaleString() : hit.sessionFile.slice(0, 19);
      const text = document.createElement("span");
      text.className = "search-text";
      text.textContent = hit.text;
      text.title = hit.before ? `${hit.before}\n${hit.text}` : hit.text;
      row.append(when, text);
      if (hit.filePath) {
        row.classList.add("clickable");
        const path = document.createElement("span");
        path.className = "search-path";
        path.textContent = hit.filePath;
        row.appendChild(path);
        row.addEventListener("click", () => {
          this.selected = i;
          this.highlight();
          if (this.activate()) this.root!.style.display = "none";
        });
      } else {
        const hint = document.createElement("span");
        hint.className = "search-no-file";
        hint.textContent = "no linked file";
        hint.title = "This hit mentions no project file";
        row.appendChild(hint);
        row.title = "This hit mentions no project file";
      }
      list.appendChild(row);
    }
  }
}
