/**
 * Change Review: shows a Monaco diff (pre-run baseline vs current) for a file
 * the agent touched, with Revert / Accept / Open actions.
 */
import * as monaco from "monaco-editor";
import { toast } from "./components/modals";

export class ReviewView {
  private container: HTMLElement;
  private diffEl: HTMLElement;
  private diffEditor: monaco.editor.IStandaloneDiffEditor;
  private nameEl: HTMLElement;
  private terminalId: string | null = null;
  private path: string | null = null;
  private baseline: string | null = null;
  private originalModel: monaco.editor.ITextModel | null = null;
  private modifiedModel: monaco.editor.ITextModel | null = null;
  private onOpenFile: (path: string) => void = () => {};
  private onAccepted: (path: string) => void = () => {};
  private onReverted: (path: string) => void = () => {};

  constructor() {
    this.container = document.getElementById("review-container") as HTMLElement;
    this.diffEl = document.getElementById("review-diff") as HTMLElement;
    this.nameEl = document.getElementById("review-filename") as HTMLElement;

    this.diffEditor = monaco.editor.createDiffEditor(this.diffEl, {
      theme: "vs-dark",
      fontSize: 13,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
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

  bind(handlers: { onOpenFile: (path: string) => void; onAccepted: (path: string) => void; onReverted: (path: string) => void }): void {
    this.onOpenFile = handlers.onOpenFile;
    this.onAccepted = handlers.onAccepted;
    this.onReverted = handlers.onReverted;
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
    this.terminalId = terminalId;
    this.path = path;
    this.nameEl.textContent = relPath;

    const res = await window.pi.reviewBaseline(terminalId, path);
    this.baseline = res.baseline;
    const current = await window.pi.openFile(path);
    const currentText = "content" in current ? current.content : "";

    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
    this.originalModel = monaco.editor.createModel(this.baseline ?? "", undefined, monaco.Uri.parse(`file:///review/original/${encodeURIComponent(path)}`));
    this.modifiedModel = monaco.editor.createModel(currentText, undefined, monaco.Uri.parse(`file:///review/modified/${encodeURIComponent(path)}`));
    this.diffEditor.setModel({ original: this.originalModel, modified: this.modifiedModel });
    (window as unknown as Record<string, unknown>).__reviewDebug = {
      baseline: this.baseline,
      currentText,
      original: this.originalModel.getValue(),
      modified: this.modifiedModel.getValue(),
    };

    const revertBtn = document.getElementById("review-revert") as HTMLButtonElement;
    const acceptBtn = document.getElementById("review-accept") as HTMLButtonElement;
    revertBtn.disabled = res.baseline === undefined;
    acceptBtn.disabled = false;

    document.getElementById("editor-container")!.style.display = "none";
    document.getElementById("editor-tabs")!.style.display = "none";
    this.container.style.display = "flex";
    if (this.baseline === null && res.status === "created") {
      document.getElementById("review-hint")!.textContent = "new file created by the agent — reverting deletes it";
    } else if (this.baseline === null) {
      document.getElementById("review-hint")!.textContent = "no pre-run baseline captured — revert unavailable";
    } else {
      document.getElementById("review-hint")!.textContent = "";
    }
  }

  /** Refresh the modified side (e.g. after a revert changed the file on disk). */
  async refreshCurrent(): Promise<void> {
    if (!this.path || !this.terminalId) return;
    const current = await window.pi.openFile(this.path);
    const text = "content" in current ? current.content : "";
    this.modifiedModel?.setValue(text);
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
    this.container.style.display = "none";
    document.getElementById("editor-container")!.style.display = "";
    document.getElementById("editor-tabs")!.style.display = "";
    this.diffEditor.setModel(null);
    this.path = null;
    this.terminalId = null;
  }

  dispose(): void {
    this.originalModel?.dispose();
    this.modifiedModel?.dispose();
    this.diffEditor.dispose();
  }
}