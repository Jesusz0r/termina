/**
 * Pure TUI text helpers: slash-command completion, file mentions, tag
 * ranking, and cell-width-aware measurement/wrapping. No terminal IO.
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
  { name: "/clear (new)", hint: "start a new empty session", submit: "/clear" },
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

export const EFFORT_HINTS: Record<string, string> = {
  off: "disable reasoning",
  minimal: "use minimal reasoning effort",
  low: "use low reasoning effort",
  medium: "use medium reasoning effort",
  high: "use high reasoning effort",
  xhigh: "use extra-high reasoning effort",
  max: "use maximum reasoning effort",
};

export function effortCommandRows(levels: readonly string[] = Object.keys(EFFORT_HINTS)): SlashCommand[] {
  return levels.map((level) => ({
    name: level,
    hint: EFFORT_HINTS[level] ?? "use this reasoning effort",
    submit: `/effort ${level}`,
  }));
}

export function authCommandRows(cmd: "/login" | "/logout"): SlashCommand[] {
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

export function pickerRowMatches(line: string, row: SlashCommand): boolean {
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
  // "/new" is a hidden alias for /clear: "/n", "/ne", "/new" offer the reset row.
  if ("/new".startsWith(line)) {
    const prefixed = commands.filter((c) => c.name.startsWith(line));
    const aliased = commands.filter((c) => c.submit === "/clear" && !prefixed.includes(c));
    if (aliased.length > 0) return [...prefixed, ...aliased];
  }
  return commands.filter((c) => c.name.startsWith(line) || (c.submit?.startsWith(line) ?? false));
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

export const FILE_MENTION_PATH = /^[^\s@]+$/;

export function mentionTokenEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && !/\s/.test(text[i]!) && text[i] !== "@") i++;
  return i;
}

/** `@` starts a file tag at the beginning of the line or after whitespace.
 *  `query` is the text between `@` and the cursor (filter). `end` is the
 *  end of the whole token so a pick replaces a mid-token suffix. */
export function fileMentionAt(
  text: string,
  cursor: number,
): { start: number; query: string; end: number } | null {
  if (cursor < 1 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (!FILE_MENTION_PATH.test(query) && query !== "") return null;
  return { start: at, query, end: mentionTokenEnd(text, cursor) };
}

export function applyFileMention(
  text: string,
  cursor: number,
  path: string,
  spaced = true,
): { text: string; cursor: number } | null {
  const mention = fileMentionAt(text, cursor);
  if (!mention) return null;
  const insert = `@${path}${spaced ? " " : ""}`;
  const next = `${text.slice(0, mention.start)}${insert}${text.slice(mention.end)}`;
  return { text: next, cursor: mention.start + insert.length };
}

export function completeFileMention(
  text: string,
  cursor: number,
  paths: readonly string[],
): { text: string; cursor: number } | null {
  const mention = fileMentionAt(text, cursor);
  if (!mention || paths.length === 0) return null;
  if (paths.length === 1) return applyFileMention(text, cursor, paths[0]!, true);
  let prefix = paths[0]!;
  for (const path of paths.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < path.length && prefix[i] === path[i]) i++;
    prefix = prefix.slice(0, i);
  }
  if (prefix.length <= mention.query.length) return null;
  return applyFileMention(text, cursor, prefix, false);
}

export function rankFileTags(paths: readonly string[], query: string, cap = 50): string[] {
  const q = query.trim().toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    const stripped = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
    if (q === "") {
      scored.push({ path, score: stripped.includes("/") ? 1 : 0 });
      continue;
    }
    const lower = stripped.toLowerCase();
    const fullLower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const qb = q.endsWith("/") && q.length > 1 ? q.slice(0, -1) : q;
    let score = -1;
    if (qb !== "" && base.startsWith(qb)) score = 0;
    else {
      const baseSpread = subsequenceSpread(base, qb);
      if (baseSpread !== null) score = 1 + baseSpread / 1000;
      else if (fullLower.startsWith(q)) score = 2;
      else if (fullLower.includes(q)) score = 3;
      else {
        const pathSpread = subsequenceSpread(fullLower, q);
        if (pathSpread !== null) score = 4 + pathSpread / 1000;
      }
    }
    if (score >= 0) scored.push({ path, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
  });
  return scored.slice(0, Math.max(0, cap)).map((row) => row.path);
}

/** Consecutive-ish subsequence: all needle chars in order. Returns span length or null. */
export function subsequenceSpread(haystack: string, needle: string): number | null {
  if (!needle) return 0;
  let i = 0;
  let first = -1;
  let last = -1;
  for (let k = 0; k < haystack.length && i < needle.length; k++) {
    if (haystack[k] === needle[i]) {
      if (first < 0) first = k;
      last = k;
      i++;
    }
  }
  if (i < needle.length) return null;
  return last - first;
}

export function truncateMiddle(text: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  if (cellWidth(text) <= maxCells) return text;
  if (maxCells <= 1) return "…".slice(0, maxCells);
  const ell = "…";
  const keep = maxCells - 1;
  const head = Math.max(1, Math.ceil(keep / 2));
  const tail = Math.max(1, keep - head);
  const gs = splitGraphemes(text);
  let left = "";
  let used = 0;
  for (const g of gs) {
    const w = graphemeCells(g, used);
    if (used + w > head) break;
    left += g;
    used += w;
  }
  let right = "";
  let rused = 0;
  for (let i = gs.length - 1; i >= 0; i--) {
    const g = gs[i]!;
    const w = graphemeCells(g, 0);
    if (rused + w > tail) break;
    right = g + right;
    rused += w;
  }
  return `${left}${ell}${right}`;
}

export function formatPickerRow(name: string, hint: string, cols: number, selected = false): string {
  const marker = selected ? "▸ " : "  ";
  const hintPart = hint ? `  ${hint}` : "";
  const budget = Math.max(8, cols - marker.length - cellWidth(hintPart));
  return `${marker}${truncateMiddle(name, budget)}${hintPart}`;
}

export const EMPTY_STATE_TEXT =
  "⌖  Type a task and press Enter — the agent runs in this terminal.\n" +
  "   @ file  ·  / command  ·  /help lists keys  ·  /login  /models";

export const TUI_SHORTCUTS: SlashCommand[] = [
  { name: "Ctrl+L", hint: "model picker" },
  { name: "Ctrl+P", hint: "next model" },
  { name: "Shift+Tab", hint: "cycle effort" },
  { name: "Ctrl+J", hint: "newline" },
  { name: "Ctrl+R", hint: "search prompt history" },
  { name: "End", hint: "jump to live output when scrolled up" },
  { name: "PgUp/PgDn", hint: "scroll transcript" },
  { name: "Cmd/Ctrl+C", hint: "copy selection" },
  { name: "Ctrl+C", hint: "interrupt run or clear draft" },
  { name: "Esc", hint: "close picker" },
];

export const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function forEachGrapheme(text: string, visit: (grapheme: string) => boolean | void): void {
  // Intl.Segmenter is disproportionately expensive on the several-thousand
  // character ASCII tail repainted during streaming. ASCII code units are
  // already grapheme-safe and can be visited without a temporary array.
  if (!/[^\x00-\x7f]/.test(text)) {
    for (let i = 0; i < text.length; i++) {
      if (visit(text[i]!) === false) break;
    }
    return;
  }
  for (const part of graphemeSegmenter.segment(text)) {
    if (visit(part.segment) === false) break;
  }
}

export function splitGraphemes(text: string): string[] {
  const out: string[] = [];
  forEachGrapheme(text, (grapheme) => {
    out.push(grapheme);
  });
  return out;
}

export function isCombiningCode(cp: number): boolean {
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

export function isWideCode(cp: number): boolean {
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

export function graphemeCells(g: string, column: number): number {
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
  forEachGrapheme(text, (grapheme) => {
    col += graphemeCells(grapheme, col);
  });
  return col - Math.max(0, startColumn);
}

export function wrapText(text: string, width: number): string[] {
  const cols = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    let used = 0;
    forEachGrapheme(raw, (g) => {
      const cells = graphemeCells(g, used);
      if (cells === 0) {
        line += g;
        return;
      }
      if (used > 0 && used + cells > cols) {
        out.push(line);
        line = g;
        used = graphemeCells(g, 0);
        return;
      }
      line += g;
      used += cells;
    });
    out.push(line);
  }
  return out;
}
