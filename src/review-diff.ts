import * as monaco from "monaco-editor";
import { cssFontFamily } from "../shared/types";
import { languageForPath } from "./editor-language";

/** Owns a read-only Monaco diff and the models attached to it. */
export class ReadOnlyReviewDiff {
  private editor: monaco.editor.IStandaloneDiffEditor;
  private original: monaco.editor.ITextModel | null = null;
  private modified: monaco.editor.ITextModel | null = null;
  private path: string | null = null;
  private disposed = false;

  constructor(element: HTMLElement, private namespace: string, renderSideBySide = true) {
    this.editor = monaco.editor.createDiffEditor(element, {
      // Inherit Monaco's active application theme; creating a viewer must not reset it.
      fontSize: 13,
      fontFamily: cssFontFamily(""),
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide,
      maxComputationTime: 5000,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
  }

  setDiff(path: string, baseline: string, current: string): void {
    if (this.disposed) return;
    if (this.path === path && this.original && this.modified) {
      this.original.setValue(baseline);
      this.modified.setValue(current);
      return;
    }
    this.clear();
    const language = languageForPath(path);
    const prefix = `file:///review/${encodeURIComponent(this.namespace)}`;
    this.original = monaco.editor.createModel(baseline, language, monaco.Uri.parse(`${prefix}/original/${encodeURIComponent(path)}`));
    this.modified = monaco.editor.createModel(current, language, monaco.Uri.parse(`${prefix}/modified/${encodeURIComponent(path)}`));
    this.path = path;
    this.editor.setModel({ original: this.original, modified: this.modified });
  }

  clear(): void {
    if (this.disposed) return;
    this.editor.setModel(null);
    this.original?.dispose();
    this.modified?.dispose();
    this.original = null;
    this.modified = null;
    this.path = null;
  }

  focus(): void {
    if (!this.disposed) this.editor.getModifiedEditor().focus();
  }

  setFontSize(size: number): void {
    if (!this.disposed) this.editor.updateOptions({ fontSize: size });
  }

  setFontFamily(family: string): void {
    if (!this.disposed) this.editor.updateOptions({ fontFamily: cssFontFamily(family) });
  }

  setWordWrap(enabled: boolean): void {
    if (!this.disposed) this.editor.updateOptions({ wordWrap: enabled ? "on" : "off" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.editor.dispose();
    this.disposed = true;
  }
}
