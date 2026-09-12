/**
 * Session Search parse and walk.
 *
 * Main supplies the jsonl paths for this project (core dir, live and
 * roster files). This module is the only JSONL parser for search hits.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
// .ts extensions so the harness can load this file with strip-types.
import { cleanPlanPathToken, looksLikePath } from "./plan-board.ts";
import { isCoreSessionId, listCurrentSegments, listLogicalSessions } from "../agent-core/session.ts";
import { errorCode, isErrno } from "../shared/guards.ts";
import type { CanonicalizePath, SessionHit } from "../shared/types.ts";

const MAX_SESSION_SEARCH_FILES = 50;
const MAX_SESSION_SEARCH_HITS = 50;
const MAX_SESSION_SEARCH_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SESSION_SEARCH_LINES = 10_000;
const MAX_PROJECT_FILE_MEMO_ENTRIES = 4096;
/** Renderer queries are truncated to this before the walk (main and worker). */
export const MAX_SESSION_SEARCH_QUERY = 256;

export type SessionMessageParse = { role: string; text: string; paths: string[] };

export type SessionFileEntry = { path: string; name: string; mtimeMs: number; segments?: string[] };

function stringArgPaths(value: unknown, paths: string[]): void {
  if (typeof value === "string") {
    if (looksLikePath(value)) paths.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) stringArgPaths(item, paths);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) stringArgPaths(item, paths);
}

function pushToolPaths(block: Record<string, unknown>, paths: string[]): void {
  if (block.arguments && typeof block.arguments === "object") stringArgPaths(block.arguments, paths);
  if (block.input && typeof block.input === "object") stringArgPaths(block.input, paths);
}

/**
 * Parse one agent session JSONL line. Returns null for non-message
 * records (usage, revisions, thinking-only).
 */
export function parseSessionMessageLine(line: string): SessionMessageParse | null {
  if (!line || !line.includes('"message"')) return null;
  try {
    const entry = JSON.parse(line) as {
      type?: string;
      message?: {
        role?: string;
        content?: string | Array<Record<string, unknown>>;
      };
    };
    if (entry.type !== "message" || !entry.message) return null;
    const role = entry.message.role ?? "message";
    if (role !== "user" && role !== "assistant") return null;
    const content = entry.message.content;
    const texts: string[] = [];
    const paths: string[] = [];
    if (typeof content === "string") {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const type = typeof block.type === "string" ? block.type : "";
        if (type === "thinking" || type === "redacted_thinking" || type === "reasoning") continue;
        if (type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (type === "tool_use" && typeof block.name === "string") {
          texts.push(`[${block.name}]`);
          pushToolPaths(block, paths);
        } else if (type === "tool_result") {
          if (typeof block.content === "string") {
            if (block.content) texts.push(block.content.slice(0, 2000));
          } else if (Array.isArray(block.content)) {
            for (const part of block.content) {
              if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
                texts.push(((part as { text: string }).text).slice(0, 2000));
              }
            }
          }
        }
      }
    }
    if (texts.length === 0) return null;
    const text = texts.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return null;
    return { role, text, paths };
  } catch {
    return null;
  }
}

/** Session start time from an ISO prefix or a `/clear` rotate suffix. */
export function sessionTimestampFromName(file: string): number {
  const m = file.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  const ms = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function sessionFileTime(fileName: string, mtimeMs: number): number {
  return sessionTimestampFromName(fileName) || mtimeMs;
}

function formatSessionHitSnippet(role: string, text: string, matchIdx: number, matchLen: number): string {
  const prefix = `[${role}] `;
  if (text.length <= 300) return prefix + text;
  const start = Math.max(0, matchIdx - 60);
  const end = Math.min(text.length, matchIdx + matchLen + 200);
  const snippet = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  return prefix + snippet;
}

/** Bounded concurrency for hit-path existence checks (main or worker). */
const HIT_PATH_CONCURRENCY = 5;

export type CanonicalizeFn = (absPath: string) => string | Promise<string>;
export type ExistsFileFn = (absPath: string) => boolean | Promise<boolean>;

/**
 * Project-file admission: reject escapes, canonicalize the candidate, reject
 * symlink escapes, require a file. Single owner for the main-process and the
 * session-worker checks.
 */
export async function isProjectFileInRoot(
  relPath: string,
  projectCwd: string,
  canonicalize: CanonicalizeFn,
  isFile: ExistsFileFn,
): Promise<boolean> {
  if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return false;
  const abs = join(projectCwd, relPath);
  // Callers canonicalize projectCwd once. Canonicalize only the candidate so
  // symlink escapes are rejected without a second realpath of the trusted root.
  const canonicalAbs = await canonicalize(abs);
  const checkedRel = relative(projectCwd, canonicalAbs);
  if (!checkedRel || checkedRel.startsWith("..") || isAbsolute(checkedRel)) return false;
  try {
    return await isFile(canonicalAbs);
  } catch {
    return false;
  }
}

/** Bounded parallel map preserving input order in the output. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!, index);
    }
  }));
  return out;
}

async function resolveSessionHitPath(
  parsed: SessionMessageParse,
  projectCwd: string,
  canonicalize: CanonicalizePath,
  isProjectFile: (relPath: string, projectCwd: string) => boolean | Promise<boolean>,
): Promise<string | null> {
  // Candidates in priority order: tool arguments, backticks, ordinary tokens.
  const candidates: string[] = [];
  for (const p of parsed.paths.slice(0, 5)) candidates.push(p);
  const backticks = parsed.text.match(/`([^`]+)`/g);
  if (backticks) {
    for (const raw of backticks.slice(0, 5)) candidates.push(raw.slice(1, -1).trim());
  }
  // Resolve the first ordinary path-like token too. Bound the scan because a
  // session message can contain a large pasted document.
  let scanned = 0;
  for (const raw of parsed.text.split(/\s+/)) {
    if (scanned++ >= 64) break;
    const token = raw.replace(/^[\s'"([{<]+/, "").replace(/[\s'"\])}>.,;:!?]+$/, "");
    if (!token || (!token.includes("/") && !/\.[A-Za-z0-9_-]{1,12}$/.test(token))) continue;
    candidates.push(token);
  }
  const seen = new Set<string>();
  const unique = candidates.filter((token) => {
    if (!token || seen.has(token)) return false;
    seen.add(token);
    return true;
  });
  const resolved = await mapBounded(unique, HIT_PATH_CONCURRENCY, async (token) => {
    const clean = await cleanPlanPathToken(token, projectCwd, canonicalize);
    if (await isProjectFile(clean, projectCwd)) return clean;
    return null;
  });
  for (const hit of resolved) {
    if (hit) return hit;
  }
  return null;
}

export async function sessionFileEntry(path: string): Promise<SessionFileEntry | null> {
  if (!path.endsWith(".jsonl")) return null;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { path, name: basename(path), mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/** Newest first. Unique by path string. Caps at MAX_SESSION_SEARCH_FILES. */
export function mergeSessionFiles(groups: SessionFileEntry[][]): SessionFileEntry[] {
  const seen = new Set<string>();
  const all: Array<{ entry: SessionFileEntry; time: number }> = [];
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      // Parse each timestamp once: the comparator below runs O(n log n) times.
      all.push({ entry, time: sessionFileTime(entry.name, entry.mtimeMs) });
    }
  }
  all.sort((a, b) => {
    if (b.time !== a.time) return b.time - a.time;
    return b.entry.name < a.entry.name ? -1 : b.entry.name > a.entry.name ? 1 : 0;
  });
  return all.slice(0, MAX_SESSION_SEARCH_FILES).map(({ entry }) => entry);
}

/**
 * Gather the session files participating in Session Search: core bundles,
 * newest first, capped. Single owner for which files a search covers; the
 * session worker calls this off the main thread, and main keeps query
 * cancellation. A missing directory is empty history; anything else that
 * prevents a complete listing (permission errors, unreadable or malformed
 * bundles) returns `error` so the modal can say the listing is uncertain
 * instead of showing a silent empty.
 */
export type SessionSearchListing = { files: SessionFileEntry[]; error?: string };

export async function collectSessionSearchFiles(coreDir: string): Promise<SessionSearchListing> {
  let topNames: string[];
  try {
    topNames = await readdir(coreDir);
  } catch (err) {
    if (isErrno(err, "ENOENT")) return { files: [] };
    const detail = errorCode(err) ?? (err instanceof Error ? err.message : String(err));
    return { files: [], error: `session listing uncertain: ${detail}` };
  }
  const coreSessions = await listLogicalSessions(coreDir);
  const files = mergeSessionFiles([
    coreSessions.map((entry) => ({
      path: entry.path,
      name: entry.name,
      mtimeMs: entry.mtimeMs,
      segments: entry.segments,
    })),
  ]);
  const seen = new Set(coreSessions.map((entry) => entry.sessionId));
  let skipped = 0;
  for (const name of topNames) {
    if (!isCoreSessionId(name) || seen.has(name)) continue;
    try {
      if (!(await stat(join(coreDir, name))).isDirectory()) continue;
    } catch (err) {
      // A concurrent delete is a race, not uncertainty; anything else (EACCES,
      // ENOTDIR on a swapped path) means a bundle could not be proven absent.
      if (isErrno(err, "ENOENT")) continue;
    }
    skipped++;
  }
  if (skipped > 0) {
    const detail = skipped === 1 ? "1 session could not be listed" : `${skipped} sessions could not be listed`;
    return { files, error: `session listing uncertain: ${detail}` };
  }
  return { files };
}

export async function searchSessionFiles(opts: {
  query: string;
  files: SessionFileEntry[];
  projectCwd: string;
  canonicalize: CanonicalizePath;
  isProjectFile: (relPath: string, projectCwd: string) => boolean | Promise<boolean>;
  shouldStop?: () => boolean;
}): Promise<SessionHit[]> {
  // The worker is its own trust boundary: never trust caller-supplied sizes.
  const needle = opts.query.trim().toLowerCase().slice(0, MAX_SESSION_SEARCH_QUERY);
  if (needle.length < 2) return [];
  const files = opts.files.slice(0, MAX_SESSION_SEARCH_FILES);
  const hits: SessionHit[] = [];
  // A single message can expose the same candidate through tool arguments,
  // backticks, and ordinary tokens.  Keep the bounded search from repeating
  // the main-process existence/stat check for those candidates.
  const projectFileMemo = new Map<string, Promise<boolean>>();
  const isProjectFile = (relPath: string, projectCwd: string): Promise<boolean> => {
    const key = `${projectCwd}\0${relPath}`;
    const cached = projectFileMemo.get(key);
    if (cached) return cached;
    const result = Promise.resolve().then(() => opts.isProjectFile(relPath, projectCwd));
    if (projectFileMemo.size < MAX_PROJECT_FILE_MEMO_ENTRIES) projectFileMemo.set(key, result);
    return result;
  };

  for (const file of files) {
    if (opts.shouldStop?.()) return [];
    let snapshot = sessionSegmentSnapshot(file);
    if (!snapshot) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      const hitStart = hits.length;
      let lineNum = 0;
      let prevText = "";
      let hitCap = false;
      for (const segment of snapshot.paths) {
        if (opts.shouldStop?.()) return [];
        try {
          const info = await stat(segment);
          if (!info.isFile() || info.size > MAX_SESSION_SEARCH_FILE_BYTES) continue;
        } catch {
          continue;
        }
        const stream = createReadStream(segment, { encoding: "utf8" });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            if (opts.shouldStop?.()) {
              rl.close();
              stream.destroy();
              return [];
            }
            lineNum++;
            if (lineNum > MAX_SESSION_SEARCH_LINES) break;
            const parsed = parseSessionMessageLine(line);
            if (parsed) {
              const matchIdx = parsed.text.toLowerCase().indexOf(needle);
              if (matchIdx !== -1) {
                const hitPath = await resolveSessionHitPath(parsed, opts.projectCwd, opts.canonicalize, isProjectFile);
                hits.push({
                  sessionFile: file.name,
                  line: lineNum,
                  text: formatSessionHitSnippet(parsed.role, parsed.text, matchIdx, needle.length),
                  before: prevText,
                  after: "",
                  ts: sessionFileTime(file.name, file.mtimeMs),
                  filePath: hitPath ?? undefined,
                });
                if (hits.length >= MAX_SESSION_SEARCH_HITS) {
                  hitCap = true;
                  break;
                }
              }
              prevText = `[${parsed.role}] ${parsed.text.slice(0, 120)}`;
            }
            if (lineNum % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } catch {
          /* skip read errors */
        } finally {
          rl.close();
          stream.destroy();
        }
        if (hitCap || lineNum > MAX_SESSION_SEARCH_LINES) break;
      }
      const next = sessionSegmentSnapshot(file);
      if (!file.segments || !next || next.key === snapshot.key) {
        if (hitCap) return hits;
        break;
      }
      hits.splice(hitStart);
      if (attempt === 1) break;
      snapshot = next;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return opts.shouldStop?.() ? [] : hits;
}

function sessionSegmentSnapshot(file: SessionFileEntry): { paths: string[]; key: string } | null {
  if (!file.segments) return { paths: [file.path], key: file.path };
  const listing = listCurrentSegments(dirname(file.path));
  if (!listing.ok) return null;
  const paths = listing.parts.map((part) => part.path);
  if (listing.active) paths.push(listing.active.path);
  const key = paths.join("\n");
  return { paths, key };
}
