/**
 * User-facing content search (find in files) for the active project.
 *
 * Single owner for grepping the project tree from Electron main. Ripgrep
 * (`rg --json`) when present, a bounded JS line scan otherwise; both honor
 * the same visibility rule (IGNORED_SEGMENTS + .gitignore) and the same
 * caps. Callers validate the pattern with the shared grep validator first:
 * an uncompilable pattern here yields no hits, never a throw.
 *
 * Engine notes: ripgrep additionally honors .ignore/.rgignore files, which
 * the scan does not read; both always honor .gitignore. Dotfiles stay
 * excluded on both engines (no --hidden). Ripgrep is started with
 * --no-config so a host config cannot change globs or run a preprocessor,
 * and --crlf so a trailing CR does not hide an end-anchored match. In-project
 * symlinks are searched by the scan (the walk follows ones that stay inside
 * the root) but not by ripgrep: --follow would also leave the project.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { IGNORED_SEGMENTS, matchGitignore, type GitignoreRules } from "../shared/gitignore.ts";
import type { ContentHit } from "../shared/types.ts";
import { isRecord } from "../shared/guards.ts";
import { ensureGitignoreChain, listProjectPaths } from "./quick-open.js";
import { ContentLineMatcher } from "./content-search/line-matcher.js";

interface ContentSearchResult {
  hits: ContentHit[];
  truncated: boolean;
}

interface ContentSearchOptions {
  shouldStop?: () => boolean;
  candidates?: { paths: readonly string[]; truncated: boolean };
  /** Resolved ripgrep path; null forces the JS scan; omitted resolves from PATH. */
  rg?: string | null;
}

/** Total hits across files: enough for a grouped Explorer listing. */
const MAX_CONTENT_HITS = 200;
/** Per-file hit cap, mirroring the agent grep tool. */
const MAX_CONTENT_HITS_PER_FILE = 50;
/** Preview characters kept per matched line. */
const MAX_CONTENT_PREVIEW = 240;
/** Total preview bytes across hits. */
const MAX_CONTENT_BYTES = 256 * 1024;
/** Files the JS scan reads before reporting truncation. */
const MAX_SCAN_FILES = 5000;
/** The JS scan skips larger files (ripgrep mirrors this via --max-filesize). */
const MAX_SCAN_FILE_BYTES = 1024 * 1024;
/** Total bytes the JS scan reads before reporting truncation. */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
/** Ripgrep wall clock before its partial results are returned truncated. */
const CONTENT_SEARCH_BUDGET_MS = 5000;
/** Ripgrep stdout cap: --json is verbose, the hit cap usually fires first. */
const RG_STDOUT_CAP = 1024 * 1024;

const PREVIEW_ELLIPSIS = "…";

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Index of the code point before `index`, or 0. */
function prevBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  return isLowSurrogate(text, index - 1) ? Math.max(0, index - 2) : index - 1;
}

/** Index of the code point after `index`, or the string length. */
function nextBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length;
  return index + 1 < text.length && isLowSurrogate(text, index + 1) ? index + 2 : index + 1;
}

/** Snap an index off a low surrogate so a slice does not split a pair. */
function clampIndex(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  return isLowSurrogate(text, index) ? index - 1 : index;
}

/**
 * Window a line around a match so the preview shows the match, not only the
 * line start. `omittedBefore` / `omittedAfter` count characters the caller
 * already cut off (a worker slice of a huge line). The returned offset and
 * length address `text`, which never splits a surrogate pair.
 */
export function contentPreview(
  raw: string,
  matchIndex: number,
  matchLength: number,
  omittedBefore = 0,
  omittedAfter = 0,
): { text: string; matchOffset: number; matchLength: number } {
  const line = raw.replace(/[\r\n]+$/, "");
  const start = clampIndex(line, Math.max(0, Math.min(matchIndex, line.length)));
  const end = clampIndex(line, Math.max(start, Math.min(start + Math.max(0, matchLength), line.length)));
  const matchedLen = end - start;
  if (omittedBefore === 0 && omittedAfter === 0 && line.length <= MAX_CONTENT_PREVIEW) {
    return { text: line, matchOffset: start, matchLength: matchedLen };
  }
  const needsLead = (from: number): boolean => omittedBefore > 0 || from > 0;
  const needsTrail = (to: number): boolean => omittedAfter > 0 || to < line.length;
  const decoratedLength = (from: number, to: number): number =>
    (needsLead(from) ? PREVIEW_ELLIPSIS.length : 0) + (to - from) + (needsTrail(to) ? PREVIEW_ELLIPSIS.length : 0);

  // The match itself does not fit: show its start, with an ellipsis.
  if (decoratedLength(start, end) > MAX_CONTENT_PREVIEW) {
    const lead = needsLead(start) ? PREVIEW_ELLIPSIS : "";
    let bodyEnd = start;
    let room = MAX_CONTENT_PREVIEW - lead.length - PREVIEW_ELLIPSIS.length;
    while (room > 0 && bodyEnd < end) {
      const next = nextBoundary(line, bodyEnd);
      const size = next - bodyEnd;
      if (next === bodyEnd || size > room || next > end) break;
      bodyEnd = next;
      room -= size;
    }
    const body = line.slice(start, bodyEnd);
    return { text: lead + body + PREVIEW_ELLIPSIS, matchOffset: lead.length, matchLength: body.length };
  }

  let from = start;
  let to = end;
  for (let step = 0; step < MAX_CONTENT_PREVIEW + 4; step++) {
    if (decoratedLength(from, to) >= MAX_CONTENT_PREVIEW) break;
    const leftGap = start - from;
    const rightGap = to - end;
    if (from > 0 && (leftGap <= rightGap || to >= line.length)) {
      const next = prevBoundary(line, from);
      if (next === from) break;
      from = next;
      continue;
    }
    if (to < line.length) {
      const next = nextBoundary(line, to);
      if (next === to) break;
      to = next;
      continue;
    }
    break;
  }
  while (decoratedLength(from, to) > MAX_CONTENT_PREVIEW && (from < start || to > end)) {
    if (from < start && start - from >= to - end) {
      const next = nextBoundary(line, from);
      if (next === from || next > start) break;
      from = next;
    } else if (to > end) {
      const next = prevBoundary(line, to);
      if (next === to || next < end) break;
      to = next;
    } else break;
  }
  const lead = needsLead(from) ? PREVIEW_ELLIPSIS : "";
  const trail = needsTrail(to) ? PREVIEW_ELLIPSIS : "";
  return {
    text: lead + line.slice(from, to) + trail,
    matchOffset: lead.length + (start - from),
    matchLength: matchedLen,
  };
}

/**
 * Decode a UTF-8 chunk, holding back an incomplete trailing sequence so the
 * next chunk can finish it. A split multibyte character must not become
 * U+FFFD in the middle of an `rg --json` line.
 */
export function takeCompleteUtf8(buffer: Buffer): { text: string; rest: Buffer } {
  if (buffer.length === 0) return { text: "", rest: Buffer.alloc(0) };
  let end = buffer.length;
  const maxBack = Math.min(4, buffer.length);
  for (let back = 1; back <= maxBack; back++) {
    const index = buffer.length - back;
    const byte = buffer[index]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : byte < 0xf8 ? 4 : 1;
    if (back < need) end = index;
    break;
  }
  return { text: buffer.subarray(0, end).toString("utf8"), rest: Buffer.from(buffer.subarray(end)) };
}

function presentMatch(relPath: string, line: number, column: number, raw: string, matchIndex: number, matchLength: number, omittedBefore = 0, omittedAfter = 0): ContentHit {
  const preview = contentPreview(raw, matchIndex, matchLength, omittedBefore, omittedAfter);
  return { relPath, line, column, text: preview.text, matchOffset: preview.matchOffset, matchLength: preview.matchLength };
}

/**
 * Convert a ripgrep UTF-8 byte offset into a 1-based UTF-16 editor column
 * using the matched line text. Ripgrep counts bytes; Monaco and the JS
 * fallback count UTF-16 code units, so multibyte text before the match
 * would otherwise navigate to the wrong column. Null when the offset is
 * not an integer, runs past the line, or splits a code point.
 */
function byteOffsetToColumn(lineText: string, byteOffset: number): number | null {
  if (!Number.isInteger(byteOffset) || byteOffset < 0) return null;
  let bytes = 0;
  let i = 0;
  while (i < lineText.length && bytes < byteOffset) {
    const codePoint = lineText.codePointAt(i)!;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    i += codePoint > 0xffff ? 2 : 1;
  }
  if (bytes !== byteOffset) return null;
  return i + 1;
}

/**
 * Parse one `rg --json` output line into a hit. Binary matches (base64 byte
 * payloads) and paths escaping the root yield null.
 */
export function parseRipgrepJsonLine(line: string, root: string): ContentHit | null {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(rec) || rec.type !== "match") return null;
  const data = rec.data;
  if (!isRecord(data)) return null;
  const { path, lines, line_number: lineNumber, submatches } = data;
  if (!isRecord(path) || !isRecord(lines)) return null;
  const pathText = path.text;
  const lineText = lines.text;
  if (typeof pathText !== "string" || !pathText || typeof lineText !== "string"
    || typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || lineNumber < 1) return null;
  const first: unknown = Array.isArray(submatches) ? submatches[0] : undefined;
  const { start, end } = isRecord(first) ? first : {};
  const startByte = typeof start === "number" ? start : 0;
  const column = byteOffsetToColumn(lineText, startByte);
  if (column === null) return null;
  const endColumn = typeof end === "number" ? byteOffsetToColumn(lineText, end) : null;
  const matchLength = endColumn !== null && endColumn >= column ? endColumn - column : 0;
  const abs = isAbsolute(pathText) ? pathText : join(root, pathText);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return presentMatch(rel, lineNumber, column, lineText, column - 1, matchLength);
}

/**
 * Resolve a ripgrep binary from PATH. Absolute entries only, and never from
 * inside the searched root: a project must not be able to plant the binary
 * main executes. Both the PATH directory and the final executable target
 * (after leaf symlinks) are validated against the canonical root.
 */
export function findRipgrep(root: string): string | null {
  const bin = process.platform === "win32" ? "rg.exe" : "rg";
  let canonRoot = root;
  try {
    canonRoot = realpathSync(root);
  } catch {
    /* compare against the root as given */
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      continue;
    }
    const under = relative(canonRoot, realDir);
    if (under === "" || (!under.startsWith("..") && !isAbsolute(under))) continue;
    const candidate = join(realDir, bin);
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    // The directory check above is not enough: the leaf itself may be a
    // symlink into the searched project. Canonicalize the final executable
    // and apply the same never-from-inside policy to its target.
    let realBin: string;
    try {
      realBin = realpathSync(candidate);
    } catch {
      continue;
    }
    const targetUnder = relative(canonRoot, realBin);
    if (targetUnder === "" || (!targetUnder.startsWith("..") && !isAbsolute(targetUnder))) continue;
    return realBin;
  }
  return null;
}

interface RipgrepOutcome {
  /** False on spawn failure or ripgrep errors: the caller falls back to the scan. */
  ok: boolean;
  hits: ContentHit[];
  truncated: boolean;
}

function ripgrepArgs(pattern: string): string[] {
  const args = [
    "--json",
    "--color=never",
    "--no-config",
    "--crlf",
    "--no-require-git",
    // One past the cap so an exact per-file count is not reported as truncated.
    `--max-count=${MAX_CONTENT_HITS_PER_FILE + 1}`,
    "--max-filesize=1M",
  ];
  for (const name of IGNORED_SEGMENTS) args.push("-g", `!**/${name}`, "-g", `!**/${name}/**`);
  args.push("--", pattern, ".");
  return args;
}

function ripgrepContentSearch(
  rg: string,
  root: string,
  pattern: string,
  stop: () => boolean,
): Promise<RipgrepOutcome> {
  return new Promise((resolve) => {
    const hits: ContentHit[] = [];
    let truncated = false;
    let settled = false;
    let stopFired = false;
    let stdoutBytes = 0;
    let hitBytes = 0;
    let tail = "";
    let pendingUtf8: Buffer = Buffer.alloc(0);
    const perFile = new Map<string, number>();
    let child: ChildProcess;
    try {
      child = spawn(rg, ripgrepArgs(pattern), { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, hits: [], truncated: false });
      return;
    }
    const done = (outcome: RipgrepOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(outcome);
    };
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      truncated = true;
      kill();
    }, CONTENT_SEARCH_BUDGET_MS);
    const poll = setInterval(() => {
      if (stop()) {
        stopFired = true;
        kill();
      }
    }, 20);
    const ingest = (lines: string): void => {
      for (const line of lines.split("\n")) {
        if (!line) continue;
        const hit = parseRipgrepJsonLine(line, root);
        if (!hit) continue;
        const seen = perFile.get(hit.relPath) ?? 0;
        if (seen >= MAX_CONTENT_HITS_PER_FILE) {
          truncated = true;
          continue;
        }
        perFile.set(hit.relPath, seen + 1);
        hits.push(hit);
        hitBytes += Buffer.byteLength(hit.text, "utf8");
        if (hitBytes > MAX_CONTENT_BYTES || hits.length > MAX_CONTENT_HITS) {
          if (hits.length > MAX_CONTENT_HITS) hits.pop();
          truncated = true;
          kill();
          return;
        }
      }
    };
    const pushText = (text: string): void => {
      if (!text) return;
      tail += text;
      const cut = tail.lastIndexOf("\n");
      if (cut === -1) return;
      const complete = tail.slice(0, cut);
      tail = tail.slice(cut + 1);
      ingest(complete);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > RG_STDOUT_CAP) {
        truncated = true;
        kill();
        return;
      }
      const merged = pendingUtf8.length > 0 ? Buffer.concat([pendingUtf8, chunk]) : chunk;
      const decoded = takeCompleteUtf8(merged);
      pendingUtf8 = decoded.rest;
      pushText(decoded.text);
    });
    // Drained and discarded: a full stderr pipe would stall the child.
    child.stderr?.on("data", () => {});
    child.on("error", () => done({ ok: false, hits: [], truncated: false }));
    child.on("close", (code) => {
      if (stopFired) {
        // A superseded query returns nothing rather than a partial result.
        done({ ok: true, hits: [], truncated: false });
        return;
      }
      if (pendingUtf8.length > 0) tail += pendingUtf8.toString("utf8");
      pendingUtf8 = Buffer.alloc(0);
      if (tail) ingest(tail);
      if (code === 2) {
        done({ ok: false, hits: [], truncated: false });
        return;
      }
      done({ ok: true, hits, truncated });
    });
  });
}

async function scanContentSearch(
  root: string,
  pattern: string,
  candidates: readonly string[],
  stop: () => boolean,
): Promise<ContentSearchResult> {
  const matcher = new ContentLineMatcher(pattern, stop, CONTENT_SEARCH_BUDGET_MS);
  try {
    await matcher.match("", 1, MAX_CONTENT_PREVIEW);
    if (matcher.invalid) return { hits: [], truncated: false };
    const hits: ContentHit[] = [];
    let truncated = false;
    let filesScanned = 0;
    let bytesScanned = 0;
    const rules: GitignoreRules = new Map();
    const loaded = new Set<string>();
    for (const rel of candidates) {
      if (stop()) return { hits: [], truncated: false };
      if (matcher.stopped) return { hits: matcher.timedOut ? hits : [], truncated: matcher.timedOut };
      if (filesScanned >= MAX_SCAN_FILES) {
        truncated = true;
        break;
      }
      const posixRel = rel.split(sep).join("/");
      const slash = posixRel.lastIndexOf("/");
      await ensureGitignoreChain(rules, loaded, root, slash === -1 ? "" : posixRel.slice(0, slash));
      if (matchGitignore(rules, posixRel)) continue;
      const abs = join(root, rel);
      let size: number;
      let isFile = false;
      try {
        const st = await stat(abs);
        size = st.size;
        isFile = st.isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;
      if (size > MAX_SCAN_FILE_BYTES) {
        truncated = true;
        continue;
      }
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      filesScanned++;
      bytesScanned += content.length;
      if (bytesScanned > MAX_SCAN_BYTES) {
        truncated = true;
        break;
      }
      if (content.includes("\0")) continue;
      const room = MAX_CONTENT_HITS - hits.length;
      // One past the cap distinguishes "exactly 50" from "50 and more".
      const probe = Math.min(MAX_CONTENT_HITS_PER_FILE + 1, room + 1);
      const matches = await matcher.match(content, probe, MAX_CONTENT_PREVIEW);
      if (matcher.stopped) return { hits: matcher.timedOut ? hits : [], truncated: matcher.timedOut };
      const keep = Math.min(matches.length, MAX_CONTENT_HITS_PER_FILE, room);
      if (matches.length > keep) truncated = true;
      for (const match of matches.slice(0, keep)) {
        hits.push(presentMatch(
          rel,
          match.line,
          match.column,
          match.text,
          match.column - 1 - match.sliceStart,
          match.matchLength,
          match.sliceStart,
          Math.max(0, match.lineLength - match.sliceStart - match.text.length),
        ));
      }
      if (hits.length >= MAX_CONTENT_HITS) { truncated = true; break; }
    }
    return { hits, truncated };
  } finally {
    await matcher.dispose();
  }
}

/**
 * Grep the project tree for a caller-supplied pattern. Ripgrep when
 * available (falling back to the scan when it errors), the JS scan
 * otherwise. A superseded search returns nothing; caps report truncation.
 */
export async function searchProjectContent(
  root: string,
  pattern: string,
  opts?: ContentSearchOptions,
): Promise<ContentSearchResult> {
  const stop = opts?.shouldStop ?? (() => false);
  const listed = opts?.candidates ?? await listProjectPaths(root, opts);
  if (stop()) return { hits: [], truncated: false };
  const rg = opts?.rg !== undefined ? opts.rg : findRipgrep(root);
  if (rg) {
    const via = await ripgrepContentSearch(rg, root, pattern, stop);
    if (via.ok) return { hits: via.hits, truncated: via.truncated || listed.truncated };
  }
  const scanned = await scanContentSearch(root, pattern, listed.paths, stop);
  return { hits: scanned.hits, truncated: scanned.truncated || listed.truncated };
}
