/**
 * Explorer content-search listing.
 *
 * Owns the persistent Search Contents results section. The Explorer owns the
 * tree; this collaborator renders content hits through a narrow host. Split
 * from components/explorer.ts (issue #38) with no behavior change.
 */
import type { ContentHit } from "../../shared/types";
import { makeNote } from "./explorer-rows";

/** Narrow Explorer surface the content collaborator drives. */
export interface ExplorerContentHost {
  onContentHit(relPath: string, line: number, column: number): void;
}

export class ExplorerContent {
  private contentSection: HTMLElement | null = null;
  private contentTitle: HTMLElement | null = null;
  private contentResults: HTMLElement | null = null;
  /** Pattern behind the listing; "" means the section is empty/hidden. */
  private contentPattern = "";

  /** Bumped per re-run. A slow old search never renders over a newer one. */
  private contentSeq = 0;

  constructor(container: HTMLElement, private host: ExplorerContentHost) {
    this.contentSection = container.querySelector("#explorer-content");
    this.contentTitle = container.querySelector("#explorer-content-title");
    this.contentResults = container.querySelector("#explorer-content-results");
    container.querySelector("#explorer-content-rerun")?.addEventListener("click", () => void this.rerunContentSearch());
    container.querySelector("#explorer-content-clear")?.addEventListener("click", () => this.clearContentResults());
  }

  /**
   * List content-search hits grouped by file. Fed by the Search Contents
   * modal; the listing persists so many hits stay browsable after the modal
   * closes.
   */
  showContentResults(pattern: string, hits: ContentHit[], truncated: boolean): void {
    this.contentPattern = pattern;
    const section = this.contentSection;
    const title = this.contentTitle;
    const results = this.contentResults;
    if (!section || !title || !results) return;
    section.hidden = false;
    const label = hits.length === 1 ? "1 match" : `${hits.length} matches`;
    title.textContent = `${label} for "${pattern}"${truncated ? " (truncated)" : ""}`;
    title.title = pattern;
    results.replaceChildren();
    if (hits.length === 0) {
      results.appendChild(makeNote(`No matches for "${pattern}".`));
      return;
    }
    let currentFile: string | null = null;
    for (const hit of hits) {
      if (hit.relPath !== currentFile) {
        currentFile = hit.relPath;
        const file = document.createElement("div");
        file.className = "explorer-content-file";
        file.textContent = hit.relPath;
        file.title = hit.relPath;
        results.appendChild(file);
      }
      const row = document.createElement("div");
      row.className = "explorer-content-hit";
      row.title = `${hit.relPath}:${hit.line}`;
      const lineNo = document.createElement("span");
      lineNo.className = "explorer-content-line";
      lineNo.textContent = String(hit.line);
      const text = document.createElement("span");
      text.className = "explorer-content-text";
      text.textContent = hit.text || "(empty line)";
      row.append(lineNo, text);
      row.addEventListener("click", () => this.host.onContentHit(hit.relPath, hit.line, hit.column));
      results.appendChild(row);
    }
    if (truncated) results.appendChild(makeNote("More matches exist — refine to narrow."));
  }

  /** Hide the content listing and forget its pattern. */
  clearContentResults(): void {
    this.contentPattern = "";
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
    const loading = makeNote("searching…");
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
      results.replaceChildren();
      results.appendChild(makeNote(res.error));
      return;
    }
    this.showContentResults(pattern, res.hits, res.truncated ?? false);
  }
}
