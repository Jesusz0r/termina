/**
 * Agent TUI application.
 *
 * Owns the AgentTui input/render/event lifecycle. Split from
 * agent-core/tui.ts (issue #38).
 */
import { EMPTY_STATE_TEXT, SLASH_COMMANDS, applyFileMention, cellWidth, completeFileMention, completeSlashLine, effortCommandRows, fileMentionAt, formatPickerRow, formatToolSummary, matchingSlashCommands, splitGraphemes, truncateMiddle, wrapText, type SlashCommand } from "../tui-text.ts";
import { INPUT_PREFIX, boxBorderRow, boxContentRow, clip, displayBudget, graphemeSafeTail, inputWrapWidth, layoutHeights, paintRow, sourceTail, tailSpans, wrapInput, wrapSpans } from "./layout.ts";
import { HANDLE_ERROR, MAX_CSI, MAX_HISTORY, MAX_TRANSCRIPT, MAX_TRANSCRIPT_ENTRIES, SPIN, TRANSCRIPT_TRIM_TARGET, TRUNCATION_MARKER, closeSanitize, entryChars, freshMarkdownBoundary, freshSanitizer, parseMarkdown, sanitizeText, toolStatusLabel, transcriptHandleBrand } from "./transcript.ts";
import type { StyledSpan, ToolTranscriptState, TranscriptEntry, TranscriptHandle, TuiIO, TuiInput } from "./transcript.ts";


export class AgentTui {
  private readonly out: TuiIO;
  private readonly inp: TuiInput;
  private readonly commands: SlashCommand[];
  private readonly onSubmit: (line: string) => void;
  private readonly onInterrupt: () => void;
  private readonly onExit: () => void;
  private started = false;
  private entries: TranscriptEntry[] = [];
  private nextEntryId = 1;
  private nextHandle = 1;
  private transcriptChars = 0;
  private activeStream: { kind: "assistant" | "thinking"; entryId: number } | null = null;
  private activeEntry: TranscriptEntry | null = null;
  private toolHandles = new Map<number, number>();
  private thinkingVisible = true;
  markdownScannedChars = 0;
  private scroll = 0;
  private follow = true;
  private chars: string[] = [];
  private cursor = 0;
  private slashIndex = 0;
  private history: string[] = [];
  private histIndex = -1;
  private draft = "";
  private esc = 0;
  private csi = "";
  private paste = false;
  private pasteCR = false;
  private rawInput = false;
  private model = "";
  private effort = "off";
  private usage = "";
  private pendingImageCount = 0;
  private permissions = "";
  private queued = "";
  private pickerSuppressed = false;
  private search: { query: string; idx: number } | null = null;
  private onHostRefresh: (() => void) | null = null;
  private busy = false;
  private spin = 0;
  private spinTimer: ReturnType<typeof setInterval> | null = null;
  private paintTimer: ReturnType<typeof setTimeout> | null = null;
  private onResize: (() => void) | null = null;
  private onData: ((chunk: Buffer | string) => void) | null = null;
  private decoder = new TextDecoder("utf8");
  private lastPainted: string[] | null = null;
  private lastDim = { cols: 0, rows: 0 };
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private modelRows: SlashCommand[] = [];
  private effortRows: SlashCommand[] = effortCommandRows();
  private choicePrompt = "";
  private choiceRows: SlashCommand[] = [];
  private choiceDraft: { chars: string[]; cursor: number } | null = null;
  private readonly fileMatches: ((query: string) => string[]) | null;

  constructor(opts: {
    stdout: TuiIO;
    stdin: TuiInput;
    commands?: SlashCommand[];
    fileMatches?: (query: string) => string[];
    onSubmit: (line: string) => void;
    onInterrupt: () => void;
    onExit: () => void;
    onHostRefresh?: () => void;
    thinkingVisible?: boolean;
  }) {
    this.out = opts.stdout;
    this.inp = opts.stdin;
    this.commands = opts.commands ?? SLASH_COMMANDS;
    this.fileMatches = opts.fileMatches ?? null;
    this.onSubmit = opts.onSubmit;
    this.onInterrupt = opts.onInterrupt;
    this.onExit = opts.onExit;
    if (opts.onHostRefresh) this.onHostRefresh = opts.onHostRefresh;
    if (opts.thinkingVisible === false) this.thinkingVisible = false;
  }

  setPendingImageCount(count: number): void {
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (this.pendingImageCount === n) return;
    this.pendingImageCount = n;
    this.schedule();
  }

  active(): boolean {
    return this.started;
  }

  setStatus(status: {
    model?: string;
    effort?: string;
    usage?: string;
    permissions?: string;
  }): void {
    if (status.model !== undefined) this.model = status.model;
    if (status.effort !== undefined) this.effort = status.effort;
    if (status.usage !== undefined) this.usage = status.usage;
    if (status.permissions !== undefined) this.permissions = status.permissions;
    this.schedule();
  }

  setQueued(line: string): void {
    const next = line.trim();
    if (this.queued === next) return;
    this.queued = next;
    this.schedule();
  }

  private enterSearch(): void {
    if (this.rawInput || this.choiceRows.length > 0) return;
    if (!this.search) {
      if (this.histIndex < 0) this.draft = this.chars.join("");
      this.search = { query: "", idx: this.history.length };
    }
    this.findSearch(-1);
  }

  private findSearch(dir: -1 | 1): void {
    if (!this.search || this.history.length === 0) {
      this.schedule();
      return;
    }
    const q = this.search.query.toLowerCase();
    let i = this.search.idx + dir;
    while (i >= 0 && i < this.history.length) {
      if (!q || this.history[i]!.toLowerCase().includes(q)) {
        this.search.idx = i;
        this.chars = splitGraphemes(this.history[i]!);
        this.cursor = this.chars.length;
        this.histIndex = i;
        this.schedule();
        return;
      }
      i += dir;
    }
    this.schedule();
  }

  private exitSearch(restore: boolean): void {
    if (!this.search) return;
    this.search = null;
    if (restore) {
      this.chars = splitGraphemes(this.draft);
      this.cursor = this.chars.length;
      this.histIndex = -1;
    } else {
      this.histIndex = -1;
      this.draft = "";
    }
    this.schedule();
  }

  setModelRows(rows: SlashCommand[]): void {
    this.modelRows = rows;
    this.schedule();
  }

  setEffortLevels(levels: readonly string[]): void {
    this.effortRows = effortCommandRows(levels);
    this.schedule();
  }

  setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    if (busy) this.startSpin();
    else this.stopSpin();
    this.schedule();
  }

  setRawInput(raw: boolean): void {
    if (this.rawInput === raw) return;
    this.rawInput = raw;
    this.slashIndex = 0;
    this.schedule();
  }

  setChoices(prompt: string, rows: SlashCommand[]): void {
    if (this.choiceRows.length === 0) this.choiceDraft = { chars: this.chars, cursor: this.cursor };
    this.choicePrompt = prompt;
    this.choiceRows = rows;
    this.chars = [];
    this.cursor = 0;
    this.slashIndex = 0;
    this.schedule();
  }

  clearChoices(): void {
    this.choicePrompt = "";
    this.choiceRows = [];
    this.slashIndex = 0;
    if (this.choiceDraft) {
      this.chars = this.choiceDraft.chars;
      this.cursor = this.choiceDraft.cursor;
      this.choiceDraft = null;
    }
    this.schedule();
  }

  setDraft(text: string): void {
    this.chars = splitGraphemes(text);
    this.cursor = this.chars.length;
    this.slashIndex = 0;
    this.histIndex = -1;
    this.draft = "";
    this.schedule();
  }

  appendPlain(text: string): void {
    this.pushText("plain", text, true);
  }

  appendAssistant(text: string): void {
    this.pushStream("assistant", text);
  }

  appendThinking(text: string): void {
    this.pushStream("thinking", text);
  }

  appendError(text: string): void {
    this.pushText("error", text, true);
  }

  setThinkingVisible(visible: boolean): void {
    if (this.thinkingVisible === visible) return;
    if (this.follow) {
      this.thinkingVisible = visible;
      this.schedule();
      return;
    }
    const { cols, rows } = this.size();
    const inputLines = this.composerInput(cols).wrapped.length;
    const layout = layoutHeights(rows, Math.max(1, inputLines), this.matches().length);
    const anchor = this.topVisibleEntryId(cols, layout.transcript, this.scroll);
    this.thinkingVisible = visible;
    const next = anchor === null ? null : this.nearestVisibleEntryId(anchor);
    if (next === null) this.scroll = 0;
    else this.scrollEntryToTop(next, cols, layout.transcript);
    this.follow = this.scroll === 0;
    this.schedule();
  }

  startTool(name: string, detail: string): TranscriptHandle {
    this.closeStream();
    const id = this.nextEntryId++;
    const handleId = this.nextHandle++;
    const handle = { [transcriptHandleBrand]: handleId } as TranscriptHandle;
    const cleanName = closeSanitize(name, freshSanitizer());
    const cleanDetail = closeSanitize(detail, freshSanitizer());
    this.entries.push({
      id,
      kind: "tool",
      text: "",
      settled: false,
      toolName: cleanName,
      toolDetail: cleanDetail,
      toolState: "running",
      sanitizer: freshSanitizer(),
      revision: 1,
      mdPrefixLen: 0,
      mdPrefixChars: 0,
      mdPrefixSpans: [],
      mdBoundary: freshMarkdownBoundary(),
      cache: null,
    });
    this.toolHandles.set(handleId, id);
    this.transcriptChars += entryChars(this.entries[this.entries.length - 1]!);
    this.evictSettled();
    if (this.follow) this.scroll = 0;
    this.schedule();
    return handle;
  }

  finishTool(handle: TranscriptHandle, state: ToolTranscriptState, output?: string): void {
    const handleId = (handle as unknown as { [transcriptHandleBrand]?: number })[transcriptHandleBrand];
    const entryId = typeof handleId === "number" ? this.toolHandles.get(handleId) : undefined;
    const entry = entryId !== undefined ? this.entries.find((item) => item.id === entryId) : undefined;
    if (!entry || entry.kind !== "tool") {
      this.appendPlain(HANDLE_ERROR);
      return;
    }
    if (entry.settled) {
      this.appendPlain(HANDLE_ERROR);
      return;
    }
    this.transcriptChars -= entryChars(entry);
    entry.toolState = state === "success" ? "success" : state === "cancelled" ? "cancelled" : "error";
    entry.settled = true;
    entry.expanded = false;
    entry.text = closeSanitize(output ?? "", freshSanitizer());
    entry.revision += 1;
    this.resetMarkdown(entry);
    entry.cache = null;
    this.transcriptChars += entryChars(entry);
    this.toolHandles.delete(handleId as number);
    this.evictSettled();
    if (this.follow) this.scroll = 0;
    this.schedule();
  }

  cancelPendingTools(): void {
    for (const entry of this.entries) {
      if (entry.kind === "tool" && !entry.settled) {
        entry.toolState = "cancelled";
        entry.settled = true;
        entry.revision += 1;
        entry.cache = null;
      }
    }
    this.toolHandles.clear();
    this.evictSettled();
    this.schedule();
  }

  private closeStream(): void {
    if (!this.activeStream) return;
    if (this.activeEntry) {
      this.activeEntry.settled = true;
      this.activeEntry.sanitizer = freshSanitizer();
    }
    this.activeStream = null;
    this.activeEntry = null;
  }

  private pushStream(kind: "assistant" | "thinking", text: string): void {
    if (!text) return;
    if (!this.activeEntry || this.activeStream?.kind !== kind) {
      this.closeStream();
      const id = this.nextEntryId++;
      const entry: TranscriptEntry = {
        id,
        kind,
        text: "",
        settled: false,
        sanitizer: freshSanitizer(),
        revision: 1,
        mdPrefixLen: 0,
        mdPrefixChars: 0,
        mdPrefixSpans: [],
        mdBoundary: freshMarkdownBoundary(),
        cache: null,
      };
      this.entries.push(entry);
      this.activeStream = { kind, entryId: id };
      this.activeEntry = entry;
    }
    const entry = this.activeEntry;
    if (!entry) return;
    const next = sanitizeText(text, entry.sanitizer);
    entry.sanitizer = next.state;
    const appendAt = entry.text.length;
    entry.text += next.text;
    this.advanceMarkdownBoundary(entry, next.text, appendAt);
    entry.revision += 1;
    entry.cache = null;
    this.transcriptChars += next.text.length;
    this.evictSettled();
    this.truncateActive(entry);
    if (this.follow) this.scroll = 0;
    this.schedule();
  }

  private pushText(kind: "plain" | "error", text: string, settled: boolean): void {
    if (!text) return;
    this.closeStream();
    const clean = closeSanitize(text, freshSanitizer());
    const id = this.nextEntryId++;
    this.entries.push({
      id,
      kind,
      text: clean,
      settled,
      sanitizer: freshSanitizer(),
      revision: 1,
      mdPrefixLen: 0,
      mdPrefixChars: 0,
      mdPrefixSpans: [],
      mdBoundary: freshMarkdownBoundary(),
      cache: null,
    });
    this.transcriptChars += clean.length;
    this.evictSettled();
    if (this.follow) this.scroll = 0;
    this.schedule();
  }

  private truncateActive(entry: TranscriptEntry): void {
    if (this.transcriptChars <= MAX_TRANSCRIPT) return;
    if (this.activeStream?.entryId !== entry.id) return;
    const others = this.transcriptChars - entryChars(entry);
    const budget = Math.max(0, TRANSCRIPT_TRIM_TARGET - others - TRUNCATION_MARKER.length);
    let tail = entry.text.length > budget ? graphemeSafeTail(entry.text, budget) : entry.text;
    const nl = tail.indexOf("\n");
    if (nl >= 0 && nl + 1 < tail.length) tail = tail.slice(nl + 1);
    const next = TRUNCATION_MARKER + tail;
    this.transcriptChars -= entryChars(entry);
    entry.text = next;
    this.resetMarkdown(entry);
    entry.revision += 1;
    entry.cache = null;
    this.transcriptChars += entryChars(entry);
  }

  private evictSettled(): void {
    while (this.entries.length > MAX_TRANSCRIPT_ENTRIES || this.transcriptChars > MAX_TRANSCRIPT) {
      const idx = this.entries.findIndex(
        (item) => item.settled && this.activeStream?.entryId !== item.id,
      );
      if (idx < 0) break;
      const gone = this.entries[idx]!;
      this.entries.splice(idx, 1);
      this.transcriptChars -= entryChars(gone);
      for (const [handleId, entryId] of [...this.toolHandles]) {
        if (entryId === gone.id) this.toolHandles.delete(handleId);
      }
    }
  }

  private entrySpans(entry: TranscriptEntry): StyledSpan[] {
    if (entry.kind === "tool") {
      const status = toolStatusLabel(entry.toolState);
      const title = formatToolSummary(entry.toolName || "", entry.toolDetail, status);
      const spans: StyledSpan[] = [{ text: title, style: 4 }];
      if (entry.text && (!entry.settled || entry.expanded)) {
        spans.push({ text: `\n${entry.text}`, style: 0 });
      }
      return spans;
    }
    if (entry.kind !== "assistant" && entry.kind !== "thinking") {
      return entry.text ? [{ text: entry.text, style: 0 }] : [];
    }
    return this.entryTailSpans(entry, Number.MAX_SAFE_INTEGER).spans;
  }

  private resetMarkdown(entry: TranscriptEntry): void {
    entry.mdPrefixLen = 0;
    entry.mdPrefixChars = 0;
    entry.mdPrefixSpans = [];
    entry.mdBoundary = freshMarkdownBoundary();
  }

  /** Advance markdown boundaries from the new chunk, never by searching the
   *  growing response string (which forces V8 to flatten its string rope). */
  private advanceMarkdownBoundary(entry: TranscriptEntry, chunk: string, offset: number): void {
    if (!chunk) return;
    if (entry.mdBoundary.checked !== offset) {
      this.resetMarkdown(entry);
      chunk = entry.text;
      offset = 0;
    }
    const state = entry.mdBoundary;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      if (ch !== "\n") {
        if (state.linePrefix.length < 3) state.linePrefix += ch;
        continue;
      }
      const nl = offset + i;
      if (state.linePrefix === "```") {
        if (!state.fence) {
          state.fence = true;
          state.fenceStart = state.lineStart;
        } else {
          state.fence = false;
          state.completeEnd = nl + 1;
        }
      } else if (!state.fence) {
        state.completeEnd = nl + 1;
      }
      state.lineStart = nl + 1;
      state.linePrefix = "";
    }
    state.checked = offset + chunk.length;
    this.markdownScannedChars += chunk.length;
  }

  private unfinishedStart(entry: TranscriptEntry): number {
    if (entry.mdBoundary.checked !== entry.text.length) {
      this.advanceMarkdownBoundary(entry, entry.text.slice(entry.mdBoundary.checked), entry.mdBoundary.checked);
    }
    const state = entry.mdBoundary;
    if (state.fence) return state.fenceStart;
    // An incomplete opening fence is not a stable parsed prefix yet.
    if (state.linePrefix === "```") return state.lineStart;
    return state.completeEnd;
  }

  private ensureMdPrefix(entry: TranscriptEntry, start: number): void {
    if (entry.mdPrefixLen > start) this.resetMarkdown(entry);
    if (entry.mdPrefixLen >= start) return;
    const scanned = { n: 0 };
    const extra = parseMarkdown(entry.text.slice(entry.mdPrefixLen, start), scanned);
    this.markdownScannedChars += scanned.n;
    for (const span of extra) {
      entry.mdPrefixSpans.push(span);
      entry.mdPrefixChars += span.text.length;
    }
    entry.mdPrefixLen = start;
  }

  private entryTailSpans(entry: TranscriptEntry, maxChars: number): { spans: StyledSpan[]; complete: boolean } {
    if (entry.kind === "tool") return { spans: this.entrySpans(entry), complete: true };
    if (entry.kind !== "assistant" && entry.kind !== "thinking") {
      const tail = sourceTail(entry.text, maxChars);
      return {
        spans: tail.text ? [{ text: tail.text, style: 0 }] : [],
        complete: !tail.sliced,
      };
    }
    const start = this.unfinishedStart(entry);
    // A truncation resets prefix metadata. Do not eagerly rebuild hundreds of
    // thousands of off-screen markdown characters just to paint the live tail.
    if (entry.mdPrefixLen === 0 && start > maxChars) {
      const tail = sourceTail(entry.text, maxChars);
      const scanned = { n: 0 };
      const spans = parseMarkdown(tail.text, scanned);
      this.markdownScannedChars += scanned.n;
      return { spans, complete: false };
    }
    const suffix = entry.text.slice(start);
    if (suffix.length > maxChars) {
      const tail = sourceTail(suffix, maxChars);
      const scanned = { n: 0 };
      const spans = parseMarkdown(tail.text, scanned);
      this.markdownScannedChars += scanned.n;
      return { spans, complete: false };
    }
    this.ensureMdPrefix(entry, start);
    const scanned = { n: 0 };
    const parsed = parseMarkdown(suffix, scanned);
    this.markdownScannedChars += scanned.n;
    const prefix = entry.mdPrefixSpans;
    if (entry.mdPrefixChars + suffix.length <= maxChars) {
      return { spans: prefix.length ? prefix.concat(parsed) : parsed, complete: true };
    }
    return {
      spans: tailSpans(prefix, Math.max(0, maxChars - suffix.length)).concat(parsed),
      complete: false,
    };
  }

  private renderedEntry(
    entry: TranscriptEntry,
    cols: number,
    maxRows: number,
  ): { rows: string[]; painted: string[]; complete: boolean } {
    const want = Math.max(1, maxRows);
    const hit = entry.cache;
    if (hit && hit.revision === entry.revision && hit.width === cols && (hit.complete || hit.cover >= want)) {
      if (hit.rows.length <= want) return hit;
      return {
        rows: hit.rows.slice(-want),
        painted: hit.painted.slice(-want),
        complete: hit.complete,
      };
    }
    let budget = displayBudget(cols, want);
    let chunk = this.entryTailSpans(entry, budget);
    let wrapped = wrapSpans(chunk.spans, cols);
    for (let pass = 0; pass < 3 && !chunk.complete && wrapped.length < want && budget < entry.text.length; pass++) {
      budget = Math.min(entry.text.length, budget * 2);
      chunk = this.entryTailSpans(entry, budget);
      wrapped = wrapSpans(chunk.spans, cols);
    }
    let rows = wrapped.map((row) => row.frags.map((frag) => frag.text).join(""));
    let painted = wrapped.map((row) => paintRow(row.frags, cols, entry, row.cells));
    if (!chunk.complete && rows.length > want) {
      rows = rows.slice(-want);
      painted = painted.slice(-want);
    }
    entry.cache = {
      revision: entry.revision,
      width: cols,
      cover: rows.length,
      complete: chunk.complete,
      rows,
      painted,
    };
    return entry.cache;
  }

  private visibleSlice(
    cols: number,
    rowCount: number,
    scroll: number,
  ): { rows: string[]; painted: string[]; ids: number[] } {
    let stillNeed = Math.max(0, rowCount + scroll);
    const rows: string[] = [];
    const painted: string[] = [];
    const ids: number[] = [];
    for (let i = this.entries.length - 1; i >= 0 && stillNeed > 0; i--) {
      const entry = this.entries[i]!;
      if (!this.thinkingVisible && entry.kind === "thinking") continue;
      const rendered = this.renderedEntry(entry, cols, stillNeed);
      rows.unshift(...rendered.rows);
      painted.unshift(...rendered.painted);
      for (let r = 0; r < rendered.rows.length; r++) ids.unshift(entry.id);
      if (!rendered.complete) break;
      stillNeed -= rendered.rows.length;
    }
    const end = Math.max(0, rows.length - scroll);
    const start = Math.max(0, end - rowCount);
    return {
      rows: rows.slice(start, end),
      painted: painted.slice(start, end),
      ids: ids.slice(start, end),
    };
  }

  private visibleTranscript(cols: number, rowCount: number, scroll: number): string[] {
    return this.visibleSlice(cols, rowCount, scroll).rows;
  }

  private topVisibleEntryId(cols: number, rowCount: number, scroll: number): number | null {
    const ids = this.visibleSlice(cols, rowCount, scroll).ids;
    return ids[0] ?? null;
  }

  private nearestVisibleEntryId(id: number): number | null {
    const idx = this.entries.findIndex((item) => item.id === id);
    const visible = (entry: TranscriptEntry): boolean => this.thinkingVisible || entry.kind !== "thinking";
    if (idx < 0) return this.entries.find(visible)?.id ?? null;
    for (let d = 0; d < this.entries.length; d++) {
      const left = this.entries[idx - d];
      if (left && visible(left)) return left.id;
      const right = this.entries[idx + d];
      if (d > 0 && right && visible(right)) return right.id;
    }
    return null;
  }

  private scrollEntryToTop(id: number, cols: number, rowCount: number): void {
    let after = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (!this.thinkingVisible && entry.kind === "thinking") continue;
      if (entry.id === id) {
        const piece = this.renderedEntry(entry, cols, after + rowCount);
        if (!piece.complete) {
          this.scroll = after;
          return;
        }
        this.scroll = Math.max(0, after + piece.rows.length - rowCount);
        return;
      }
      const newer = this.renderedEntry(entry, cols, 4096);
      after += newer.complete ? newer.rows.length : 4096;
    }
    this.scroll = 0;
  }

  start(): boolean {
    if (this.started) return true;
    try {
      this.inp.setRawMode?.(true);
      this.inp.resume?.();
    } catch {
      return false;
    }
    this.started = true;
    // No 1000/1006 mouse tracking: that steals drag-select and copy in
    // the host terminal. Wheel still reaches applyCsi as SGR 64/65 when
    // the host forwards it.
    this.out.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?7l");
    this.onResize = () => this.render();
    this.onData = (chunk) => {
      try {
        const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
        this.feed(text);
      } catch (err) {
        process.stderr.write(`tui input error: ${(err as Error).message}\n`);
      }
    };
    this.out.on?.("resize", this.onResize);
    this.inp.on?.("data", this.onData);
    if (this.busy) this.startSpin();
    this.render();
    return true;
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.lastPainted = null;
    this.stopSpin();
    if (this.paintTimer) {
      clearTimeout(this.paintTimer);
      this.paintTimer = null;
    }
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    if (this.onResize) this.out.off?.("resize", this.onResize);
    if (this.onData) this.inp.off?.("data", this.onData);
    try {
      this.decoder.decode();
    } catch {
      /* flush best-effort */
    }
    try {
      this.inp.setRawMode?.(false);
    } catch {
      /* restore best-effort */
    }
    this.out.write("\x1b[?2026l\x1b[?7h\x1b[?2004l\x1b[?25h\x1b[?1049l");
  }

  /** Visible frame without tty side effects. Tests use this. */
  frame(): string {
    this.flushBareEscape();
    return this.buildFrame(this.size()).text;
  }

  /** Styled rows without tty side effects. Tests use this. */
  paintedFrame(): string[] {
    this.flushBareEscape();
    return this.buildFrame(this.size()).painted;
  }

  feed(text: string): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    if (text === "\x1b") {
      this.esc = 1;
      this.escTimer = setTimeout(() => this.flushBareEscape(), 25);
      return;
    }
    for (const ch of text) this.handleChar(ch);
  }

  private flushBareEscape(): void {
    if (!this.escTimer && this.esc !== 1) return;
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    if (this.esc !== 1) return;
    this.esc = 0;
    if (this.search) {
      this.exitSearch(true);
      return;
    }
    if (this.choiceRows.length > 0) {
      this.clearChoices();
      this.onInterrupt();
      return;
    }
    if (this.matches().length > 0) {
      this.pickerSuppressed = true;
      this.slashIndex = 0;
      this.schedule();
      return;
    }
    this.onInterrupt();
  }

  private size(): { cols: number; rows: number } {
    return { cols: Math.max(1, this.out.columns ?? 80), rows: Math.max(1, this.out.rows ?? 24) };
  }

  private startSpin(): void {
    if (this.spinTimer || !this.started) return;
    this.spinTimer = setInterval(() => {
      this.spin = (this.spin + 1) % SPIN.length;
      this.render();
    }, 180);
  }

  private stopSpin(): void {
    if (!this.spinTimer) return;
    clearInterval(this.spinTimer);
    this.spinTimer = null;
  }

  private schedule(): void {
    if (!this.started) return;
    if (this.paintTimer) return;
    this.paintTimer = setTimeout(() => {
      this.paintTimer = null;
      this.render();
    }, 16);
  }

  private textAndCursor(): { text: string; cursor: number } {
    return { text: this.chars.join(""), cursor: this.chars.slice(0, this.cursor).join("").length };
  }

  private setTextCursor(text: string, cursor: number): void {
    this.chars = splitGraphemes(text);
    this.cursor = splitGraphemes(text.slice(0, cursor)).length;
  }

  private fileRows(): SlashCommand[] {
    if (!this.fileMatches) return [];
    const { text, cursor } = this.textAndCursor();
    if (text.trimStart().startsWith("/")) return [];
    const mention = fileMentionAt(text, cursor);
    if (!mention) return [];
    return this.fileMatches(mention.query).map((path) => ({ name: path, hint: path.endsWith("/") ? "dir" : "file", submit: `@${path}` }));
  }

  private matches(): SlashCommand[] {
    if (this.rawInput || this.search || this.pickerSuppressed) return [];
    if (this.choiceRows.length > 0) return this.choiceRows;
    const slash = matchingSlashCommands(this.chars.join(""), this.commands, this.modelRows, this.effortRows);
    if (slash.length > 0) return slash;
    return this.fileRows();
  }

  /** Composer box content during a picker: the question shows while idle,
   *  typed-ahead input replaces it while typing so the box stays one row
   *  and short terminals keep the choice rows visible. */
  private composerInput(cols: number): { wrapped: string[]; pos: { row: number; col: number } } {
    const width = inputWrapWidth(cols);
    if (!this.choicePrompt || this.chars.length > 0) {
      return wrapInput(INPUT_PREFIX, this.chars, this.cursor, width);
    }
    return {
      wrapped: wrapText(this.choicePrompt, width),
      pos: { row: 0, col: Math.min(width - 1, cellWidth(this.choicePrompt)) },
    };
  }

  private visibleFoldableTools(): TranscriptEntry[] {
    const { cols, rows } = this.size();
    const inputLines = this.composerInput(cols).wrapped.length;
    const layout = layoutHeights(rows, Math.max(1, inputLines), this.matches().length);
    const ids = this.visibleSlice(cols, layout.transcript, this.scroll).ids;
    const tools: TranscriptEntry[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = this.entries.find((item) => item.id === id);
      if (entry?.kind === "tool" && entry.settled && entry.text) tools.push(entry);
    }
    return tools;
  }

  /** Enter on an empty composer toggles the tool row in view (no new chrome). */
  private toggleVisibleToolFold(): boolean {
    const tools = this.visibleFoldableTools();
    if (tools.length === 0) return false;
    const entry = this.scroll > 0 ? tools[0]! : tools[tools.length - 1]!;
    entry.expanded = !entry.expanded;
    entry.revision += 1;
    entry.cache = null;
    this.schedule();
    return true;
  }

  private submitLine(): void {
    if (this.search) this.exitSearch(false);
    this.pickerSuppressed = false;
    const typed = this.chars.join("");
    const wasChoice = this.choiceRows.length > 0;
    const matches = this.rawInput ? [] : this.matches();
    const { text, cursor } = this.textAndCursor();
    const mention = this.rawInput || wasChoice ? null : fileMentionAt(text, cursor);
    const fileRows = mention ? this.fileRows() : [];
    if (mention && matches.length > 0 && fileRows.length > 0) {
      const picked = matches[this.slashIndex] ?? matches[0]!;
      const token = text.slice(mention.start + 1, mention.end);
      if (token !== picked.name) {
        const next = applyFileMention(text, cursor, picked.name, true);
        if (next) {
          this.setTextCursor(next.text, next.cursor);
          this.slashIndex = 0;
          this.histIndex = -1;
          this.draft = "";
          this.schedule();
          return;
        }
      }
    }
    let line = typed.trim();
    let echo = line;
    let isChoicePick = false;
    if (matches.length > 0) {
      if (wasChoice) {
        // Empty submit picks the highlighted row; an exact name/submit picks
        // that row. Anything else is a typed-ahead prompt that queues in the
        // engine while the picker stays open.
        if (!line) {
          const picked = matches[this.slashIndex] ?? matches[0];
          if (picked?.submit) {
            line = picked.submit;
            echo = picked.name;
          } else if (picked) {
            line = picked.name;
            echo = picked.name;
          }
          isChoicePick = true;
        } else {
          const exact = matches.find((m) => m.name === line || m.submit === line);
          if (exact) {
            if (exact.submit) {
              line = exact.submit;
              echo = exact.name;
            } else {
              line = exact.name;
              echo = exact.name;
            }
            isChoicePick = true;
          }
        }
      } else {
        const exact = matches.find((m) => m.name === line || m.submit === line);
        const picked = exact ?? matches[this.slashIndex];
        if (picked?.submit) {
          line = picked.submit;
          echo = picked.name;
        } else if (picked) {
          line = picked.name;
          echo = picked.name;
        }
      }
    }
    // Bare /model is the models picker, not the engine "show current route" probe.
    // Queued input during a picker submits straight through; the engine
    // answers (engine busy) for slash while the picker stays pending.
    if (!(wasChoice && !isChoicePick)) {
      if (line === "/model") line = "/models";
      if (
        !this.rawInput &&
        (line === "/login" ||
          line === "/logout" ||
          line === "/permissions" ||
          (line === "/models" && this.modelRows.length > 0))
      ) {
        this.chars = splitGraphemes(line);
        this.cursor = this.chars.length;
        this.slashIndex = 0;
        this.histIndex = -1;
        this.draft = "";
        this.schedule();
        return;
      }
    }
    if (!line && !wasChoice && !this.rawInput && this.toggleVisibleToolFold()) {
      return;
    }
    this.chars = [];
    this.cursor = 0;
    this.slashIndex = 0;
    this.histIndex = -1;
    this.draft = "";
    if (wasChoice && isChoicePick) this.clearChoices();
    if ((!wasChoice || !isChoicePick) && line && (this.history.length === 0 || this.history[this.history.length - 1] !== line)) {
      this.history.push(line);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.follow = true;
    this.scroll = 0;
    if (line) this.appendPlain(`\n> ${echo}\n`);
    else this.schedule();
    if (line === "/exit" || line === "/quit") {
      this.onExit();
      return;
    }
    this.onSubmit(line);
  }

  private handleChar(ch: string): void {
    if (this.esc === 1) {
      if (ch === "[") {
        this.esc = 2;
        this.csi = "";
        return;
      }
      if (ch === "O") {
        this.esc = 3;
        return;
      }
      if (ch === "\x1b") return;
      this.esc = 0;
      if (ch === "b") this.moveWord(-1);
      else if (ch === "f") this.moveWord(1);
      else if (ch === "d") this.deleteWord(1);
      else if (ch === "\x7f") this.deleteWord(-1);
      else if (ch === "\r" || ch === "\n") this.insert("\n");
      this.schedule();
      return;
    }
    if (this.esc === 3) {
      if (ch === "H") this.cursor = this.lineStart();
      else if (ch === "F") {
        if (this.scroll > 0 && this.cursor === this.lineEnd()) {
          this.scroll = 0;
          this.follow = true;
        } else this.cursor = this.lineEnd();
      }
      this.esc = 0;
      this.schedule();
      return;
    }
    if (this.esc === 2) {
      if (this.csi.length === 0 && (ch === "<" || ch === "?")) {
        this.csi = ch;
        return;
      }
      if ((ch >= "0" && ch <= "9") || ch === ";") {
        if (this.csi.length < MAX_CSI) this.csi += ch;
        else this.csi = this.csi.slice(0, MAX_CSI) + "x";
        return;
      }
      if (this.csi.startsWith("?")) {
        if (this.csi.length <= MAX_CSI && this.csi === "?9001" && (ch === "h" || ch === "l")) {
          this.setThinkingVisible(ch === "h");
        }
        this.esc = 0;
        this.csi = "";
        return;
      }
      this.applyCsi(this.csi, ch);
      this.esc = 0;
      this.csi = "";
      return;
    }
    if (ch === "\x1b") {
      this.esc = 1;
      return;
    }
    if (this.paste) {
      if (ch === "\r") {
        this.insert("\n");
        this.pasteCR = true;
        return;
      }
      if (ch === "\n") {
        if (!this.pasteCR) this.insert("\n");
        this.pasteCR = false;
        return;
      }
      this.pasteCR = false;
      if (ch === "\t" || ch >= " ") this.insert(ch);
      return;
    }
    if (ch === "\r") {
      this.submitLine();
      return;
    }
    if (ch === "\n") {
      this.insert("\n");
      return;
    }
    if (ch === "\x7f") {
      if (this.search) {
        this.search.query = this.search.query.slice(0, -1);
        this.search.idx = this.history.length;
        this.findSearch(-1);
        return;
      }
      if (this.cursor > 0) {
        this.chars.splice(this.cursor - 1, 1);
        this.cursor--;
        this.slashIndex = 0;
        this.pickerSuppressed = false;
        this.schedule();
      }
      return;
    }
    if (ch === "\x12") {
      if (this.search) this.findSearch(-1);
      else this.enterSearch();
      return;
    }
    if (ch === "\x03") {
      if (this.search) {
        this.exitSearch(true);
        return;
      }
      if (this.busy) this.onInterrupt();
      else {
        this.chars = [];
        this.cursor = 0;
        this.slashIndex = 0;
        this.histIndex = -1;
        this.pickerSuppressed = false;
        this.schedule();
      }
      return;
    }
    if (ch === "\x02") {
      this.cursor = Math.max(0, this.cursor - 1);
      this.schedule();
      return;
    }
    if (ch === "\x06") {
      this.cursor = Math.min(this.chars.length, this.cursor + 1);
      this.schedule();
      return;
    }
    if (ch === "\x04") {
      if (this.cursor < this.chars.length) this.chars.splice(this.cursor, 1);
      else if (this.chars.length === 0) this.onExit();
      this.schedule();
      return;
    }
    if (ch === "\x0b") {
      this.chars.splice(this.cursor, this.lineEnd() - this.cursor);
      this.schedule();
      return;
    }
    if (ch === "\x0c") {
      this.openModelPicker();
      return;
    }
    if (ch === "\x10") {
      this.cycleModel(1);
      return;
    }
    if (ch === "\t") {
      if (this.rawInput) return;
      const { text, cursor } = this.textAndCursor();
      if (!text.trimStart().startsWith("/") && this.fileMatches) {
        const mention = fileMentionAt(text, cursor);
        if (mention) {
          const next = completeFileMention(text, cursor, this.fileMatches(mention.query));
          if (next) this.setTextCursor(next.text, next.cursor);
          this.slashIndex = 0;
          this.schedule();
          return;
        }
      }
      const next = completeSlashLine(text, this.commands, this.modelRows, this.effortRows);
      this.chars = splitGraphemes(next);
      this.cursor = this.chars.length;
      this.slashIndex = 0;
      this.schedule();
      return;
    }
    if (ch === "\x01") {
      this.cursor = this.lineStart();
      this.schedule();
      return;
    }
    if (ch === "\x05") {
      this.cursor = this.lineEnd();
      this.schedule();
      return;
    }
    if (ch === "\x15") {
      const start = this.lineStart();
      this.chars.splice(start, this.cursor - start);
      this.cursor = start;
      this.slashIndex = 0;
      this.schedule();
      return;
    }
    if (ch === "\x17") {
      this.deleteWord(-1);
      this.schedule();
      return;
    }
    if (ch < " ") return;
    if (this.search) {
      this.search.query += ch;
      this.search.idx = this.history.length;
      this.findSearch(-1);
      return;
    }
    this.insert(ch);
  }

  private insert(ch: string): void {
    this.chars.splice(this.cursor, 0, ch);
    const prefix = this.chars.slice(0, this.cursor + 1).join("");
    const rest = this.chars.slice(this.cursor + 1).join("");
    const prefixGs = splitGraphemes(prefix);
    this.chars = [...prefixGs, ...splitGraphemes(rest)];
    this.cursor = prefixGs.length;
    this.slashIndex = 0;
    this.histIndex = -1;
    this.pickerSuppressed = false;
    this.schedule();
  }

  private lineStart(): number {
    if (this.cursor <= 0) return 0;
    return this.chars.lastIndexOf("\n", this.cursor - 1) + 1;
  }

  private lineEnd(): number {
    const end = this.chars.indexOf("\n", this.cursor);
    return end < 0 ? this.chars.length : end;
  }

  private moveWord(direction: -1 | 1): void {
    if (direction < 0) {
      while (this.cursor > 0 && /\s/.test(this.chars[this.cursor - 1]!)) this.cursor--;
      while (this.cursor > 0 && !/\s/.test(this.chars[this.cursor - 1]!)) this.cursor--;
    } else {
      while (this.cursor < this.chars.length && /\s/.test(this.chars[this.cursor]!)) this.cursor++;
      while (this.cursor < this.chars.length && !/\s/.test(this.chars[this.cursor]!)) this.cursor++;
    }
  }

  private deleteWord(direction: -1 | 1): void {
    const from = this.cursor;
    this.moveWord(direction);
    const start = Math.min(from, this.cursor);
    this.chars.splice(start, Math.abs(from - this.cursor));
    this.cursor = start;
    this.slashIndex = 0;
  }

  private openModelPicker(): void {
    if (this.modelRows.length === 0) {
      this.onSubmit("/models");
      return;
    }
    this.pickerSuppressed = false;
    this.search = null;
    this.chars = splitGraphemes("/models");
    this.cursor = this.chars.length;
    this.slashIndex = Math.max(0, this.modelRows.findIndex((row) => row.name === this.model));
    this.schedule();
  }

  private cycleModel(direction: -1 | 1): void {
    if (this.modelRows.length === 0) return;
    const current = this.modelRows.findIndex((row) => row.name === this.model);
    const base = current >= 0 ? current : direction > 0 ? -1 : 0;
    const index = (base + direction + this.modelRows.length) % this.modelRows.length;
    const command = this.modelRows[index]?.submit;
    if (command) this.onSubmit(command);
  }

  private cycleEffort(): void {
    if (this.effortRows.length === 0) return;
    const current = this.effortRows.findIndex((row) => row.name === this.effort);
    const index = (current + 1 + this.effortRows.length) % this.effortRows.length;
    const command = this.effortRows[index]?.submit;
    if (command) this.onSubmit(command);
  }

  private applyCsi(params: string, final: string): void {
    if (params.startsWith("<") && (final === "M" || final === "m")) {
      const btn = Number(params.slice(1).split(";")[0] || "0");
      if (btn === 64) this.scrollLines(1);
      else if (btn === 65) this.scrollLines(-1);
      return;
    }
    if (this.paste) {
      if (params === "201") {
        this.paste = false;
        this.schedule();
      } else if (params === "200") this.paste = true;
      return;
    }
    if (final === "~") {
      if (params === "200") this.paste = true;
      else if (params === "201") this.onHostRefresh?.();
      else if (params === "3") {
        if (this.cursor < this.chars.length) this.chars.splice(this.cursor, 1);
      } else if (params === "3;3") this.deleteWord(1);
      else if (params === "5") this.scrollPages(1);
      else if (params === "6") this.scrollPages(-1);
      this.schedule();
      return;
    }
    if (final === "Z") {
      this.cycleEffort();
      return;
    }
    if (final === "u") {
      if (params === "13;2" || params === "13;3") this.insert("\n");
      else if (params === "9;2") this.cycleEffort();
      else if (params === "112;6") this.cycleModel(-1);
      return;
    }
    const n = Number.parseInt(params || "1", 10) || 1;
    const word = params.endsWith(";3") || params.endsWith(";5");
    if (final === "A") this.moveUp(n);
    else if (final === "B") this.moveDown(n);
    else if (final === "C") {
      if (word) this.moveWord(1);
      else this.cursor = Math.min(this.chars.length, this.cursor + n);
    } else if (final === "D") {
      if (word) this.moveWord(-1);
      else this.cursor = Math.max(0, this.cursor - n);
    } else if (final === "H") this.cursor = this.lineStart();
    else if (final === "F") {
      if (this.scroll > 0 && this.cursor === this.lineEnd()) {
        this.scroll = 0;
        this.follow = true;
      } else this.cursor = this.lineEnd();
    }
    this.schedule();
  }

  private moveUp(n: number): void {
    if (this.histIndex >= 0) {
      this.historyBy(-n);
      return;
    }
    const matches = this.matches();
    if (matches.length > 0) {
      this.slashIndex = Math.max(0, this.slashIndex - n);
      return;
    }
    if (!this.moveVertical(-n)) this.historyBy(-n);
  }

  private moveDown(n: number): void {
    if (this.histIndex >= 0) {
      this.historyBy(n);
      return;
    }
    const matches = this.matches();
    if (matches.length > 0) {
      this.slashIndex = Math.min(matches.length - 1, this.slashIndex + n);
      return;
    }
    if (!this.moveVertical(n)) this.historyBy(n);
  }

  private lineScreenCol(start: number, cursor: number): number {
    const prefix = start === 0 ? cellWidth(INPUT_PREFIX) : 0;
    return prefix + cellWidth(this.chars.slice(start, cursor).join(""));
  }

  private cursorAtScreenCol(start: number, end: number, screenCol: number): number {
    const prefix = start === 0 ? cellWidth(INPUT_PREFIX) : 0;
    const want = Math.max(0, screenCol - prefix);
    let used = 0;
    for (let i = start; i < end; i++) {
      const w = cellWidth(this.chars[i]!);
      if (used + w > want) return i;
      used += w;
      if (used === want) return i + 1;
    }
    return end;
  }

  private moveVertical(delta: number): boolean {
    let moved = false;
    for (let step = 0; step < Math.abs(delta); step++) {
      const start = this.lineStart();
      const end = this.lineEnd();
      const screenCol = this.lineScreenCol(start, this.cursor);
      if (delta < 0) {
        if (start === 0) break;
        const previousEnd = start - 1;
        const previousStart = previousEnd <= 0 ? 0 : this.chars.lastIndexOf("\n", previousEnd - 1) + 1;
        this.cursor = this.cursorAtScreenCol(previousStart, previousEnd, screenCol);
      } else {
        if (end === this.chars.length) break;
        const nextStart = end + 1;
        const nextBreak = this.chars.indexOf("\n", nextStart);
        const nextEnd = nextBreak < 0 ? this.chars.length : nextBreak;
        this.cursor = this.cursorAtScreenCol(nextStart, nextEnd, screenCol);
      }
      moved = true;
    }
    return moved;
  }

  private historyBy(delta: number): void {
    if (this.search || this.history.length === 0) return;
    if (this.histIndex < 0) this.draft = this.chars.join("");
    const next = this.histIndex < 0 ? this.history.length - 1 : this.histIndex + delta;
    if (next < 0) {
      this.histIndex = 0;
    } else if (next >= this.history.length) {
      this.histIndex = -1;
      this.chars = splitGraphemes(this.draft);
      this.cursor = this.chars.length;
      return;
    } else {
      this.histIndex = next;
    }
    this.chars = splitGraphemes(this.history[this.histIndex] ?? "");
    this.cursor = this.chars.length;
  }

  private scrollLines(lines: number): void {
    const { cols, rows } = this.size();
    const matches = this.matches();
    const inputLines = Math.max(1, this.composerInput(cols).wrapped.length || 1);
    const layout = layoutHeights(rows, inputLines, matches.length);
    const extra = Math.max(1, Math.abs(lines));
    const wrapped = this.visibleTranscript(cols, layout.transcript + this.scroll + extra + 2, 0);
    const maxScroll = Math.max(0, wrapped.length - layout.transcript);
    this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + lines));
    this.follow = this.scroll === 0;
    this.schedule();
  }

  private scrollPages(pages: number): void {
    const { cols, rows } = this.size();
    const matches = this.matches();
    const inputLines = Math.max(1, this.composerInput(cols).wrapped.length || 1);
    const layout = layoutHeights(rows, inputLines, matches.length);
    const page = Math.max(1, layout.transcript - 1);
    this.scrollLines(pages * page);
  }

  private render(): void {
    if (!this.started) return;
    const size = this.size();
    const built = this.buildFrame(size);
    const { cols, rows } = size;
    const reset = !this.lastPainted || this.lastDim.cols !== cols || this.lastDim.rows !== rows;
    let tty = "\x1b[?2026h";
    if (reset) tty += "\x1b[2J";
    for (let i = 0; i < rows; i++) {
      const line = built.painted[i] ?? "";
      if (!reset && this.lastPainted && this.lastPainted[i] === line) continue;
      tty += `\x1b[${i + 1};1H\x1b[0m\x1b[2K${line}`;
    }
    tty += `\x1b[${built.cursorRow};${built.cursorCol}H\x1b[?25h\x1b[?2026l`;
    this.lastPainted = built.painted;
    this.lastDim = { cols, rows };
    this.out.write(tty);
  }

  private buildFrame(size: { cols: number; rows: number }): {
    text: string;
    painted: string[];
    cursorRow: number;
    cursorCol: number;
  } {
    const { cols, rows } = size;
    const matches = this.matches();
    if (this.slashIndex >= matches.length) this.slashIndex = Math.max(0, matches.length - 1);
    const { wrapped: inputWrapped, pos } = this.composerInput(cols);
    const layout = layoutHeights(rows, Math.max(1, inputWrapped.length), matches.length);
    const slashStart = Math.max(
      0,
      Math.min(this.slashIndex - layout.slash + 1, Math.max(0, matches.length - layout.slash)),
    );
    const shownSlash = matches.slice(slashStart, slashStart + layout.slash);
    const view = this.visibleSlice(cols, layout.transcript, this.scroll);
    const spin = this.busy ? SPIN[this.spin]! : "";
    const imageN = this.pendingImageCount;
    const images = imageN > 0 ? `${imageN} img` : "";
    const permLabel = this.permissions ? `perm ${this.permissions}` : "";
    const modelLabel = this.model ? `${spin ? `${spin} ` : ""}${this.model}` : spin ? `${spin} no model` : "no model";
    let queuedLabel = this.queued ? `queued ${truncateMiddle(this.queued, 18)}` : "";
    // Model and effort are one visual group. Reserve the effort suffix before
    // truncating a long model so narrow terminals never hide the active level.
    let extraParts = [permLabel, images, queuedLabel].filter(Boolean);
    const separator = "  ·  ";
    const modelSuffix = ` · ${this.effort}`;
    const fixedTitleCells = (parts: string[]): number =>
      cellWidth("▸ termina") +
      cellWidth(separator) +
      cellWidth(modelSuffix) +
      parts.reduce((sum, part) => sum + cellWidth(separator) + cellWidth(part), 0) +
      3; // outer spaces plus the minimum left/right gap
    let fixedCells = fixedTitleCells(extraParts);
    // Queued text is context, while the queued state is a control. Collapse
    // the summary before it can clip the control.
    if (queuedLabel && fixedCells >= cols) {
      queuedLabel = "queued";
      extraParts = [permLabel, images, queuedLabel].filter(Boolean);
      fixedCells = fixedTitleCells(extraParts);
    }
    const visibleModel = truncateMiddle(modelLabel, Math.max(1, cols - fixedCells));
    const leftParts = [`▸ termina`, `${visibleModel}${modelSuffix}`, ...extraParts];
    const leftTitle = leftParts.join(separator);
    const gap = Math.max(1, cols - cellWidth(leftTitle) - 2);
    const title = ` ${leftTitle}${" ".repeat(gap)} `;
    const bashInput = this.chars[0] === "!" && !this.choicePrompt && !this.rawInput;

    // Placeholder when the prompt is empty
    const isInputEmpty = this.chars.length === 0 && !this.choicePrompt && !this.search && !this.rawInput;
    const INPUT_PLACEHOLDER = "Type a task…  @ files  ·  / commands  ·  ! bash";
    let displayWrapped = inputWrapped;
    let displayPos = pos;
    if (isInputEmpty) {
      displayWrapped = wrapText(INPUT_PREFIX + INPUT_PLACEHOLDER, inputWrapWidth(cols));
    }

    const lines: string[] = [];
    if (this.entries.length === 0 && !this.busy && this.scroll === 0) {
      const empty = wrapText(EMPTY_STATE_TEXT, cols);
      for (let i = 0; i < layout.transcript; i++) lines.push(clip(empty[i] ?? "", cols));
    } else {
      for (let i = 0; i < layout.transcript; i++) lines.push(clip(view.rows[i] ?? "", cols));
    }
    // The composer is a bordered box: top border, content rows, bottom
    // border. It reads as one textbox separated from the transcript above
    // and the slash menu, title, and usage below.
    const inputTop = layout.transcript;
    const inputShown = displayWrapped.slice(0, layout.input);
    lines.push(boxBorderRow(cols, "┌", "─", "┐"));
    for (let i = 0; i < layout.input; i++) lines.push(boxContentRow(inputShown[i] ?? "", cols));
    lines.push(boxBorderRow(cols, "└", "─", "┘"));
    for (let i = 0; i < layout.slash; i++) {
      const c = shownSlash[i];
      const selected = slashStart + i === this.slashIndex;
      const row = c ? formatPickerRow(c.name, c.hint, cols, selected) : "";
      lines.push(clip(row, cols));
    }
    while (lines.length < rows - layout.header - 2) lines.push(clip("", cols));
    lines.push(clip("─".repeat(Math.max(0, cols)), cols));
    lines.push(clip(title, cols));
    if (layout.header === 2) {
      const usageLine = this.usage ? `  ${this.usage}` : "  idle — waiting for a task";
      lines.push(clip(usageLine, cols));
    }
    if (lines.length > rows) lines.length = rows;

    const contentTop = inputTop + 1;
    // Content sits inside "│ ": cursor columns shift two cells right, rows
    // one row down. Placeholder caret stays right after "> ". cursorRow is a
    // 1-based terminal row: the last content row is contentTop + layout.input.
    const cursorRow = isInputEmpty
      ? Math.min(rows, Math.max(1, contentTop + 1))
      : Math.min(rows, Math.max(1, Math.min(contentTop + layout.input, contentTop + displayPos.row + 1)));
    const cursorCol = isInputEmpty ? 5 : Math.min(cols, Math.max(1, displayPos.col + 3));
    const slashTop = contentTop + layout.input + 1;
    const titleRow = lines.length - layout.header;
    const painted: string[] = [];
    for (let i = 0; i < rows; i++) {
      const raw = lines[i] ?? clip("", cols);
      if (i === titleRow) painted.push(`\x1b[30;104m${raw}\x1b[0m`);
      else if (i === rows - 1 || i === titleRow - 1 || (layout.header === 2 && i === titleRow + 1)) {
        painted.push(`\x1b[90m${raw}\x1b[0m`);
      } else if (i === inputTop || i === contentTop + layout.input) {
        // Composer box borders.
        painted.push(`\x1b[90m${raw}\x1b[0m`);
      } else if (i >= slashTop && i < slashTop + layout.slash) {
        const si = i - slashTop;
        painted.push(si === this.slashIndex - slashStart ? `\x1b[30;104m${raw}\x1b[0m` : `\x1b[90m${raw}\x1b[0m`);
      } else if (i === contentTop && isInputEmpty) {
        // Dim the placeholder row inside the box.
        painted.push(`\x1b[90m${raw}\x1b[0m`);
      } else if (i >= contentTop && i < contentTop + layout.input) {
        // Bang commands are local shell execution, not agent prompts. Give the
        // whole composer a distinct amber treatment while the command is typed.
        painted.push(bashInput ? `\x1b[1;38;5;229;48;5;58m${raw}\x1b[0m` : raw);
      } else if (i < layout.transcript) {
        if (this.entries.length === 0 && !this.busy) painted.push(`\x1b[90m${raw}\x1b[0m`);
        else painted.push(view.painted[i] ?? `\x1b[0m${raw}\x1b[0m`);
      }
      else painted.push(raw);
    }
    return { text: lines.join("\n"), painted, cursorRow, cursorCol };
  }
}
