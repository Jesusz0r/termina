/**
 * Session Search parse and walk.
 *
 * Main supplies the jsonl paths for this project (Pi dir, core dir,
 * live and roster files). This module is the only JSONL parser for
 * search hits.
 */
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
// .ts extensions so the harness can load this file with strip-types.
import { cleanPlanPathToken, looksLikePath } from "./plan-board.ts";
import type { SessionHit } from "../shared/types.ts";

export const MAX_SESSION_SEARCH_FILES = 50;
export const MAX_SESSION_SEARCH_HITS = 50;
export const MAX_SESSION_SEARCH_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SESSION_SEARCH_LINES = 10_000;

export type SessionMessageParse = { role: string; text: string; paths: string[] };

export type SessionFileEntry = { path: string; name: string; mtimeMs: number };

type CanonicalizePath = (absPath: string) => string | Promise<string>;

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
 * Parse one Pi or core session JSONL line. Returns null for non-message
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
        } else if (type === "toolCall" && typeof block.name === "string") {
          texts.push(`[${block.name}]`);
          pushToolPaths(block, paths);
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

export function sessionFileTime(fileName: string, mtimeMs: number): number {
  return sessionTimestampFromName(fileName) || mtimeMs;
}

export function formatSessionHitSnippet(role: string, text: string, matchIdx: number, matchLen: number): string {
  const prefix = `[${role}] `;
  if (text.length <= 300) return prefix + text;
  const start = Math.max(0, matchIdx - 60);
  const end = Math.min(text.length, matchIdx + matchLen + 200);
  const snippet = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  return prefix + snippet;
}

export async function resolveSessionHitPath(
  parsed: SessionMessageParse,
  projectCwd: string,
  canonicalize: CanonicalizePath,
  isProjectFile: (relPath: string, projectCwd: string) => boolean | Promise<boolean>,
): Promise<string | null> {
  for (const p of parsed.paths.slice(0, 5)) {
    const clean = await cleanPlanPathToken(p, projectCwd, canonicalize);
    if (await isProjectFile(clean, projectCwd)) return clean;
  }
  const backticks = parsed.text.match(/`([^`]+)`/g);
  if (backticks) {
    for (const raw of backticks.slice(0, 5)) {
      const token = raw.slice(1, -1).trim();
      const clean = await cleanPlanPathToken(token, projectCwd, canonicalize);
      if (await isProjectFile(clean, projectCwd)) return clean;
    }
  }
  return null;
}

/** List jsonl files in one directory. Missing directories yield []. */
export async function listSessionJsonl(dir: string): Promise<SessionFileEntry[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: SessionFileEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      let real = path;
      try {
        real = await realpath(path);
      } catch {
        /* keep the unresolved path */
      }
      out.push({ path: real, name, mtimeMs: info.mtimeMs });
    } catch {
      /* skip unreadable entries */
    }
  }
  return out;
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
  const all: SessionFileEntry[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      all.push(entry);
    }
  }
  all.sort((a, b) => {
    const tb = sessionFileTime(b.name, b.mtimeMs);
    const ta = sessionFileTime(a.name, a.mtimeMs);
    if (tb !== ta) return tb - ta;
    return b.name < a.name ? -1 : b.name > a.name ? 1 : 0;
  });
  return all.slice(0, MAX_SESSION_SEARCH_FILES);
}

export async function searchSessionFiles(opts: {
  query: string;
  files: SessionFileEntry[];
  projectCwd: string;
  canonicalize: CanonicalizePath;
  isProjectFile: (relPath: string, projectCwd: string) => boolean | Promise<boolean>;
  shouldStop?: () => boolean;
}): Promise<SessionHit[]> {
  const needle = opts.query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits: SessionHit[] = [];

  for (const file of opts.files) {
    if (opts.shouldStop?.()) return [];
    try {
      const info = await stat(file.path);
      if (info.size > MAX_SESSION_SEARCH_FILE_BYTES) continue;
    } catch {
      continue;
    }

    const stream = createReadStream(file.path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNum = 0;
    let prevText = "";

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
        if (!parsed) continue;

        const matchIdx = parsed.text.toLowerCase().indexOf(needle);
        if (matchIdx !== -1) {
          const hitPath = await resolveSessionHitPath(parsed, opts.projectCwd, opts.canonicalize, opts.isProjectFile);
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
            rl.close();
            stream.destroy();
            return hits;
          }
        }
        prevText = `[${parsed.role}] ${parsed.text.slice(0, 120)}`;
      }
    } catch {
      /* skip read errors */
    } finally {
      rl.close();
      stream.destroy();
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return opts.shouldStop?.() ? [] : hits;
}
