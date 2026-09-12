/**
 * TUI transcript model: sanitize, markdown, and entries.
 *
 * Owns output sanitizing, markdown spans, transcript entries, and TUI IO
 * contracts. Split from agent-core/tui.ts (issue #38).
 */


export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const MAX_TRANSCRIPT = 400_000;

/** Leave headroom so an active response is not recopied on every token once
 *  it reaches the transcript cap. */
export const TRANSCRIPT_TRIM_TARGET = MAX_TRANSCRIPT - 16 * 1024;

export const MAX_TRANSCRIPT_ENTRIES = 2_000;

export const MAX_HISTORY = 100;

export const MAX_CSI = 32;

const MAX_ESCAPE = 32;

export const TRUNCATION_MARKER = "…[truncated]\n";

export const HANDLE_ERROR = "invalid tool handle\n";

const MAX_MD_NEST = 8;


export const transcriptHandleBrand = Symbol("transcript-handle");

export type TranscriptHandle = Readonly<{ [transcriptHandleBrand]: number }>;

export type ToolTranscriptState = "success" | "error" | "cancelled";


type SanitizerMode = "ground" | "esc" | "csi" | "osc" | "dcs";

type SanitizerState = { mode: SanitizerMode; n: number; esc: boolean };


export function freshSanitizer(): SanitizerState {
  return { mode: "ground", n: 0, esc: false };
}


function isC1(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}


export function sanitizeText(input: string, start: SanitizerState): { text: string; state: SanitizerState } {
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


export function closeSanitize(input: string, start: SanitizerState): string {
  return sanitizeText(input, start).text;
}


export type StyleId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type StyledSpan = { text: string; style: StyleId };


type MarkdownBoundary = {
  /** Start and first three characters of the current incomplete source line. */
  lineStart: number;
  linePrefix: string;
  /** Source length already checked for newline boundaries. */
  checked: number;
  fence: boolean;
  fenceStart: number;
  completeEnd: number;
};


export function freshMarkdownBoundary(): MarkdownBoundary {
  return { lineStart: 0, linePrefix: "", checked: 0, fence: false, fenceStart: 0, completeEnd: 0 };
}


type EntryKind = "plain" | "assistant" | "thinking" | "tool" | "error";

type ToolUiState = "running" | "success" | "error" | "cancelled";

export type TranscriptEntry = {
  id: number;
  kind: EntryKind;
  text: string;
  settled: boolean;
  toolName?: string;
  toolDetail?: string;
  toolState?: ToolUiState;
  expanded?: boolean;
  sanitizer: SanitizerState;
  revision: number;
  mdPrefixLen: number;
  mdPrefixChars: number;
  mdPrefixSpans: StyledSpan[];
  mdBoundary: MarkdownBoundary;
  cache: {
    revision: number;
    width: number;
    cover: number;
    complete: boolean;
    rows: string[];
    painted: string[];
  } | null;
};


export function entryChars(entry: TranscriptEntry): number {
  if (entry.kind === "tool") {
    return (entry.toolName?.length ?? 0) + (entry.toolDetail?.length ?? 0) + entry.text.length;
  }
  return entry.text.length;
}


export function toolStatusLabel(state: ToolUiState | undefined): string {
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


export function parseMarkdown(text: string, scanned: { n: number }): StyledSpan[] {
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
