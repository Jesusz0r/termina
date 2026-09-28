/**
 * Explorer content-search listing.
 *
 * Owns the persistent Search Contents results section. The Explorer owns the
 * tree; this collaborator renders content hits through a narrow host. Split
 * from components/explorer.ts (issue #38) with no behavior change.
 */
import type { ContentHit } from "../../shared/types";
import { contentSearchMessage } from "../quick-open";
import { makeNote } from "./explorer-rows";

/** Narrow Explorer surface the content collaborator drives. */
interface ExplorerContentHost {
  onContentHit(relPath: string, line: number, column: number): void;
  focusFilter?(): void;
}

function paintMatch(el: HTMLElement, text: string, offset: number, length: number): void {
  if (length <= 0 || offset < 0 || offset >= text.length) {
    el.textContent = text;
    return;
  }
  const end = Math.min(text.length, offset + length);
  el.append(document.createTextNode(text.slice(0, offset)));
  const mark = document.createElement("mark");
  mark.textContent = text.slice(offset, end);
  el.append(mark);
  if (end < text.length) el.append(document.createTextNode(text.slice(end)));
}

export class ExplorerContent {
  private contentSection: HTMLElement | null = null;
  private contentTitle: HTMLElement | null = null;
  private contentResults: HTMLElement | null = null;
  /** Pattern behind the listing; "" means the section is empty/hidden. */
  private contentPattern = "";
  /** Bumped on clear. A modal search that started earlier must not repaint. */
  private generation = 0;

  /** Bumped per re-run. A slow old search never renders over a newer one. */
  private contentSeq = 0;

  constructor(container: HTMLElement, private host: ExplorerContentHost) {
    this.contentSection = container.querySelector("#explorer-content");
    this.contentTitle = container.querySelector("#explorer-content-title");
    this.contentResults = container.querySelector("#explorer-content-results");
    if (this.contentResults) {
      this.contentResults.setAttribute("role", "list");
      this.contentResults.setAttribute("aria-label", "Content search results");
      this.contentResults.addEventListener("keydown", (e) => this.onKeyDown(e));
    }
    container.querySelector("#explorer-content-rerun")?.addEventListener("click", () => void this.rerunContentSearch());
    container.querySelector("#explorer-content-clear")?.addEventListener("click", () => this.clearContentResults());
  }

  /** Generation captured when a modal search starts. Clear invalidates it. */
  contentGeneration(): number {
    return this.generation;
  }

  /**
   * List content-search hits grouped by file. Fed by the Search Contents
   * modal; the listing persists so many hits stay browsable after the modal
   * closes.
   */
  showContentResults(pattern: string, hits: ContentHit[], truncated: boolean, error?: string): void {
    this.contentPattern = pattern;
    const section = this.contentSection;
    const title = this.contentTitle;
    const results = this.contentResults;
    if (!section || !title || !results) return;
    section.hidden = false;
    results.replaceChildren();
    if (error) {
      title.textContent = `Could not search for "${pattern}"`;
      title.title = pattern;
      results.appendChild(makeNote(error));
      return;
    }
    const label = hits.length === 1 ? "1 match" : `${hits.length} matches`;
    title.textContent = `${label} for "${pattern}"${truncated ? " (truncated)" : ""}`;
    title.title = pattern;
    if (hits.length === 0) {
      results.appendChild(makeNote(truncated
        ? "No matches in the files searched. Results were cut short — refine and try again."
        : `No matches for "${pattern}".`));
      return;
    }
    let currentFile: string | null = null;
    let group: HTMLElement | null = null;
    let index = 0;
    for (const hit of hits) {
      if (hit.relPath !== currentFile) {
        currentFile = hit.relPath;
        group = document.createElement("div");
        group.className = "explorer-content-group";
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", hit.relPath);
        const file = document.createElement("div");
        file.className = "explorer-content-file";
        file.textContent = hit.relPath;
        file.title = hit.relPath;
        group.appendChild(file);
        results.appendChild(group);
      }
      const row = document.createElement("div");
      row.className = "explorer-content-hit";
      row.title = `${hit.relPath}:${hit.line}:${hit.column}`;
      row.setAttribute("role", "listitem");
      row.tabIndex = index === 0 ? 0 : -1;
      const lineNo = document.createElement("span");
      lineNo.className = "explorer-content-line";
      lineNo.textContent = String(hit.line);
      const text = document.createElement("span");
      text.className = "explorer-content-text";
      text.title = hit.text || "(empty line)";
      paintMatch(text, hit.text || "(empty line)", hit.matchOffset, hit.matchLength);
      row.append(lineNo, text);
      row.addEventListener("click", () => this.host.onContentHit(hit.relPath, hit.line, hit.column));
      group!.appendChild(row);
      index++;
    }
    if (truncated) results.appendChild(makeNote("More matches exist — refine to narrow."));
  }

  /** Move keyboard focus to the first hit. False when the listing is hidden or empty. */
  focusFirstHit(): boolean {
    if (!this.contentSection || this.contentSection.hidden) return false;
    const rows = this.hitRows();
    if (rows.length === 0) return false;
    this.moveFocus(0);
    return true;
  }

  /** Hide the content listing and forget its pattern. */
  clearContentResults(): void {
    this.contentPattern = "";
    this.generation++;
    this.contentSeq++;
    if (this.contentSection) this.contentSection.hidden = true;
    this.contentResults?.replaceChildren();
  }

  /** Re-run the listing's pattern (it goes stale as files change). */
  async rerunContentSearch(): Promise<void> {
    const pattern = this.contentPattern;
    const results = this.contentResults;
    if (!pattern || !results) return;
    const seq = ++this.contentSeq;
    results.replaceChildren();
    const loading = makeNote("Searching…");
    results.appendChild(loading);
    let res;
    try {
      res = await window.termina.searchContent(pattern, "explorer");
    } catch (err) {
      if (seq !== this.contentSeq) return;
      results.replaceChildren();
      results.appendChild(makeNote((err as Error).message));
      return;
    }
    if (seq !== this.contentSeq) return;
    if (res.error) {
      this.showContentResults(pattern, [], false, contentSearchMessage(res.error));
      return;
    }
    this.showContentResults(pattern, res.hits, res.truncated ?? false);
  }

  private hitRows(): HTMLElement[] {
    return this.contentResults
      ? [...this.contentResults.querySelectorAll<HTMLElement>(".explorer-content-hit")]
      : [];
  }

  private moveFocus(index: number): void {
    const rows = this.hitRows();
    if (rows.length === 0) return;
    const next = Math.max(0, Math.min(index, rows.length - 1));
    for (let i = 0; i < rows.length; i++) rows[i]!.tabIndex = i === next ? 0 : -1;
    rows[next]!.focus();
  }

  private onKeyDown(event: KeyboardEvent): void {
    const rows = this.hitRows();
    const current = rows.findIndex((row) => row === document.activeElement);
    if (current < 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.moveFocus(current + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (current === 0) this.host.focusFilter?.();
      else this.moveFocus(current - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      this.moveFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      this.moveFocus(rows.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      rows[current]!.click();
    }
  }
}
