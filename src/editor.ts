/**
 * Monaco editor (the same editor VS Code uses) wrapped with tab management.
 *
 * The editor is a *live viewer*: content is driven by the file watcher in the
 * main process, so whatever the agent writes/edits on disk shows up here in
 * real time. While the agent is streaming the editor is locked read-only;
 * when idle you can edit and save with Cmd+S.
 */
import * as monaco from "monaco-editor";

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
      this.editor.updateOptions({ readOnly: this.isTimelineActive() });
    });
    this.syncEmptyState();
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
   * Open (or focus) a file. Content is fetched from main if we don't have it.
   * With preview: true the tab is a replaceable preview (VS Code style) — a
   * new preview replaces the previous one; editing or preview: false pins it.
   */
  async openFile(path: string, opts: { preview?: boolean } = {}): Promise<void> {
    const preview = opts.preview ?? true;
    const key = path;
    const existing = this.tabs.get(key);
    if (existing) {
      // Pin the preview when explicitly requested (e.g. double-click).
      if (!preview && this.previewKey === key) this.pinPreview();
      this.activate(key);
      return;
    }
    // A new preview replaces the previous preview (if it wasn't edited).
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
    // do not pin.
    model.onDidChangeContent((e) => {
      if (e.isFlush) return;
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

  /** Update model content from the watcher (live edits). */
  updateContent(path: string, content: string): void {
    const tab = this.tabs.get(path);
    if (!tab) return;
    const model = tab.model;
    if (model.getValue() === content) return;
    const editor = this.editor;
    const isActive = editor.getModel() === model;
    const scrollTop = editor.getScrollTop();
    const sel = editor.getSelection();
    model.setValue(content);
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
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(key);
    });
    dom.append(dirty, name, mine, close);
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
      tab.dirtyDot.style.display = "none";
    }
  }

  /** Close a tab if it is open (e.g. the file was deleted on disk). */
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

  dispose(): void {
    this.editor.dispose();
    for (const tab of this.tabs.values()) tab.model.dispose();
  }
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Language detection for Monaco models. */
export function languageForPath(path: string): string {
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