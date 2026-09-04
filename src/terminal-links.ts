import type { IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "java", "c", "cpp", "cc", "cxx", "h", "hpp", "cs", "rb", "php", "swift", "kt", "scala",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "json", "jsonl", "json5", "yaml", "yml", "toml", "html", "htm", "css", "scss", "sass", "less", "sql",
  "md", "markdown", "mdx", "txt", "xml", "svg", "env", "lock",
  "vue", "svelte", "astro", "graphql", "gql", "proto", "ini", "cfg", "conf", "diff", "patch",
  "log", "csv", "tsv",
]);

const KNOWN_FILENAMES = new Set([
  "dockerfile", "makefile", "gemfile", "rakefile", "cmakelists.txt", "license", "licence", "readme",
  ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc", ".prettierrc", ".eslintrc",
  "cargo.toml", "cargo.lock", "package.json", "pnpm-lock.yaml", "tsconfig.json",
]);

export interface ParsedTerminalFileLink {
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
 */
export function parseTargetReference(target: string): { path: string; line?: number; column?: number } | null {
  let cleaned = target;
  if (!/\(\d+(?:,\s*\d+)?\)$/.test(target)) {
    cleaned = cleaned.replace(/[.,;!?:)]+$/, "");
  } else {
    cleaned = cleaned.replace(/[.,;!?:]+$/, "");
  }
  if (!cleaned) return null;

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

  const cleanPath = cleaned.replace(/^[ab]\//, "");
  const baseName = cleanPath.split("/").pop() ?? "";
  const dotIdx = baseName.lastIndexOf(".");
  const ext = dotIdx > 0 ? baseName.slice(dotIdx + 1).toLowerCase() : "";
  const hasDirectory = cleanPath.includes("/");

  const isRecognized =
    (ext && KNOWN_EXTENSIONS.has(ext)) ||
    KNOWN_FILENAMES.has(baseName.toLowerCase()) ||
    (hasDirectory && ext.length >= 1 && ext.length <= 10 && /^[a-zA-Z0-9]+$/.test(ext));

  if (!isRecognized) return null;
  return { path: cleanPath, line, column: col };
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
  const webRegex = /https?:\/\/[^\s"'`()\[\]{}]+/gi;
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

    const parsedTarget = parseTargetReference(raw);
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

/**
 * Creates an xterm.js ILinkProvider for clickable terminal file references.
 */
export function createTerminalLinkProvider(
  term: Terminal,
  onOpen: (link: ParsedTerminalFileLink) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const outColumns: number[] = [];
      const lineText = (line as any).translateToString(true, undefined, undefined, outColumns);
      if (!lineText.trim()) {
        callback(undefined);
        return;
      }

      const parsed = parseTerminalFileLinks(lineText);
      if (parsed.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = parsed.map((item) => {
        const startX = outColumns.length > item.startIndex
          ? outColumns[item.startIndex] + 1
          : item.startIndex + 1;
        const endCharIdx = Math.max(0, item.endIndex - 1);
        const endX = outColumns.length > endCharIdx
          ? outColumns[endCharIdx] + 1
          : item.endIndex;

        const range: IBufferRange = {
          start: { x: startX, y: bufferLineNumber },
          end: { x: endX, y: bufferLineNumber },
        };
        const tooltip = `Open ${item.path}${item.line ? `:${item.line}${item.column ? `:${item.column}` : ""}` : ""}`;
        return {
          text: item.text,
          range,
          decorations: {
            pointerCursor: true,
            underline: true,
          },
          hover() {
            term.element?.setAttribute("title", tooltip);
          },
          leave() {
            term.element?.removeAttribute("title");
          },
          activate(_event: MouseEvent) {
            onOpen(item);
          },
        };
      });

      callback(links);
    },
  };
}
