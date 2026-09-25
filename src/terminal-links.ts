import type { IBufferLine, IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { isRecognizedTerminalPath, terminalWebUrl } from "../shared/terminal-link";
import { isMacPlatform } from "./settings-shortcuts";

interface ParsedTerminalFileLink {
  /** The exact raw string in the terminal line that was matched. */
  text: string;
  /** Cleaned file path suitable for opening (file:// stripped, diff prefixes stripped). */
  path: string;
  /** Optional 1-based line number. */
  line?: number;
  /** Optional 1-based column number. */
  column?: number;
  /** 0-based start character index in lineText. */
  startIndex: number;
  /** 0-based end character index in lineText (exclusive). */
  endIndex: number;
}

function safeDecodeUri(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

/**
 * Parses a target candidate into clean path, line, and column.
 * Returns null if the target does not look like a source file or known config.
 *
 * Only `file://` URIs are local files: any other scheme (`http://`, `https://`,
 * …) is rejected here so quoted and Markdown web targets never become file links.
 * A leading `a/` or `b/` is a Git diff prefix only when the caller observed a
 * real diff header (`diffHeader: true`); ordinary paths keep it literally.
 */
function parseTargetReference(
  target: string,
  opts: { diffHeader?: boolean } = {},
): { path: string; line?: number; column?: number } | null {
  let cleaned = target;
  if (!/\(\d+(?:,\s*\d+)?\)$/.test(target)) {
    cleaned = cleaned.replace(/[.,;!?:)]+$/, "");
  } else {
    cleaned = cleaned.replace(/[.,;!?:]+$/, "");
  }
  if (!cleaned) return null;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cleaned) && !cleaned.startsWith("file://")) return null;

  if (cleaned.startsWith("file://")) {
    cleaned = cleaned.slice("file://".length);
    if (cleaned.startsWith("localhost/")) {
      cleaned = cleaned.slice("localhost".length);
    }
  }

  cleaned = safeDecodeUri(cleaned);

  let line: number | undefined;
  let col: number | undefined;

  const hashMatch = /#L(\d+)(?:-L?(\d+))?$/.exec(cleaned);
  if (hashMatch) {
    line = parseInt(hashMatch[1], 10);
    cleaned = cleaned.slice(0, hashMatch.index);
  } else {
    const parenMatch = /\((\d+)(?:,\s*(\d+))?\)$/.exec(cleaned);
    if (parenMatch) {
      line = parseInt(parenMatch[1], 10);
      if (parenMatch[2]) col = parseInt(parenMatch[2], 10);
      cleaned = cleaned.slice(0, parenMatch.index);
    } else {
      const colonMatch = /:(\d+)(?::(\d+))?$/.exec(cleaned);
      if (colonMatch) {
        line = parseInt(colonMatch[1], 10);
        if (colonMatch[2]) col = parseInt(colonMatch[2], 10);
        cleaned = cleaned.slice(0, colonMatch.index);
      }
    }
  }

  const cleanPath = opts.diffHeader ? cleaned.replace(/^[ab]\//, "") : cleaned;
  if (!isRecognizedTerminalPath(cleanPath)) return null;
  return { path: cleanPath, line, column: col };
}

/**
 * True when the match at `startIndex` is the path of a real Git diff header
 * (`--- a/…`, `+++ b/…`, or either side of `diff --git a/… b/…`) rather than
 * an ordinary reference to a directory literally named `a` or `b`.
 */
function isDiffHeaderTarget(lineText: string, startIndex: number): boolean {
  const before = lineText.slice(0, startIndex);
  const prefix = before.slice(before.lastIndexOf("\n") + 1);
  return /^(---|\+\+\+)\s+$/.test(prefix) || /^diff --git\s+(\S+\s+)?$/.test(prefix);
}

/**
 * Scan a single line of terminal buffer text for file references, markdown file links,
 * file:// URIs, compiler/stack trace paths, quoted paths with spaces, and git diff headers.
 */
export function parseTerminalFileLinks(lineText: string): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = [];
  if (!lineText) return links;

  const isOverlapping = (start: number, end: number) =>
    links.some((l) => (start >= l.startIndex && start < l.endIndex) || (end > l.startIndex && end <= l.endIndex));

  // 1. Locate all web URLs (http:// and https://) so they are never treated as file links
  const webUrls: { start: number; end: number }[] = [];
  const webRegex = /(?:https?:\/\/|(?:localhost|127\.0\.0\.1):)\S+/gi;
  let m: RegExpExecArray | null;
  while ((m = webRegex.exec(lineText)) !== null) {
    webUrls.push({ start: m.index, end: m.index + m[0].length });
  }
  const isInsideWebUrl = (start: number) => webUrls.some((u) => start >= u.start && start < u.end);

  // 2. Markdown links: [Label](target)
  const mdLinkRegex = /\[([^\]]+)\]\((file:\/\/[^\s)]+|[^\s)]+)\)/g;
  while ((m = mdLinkRegex.exec(lineText)) !== null) {
    const fullMatch = m[0];
    const target = m[2];
    const startIndex = m.index;
    const endIndex = m.index + fullMatch.length;

    if (isInsideWebUrl(startIndex) || isOverlapping(startIndex, endIndex)) continue;

    const parsedTarget = parseTargetReference(target);
    if (parsedTarget) {
      links.push({
        text: fullMatch,
        path: parsedTarget.path,
        line: parsedTarget.line,
        column: parsedTarget.column,
        startIndex,
        endIndex,
      });
    }
  }

  // 3. file:// URI matching: file:///path/to/file.ts:42:10 or file:///path#L42
  const fileUriRegex = /file:\/\/(\/[^\s"'`()\[\]{}]+)/g;
  while ((m = fileUriRegex.exec(lineText)) !== null) {
    const rawUri = m[0];
    const trimmedUri = rawUri.replace(/[.,;!?:)]+$/, "");
    const startIndex = m.index;
    const endIndex = m.index + trimmedUri.length;

    if (isInsideWebUrl(startIndex) || isOverlapping(startIndex, endIndex)) continue;

    const parsedTarget = parseTargetReference(trimmedUri);
    if (parsedTarget) {
      links.push({
        text: trimmedUri,
        path: parsedTarget.path,
        line: parsedTarget.line,
        column: parsedTarget.column,
        startIndex,
        endIndex,
      });
    }
  }

  // 4. Quoted paths (supporting spaces inside quotes): "path/to/my file.ts:42"
  const quotedRegex = /(["'`])([^"'`\r\n]+)\1/g;
  while ((m = quotedRegex.exec(lineText)) !== null) {
    const rawMatch = m[0];
    const inner = m[2];
    const startIndex = m.index;
    const endIndex = m.index + rawMatch.length;

    if (isInsideWebUrl(startIndex) || isOverlapping(startIndex, endIndex)) continue;

    const parsedTarget = parseTargetReference(inner);
    if (parsedTarget) {
      links.push({
        text: rawMatch,
        path: parsedTarget.path,
        line: parsedTarget.line,
        column: parsedTarget.column,
        startIndex,
        endIndex,
      });
    }
  }

  // 5. Unquoted file paths: relative or absolute with recognized extension or known filename
  const candidateRegex = /(?:^|[\s"'`(\[{<>=:,])((?:(?:\.{1,2}|\~)?\/)?(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?|\(\d+(?:,\s*\d+)?\))?)/g;

  while ((m = candidateRegex.exec(lineText)) !== null) {
    let raw = m[1];
    if (!raw || raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("file://")) continue;

    const matchFull = m[0];
    const prefixLen = matchFull.length - raw.length;
    const startIndex = m.index + prefixLen;

    if (isInsideWebUrl(startIndex)) continue;

    // Strip trailing punctuation (preserve closing paren if part of (line,col) or (line))
    let trimmed = raw;
    if (!/\(\d+(?:,\s*\d+)?\)$/.test(raw)) {
      trimmed = trimmed.replace(/[.,;!?:)]+$/, "");
    } else {
      trimmed = trimmed.replace(/[.,;!?:]+$/, "");
    }
    if (!trimmed) continue;
    raw = trimmed;

    const endIndex = startIndex + raw.length;
    if (isOverlapping(startIndex, endIndex)) continue;

    // Only the unquoted site can be a diff header: Markdown, quoted, and
    // file:// targets carry their own syntax, so their `a/` / `b/` stays literal.
    const parsedTarget = parseTargetReference(raw, { diffHeader: isDiffHeaderTarget(lineText, startIndex) });
    if (!parsedTarget) continue;

    links.push({
      text: raw,
      path: parsedTarget.path,
      line: parsedTarget.line,
      column: parsedTarget.column,
      startIndex,
      endIndex,
    });
  }

  return links.sort((a, b) => a.startIndex - b.startIndex);
}

export interface ParsedTerminalWebLink {
  text: string;
  url: string;
  startIndex: number;
  endIndex: number;
}

/** http(s) URLs on one terminal line. Trailing punctuation stays outside the link. */
export function parseTerminalWebLinks(lineText: string): ParsedTerminalWebLink[] {
  const links: ParsedTerminalWebLink[] = [];
  if (!lineText) return links;
  const webRegex = /(?:https?:\/\/|(?:localhost|127\.0\.0\.1):)\S+/gi;
  let match: RegExpExecArray | null;
  while ((match = webRegex.exec(lineText)) !== null) {
    let text = match[0];
    while (/[.,;!?:]$/.test(text) || (text.endsWith(")") && !text.includes("("))) text = text.slice(0, -1);
    const url = terminalWebUrl(text);
    if (!url) continue;
    links.push({ text, url, startIndex: match.index, endIndex: match.index + text.length });
  }
  return links;
}

/** Cmd-click on macOS, Ctrl-click elsewhere. A plain click keeps selecting text. */
export function isTerminalLinkClick(event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  if (event.button !== 0 || event.altKey) return false;
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Maps each UTF-16 offset of a line's string (up to `textLength`) to its
 * 0-based terminal cell, using only the supported buffer API.
 *
 * Wide characters occupy two cells but appear once in the string, combined
 * marks share one cell, and empty cells stringify as a space — so string
 * offsets and cell columns diverge after any non-trivial cell. The public
 * `translateToString` takes only three arguments: the internal out-columns
 * fourth argument is unreachable, and an `any` cast cannot change that.
 */
export function cellColumnsForLine(line: IBufferLine, textLength: number): number[] {
  const columns: number[] = [];
  let x = 0;
  while (x < line.length && columns.length < textLength) {
    const cell = line.getCell(x);
    if (!cell) {
      columns.push(x);
      x++;
      continue;
    }
    // Empty cells stringify as one space; wide cells advance past their placeholder.
    const chars = cell.getChars() || " ";
    const width = cell.getWidth() || 1;
    for (let i = 0; i < chars.length; i++) columns.push(x);
    x += width;
  }
  return columns;
}

/**
 * Creates an xterm.js ILinkProvider for clickable terminal file references.
 */
export function createTerminalLinkProvider(
  term: Terminal,
  onOpenFile: (link: ParsedTerminalFileLink) => void,
  onOpenWeb: (url: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const lineText = line.translateToString(true);
      if (!lineText.trim()) {
        callback(undefined);
        return;
      }

      const parsed = parseTerminalFileLinks(lineText);
      const webs = parseTerminalWebLinks(lineText);
      if (parsed.length === 0 && webs.length === 0) {
        callback(undefined);
        return;
      }

      // Link ranges are terminal cells (1-based, end-inclusive), not string offsets.
      const columns = cellColumnsForLine(line, lineText.length);
      const cellOf = (offset: number): number => (offset < columns.length ? columns[offset]! : offset);
      const rangeFor = (startIndex: number, endIndex: number): IBufferRange => {
        const startX = cellOf(startIndex) + 1;
        const endCharIdx = Math.max(0, endIndex - 1);
        const endX = cellOf(endCharIdx) + 1;
        return {
          start: { x: startX, y: bufferLineNumber },
          end: { x: endX, y: bufferLineNumber },
        };
      };

      const links: ILink[] = [
        ...parsed.map((item): ILink => ({
          text: item.text,
          range: rangeFor(item.startIndex, item.endIndex),
          decorations: { pointerCursor: true, underline: true },
          hover() {
            term.element?.setAttribute("title", `Open ${item.path}${item.line ? `:${item.line}${item.column ? `:${item.column}` : ""}` : ""}`);
          },
          leave() {
            term.element?.removeAttribute("title");
          },
          activate(event: MouseEvent) {
            if (!isTerminalLinkClick(event)) return;
            onOpenFile(item);
          },
        })),
        ...webs.map((item): ILink => ({
          text: item.url,
          range: rangeFor(item.startIndex, item.endIndex),
          decorations: { pointerCursor: true, underline: true },
          hover() {
            term.element?.setAttribute("title", item.url);
          },
          leave() {
            term.element?.removeAttribute("title");
          },
          activate(event: MouseEvent) {
            if (!isTerminalLinkClick(event)) return;
            onOpenWeb(item.url);
          },
        })),
      ];

      callback(links);
    },
  };
}
