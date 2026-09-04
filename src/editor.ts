/**
 * Monaco editor (the same editor VS Code uses) wrapped with tab management.
 *
 * The editor is a *live viewer*: content is driven by the file watcher in the
 * main process, so whatever the agent writes/edits on disk shows up here in
 * real time. While the agent is streaming the editor is locked read-only;
 * when idle you can edit and save with Cmd+S.
 */
import * as monaco from "monaco-editor";
import { cssFontFamily, pathBasename, type ProjectWorkspaceRef, type ThemeId } from "../shared/types";
import { languageForPath } from "./editor-language";
import { changedLinesInAfter } from "../shared/line-diff";
import { copyText, toast } from "./components/modals";
import { showContextMenu, closeContextMenu } from "./components/context-menu";

// Both custom themes are defined at import time: the editor constructor
// references "termina-dark" before applyMonacoTheme ever runs, and an
// undefined theme silently falls back to stock vs-dark.
monaco.editor.defineTheme("termina-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5f6a51", fontStyle: "italic" },
    { token: "string", foreground: "86e29b" },
    { token: "keyword", foreground: "ffb454" },
    { token: "number", foreground: "d9a05b" },
    { token: "regexp", foreground: "7cc4ff" },
    { token: "type", foreground: "b8f04a" },
    { token: "class", foreground: "b8f04a" },
    { token: "function", foreground: "7cc4ff" },
    { token: "identifier", foreground: "edf2e2" },
    { token: "delimiter", foreground: "9aa78c" },
    { token: "tag", foreground: "ff7a6b" },
    { token: "attribute.name", foreground: "ffb454" },
    { token: "attribute.value", foreground: "86e29b" },
  ],
  colors: {
    "editor.background": "#0b0d09",
    "editor.foreground": "#edf2e2",
    "editor.lineHighlightBackground": "#11140d",
    "editor.selectionBackground": "#333c26",
    "editorCursor.foreground": "#b8f04a",
    "editorLineNumber.foreground": "#3f4930",
    "editorLineNumber.activeForeground": "#9aa78c",
    "editorWidget.background": "#11140d",
    "editorSuggestWidget.background": "#11140d",
    "editorHoverWidget.background": "#11140d",
    "minimap.background": "#0b0d09",
  },
});

monaco.editor.defineTheme("termina-atom", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5c6370", fontStyle: "italic" },
    { token: "string", foreground: "98c379" },
    { token: "keyword", foreground: "c678dd" },
    { token: "number", foreground: "d19a66" },
    { token: "regexp", foreground: "56b6c2" },
    { token: "type", foreground: "e5c07b" },
    { token: "class", foreground: "e5c07b" },
    { token: "function", foreground: "61afef" },
    { token: "identifier", foreground: "abb2bf" },
    { token: "delimiter", foreground: "abb2bf" },
    { token: "tag", foreground: "e06c75" },
    { token: "attribute.name", foreground: "d19a66" },
    { token: "attribute.value", foreground: "98c379" },
  ],
  colors: {
    "editor.background": "#282c34",
    "editor.foreground": "#abb2bf",
    "editor.lineHighlightBackground": "#2c313c",
    "editor.selectionBackground": "#3e4451",
    "editorCursor.foreground": "#528bff",
    "editorLineNumber.foreground": "#495162",
    "editorLineNumber.activeForeground": "#abb2bf",
    "editorWidget.background": "#21252b",
    "editorSuggestWidget.background": "#21252b",
    "editorHoverWidget.background": "#21252b",
    "minimap.background": "#282c34",
  },
});

export function applyMonacoTheme(theme: ThemeId): void {
  monaco.editor.setTheme(
    theme === "light" ? "vs" : theme === "high-contrast" ? "hc-black" : theme === "atom" ? "termina-atom" : "termina-dark",
  );
}

interface SharedModelEntry {
  model: monaco.editor.ITextModel;
  refs: number;
}

/** Monaco models are global by URI; tabs are owned by each project editor. */
const sharedFileModels = new Map<string, SharedModelEntry>();

function acquireSharedFileModel(path: string): { model: monaco.editor.ITextModel; release: () => void } {
  const uri = monaco.Uri.file(path);
  const uriKey = uri.toString();
  let entry = sharedFileModels.get(uriKey);
  if (!entry || entry.model.isDisposed()) {
    if (entry) sharedFileModels.delete(uriKey);
    let model = monaco.editor.getModel(uri);
    if (!model || model.isDisposed()) model = monaco.editor.createModel("", languageForPath(path), uri);
    entry = { model, refs: 0 };
    sharedFileModels.set(uriKey, entry);
  }
  entry.refs++;
  let released = false;
  return {
    model: entry.model,
    release: () => {
      if (released) return;
      released = true;
      const current = sharedFileModels.get(uriKey);
      if (!current || current.model !== entry!.model) return;
      current.refs = Math.max(0, current.refs - 1);
      if (current.refs === 0) {
        sharedFileModels.delete(uriKey);
        if (!current.model.isDisposed()) current.model.dispose();
      }
    },
  };
}

interface OpenTab {
  key: string; // absolute path
  model: monaco.editor.ITextModel;
  owner: ProjectWorkspaceRef | null;
  releaseModel: () => void;
  contentListener: monaco.IDisposable | null;
  dom: HTMLElement;
  dirtyDot: HTMLElement;
  /** The model version last known to match the disk content. */
  savedVersionId: number;
  /** Live agent-change decorations on this model. */
  changeDecorations: string[];
  /** First changed line to reveal when this tab becomes active. */
  agentRevealLine: number | null;
}

const AGENT_CHANGE_DECO: monaco.editor.IModelDecorationOptions = {
  isWholeLine: true,
  className: "agent-change-line",
  linesDecorationsClassName: "agent-change-gutter",
  stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
};

export class EditorManager {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private tabs = new Map<string, OpenTab>();
  private order: string[] = [];
  private activeKey: string | null = null;
  private tabsEl: HTMLElement;
  private emptyEl: HTMLElement;
  private emptyWelcome: HTMLElement | null;
  private emptyLogin: HTMLElement | null;
  private emptyOpenBtn: HTMLElement | null;
  private projectOpen = false;
  /** True when the empty pane should tell the user to log in in the terminal. */
  private needsLogin = false;
  /** The single replaceable preview tab (VS Code style). */
  private previewKey: string | null = null;
  /** Tab keys with unsaved user edits. */
  private userDirty = new Set<string>();
  /** True while a workspace agent is running (models stay read-only). */
  private locked = false;
  /** Fired when a disk write reaches a model with unsaved user edits. */
  onConflict: (path: string) => void = () => {};
  /** Fired after a file or snapshot tab is shown. */
  onFileOpened: () => void = () => {};
  /** Fired when the last tab closes. */
  onBecameEmpty: () => void = () => {};
  /** The candidate label of a path ("A"/"B"), or null (worldline badge). */
  tabBadge: (path: string) => "A" | "B" | null = () => null;
  /** The opened project root, for Copy Relative Path (null when unknown). */
  projectRootProvider: () => string | null = () => null;
  /** The project/workspace owner for renderer-originated file mutations. */
  ownerProvider: () => ProjectWorkspaceRef | null = () => null;

  constructor(container: HTMLElement, tabsEl: HTMLElement, emptyEl: HTMLElement, projectOpen = false, needsLogin = false) {
    this.tabsEl = tabsEl;
    this.emptyEl = emptyEl;
    this.emptyWelcome = emptyEl.querySelector<HTMLElement>(".empty-welcome");
    this.emptyLogin = emptyEl.querySelector<HTMLElement>(".empty-login");
    this.emptyOpenBtn = emptyEl.querySelector<HTMLElement>(".empty-open-folder");
    this.projectOpen = projectOpen;
    this.needsLogin = projectOpen && needsLogin;

    this.editor = monaco.editor.create(container, {
      theme: "termina-dark",
      fontSize: 13,
      fontFamily: cssFontFamily(""),
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      readOnly: false,
      tabSize: 2,
      wordWrap: "off",
      renderWhitespace: "selection",
      glyphMargin: false,
      stickyScroll: { enabled: false },
    });

    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.saveActive());
    this.editor.onDidChangeModel(() => {
      this.syncEmptyState();
      // Timeline snapshots are read-only views of the past.
      this.updateReadOnly();
    });
    this.syncEmptyState();
  }

  /** Lock or unlock the editor while a workspace agent writes. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.updateReadOnly();
  }

  setTheme(theme: ThemeId): void {
    applyMonacoTheme(theme);
  }

  setFontSize(size: number): void {
    this.editor.updateOptions({ fontSize: size });
  }

  setMinimap(enabled: boolean): void {
    this.editor.updateOptions({ minimap: { enabled } });
  }

  setFontFamily(family: string): void {
    this.editor.updateOptions({ fontFamily: cssFontFamily(family) });
  }

  setWordWrap(enabled: boolean): void {
    this.editor.updateOptions({ wordWrap: enabled ? "on" : "off" });
  }

  /** Read-only when locked by a busy agent or when a snapshot is active. */
  private updateReadOnly(): void {
    this.editor.updateOptions({ readOnly: this.locked || this.isTimelineActive() });
  }

  /** Called when a project folder is opened or closed. */
  setProjectOpen(open: boolean, needsLogin = false): void {
    this.projectOpen = open;
    this.needsLogin = open && needsLogin;
    this.syncEmptyState();
  }

  private syncEmptyState(): void {
    const noTabs = this.order.length === 0;
    const showWelcome = !this.projectOpen && noTabs;
    const showLogin = this.projectOpen && this.needsLogin && noTabs;
    this.emptyEl.hidden = !(showWelcome || showLogin);
    if (this.emptyWelcome) this.emptyWelcome.hidden = !showWelcome;
    if (this.emptyLogin) this.emptyLogin.hidden = !showLogin;
    if (this.emptyOpenBtn) this.emptyOpenBtn.hidden = !showWelcome;
  }

  /**
   * Open or focus a file. Fetch content from main when the model has none.
   * With preview: true the tab is a replaceable preview (VS Code style) — a
   * new preview replaces the previous one; editing or preview: false pins it.
   */
  async openFile(path: string, opts: { preview?: boolean; owner?: ProjectWorkspaceRef; line?: number; column?: number } = {}): Promise<void> {
    const preview = opts.preview ?? true;
    const owner = opts.owner ?? this.ownerProvider();
    if (!owner) throw new Error("file owner is unavailable");
    const key = path;
    const existing = this.tabs.get(key);
    if (existing) {
      // Pin the preview when explicitly requested (for example double-click).
      if (!preview && this.previewKey === key) this.pinPreview();
      this.onFileOpened();
      this.activate(key);
      if (typeof opts.line === "number" && opts.line > 0) {
        this.revealPosition(opts.line, opts.column);
      }
      return;
    }
    // Keep a replacement tab in the map before closing the previous preview.
    // Closing the last tab first would collapse the editor, then expand it again.
    const replacing = preview && this.previewKey && this.previewKey !== key ? this.previewKey : null;
    const lease = acquireSharedFileModel(path);
    const model = lease.model;
    const tab = this.makeTab(key, model, owner, lease.release);
    if (preview) {
      this.previewKey = key;
      tab.dom.classList.add("preview");
    }
    // User edits pin the preview into a permanent tab. Programmatic content
    // replacements (watcher/agent live updates) come through as isFlush and
    // do not pin. The same event marks the tab unsaved.
    tab.contentListener = model.onDidChangeContent((e) => {
      if (e.isFlush) return;
      this.clearAgentChanges(key);
      if (this.previewKey === key) this.pinPreview();
      this.syncDirty(tab);
    });
    this.tabs.set(key, tab);
    this.order.push(key);
    if (replacing && this.tabs.has(replacing)) this.closeTab(replacing);
    this.renderTabs();
    this.syncEmptyState();

    const initialVersionId = model.getAlternativeVersionId();
    const res = await window.pi.openFile(path, owner);
    if (res.ok) {
      const current = this.tabs.get(key);
      if (current?.model === model && model.getAlternativeVersionId() === initialVersionId) {
        // Learn the canonical alias so watcher pushes under the canonical
        // path find this tab.
        if (res.path !== key) this.canonicalKeys.set(res.path, key);
        model.setValue(res.content);
        tab.savedVersionId = model.getAlternativeVersionId();
        // Paint the last watcher transition even though this open has no
        // previous model content to diff against.
        if (res.changedLines && res.changedLines.length > 0) {
          this.paintAgentChanges(tab, res.changedLines);
          tab.agentRevealLine = res.changedLines[0];
        } else {
          tab.agentRevealLine = null;
        }
      } else if (current?.model === model && this.userDirty.has(key)) {
        // The initial read lost a race with a user edit. Never replace the
        // user's model with delayed disk bytes; surface the normal conflict.
        if (!current.dom.classList.contains("conflict")) {
          current.dom.classList.add("conflict");
          current.dom.title = `${key} — changed on disk while you have unsaved edits`;
          this.onConflict(key);
        }
        if (this.previewKey === key) this.pinPreview();
      }
      if (this.tabs.get(key)?.model === model) {
        this.activate(key);
        this.onFileOpened();
        if (typeof opts.line === "number" && opts.line > 0) {
          this.revealPosition(opts.line, opts.column);
        }
      }
      return;
    }
    if (this.tabs.get(key)?.model === model && model.getAlternativeVersionId() === initialVersionId) this.closeTab(key);
    throw new Error(res.error);
  }

  /** True when at least one file or snapshot tab is open. */
  hasOpenTabs(): boolean {
    return this.order.length > 0;
  }

  /** Promote the preview tab to a permanent tab. */
  private pinPreview(): void {
    if (!this.previewKey) return;
    const tab = this.tabs.get(this.previewKey);
    if (tab) tab.dom.classList.remove("preview");
    this.previewKey = null;
  }

  /** Canonical-path aliases per tab key. Main pushes canonical paths
   *  (/private/tmp on macOS); tabs are keyed by the opened path. The open
   *  response returns the canonical path, so every tab learns its alias. */
  private canonicalKeys = new Map<string, string>();

  /** The tab key for a pushed path: the path itself or its canonical alias. */
  private resolveKey(path: string): string | null {
    if (this.tabs.has(path)) return path;
    const aliased = this.canonicalKeys.get(path);
    return aliased !== undefined && this.tabs.has(aliased) ? aliased : null;
  }

  /** Update model content from the watcher (live edits). A model with
   *  unsaved user edits is never replaced silently: the tab shows a conflict
   *  and the user decides (save overwrites the disk, or revert the model). */
  updateContent(path: string, content: string, changedLines?: number[]): void {
    const resolved = this.resolveKey(path);
    if (resolved === null) return;
    const tab = this.tabs.get(resolved)!;
    if (this.userDirty.has(resolved)) {
      if (!tab.dom.classList.contains("conflict")) {
        tab.dom.classList.add("conflict");
        tab.dom.title = `${resolved} — changed on disk while you have unsaved edits`;
        this.onConflict(resolved);
      }
      return;
    }
    const model = tab.model;
    if (model.getValue() === content) return;
    const before = model.getValue();
    // setValue fires with isFlush=true; the model's change handler uses that
    // to tell programmatic pushes from user edits.
    model.setValue(content);
    // The agent saved to disk, so this content is the new baseline. The
    // dot stays hidden: it marks unsaved user edits, not agent writes.
    // Without the reset, the next syncDirty compares against the
    // pre-push version and shows a phantom diff.
    tab.savedVersionId = model.getAlternativeVersionId();
    // Main diffs the watcher's pre-change cache. It is authoritative even
    // when this model missed an earlier push (large-file fetches).
    const changed = changedLines ?? changedLinesInAfter(before, content);
    this.paintAgentChanges(tab, changed);
    const first = changed[0];
    if (first === undefined) return;
    if (this.editor.getModel() === model) {
      this.revealAgentChange(first);
      tab.agentRevealLine = null;
    } else {
      tab.agentRevealLine = first;
    }
  }

  private paintAgentChanges(tab: OpenTab, lines: number[]): void {
    const last = tab.model.getLineCount();
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    for (const line of lines) {
      if (line < 1 || line > last) continue;
      decos.push({ range: new monaco.Range(line, 1, line, 1), options: AGENT_CHANGE_DECO });
    }
    tab.changeDecorations = tab.model.deltaDecorations(tab.changeDecorations, decos);
  }

  private clearAgentChanges(key: string): void {
    const tab = this.tabs.get(key);
    if (!tab) return;
    tab.agentRevealLine = null;
    if (tab.changeDecorations.length === 0) return;
    tab.changeDecorations = tab.model.deltaDecorations(tab.changeDecorations, []);
  }

  private revealAgentChange(line: number): void {
    this.editor.revealLineInCenter(line);
  }

  /** The tab dot reflects unsaved user edits only: content that matches
   *  the disk (agent pushes, saves, undo back to the saved version) hides
   *  it again. */
  private syncDirty(tab: OpenTab): void {
    const dirty = tab.model.getAlternativeVersionId() !== tab.savedVersionId;
    tab.dirtyDot.style.display = dirty ? "inline-block" : "none";
    if (dirty) this.userDirty.add(tab.key);
    else this.userDirty.delete(tab.key);
  }

  /** Paths marked as the user's own (agent off-limits). */
  private mineKeys = new Set<string>();
  /** Fired when the user clicks the mine toggle on a tab. */
  onToggleMine: (path: string, owner: ProjectWorkspaceRef) => void = () => {};

  /** True when the path is marked as the user's own. */
  isMine(path: string): boolean {
    return this.mineKeys.has(path);
  }

  /** Mark a path (or clear the mark); updates the open tab. */
  setMine(path: string, mine: boolean): void {
    if (mine) this.mineKeys.add(path);
    else this.mineKeys.delete(path);
    const tab = this.tabs.get(path);
    if (tab) tab.dom.classList.toggle("mine", mine);
  }

  /** Re-apply the worldline badges on every open tab (worldline pushes). */
  refreshBadges(): void {
    for (const [key, tab] of this.tabs) {
      const badge = tab.dom.querySelector(".tab-worldline") as HTMLElement;
      if (!badge) continue;
      const label = this.tabBadge(key);
      badge.textContent = label ?? "";
      badge.style.display = label ? "" : "none";
      badge.title = label ? `worldline candidate ${label}` : "";
      badge.classList.toggle("a", label === "A");
      badge.classList.toggle("b", label === "B");
    }
  }

  /** Reset tabs and editor state when the project changes. */
  resetForProject(): void {
    for (const key of [...this.order]) this.closeTab(key);
    this.previewKey = null;
    this.lastTimelineKey = null;
    this.clearMine();
    this.setProjectOpen(true, this.needsLogin);
  }

  /** Forget every mine mark (folder switch resets ownership). */
  clearMine(): void {
    this.mineKeys.clear();
    for (const tab of this.tabs.values()) tab.dom.classList.remove("mine");
  }

  private makeTab(key: string, model: monaco.editor.ITextModel, owner: ProjectWorkspaceRef | null, releaseModel: () => void): OpenTab {
    const dom = document.createElement("div");
    dom.className = "editor-tab";
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = pathBasename(key);
    name.title = key;
    const dirty = document.createElement("span");
    dirty.className = "tab-dirty";
    dirty.style.display = "none";
    const mine = document.createElement("span");
    mine.className = "tab-mine";
    mine.textContent = "M";
    mine.title = "Mark as yours — the agent must not modify it";
    mine.addEventListener("click", (e) => {
      e.stopPropagation();
      if (owner) this.onToggleMine(key, owner);
    });
    const wline = document.createElement("span");
    wline.className = "tab-worldline";
    wline.style.display = "none";
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(key);
    });
    dom.append(dirty, name, mine, wline, close);
    if (this.mineKeys.has(key)) dom.classList.add("mine");
    dom.addEventListener("click", () => this.activate(key));
    dom.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openTabMenu(key, e.clientX, e.clientY);
    });
    // Middle-click closes, like VS Code.
    dom.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(key);
      }
    });
    // Drag to reorder. The drop indicator is a class on the target tab;
    // the order itself commits on drop so a cancelled drag changes nothing.
    dom.draggable = true;
    dom.addEventListener("dragstart", (e) => {
      this.dragKey = key;
      if (e.dataTransfer) {
        e.dataTransfer.setData("text/plain", key);
        e.dataTransfer.effectAllowed = "move";
      }
      dom.classList.add("dragging");
    });
    dom.addEventListener("dragover", (e) => {
      if (!this.dragKey || this.dragKey === key) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = dom.getBoundingClientRect();
      this.setDropTarget(key, e.clientX > rect.left + rect.width / 2);
    });
    dom.addEventListener("drop", (e) => {
      e.preventDefault();
      this.commitDrop(key);
    });
    dom.addEventListener("dragleave", () => this.clearDropTarget());
    dom.addEventListener("dragend", () => this.clearDrag());
    return { key, model, owner, releaseModel, contentListener: null, dom, dirtyDot: dirty, savedVersionId: model.getAlternativeVersionId(), changeDecorations: [], agentRevealLine: null };
  }

  private renderTabs(): void {
    this.tabsEl.replaceChildren();
    for (const key of this.order) {
      const tab = this.tabs.get(key);
      if (tab) this.tabsEl.appendChild(tab.dom);
    }
  }

  activate(key: string): void {
    const tab = this.tabs.get(key);
    if (!tab) return;
    this.activeKey = key;
    this.editor.setModel(tab.model);
    for (const t of this.tabs.values()) t.dom.classList.toggle("active", t.key === key);
    this.syncEmptyState();
    this.layout();
    this.focusEditor();
    if (tab.agentRevealLine !== null) {
      this.revealAgentChange(tab.agentRevealLine);
      tab.agentRevealLine = null;
    }
  }

  /** Recalculate Monaco size. Call this after a hidden container becomes visible. */
  layout(): void {
    this.editor.layout();
  }

  /** Move cursor to line/column, scroll line into center, and focus the editor. */
  revealPosition(line: number, column?: number): void {
    const col = typeof column === "number" && column > 0 ? column : 1;
    this.editor.setPosition({ lineNumber: line, column: col });
    this.editor.revealPositionInCenter({ lineNumber: line, column: col });
    this.focusEditor();
  }

  /** Focus the editor without scrolling the terminal pane. */
  private focusEditor(): void {
    const textarea = this.editor.getDomNode()?.querySelector("textarea");
    if (textarea) textarea.focus({ preventScroll: true });
    else this.editor.focus();
  }

  closeTab(key: string): void {
    const tab = this.tabs.get(key);
    if (!tab) return;
    for (const [canonical, mapped] of this.canonicalKeys) {
      if (mapped === key) this.canonicalKeys.delete(canonical);
    }
    tab.contentListener?.dispose();
    tab.contentListener = null;
    tab.releaseModel();
    this.tabs.delete(key);
    this.order = this.order.filter((k) => k !== key);
    this.userDirty.delete(key);
    if (this.previewKey === key) this.previewKey = null;
    this.renderTabs();
    if (this.activeKey === key) {
      this.activeKey = this.order.length ? this.order[this.order.length - 1] : null;
      if (this.activeKey) this.activate(this.activeKey);
      else {
        this.editor.setModel(null);
        this.syncEmptyState();
      }
    }
    if (this.order.length === 0) this.onBecameEmpty();
  }

  private async saveActive(): Promise<void> {
    if (!this.activeKey || this.activeKey.startsWith("timeline:")) return;
    const tab = this.tabs.get(this.activeKey);
    if (!tab) return;
    if (!tab.owner) {
      toast(`could not save ${pathBasename(tab.key)}: file owner is unavailable`, "error");
      return;
    }
    const res = await window.pi.saveFile(tab.key, tab.model.getValue(), tab.owner);
    if (res.ok) {
      tab.savedVersionId = tab.model.getAlternativeVersionId();
      this.syncDirty(tab);
      tab.dom.classList.remove("conflict");
    } else {
      toast(`could not save ${pathBasename(tab.key)}: ${res.error ?? "unknown error"}`, "error");
    }
  }

  /** Save every model with unsaved user edits. Returns the failed paths.
   *  With `writerId` (the write-lease holder) the saves bypass the lease
   *  block — the flush IS the holder's operation. */
  async flushAll(writerId?: string): Promise<{ ok: boolean; failed: string[] }> {
    const failed: string[] = [];
    for (const key of [...this.userDirty]) {
      const tab = this.tabs.get(key);
      if (!tab) continue;
      if (!tab.owner) {
        failed.push(key);
        continue;
      }
      const res = writerId
        ? await window.pi.flushSave(tab.key, tab.model.getValue(), writerId, tab.owner)
        : await window.pi.saveFile(tab.key, tab.model.getValue(), tab.owner);
      if (res.ok) {
        tab.savedVersionId = tab.model.getAlternativeVersionId();
        this.syncDirty(tab);
        tab.dom.classList.remove("conflict");
      } else {
        failed.push(key);
      }
    }
    return { ok: failed.length === 0, failed };
  }

  /** True when any model has unsaved user edits. */
  hasDirtyModels(): boolean {
    return this.userDirty.size > 0;
  }

  /** Close a tab if it is open (the file was deleted on disk). */
  closeIfOpen(path: string): void {
    const resolved = this.resolveKey(path);
    if (resolved !== null) this.closeTab(resolved);
  }

  // ---------------- tab actions (VS Code-style context menu) ---------------

  private dragKey: string | null = null;
  private dropTarget: { key: string; after: boolean } | null = null;

  closeOthers(key: string): void {
    this.closeKeys(this.order.filter((k) => k !== key));
    if (this.tabs.has(key)) this.activate(key);
  }

  closeToLeft(key: string): void {
    const at = this.order.indexOf(key);
    if (at === -1) return;
    this.closeKeys(this.order.slice(0, at));
  }

  closeToRight(key: string): void {
    const at = this.order.indexOf(key);
    if (at === -1) return;
    this.closeKeys(this.order.slice(at + 1));
  }

  closeAllTabs(): void {
    this.closeKeys([...this.order]);
  }

  private closeKeys(keys: string[]): void {
    for (const k of keys) this.closeTab(k);
  }

  private setDropTarget(key: string, after: boolean): void {
    const tab = this.tabs.get(key);
    if (!tab) return;
    if (this.dropTarget?.key === key && this.dropTarget.after === after) return;
    this.clearDropTarget();
    this.dropTarget = { key, after };
    tab.dom.classList.add(after ? "drop-after" : "drop-before");
  }

  private clearDropTarget(): void {
    if (!this.dropTarget) return;
    const el = this.tabs.get(this.dropTarget.key)?.dom;
    if (el) { el.classList.remove("drop-before", "drop-after"); }
    this.dropTarget = null;
  }

  private clearDrag(): void {
    this.dragKey = null;
    this.clearDropTarget();
    this.tabsEl.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
  }

  private commitDrop(targetKey: string): void {
    const dragKey = this.dragKey;
    const after = this.dropTarget?.key === targetKey ? this.dropTarget.after : false;
    this.clearDrag();
    if (!dragKey || dragKey === targetKey) return;
    const from = this.order.indexOf(dragKey);
    if (from === -1) return;
    this.order.splice(from, 1);
    const to = this.order.indexOf(targetKey) + (after ? 1 : 0);
    this.order.splice(to, 0, dragKey);
    this.renderTabs();
  }

  private openTabMenu(key: string, x: number, y: number): void {
    const tab = this.tabs.get(key);
    if (!tab) return;
    const idx = this.order.indexOf(key);
    const isTimeline = key.startsWith("timeline:");
    const relPath = isTimeline ? null : this.relativePath(key);
    showContextMenu(
      [
        { label: "Close", action: () => this.closeTab(key) },
        { label: "Close Others", action: () => this.closeOthers(key) },
        { label: "Close to the Left", disabled: idx === 0, action: () => this.closeToLeft(key) },
        { label: "Close to the Right", disabled: idx === this.order.length - 1, action: () => this.closeToRight(key) },
        { label: "Close All", action: () => this.closeAllTabs() },
        ...(this.previewKey === key ? [{ label: "Keep Open", action: () => this.pinPreview() }] : []),
        ...(isTimeline
          ? []
          : [
              { separator: true },
              { label: "Copy Path", action: () => copyText(key, "Path copied") },
              {
                label: "Copy Relative Path",
                disabled: relPath === null,
                action: () => {
                  if (relPath === null) return;
                  copyText(relPath, "Relative path copied");
                },
              },
            ]),
      ],
      x,
      y,
    );
  }

  private relativePath(absPath: string): string | null {
    const root = this.projectRootProvider()?.replace(/\/+$/, "");
    if (!root || !absPath.startsWith(`${root}/`)) return null;
    return absPath.slice(root.length + 1);
  }

  /**
   * Session Timeline: open a read-only tab showing a file snapshot taken at
   * a past moment (the content lives in the event, not on disk). The tab key
   * is namespaced so it never collides with the real file and watcher updates
   * never touch it.
   */
  private lastTimelineKey: string | null = null;

  openSnapshot(terminalId: string, eventKey: string, relPath: string, content: string, label: string, replay = false): void {
    const key = `timeline:${terminalId}:${eventKey}`;
    const prevKey = this.lastTimelineKey;
    // Replay shows one tab: close the previous snapshot tab. Clicks keep one
    // tab per dot, so comparing moments stays easy.
    const existing = this.tabs.get(key);
    if (existing) {
      existing.model.setValue(content);
      this.activate(key);
      this.onFileOpened();
      this.lastTimelineKey = key;
      if (replay && prevKey && prevKey !== key && this.tabs.has(prevKey)) this.closeTab(prevKey);
      return;
    }
    const MAX_OPEN_SNAPSHOT_TABS = 10;
    if (!replay) {
      const openSnapshots = this.order.filter((k) => k.startsWith("timeline:"));
      if (openSnapshots.length >= MAX_OPEN_SNAPSHOT_TABS) {
        const oldest = openSnapshots[0];
        if (oldest && oldest !== key && this.tabs.has(oldest)) this.closeTab(oldest);
      }
    }
    const replacingPreview = this.previewKey && this.previewKey !== key ? this.previewKey : null;
    const model = monaco.editor.createModel(content, languageForPath(relPath), monaco.Uri.parse(`timeline://${terminalId}/${encodeURIComponent(eventKey)}`));
    const tab = this.makeTab(key, model, null, () => model.dispose());
    tab.dom.classList.add("timeline-tab");
    tab.dom.title = `${relPath} — ${label}`;
    this.tabs.set(key, tab);
    this.order.push(key);
    if (replay && prevKey && prevKey !== key && this.tabs.has(prevKey)) this.closeTab(prevKey);
    if (replacingPreview && this.tabs.has(replacingPreview)) this.closeTab(replacingPreview);
    this.renderTabs();
    this.syncEmptyState();
    this.activate(key);
    this.onFileOpened();
    this.lastTimelineKey = key;
    // The test suites read the snapshot from the model, not the DOM render.
    (window as unknown as Record<string, unknown>).__timelineTab = { key, content };
  }

  /** True when the active model is a timeline snapshot (read-only view). */
  isTimelineActive(): boolean {
    return this.activeKey !== null && this.activeKey.startsWith("timeline:");
  }

  /** True when the editor (not the terminal) owns keyboard focus. */
  hasTextFocus(): boolean {
    return this.editor.hasTextFocus();
  }

  /** True when the workspace lock is engaged (test hook). */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Run a menu command on the editor. Return false when the editor is
   * not focused. The caller can then use the terminal or the browser.
   */
  runMenuEdit(kind: "undo" | "redo" | "select-all" | "find"): boolean {
    if (!this.editor.hasTextFocus()) return false;
    const actions = {
      undo: "editor.action.undo",
      redo: "editor.action.redo",
      "select-all": "editor.action.selectAll",
      find: "actions.find",
    } as const;
    this.editor.trigger("menu", actions[kind], null);
    return true;
  }

  dispose(): void {
    closeContextMenu();
    this.editor.dispose();
    for (const tab of this.tabs.values()) {
      tab.contentListener?.dispose();
      tab.contentListener = null;
      tab.releaseModel();
    }
    this.tabs.clear();
    this.order = [];
    this.userDirty.clear();
    this.mineKeys.clear();
  }
}
