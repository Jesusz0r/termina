/**
 * Change Review: shows a Monaco diff (pre-run baseline vs current) for a file
 * the agent touched, with Revert / Accept / Open actions.
 */
import * as monaco from "monaco-editor";
import { toast } from "./components/modals";
import { languageForPath } from "./editor-language";
import { applyMonacoTheme } from "./editor";
import { cssFontFamily, type ThemeId } from "../shared/types";

export class ReviewView {
  private container: HTMLElement;
  private diffEl: HTMLElement;
  private diffEditor: monaco.editor.IStandaloneDiffEditor;
  private nameEl: HTMLElement;
  private terminalId: string | null = null;
  private path: string | null = null;
  private baseline: string | null | undefined = null;
  private originalModel: monaco.editor.ITextModel | null = null;
  private modifiedModel: monaco.editor.ITextModel | null = null;
  private onOpenFile: (path: string) => void = () => {};
  private onAccepted: (path: string) => void = () => {};
  private onReverted: (path: string) => void = () => {};
  private onHidden: () => void = () => {};
  private onShown: () => void = () => {};
  /** Bumped on every show/hide. A stale load applies to nothing. */
  private loadSeq = 0;

  constructor() {
    this.container = document.getElementById("review-container") as HTMLElement;
    this.diffEl = document.getElementById("review-diff") as HTMLElement;
    this.nameEl = document.getElementById("review-filename") as HTMLElement;

    this.diffEditor = monaco.editor.createDiffEditor(this.diffEl, {
      theme: "vs-dark",
      fontSize: 13,
      fontFamily: cssFontFamily(""),
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });

    document.getElementById("review-back")!.addEventListener("click", () => this.hide());
    document.getElementById("review-open")!.addEventListener("click", () => {
      if (this.path) this.onOpenFile(this.path);
    });
    document.getElementById("review-revert")!.addEventListener("click", () => void this.revert());
    document.getElementById("review-accept")!.addEventListener("click", () => this.accept());
  }

  bind(handlers: { onOpenFile: (path: string) => void; onAccepted: (path: string) => void; onReverted: (path: string) => void; onHidden?: () => void; onShown?: () => void }): void {
    this.onOpenFile = handlers.onOpenFile;
    this.onAccepted = handlers.onAccepted;
    this.onReverted = handlers.onReverted;
    this.onHidden = handlers.onHidden ?? (() => {});
    this.onShown = handlers.onShown ?? (() => {});
  }

  setTheme(theme: ThemeId): void {
    applyMonacoTheme(theme);
  }

  setFontSize(size: number): void {
    this.diffEditor.updateOptions({ fontSize: size });
  }

  setFontFamily(family: string): void {
    this.diffEditor.updateOptions({ fontFamily: cssFontFamily(family) });
  }

  setWordWrap(enabled: boolean): void {
    this.diffEditor.updateOptions({ wordWrap: enabled ? "on" : "off" });
  }

  get isVisible(): boolean {
    return this.container.style.display !== "none";
  }

  /** True when the review shows the given path. */
  matchesPath(path: string): boolean {
    return this.path === path;
  }

  /** Show the diff for a file the agent changed in the given terminal. */
  async show(terminalId: string, path: string, relPath: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.terminalId = terminalId;
    this.path = path;
    this.nameEl.textContent = relPath;

    const hint = document.getElementById("review-hint")!;
    hint.textContent = "loading…";
    let res;
    let current;
    try {
      res = await window.pi.reviewBaseline(terminalId, path);
      if (seq !== this.loadSeq) return;
      current = await window.pi.openFile(path);
    } catch (err) {
      if (seq !== this.loadSeq) return;
      hint.textContent = (err as Error).message;
      toast(`could not load review: ${(err as Error).message}`, "error");
      return;
    }
    if (seq !== this.loadSeq) return;
    this.baseline = res.baseline;
    if (!current.ok) {
      hint.textContent = current.error;
      toast(`could not load ${relPath}: ${current.error}`, "error");
      return;
    }
    const currentText = current.content;

    this.setDiff(this.baseline ?? "", currentText);

    const revertBtn = document.getElementById("review-revert") as HTMLButtonElement;
    const acceptBtn = document.getElementById("review-accept") as HTMLButtonElement;
    revertBtn.style.display = "";
    acceptBtn.style.display = "";
    revertBtn.disabled = res.baseline === undefined;
    acceptBtn.disabled = false;

    this.coverEditors(true);
    this.container.style.display = "flex";
    this.onShown();
    if (this.baseline === null && res.status === "created") {
      document.getElementById("review-hint")!.textContent = "new file created by the agent — reverting deletes it";
    } else if (this.baseline === null) {
      document.getElementById("review-hint")!.textContent = "no pre-run baseline captured — revert unavailable";
    } else {
      document.getElementById("review-hint")!.textContent = "";
    }
  }

  /** Show the base-to-candidate diff for a worldline file. */
  async showCandidateDiff(comparisonId: string, label: "A" | "B", relPath: string, absPath: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.terminalId = null;
    this.path = absPath;
    this.nameEl.textContent = `${relPath}  ·  ${label}`;
    const [base, cand] = await Promise.all([
      window.pi.getWorldlineBaseFile(comparisonId, relPath),
      window.pi.getWorldlineFile(comparisonId, label, relPath),
    ]);
    if (seq !== this.loadSeq) return;
    this.setDiff(base.ok && base.content !== undefined ? base.content : "", cand.ok && cand.content !== undefined ? cand.content : "");
    const revertBtn = document.getElementById("review-revert") as HTMLButtonElement;
    const acceptBtn = document.getElementById("review-accept") as HTMLButtonElement;
    revertBtn.style.display = "none";
    acceptBtn.style.display = "none";
    this.coverEditors(true);
    this.container.style.display = "flex";
    this.onShown();
    const hint = document.getElementById("review-hint")!;
    hint.textContent = `shared base → candidate ${label}`;
    if (!base.ok || !cand.ok) hint.textContent = `shared base → candidate ${label} — ${base.error ?? cand.error ?? ""}`;
  }

  /** Show the A-to-B diff for a worldline file. */
  async showABDiff(comparisonId: string, relPath: string, aRoot: string | null): Promise<void> {
    const seq = ++this.loadSeq;
    this.terminalId = null;
    this.path = aRoot ? `${aRoot}/${relPath}` : null;
    this.nameEl.textContent = `${relPath}  ·  A ⇄ B`;
    const [a, b] = await Promise.all([
      window.pi.getWorldlineFile(comparisonId, "A", relPath),
      window.pi.getWorldlineFile(comparisonId, "B", relPath),
    ]);
    if (seq !== this.loadSeq) return;
    this.setDiff(a.ok && a.content !== undefined ? a.content : "", b.ok && b.content !== undefined ? b.content : "");
    const revertBtn = document.getElementById("review-revert") as HTMLButtonElement;
    const acceptBtn = document.getElementById("review-accept") as HTMLButtonElement;
    revertBtn.style.display = "none";
    acceptBtn.style.display = "none";
    this.coverEditors(true);
    this.container.style.display = "flex";
    this.onShown();
    const hint = document.getElementById("review-hint")!;
    hint.textContent = "candidate A (reference) → candidate B (alternative)";
    if (!a.ok || !b.ok) {
      hint.textContent = `A ⇄ B — ${a.error ?? b.error ?? ""}`;
      toast(a.error ?? b.error ?? "could not load A ⇄ B diff", "error");
    }
  }

  /** Build the diff models from two texts. */
  private setDiff(originalText: string, modifiedText: string): void {
    const path = this.path ?? "";
    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
    const lang = languageForPath(path);
    this.originalModel = monaco.editor.createModel(originalText, lang, monaco.Uri.parse(`file:///review/original/${encodeURIComponent(path)}`));
    this.modifiedModel = monaco.editor.createModel(modifiedText, lang, monaco.Uri.parse(`file:///review/modified/${encodeURIComponent(path)}`));
    this.diffEditor.setModel({ original: this.originalModel, modified: this.modifiedModel });
    // Test seam: the e2e suites assert on the diff sides. Content is small
    // (review files) and lives only while the modal is open.
    (window as unknown as Record<string, unknown>).__reviewDebug = {
      original: this.originalModel.getValue(),
      modified: this.modifiedModel.getValue(),
    };
  }

  /** Refresh the modified side (for example after a revert changed the file). */
  async refreshCurrent(): Promise<void> {
    if (!this.path || !this.terminalId) return;
    const seq = this.loadSeq;
    const path = this.path;
    const current = await window.pi.openFile(path);
    if (seq !== this.loadSeq || this.path !== path) return;
    if (!current.ok) {
      toast(`could not refresh review: ${current.error}`, "error");
      return;
    }
    this.modifiedModel?.setValue(current.content);
  }

  async revert(): Promise<void> {
    if (!this.terminalId || !this.path) return;
    const res = await window.pi.reviewRevert(this.terminalId, this.path);
    if (!res.ok) {
      toast(res.error ?? "revert failed", "error");
      return;
    }
    // The watcher updates the editor; refresh the diff to show the restored state.
    await this.refreshCurrent();
    this.onReverted(this.path);
    toast("reverted", "info");
  }

  accept(): void {
    if (!this.path) return;
    this.onAccepted(this.path);
    toast("accepted", "info");
    this.hide();
  }

  hide(): void {
    this.loadSeq++;
    this.container.style.display = "none";
    this.coverEditors(false);
    this.diffEditor.setModel(null);
    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
    this.originalModel = null;
    this.modifiedModel = null;
    this.path = null;
    this.terminalId = null;
    this.baseline = null;
    this.onHidden();
  }

  /** Cover the Monaco surfaces while the diff is open. Do not force the
   *  base editor visible when hiding: the project view owns the pane. */
  private coverEditors(cover: boolean): void {
    document.getElementById("right-pane")?.classList.toggle("review-open", cover);
  }

  resetForProject(): void {
    this.hide();
  }

  dispose(): void {
    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
    this.diffEditor.dispose();
  }
}