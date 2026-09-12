/**
 * Project file discovery: cwd freezing, jail confinement, directory walks,
 * glob matching, `@` tag scanning/expansion support, and the glob tool page.
 * Pure over the filesystem; the only retained state is the tag-scan cache.
 */
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { IGNORED_SEGMENTS, matchGitignore, parseGitignore, type GitignoreRules } from "../../shared/gitignore.ts";
import { GREP_NO_MATCHES_PREFIX } from "../stall.ts";
import { rankFileTags } from "../tui-text.ts";
import {
  GREP_BYTE_CAP,
  boundedToolResult,
  logicalToolText,
  type CompletionState,
  type ToolTextResult,
} from "../tool-output.ts";

export const GREP_VISIT_CAP = 2_000;
export const GREP_BUDGET_MS = 2_000;
const GLOB_HIT_CAP = 200;

const FILE_TAG_VISIT_CAP = GREP_VISIT_CAP;
const FILE_TAG_PICK_CAP = 50;
export const FILE_TAG_ATTACH_CAP = 8;
const FILE_TAG_SCAN_MS = GREP_BUDGET_MS;

const FILE_TAG_TTL_MS = 2_000;

export function freezeCwd(cwd: string): string {
  try {
    if (existsSync(cwd)) return realpathSync(cwd);
  } catch {
    /* fall through to resolve */
  }
  return resolve(cwd);
}

export function underRoot(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

export function sortUtf8(names: string[]): string[] {
  return names.slice().sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
}

export function posixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

export function gitignoreSkips(rules: GitignoreRules, rel: string, isDir: boolean): boolean {
  if (!rel || rel === ".") return false;
  if (matchGitignore(rules, rel)) return true;
  return isDir && matchGitignore(rules, `${rel}/x`);
}

export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export type ConfineResult = { ok: true; abs: string } | { ok: false; error: string };

export function confinePath(
  cwd: string,
  input: string | undefined,
  opts?: { mustExist?: boolean; allow?: ReadonlySet<string> },
): ConfineResult {
  const root = freezeCwd(cwd);
  const candidate = resolve(root, input ?? ".");
  const label = input ?? ".";
  let existed = false;
  try {
    lstatSync(candidate);
    existed = true;
  } catch {
    existed = false;
  }
  if (existed) {
    try {
      const abs = realpathSync(candidate);
      if (underRoot(abs, root) || (opts?.allow !== undefined && opts.allow.has(abs))) return { ok: true, abs };
      return { ok: false, error: `error: path outside project: ${label}` };
    } catch {
      return { ok: false, error: `error: cannot resolve ${label}` };
    }
  }
  if (opts?.mustExist) return { ok: false, error: `error: not found: ${label}` };
  let cur = dirname(candidate);
  for (;;) {
    try {
      lstatSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return { ok: false, error: `error: path outside project: ${label}` };
      cur = parent;
      continue;
    }
    let ancestorReal: string;
    try {
      ancestorReal = realpathSync(cur);
    } catch {
      return { ok: false, error: `error: cannot resolve ${label}` };
    }
    if (!underRoot(ancestorReal, root)) return { ok: false, error: `error: path outside project: ${label}` };
    const suffix = relative(cur, candidate);
    const abs = suffix ? join(ancestorReal, suffix) : ancestorReal;
    if (underRoot(abs, root)) return { ok: true, abs };
    return { ok: false, error: `error: path outside project: ${label}` };
  }
}

function matchStar(pat: string, seg: string): boolean {
  const n = pat.length;
  const m = seg.length;
  const dp: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  dp[0]![0] = 1;
  for (let i = 1; i <= n; i++) {
    if (pat[i - 1] === "*") dp[i]![0] = dp[i - 1]![0]!;
  }
  for (let i = 1; i <= n; i++) {
    const pc = pat[i - 1]!;
    for (let j = 1; j <= m; j++) {
      if (pc === "*") dp[i]![j] = dp[i]![j - 1]! | dp[i - 1]![j]!;
      else if (pc === "?" || pc === seg[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]!;
    }
  }
  return dp[n]![m] === 1;
}

export function matchGlob(pattern: string, relPath: string): boolean {
  if (pattern.length < 1 || pattern.length > 256) return false;
  if (/[\[\]{}]/.test(pattern)) return false;
  const pSegs = pattern.split("/");
  const tSegs = relPath.split(sep).join("/").split("/");
  const n = pSegs.length;
  const m = tSegs.length;
  const dp: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  dp[0]![0] = 1;
  for (let i = 1; i <= n; i++) {
    if (pSegs[i - 1] === "**") dp[i]![0] = dp[i - 1]![0]!;
  }
  for (let i = 1; i <= n; i++) {
    const ps = pSegs[i - 1]!;
    for (let j = 1; j <= m; j++) {
      if (ps === "**") dp[i]![j] = dp[i - 1]![j]! | dp[i]![j - 1]!;
      else if (matchStar(ps, tSegs[j - 1]!)) dp[i]![j] = dp[i - 1]![j - 1]!;
    }
  }
  return dp[n]![m] === 1;
}

export function fileHasNul(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, 4096, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isReadableFile(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---- walk helpers (shared between collectFiles + collectRelativeFiles) ----
function readDirState(dirReal: string, root: string, gitignore: GitignoreRules): { names: string[]; byName: Map<string, import("node:fs").Dirent> } | null {
  let ents;
  try {
    ents = readdirSync(dirReal, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = sortUtf8(ents.map((e) => e.name));
  const byName = new Map(ents.map((e) => [e.name, e] as const));
  if (byName.has(".gitignore")) {
    try {
      gitignore.set(posixRel(root, dirReal), parseGitignore(readFileSync(join(dirReal, ".gitignore"), "utf8")));
    } catch {
      /* unreadable gitignore */
    }
  }
  return { names, byName };
}

export function classifyWalkPath(abs: string, root: string): { kind: "dir" | "file"; real: string } | null {
  let lst;
  try {
    lst = lstatSync(abs);
  } catch {
    return null;
  }
  if (lst.isSymbolicLink()) {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return null;
    }
    if (!underRoot(real, root)) return null;
    let st;
    try {
      st = statSync(real);
    } catch {
      return null;
    }
    if (st.isDirectory()) return { kind: "dir", real };
    if (st.isFile()) return { kind: "file", real };
    return null;
  }
  if (lst.isDirectory()) {
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      return { kind: "dir", real: abs };
    }
    return { kind: "dir", real };
  }
  if (lst.isFile()) {
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      return null;
    }
    if (!underRoot(real, root)) return null;
    return { kind: "file", real };
  }
  return null;
}

export async function collectFiles(
  start: string,
  root: string,
  visitCap: number,
  opts?: { skipNul?: boolean; shouldStop?: () => boolean; budgetMs?: number },
): Promise<{
  files: string[];
  state: CompletionState;
  hitCap: boolean;
  timedOut: boolean;
}> {
  const skipNul = opts?.skipNul !== false;
  const rawBudgetMs = opts?.budgetMs ?? GREP_BUDGET_MS;
  const budgetMs = Number.isFinite(rawBudgetMs) && rawBudgetMs >= 0 ? rawBudgetMs : 0;
  const normalizedVisitCap = Number.isSafeInteger(visitCap) && visitCap >= 0 ? visitCap : 0;
  const files: string[] = [];
  const visited = new Set<string>();
  const seenFiles = new Set<string>();
  const gitignore: GitignoreRules = new Map();
  let stopCallbackFailed = false;
  const shouldStop = (): boolean => {
    try {
      return opts?.shouldStop?.() === true;
    } catch {
      stopCallbackFailed = true;
      return true;
    }
  };
  if (shouldStop()) return { files, state: stopCallbackFailed ? "failed" : "interrupted", hitCap: false, timedOut: false };
  if (budgetMs <= 0) return { files, state: "timeout", hitCap: false, timedOut: true };
  const classified = classifyWalkPath(start, root);
  if (!classified) return { files, state: "unreadable", hitCap: false, timedOut: false };
  if (classified.kind === "file") {
    const rel = posixRel(root, classified.real);
    if (rel && gitignoreSkips(gitignore, rel, false)) return { files, state: "complete", hitCap: false, timedOut: false };
    if (!isReadableFile(classified.real)) return { files, state: "unreadable", hitCap: false, timedOut: false };
    if (skipNul && fileHasNul(classified.real)) return { files, state: "complete", hitCap: false, timedOut: false };
    return { files: [classified.real], state: "complete", hitCap: false, timedOut: false };
  }
  const stack = [classified.real];
  let visits = 0;
  const started = Date.now();
  let unreadable = false;
  while (stack.length > 0) {
    if (shouldStop()) {
      files.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
      return { files, state: stopCallbackFailed ? "failed" : "interrupted", hitCap: false, timedOut: false };
    }
    if (budgetMs <= 0 || Date.now() - started >= budgetMs) {
      files.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
      return { files, state: "timeout", hitCap: false, timedOut: true };
    }
    const dir = stack.pop()!;
    let dirReal = dir;
    try {
      dirReal = realpathSync(dir);
    } catch {
      unreadable = true;
      continue;
    }
    if (visited.has(dirReal)) continue;
    visited.add(dirReal);
    const state = readDirState(dirReal, root, gitignore);
    if (!state) {
      unreadable = true;
      continue;
    }
    const { names, byName } = state;
    for (const name of names) {
      if (shouldStop()) {
        files.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
        return { files, state: stopCallbackFailed ? "failed" : "interrupted", hitCap: false, timedOut: false };
      }
      if (name === "." || name === "..") continue;
      if (IGNORED_SEGMENTS.has(name)) continue;
      if (!byName.has(name)) continue;
      const abs = join(dirReal, name);
      visits++;
      if (visits > normalizedVisitCap) {
        files.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
        return { files, state: "visit-cap", hitCap: true, timedOut: false };
      }
      if (visits % 25 === 0) {
        await yieldEventLoop();
        if (shouldStop()) {
          files.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
          return { files, state: stopCallbackFailed ? "failed" : "interrupted", hitCap: false, timedOut: false };
        }
      }
      const candidate = classifyWalkPath(abs, root);
      if (!candidate) {
        unreadable = true;
        continue;
      }
      const rel = posixRel(root, candidate.real);
      if (gitignoreSkips(gitignore, rel, candidate.kind === "dir")) continue;
      const next = { kind: candidate.kind, real: candidate.real, rel };
      if (next.kind === "dir") stack.push(next.real);
      else {
        if (seenFiles.has(next.real)) continue;
        seenFiles.add(next.real);
        if (!isReadableFile(next.real)) {
          unreadable = true;
          continue;
        }
        if (skipNul && fileHasNul(next.real)) continue;
        files.push(next.real);
      }
    }
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  return { files, state: unreadable ? "unreadable" : "complete", hitCap: false, timedOut: false };
}

export type RelativeFilesScanOptions = {
  shouldStop?: () => boolean;
  budgetMs?: number;
};

/**
 * Array-shaped result so existing ranking/selection code remains a normal
 * string-array consumer while every scan carries its completion state. The
 * `files` copy is the explicit canonical payload for metadata-aware callers.
 */
export type RelativeFilesResult = string[] & {
  readonly files: string[];
  readonly state: CompletionState;
  readonly hitCap: boolean;
  readonly timedOut: boolean;
  readonly visits: number;
  readonly visitedDirectories: number;
};

function relativeFilesResult(
  files: string[],
  metadata: Omit<RelativeFilesResult, "files" | keyof string[]>,
): RelativeFilesResult {
  const result = files.slice() as RelativeFilesResult;
  Object.defineProperties(result, {
    files: { value: result.slice(), enumerable: true },
    state: { value: metadata.state, enumerable: true },
    hitCap: { value: metadata.hitCap, enumerable: true },
    timedOut: { value: metadata.timedOut, enumerable: true },
    visits: { value: metadata.visits, enumerable: true },
    visitedDirectories: { value: metadata.visitedDirectories, enumerable: true },
  });
  return result;
}

let fileTagIndex: { root: string; scan: RelativeFilesResult; at: number } | null = null;

/** Relative project files and folders for `@` tagging. Sync, ignored walks, no NUL scan. */
export function collectRelativeFiles(
  cwd: string,
  visitCap = FILE_TAG_VISIT_CAP,
  opts?: RelativeFilesScanOptions,
): RelativeFilesResult {
  const root = freezeCwd(cwd);
  const files: string[] = [];
  const visited = new Set<string>();
  const seenFiles = new Set<string>();
  const gitignore: GitignoreRules = new Map();
  const normalizedVisitCap = Number.isSafeInteger(visitCap) && visitCap >= 0 ? visitCap : 0;
  const rawBudgetMs = opts?.budgetMs ?? FILE_TAG_SCAN_MS;
  const budgetMs = Number.isFinite(rawBudgetMs) && rawBudgetMs >= 0 ? rawBudgetMs : 0;
  let stopCallbackFailed = false;
  const shouldStop = (): boolean => {
    try {
      return opts?.shouldStop?.() === true;
    } catch {
      stopCallbackFailed = true;
      return true;
    }
  };
  const started = Date.now();
  let visits = 0;
  let unreadable = false;
  const finish = (
    state: CompletionState,
    hitCap = false,
    timedOut = false,
  ): RelativeFilesResult => {
    files.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    return relativeFilesResult(files, {
      state,
      hitCap,
      timedOut,
      visits,
      visitedDirectories: visited.size,
    } as Omit<RelativeFilesResult, "files" | keyof string[]>);
  };
  if (shouldStop()) return finish(stopCallbackFailed ? "failed" : "interrupted");
  if (budgetMs <= 0) return finish("timeout", false, true);
  const classified = classifyWalkPath(root, root);
  if (!classified || classified.kind !== "dir") return finish("unreadable");
  const stack = [classified.real];
  while (stack.length > 0) {
    if (shouldStop()) return finish(stopCallbackFailed ? "failed" : "interrupted");
    if (Date.now() - started >= budgetMs) return finish("timeout", false, true);
    const dir = stack.pop()!;
    let dirReal = dir;
    try {
      dirReal = realpathSync(dir);
    } catch {
      unreadable = true;
      continue;
    }
    if (visited.has(dirReal)) continue;
    visited.add(dirReal);
    const state = readDirState(dirReal, root, gitignore);
    if (!state) {
      unreadable = true;
      continue;
    }
    const { names } = state;
    for (const name of names) {
      if (shouldStop()) return finish(stopCallbackFailed ? "failed" : "interrupted");
      if (Date.now() - started >= budgetMs) return finish("timeout", false, true);
      if (name === "." || name === "..") continue;
      if (IGNORED_SEGMENTS.has(name)) continue;
      visits++;
      if (visits > normalizedVisitCap) {
        return finish("visit-cap", true);
      }
      const candidate = classifyWalkPath(join(dirReal, name), root);
      if (!candidate) {
        unreadable = true;
        continue;
      }
      const rel = posixRel(root, candidate.real);
      if (gitignoreSkips(gitignore, rel, candidate.kind === "dir")) continue;
      if (candidate.kind === "dir") {
        stack.push(candidate.real);
        if (!seenFiles.has(candidate.real)) {
          seenFiles.add(candidate.real);
          if (rel) files.push(rel.endsWith("/") ? rel : `${rel}/`);
        }
      } else if (!seenFiles.has(candidate.real)) {
        seenFiles.add(candidate.real);
        if (rel) files.push(rel);
      }
    }
  }
  return finish(unreadable ? "unreadable" : "complete");
}

export function listTaggedFiles(
  cwd: string,
  query: string,
  cap = FILE_TAG_PICK_CAP,
  opts?: RelativeFilesScanOptions & { visitCap?: number },
): RelativeFilesResult {
  const root = freezeCwd(cwd);
  const now = Date.now();
  const requestedScan = opts !== undefined;
  const stale = requestedScan || !fileTagIndex || fileTagIndex.root !== root ||
    (query === "" && now - fileTagIndex.at >= FILE_TAG_TTL_MS);
  let scan: RelativeFilesResult;
  if (stale) {
    scan = collectRelativeFiles(root, opts?.visitCap ?? FILE_TAG_VISIT_CAP, opts);
    // Never retain an incomplete scan as if it were a complete autocomplete
    // index. A subsequent query will rescan and report its own state.
    if (scan.state === "complete") fileTagIndex = { root, scan, at: now };
    else fileTagIndex = null;
  } else {
    scan = fileTagIndex!.scan;
  }
  const matches = rankFileTags(scan.files, query, cap);
  return relativeFilesResult(matches, {
    state: scan.state,
    hitCap: scan.hitCap,
    timedOut: scan.timedOut,
    visits: scan.visits,
    visitedDirectories: scan.visitedDirectories,
  } as Omit<RelativeFilesResult, "files" | keyof string[]>);
}

export function parseFileTags(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /(^|\s)@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const path = m[2]!;
    if (path === "." || path === ".." || path.includes("://")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    found.push(path);
  }
  return found;
}

export function shellQuote(raw: string): string {
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80);
  return `'${cleaned.replace(/'/g, `'\\''`)}'`;
}

export async function globFiles(
  cwd: string,
  pattern: string,
  opts?: { shouldStop?: () => boolean; budgetMs?: number },
): Promise<ToolTextResult> {
  const repro = `glob ${shellQuote(pattern)}`;
  const continuation = `Glob again with a narrower pattern than ${JSON.stringify(pattern)} or a narrower path.`;
  const fail = (content: string): ToolTextResult => Object.freeze({
    ...boundedToolResult(content, { maxBytes: GREP_BYTE_CAP, marker: "", state: "failed", isError: true }),
    continuation: null,
    repro,
  });
  if (pattern.length < 1 || pattern.length > 256) return fail("error: pattern length must be 1–256");
  if (/[\[\]{}]/.test(pattern)) return fail("error: glob only supports * ** ?");
  const root = freezeCwd(cwd);
  const collected = await collectFiles(root, root, GREP_VISIT_CAP, {
    shouldStop: opts?.shouldStop,
    budgetMs: opts?.budgetMs,
  });
  const out: string[] = [];
  for (const abs of collected.files) {
    const rel = relative(root, abs).split(sep).join("/");
    if (!matchGlob(pattern, rel)) continue;
    out.push(rel);
    // One lookahead distinguishes an exact page from an omitted continuation.
    if (out.length > GLOB_HIT_CAP) break;
  }
  const hasMore = out.length > GLOB_HIT_CAP;
  const visible = out.slice(0, GLOB_HIT_CAP);
  const incomplete = collected.state !== "complete";
  const body = visible.length > 0
    ? visible.join("\n")
    : incomplete
      ? `(glob ${collected.state} after ${collected.files.length} files)`
      : GREP_NO_MATCHES_PREFIX;
  const needsContinuation = hasMore || incomplete;
  const result = logicalToolText(body, {
    maxBytes: GREP_BYTE_CAP,
    state: collected.state,
    isError: incomplete,
    forceMarker: needsContinuation,
    marker: needsContinuation ? `${hasMore ? "(more matching files not listed)\n" : ""}${continuation}` : "",
    continuation: needsContinuation ? continuation : null,
    repro,
  });
  return Object.freeze({ ...result, truncated: result.truncated || needsContinuation });
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function xmlSafe(s: string): string {
  return escapeXml(s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""));
}
