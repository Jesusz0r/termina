/**
 * Session Search: a modal that searches the project's past Pi and core
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
    backdrop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
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
    let hits;
    try {
      hits = await window.pi.searchSessions(query);
    } catch (err) {
      if (seq !== this.searchSeq || (this.input?.value ?? "") !== query) return;
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
    this.render(hits, query);
  }

  private render(hits: SessionHit[], query: string): void {
    const list = this.resultsEl;
    if (!list) return;
    list.replaceChildren();
    if (hits.length === 0) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = query.trim().length < 2 ? "Type at least 2 characters." : "No matches.";
      list.appendChild(empty);
      return;
    }
    for (const hit of hits) {
      const row = document.createElement("div");
      row.className = "search-hit";
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
        row.addEventListener("click", () => this.onOpenFile(hit.filePath!));
      }
      list.appendChild(row);
    }
  }
}
