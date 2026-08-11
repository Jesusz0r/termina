/**
 * Monaco editor (the same editor VS Code uses) wrapped with tab management.
 *
 * The editor is a *live viewer*: content is driven by the file watcher in the
 * main process, so whatever the agent writes/edits on disk shows up here in
 * real time. While the agent is streaming the editor is locked read-only;
 * when idle you can edit and save with Cmd+S.
 */
import * as monaco from "monaco-editor";
import type { ThemeId } from "../shared/types";

interface OpenTab {
  key: string; // absolute path
  model: monaco.editor.ITextModel;
  dom: HTMLElement;
  dirtyDot: HTMLElement;
}

export class EditorManager {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private tabs = new Map<string, OpenTab>();
  private order: string[] = [];
  private activeKey: string | null = null;
  private tabsEl: HTMLElement;
  private emptyEl: HTMLElement;
  private projectOpen = false;
  /** The single replaceable preview tab (VS Code style). */
  private previewKey: string | null = null;
  /** Tab keys with unsaved user edits. */
  private userDirty = new Set<string>();
  /** True while a workspace agent is running (models stay read-only). */
  private locked = false;
  /** Fired when a disk write reaches a model with unsaved user edits. */
  onConflict: (path: string) => void = () => {};
  /** The candidate label of a path ("A"/"B"), or null (worldline badge). */
  tabBadge: (path: string) => "A" | "B" | null = () => null;

  constructor(container: HTMLElement) {
    this.tabsEl = document.getElementById("editor-tabs")!;
    this.emptyEl = document.getElementById("editor-empty")!;

    this.editor = monaco.editor.create(container, {
      theme: "vs-dark",
      fontSize: 13,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
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
    monaco.editor.setTheme(theme === "light" ? "vs" : theme === "high-contrast" ? "hc-black" : "vs-dark");
  }

  setFontSize(size: number): void {
    this.editor.updateOptions({ fontSize: size });
  }

  setMinimap(enabled: boolean): void {
    this.editor.updateOptions({ minimap: { enabled } });
  }

  /** Read-only when locked by a busy agent or when a snapshot is active. */
  private updateReadOnly(): void {
    this.editor.updateOptions({ readOnly: this.locked || this.isTimelineActive() });
  }

  /** Called when a project folder is opened/closed; hides the welcome hint. */
  setProjectOpen(open: boolean): void {
    this.projectOpen = open;
    this.syncEmptyState();
  }

  private syncEmptyState(): void {
    // The hint only makes sense before a folder is opened: once a project is
    // open (even with no tabs yet) the pane stays clean.
    this.emptyEl.style.display = !this.projectOpen && this.order.length === 0 ? "flex" : "none";
  }

  /**
   * Open or focus a file. Fetch content from main when the model has none.
   * With preview: true the tab is a replaceable preview (VS Code style) — a
   * new preview replaces the previous one; editing or preview: false pins it.
   */
  async openFile(path: string, opts: { preview?: boolean } = {}): Promise<void> {
    const preview = opts.preview ?? true;
    const key = path;
    const existing = this.tabs.get(key);
    if (existing) {
      // Pin the preview when explicitly requested (for example double-click).
      if (!preview && this.previewKey === key) this.pinPreview();
      this.activate(key);
      return;
    }
    // A new preview replaces the previous preview when the previous preview is not edited.
    if (preview && this.previewKey && this.tabs.has(this.previewKey)) {
      this.closeTab(this.previewKey);
    }
    const model = monaco.editor.createModel("", languageForPath(path), monaco.Uri.file(path));
    const tab = this.makeTab(key, model);
    if (preview) {
      this.previewKey = key;
      tab.dom.classList.add("preview");
    }
    // User edits pin the preview into a permanent tab. Programmatic content
    // replacements (watcher/agent live updates) come through as isFlush and
    // do not pin. The same event marks the model dirty.
    model.onDidChangeContent((e) => {
      if (e.isFlush) return;
      this.userDirty.add(key);
      if (this.previewKey === key) this.pinPreview();
    });
    this.tabs.set(key, tab);
    this.order.push(key);
    this.renderTabs();
    this.syncEmptyState();

    const res = await window.pi.openFile(path);
    if ("content" in res) {
      if (this.tabs.has(key)) model.setValue(res.content);
    } else {
      model.setValue(`// ${res.error}`);
    }
    this.activate(key);
  }

  /** Promote the preview tab to a permanent tab. */
  private pinPreview(): void {
    if (!this.previewKey) return;
    const tab = this.tabs.get(this.previewKey);
    if (tab) tab.dom.classList.remove("preview");
    this.previewKey = null;
  }

  /** Update model content from the watcher (live edits). A model with
   *  unsaved user edits is never replaced silently: the tab shows a conflict
   *  and the user decides (save overwrites the disk, or revert the model). */
  updateContent(path: string, content: string): void {
    const tab = this.tabs.get(path);
    if (!tab) return;
    if (this.userDirty.has(path)) {
      if (!tab.dom.classList.contains("conflict")) {
        tab.dom.classList.add("conflict");
        tab.dom.title = `${path} — changed on disk while you have unsaved edits`;
        this.onConflict(path);
      }
      return;
    }
    const model = tab.model;
    if (model.getValue() === content) return;
    // setValue fires with isFlush=true; the model's change handler uses that
    // to tell programmatic pushes from user edits.
    model.setValue(content);
    const editor = this.editor;
    const isActive = editor.getModel() === model;
    const scrollTop = editor.getScrollTop();
    const sel = editor.getSelection();
    if (isActive) {
      const layout = editor.getLayoutInfo();
      const maxScroll = Math.max(0, editor.getScrollHeight() - layout.height);
      editor.setScrollTop(Math.min(scrollTop, maxScroll));
      if (sel) {
        const line = Math.min(sel.positionLineNumber, model.getLineCount());
        const column = Math.min(sel.positionColumn, model.getLineMaxColumn(line));
        editor.setPosition({ lineNumber: line, column });
      }
    }
    tab.dirtyDot.style.display = "inline-block";
  }

  /** Mark a file as being touched by the agent (tab badge). */
  markTouched(path: string): void {
    const tab = this.tabs.get(path);
    if (tab) tab.dirtyDot.style.display = "inline-block";
  }

  /** Paths marked as the user's own (agent off-limits). */
  private mineKeys = new Set<string>();
  /** Fired when the user clicks the mine toggle on a tab. */
  onToggleMine: (path: string) => void = () => {};

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
    this.setProjectOpen(true);
  }

  /** Forget every mine mark (folder switch resets ownership). */
  clearMine(): void {
    this.mineKeys.clear();
    for (const tab of this.tabs.values()) tab.dom.classList.remove("mine");
  }

  private makeTab(key: string, model: monaco.editor.ITextModel): OpenTab {
    const dom = document.createElement("div");
    dom.className = "editor-tab";
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = basename(key);
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
      this.onToggleMine(key);
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
    return { key, model, dom, dirtyDot: dirty };
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
    this.editor.focus();
  }

  closeTab(key: string): void {
    const tab = this.tabs.get(key);
    if (!tab) return;
    tab.model.dispose();
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
  }

  private async saveActive(): Promise<void> {
    if (!this.activeKey || this.activeKey.startsWith("timeline:")) return;
    const tab = this.tabs.get(this.activeKey);
    if (!tab) return;
    const res = await window.pi.saveFile(tab.key, tab.model.getValue());
    if (res.ok) {
      this.userDirty.delete(tab.key);
      tab.dirtyDot.style.display = "none";
      tab.dom.classList.remove("conflict");
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
      const res = writerId ? await window.pi.flushSave(tab.key, tab.model.getValue(), writerId) : await window.pi.saveFile(tab.key, tab.model.getValue());
      if (res.ok) {
        this.userDirty.delete(key);
        tab.dirtyDot.style.display = "none";
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
    if (this.tabs.has(path)) this.closeTab(path);
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
    if (replay && prevKey && prevKey !== key && this.tabs.has(prevKey)) this.closeTab(prevKey);
    const existing = this.tabs.get(key);
    if (existing) {
      existing.model.setValue(content);
      this.activate(key);
      this.lastTimelineKey = key;
      return;
    }
    if (this.previewKey && this.tabs.has(this.previewKey)) this.closeTab(this.previewKey);
    const model = monaco.editor.createModel(content, languageForPath(relPath), monaco.Uri.parse(`timeline://${terminalId}/${encodeURIComponent(eventKey)}`));
    const tab = this.makeTab(key, model);
    tab.dom.classList.add("timeline-tab");
    tab.dom.title = `${relPath} — ${label}`;
    this.tabs.set(key, tab);
    this.order.push(key);
    this.renderTabs();
    this.syncEmptyState();
    this.activate(key);
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
   * Run a menu edit command on the editor. Return false when the editor is
   * not focused. The caller can then use the terminal or the browser.
   */
  runMenuEdit(kind: "undo" | "redo" | "select-all"): boolean {
    if (!this.editor.hasTextFocus()) return false;
    const actions = {
      undo: "editor.action.undo",
      redo: "editor.action.redo",
      "select-all": "editor.action.selectAll",
    } as const;
    this.editor.trigger("menu", actions[kind], null);
    return true;
  }

  dispose(): void {
    this.editor.dispose();
    for (const tab of this.tabs.values()) tab.model.dispose();
  }
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Language detection for Monaco models. */
function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", jsonc: "json",
    html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    md: "markdown",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
    cs: "csharp",
    php: "php",
    sh: "shell", bash: "shell", zsh: "shell",
    yml: "yaml", yaml: "yaml",
    toml: "ini",
    sql: "sql",
    xml: "xml", svg: "xml",
    vue: "html",
    swift: "swift",
    kt: "kotlin",
    dart: "dart",
  };
  return map[ext] ?? "plaintext";
}