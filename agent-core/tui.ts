/**
 * Full-screen TUI for agent-core. The kernel writes transcript text; this
 * module owns layout, input, the slash menu, and the tty restore.
 */
import { loginPickerItems } from "./auth.ts";

export type SlashCommand = { name: string; hint: string; submit?: string };

/** `/help` first and `/exit` last so Enter on a bare slash is safe. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", hint: "list commands" },
  { name: "/login", hint: "pick a provider" },
  { name: "/logout", hint: "drop a stored credential" },
  { name: "/model", hint: "show or switch the model" },
  { name: "/models", hint: "list live models" },
  { name: "/resume", hint: "replay the stored session" },
  { name: "/clear", hint: "start a new empty session" },
  { name: "/compact", hint: "reclaim and summarize context" },
  { name: "/effort", hint: "show or set reasoning effort" },
  { name: "/permissions", hint: "set bash approval policy" },
  { name: "/exit", hint: "quit the engine" },
];

export const PERMISSION_COMMANDS: SlashCommand[] = [
  { name: "Always ask", hint: "ask before every bash command", submit: "/permissions ask" },
  { name: "Ask on dangerous requests", hint: "ask before recognized destructive commands", submit: "/permissions dangerous" },
  { name: "Always approve", hint: "run bash without asking", submit: "/permissions always" },
];

const EFFORT_HINTS: Record<string, string> = {
  off: "disable reasoning",
  minimal: "use minimal reasoning effort",
  low: "use low reasoning effort",
  medium: "use medium reasoning effort",
  high: "use high reasoning effort",
  xhigh: "use extra-high reasoning effort",
  max: "use maximum reasoning effort",
};

function effortCommandRows(levels: readonly string[] = Object.keys(EFFORT_HINTS)): SlashCommand[] {
  return levels.map((level) => ({
    name: level,
    hint: EFFORT_HINTS[level] ?? "use this reasoning effort",
    submit: `/effort ${level}`,
  }));
}

function authCommandRows(cmd: "/login" | "/logout"): SlashCommand[] {
  return loginPickerItems(cmd).map((m) => ({
    name: m.label,
    hint: m.hint,
    submit: m.command,
  }));
}

export function authRowMatches(line: string, rowName: string): boolean {
  if (rowName.startsWith(line)) return true;
  const space = line.indexOf(" ");
  if (space < 0) return false;
  const cmd = line.slice(0, space);
  if (cmd !== "/login" && cmd !== "/logout") return false;
  if (!rowName.startsWith(`${cmd} `)) return false;
  const rest = line.slice(space + 1).trim().toLowerCase();
  if (!rest) return true;
  const rowRest = rowName.slice(cmd.length + 1).toLowerCase();
  if (rowRest.startsWith(rest)) return true;
  const tokens = rest.split(/\s+/);
  const kind = tokens[0];
  if (kind !== "oauth" && kind !== "key") return false;
  const group = tokens[1] ?? "";
  const [rowGroup, rowKind] = rowRest.split(/\s+/);
  if (rowKind !== kind) return false;
  return !group || (rowGroup ?? "").startsWith(group);
}

function pickerRowMatches(line: string, row: SlashCommand): boolean {
  const command = row.submit ?? row.name;
  if (authRowMatches(line, command)) return true;
  const space = line.indexOf(" ");
  if (space < 0) return false;
  const rest = line.slice(space + 1).trim().toLowerCase();
  if (!rest) return true;
  const label = row.name.toLowerCase();
  if (label.startsWith(rest)) return true;
  // Token prefix so "/login a" matches Anthropic, not OpenAI.
  return label.split(/[\s()/]+/).filter(Boolean).some((token) => token.startsWith(rest));
}

export function matchingSlashCommands(
  line: string,
  commands: SlashCommand[] = SLASH_COMMANDS,
  modelRows: SlashCommand[] = [],
  effortRows: SlashCommand[] = effortCommandRows(),
): SlashCommand[] {
  if (!line.startsWith("/")) return [];
  const space = line.indexOf(" ");
  const head = space < 0 ? line : line.slice(0, space);
  if (head === "/login" || head === "/logout") {
    if (space < 0 && line !== "/login" && line !== "/logout") {
      return commands.filter((c) => c.name.startsWith(line));
    }
    const rows = authCommandRows(head);
    if (space < 0) return rows;
    return rows.filter((c) => pickerRowMatches(line, c));
  }
  if (head === "/models") {
    if (space < 0 && line !== "/models") {
      return commands.filter((c) => c.name.startsWith(line));
    }
    if (modelRows.length === 0) {
      return space < 0 ? commands.filter((c) => c.name === "/models") : [];
    }
    if (space < 0) return modelRows;
    const rest = line.slice(space + 1).trim().toLowerCase();
    if (!rest) return modelRows;
    return modelRows.filter((c) => pickerRowMatches(`/model ${rest}`, c));
  }
  if (head === "/effort") {
    if (space < 0 && line !== "/effort") {
      return commands.filter((c) => c.name.startsWith(line));
    }
    if (space < 0) return effortRows;
    return effortRows.filter((c) => pickerRowMatches(line, c));
  }
  if (head === "/permissions") {
    if (space < 0 && line !== "/permissions") {
      return commands.filter((c) => c.name.startsWith(line));
    }
    if (space < 0) return PERMISSION_COMMANDS;
    const exact = PERMISSION_COMMANDS.find((c) => c.submit === line);
    return exact ? [exact] : PERMISSION_COMMANDS.filter((c) => pickerRowMatches(line, c));
  }
  if (space >= 0) return [];
  return commands.filter((c) => c.name.startsWith(line));
}

export function completeSlashLine(
  line: string,
  commands: SlashCommand[] = SLASH_COMMANDS,
  modelRows: SlashCommand[] = [],
  effortRows: SlashCommand[] = effortCommandRows(),
): string {
  const matches = matchingSlashCommands(line, commands, modelRows, effortRows);
  if (matches.length === 0) return line;
  if (matches.length === 1) {
    if (matches[0]!.submit) return line;
    return matches[0]!.name;
  }
  const names = matches.map((m) => m.submit ?? m.name);
  let prefix = names[0]!;
  for (const m of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < m.length && prefix[i] === m[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.length > line.length ? prefix : line;
}

export function wrapText(text: string, width: number): string[] {
  const cols = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const units = [...raw];
    if (units.length === 0) {
      out.push("");
      continue;
    }
    for (let i = 0; i < units.length; i += cols) out.push(units.slice(i, i + cols).join(""));
  }
  return out;
}

/** Wrap only a tail big enough to fill the window. Streaming must not rewrap the whole log. */
export function visibleLines(plain: string, cols: number, rowCount: number, scroll: number): string[] {
  const colsN = Math.max(1, cols);
  const rowsN = Math.max(0, rowCount);
  const scrollN = Math.max(0, scroll);
  const need = (rowsN + scrollN + 2) * colsN + 2;
  let slice = plain;
  if (plain.length > need) {
    slice = plain.slice(plain.length - need);
    const lead = slice.charCodeAt(0);
    if (lead >= 0xdc00 && lead <= 0xdfff) slice = slice.slice(1);
  }
  const wrapped = wrapText(slice, colsN);
  const end = Math.max(0, wrapped.length - scrollN);
  const start = Math.max(0, end - rowsN);
  return wrapped.slice(start, end);
}

export function layoutHeights(
  rows: number,
  inputLines: number,
  slashCount: number,
): { header: number; transcript: number; input: number; slash: number; footer: number } {
  const header = rows >= 6 ? 2 : 1;
  const footer = 1;
  const sep = 1;
  const minTranscript = 1;
  let slash = Math.max(0, slashCount);
  let input = Math.max(1, inputLines);
  const budget = Math.max(4, rows);
  while (header + sep + minTranscript + input + slash + footer > budget && slash > 0) slash--;
  while (header + sep + minTranscript + input + slash + footer > budget && input > 1) input--;
  const used = header + sep + input + slash + footer;
  return { header, transcript: Math.max(minTranscript, budget - used), input, slash, footer };
}

function unitsLen(text: string): number {
  return [...text].length;
}

function clip(text: string, cols: number): string {
  const units = [...text];
  if (units.length === cols) return text;
  if (units.length > cols) return units.slice(0, cols).join("");
  return text + " ".repeat(cols - units.length);
}

function cursorRowCol(prefix: string, chars: string[], cursor: number, cols: number): { row: number; col: number } {
  const n = unitsLen(prefix) + chars.slice(0, cursor).length;
  if (n === 0) return { row: 0, col: 0 };
  if (n % cols === 0) return { row: n / cols, col: 0 };
  return { row: Math.floor(n / cols), col: n % cols };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_TRANSCRIPT = 400_000;
const MAX_HISTORY = 100;
const MAX_CSI = 32;

export type TuiIO = {
  write(s: string): unknown;
  columns?: number;
  rows?: number;
  isTTY?: boolean;
  on?(event: string, fn: () => void): unknown;
  off?(event: string, fn: () => void): unknown;
};

export type TuiInput = {
  isTTY?: boolean;
  setRawMode?(v: boolean): unknown;
  resume?(): unknown;
  on?(event: string, fn: (chunk: Buffer | string) => void): unknown;
  off?(event: string, fn: (chunk: Buffer | string) => void): unknown;
};

export class AgentTui {
  private readonly out: TuiIO;
  private readonly inp: TuiInput;
  private readonly commands: SlashCommand[];
  private readonly onSubmit: (line: string) => void;
  private readonly onInterrupt: () => void;
  private readonly onExit: () => void;
  private started = false;
  private plain = "";
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
  private auth = "";
  private effort = "off";
  private usage = "";
  private pendingImages: () => number = () => 0;
  private busy = false;
  private spin = 0;
  private spinTimer: ReturnType<typeof setInterval> | null = null;
  private paintTimer: ReturnType<typeof setTimeout> | null = null;
  private onResize: (() => void) | null = null;
  private onData: ((chunk: Buffer | string) => void) | null = null;
  private decoder = new TextDecoder("utf8");
  private lastPainted: string[] | null = null;
  private lastDim = { cols: 0, rows: 0 };
  private modelRows: SlashCommand[] = [];
  private effortRows: SlashCommand[] = effortCommandRows();
  private choicePrompt = "";
  private choiceRows: SlashCommand[] = [];
  private choiceDraft: { chars: string[]; cursor: number } | null = null;

  constructor(opts: {
    stdout: TuiIO;
    stdin: TuiInput;
    commands?: SlashCommand[];
    onSubmit: (line: string) => void;
    onInterrupt: () => void;
    onExit: () => void;
    pendingImages?: () => number;
  }) {
    this.out = opts.stdout;
    this.inp = opts.stdin;
    this.commands = opts.commands ?? SLASH_COMMANDS;
    this.onSubmit = opts.onSubmit;
    this.onInterrupt = opts.onInterrupt;
    this.onExit = opts.onExit;
    if (opts.pendingImages) this.pendingImages = opts.pendingImages;
  }

  active(): boolean {
    return this.started;
  }

  setStatus(status: { model?: string; auth?: string; effort?: string; usage?: string }): void {
    if (status.model !== undefined) this.model = status.model;
    if (status.auth !== undefined) this.auth = status.auth;
    if (status.effort !== undefined) this.effort = status.effort;
    if (status.usage !== undefined) this.usage = status.usage;
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
    this.chars = [...text];
    this.cursor = this.chars.length;
    this.slashIndex = 0;
    this.histIndex = -1;
    this.draft = "";
    this.schedule();
  }

  append(text: string): void {
    if (!text) return;
    this.plain += stripAnsi(text);
    if (this.plain.length > MAX_TRANSCRIPT) {
      const cut = this.plain.slice(-MAX_TRANSCRIPT);
      const lead = cut.charCodeAt(0);
      const trimmed = lead >= 0xdc00 && lead <= 0xdfff ? cut.slice(1) : cut;
      const nl = trimmed.indexOf("\n");
      this.plain = nl === -1 ? trimmed : trimmed.slice(nl + 1);
    }
    if (this.follow) this.scroll = 0;
    this.schedule();
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
    this.out.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?7l\x1b[?1006h\x1b[?1000h");
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
    this.out.write("\x1b[?2026l\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?2004l\x1b[?25h\x1b[?1049l");
  }

  /** Visible frame without tty side effects. Tests use this. */
  frame(): string {
    return this.buildFrame(this.size()).text;
  }

  feed(text: string): void {
    if (text === "\x1b") {
      this.esc = 0;
      if (this.choiceRows.length > 0) {
        this.clearChoices();
        this.onInterrupt();
      } else if (this.matches().length > 0) {
        this.chars = [];
        this.cursor = 0;
        this.slashIndex = 0;
        this.schedule();
      } else this.onInterrupt();
      return;
    }
    for (const ch of text) this.handleChar(ch);
  }

  private size(): { cols: number; rows: number } {
    return { cols: Math.max(1, this.out.columns ?? 80), rows: Math.max(1, this.out.rows ?? 24) };
  }

  private startSpin(): void {
    if (this.spinTimer || !this.started) return;
    this.spinTimer = setInterval(() => {
      this.spin = (this.spin + 1) % SPIN.length;
      this.render();
    }, 80);
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

  private matches(): SlashCommand[] {
    if (this.rawInput) return [];
    if (this.choiceRows.length > 0) return this.choiceRows;
    return matchingSlashCommands(this.chars.join(""), this.commands, this.modelRows, this.effortRows);
  }

  private submitLine(): void {
    const typed = this.chars.join("");
    const wasChoice = this.choiceRows.length > 0;
    const matches = this.rawInput ? [] : this.matches();
    let line = typed.trim();
    let echo = line;
    if (matches.length > 0) {
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
    if (
      !this.rawInput &&
      (line === "/login" ||
        line === "/logout" ||
        line === "/permissions" ||
        (line === "/models" && this.modelRows.length > 0))
    ) {
      this.chars = [...line];
      this.cursor = this.chars.length;
      this.slashIndex = 0;
      this.histIndex = -1;
      this.draft = "";
      this.schedule();
      return;
    }
    this.chars = [];
    this.cursor = 0;
    this.slashIndex = 0;
    this.histIndex = -1;
    this.draft = "";
    if (wasChoice) this.clearChoices();
    if (!wasChoice && line && (this.history.length === 0 || this.history[this.history.length - 1] !== line)) {
      this.history.push(line);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.follow = true;
    this.scroll = 0;
    if (line) this.append(`\n> ${echo}\n`);
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
      else if (ch === "\r") this.submitLine();
      this.schedule();
      return;
    }
    if (this.esc === 3) {
      if (ch === "H") this.cursor = this.lineStart();
      else if (ch === "F") this.cursor = this.lineEnd();
      this.esc = 0;
      this.schedule();
      return;
    }
    if (this.esc === 2) {
      if (this.csi.length === 0 && ch === "<") {
        this.csi = "<";
        return;
      }
      if ((ch >= "0" && ch <= "9") || ch === ";") {
        if (this.csi.length < MAX_CSI) this.csi += ch;
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
      if (this.cursor > 0) {
        this.chars.splice(this.cursor - 1, 1);
        this.cursor--;
        this.slashIndex = 0;
        this.schedule();
      }
      return;
    }
    if (ch === "\x03") {
      if (this.busy) this.onInterrupt();
      else {
        this.chars = [];
        this.cursor = 0;
        this.slashIndex = 0;
        this.histIndex = -1;
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
      const next = completeSlashLine(this.chars.join(""), this.commands, this.modelRows, this.effortRows);
      this.chars = [...next];
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
    this.insert(ch);
  }

  private insert(ch: string): void {
    this.chars.splice(this.cursor, 0, ch);
    this.cursor++;
    this.slashIndex = 0;
    this.histIndex = -1;
    this.schedule();
  }

  private lineStart(): number {
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
    this.chars = [..."/models"];
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
      if (btn === 64) this.scrollBy(1);
      else if (btn === 65) this.scrollBy(-1);
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
      else if (params === "201") this.paste = false;
      else if (params === "3") {
        if (this.cursor < this.chars.length) this.chars.splice(this.cursor, 1);
      } else if (params === "3;3") this.deleteWord(1);
      else if (params === "5") this.scrollBy(1);
      else if (params === "6") this.scrollBy(-1);
      this.schedule();
      return;
    }
    if (final === "Z") {
      this.cycleEffort();
      return;
    }
    if (final === "u") {
      if (params === "13;2") this.insert("\n");
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
    else if (final === "F") this.cursor = this.lineEnd();
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

  private moveVertical(delta: number): boolean {
    let moved = false;
    for (let step = 0; step < Math.abs(delta); step++) {
      const start = this.lineStart();
      const end = this.lineEnd();
      const col = this.cursor - start;
      if (delta < 0) {
        if (start === 0) break;
        const previousEnd = start - 1;
        const previousStart = this.chars.lastIndexOf("\n", previousEnd - 1) + 1;
        this.cursor = Math.min(previousStart + col, previousEnd);
      } else {
        if (end === this.chars.length) break;
        const nextStart = end + 1;
        const nextBreak = this.chars.indexOf("\n", nextStart);
        const nextEnd = nextBreak < 0 ? this.chars.length : nextBreak;
        this.cursor = Math.min(nextStart + col, nextEnd);
      }
      moved = true;
    }
    return moved;
  }

  private historyBy(delta: number): void {
    if (this.history.length === 0) return;
    if (this.histIndex < 0) this.draft = this.chars.join("");
    const next = this.histIndex < 0 ? this.history.length - 1 : this.histIndex + delta;
    if (next < 0) {
      this.histIndex = 0;
    } else if (next >= this.history.length) {
      this.histIndex = -1;
      this.chars = [...this.draft];
      this.cursor = this.chars.length;
      return;
    } else {
      this.histIndex = next;
    }
    this.chars = [...(this.history[this.histIndex] ?? "")];
    this.cursor = this.chars.length;
  }

  private scrollBy(pages: number): void {
    const { cols, rows } = this.size();
    const inputText = `> ${this.chars.join("")}`;
    const matches = this.matches();
    const inputLines = Math.max(1, wrapText(inputText, cols).length || 1);
    const layout = layoutHeights(rows, inputLines, matches.length);
    const wrapped = wrapText(this.plain.length > (layout.transcript + this.scroll + 2) * cols
      ? this.plain.slice(-(layout.transcript + this.scroll + 2) * cols)
      : this.plain, cols);
    const maxScroll = Math.max(0, wrapped.length - layout.transcript);
    this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + pages * Math.max(1, layout.transcript - 1)));
    this.follow = this.scroll === 0;
    this.schedule();
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
    const inputText = this.choicePrompt || `> ${this.chars.join("")}`;
    const matches = this.matches();
    if (this.slashIndex >= matches.length) this.slashIndex = Math.max(0, matches.length - 1);
    const inputWrapped = wrapText(inputText, cols);
    const layout = layoutHeights(rows, Math.max(1, inputWrapped.length), matches.length);
    const slashStart = Math.max(
      0,
      Math.min(this.slashIndex - layout.slash + 1, Math.max(0, matches.length - layout.slash)),
    );
    const shownSlash = matches.slice(slashStart, slashStart + layout.slash);
    const view = visibleLines(this.plain, cols, layout.transcript, this.scroll);
    const nameW = shownSlash.length > 0 ? Math.max(...shownSlash.map((c) => c.name.length)) : 0;
    const spin = this.busy ? `${SPIN[this.spin]!} ` : "";
    const imageN = this.pendingImages();
    const images = imageN > 0 ? `  ${imageN} image${imageN === 1 ? "" : "s"}` : "";
    const title = ` termina agent-core v1  ${spin}effort ${this.effort}  ${this.model}${this.auth ? `  ${this.auth}` : ""}${images} `;
    const picker = matches.length > 0 && Boolean(matches[0]?.submit);
    const foot = picker
      ? " ↑↓ pick · Enter select · Ctrl+C cancel "
      : this.busy
        ? " Ctrl+C interrupt · PgUp/PgDn scroll "
        : " / commands · Tab complete · Ctrl+J newline · PgUp/PgDn scroll · Ctrl+C clear ";

    const lines: string[] = [];
    for (let i = 0; i < layout.transcript; i++) lines.push(clip(view[i] ?? "", cols));
    const inputShown = inputWrapped.slice(0, layout.input);
    for (let i = 0; i < layout.input; i++) lines.push(clip(inputShown[i] ?? "", cols));
    for (let i = 0; i < layout.slash; i++) {
      const c = shownSlash[i];
      const row = c ? `  ${c.name.padEnd(nameW)}  ${c.hint}` : "";
      lines.push(clip(row, cols));
    }
    while (lines.length < rows - layout.header - 2) lines.push(clip("", cols));
    lines.push(clip("─".repeat(Math.max(0, cols)), cols));
    lines.push(clip(title, cols));
    if (layout.header === 2) lines.push(clip(` ${this.usage}`, cols));
    lines.push(clip(foot, cols));
    if (lines.length > rows) lines.length = rows;

    const pos = this.choicePrompt
      ? { row: 0, col: Math.min(cols - 1, unitsLen(this.choicePrompt)) }
      : cursorRowCol("> ", this.chars, this.cursor, cols);
    const inputTop = layout.transcript;
    const cursorRow = Math.min(rows, Math.max(1, Math.min(inputTop + layout.input, inputTop + pos.row + 1)));
    const cursorCol = Math.min(cols, Math.max(1, pos.col + 1));
    const slashTop = inputTop + layout.input;
    const titleRow = rows - layout.header - 1;
    const painted: string[] = [];
    for (let i = 0; i < rows; i++) {
      const raw = lines[i] ?? clip("", cols);
      if (i === titleRow) painted.push(`\x1b[30;104m${raw}\x1b[0m`);
      else if (i === rows - 1 || i === titleRow - 1 || (layout.header === 2 && i === titleRow + 1)) {
        painted.push(`\x1b[90m${raw}\x1b[0m`);
      } else if (i >= slashTop && i < slashTop + layout.slash) {
        const si = i - slashTop;
        painted.push(si === this.slashIndex - slashStart ? `\x1b[30;104m${raw}\x1b[0m` : raw);
      } else painted.push(raw);
    }
    return { text: lines.join("\n"), painted, cursorRow, cursorCol };
  }
}
