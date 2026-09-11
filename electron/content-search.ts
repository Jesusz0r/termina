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
 * excluded on both engines (no --hidden).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { IGNORED_SEGMENTS, matchGitignore, parseGitignore, type GitignoreRules } from "../shared/gitignore.ts";
import type { ContentHit } from "../shared/types.ts";
import { isRecord } from "../shared/guards.ts";
import { listProjectPaths } from "./quick-open.js";

export type { ContentHit };

export interface ContentSearchResult {
  hits: ContentHit[];
  truncated: boolean;
}

export interface ContentSearchOptions {
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

function previewLine(text: string): string {
  const line = text.replace(/[\r\n]+$/, "");
  return line.length > MAX_CONTENT_PREVIEW ? line.slice(0, MAX_CONTENT_PREVIEW) + "…" : line;
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
  const pathText = isRecord(data.path) && typeof data.path.text === "string" ? data.path.text : null;
  const lineText = isRecord(data.lines) && typeof data.lines.text === "string" ? data.lines.text : null;
  const lineNumber = typeof data.line_number === "number" ? data.line_number : 0;
  if (!pathText || lineText === null || !Number.isInteger(lineNumber) || lineNumber < 1) return null;
  const submatches = Array.isArray(data.submatches) ? data.submatches : [];
  const first = submatches.length > 0 && isRecord(submatches[0]) && typeof submatches[0].start === "number"
    ? submatches[0].start
    : 0;
  const abs = isAbsolute(pathText) ? pathText : join(root, pathText);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return { relPath: rel, line: lineNumber, column: first + 1, text: previewLine(lineText) };
}

/**
 * Resolve a ripgrep binary from PATH. Absolute entries only, and never from
 * inside the searched root: a project must not be able to plant the binary
 * main executes.
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
    try {
      if (statSync(join(realDir, bin)).isFile()) return join(realDir, bin);
    } catch {
      continue;
    }
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
    "--no-require-git",
    `--max-count=${MAX_CONTENT_HITS_PER_FILE}`,
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
        hits.push(hit);
        hitBytes += Buffer.byteLength(hit.text, "utf8");
        if (hits.length >= MAX_CONTENT_HITS || hitBytes > MAX_CONTENT_BYTES) {
          truncated = true;
          kill();
          return;
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > RG_STDOUT_CAP) {
        truncated = true;
        kill();
        return;
      }
      tail += chunk.toString("utf8");
      const cut = tail.lastIndexOf("\n");
      if (cut === -1) return;
      const complete = tail.slice(0, cut);
      tail = tail.slice(cut + 1);
      ingest(complete);
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
      if (tail) ingest(tail);
      if (code === 2) {
        done({ ok: false, hits: [], truncated: false });
        return;
      }
      done({ ok: true, hits, truncated });
    });
  });
}

async function ensureGitignoreChain(
  rules: GitignoreRules,
  loaded: Set<string>,
  root: string,
  posixDir: string,
): Promise<void> {
  let dir = posixDir;
  for (;;) {
    if (!loaded.has(dir)) {
      loaded.add(dir);
      const abs = dir === "" ? join(root, ".gitignore") : join(root, ...dir.split("/"), ".gitignore");
      try {
        rules.set(dir, parseGitignore(await readFile(abs, "utf8")));
      } catch {
        /* no gitignore here */
      }
    }
    if (dir === "") return;
    const slash = dir.lastIndexOf("/");
    dir = slash === -1 ? "" : dir.slice(0, slash);
  }
}

async function scanContentSearch(
  root: string,
  pattern: string,
  candidates: readonly string[],
  stop: () => boolean,
): Promise<ContentSearchResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return { hits: [], truncated: false };
  }
  const hits: ContentHit[] = [];
  let truncated = false;
  let filesScanned = 0;
  let bytesScanned = 0;
  const rules: GitignoreRules = new Map();
  const loaded = new Set<string>();
  for (const rel of candidates) {
    if (stop()) return { hits: [], truncated: false };
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
    let perFile = 0;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const found = regex.exec(lines[i] ?? "");
      if (!found) continue;
      hits.push({ relPath: rel, line: i + 1, column: (found.index ?? 0) + 1, text: previewLine(lines[i] ?? "") });
      if (++perFile >= MAX_CONTENT_HITS_PER_FILE) {
        // Other files still have hits worth collecting; only the total cap
        // ends the scan.
        truncated = true;
        break;
      }
      if (hits.length >= MAX_CONTENT_HITS) {
        truncated = true;
        break;
      }
    }
    if (hits.length >= MAX_CONTENT_HITS) break;
  }
  return { hits, truncated };
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
