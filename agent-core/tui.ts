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

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function splitGraphemes(text: string): string[] {
  if (!text) return [];
  return [...graphemeSegmenter.segment(text)].map((part) => part.segment);
}

function isCombiningCode(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function isWideCode(cp: number): boolean {
  if (cp >= 0x1f000 && cp <= 0x1ffff) return true;
  if (cp >= 0x2600 && cp <= 0x27bf) return true;
  if (cp >= 0x2e80 && cp <= 0xa4cf) return true;
  if (cp >= 0xac00 && cp <= 0xd7af) return true;
  if (cp >= 0xf900 && cp <= 0xfaff) return true;
  if (cp >= 0xfe10 && cp <= 0xfe19) return true;
  if (cp >= 0xfe30 && cp <= 0xfe6f) return true;
  if (cp >= 0xff01 && cp <= 0xff60) return true;
  if (cp >= 0xffe0 && cp <= 0xffe6) return true;
  if (cp >= 0x1100 && cp <= 0x115f) return true;
  if (cp >= 0x2329 && cp <= 0x232a) return true;
  if (cp >= 0x2ff0 && cp <= 0x2fff) return true;
  if (cp >= 0x3000 && cp <= 0x303e) return true;
  if (cp >= 0x3040 && cp <= 0x33ff) return true;
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true;
  return false;
}

function graphemeCells(g: string, column: number): number {
  if (g === "\t") return 8 - (column % 8);
  let wide = false;
  let base = false;
  for (const ch of g) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCombiningCode(cp)) continue;
    base = true;
    if (isWideCode(cp)) wide = true;
  }
  if (!base) return 0;
  return wide ? 2 : 1;
}

export function cellWidth(text: string, startColumn = 0): number {
  let col = Math.max(0, startColumn);
  for (const g of splitGraphemes(text)) col += graphemeCells(g, col);
  return col - Math.max(0, startColumn);
}

export function wrapText(text: string, width: number): string[] {
  const cols = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const gs = splitGraphemes(raw);
    if (gs.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    let used = 0;
    for (const g of gs) {
      const cells = graphemeCells(g, used);
      if (cells === 0) {
        line += g;
        continue;
      }
      if (used > 0 && used + cells > cols) {
        out.push(line);
        line = g;
        used = graphemeCells(g, 0);
        continue;
      }
      line += g;
      used += cells;
    }
    out.push(line);
  }
  return out;
}

function displayBudget(cols: number, maxRows: number): number {
  return (Math.max(1, maxRows) + 2) * Math.max(1, cols) + 2;
}

function graphemeSafeTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  let start = text.length - maxChars;
  const lead = text.charCodeAt(start);
  if (lead >= 0xdc00 && lead <= 0xdfff) start += 1;
  let slice = text.slice(start);
  const gs = splitGraphemes(slice);
  if (gs.length === 0) return "";
  if (gs.length > 1 && graphemeCells(gs[0]!, 0) === 0) slice = gs.slice(1).join("");
  return slice;
}

function sourceTail(text: string, maxChars: number): { text: string; sliced: boolean } {
  if (maxChars <= 0) return { text: "", sliced: text.length > 0 };
  if (text.length <= maxChars) return { text, sliced: false };
  let slice = graphemeSafeTail(text, maxChars);
  const nl = slice.indexOf("\n");
  if (nl >= 0 && nl + 1 < slice.length) slice = slice.slice(nl + 1);
  return { text: slice, sliced: true };
}

function spanTextLen(spans: StyledSpan[]): number {
  let n = 0;
  for (const span of spans) n += span.text.length;
  return n;
}

function tailSpans(spans: StyledSpan[], maxChars: number): StyledSpan[] {
  if (maxChars <= 0) return [];
  let n = 0;
  const out: StyledSpan[] = [];
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]!;
    if (n >= maxChars) break;
    if (n + span.text.length <= maxChars) {
      out.push(span);
      n += span.text.length;
      continue;
    }
    out.push({ text: graphemeSafeTail(span.text, maxChars - n), style: span.style });
    break;
  }
  out.reverse();
  return out;
}

function wrapSpans(spans: StyledSpan[], width: number): Array<{ frags: StyledSpan[]; cells: number }> {
  const cols = Math.max(1, width);
  const rows: Array<{ frags: StyledSpan[]; cells: number }> = [];
  let row: StyledSpan[] = [];
  let used = 0;
  const flush = (): void => {
    rows.push({ frags: row, cells: used });
    row = [];
    used = 0;
  };
  const add = (g: string, style: StyleId): void => {
    if (g === "\n") {
      flush();
      return;
    }
    const cells = graphemeCells(g, used);
    if (cells === 0) {
      const last = row[row.length - 1];
      if (last && last.style === style) last.text += g;
      else row.push({ text: g, style });
      return;
    }
    if (used > 0 && used + cells > cols) flush();
    const placed = graphemeCells(g, used);
    const last = row[row.length - 1];
    if (last && last.style === style) last.text += g;
    else row.push({ text: g, style });
    used += placed;
  };
  for (const span of spans) {
    for (const g of splitGraphemes(span.text)) add(g, span.style);
  }
  rows.push({ frags: row, cells: used });
  return rows;
}

function paintRow(frags: StyledSpan[], cols: number, entry: TranscriptEntry, cells: number): string {
  const bg =
    entry.kind === "tool"
      ? entry.toolState === "success"
        ? 17
        : entry.toolState === "error"
          ? 18
          : 16
      : 0;
  let out = "\x1b[0m";
  if (bg) out += `\x1b[48;5;${bg}m`;
  if (entry.kind === "thinking") out += "\x1b[3;90m";
  if (entry.kind === "error") out += "\x1b[31m";
  for (const frag of frags) {
    const sgr =
      frag.style === 1
        ? "\x1b[3m"
        : frag.style === 2
          ? "\x1b[1m"
          : frag.style === 3
            ? "\x1b[36m"
            : frag.style === 4
              ? "\x1b[1;34m"
              : frag.style === 5
                ? "\x1b[2m"
                : frag.style === 6 || frag.style === 7
                  ? "\x1b[2;90m"
                  : "";
    if (sgr) out += sgr;
    out += frag.text;
    if (sgr) {
      out += "\x1b[0m";
      if (bg) out += `\x1b[48;5;${bg}m`;
      if (entry.kind === "thinking") out += "\x1b[3;90m";
      if (entry.kind === "error") out += "\x1b[31m";
    }
  }
  if (cells < cols) out += " ".repeat(cols - cells);
  out += "\x1b[0m";
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
    const gs = splitGraphemes(slice);
    if (gs[0] && cellWidth(gs[0]) === 0) slice = gs.slice(1).join("");
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

function clip(text: string, cols: number): string {
  const gs = splitGraphemes(text);
  let used = 0;
  let out = "";
  for (const g of gs) {
    const cells = graphemeCells(g, used);
    if (used + cells > cols) break;
    out += g;
    used += cells;
  }
  if (used < cols) out += " ".repeat(cols - used);
  return out;
}

function cursorRowCol(prefix: string, chars: string[], cursor: number, cols: number): { row: number; col: number } {
  const n = cellWidth(prefix + chars.slice(0, cursor).join(""));
  if (n === 0) return { row: 0, col: 0 };
  if (n % cols === 0) return { row: n / cols, col: 0 };
  return { row: Math.floor(n / cols), col: n % cols };
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_TRANSCRIPT = 400_000;
const MAX_TRANSCRIPT_ENTRIES = 2_000;
const MAX_HISTORY = 100;
const MAX_CSI = 32;
const MAX_ESCAPE = 32;
const TRUNCATION_MARKER = "…[truncated]\n";
const HANDLE_ERROR = "invalid tool handle\n";
const MAX_MD_NEST = 8;

const transcriptHandleBrand = Symbol("transcript-handle");
export type TranscriptHandle = Readonly<{ [transcriptHandleBrand]: number }>;
export type ToolTranscriptState = "success" | "error" | "cancelled";

type SanitizerMode = "ground" | "esc" | "csi" | "osc" | "dcs";
type SanitizerState = { mode: SanitizerMode; n: number; esc: boolean };

function freshSanitizer(): SanitizerState {
  return { mode: "ground", n: 0, esc: false };
}

function isC1(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}

function sanitizeText(input: string, start: SanitizerState): { text: string; state: SanitizerState } {
  const state: SanitizerState = { ...start };
  let out = "";
  const flushIncomplete = (): void => {
    state.mode = "ground";
    state.n = 0;
    state.esc = false;
  };
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (state.mode === "ground") {
      if (code === 0x1b) {
        state.mode = "esc";
        state.n = 0;
        continue;
      }
      if (code === 0x9b) {
        state.mode = "csi";
        state.n = 0;
        continue;
      }
      if (code === 0x9d) {
        state.mode = "osc";
        state.n = 0;
        continue;
      }
      if (code === 0x90) {
        state.mode = "dcs";
        state.n = 0;
        continue;
      }
      if (code === 0x9c || isC1(code) || (code < 0x20 && ch !== "\n" && ch !== "\t")) continue;
      out += ch;
      continue;
    }
    if (state.mode === "esc") {
      if (ch === "[") {
        state.mode = "csi";
        state.n = 0;
        continue;
      }
      if (ch === "]") {
        state.mode = "osc";
        state.n = 0;
        continue;
      }
      if (ch === "P") {
        state.mode = "dcs";
        state.n = 0;
        continue;
      }
      if (ch === "\\") {
        flushIncomplete();
        continue;
      }
      flushIncomplete();
      continue;
    }
    if (state.mode === "csi") {
      if (code === 0x0a) {
        flushIncomplete();
        out += ch;
        continue;
      }
      state.n += 1;
      if (code >= 0x40 && code <= 0x7e) {
        flushIncomplete();
        continue;
      }
      if (state.n > MAX_ESCAPE) continue;
      continue;
    }
    if (state.mode === "osc" || state.mode === "dcs") {
      if (code === 0x07 || code === 0x9c) {
        flushIncomplete();
        continue;
      }
      if (code === 0x1b) {
        state.esc = true;
        continue;
      }
      if (state.esc) {
        state.esc = false;
        if (ch === "\\") {
          flushIncomplete();
          continue;
        }
      }
      if (code === 0x0a) {
        flushIncomplete();
        out += ch;
        continue;
      }
      state.n += 1;
      if (state.n > MAX_ESCAPE) continue;
    }
  }
  return { text: out, state };
}

function closeSanitize(input: string, start: SanitizerState): string {
  return sanitizeText(input, start).text;
}

type StyleId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type StyledSpan = { text: string; style: StyleId };

type EntryKind = "plain" | "assistant" | "thinking" | "tool" | "error";
type ToolUiState = "running" | "success" | "error" | "cancelled";
type TranscriptEntry = {
  id: number;
  kind: EntryKind;
  text: string;
  settled: boolean;
  toolName?: string;
  toolDetail?: string;
  toolState?: ToolUiState;
  sanitizer: SanitizerState;
  revision: number;
  mdPrefixLen: number;
  mdPrefixSpans: StyledSpan[];
  cache: {
    revision: number;
    width: number;
    cover: number;
    complete: boolean;
    rows: string[];
    painted: string[];
  } | null;
};

function entryChars(entry: TranscriptEntry): number {
  if (entry.kind === "tool") {
    return (entry.toolName?.length ?? 0) + (entry.toolDetail?.length ?? 0) + entry.text.length;
  }
  return entry.text.length;
}

function toolStatusLabel(state: ToolUiState | undefined): string {
  if (state === "success") return "done";
  if (state === "error") return "failed";
  if (state === "cancelled") return "cancelled";
  return "running";
}

function parseInline(text: string, scanned: { n: number }, depth = 0): StyledSpan[] {
  scanned.n += text.length;
  if (depth >= MAX_MD_NEST) return text ? [{ text, style: 0 }] : [];
  const spans: StyledSpan[] = [];
  let i = 0;
  let buf = "";
  const flush = (style: StyleId): void => {
    if (!buf) return;
    spans.push({ text: buf, style });
    buf = "";
  };
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2 && !text.slice(i + 2, end).includes("\n")) {
        flush(0);
        const inner = parseInline(text.slice(i + 2, end), scanned, depth + 1);
        for (const span of inner) spans.push({ text: span.text, style: 2 });
        i = end + 2;
        continue;
      }
      buf += "**";
      i += 2;
      continue;
    }
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes("\n")) {
        flush(0);
        const inner = parseInline(text.slice(i + 1, end), scanned, depth + 1);
        for (const span of inner) spans.push({ text: span.text, style: span.style === 0 ? 1 : span.style });
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes("\n")) {
        flush(0);
        spans.push({ text: text.slice(i + 1, end), style: 3 });
        i = end + 1;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  flush(0);
  return spans.length > 0 ? spans : text ? [{ text, style: 0 }] : [];
}

function quoteDepth(line: string): number {
  let depth = 0;
  let i = 0;
  while (line.startsWith("> ", i) && depth < 32) {
    depth += 1;
    i += 2;
  }
  return depth;
}

function listDepth(line: string): number {
  const m = /^(\s*)(?:[-*]|\d+\.)\s+/.exec(line);
  if (!m) return 0;
  return Math.floor((m[1] ?? "").length / 2) + 1;
}

function unfinishedStart(text: string): number {
  let fence = false;
  let fenceStart = 0;
  let completeEnd = 0;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== "\n") continue;
    const line = text.slice(lineStart, i);
    if (line.startsWith("```")) {
      if (!fence) {
        fence = true;
        fenceStart = lineStart;
      } else {
        fence = false;
        completeEnd = i + 1;
      }
    } else if (!fence && i < text.length) {
      completeEnd = i + 1;
    }
    lineStart = i + 1;
  }
  if (fence) return fenceStart;
  return Math.min(completeEnd, text.length);
}

function parseMarkdown(text: string, scanned: { n: number }): StyledSpan[] {
  if (!text) return [];
  const lines = text.split("\n");
  const spans: StyledSpan[] = [];
  let fence: string[] | null = null;
  let fenceLang = "";
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    scanned.n += line.length + 1;
    const more = li < lines.length - 1;
    if (line.startsWith("```")) {
      if (!fence) {
        fence = [];
        fenceLang = line.slice(3).trim();
      } else {
        if (fenceLang) spans.push({ text: fenceLang + "\n", style: 6 });
        for (let fi = 0; fi < fence.length; fi++) {
          const last = fi === fence.length - 1;
          spans.push({ text: fence[fi]! + (last ? "" : "\n"), style: 3 });
        }
        if (fence.length === 0) spans.push({ text: "", style: 3 });
        if (more) spans.push({ text: "\n", style: 3 });
        fence = null;
        fenceLang = "";
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const qd = quoteDepth(line);
    const ld = listDepth(line);
    if (/^#{1,6}\s/.test(line)) {
      spans.push(...parseInline(line.replace(/^#{1,6}\s+/, ""), scanned).map((s) => ({ ...s, style: 4 as StyleId })));
      if (more) spans.push({ text: "\n", style: 4 });
      continue;
    }
    if (qd > MAX_MD_NEST || ld > MAX_MD_NEST) {
      spans.push({ text: line, style: 0 });
      if (more) spans.push({ text: "\n", style: 0 });
      continue;
    }
    if (qd > 0) {
      let rest = line;
      for (let d = 0; d < qd; d++) rest = rest.slice(2);
      spans.push({ text: "│ ".repeat(qd), style: 5 });
      spans.push(...parseInline(rest, scanned).map((s) => ({ ...s, style: s.style === 0 ? 5 : s.style })));
      if (more) spans.push({ text: "\n", style: 5 });
      continue;
    }
    if (ld > 0) {
      const item = line.replace(/^\s*[-*]\s+/, "• ").replace(/^\s*\d+\.\s+/, (m) => m);
      spans.push(...parseInline(item, scanned));
      if (more) spans.push({ text: "\n", style: 0 });
      continue;
    }
    spans.push(...parseInline(line, scanned));
    if (more) spans.push({ text: "\n", style: 0 });
  }
  if (fence) {
    const open = `\`\`\`${fenceLang}`;
    spans.push({ text: open, style: 0 });
    for (const body of fence) spans.push({ text: `\n${body}`, style: 0 });
  }
  return spans;
}

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
  private auth = "";
  private effort = "off";
  private usage = "";
  private pendingImageCount = 0;
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

  constructor(opts: {
    stdout: TuiIO;
    stdin: TuiInput;
    commands?: SlashCommand[];
    onSubmit: (line: string) => void;
    onInterrupt: () => void;
    onExit: () => void;
    onHostRefresh?: () => void;
    thinkingVisible?: boolean;
  }) {
    this.out = opts.stdout;
    this.inp = opts.stdin;
    this.commands = opts.commands ?? SLASH_COMMANDS;
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
    const inputText = this.choicePrompt || `> ${this.chars.join("")}`;
    const layout = layoutHeights(rows, Math.max(1, wrapText(inputText, cols).length), this.matches().length);
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
      mdPrefixSpans: [],
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
    entry.text = closeSanitize(output ?? "", freshSanitizer());
    entry.revision += 1;
    entry.mdPrefixLen = 0;
    entry.mdPrefixSpans = [];
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
        mdPrefixSpans: [],
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
    entry.text += next.text;
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
      mdPrefixSpans: [],
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
    const budget = Math.max(0, MAX_TRANSCRIPT - others - TRUNCATION_MARKER.length);
    let tail = entry.text.length > budget ? graphemeSafeTail(entry.text, budget) : entry.text;
    const nl = tail.indexOf("\n");
    if (nl >= 0 && nl + 1 < tail.length) tail = tail.slice(nl + 1);
    const next = TRUNCATION_MARKER + tail;
    this.transcriptChars -= entryChars(entry);
    entry.text = next;
    entry.mdPrefixLen = 0;
    entry.mdPrefixSpans = [];
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
      const title = `◆ ${entry.toolName || "tool"}${entry.toolDetail ? `  ${entry.toolDetail}` : ""}`;
      const status = toolStatusLabel(entry.toolState);
      const spans: StyledSpan[] = [
        { text: title, style: 4 },
        { text: `\n  ${status}`, style: 7 },
      ];
      if (entry.text) spans.push({ text: `\n${entry.text}`, style: 0 });
      return spans;
    }
    if (entry.kind !== "assistant" && entry.kind !== "thinking") {
      return entry.text ? [{ text: entry.text, style: 0 }] : [];
    }
    return this.entryTailSpans(entry, Number.MAX_SAFE_INTEGER).spans;
  }

  private ensureMdPrefix(entry: TranscriptEntry, start: number): void {
    if (entry.mdPrefixLen > start) {
      entry.mdPrefixLen = 0;
      entry.mdPrefixSpans = [];
    }
    if (entry.mdPrefixLen >= start) return;
    const scanned = { n: 0 };
    const extra = parseMarkdown(entry.text.slice(entry.mdPrefixLen, start), scanned);
    this.markdownScannedChars += scanned.n;
    for (const span of extra) entry.mdPrefixSpans.push(span);
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
    const start = unfinishedStart(entry.text);
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
    if (spanTextLen(prefix) + suffix.length <= maxChars) {
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
    this.out.write("\x1b[?2026l\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?2004l\x1b[?25h\x1b[?1049l");
  }

  /** Visible frame without tty side effects. Tests use this. */
  frame(): string {
    this.flushBareEscape();
    return this.buildFrame(this.size()).text;
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
    if (this.choiceRows.length > 0) {
      this.clearChoices();
      this.onInterrupt();
    } else if (this.matches().length > 0) {
      this.chars = [];
      this.cursor = 0;
      this.slashIndex = 0;
      this.schedule();
    } else this.onInterrupt();
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
      this.chars = splitGraphemes(line);
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
      else if (params === "201") this.onHostRefresh?.();
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
      this.chars = splitGraphemes(this.draft);
      this.cursor = this.chars.length;
      return;
    } else {
      this.histIndex = next;
    }
    this.chars = splitGraphemes(this.history[this.histIndex] ?? "");
    this.cursor = this.chars.length;
  }

  private scrollBy(pages: number): void {
    const { cols, rows } = this.size();
    const inputText = `> ${this.chars.join("")}`;
    const matches = this.matches();
    const inputLines = Math.max(1, wrapText(inputText, cols).length || 1);
    const layout = layoutHeights(rows, inputLines, matches.length);
    const page = Math.max(1, layout.transcript - 1);
    const wrapped = this.visibleTranscript(cols, layout.transcript + this.scroll + page + 2, 0);
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
    const view = this.visibleSlice(cols, layout.transcript, this.scroll);
    const nameW = shownSlash.length > 0 ? Math.max(...shownSlash.map((c) => c.name.length)) : 0;
    const spin = this.busy ? `${SPIN[this.spin]!} ` : "";
    const imageN = this.pendingImageCount;
    const images = imageN > 0 ? `  ${imageN} image${imageN === 1 ? "" : "s"}` : "";
    const title = ` termina agent-core v1  ${spin}effort ${this.effort}  ${this.model}${this.auth ? `  ${this.auth}` : ""}${images} `;
    const picker = matches.length > 0 && Boolean(matches[0]?.submit);
    const foot = picker
      ? " ↑↓ pick · Enter select · Ctrl+C cancel "
      : this.busy
        ? " Ctrl+C interrupt · PgUp/PgDn scroll "
        : " / commands · Tab complete · Ctrl+J newline · PgUp/PgDn scroll · Ctrl+C clear ";

    const lines: string[] = [];
    for (let i = 0; i < layout.transcript; i++) lines.push(clip(view.rows[i] ?? "", cols));
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
      ? { row: 0, col: Math.min(cols - 1, cellWidth(this.choicePrompt)) }
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
      } else if (i < layout.transcript) painted.push(view.painted[i] ?? `\x1b[0m${raw}\x1b[0m`);
      else painted.push(raw);
    }
    return { text: lines.join("\n"), painted, cursorRow, cursorCol };
  }
}
