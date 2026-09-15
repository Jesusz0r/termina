/**
 * TUI layout and row-rendering helpers.
 *
 * Owns pure box/wrap/paint math for the transcript viewport and input box.
 * Split from agent-core/tui.ts (issue #38).
 */
import { cursorRowCol, forEachGrapheme, graphemeCells, splitGraphemes, wrapText } from "../tui-text.ts";
import type { StyleId, StyledSpan, TranscriptEntry } from "./transcript.ts";



export function displayBudget(cols: number, maxRows: number): number {
  return (Math.max(1, maxRows) + 2) * Math.max(1, cols) + 2;
}


export function graphemeSafeTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (!/[^\x00-\x7f]/.test(text)) return text.slice(text.length - maxChars);
  let start = text.length - maxChars;
  const lead = text.charCodeAt(start);
  if (lead >= 0xdc00 && lead <= 0xdfff) start += 1;
  const slice = text.slice(start);
  const gs = splitGraphemes(slice);
  if (gs.length === 0) return "";
  // Never split a cluster at the cut: drop an orphaned leading grapheme, but
  // never empty a non-empty slice over it.
  if (gs.length > 1) {
    const first = gs[0]!;
    if (graphemeCells(first, 0) === 0) return gs.slice(1).join("");
    const firstCp = first.codePointAt(0) ?? 0;
    // ZWJ never starts a cluster, so a leading joiner continues cut content.
    if (firstCp === 0x200d) return gs.slice(1).join("");
    // Regional indicators pair greedily left to right. An odd trailing run in
    // the prefix pairs across the cut, orphaning the slice's first indicator.
    if (firstCp >= 0x1f1e6 && firstCp <= 0x1f1ff && trailingRegionalParity(text, start)) {
      return slice.slice(2);
    }
  }
  return slice;
}

/** True when an odd run of regional indicators ends at `end`. */
function trailingRegionalParity(text: string, end: number): boolean {
  let odd = false;
  let i = end;
  while (i > 0) {
    let cp = text.charCodeAt(i - 1);
    let width = 1;
    if (cp >= 0xdc00 && cp <= 0xdfff && i >= 2) {
      const lead = text.charCodeAt(i - 2);
      if (lead >= 0xd800 && lead <= 0xdbff) {
        cp = (lead - 0xd800) * 0x400 + (cp - 0xdc00) + 0x10000;
        width = 2;
      }
    }
    if (cp < 0x1f1e6 || cp > 0x1f1ff) break;
    odd = !odd;
    i -= width;
  }
  return odd;
}


export function sourceTail(text: string, maxChars: number): { text: string; sliced: boolean } {
  if (maxChars <= 0) return { text: "", sliced: text.length > 0 };
  if (text.length <= maxChars) return { text, sliced: false };
  let slice = graphemeSafeTail(text, maxChars);
  const nl = slice.indexOf("\n");
  if (nl >= 0 && nl + 1 < slice.length) slice = slice.slice(nl + 1);
  return { text: slice, sliced: true };
}


export function tailSpans(spans: StyledSpan[], maxChars: number): StyledSpan[] {
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


export function wrapSpans(spans: StyledSpan[], width: number): Array<{ frags: StyledSpan[]; cells: number }> {
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
  for (const span of spans) forEachGrapheme(span.text, (g) => add(g, span.style));
  rows.push({ frags: row, cells: used });
  return rows;
}


export function paintRow(frags: StyledSpan[], cols: number, entry: TranscriptEntry, cells: number): string {
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
                : frag.style === 6
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


export function layoutHeights(
  rows: number,
  inputLines: number,
  slashCount: number,
): { header: number; transcript: number; input: number; slash: number } {
  // The header is a single title row; usage lives in the sidecar feed.
  const header = 1;
  const sep = 1;
  const minTranscript = 1;
  let slash = Math.max(0, slashCount);
  let input = Math.max(1, inputLines);
  const budget = Math.max(4, rows);
  // The composer box adds a top and bottom border around the input rows.
  const chrome = BOX_CHROME_ROWS;
  while (header + sep + minTranscript + input + slash + chrome > budget && slash > 0) slash--;
  while (header + sep + minTranscript + input + slash + chrome > budget && input > 1) input--;
  const used = header + sep + input + slash + chrome;
  return { header, transcript: Math.max(minTranscript, budget - used), input, slash };
}


export function clip(text: string, cols: number): string {
  let used = 0;
  let out = "";
  forEachGrapheme(text, (g) => {
    if (used >= cols) return false;
    const cells = graphemeCells(g, used);
    if (used + cells > cols) return false;
    out += g;
    used += cells;
  });
  if (used < cols) out += " ".repeat(cols - used);
  return out;
}


export const INPUT_PREFIX = "> ";

// The composer renders as a bordered box separated from the transcript.
// Borders occupy two cells on each side ("│ " and " │").
const BOX_CHROME_COLS = 4;

const BOX_CHROME_ROWS = 2;


export function inputWrapWidth(cols: number): number {
  return Math.max(8, cols - BOX_CHROME_COLS);
}


export function boxBorderRow(cols: number, left: string, fill: string, right: string): string {
  return clip(left + fill.repeat(Math.max(0, cols - 2)) + right, cols);
}


export function boxContentRow(content: string, cols: number): string {
  const inner = clip(content, inputWrapWidth(cols));
  return clip(`│ ${inner} │`, cols);
}


export function wrapInput(
  prefix: string,
  chars: string[],
  cursor: number,
  cols: number,
): { wrapped: string[]; pos: { row: number; col: number } } {
  const pos = cursorRowCol(prefix, chars, cursor, cols);
  const wrapped = wrapText(prefix + chars.join(""), cols);
  while (wrapped.length <= pos.row) wrapped.push("");
  return { wrapped, pos };
}
