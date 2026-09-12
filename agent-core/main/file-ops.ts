/**
 * File tool implementations: reads (offset/line windows, numbered views),
 * directory listings, atomic writes, unique/fuzzy edits, and `@` tag
 * expansion for prompts. Stateless between calls.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { IGNORED_SEGMENTS, parseGitignore, type GitignoreRules } from "../../shared/gitignore.ts";
import {
  BoundedTextAccumulator,
  logicalToolText,
  type CompletionState,
  type ToolTextResult,
} from "../tool-output.ts";
import {
  FILE_TAG_ATTACH_CAP,
  classifyWalkPath,
  confinePath,
  freezeCwd,
  gitignoreSkips,
  parseFileTags,
  posixRel,
  sortUtf8,
  underRoot,
  xmlSafe,
} from "./files.ts";

/** Tool results below this size are never worth a stub. */
const READ_CAP_BYTES = 40 * 1024;
const DIR_LIST_CAP = 200;
const LINE_NUM_WIDTH = 6;
const EDIT_MISS_SHOW = 3;
const EDIT_MISS_LINE_CHARS = 240;
const READ_SCAN_MS = 2_000;
const EDIT_MAX_BYTES = 8 * 1024 * 1024;

export function expandFileTags(cwd: string, prompt: string): string {
  const tags = parseFileTags(prompt);
  if (tags.length === 0) return prompt;
  const chunks: string[] = [];
  let omitted = 0;
  for (let index = 0; index < tags.length; index += 1) {
    const path = tags[index]!;
    if (chunks.length >= FILE_TAG_ATTACH_CAP) {
      omitted = tags.length - index;
      break;
    }
    const confined = confinePath(cwd, path);
    if (!confined.ok) continue;
    let st;
    try {
      st = statSync(confined.abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const listing = listProjectDir(cwd, confined.abs);
      if (listing.isError) continue;
      chunks.push(`<file path="${xmlSafe(path)}">\n${xmlSafe(listing.content)}\n</file>`);
      continue;
    }
    const got = readTextView(confined.abs, { offset: 0 });
    if (got.isError) continue;
    chunks.push(`<file path="${xmlSafe(path)}">\n${xmlSafe(got.content)}\n</file>`);
  }
  if (chunks.length === 0) return prompt;
  const omission = omitted > 0
    ? `\n<!-- ${omitted} file attachments omitted after the ${FILE_TAG_ATTACH_CAP}-file cap; read_file the omitted paths explicitly -->`
    : "";
  return `${prompt}\n\n<tagged-files>\n${chunks.join("\n")}${omission}\n</tagged-files>`;
}

export function parseOffset(value: unknown): number | { error: string } {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) return { error: "error: offset must be a number" };
  const i = Math.floor(n);
  if (i < 0) return { error: "error: offset must be >= 0" };
  return i;
}

export function parseLineBound(value: unknown, field: string): number | { error: string } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) return { error: `error: ${field} must be a number` };
  const i = Math.floor(n);
  if (i < 1) return { error: `error: ${field} must be >= 1` };
  return i;
}

function linePrefix(n: number): string {
  const s = String(n);
  return `${s.length >= LINE_NUM_WIDTH ? s : s.padStart(LINE_NUM_WIDTH, " ")}|`;
}

export function formatNumberedText(text: string, startLine: number): string {
  if (text === "") return "";
  const endsWithNl = text.endsWith("\n");
  const parts = text.split("\n");
  if (endsWithNl) parts.pop();
  return parts.map((line, i) => `${linePrefix(startLine + i)}${line.replace(/\r$/, "")}`).join("\n");
}

function newlineCount(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return n;
}

function lastNewlineIndex(buf: Buffer): number {
  for (let i = buf.length - 1; i >= 0; i--) if (buf[i] === 10) return i;
  return -1;
}

/** Number of source bytes ending at a complete UTF-8 code-point boundary. */
function completeUtf8Boundary(value: Uint8Array): number {
  let cursor = 0;
  while (cursor < value.byteLength) {
    const first = value[cursor]!;
    let length = 0;
    if (first <= 0x7f) length = 1;
    else if (first >= 0xc2 && first <= 0xdf) length = 2;
    else if (first >= 0xe0 && first <= 0xef) length = 3;
    else if (first >= 0xf0 && first <= 0xf4) length = 4;
    else break;
    if (cursor + length > value.byteLength) break;
    const second = value[cursor + 1];
    if (length >= 2) {
      if (second === undefined || (second & 0xc0) !== 0x80) break;
      if (first === 0xe0 && second < 0xa0) break;
      if (first === 0xed && second >= 0xa0) break;
      if (first === 0xf0 && second < 0x90) break;
      if (first === 0xf4 && second >= 0x90) break;
      for (let i = 2; i < length; i += 1) {
        if ((value[cursor + i]! & 0xc0) !== 0x80) return cursor;
      }
    }
    cursor += length;
  }
  return cursor;
}

function scanTimedOut(started: number): boolean {
  return Date.now() - started >= READ_SCAN_MS;
}

function countNewlinesInRange(fd: number, end: number, started: number): number | { error: string; timedOut: boolean } {
  if (end <= 0) return 0;
  const chunk = Buffer.alloc(Math.min(64 * 1024, end));
  let pos = 0;
  let nls = 0;
  while (pos < end) {
    if (scanTimedOut(started)) return { error: "error: read timed out", timedOut: true };
    const want = Math.min(chunk.length, end - pos);
    const n = readSync(fd, chunk, 0, want, pos);
    if (n <= 0) break;
    for (let i = 0; i < n; i++) if (chunk[i] === 10) nls++;
    pos += n;
  }
  return nls;
}

/** Find both line boundaries in one pass, or `size` when a requested line is
 * beyond EOF. A range read must not rescan the file prefix for its end line. */
function lineRangeOffsets(
  fd: number,
  size: number,
  startLine: number,
  endLine: number | undefined,
  started: number,
): { start: number; end: number } | { error: string; timedOut: boolean } {
  const startTarget = Math.max(1, startLine);
  const endTarget = endLine === undefined ? undefined : Math.max(1, endLine + 1);
  let start = startTarget <= 1 ? 0 : -1;
  let end = endTarget === undefined ? size : -1;
  if (start === 0 && endTarget === undefined) return { start, end };
  const chunk = Buffer.alloc(64 * 1024);
  let pos = 0;
  let current = 1;
  while (pos < size) {
    if (scanTimedOut(started)) return { error: "error: read timed out", timedOut: true };
    const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
    if (n <= 0) break;
    for (let i = 0; i < n; i++) {
      if (chunk[i] === 10) {
        current++;
        const offset = pos + i + 1;
        if (start < 0 && current === startTarget) start = offset;
        if (end < 0 && endTarget !== undefined && current === endTarget) {
          end = offset;
          if (start >= 0) return { start, end };
        }
      }
    }
    pos += n;
  }
  return { start: start < 0 ? size : start, end: end < 0 ? size : end };
}

function gitignoreRulesFor(root: string, dirAbs: string): GitignoreRules {
  const rules: GitignoreRules = new Map();
  const dirs: string[] = [];
  let cur = dirAbs;
  for (;;) {
    dirs.push(cur);
    if (cur === root) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    if (parent !== root && !underRoot(parent, root)) break;
    cur = parent;
  }
  for (const dir of dirs.reverse()) {
    try {
      const gi = join(dir, ".gitignore");
      if (!existsSync(gi)) continue;
      const rel = dir === root ? "" : posixRel(root, dir);
      rules.set(rel, parseGitignore(readFileSync(gi, "utf8")));
    } catch {
      /* unreadable gitignore */
    }
  }
  return rules;
}

export function listProjectDir(cwd: string, abs: string): ToolTextResult {
  const root = freezeCwd(cwd);
  let dirReal = abs;
  try {
    dirReal = realpathSync(abs);
  } catch (err) {
    return logicalToolText(`error: ${(err as Error).message}`, {
      maxBytes: READ_CAP_BYTES,
      state: "failed",
      isError: true,
    });
  }
  if (!underRoot(dirReal, root)) return logicalToolText("error: path outside project", {
    maxBytes: READ_CAP_BYTES,
    state: "failed",
    isError: true,
  });
  let ents;
  try {
    ents = readdirSync(dirReal, { withFileTypes: true });
  } catch (err) {
    return logicalToolText(`error: ${(err as Error).message}`, {
      maxBytes: READ_CAP_BYTES,
      state: "unreadable",
      isError: true,
    });
  }
  const names = sortUtf8(ents.map((e) => e.name));
  const gi = gitignoreRulesFor(root, dirReal);
  const rows: string[] = [];
  let omitted = 0;
  for (const name of names) {
    if (name === "." || name === "..") continue;
    if (IGNORED_SEGMENTS.has(name)) continue;
    const classified = classifyWalkPath(join(dirReal, name), root);
    if (!classified) continue;
    const rel = posixRel(root, classified.real);
    if (gitignoreSkips(gi, rel, classified.kind === "dir")) continue;
    if (rows.length >= DIR_LIST_CAP) {
      omitted++;
      continue;
    }
    const cleaned = name.replace(/[\x00-\x1f\x7f]/g, " ");
    rows.push(classified.kind === "dir" ? `${cleaned}/` : cleaned);
  }
  const relDir = (posixRel(root, dirReal) || ".").replace(/[\x00-\x1f\x7f]/g, " ");
  let body = rows.length > 0 ? rows.join("\n") : "(empty directory)";
  if (omitted > 0) body += `\n<!-- ${omitted} entries omitted -->`;
  const continuation = omitted > 0 ? `List ${JSON.stringify(relDir)} with a narrower path or filter.` : null;
  return logicalToolText(`[directory ${relDir}]\n${body}`, {
    maxBytes: READ_CAP_BYTES,
    state: "complete",
    isError: false,
    forceMarker: omitted > 0,
    marker: continuation,
    continuation,
  });
}

function truncationMarker(nextOffset: number, nextLine?: number): string {
  if (nextLine !== undefined) {
    return `[truncated at ${READ_CAP_BYTES} bytes — read_file offset ${nextOffset} — start_line ${nextLine}]`;
  }
  return `[truncated at ${READ_CAP_BYTES} bytes — read_file offset ${nextOffset}]`;
}

export function readTextView(
  abs: string,
  opts: { offset: number; startLine?: number; endLine?: number },
): ToolTextResult {
  const repro = `read_file(${JSON.stringify(abs)})`;
  const fail = (content: string, state: CompletionState = "failed"): ToolTextResult => logicalToolText(content, {
    maxBytes: READ_CAP_BYTES,
    state,
    isError: true,
    repro,
  });
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const st = fstatSync(fd);
    const head = Buffer.alloc(Math.min(4096, st.size));
    if (head.length > 0) readSync(fd, head, 0, head.length, 0);
    if (head.includes(0)) return fail("error: binary file");
    if (st.size === 0) return logicalToolText("", {
      maxBytes: READ_CAP_BYTES,
      state: "complete",
      isError: false,
      repro,
    });

    const started = Date.now();
    const lineMode = opts.startLine !== undefined || opts.endLine !== undefined;
    const startLine = opts.startLine ?? 1;
    const endLine = opts.endLine;
    let from = opts.offset;
    let viewStartLine = 1;
    let until = st.size;
    if (lineMode) {
      const offsets = lineRangeOffsets(fd, st.size, startLine, endLine, started);
      if ("error" in offsets) return fail(offsets.error, offsets.timedOut ? "timeout" : "failed");
      from = offsets.start;
      viewStartLine = startLine;
      until = offsets.end;
    } else {
      const nls = countNewlinesInRange(fd, from, started);
      if (typeof nls === "object") return fail(nls.error, nls.timedOut ? "timeout" : "failed");
      viewStartLine = nls + 1;
    }
    if (from >= st.size || from >= until) return logicalToolText("", {
      maxBytes: READ_CAP_BYTES,
      state: "complete",
      isError: false,
      repro,
    });
    const want = Math.min(READ_CAP_BYTES, Math.max(0, until - from));
    const slice = Buffer.alloc(want);
    if (want > 0) readSync(fd, slice, 0, want, from);
    const more = from + want < until;
    let view = slice;
    let nextOffset = from + want;
    let atLineBoundary = false;
    if (more) {
      const nl = lastNewlineIndex(slice);
      if (nl >= 0) {
        view = slice.subarray(0, nl + 1);
        nextOffset = from + nl + 1;
        atLineBoundary = true;
      }
    }
    const safe = new BoundedTextAccumulator({ maxBytes: READ_CAP_BYTES, direction: "head", marker: "" });
    safe.push(view);
    const safeText = safe.finish();
    // The provider-visible continuation is a byte offset into the source,
    // not the end of the raw read buffer.  A cap can split a 2–4 byte code
    // point; advancing by `want` would silently skip its remaining bytes.
    const completeBytes = completeUtf8Boundary(view);
    const sourceBoundary = Math.min(safeText.retainedBytes, completeBytes);
    nextOffset = from + sourceBoundary;
    const numbered = formatNumberedText(safeText.text, viewStartLine);
    if (nextOffset < until) {
      const nextLine = atLineBoundary && sourceBoundary === view.length
        ? viewStartLine + newlineCount(view)
        : undefined;
      const marker = truncationMarker(nextOffset, nextLine);
      return logicalToolText(numbered, {
        maxBytes: READ_CAP_BYTES,
        state: "complete",
        isError: false,
        forceMarker: true,
        marker,
        continuation: marker,
        repro,
      });
    }
    if (safeText.truncated) {
      const marker = truncationMarker(nextOffset);
      return logicalToolText(numbered, {
        maxBytes: READ_CAP_BYTES,
        state: "unreadable",
        isError: true,
        forceMarker: true,
        marker,
        continuation: marker,
        repro,
      });
    }
    return logicalToolText(numbered, {
      maxBytes: READ_CAP_BYTES,
      state: "complete",
      isError: false,
      repro,
    });
  } catch (err) {
    return fail(`error: ${(err as Error).message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function nestedAgentsPointer(cwd: string, fileAbs: string): string | null {
  const root = freezeCwd(cwd);
  let abs = fileAbs;
  try {
    if (existsSync(fileAbs)) abs = realpathSync(fileAbs);
  } catch {
    abs = resolve(fileAbs);
  }
  if (basename(abs) === "AGENTS.md") return null;
  if (!underRoot(abs, root)) return null;
  let dir = dirname(abs);
  while (dir.startsWith(root + sep)) {
    const candidate = join(dir, "AGENTS.md");
    if (existsSync(candidate)) {
      try {
        const real = realpathSync(candidate);
        if (!underRoot(real, root)) return null;
      } catch {
        return null;
      }
      const rel = relative(root, candidate).split(sep).join("/");
      return `[package instructions: ${rel} — read_file that path]`;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function readFileResult(abs: string, offset: number): ToolTextResult {
  const repro = `read_file(${JSON.stringify(abs)})`;
  const fail = (content: string): ToolTextResult => logicalToolText(content, {
    maxBytes: READ_CAP_BYTES,
    state: "failed",
    isError: true,
    repro,
  });
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const st = fstatSync(fd);
    const head = Buffer.alloc(Math.min(4096, st.size));
    if (head.length > 0) readSync(fd, head, 0, head.length, 0);
    if (head.includes(0)) return fail("error: binary file");
    if (offset >= st.size) return logicalToolText("", {
      maxBytes: READ_CAP_BYTES,
      state: "complete",
      isError: false,
      repro,
    });
    const want = Math.min(READ_CAP_BYTES, Math.max(0, st.size - offset));
    const slice = Buffer.alloc(want);
    if (want > 0) readSync(fd, slice, 0, want, offset);
    const safe = new BoundedTextAccumulator({ maxBytes: READ_CAP_BYTES, direction: "head", marker: "" });
    safe.push(slice);
    const text = safe.finish();
    const completeBytes = completeUtf8Boundary(slice);
    const nextOffset = offset + Math.min(text.retainedBytes, completeBytes);
    const marker = nextOffset < st.size
      ? `[truncated at ${READ_CAP_BYTES} bytes — read_file offset ${nextOffset}]`
      : text.truncated
        ? `[invalid UTF-8 omitted — continue with read_file offset ${nextOffset}]`
        : null;
    const result = logicalToolText(text.text, {
      maxBytes: READ_CAP_BYTES,
      state: nextOffset >= st.size && text.truncated ? "unreadable" : "complete",
      isError: nextOffset >= st.size && text.truncated,
      forceMarker: marker !== null,
      marker,
      continuation: marker,
      repro,
    });
    return result;
  } catch (err) {
    return fail(`error: ${(err as Error).message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readProjectFile(
  cwd: string,
  input: { path?: string; offset?: unknown; start_line?: unknown; end_line?: unknown },
  allow?: ReadonlySet<string>,
): ToolTextResult {
  const fail = (content: string): ToolTextResult => logicalToolText(content, {
    maxBytes: READ_CAP_BYTES,
    state: "failed",
    isError: true,
  });
  const off = parseOffset(input.offset);
  if (typeof off !== "number") return fail(off.error);
  const startLine = parseLineBound(input.start_line, "start_line");
  if (typeof startLine === "object") return fail(startLine.error);
  const endLine = parseLineBound(input.end_line, "end_line");
  if (typeof endLine === "object") return fail(endLine.error);
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    return fail("error: end_line must be >= start_line");
  }
  if (off > 0 && (startLine !== undefined || endLine !== undefined)) {
    return fail("error: use start_line or offset, not both");
  }
  const confined = confinePath(cwd, input.path ?? "", { allow });
  if (!confined.ok) return fail(confined.error);
  let st;
  try {
    st = statSync(confined.abs);
  } catch (err) {
    return fail(`error: ${(err as Error).message}`);
  }
  if (st.isDirectory()) {
    if (off > 0 || startLine !== undefined || endLine !== undefined) {
      return fail("error: path is a directory");
    }
    return listProjectDir(cwd, confined.abs);
  }
  const got = readTextView(confined.abs, { offset: off, startLine, endLine });
  if (got.isError) return got;
  const pointer = nestedAgentsPointer(cwd, confined.abs);
  if (pointer) {
    const pointerContent = `${pointer}\n${got.content}`;
    const pointerContinuation = typeof got.continuation === "string"
      ? got.continuation
      : `Continue with read_file(${JSON.stringify(confined.abs)}).`;
    const withPointer = logicalToolText(pointerContent, {
      maxBytes: READ_CAP_BYTES,
      state: got.state,
      isError: got.isError,
      forceMarker: Buffer.byteLength(pointerContent, "utf8") > READ_CAP_BYTES,
      marker: pointerContinuation,
      continuation: typeof got.continuation === "string" ? got.continuation : null,
      repro: got.repro ?? null,
    });
    return Object.freeze({
      ...withPointer,
      truncated: withPointer.truncated || got.truncated,
      continuation: withPointer.continuation ?? got.continuation ?? null,
      repro: withPointer.repro ?? got.repro ?? null,
    });
  }
  return got;
}

function atomicWrite(path: string, content: string, mode?: number): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* preserve the original error */
    }
    throw err;
  }
}

export function writeProjectFile(cwd: string, path: string | undefined, content: string): { content: string; isError: boolean } {
  const confined = confinePath(cwd, path ?? "");
  if (!confined.ok) return { content: confined.error, isError: true };
  try {
    mkdirSync(dirname(confined.abs), { recursive: true });
    let mode: number | undefined;
    try {
      mode = statSync(confined.abs).mode & 0o777;
    } catch {
      /* use the process umask for a new file */
    }
    atomicWrite(confined.abs, content, mode);
    return { content: `ok: wrote ${posixRel(freezeCwd(cwd), confined.abs)}`, isError: false };
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, isError: true };
  }
}

export type EditResult = {
  content: string;
  isError: boolean;
  edits?: Array<{ oldText: string; newText: string }>;
};

export function isReplaceAll(value: unknown): boolean {
  return value === true || value === "true";
}

export function editMissDiagnostic(body: string, oldText: string): string {
  const hits: number[] = [];
  let count = 0;
  let idx = 0;
  const step = Math.max(oldText.length, 1);
  while (idx < body.length) {
    const at = body.indexOf(oldText, idx);
    if (at < 0) break;
    count++;
    if (hits.length < EDIT_MISS_SHOW) hits.push(at);
    idx = at + step;
  }
  const kind = count === 0 ? "old_text not found" : "old_text is not unique";
  const noun = count === 1 ? "occurrence" : "occurrences";
  const lines = [`error: ${kind} (${count} ${noun})`];
  for (const at of hits) {
    const lineNo = body.slice(0, at).split("\n").length;
    const lineStart = at === 0 ? 0 : body.lastIndexOf("\n", at - 1) + 1;
    const nl = body.indexOf("\n", at);
    const line = body.slice(lineStart, nl < 0 ? body.length : nl).replace(/\r$/, "");
    const clipped = line.length > EDIT_MISS_LINE_CHARS ? `${line.slice(0, EDIT_MISS_LINE_CHARS)}...` : line;
    lines.push(`  ${lineNo}:${clipped}`);
  }
  if (count > hits.length) lines.push(`  (${count - hits.length} more)`);
  return lines.join("\n");
}

/** Upstream-style fuzzy fallback (opencode replacers, minimal subset). Exact stays
 * authoritative; these only rescue whitespace/indent/trim drift and refuse
 * disproportionate spans so a wrong block can never apply. */
function findFuzzyEditSpan(body: string, oldText: string): { at: number; len: number } | { ambiguous: true } | null {
  // Compare on CRLF-normalized lines but index the original body: raw line
  // starts keep every \r accounted for so the span never shifts the cut.
  const rawLines = body.split("\n");
  const bodyLines = rawLines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const bodyTrimmed = bodyLines.map((line) => line.trim());
  const starts: number[] = new Array<number>(rawLines.length);
  let lineStart = 0;
  for (let k = 0; k < rawLines.length; k++) {
    starts[k] = lineStart;
    lineStart += rawLines[k]!.length + 1;
  }
  const findLines = oldText.replace(/\r\n/g, "\n").split("\n");
  while (findLines.length > 0 && findLines[findLines.length - 1]!.trim() === "" && oldText.endsWith("\n")) findLines.pop();
  if (findLines.length === 0 || findLines.every((l) => l.trim() === "")) return null;
  const findTrimmed = findLines.map((line) => line.trim());
  const matches: Array<{ at: number; len: number }> = [];
  // 1. Line-trimmed block match (indent drift, line-number prefix copy errors).
  for (let i = 0; i <= bodyLines.length - findLines.length; i++) {
    let ok = true;
    for (let j = 0; j < findLines.length; j++) {
      if (bodyTrimmed[i + j]! !== findTrimmed[j]!) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const at = starts[i]!;
    const last = i + findLines.length - 1;
    const len = starts[last]! + rawLines[last]!.length - at;
    matches.push({ at, len });
    if (matches.length > 1) return { ambiguous: true };
  }
  if (matches.length === 1) {
    const m = matches[0]!;
    if (m.len > Math.max(64, oldText.length * 4)) return null;
    return m;
  }
  return null;
}

/** First unique occurrence of oldText, or every occurrence when replaceAll is set.
 *  Does not write when the match is missing. Unique mode also fails when repeated. */
export function editProjectFile(
  cwd: string,
  path: string | undefined,
  oldText: string,
  newText: string,
  replaceAll = false,
): EditResult {
  if (oldText === "") return { content: "error: old_text must not be empty", isError: true };
  const confined = confinePath(cwd, path ?? "", { mustExist: true });
  if (!confined.ok) return { content: confined.error, isError: true };
  let st;
  try {
    st = statSync(confined.abs);
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, isError: true };
  }
  if (st.isDirectory()) return { content: "error: EISDIR", isError: true };
  if (st.size > EDIT_MAX_BYTES) return { content: `error: file exceeds ${EDIT_MAX_BYTES} bytes`, isError: true };
  let fd: number | undefined;
  let body: string;
  try {
    fd = openSync(confined.abs, "r");
    const buf = Buffer.alloc(st.size);
    if (st.size > 0) readSync(fd, buf, 0, st.size, 0);
    if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
      return { content: "error: binary file", isError: true };
    }
    body = buf.toString("utf8");
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, isError: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  const ending = body.includes("\r\n") ? "\r\n" : "\n";
  const old = oldText.replace(/\r\n/g, "\n").replace(/\n/g, ending).replace(/^\uFEFF/, "");
  const replacement = newText.replace(/\r\n/g, "\n").replace(/\n/g, ending);
  if (!replaceAll) {
    let count = 0;
    let idx = 0;
    while (idx < body.length) {
      const at = body.indexOf(old, idx);
      if (at < 0) break;
      count++;
      if (count > 1) return { content: editMissDiagnostic(body, old), isError: true };
      idx = at + old.length;
    }
    if (count === 0) {
      const fuzzy = findFuzzyEditSpan(body, old);
      if (fuzzy && !("ambiguous" in fuzzy)) {
        const next = body.slice(0, fuzzy.at) + replacement + body.slice(fuzzy.at + fuzzy.len);
        try {
          atomicWrite(confined.abs, next, st.mode & 0o777);
        } catch (err) {
          return { content: `error: ${(err as Error).message}`, isError: true };
        }
        return {
          content: `ok: edited ${posixRel(freezeCwd(cwd), confined.abs)} (whitespace/indent-tolerant match)`,
          isError: false,
          edits: [{ oldText, newText }],
        };
      }
      return { content: editMissDiagnostic(body, old), isError: true };
    }
    const at = body.indexOf(old);
    const next = body.slice(0, at) + replacement + body.slice(at + old.length);
    try {
      atomicWrite(confined.abs, next, st.mode & 0o777);
    } catch (err) {
      return { content: `error: ${(err as Error).message}`, isError: true };
    }
    return {
      content: `ok: edited ${posixRel(freezeCwd(cwd), confined.abs)}`,
      isError: false,
      edits: [{ oldText, newText }],
    };
  }
  let next = body;
  let from = 0;
  let n = 0;
  while (from <= next.length) {
    const at = next.indexOf(old, from);
    if (at < 0) break;
    next = next.slice(0, at) + replacement + next.slice(at + old.length);
    from = at + replacement.length;
    n++;
  }
  if (n === 0) return { content: editMissDiagnostic(body, old), isError: true };
  try {
    atomicWrite(confined.abs, next, st.mode & 0o777);
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, isError: true };
  }
  return {
    content: `ok: edited ${posixRel(freezeCwd(cwd), confined.abs)} (${n} replacements)`,
    isError: false,
  };
}

/** Per-file promise chains so concurrent batch tools never interleave mutations. */
const fileMutationChains = new Map<string, Promise<void>>();

export function fileMutationKey(cwd: string, inputPath: string | undefined): string | null {
  const confined = confinePath(cwd, inputPath);
  return confined.ok ? confined.abs : null;
}

/** Run fn after the previous mutation on key settles. Null keys run unserialized. */
export async function withFileMutation<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  if (key === null) return fn();
  const prev = fileMutationChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => mine);
  fileMutationChains.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileMutationChains.get(key) === chained) fileMutationChains.delete(key);
  }
}
