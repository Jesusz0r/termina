/**
 * File tool implementations: reads (offset/line windows, numbered views),
 * directory listings, atomic writes, unique/fuzzy edits, and `@` tag
 * expansion for prompts. Stateless between calls.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  readdirSync,
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
  utf8BytePrefix,
  type CompletionState,
  type ToolTextResult,
} from "../tool-output.ts";
import {
  FILE_TAG_ATTACH_CAP,
  classifyWalkPath,
  confinePath,
  freezeCwd,
  gitignoreSkips,
  openRegularFile,
  parseFileTags,
  posixRel,
  readIgnoreFile,
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

function stripCarriage(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function numberLine(n: number, raw: string): string {
  return `${linePrefix(n)}${stripCarriage(raw)}`;
}

function splitPageLines(text: string): { parts: string[]; endsWithNl: boolean } {
  const endsWithNl = text.endsWith("\n");
  const parts = text.split("\n");
  if (endsWithNl) parts.pop();
  return { parts, endsWithNl };
}

export function formatNumberedText(text: string, startLine: number): string {
  if (text === "") return "";
  return splitPageLines(text).parts.map((line, i) => numberLine(startLine + i, line)).join("\n");
}

function lastNewlineIndex(buf: Buffer): number {
  for (let i = buf.length - 1; i >= 0; i--) if (buf[i] === 10) return i;
  return -1;
}

/** Number of source bytes ending at a complete UTF-8 code-point boundary. */
function completeUtf8Boundary(value: Uint8Array): number {
  return utf8BytePrefix(value, value.byteLength).byteLength;
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
      const text = readIgnoreFile(join(dir, ".gitignore"));
      if (text === null) continue;
      const rel = dir === root ? "" : posixRel(root, dir);
      rules.set(rel, parseGitignore(text));
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

/** Largest integer with the same decimal width (marker-size probing). */
function maxSameWidth(value: number): number {
  return Number("9".repeat(String(Math.max(0, Math.floor(value))).length));
}

interface NumberedPageEmission {
  body: string;
  /** Source bytes covered by the emitted body. */
  emittedBytes: number;
  /** Whole numbered lines emitted. */
  emittedLines: number;
  /** Body ends mid-line (the first line alone exceeded the budget). */
  partial: boolean;
}

/**
 * Budget numbered lines (prefixes included) into bodyLimit display bytes,
 * mapping back to the source bytes actually emitted (#156). Whole lines
 * only, except a code-point-safe partial first line when even one line
 * exceeds the budget. The continuation offset derives from this mapping,
 * never from the raw read length, so following it cannot skip displayed
 * or undisplayed source text.
 */
export function emitNumberedPage(text: string, startLine: number, bodyLimit: number): NumberedPageEmission {
  const { parts, endsWithNl } = splitPageLines(text);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "" && !endsWithNl)) {
    return { body: "", emittedBytes: 0, emittedLines: 0, partial: false };
  }
  const rendered: string[] = [];
  let used = 0;
  let emittedBytes = 0;
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]!;
    const display = numberLine(startLine + i, raw);
    const entryBytes = Buffer.byteLength(display, "utf8") + (rendered.length > 0 ? 1 : 0);
    if (used + entryBytes > bodyLimit) break;
    used += entryBytes;
    rendered.push(display);
    emittedBytes += Buffer.byteLength(raw, "utf8") + (i < parts.length - 1 || endsWithNl ? 1 : 0);
  }
  if (rendered.length > 0) {
    return { body: rendered.join("\n"), emittedBytes, emittedLines: rendered.length, partial: false };
  }
  const prefix = linePrefix(startLine);
  const room = Math.max(0, bodyLimit - Buffer.byteLength(prefix, "utf8"));
  const content = Buffer.from(stripCarriage(parts[0]!), "utf8");
  const keep = completeUtf8Boundary(content.subarray(0, room));
  const body = prefix + content.subarray(0, keep).toString("utf8");
  return { body, emittedBytes: keep, emittedLines: 0, partial: true };
}

interface PlainPageEmission {
  body: string;
  emittedBytes: number;
}

/** Byte-budget plain text on a code-point boundary, with its source span. */
export function emitPlainPage(text: string, bodyLimit: number): PlainPageEmission {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bodyLimit) return { body: text, emittedBytes: buf.length };
  const keep = completeUtf8Boundary(buf.subarray(0, bodyLimit));
  return { body: buf.subarray(0, keep).toString("utf8"), emittedBytes: keep };
}

function renderNumberedView(args: {
  text: string;
  from: number;
  until: number;
  viewStartLine: number;
  sourceBoundary: number;
  decodeTruncated: boolean;
  pointerReserve: number;
  repro: string;
}): ToolTextResult {
  const rawComplete = args.from + args.sourceBoundary >= args.until;
  // Fast path: the whole window fits without a marker; byte shape matches
  // the pre-budget renderer exactly (plus pointer room for the re-wrap).
  const full = emitNumberedPage(args.text, args.viewStartLine, READ_CAP_BYTES - args.pointerReserve);
  if (!args.decodeTruncated && rawComplete && !full.partial && full.emittedBytes >= args.sourceBoundary) {
    return logicalToolText(full.body, {
      maxBytes: READ_CAP_BYTES,
      state: "complete",
      isError: false,
      repro: args.repro,
    });
  }
  // Truncated path: probe the marker at worst-case digit width (final values
  // can only be smaller, so the reserved marker bytes never overflow), then
  // emit within the remaining budget.
  const totalLines = splitPageLines(args.text).parts.length;
  const probe = truncationMarker(maxSameWidth(args.until), maxSameWidth(args.viewStartLine + totalLines));
  const bodyLimit = Math.max(1024, READ_CAP_BYTES - Buffer.byteLength(probe, "utf8") - 1 - args.pointerReserve);
  const page = emitNumberedPage(args.text, args.viewStartLine, bodyLimit);
  let nextOffset = args.from + Math.min(page.emittedBytes, args.sourceBoundary);
  // Undecodable windows emit nothing; skip one byte rather than stalling on
  // the same offset forever.
  if (nextOffset <= args.from && args.until > args.from) nextOffset = args.from + 1;
  const nextLine = page.emittedLines > 0 ? args.viewStartLine + page.emittedLines : undefined;
  if (rawComplete && args.decodeTruncated) {
    const marker = truncationMarker(nextOffset);
    return logicalToolText(page.body, {
      maxBytes: READ_CAP_BYTES,
      state: "unreadable",
      isError: true,
      forceMarker: true,
      marker,
      continuation: marker,
      repro: args.repro,
    });
  }
  const marker = truncationMarker(nextOffset, nextLine);
  return logicalToolText(page.body, {
    maxBytes: READ_CAP_BYTES,
    state: "complete",
    isError: false,
    forceMarker: true,
    marker,
    continuation: marker,
    repro: args.repro,
  });
}

export function readTextView(
  abs: string,
  opts: { offset: number; startLine?: number; endLine?: number; pointerReserve?: number },
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
    const opened = openRegularFile(abs);
    if ("error" in opened) return fail(opened.error);
    fd = opened.fd;
    const size = opened.size;
    const head = Buffer.alloc(Math.min(4096, size));
    if (head.length > 0) readSync(fd, head, 0, head.length, 0);
    if (head.includes(0)) return fail("error: binary file");
    if (size === 0) return logicalToolText("", {
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
    let until = size;
    if (lineMode) {
      const offsets = lineRangeOffsets(fd, size, startLine, endLine, started);
      if ("error" in offsets) return fail(offsets.error, offsets.timedOut ? "timeout" : "failed");
      from = offsets.start;
      viewStartLine = startLine;
      until = offsets.end;
    } else {
      const nls = countNewlinesInRange(fd, from, started);
      if (typeof nls === "object") return fail(nls.error, nls.timedOut ? "timeout" : "failed");
      viewStartLine = nls + 1;
    }
    if (from >= size || from >= until) return logicalToolText("", {
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
    if (more) {
      const nl = lastNewlineIndex(slice);
      if (nl >= 0) {
        view = slice.subarray(0, nl + 1);
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
    return renderNumberedView({
      text: safeText.text,
      from,
      until,
      viewStartLine,
      sourceBoundary,
      decodeTruncated: safeText.truncated,
      pointerReserve: opts.pointerReserve ?? 0,
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
  // The nested-instructions pointer is prepended after the read and re-capped;
  // reserve its bytes up front so the continuation offset already accounts
  // for the final page shape (#156).
  const pointer = nestedAgentsPointer(cwd, confined.abs);
  const got = readTextView(confined.abs, {
    offset: off,
    startLine,
    endLine,
    pointerReserve: pointer ? Buffer.byteLength(pointer, "utf8") + 1 : 0,
  });
  if (got.isError) return got;
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

/** Maximum files in one batched `read_file` call. One shared bound stays small. */
export const READ_BATCH_CAP = 10;

/**
 * Batched `read_file`: one bounded result for up to READ_BATCH_CAP files.
 * Composes the single-file reader, so jail confinement, numbering, and
 * per-file truncation stay canonical. Sections are whole-file atomic: the
 * result keeps an order-stable prefix that fits READ_CAP_BYTES and names
 * omitted tail files with an explicit re-read hint. Per-file failures render
 * inline; the call only fails when every included file failed.
 */
export function readProjectFiles(
  cwd: string,
  input: { path?: unknown; paths?: unknown; offset?: unknown; start_line?: unknown; end_line?: unknown },
  allow?: ReadonlySet<string>,
): ToolTextResult {
  const fail = (content: string): ToolTextResult => logicalToolText(content, {
    maxBytes: READ_CAP_BYTES,
    state: "failed",
    isError: true,
  });
  if (!Array.isArray(input.paths)) return fail("error: paths must be an array of strings");
  if (input.paths.length < 1) return fail("error: paths must list at least one file");
  if (input.paths.length > READ_BATCH_CAP) return fail(`error: paths caps at ${READ_BATCH_CAP} files per call`);
  if (typeof input.path === "string" && input.path !== "") return fail("error: use path or paths, not both");
  if (input.offset !== undefined && input.offset !== null && input.offset !== "") {
    return fail("error: offset applies to a single path; omit it with paths");
  }
  if ((input.start_line !== undefined && input.start_line !== null && input.start_line !== "") ||
    (input.end_line !== undefined && input.end_line !== null && input.end_line !== "")) {
    return fail("error: start_line/end_line apply to a single path; omit them with paths");
  }
  const seen = new Set<string>();
  for (const entry of input.paths) {
    if (typeof entry !== "string" || entry === "") return fail("error: every paths entry must be a non-empty string");
    if (entry.length > 1024) return fail("error: every paths entry must be under 1024 chars");
    if (seen.has(entry)) return fail(`error: duplicate path in paths: ${entry}`);
    seen.add(entry);
  }
  const paths = input.paths as string[];
  if (paths.length === 1) return readProjectFile(cwd, { path: paths[0] }, allow);
  const sections: string[] = [];
  const failed: boolean[] = [];
  for (const rel of paths) {
    const got = readProjectFile(cwd, { path: rel }, allow);
    sections.push(`<file path="${xmlSafe(rel)}">\n${got.content}\n</file>`);
    failed.push(got.isError);
  }
  const included: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i]!;
    const need = Buffer.byteLength(sec, "utf8") + (included.length > 0 ? 1 : 0);
    if (included.length === 0 || used + need <= READ_CAP_BYTES) {
      included.push(sec);
      used += need;
    } else {
      omitted.push(paths[i]!);
    }
  }
  const body = included.join("\n");
  const repro = `read_file(${paths.length} paths)`;
  const allFailed = failed.slice(0, included.length).every(Boolean) && omitted.length === 0;
  if (omitted.length > 0) {
    const names = omitted.map((p) => JSON.stringify(p)).join(", ");
    const marker = `[batch truncated at ${READ_CAP_BYTES} bytes — ${omitted.length} file(s) omitted: ${names} — read_file each omitted path explicitly]`;
    const continuation = `Read the omitted paths explicitly with read_file: ${names}. Use one path per call or a smaller batch.`;
    return logicalToolText(body, {
      maxBytes: READ_CAP_BYTES,
      state: allFailed ? "failed" : "complete",
      isError: allFailed,
      forceMarker: true,
      marker,
      continuation,
      repro,
    });
  }
  return logicalToolText(body, {
    maxBytes: READ_CAP_BYTES,
    state: allFailed ? "failed" : "complete",
    isError: allFailed,
    repro,
  });
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

type EditResult = {
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
  const opened = openRegularFile(confined.abs);
  if ("error" in opened) {
    return {
      content: opened.error === "error: path is a directory" ? "error: EISDIR" : opened.error,
      isError: true,
    };
  }
  if (opened.size > EDIT_MAX_BYTES) {
    closeSync(opened.fd);
    return { content: `error: file exceeds ${EDIT_MAX_BYTES} bytes`, isError: true };
  }
  const fileMode = opened.mode & 0o777;
  let body: string;
  try {
    const buf = Buffer.alloc(opened.size);
    if (opened.size > 0) readSync(opened.fd, buf, 0, opened.size, 0);
    if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
      return { content: "error: binary file", isError: true };
    }
    body = buf.toString("utf8");
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, isError: true };
  } finally {
    closeSync(opened.fd);
  }
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  const ending = body.includes("\r\n") ? "\r\n" : "\n";
  const old = oldText.replace(/\r\n/g, "\n").replace(/\n/g, ending).replace(/^\uFEFF/, "");
  const replacement = newText.replace(/\r\n/g, "\n").replace(/\n/g, ending);
  // A BOM-only search passes the pre-read empty check, then normalizes to
  // "". indexOf("", from) always matches without advancing, which hangs
  // both search modes. Reject the normalized empty term before matching.
  if (old === "") return { content: "error: old_text must not be empty", isError: true };
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
          atomicWrite(confined.abs, next, fileMode);
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
      atomicWrite(confined.abs, next, fileMode);
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
    atomicWrite(confined.abs, next, fileMode);
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
