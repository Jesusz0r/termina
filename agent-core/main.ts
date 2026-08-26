/**
 * Termina agent-core v1 — in-house coding-agent engine.
 *
 * One of Termina's terminal engines (alongside Pi and the shell). Same pty
 * surface and sidecar contract (TERMINA_TERMINAL_ID + TERMINA_EVENTS_DIR,
 * agent_start/tool/tool_end/agent_settled) so the host timeline and modified
 * list work. Full-screen TUI in a tty; streamed tokens land in the
 * transcript. Piped runs print a banner and exit.
 *
 * - Frozen deterministic front matter; append-only session storage;
 *       revisions change the view, never the stored bytes; /resume replay
 * - Reclamation with high-water/low-water hysteresis; chained
 *       summarization on the cheap lane; emergency overflow revision
 *       mid-turn; last-resort truncate at prompt boundaries
 * - Stubs carry the reproducing command; structured file inventories
 *       survive summarization as data
 * - Per-turn usage records with waste attribution and models.dev pricing
 * - Two-role routing map (main + summary), env-overridable
 * - Streaming always; tool calls run concurrently behind a small bound
 * - cwd jail; grep/glob; web_search; skill index; prefix cache_control; traces
 * - provider auth (Anthropic, OpenAI, ChatGPT Codex, xAI, Google, OpenRouter)
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
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
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authBanner,
  DEFAULT_MODELS,
  firstAuthenticatedProvider,
  isSupportedProvider,
  loginPickerItems,
  parseAuthCommand,
  parseModelRef,
  providerProtocol,
  refreshOauth,
  resolveAuth,
  runLogin,
  runLogout,
  type ProviderId,
} from "./auth.ts";
import {
  completionsBody,
  completionResultFromEvents,
  readSseJson,
  responsesBody,
  responsesResultFromEvents,
  textFromCompletionPayload,
  textFromResponsesPayload,
  type ToolDef,
} from "./openai-compat.ts";
import {
  catalogFetchAllowed,
  formatModelBanner,
  formatModelLines,
  loadProviderModels,
  parseModelSwitch,
  pickDefaultModel,
  type ModelInfo,
} from "./models.ts";
import { AgentTui, SLASH_COMMANDS } from "./tui.ts";

export { SLASH_COMMANDS, completeSlashLine, matchingSlashCommands, type SlashCommand } from "./tui.ts";

/** Example starting values from docs/AGENT-CORE.md; never spec constants. */
const MODEL_ENV = process.env.TERMINA_CORE_MODEL?.trim() || "";
const PROVIDER_ENV = process.env.TERMINA_CORE_PROVIDER?.trim() || "";
const PINNED_ROUTE = Boolean(MODEL_ENV || PROVIDER_ENV);
let route = parseModelRef(MODEL_ENV || DEFAULT_MODELS.anthropic.main, PROVIDER_ENV || undefined);
/** Routing map, role → model. Mechanical work rides the cheap lane. */
let summaryRoute = parseModelRef(
  process.env.TERMINA_CORE_SUMMARY_MODEL ?? DEFAULT_MODELS[route.provider].summary,
  process.env.TERMINA_CORE_SUMMARY_MODEL ? undefined : route.provider,
);
let catalog: ModelInfo[] | null = null;
const CONTEXT_WINDOW = Number(process.env.TERMINA_CORE_CONTEXT ?? 200_000);
const OUTPUT_RESERVE = 16_384;
const USABLE = Math.max(8_000, CONTEXT_WINDOW - OUTPUT_RESERVE);
const HIGH_WATER = 0.8;
const LOW_WATER = 0.6;
/** Trailing tool-output span never reclaimed (fraction of usable, clamped). */
const PROTECT_MIN = 4_000;
const PROTECT_MAX = 40_000;
const PROTECT_TOKENS = Math.min(PROTECT_MAX, Math.max(PROTECT_MIN, Math.floor(USABLE * 0.25)));
/** Newest user turns whose messages are never touched. */
const PROTECT_TURNS = 2;
/** Tool results below this size are never worth a stub. */
const PRUNE_MIN_CHARS = 2_048;
const READ_CAP_BYTES = 40 * 1024;
const BASH_CAP_BYTES = 20 * 1024;
const BASH_TIMEOUT_MS = 60_000;
const TOOL_CONCURRENCY = 4;
const NOISE_FLOOR_TOKENS = 1_024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const USER_AGENTS_CAP = 8_192;
const PROJECT_AGENTS_CAP = 24_576;
const SKILL_XML_CAP = 8_192;
const SKILL_COUNT_CAP = 32;
const GREP_HIT_CAP = 50;
const GREP_BYTE_CAP = 20 * 1024;
const GREP_VISIT_CAP = 2_000;
const GREP_LINE_CHARS = 8_192;
const GREP_BUDGET_MS = 2_000;
const GLOB_HIT_CAP = 200;
const TRACE_CAP = 64;
const LISTING_CAP = 20;
const PROBE_TIMEOUT_MS = 500;

/** Copy of the watcher's ignored names. Do not import electron/watcher.ts. */
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".pi",
  ".agents",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".yarn",
  ".venv",
  "venv",
  "dist",
  "out",
  "build",
  "coverage",
  ".DS_Store",
  "vendor",
  ".idea",
  ".vscode",
  ".hg",
  ".svn",
  ".terraform",
  ".serverless",
  ".expo",
  ".android",
  ".ios",
]);

export function parseMaxTurns(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 80;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 80;
  return n;
}

const MAX_TURNS = parseMaxTurns(process.env.TERMINA_CORE_MAX_TURNS);

/** Chars-per-token estimate. Good enough for water marks; never billing. */
function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export function freezeCwd(cwd: string): string {
  try {
    if (existsSync(cwd)) return realpathSync(cwd);
  } catch {
    /* fall through to resolve */
  }
  return resolve(cwd);
}

function underRoot(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

export function isValidTerminalId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function sortUtf8(names: string[]): string[] {
  return names.slice().sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
}

function yieldEventLoop(): Promise<void> {
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

export function validateGrepPattern(pattern: string): string | null {
  if (pattern.length < 1 || pattern.length > 256) return "error: pattern length must be 1–256";
  let i = 0;
  let inClass = false;
  let quantifiers = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) {
      const n = pattern[i + 1]!;
      if (n >= "0" && n <= "9") return "error: unsafe regular expression";
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c === "(" || c === ")") return "error: unsafe regular expression";
    if (c === "*" || c === "+" || c === "?") {
      quantifiers++;
      if (quantifiers > 1) return "error: unsafe regular expression";
      i++;
      continue;
    }
    if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close < 0) return "error: invalid regular expression";
      quantifiers++;
      if (quantifiers > 1) return "error: unsafe regular expression";
      i = close + 1;
      continue;
    }
    i++;
  }
  if (inClass) return "error: invalid regular expression";
  return null;
}

function fileHasNul(abs: string): boolean {
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

function classifyWalkPath(abs: string, root: string): { kind: "dir" | "file"; real: string } | null {
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
): Promise<{ files: string[]; hitCap: boolean; timedOut: boolean }> {
  const skipNul = opts?.skipNul !== false;
  const budgetMs = opts?.budgetMs ?? GREP_BUDGET_MS;
  const files: string[] = [];
  const visited = new Set<string>();
  const seenFiles = new Set<string>();
  const classified = classifyWalkPath(start, root);
  if (!classified) return { files, hitCap: false, timedOut: false };
  if (classified.kind === "file") {
    if (skipNul && fileHasNul(classified.real)) return { files, hitCap: false, timedOut: false };
    return { files: [classified.real], hitCap: false, timedOut: false };
  }
  const stack = [classified.real];
  let visits = 0;
  const started = Date.now();
  while (stack.length > 0) {
    if (opts?.shouldStop?.()) break;
    if (Date.now() - started >= budgetMs) return { files, hitCap: false, timedOut: true };
    const dir = stack.pop()!;
    let dirReal = dir;
    try {
      dirReal = realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(dirReal)) continue;
    visited.add(dirReal);
    let ents;
    try {
      ents = readdirSync(dirReal, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = sortUtf8(ents.map((e) => e.name));
    const byName = new Map(ents.map((e) => [e.name, e]));
    for (const name of names) {
      if (name === "." || name === "..") continue;
      if (IGNORED_SEGMENTS.has(name)) continue;
      const ent = byName.get(name);
      if (!ent) continue;
      const abs = join(dirReal, name);
      visits++;
      if (visits > visitCap) return { files, hitCap: true, timedOut: false };
      if (visits % 25 === 0) await yieldEventLoop();
      const next = classifyWalkPath(abs, root);
      if (!next) continue;
      if (next.kind === "dir") stack.push(next.real);
      else {
        if (seenFiles.has(next.real)) continue;
        seenFiles.add(next.real);
        if (skipNul && fileHasNul(next.real)) continue;
        files.push(next.real);
      }
    }
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  return { files, hitCap: false, timedOut: false };
}

const GREP_LINE_BYTE_CAP = GREP_LINE_CHARS * 4;

function forEachGrepLine(
  abs: string,
  fn: (lineNo: number, line: string) => boolean,
  shouldStop?: () => boolean,
): void {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const chunk = Buffer.alloc(64 * 1024);
    let leftover = Buffer.alloc(0);
    let skipUntilNl = false;
    let lineNo = 1;
    let pos = 0;
    for (;;) {
      if (shouldStop?.()) return;
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      let data = leftover.length > 0 ? Buffer.concat([leftover, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      leftover = Buffer.alloc(0);
      let start = 0;
      if (skipUntilNl) {
        const nl = data.indexOf(10);
        if (nl < 0) continue;
        skipUntilNl = false;
        start = nl + 1;
      }
      for (let i = start; i < data.length; i++) {
        if (data[i] !== 10) continue;
        let end = i;
        if (end > start && data[end - 1] === 13) end--;
        const raw = data.subarray(start, end);
        const line = raw.subarray(0, GREP_LINE_BYTE_CAP).toString("utf8").slice(0, GREP_LINE_CHARS);
        if (!fn(lineNo, line)) return;
        lineNo++;
        start = i + 1;
      }
      leftover = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
      if (leftover.length > GREP_LINE_BYTE_CAP) {
        const line = leftover.subarray(0, GREP_LINE_BYTE_CAP).toString("utf8").slice(0, GREP_LINE_CHARS);
        if (!fn(lineNo, line)) return;
        lineNo++;
        leftover = Buffer.alloc(0);
        skipUntilNl = true;
      }
    }
    if (!skipUntilNl && leftover.length > 0) {
      const line = leftover.subarray(0, GREP_LINE_BYTE_CAP).toString("utf8").slice(0, GREP_LINE_CHARS);
      fn(lineNo, line);
    }
  } catch {
    /* unreadable file */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function grepFiles(
  cwd: string,
  input: { pattern?: string; path?: string; glob?: string },
  opts?: { shouldStop?: () => boolean; budgetMs?: number },
): Promise<string> {
  const pattern = input.pattern ?? "";
  const unsafe = validateGrepPattern(pattern);
  if (unsafe) return unsafe;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return "error: invalid regular expression";
  }
  const root = freezeCwd(cwd);
  const confined = confinePath(cwd, input.path ?? ".", { mustExist: true });
  if (!confined.ok) return confined.error;
  if (input.glob) {
    if (input.glob.length < 1 || input.glob.length > 256) return "error: glob pattern length must be 1–256";
    if (/[\[\]{}]/.test(input.glob)) return "error: glob only supports * ** ?";
  }
  const budgetMs = opts?.budgetMs ?? GREP_BUDGET_MS;
  const started = Date.now();
  const collected = await collectFiles(confined.abs, root, GREP_VISIT_CAP, {
    shouldStop: opts?.shouldStop,
    budgetMs,
  });
  if (collected.timedOut) return `(grep timed out after ${collected.files.length} files)`;
  const hits: string[] = [];
  let bytes = 0;
  let scanned = 0;
  for (const abs of collected.files) {
    if (opts?.shouldStop?.()) break;
    if (Date.now() - started >= budgetMs) {
      hits.push(`(grep timed out after ${scanned} files)`);
      break;
    }
    scanned++;
    if (scanned % 25 === 0) await yieldEventLoop();
    const rel = relative(root, abs).split(sep).join("/");
    if (input.glob && !matchGlob(input.glob, rel)) continue;
    let hitCap = false;
    let timedOut = false;
    forEachGrepLine(
      abs,
      (lineNo, line) => {
        if (Date.now() - started >= budgetMs) {
          timedOut = true;
          return false;
        }
        if (!regex.test(line)) return true;
        const row = `${rel}:${lineNo}:${line}`;
        const rowBytes = Buffer.byteLength(row) + (hits.length > 0 ? 1 : 0);
        if (hits.length >= GREP_HIT_CAP || bytes + rowBytes > GREP_BYTE_CAP) {
          hitCap = true;
          return false;
        }
        hits.push(row);
        bytes += rowBytes;
        return true;
      },
      opts?.shouldStop,
    );
    if (hitCap) return hits.join("\n");
    if (timedOut) {
      hits.push(`(grep timed out after ${scanned} files)`);
      break;
    }
  }
  return hits.length > 0 ? hits.join("\n") : "(no matches)";
}

export async function globFiles(
  cwd: string,
  pattern: string,
  opts?: { shouldStop?: () => boolean; budgetMs?: number },
): Promise<string> {
  if (pattern.length < 1 || pattern.length > 256) return "error: pattern length must be 1–256";
  if (/[\[\]{}]/.test(pattern)) return "error: glob only supports * ** ?";
  const root = freezeCwd(cwd);
  const collected = await collectFiles(root, root, GREP_VISIT_CAP, {
    shouldStop: opts?.shouldStop,
    budgetMs: opts?.budgetMs,
  });
  if (collected.timedOut) return `(glob timed out after ${collected.files.length} files)`;
  const out: string[] = [];
  for (const abs of collected.files) {
    const rel = relative(root, abs).split(sep).join("/");
    if (!matchGlob(pattern, rel)) continue;
    out.push(rel);
    if (out.length >= GLOB_HIT_CAP) break;
  }
  return out.length > 0 ? out.join("\n") : "(no matches)";
}

export interface Skill {
  name: string;
  description: string;
  abs: string;
}

function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const rest = text.startsWith("---\n") || text.startsWith("---\r\n") ? text.slice(text.indexOf("\n") + 1) : text.slice(3);
  const end = rest.search(/\n---(?:\n|$)/);
  if (end < 0) return {};
  const block = rest.slice(0, end);
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xmlSafe(s: string): string {
  return escapeXml(s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""));
}

function walkSkillFiles(scanRoot: string): { files: string[]; capped: boolean } {
  if (!existsSync(scanRoot)) return { files: [], capped: false };
  let rootReal: string;
  try {
    rootReal = realpathSync(scanRoot);
  } catch {
    return { files: [], capped: false };
  }
  const found: string[] = [];
  const visited = new Set<string>();
  const stack = [rootReal];
  let visits = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirReal = dir;
    try {
      dirReal = realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(dirReal)) continue;
    visited.add(dirReal);
    let ents;
    try {
      ents = readdirSync(dirReal, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = sortUtf8(ents.map((e) => e.name));
    for (const name of names) {
      if (name === "." || name === "..") continue;
      if (name === "node_modules") continue;
      visits++;
      if (visits > GREP_VISIT_CAP) return { files: found, capped: true };
      const abs = join(dirReal, name);
      const next = classifyWalkPath(abs, rootReal);
      if (!next) continue;
      if (next.kind === "dir") stack.push(next.real);
      else if (basename(next.real) === "SKILL.md") found.push(next.real);
    }
  }
  found.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  return { files: found, capped: false };
}

export function scanSkills(dirs: string[]): { skills: Skill[]; capped: boolean } {
  const byName = new Map<string, Skill>();
  let capped = false;
  for (const dir of dirs) {
    const walked = walkSkillFiles(dir);
    if (walked.capped) capped = true;
    for (const abs of walked.files) {
      if (fileHasNul(abs)) continue;
      let text: string;
      try {
        const fd = openSync(abs, "r");
        try {
          const buf = Buffer.alloc(8192);
          const n = readSync(fd, buf, 0, 8192, 0);
          text = buf.subarray(0, n).toString("utf8");
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      const fm = parseFrontmatter(text);
      if (fm["disable-model-invocation"] === "true") continue;
      const name = (fm.name || basename(dirname(abs))).trim();
      if (!name) continue;
      byName.set(name, { name, description: fm.description ?? "", abs });
    }
  }
  const skills = [...byName.values()].sort((a, b) => {
    const n = Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8"));
    if (n !== 0) return n;
    return Buffer.compare(Buffer.from(a.abs, "utf8"), Buffer.from(b.abs, "utf8"));
  });
  return { skills, capped };
}

export function formatSkillIndex(skills: Skill[], opts?: { capped?: boolean }): string {
  if (skills.length === 0 && !opts?.capped) return "";
  const lines = ["<skill-index>"];
  let n = 0;
  let omitted = 0;
  for (const s of skills) {
    const tag = `<skill name="${xmlSafe(s.name)}" path="${xmlSafe(s.abs)}">${xmlSafe(s.description)}</skill>`;
    const trial = [...lines, tag, "</skill-index>"].join("\n");
    if (n >= SKILL_COUNT_CAP || Buffer.byteLength(trial) > SKILL_XML_CAP) {
      omitted = skills.length - n;
      break;
    }
    lines.push(tag);
    n++;
  }
  if (omitted > 0) lines.push(`<!-- ${omitted} skills omitted -->`);
  if (opts?.capped) lines.push("<!-- skill scan capped -->");
  lines.push("</skill-index>");
  return lines.join("\n");
}

function capParagraph(md: string, max: number): { text: string; omitted: number } {
  if (md.length <= max) return { text: md, omitted: 0 };
  const slice = md.slice(0, max);
  const blank = slice.lastIndexOf("\n\n");
  const text = blank > 0 ? slice.slice(0, blank) : slice;
  return { text, omitted: md.length - text.length };
}

export function formatProjectInstructions(md: string): string {
  const { text, omitted } = capParagraph(md, PROJECT_AGENTS_CAP);
  let body = text;
  if (omitted > 0) body += `\n<!-- AGENTS.md truncated; ${omitted} chars remain; read AGENTS.md with read_file -->`;
  return `<project-instructions>\n${body}\n</project-instructions>`;
}

export function formatUserInstructions(md: string, absPath: string): string {
  const { text, omitted } = capParagraph(md, USER_AGENTS_CAP);
  let body = text;
  if (omitted > 0) {
    // Keep the absolute path outside the HTML comment. A path that contains
    // "--" would otherwise close the comment early.
    body += `\n<!-- AGENTS.md truncated; ${omitted} chars remain -->\nread_file ${JSON.stringify(absPath)}`;
  }
  return `<user-instructions>\n${body}\n</user-instructions>`;
}

function resolveTrustedBin(bin: string, cwdRoot: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      continue;
    }
    if (underRoot(realDir, cwdRoot)) continue;
    const cand = join(realDir, bin);
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      continue;
    }
  }
  return null;
}

function probeAbs(absBin: string, remainingMs: number): string | null {
  if (remainingMs <= 0) return null;
  try {
    const out = execFileSync(absBin, ["--version"], {
      timeout: remainingMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = String(out).split("\n")[0]?.trim() ?? "";
    return line ? line.slice(0, 80) : null;
  } catch (err) {
    const extra = err as { stdout?: string; stderr?: string };
    const line = `${extra.stdout ?? ""}${extra.stderr ?? ""}`.split("\n")[0]?.trim() ?? "";
    return line ? line.slice(0, 80) : null;
  }
}

export function formatEnvironment(cwd: string, opts?: { probes?: boolean }): string {
  const root = freezeCwd(cwd);
  const lines = [`cwd: ${JSON.stringify(root)}`, `platform: ${JSON.stringify(process.platform)}`];
  try {
    const names = sortUtf8(readdirSync(root).filter((n) => n !== "." && n !== ".." && !IGNORED_SEGMENTS.has(n))).slice(
      0,
      LISTING_CAP,
    );
    if (names.length > 0) lines.push(`listing: ${names.map((n) => JSON.stringify(n)).join(", ")}`);
  } catch {
    /* unreadable cwd */
  }
  if (opts?.probes !== false) {
    const tools: string[] = [`node ${process.version}`];
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    for (const bin of ["python3", "rustc", "go"]) {
      const abs = resolveTrustedBin(bin, root);
      if (!abs) continue;
      const ver = probeAbs(abs, deadline - Date.now());
      if (ver) tools.push(`${bin} ${ver}`);
    }
    lines.push(`toolchain: ${tools.join("; ")}`);
  }
  return `<environment>\n${lines.join("\n")}\n</environment>`;
}

export function formatStub(opts: { chars: number; tool: string; sseq: number; repro?: string }): string {
  const repro = opts.repro ? ` — reproduce: ${opts.repro}` : "";
  return `[cleared: ${opts.chars} chars of ${opts.tool} — storageSeq ${opts.sseq}${repro}]`;
}

export function parseOffset(value: unknown): number | { error: string } {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) return { error: "error: offset must be a number" };
  const i = Math.floor(n);
  if (i < 0) return { error: "error: offset must be >= 0" };
  return i;
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

export function readFileResult(abs: string, offset: number): { content: string; isError: boolean } {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const st = fstatSync(fd);
    const head = Buffer.alloc(Math.min(4096, st.size));
    if (head.length > 0) readSync(fd, head, 0, head.length, 0);
    if (head.includes(0)) return { content: "error: binary file", isError: true };
    if (offset >= st.size) return { content: "", isError: false };
    const want = Math.min(READ_CAP_BYTES, Math.max(0, st.size - offset));
    const slice = Buffer.alloc(want);
    if (want > 0) readSync(fd, slice, 0, want, offset);
    let text = slice.toString("utf8");
    if (offset + want < st.size) {
      text += `\n[truncated at ${READ_CAP_BYTES} bytes — read_file offset ${offset + want}]`;
    }
    return { content: text, isError: false };
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, isError: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readProjectFile(
  cwd: string,
  input: { path?: string; offset?: unknown },
  allow?: ReadonlySet<string>,
): { content: string; isError: boolean } {
  const off = parseOffset(input.offset);
  if (typeof off !== "number") return { content: off.error, isError: true };
  const confined = confinePath(cwd, input.path ?? "", { allow });
  if (!confined.ok) return { content: confined.error, isError: true };
  let st;
  try {
    st = statSync(confined.abs);
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, isError: true };
  }
  if (st.isDirectory()) return { content: "error: EISDIR", isError: true };
  const got = readFileResult(confined.abs, off);
  if (got.isError) return got;
  const pointer = nestedAgentsPointer(cwd, confined.abs);
  if (pointer) return { content: `${pointer}\n${got.content}`, isError: false };
  return got;
}

export function writeProjectFile(cwd: string, path: string | undefined, content: string): { content: string; isError: boolean } {
  const confined = confinePath(cwd, path ?? "");
  if (!confined.ok) return { content: confined.error, isError: true };
  try {
    mkdirSync(dirname(confined.abs), { recursive: true });
    writeFileSync(confined.abs, content);
    return { content: `ok: wrote ${confined.abs}`, isError: false };
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, isError: true };
  }
}

// ---- sidecar (the bridge contract) ----

export function tracesDirFor(events: string, id: string): string | null {
  if (!events || !isValidTerminalId(id)) return null;
  return join(events, `${id}.traces`);
}

export function retainTraceFiles(dir: string, cap: number): string[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const turns = names
    .map((n) => {
      const m = n.match(/^turn-(\d+)\.json$/);
      return m ? { n, i: Number(m[1]) } : null;
    })
    .filter((x): x is { n: string; i: number } => x !== null)
    .sort((a, b) => a.i - b.i);
  while (turns.length > cap) {
    const oldest = turns.shift()!;
    try {
      rmSync(join(dir, oldest.n), { force: true });
    } catch {
      /* ignore */
    }
  }
  return turns.map((t) => t.n);
}

const eventsDir = process.env.TERMINA_EVENTS_DIR ?? "";
const rawTerminalId = process.env.TERMINA_TERMINAL_ID ?? "";
const terminalId = isValidTerminalId(rawTerminalId) ? rawTerminalId : "";
const sessionId = process.env.TERMINA_CORE_SESSION_ID?.trim() || terminalId;
const bridgeId = `core-${randomUUID()}`;
let seq = 0;
const canonicalCwd = freezeCwd(process.cwd());
let allowPaths = new Set<string>();
const tracesDir = tracesDirFor(eventsDir, terminalId) ?? "";
let traceTurn = 0;
let streamPrepared = false;

function logEvent(body: Record<string, unknown>): void {
  if (!eventsDir || !terminalId) return;
  try {
    mkdirSync(eventsDir, { recursive: true });
    const line = JSON.stringify({ bridgeId, seq: ++seq, ...body }) + "\n";
    appendFileSync(join(eventsDir, terminalId + ".jsonl"), line, { mode: 0o600 });
  } catch {
    /* the tailer tolerates gaps; never crash the loop on log failure */
  }
}

function resetTraces(): void {
  if (!tracesDir) return;
  try {
    rmSync(tracesDir, { recursive: true, force: true });
    mkdirSync(tracesDir, { recursive: true, mode: 0o700 });
  } catch {
    /* traces are best-effort */
  }
}

function pruneTraces(): void {
  if (!tracesDir) return;
  retainTraceFiles(tracesDir, TRACE_CAP);
}

export function traceRecord(fields: {
  role: "main" | "summary";
  model: string;
  status: string;
  storageSeqRange: readonly [number, number];
  toolNames: string[];
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number } | null;
  ttftMs: number | null;
  turnMs: number;
  revisions: number;
  wasteCause: string | null;
  systemHash: string;
}): {
  role: "main" | "summary";
  model: string;
  status: string;
  storageSeqRange: readonly [number, number];
  toolNames: string[];
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number } | null;
  ttftMs: number | null;
  turnMs: number;
  revisions: number;
  wasteCause: string | null;
  systemHash: string;
} {
  return {
    role: fields.role,
    model: fields.model,
    status: fields.status,
    storageSeqRange: fields.storageSeqRange,
    toolNames: fields.toolNames.slice(),
    usage: fields.usage
      ? {
          input: fields.usage.input,
          cacheRead: fields.usage.cacheRead,
          cacheWrite: fields.usage.cacheWrite,
          output: fields.usage.output,
        }
      : null,
    ttftMs: fields.ttftMs,
    turnMs: fields.turnMs,
    revisions: fields.revisions,
    wasteCause: fields.wasteCause,
    systemHash: fields.systemHash,
  };
}

function writeTrace(payload: ReturnType<typeof traceRecord>): void {
  if (!tracesDir) return;
  try {
    mkdirSync(tracesDir, { recursive: true, mode: 0o700 });
    const n = ++traceTurn;
    writeFileSync(join(tracesDir, `turn-${n}.json`), JSON.stringify(payload), { mode: 0o600 });
    pruneTraces();
  } catch {
    /* traces are best-effort */
  }
}

export function hashSystem(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

// ---- append-only session storage ----

export function resolveSessionFile(events: string, termId: string, override?: string): string | null {
  const explicit = override?.trim() || "";
  if (explicit) return explicit;
  if (events && termId) return join(events, `${termId}.session.jsonl`);
  return null;
}

const sessionFile = resolveSessionFile(eventsDir, terminalId, process.env.TERMINA_CORE_SESSION_FILE);
let storageSeq = 0;

export function prepareSessionStream(sessionPath: string, mode: "fresh"): void {
  if (mode === "fresh") writeFileSync(sessionPath, "");
}

export const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;

/** Move a failed resume file aside so the next prompt does not truncate it. */
export function quarantineSessionFile(path: string): boolean {
  try {
    const dest = existsSync(`${path}.bad`) ? `${path}.bad-${Date.now()}` : `${path}.bad`;
    renameSync(path, dest);
    return true;
  } catch {
    return false;
  }
}

function ensureFreshSession(): void {
  if (streamPrepared) return;
  streamPrepared = true;
  if (sessionFile) {
    try {
      prepareSessionStream(sessionFile, "fresh");
    } catch {
      /* ignore */
    }
  }
  storageSeq = 0;
}

/** Storage takes originals only. Revisions append records; they never
 *  rewrite these lines. Returns the entry's stable sequence address. */
function store(entry: Record<string, unknown>): number {
  const sseq = ++storageSeq;
  if (!sessionFile) return sseq;
  try {
    appendFileSync(sessionFile, JSON.stringify({ storageSeq: sseq, ...entry }) + "\n", { mode: 0o600 });
  } catch {
    /* storage failure degrades to in-memory only */
  }
  return sseq;
}

function readOptional(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---- frozen deterministic front matter ----

let frozenSystem: string | null = null;

/** Built once per process, fixed order: identity, environment, user
 *  instructions, skill index, project instructions. */
export function buildFrozenSystem(opts: {
  cwd: string;
  userAgentsPath: string | null;
  userSkillDir: string | null;
  probes?: boolean;
}): { system: string; allow: Set<string> } {
  const root = freezeCwd(opts.cwd);
  const skillDirs: string[] = [];
  if (opts.userSkillDir) skillDirs.push(opts.userSkillDir);
  const projectSkillRoot = join(root, ".agents", "skills");
  try {
    if (existsSync(projectSkillRoot) && underRoot(realpathSync(projectSkillRoot), root)) {
      skillDirs.push(projectSkillRoot);
    }
  } catch {
    /* omit escaped project skill root */
  }
  const scanned = scanSkills(skillDirs);
  const allow = new Set(scanned.skills.map((s) => s.abs));
  if (opts.userAgentsPath) {
    try {
      if (existsSync(opts.userAgentsPath)) allow.add(realpathSync(opts.userAgentsPath));
    } catch {
      /* missing or unreadable */
    }
  }
  const parts = [
    "You are the Termina agent-core. Be terse. Use tools to do real work in the user's project.",
    formatEnvironment(root, { probes: opts.probes !== false }),
  ];
  if (opts.userAgentsPath) {
    const userMd = readOptional(opts.userAgentsPath);
    if (userMd !== null) {
      let abs = opts.userAgentsPath;
      try {
        abs = realpathSync(opts.userAgentsPath);
      } catch {
        /* keep unresolved path */
      }
      parts.push(formatUserInstructions(userMd, abs));
    }
  }
  const skillXml = formatSkillIndex(scanned.skills, { capped: scanned.capped });
  if (skillXml) parts.push(skillXml);
  const projPath = join(root, "AGENTS.md");
  try {
    if (existsSync(projPath) && underRoot(realpathSync(projPath), root)) {
      const proj = readOptional(projPath);
      if (proj !== null) parts.push(formatProjectInstructions(proj));
    }
  } catch {
    /* omit escaped project instructions */
  }
  return { system: parts.join("\n\n"), allow };
}

function freezeFrontMatter(): string {
  if (frozenSystem !== null) return frozenSystem;
  const built = buildFrozenSystem({
    cwd: canonicalCwd,
    userAgentsPath: join(homedir(), ".agents", "AGENTS.md"),
    userSkillDir: join(homedir(), ".agents", "skills"),
    probes: true,
  });
  allowPaths = built.allow;
  frozenSystem = built.system;
  return frozenSystem;
}

function systemPrompt(): string {
  return freezeFrontMatter();
}

// ---- tools ----

interface ToolUse {
  id: string;
  name: string;
  input: {
    path?: string;
    command?: string;
    content?: string;
    offset?: unknown;
    pattern?: string;
    glob?: string;
    query?: string;
  };
}

interface ToolOutcome {
  result: Record<string, unknown>;
  isError: boolean;
}

function toolResult(use: ToolUse, content: string): Record<string, unknown> {
  return { type: "tool_result", tool_use_id: use.id, content };
}

function done(use: ToolUse, content: string, isError: boolean): ToolOutcome {
  return { result: toolResult(use, content), isError };
}

export function shellQuote(raw: string): string {
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80);
  return `'${cleaned.replace(/'/g, `'\\''`)}'`;
}

export function capTail(text: string, maxBytes: number, repro?: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const tail = buf.subarray(buf.length - maxBytes).toString("utf8");
  const marker = `[early output truncated to ${maxBytes} bytes — reproduce: ${repro ?? ""}]`;
  return `${marker}\n${tail}`;
}

export function reproFor(use: ToolUse): string | undefined {
  if (use.name === "bash") return `bash ${shellQuote(use.input.command ?? "")}`;
  if (use.name === "read_file") return `read_file(${JSON.stringify(use.input.path ?? "")})`;
  if (use.name === "grep") return `grep ${shellQuote(use.input.pattern ?? "")}`;
  if (use.name === "glob") return `glob ${shellQuote(use.input.pattern ?? "")}`;
  if (use.name === "web_search") return `web_search ${shellQuote(use.input.query ?? "")}`;
  return undefined;
}

export function sidecarStartFor(use: { name: string; id: string; input: { path?: string } }): Record<string, unknown> {
  if (use.name === "write_file") {
    return { t: "tool", toolName: "write", path: use.input.path, toolCallId: use.id };
  }
  return { t: "tool", toolName: use.name, toolCallId: use.id };
}

async function executeTool(use: ToolUse): Promise<ToolOutcome> {
  if (use.name === "read_file") {
    const got = readProjectFile(canonicalCwd, use.input, allowPaths);
    return done(use, got.content, got.isError);
  }
  if (use.name === "write_file") {
    const got = writeProjectFile(canonicalCwd, use.input.path, use.input.content ?? "");
    return done(use, got.content, got.isError);
  }
  if (use.name === "grep") {
    const out = await grepFiles(canonicalCwd, use.input, { shouldStop: () => interrupted });
    return done(use, out, out.startsWith("error:"));
  }
  if (use.name === "glob") {
    const out = await globFiles(canonicalCwd, use.input.pattern ?? "", { shouldStop: () => interrupted });
    return done(use, out, out.startsWith("error:"));
  }
  if (use.name === "web_search") {
    return done(use, "error: web_search is provider-executed", true);
  }
  if (use.name === "bash") {
    return new Promise((res) => {
      execFile(
        "/bin/bash",
        ["-c", use.input.command ?? ""],
        { cwd: canonicalCwd, timeout: BASH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          const parts = [stdout, stderr];
          let failed = false;
          if (err) {
            failed = true;
            parts.push(`[exit ${typeof err.code === "number" ? err.code : err.signal ?? "error"}]`);
          }
          const repro = reproFor(use);
          res(done(use, capTail(parts.filter(Boolean).join("\n") || "(no output)", BASH_CAP_BYTES, repro), failed));
        },
      );
    });
  }
  return done(use, `error: unknown tool ${use.name}`, true);
}

const TOOLS = [
  {
    name: "read_file",
    description: "Read a file relative to the working directory. Output caps near 40 KB. Pass offset (bytes) to continue a truncated read.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "number" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file relative to the working directory. Parent directories are created. Paths stay inside the project.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "grep",
    description: "Search file contents with a JavaScript regular expression. Caps hits and skips ignored directories.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "Find files relative to the working directory. Pattern supports * ** and ? only.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "bash",
    description: "Run one bash command in the working directory. 60 s timeout. Combined output caps near 20 KB.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
];

/** Provider-executed search. Same Anthropic key as the model. No Brave key. */
export const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
} as const;

export function buildCachedPrefix(
  system: string,
  tools: Array<Record<string, unknown>>,
): {
  cache_control: { type: "ephemeral" };
  system: Array<{ type: "text"; text: string; cache_control: { type: "ephemeral" } }>;
  tools: Array<Record<string, unknown> & { cache_control?: { type: "ephemeral" } }>;
} {
  const copied = tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : { ...t },
  );
  return {
    cache_control: { type: "ephemeral" },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: copied,
  };
}

/** Append provider search after cached client tools. Do not put
 *  cache_control on the server tool: a strict schema can 400. */
export function requestTools(
  cachedClientTools: Array<Record<string, unknown>>,
  provider: string = "anthropic",
): Array<Record<string, unknown>> {
  if (provider !== "anthropic") return cachedClientTools;
  return [...cachedClientTools, { ...WEB_SEARCH_TOOL }];
}

function logToolStart(use: ToolUse): void {
  logEvent(sidecarStartFor(use));
}

function logServerSearch(
  blocks: Array<{ type: string; id?: string; name?: string; tool_use_id?: string; content?: unknown }>,
): string[] {
  const names: string[] = [];
  for (const b of blocks) {
    if (b.type === "server_tool_use") {
      const name = b.name ?? "web_search";
      names.push(name);
      logEvent(sidecarStartFor({ name, id: b.id ?? "", input: {} }));
      out(`\n[${name}]\n`);
    } else if (b.type === "web_search_tool_result") {
      const err =
        Boolean(b.content) &&
        typeof b.content === "object" &&
        !Array.isArray(b.content) &&
        (b.content as { type?: string }).type === "web_search_tool_result_error";
      if (b.tool_use_id) logEvent({ t: "tool_end", toolCallId: b.tool_use_id, isError: err });
    }
  }
  return names;
}

// ---- history: in-memory view over the append-only storage ----

type ContentBlock = Record<string, unknown> & {
  type: string;
  /** View metadata. Stripped before any request leaves the process. */
  chars?: number;
  tool?: string;
  repro?: string;
  stubbed?: boolean;
};

interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  tokens: number;
  /** Stable storage address. Revision records point here, never at
   *  shifting array indices. */
  sseq: number;
}

const history: Message[] = [];

function blockChars(b: ContentBlock): number {
  if (typeof b.chars === "number") return b.chars;
  if (b.type === "text") return String((b as { text?: string }).text ?? "").length;
  if (b.type === "tool_result") return String((b as { content?: string }).content ?? "").length;
  if (b.type === "tool_use") return JSON.stringify((b as { input?: unknown }).input ?? {}).length;
  return 0;
}

function estimate(m: Message): number {
  if (typeof m.content === "string") return tokenEstimate(m.content) + 4;
  let sum = 4;
  for (const b of m.content) {
    const payload =
      b.type === "tool_use" || b.type === "server_tool_use"
        ? JSON.stringify((b as { input?: unknown }).input ?? {})
        : b.type === "web_search_tool_result" || b.type === "thinking" || b.type === "redacted_thinking"
          ? JSON.stringify(b)
          : String((b as { text?: string; content?: string }).text ?? (b as { content?: string }).content ?? "");
    sum += tokenEstimate(payload) + 10;
  }
  return sum;
}

const VIEW_KEYS = new Set(["chars", "tool", "repro", "stubbed"]);

/** Strip view metadata. Extra keys on a content block (stubbed flags
 *  included) make the provider reject the whole request. */
export function toProviderBlock(b: ContentBlock): Record<string, unknown> {
  const out: Record<string, unknown> = { type: b.type };
  for (const [k, v] of Object.entries(b)) {
    if (k === "type" || VIEW_KEYS.has(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function toRequest(messages: Message[]): Array<{ role: string; content: unknown }> {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    return { role: m.role, content: m.content.map(toProviderBlock) };
  });
}

export function placeStreamBlock<T>(slots: Array<T | undefined>, index: unknown, block: T): void {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 10_000) return;
  slots[index] = block;
}

export function compactStreamBlocks<T>(slots: Array<T | undefined>): T[] {
  return slots.filter((b): b is T => b !== undefined);
}

function pushMessage(role: Message["role"], content: Message["content"]): Message {
  const m: Message = { role, content, tokens: 0, sseq: 0 };
  m.tokens = estimate(m);
  history.push(m);
  m.sseq = store({ type: "message", message: { role, content } });
  return m;
}

// ---- reclamation with hysteresis ----

/** Pure planner: pick the oldest prunable tool results outside the protected
 *  recency window until the projected total falls under the low-water mark. */
export function planPruneStubs(
  messages: Array<{ role: string; content: unknown; tokens: number }>,
  opts: { systemTokens: number; usable: number; protectTokens: number },
): Array<{ msgIndex: number }> {
  const total =
    opts.systemTokens +
    messages.reduce((sum, m) => sum + m.tokens, 0);
  // Hysteresis lives on the fill level: act at the high-water mark, reclaim
  // down to the low-water mark. Between the marks: do nothing.
  if (total < opts.usable * HIGH_WATER) return [];
  const quota = total - opts.usable * LOW_WATER;

  // Walk from the newest message backwards marking the protected span: the
  // last PROTECT_TURNS user prompts plus PROTECT_TOKENS of context.
  const protectedIdx = new Set<number>();
  let seen = 0;
  let guarded = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    protectedIdx.add(i);
    guarded += m.tokens;
    if (m.role === "user" && typeof m.content === "string") {
      seen++;
      if (seen >= PROTECT_TURNS) break;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (guarded >= opts.protectTokens) break;
    if (!protectedIdx.has(i)) {
      protectedIdx.add(i);
      guarded += messages[i]!.tokens;
    }
  }

  // Oldest-first selection among unprotected bulky tool results.
  const picks: Array<{ msgIndex: number }> = [];
  let reclaimed = 0;
  for (let i = 0; i < messages.length && reclaimed < quota; i++) {
    if (protectedIdx.has(i)) continue;
    const m = messages[i]!;
    if (typeof m.content === "string") continue;
    for (const b of m.content as ContentBlock[]) {
      if (reclaimed >= quota) break;
      if (b.type !== "tool_result") continue;
      const chars = blockChars(b as ContentBlock);
      if (chars < PRUNE_MIN_CHARS) continue;
      if ((b as ContentBlock).stubbed) continue;
      picks.push({ msgIndex: i });
      reclaimed += tokenEstimate("x".repeat(chars));
    }
  }
  return picks;
}

export type ReplayMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  sseq: number;
};

export function replaySessionRecords(
  text: string,
): { ok: true; messages: ReplayMessage[]; maxSeq: number } | { ok: false; error: string } {
  const rawLines = text.split("\n");
  const lines = rawLines.filter((line, i) => {
    if (line.trim() === "") return false;
    if (i === rawLines.length - 1) {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  });
  const messages: ReplayMessage[] = [];
  const bySeq = new Map<number, ReplayMessage>();
  const seen = new Set<number>();
  let maxSeq = 0;
  for (const line of lines) {
    let e: {
      storageSeq?: unknown;
      type?: string;
      message?: { role: string; content: ReplayMessage["content"] };
      kind?: string;
      targets?: Array<{ sseq: number; blockIndex: number }>;
      dropped?: number;
      evicted?: number;
      summarySseq?: number;
    };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      return { ok: false, error: "malformed session record" };
    }
    if (typeof e.storageSeq !== "number" || !Number.isInteger(e.storageSeq) || e.storageSeq < 1) {
      return { ok: false, error: "invalid storageSeq" };
    }
    if (seen.has(e.storageSeq)) return { ok: false, error: "duplicate storageSeq" };
    seen.add(e.storageSeq);
    maxSeq = Math.max(maxSeq, e.storageSeq);
    if (e.type === "message" && e.message && (e.message.role === "user" || e.message.role === "assistant")) {
      const m: ReplayMessage = { role: e.message.role, content: e.message.content, sseq: e.storageSeq };
      messages.push(m);
      bySeq.set(m.sseq, m);
    } else if (e.type === "revision" && e.kind === "prune" && Array.isArray(e.targets)) {
      for (const t of e.targets) {
        const m = bySeq.get(t.sseq);
        if (!m || typeof m.content === "string") continue;
        const b = m.content[t.blockIndex] as ContentBlock | undefined;
        if (!b || b.type !== "tool_result" || b.stubbed) continue;
        const stub = formatStub({
          chars: blockChars(b),
          tool: String(b.tool ?? "tool"),
          sseq: m.sseq,
          repro: typeof b.repro === "string" ? b.repro : undefined,
        });
        (b as unknown as { content: string }).content = stub;
        b.stubbed = true;
      }
    } else if (e.type === "revision" && e.kind === "truncate" && typeof e.dropped === "number") {
      messages.splice(0, e.dropped);
    } else if (e.type === "revision" && e.kind === "summarize") {
      if (typeof e.summarySseq !== "number" || !Number.isInteger(e.summarySseq) || e.summarySseq < 1) {
        return { ok: false, error: "invalid summarize revision" };
      }
      if (typeof e.evicted !== "number" || !Number.isInteger(e.evicted) || e.evicted < 0) {
        return { ok: false, error: "invalid summarize revision" };
      }
      const idx = messages.findIndex((m) => m.sseq === e.summarySseq);
      if (idx < 0) return { ok: false, error: "summarize handoff missing" };
      if (idx < e.evicted) return { ok: false, error: "summarize handoff inside evicted span" };
      const handoff = messages.splice(idx, 1)[0]!;
      messages.splice(0, e.evicted);
      messages.unshift(handoff);
    }
  }
  return { ok: true, messages, maxSeq };
}

let postRevision = false;

/** Apply the planner to the live view. Storage already holds the originals. */
function reclaim(): number {
  const plan = planPruneStubs(
    history.map((m) => ({ role: m.role, content: m.content, tokens: m.tokens })),
    {
      systemTokens: tokenEstimate(systemPrompt()),
      usable: USABLE,
      protectTokens: PROTECT_TOKENS,
    },
  );
  let stubbedCount = 0;
  const targets: Array<{ sseq: number; blockIndex: number }> = [];
  for (const pick of plan) {
    const m = history[pick.msgIndex]!;
    if (typeof m.content === "string") continue;
    const blocks = m.content as ContentBlock[];
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi]!;
      if (b.type !== "tool_result" || b.stubbed) continue;
      const c = blockChars(b);
      if (c < PRUNE_MIN_CHARS) continue;
      const stub = formatStub({ chars: c, tool: b.tool ?? "tool", sseq: m.sseq, repro: b.repro });
      (b as unknown as { content: string }).content = stub;
      b.chars = stub.length;
      b.stubbed = true;
      stubbedCount++;
      targets.push({ sseq: m.sseq, blockIndex: bi });
    }
    m.tokens = estimate(m);
  }
  if (stubbedCount > 0) {
    postRevision = true;
    revisions++;
    store({ type: "revision", kind: "prune", targets });
  }
  return stubbedCount;
}

/** Last resort when reclamation alone cannot fit the window: drop whole old
 *  turns, cutting only at real prompts. Storage keeps every dropped byte. */
function truncate(): boolean {
  let total = totalTokens();
  if (total < USABLE) return false;
  let cut = 0;
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === "user" && typeof m.content === "string") cut = i;
    total -= m.tokens;
    if (i === cut && total < USABLE * LOW_WATER) break;
  }
  if (cut <= 0) return false;
  history.splice(0, cut);
  postRevision = true;
  revisions++;
  store({ type: "revision", kind: "truncate", dropped: cut });
  return true;
}

// ---- summarization ----

/** The chained handoff. Each summary folds the previous one in. */
let lastHandoff: string | null = null;

function totalTokens(): number {
  return tokenEstimate(systemPrompt()) + history.reduce((s, m) => s + m.tokens, 0);
}

/** Newest-first protected span, mirroring the planner's window. Returns the
 *  index where the evicted span ends, adjusted back to a prompt boundary so
 *  the surviving tail starts a clean turn. */
function evictionBoundary(): number {
  let guarded = 0;
  let seen = 0;
  let boundary = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    boundary = i;
    guarded += history[i]!.tokens;
    if (history[i]!.role === "user" && typeof history[i]!.content === "string") {
      seen++;
      if (seen >= PROTECT_TURNS && guarded >= Math.min(PROTECT_TOKENS, USABLE / 4)) break;
    }
  }
  // The tail must start at a real prompt; walk forward past orphan results.
  while (
    boundary < history.length &&
    !(history[boundary]!.role === "user" && typeof history[boundary]!.content === "string")
  ) {
    boundary++;
  }
  return boundary;
}

function serializeForSummary(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      parts.push(`[User]: ${m.content.slice(0, 2_000)}`);
      continue;
    }
    for (const b of m.content as ContentBlock[]) {
      if (b.type === "text") parts.push(`[Assistant]: ${String(b.text ?? "").slice(0, 2_000)}`);
      else if (b.type === "tool_use" || b.type === "server_tool_use")
        parts.push(`[Tool call]: ${b.name}(${JSON.stringify(b.input).slice(0, 300)})`);
      else if (b.type === "tool_result" && !b.stubbed)
        parts.push(`[Tool result]: ${String(b.content ?? "").slice(0, 500)}`);
    }
  }
  return parts.join("\n").slice(0, 60_000);
}

/** Structured inventories extracted from tool calls, not prose hope. */
function fileInventories(messages: Message[]): string {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content as ContentBlock[]) {
      if (b.type !== "tool_use") continue;
      const input = (b as { input?: { path?: string } }).input;
      if (!input?.path) continue;
      if (b.name === "read_file") read.add(input.path);
      if (b.name === "write_file") modified.add(input.path);
    }
  }
  const sections: string[] = [];
  if (read.size > 0) sections.push(`<read-files>\n${[...read].join("\n")}\n</read-files>`);
  if (modified.size > 0) sections.push(`<modified-files>\n${[...modified].join("\n")}\n</modified-files>`);
  return sections.join("\n");
}

/** Collapse old turns into one handoff message. Runs on the cheap lane.
 *  Returns false when there is nothing safely evictable or the call fails;
 *  callers fall back to truncate. */
async function summarize(): Promise<boolean> {
  const boundary = evictionBoundary();
  if (boundary <= 0) return false;
  const evicted = history.slice(0, boundary);
  const prior = lastHandoff ? `<previous-handoff>\n${lastHandoff}\n</previous-handoff>\n\n` : "";
  const prompt = `${prior}<session-to-compress>\n${serializeForSummary(evicted)}\n</session-to-compress>\n\nProduce the context handoff for continuing this session: task state, decisions made, files touched, open threads. Only output the handoff.`;
  const started = Date.now();
  currentAbort ??= new AbortController();
  try {
    const summarySystem = "You compress coding-agent session history. Only output the structured handoff.";
    const folded = await completeText(summaryRoute.provider, summaryRoute.model, summarySystem, prompt, currentAbort.signal);
    const text = folded.text;
    if (!text) return false;
    const u = folded.usage;
    const inventories = fileInventories(evicted);
    const handoff = `<context-handoff>\n${text}${inventories ? `\n\n${inventories}` : ""}\n</context-handoff>`;
    lastHandoff = text;
    history.splice(0, boundary);
    const m: Message = { role: "user", content: handoff, tokens: estimate({ role: "user", content: handoff, tokens: 0, sseq: 0 }), sseq: 0 };
    history.unshift(m);
    m.sseq = store({ type: "message", message: { role: "user", content: handoff } });
    postRevision = true;
    revisions++;
    store({ type: "revision", kind: "summarize", evicted: boundary, summarySseq: m.sseq });
    writeTrace(
      traceRecord({
        role: "summary",
        model: summaryRoute.model,
        status: "ok",
        storageSeqRange: [m.sseq, m.sseq],
        toolNames: [],
        usage: u,
        ttftMs: null,
        turnMs: Date.now() - started,
        revisions: 1,
        wasteCause: null,
        systemHash: hashSystem("You compress coding-agent session history. Only output the structured handoff."),
      }),
    );
    out(`[context summarized: ${boundary} messages folded]\n`);
    return true;
  } catch (err) {
    writeTrace(
      traceRecord({
        role: "summary",
        model: summaryRoute.model,
        status: "error",
        storageSeqRange: [storageSeq, storageSeq],
        toolNames: [],
        usage: null,
        ttftMs: null,
        turnMs: Date.now() - started,
        revisions: 0,
        wasteCause: null,
        systemHash: hashSystem("You compress coding-agent session history. Only output the structured handoff."),
      }),
    );
    if (!interrupted) out(`\n(summarization failed: ${(err as Error).message})\n`);
    return false;
  }
}

// ---- provider call (minimal SSE stream with usage capture) ----

type Block =
  | { type: "text"; text: string; citations?: unknown[] }
  | { type: "tool_use"; id: string; name: string; input: ToolUse["input"] }
  | { type: "server_tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "web_search_tool_result"; tool_use_id: string; content: unknown };

interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface CallResult {
  blocks: Block[];
  usage: Usage | null;
  ttftMs: number | null;
  stopReason: string | null;
}

let currentAbort: AbortController | null = null;

function endpointFor(auth: { providerId: ProviderId; baseUrl: string }): string {
  const base = auth.baseUrl.replace(/\/$/, "");
  const proto = providerProtocol(auth.providerId);
  if (proto === "anthropic-messages") return `${base}/v1/messages`;
  if (proto === "openai-codex-responses") {
    if (base.endsWith("/codex/responses")) return base;
    if (base.endsWith("/codex")) return `${base}/responses`;
    return `${base}/codex/responses`;
  }
  return `${base}/chat/completions`;
}

async function providerPost(providerId: ProviderId, body: unknown, signal: AbortSignal | undefined): Promise<Response> {
  let replayed = false;
  for (;;) {
    const auth = await resolveAuth(providerId);
    if (!auth.ok) throw new Error(auth.error);
    const headers = { ...auth.headers };
    if (body && typeof body === "object" && (body as { stream?: unknown }).stream === true) {
      headers.accept = "text/event-stream";
    }
    const res = await fetch(endpointFor(auth), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (res.status !== 401) return res;
    await res.text();
    if (auth.kind === "oauth" && !replayed) {
      const refreshed = await refreshOauth(providerId);
      if (!refreshed.ok) throw new Error(refreshed.error);
      replayed = true;
      continue;
    }
    throw new Error(auth.kind === "oauth" ? "auth expired — run /login" : "invalid API key");
  }
}

function normalizeUsage(u: Record<string, number> | undefined): Usage | null {
  if (!u) return null;
  const prompt = u.input_tokens ?? u.prompt_tokens ?? 0;
  const output = u.output_tokens ?? u.completion_tokens ?? 0;
  return {
    input: prompt,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output,
  };
}

async function completeText(
  providerId: ProviderId,
  model: string,
  system: string,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string; usage: Usage | null }> {
  const proto = providerProtocol(providerId);
  if (proto === "anthropic-messages") {
    const res = await providerPost(
      providerId,
      { model, max_tokens: 2048, system, messages: [{ role: "user", content: prompt }] },
      signal,
    );
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = (await res.json()) as { usage?: Record<string, number>; content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? []).map((c) => c.text ?? "").join("").trim();
    return { text, usage: normalizeUsage(data.usage) };
  }
  if (proto === "openai-codex-responses") {
    const res = await providerPost(
      providerId,
      { model, store: false, stream: false, instructions: system, input: prompt },
      signal,
    );
    if (!res.ok) throw new Error(`API ${res.status}`);
    const got = textFromResponsesPayload(await res.json());
    return { text: got.text, usage: normalizeUsage(got.usage) };
  }
  const res = await providerPost(
    providerId,
    {
      model,
      stream: false,
      ...(providerId === "openai" ? { max_completion_tokens: 2048 } : { max_tokens: 2048 }),
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    },
    signal,
  );
  if (!res.ok) throw new Error(`API ${res.status}`);
  const got = textFromCompletionPayload(await res.json());
  return { text: got.text, usage: normalizeUsage(got.usage) };
}

async function callModel(messages: Message[]): Promise<CallResult> {
  const started = Date.now();
  const prefix = buildCachedPrefix(systemPrompt(), TOOLS);
  const proto = providerProtocol(route.provider);
  const kernelMessages = messages.map((m) => ({ role: m.role, content: m.content }));
  const clientTools = TOOLS as ToolDef[];
  const body =
    proto === "anthropic-messages"
      ? {
          model: route.model,
          max_tokens: 8192,
          stream: true,
          cache_control: prefix.cache_control,
          system: prefix.system,
          tools: requestTools(prefix.tools, route.provider),
          messages: toRequest(messages),
        }
      : proto === "openai-codex-responses"
        ? responsesBody(route.model, systemPrompt(), kernelMessages, clientTools)
        : completionsBody(
            route.model,
            systemPrompt(),
            kernelMessages,
            clientTools,
            route.provider === "openai" ? "max_completion_tokens" : "max_tokens",
          );
  const res = await providerPost(route.provider, body, currentAbort?.signal);
  if (!res.ok || !res.body) {
    const detail = (await res.text()).slice(0, 300);
    const hint =
      proto === "anthropic-messages" && /web_search/i.test(detail)
        ? " — enable Web search in the Anthropic console"
        : "";
    throw new Error(`API ${res.status}: ${detail}${hint}`);
  }

  if (proto !== "anthropic-messages") {
    const events = await readSseJson(res.body, currentAbort?.signal);
    const parsed =
      proto === "openai-codex-responses"
        ? responsesResultFromEvents(events, (t) => out(t), started)
        : completionResultFromEvents(events, (t) => out(t), started);
    if (parsed.error) throw new Error(parsed.error);
    return {
      blocks: parsed.blocks as Block[],
      usage: parsed.usage,
      ttftMs: parsed.ttftMs,
      stopReason: parsed.stopReason,
    };
  }

  const slots: Array<Block | undefined> = [];
  const jsonParts = new Map<number, string>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | null = null;
  let ttftMs: number | null = null;
  let stopReason: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      switch (ev.type) {
        case "message_start": {
          const msg = (ev.message ?? {}) as { usage?: Record<string, number> };
          const u = msg.usage ?? {};
          usage = {
            input: u.input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            output: u.output_tokens ?? 0,
          };
          break;
        }
        case "content_block_start": {
          const idx = Number(ev.index);
          const cb = (ev.content_block ?? {}) as {
            type?: string;
            id?: string;
            name?: string;
            tool_use_id?: string;
            citations?: unknown[];
            content?: unknown;
          };
          if (cb.type === "tool_use") {
            placeStreamBlock(slots, idx, { type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: {} });
            jsonParts.set(idx, "");
          } else if (cb.type === "server_tool_use") {
            placeStreamBlock(slots, idx, {
              type: "server_tool_use",
              id: cb.id ?? "",
              name: cb.name ?? "",
              input: {},
            });
            jsonParts.set(idx, "");
          } else if (cb.type === "web_search_tool_result") {
            placeStreamBlock(slots, idx, {
              type: "web_search_tool_result",
              tool_use_id: cb.tool_use_id ?? "",
              content: cb.content,
            });
          } else if (cb.type === "text") {
            placeStreamBlock(slots, idx, {
              type: "text",
              text: "",
              citations: Array.isArray(cb.citations) && cb.citations.length > 0 ? cb.citations : undefined,
            });
          } else if (cb.type) {
            placeStreamBlock(slots, idx, { ...(ev.content_block as Block), type: cb.type } as Block);
          }
          break;
        }
        case "content_block_delta": {
          const d = ev.delta as { type: string; text?: string; partial_json?: string; citation?: unknown; thinking?: string };
          const idx = Number(ev.index);
          const target = slots[idx];
          if (!target) break;
          if (d.type === "text_delta" && target.type === "text") {
            if (ttftMs === null) ttftMs = Date.now() - started;
            target.text += d.text ?? "";
            out(d.text ?? "");
          } else if (d.type === "citations_delta" && target.type === "text" && d.citation !== undefined) {
            target.citations = [...(target.citations ?? []), d.citation];
          } else if (d.type === "thinking_delta" && "thinking" in target) {
            (target as { thinking?: string }).thinking = `${(target as { thinking?: string }).thinking ?? ""}${d.thinking ?? ""}`;
          } else if (
            d.type === "input_json_delta" &&
            (target.type === "tool_use" || target.type === "server_tool_use")
          ) {
            jsonParts.set(idx, (jsonParts.get(idx) ?? "") + (d.partial_json ?? ""));
          }
          break;
        }
        case "message_delta": {
          const u = (ev.usage ?? {}) as Record<string, number>;
          if (usage && typeof u.output_tokens === "number") usage.output = u.output_tokens;
          const reason = (ev.delta as { stop_reason?: string } | undefined)?.stop_reason;
          if (typeof reason === "string") stopReason = reason;
          break;
        }
        default:
          break;
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().startsWith("data:")) {
    const payload = buffer.trim().slice(5).trim();
    if (payload && payload !== "[DONE]") {
      try {
        const ev = JSON.parse(payload) as Record<string, unknown>;
        if (ev.type === "message_delta") {
          const u = (ev.usage ?? {}) as Record<string, number>;
          if (usage && typeof u.output_tokens === "number") usage.output = u.output_tokens;
          const reason = (ev.delta as { stop_reason?: string } | undefined)?.stop_reason;
          if (typeof reason === "string") stopReason = reason;
        }
      } catch {
        /* ignore truncated tail */
      }
    }
  }
  for (const [idx, part] of jsonParts) {
    const target = slots[idx];
    if (target?.type === "tool_use" || target?.type === "server_tool_use") {
      try {
        target.input = JSON.parse(part || "{}") as typeof target.input;
      } catch {
        target.input = {};
      }
    }
  }
  return { blocks: compactStreamBlocks(slots), usage, ttftMs, stopReason };
}

// ---- waste attribution ----

let prevPrompt: { total: number; ts: number } | null = null;
let revisions = 0;

// Providers bill tokens; prices come from a local catalog (models.dev),
// not from the API response. Rates are USD per token once divided.
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

let rateLookup: ((model: string) => Rates | null) | null = null;

async function loadRates(): Promise<void> {
  try {
    const res = await fetch("https://models.dev/api.json");
    const db = (await res.json()) as Record<string, { models?: Record<string, { cost?: Record<string, number> }> }>;
    const per = 1_000_000;
    rateLookup = (model: string): Rates | null => {
      const catalogId = route.provider === "openai-codex" ? "openai" : route.provider;
      const models = db[catalogId]?.models ?? {};
      const entry = models[model] ?? models[Object.keys(models).find((k) => k.startsWith(model + "-")) ?? ""];
      const c = entry?.cost;
      if (!c) return null;
      return {
        input: (c.input ?? 0) / per,
        output: (c.output ?? 0) / per,
        cacheRead: (c.cache_read ?? c.input ?? 0) / per,
        cacheWrite: (c.cache_write ?? c.input ?? 0) / per,
      };
    };
  } catch {
    /* offline or catalog gone: usage records carry tokens without usd */
  }
}

function reportUsage(
  usage: Usage,
  ttftMs: number | null,
  turnStarted: number,
): { cause: string | null; usd: number | null; turnMs: number; ttftMs: number | null; revisionCount: number } {
  const cur = usage.input + usage.cacheRead + usage.cacheWrite;
  let waste: { tokens: number; cause: string } | null = null;
  if (prevPrompt) {
    const missed = Math.min(prevPrompt.total, cur) - usage.cacheRead;
    if (missed > NOISE_FLOOR_TOKENS) {
      const gap = Date.now() - prevPrompt.ts;
      const cause = postRevision
        ? "post-revision"
        : gap > CACHE_TTL_MS
          ? "idle-expired"
          : "unexplained";
      waste = { tokens: missed, cause };
    }
  }
  postRevision = false;
  prevPrompt = { total: cur, ts: Date.now() };
  const rates = rateLookup?.(route.model) ?? null;
  let usd: number | null = null;
  if (rates) {
    usd =
      usage.input * rates.input +
      usage.output * rates.output +
      usage.cacheRead * rates.cacheRead +
      usage.cacheWrite * rates.cacheWrite;
  }
  const revisionCount = revisions;
  revisions = 0;
  return { cause: waste?.cause ?? null, usd, turnMs: Date.now() - turnStarted, ttftMs, revisionCount };
}

// ---- agent loop ----

let interrupted = false;

async function runPrompt(prompt: string): Promise<void> {
  if (!streamPrepared) ensureFreshSession();
  pushMessage("user", prompt);
  logEvent({ t: "agent_start", model: route.model, sessionFile, sessionId });
  running = true;
  showPrompt();
  interrupted = false;
  currentAbort = new AbortController();
  if (!rateLookup && !ratesFailed) void loadRates().then(() => { ratesFailed = true; });
  let retriedOverflow = false;
  let modelCalls = 0;
  let lastHadTools = false;
  let resumePaused = false;
  try {
    while (modelCalls < MAX_TURNS) {
      if (interrupted) break;
      if (!resumePaused) {
        reclaim();
        // Maintenance order: reclaim first; summarize only when reclamation cannot
        // hold the high-water line; truncate is the last resort.
        if (totalTokens() >= USABLE * HIGH_WATER && !(await summarize()) && totalTokens() >= USABLE) {
          truncate();
        }
      }
      resumePaused = false;
      let result: CallResult;
      const callStarted = Date.now();
      const seqBefore = storageSeq;
      try {
        result = await callModel(history);
      } catch (err) {
        // Emergency mid-turn revision: the provider
        // rejected the window; reclaim hard and retry exactly once.
        if (!retriedOverflow && /prompt is too long|maximum context|context_length/i.test(String((err as Error).message))) {
          retriedOverflow = true;
          reclaim();
          await summarize();
          truncate();
          result = await callModel(history);
        } else {
          writeTrace(
            traceRecord({
              role: "main",
              model: route.model,
              status: "error",
              storageSeqRange: [seqBefore + 1, storageSeq],
              toolNames: [],
              usage: null,
              ttftMs: null,
              turnMs: Date.now() - callStarted,
              revisions,
              wasteCause: null,
              systemHash: hashSystem(systemPrompt()),
            }),
          );
          throw err;
        }
      }
      modelCalls++;
      const sys = systemPrompt();
      const waste = result.usage
        ? reportUsage(result.usage, result.ttftMs, callStarted)
        : { cause: null, usd: null, turnMs: Date.now() - callStarted, ttftMs: result.ttftMs, revisionCount: 0 };
      const assistantMsg: Message = { role: "assistant", content: result.blocks as ContentBlock[], tokens: 0, sseq: 0 };
      assistantMsg.tokens = estimate(assistantMsg);
      history.push(assistantMsg);
      assistantMsg.sseq = store({ type: "message", message: { role: "assistant", content: result.blocks } });
      const serverNames = logServerSearch(result.blocks);
      const uses = (result.blocks.filter((b) => b.type === "tool_use") as Extract<Block, { type: "tool_use" }>[]).map(
        (b): ToolUse => ({ id: b.id, name: b.name, input: b.input }),
      );
      lastHadTools = uses.length > 0 || result.stopReason === "pause_turn";
      if (uses.length === 0) {
        writeTrace(
          traceRecord({
            role: "main",
            model: route.model,
            status: "ok",
            storageSeqRange: [seqBefore + 1, storageSeq],
            toolNames: serverNames,
            usage: result.usage,
            ttftMs: waste.ttftMs,
            turnMs: waste.turnMs,
            revisions: waste.revisionCount,
            wasteCause: waste.cause,
            systemHash: hashSystem(sys),
          }),
        );
        if (result.stopReason === "pause_turn" && !interrupted) {
          resumePaused = true;
          continue;
        }
        break;
      }
      const outcomes: ToolOutcome[] = [];
      for (let i = 0; i < uses.length; i += TOOL_CONCURRENCY) {
        if (interrupted) break;
        const chunk = uses.slice(i, i + TOOL_CONCURRENCY);
        for (const use of chunk) {
          logToolStart(use);
          out(`\n[${use.name}]\n`);
        }
        const chunkOutcomes = await Promise.all(chunk.map(executeTool));
        for (let ci = 0; ci < chunk.length; ci++) {
          logEvent({ t: "tool_end", toolCallId: chunk[ci]!.id, isError: chunkOutcomes[ci]!.isError });
        }
        outcomes.push(...chunkOutcomes);
      }
      // An interrupted turn must still answer the open tool calls, or the
      // stored pair breaks the next request.
      const answered = outcomes.length;
      for (let i = answered; i < uses.length; i++) {
        outcomes.push({ result: toolResult(uses[i]!, "(interrupted by user)"), isError: false });
        logEvent({ t: "tool_end", toolCallId: uses[i]!.id, isError: false });
      }
      const resultBlocks = outcomes.map((o, i): ContentBlock => {
        const b = o.result as ContentBlock;
        b.chars = undefined;
        b.tool = uses[i]!.name;
        b.repro = reproFor(uses[i]!);
        return b;
      });
      pushMessage("user", resultBlocks);
      writeTrace(
        traceRecord({
          role: "main",
          model: route.model,
          status: "ok",
          storageSeqRange: [seqBefore + 1, storageSeq],
          toolNames: [...serverNames, ...uses.map((u) => u.name)],
          usage: result.usage,
          ttftMs: waste.ttftMs,
          turnMs: waste.turnMs,
          revisions: waste.revisionCount,
          wasteCause: waste.cause,
          systemHash: hashSystem(sys),
        }),
      );
      out("\n");
    }
    if (modelCalls >= MAX_TURNS && lastHadTools && !interrupted) {
      out(`\n(turn cap ${MAX_TURNS} reached this prompt)\n`);
    }
  } catch (err) {
    if (interrupted) out("\n(interrupted)\n");
    else out(`\nerror: ${(err as Error).message}\n`);
  } finally {
    running = false;
    currentAbort = null;
    showPrompt();
  }
  logEvent({ t: "agent_settled" });
  showPrompt();
}

// ---- session resume: replay the append-only log into a fresh view ----

/** Rebuild the context view from storage. Revision records address messages
 *  by stable sseq, so replay is order-independent and exact. */
function abortResume(message: string): void {
  out(`${message}\n`);
  history.length = 0;
  if (sessionFile && quarantineSessionFile(sessionFile)) {
    streamPrepared = false;
    return;
  }
  // Keep the original file. Do not truncate it on the next prompt.
  streamPrepared = true;
  storageSeq = 0;
}

function resumeSession(): void {
  if (!sessionFile || !existsSync(sessionFile)) {
    out("(no stored session)\n");
    return;
  }
  let text: string;
  try {
    const info = statSync(sessionFile);
    if (!info.isFile()) {
      out("(no stored session)\n");
      return;
    }
    if (info.size === 0) {
      out("(stored session is empty)\n");
      streamPrepared = false;
      return;
    }
    if (info.size > MAX_SESSION_FILE_BYTES) {
      abortResume("(resume failed: session file is too large)");
      return;
    }
    text = readFileSync(sessionFile, "utf8");
  } catch (err) {
    abortResume(`(resume failed: ${(err as Error).message})`);
    return;
  }
  const replayed = replaySessionRecords(text);
  if (!replayed.ok) {
    abortResume(`(resume failed: ${replayed.error})`);
    return;
  }
  if (replayed.messages.length === 0) {
    out("(stored session is empty)\n");
    streamPrepared = false;
    return;
  }
  history.length = 0;
  for (const rm of replayed.messages) {
    const m: Message = { role: rm.role, content: rm.content, tokens: 0, sseq: rm.sseq };
    m.tokens = estimate(m);
    history.push(m);
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i]!.content;
    if (typeof c === "string" && c.startsWith("<context-handoff>")) {
      lastHandoff = c.replace(/<\/?context-handoff>/g, "").trim();
      break;
    }
  }
  storageSeq = Math.max(storageSeq, replayed.maxSeq);
  streamPrepared = true;
  prevPrompt = null;
  out(`resumed ${history.length} messages\n`);
}

// ---- terminal surface ----

let surface: AgentTui | null = null;

function out(text: string): void {
  if (surface) surface.append(text);
  else process.stdout.write(text);
}

function showPrompt(): void {
  surface?.setBusy(running || authBusy);
  if (!surface) out("\n> ");
}

function printSlashHelp(): void {
  const width = Math.max(...SLASH_COMMANDS.map((c) => c.name.length));
  for (const c of SLASH_COMMANDS) out(`  ${c.name.padEnd(width)}  ${c.hint}\n`);
}

function printLoginPicker(cmd: "/login" | "/logout"): void {
  const items = loginPickerItems(cmd);
  const width = Math.max(...items.map((i) => i.label.length));
  out(cmd === "/login" ? "pick a provider:\n" : "pick a credential to drop:\n");
  for (const i of items) out(`  ${i.label.padEnd(width)}  ${i.hint}  ${i.command}\n`);
}

let running = false;
let queuedLine: string | null = null;
let ratesFailed = false;

function submit(line: string): void {
  if (running) {
    // Keep one typed-ahead prompt. More than one has no consumer yet.
    queuedLine = line;
    out("(queued — runs after the current task)\n");
    return;
  }
  // A rejected prompt promise must never kill the engine: the pty would
  // close and the terminal looks like it quit on the user.
  void runPrompt(line)
    .catch((err: unknown) => {
      out(`\nengine error: ${(err as Error).message}\n`);
      showPrompt();
    })
    .then(() => {
    if (queuedLine !== null) {
      const next = queuedLine;
      queuedLine = null;
      submit(next);
    }
  });
}

export function isDirectRunFrom(selfUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    const self = selfUrl.startsWith("file:") ? fileURLToPath(selfUrl) : selfUrl;
    return realpathSync(self) === realpathSync(argv1);
  } catch {
    return false;
  }
}

export function isDirectRun(): boolean {
  return isDirectRunFrom(import.meta.url, process.argv[1]);
}

let authBusy = false;
let loginCodeResolve: ((code: string) => void) | null = null;
let loginAbort: AbortController | null = null;

function cancelLogin(): void {
  loginAbort?.abort();
  if (loginCodeResolve) {
    loginCodeResolve("");
    loginCodeResolve = null;
  }
  surface?.setRawInput(false);
}

function retargetSummary(provider: ProviderId): void {
  if (process.env.TERMINA_CORE_SUMMARY_MODEL) return;
  summaryRoute = parseModelRef(DEFAULT_MODELS[provider].summary, provider);
}

async function loadCatalog(provider: ProviderId, adopt: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!catalogFetchAllowed()) return { ok: false, error: "catalog fetch skipped in tests" };
  if (adopt && provider !== route.provider) {
    route = { provider, model: DEFAULT_MODELS[provider].main };
    retargetSummary(provider);
    catalog = null;
  }
  if (provider !== route.provider) return { ok: true };
  const got = await loadProviderModels(provider);
  if (!got.ok) return got;
  catalog = got.models;
  const preferred =
    MODEL_ENV && route.provider === parseModelRef(MODEL_ENV, PROVIDER_ENV || undefined).provider
      ? route.model
      : DEFAULT_MODELS[provider].main;
  const pick = pickDefaultModel(catalog, preferred);
  if (pick) {
    if (!PINNED_ROUTE || !MODEL_ENV) route.model = pick;
    else if (pick === route.model || pick.startsWith(`${route.model}-`)) route.model = pick;
  }
  return { ok: true };
}

async function bootCatalog(): Promise<void> {
  if (!catalogFetchAllowed()) return;
  try {
    if (!PINNED_ROUTE) {
      const id = firstAuthenticatedProvider();
      if (!id) return;
      route = { provider: id, model: DEFAULT_MODELS[id].main };
      retargetSummary(id);
    }
    const auth = await resolveAuth(route.provider);
    if (!auth.ok) return;
    await loadCatalog(route.provider, false);
  } catch (err) {
    process.stderr.write(`agent-core: model list failed: ${(err as Error).message}\n`);
  }
}

function startCatalogCommand(line: string): void {
  if (line === "/model") {
    out(`model ${route.provider}/${route.model}\n`);
    showPrompt();
    return;
  }
  if (line === "/models" || line.startsWith("/models ")) {
    if (running || authBusy) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    const refresh = /\brefresh\b/.test(line);
    authBusy = true;
    showPrompt();
    void (async () => {
      try {
        if (refresh || !catalog) {
          const got = await loadCatalog(route.provider, false);
          if (!got.ok) out(`(${got.error})\n`);
        }
        if (catalog && catalog.length > 0) out(`${formatModelLines(catalog, route.model)}\n`);
        else out("(no model list — run /login)\n");
      } finally {
        authBusy = false;
        showPrompt();
      }
    })();
    return;
  }
  if (!line.startsWith("/model ")) return;
  if (running || authBusy) {
    out("(engine busy)\n");
    showPrompt();
    return;
  }
  const rest = line.slice("/model ".length).trim();
  if (!rest) {
    out(`model ${route.provider}/${route.model}\n`);
    showPrompt();
    return;
  }
  authBusy = true;
  showPrompt();
  void (async () => {
    try {
      if (catalog?.some((m) => m.id === rest)) {
        route.model = rest;
        out(`model ${route.provider}/${route.model}\n`);
        syncStatus();
        return;
      }
      const next = parseModelSwitch(rest, route.provider);
      const auth = await resolveAuth(next.provider);
      if (!auth.ok) {
        out(`(${auth.error})\n`);
        return;
      }
      if (next.provider !== route.provider) {
        const got = await loadCatalog(next.provider, true);
        if (!got.ok) out(`(${got.error})\n`);
        if (catalog?.some((m) => m.id === next.model || m.id.startsWith(`${next.model}-`))) {
          const pick = pickDefaultModel(catalog, next.model);
          if (pick) route.model = pick;
        } else {
          route.model = next.model;
        }
      } else {
        route.model = next.model;
      }
      out(`model ${route.provider}/${route.model}\n`);
      syncStatus();
    } finally {
      authBusy = false;
      showPrompt();
    }
  })();
}

function startAuthCommand(line: string): void {
  const parsed = parseAuthCommand(line);
  if ("error" in parsed) {
    out(`(${parsed.error})\n`);
    showPrompt();
    return;
  }
  if (parsed.cmd === "logout") {
    const result = runLogout(parsed.provider);
    if (result.ok && parsed.provider === route.provider) catalog = null;
    out(result.ok ? `${result.summary}\n` : `(${result.error})\n`);
    if (result.ok) syncStatus("");
    showPrompt();
    return;
  }
  authBusy = true;
  showPrompt();
  loginAbort = new AbortController();
  const abort = loginAbort;
  void runLogin(parsed.provider, parsed.mode, {
    write: (text) => out(text),
    waitForCode: () => {
      surface?.setRawInput(true);
      return new Promise<string>((resolve) => {
        loginCodeResolve = (code) => {
          surface?.setRawInput(false);
          resolve(code);
        };
      });
    },
    signal: abort.signal,
  })
    .then(async (result) => {
      out(result.ok ? `${result.summary}\n` : `(${result.error})\n`);
      if (!result.ok) return;
      if (!isSupportedProvider(parsed.provider)) return;
      const got = await loadCatalog(parsed.provider, !PINNED_ROUTE);
      if (route.provider !== parsed.provider) return;
      if (!got.ok) out(`(${got.error})\n`);
      else if (catalog && catalog.length > 0) out(`${formatModelBanner(catalog, route.model)}\n`);
      const nextAuth = await resolveAuth(route.provider);
      syncStatus(nextAuth.ok ? authBanner(nextAuth) : undefined);
    })
    .catch((err: unknown) => {
      out(`(login failed: ${(err as Error).message})\n`);
    })
    .finally(() => {
      if (loginAbort === abort) {
        loginAbort = null;
        loginCodeResolve = null;
        authBusy = false;
      }
      showPrompt();
    });
}

function syncStatus(authText?: string): void {
  surface?.setStatus({
    model: `${route.provider}/${route.model}`,
    auth: authText,
  });
}

function dispatchLine(line: string): void {
  if (!line) {
    showPrompt();
    return;
  }
  if (line === "/exit" || line === "/quit") {
    currentAbort?.abort();
    cancelLogin();
    process.exit(0);
  }
  if (loginCodeResolve) {
    const resolve = loginCodeResolve;
    loginCodeResolve = null;
    resolve(line);
    return;
  }
  if (line === "/help") {
    printSlashHelp();
    showPrompt();
    return;
  }
  if (line === "/login" || line === "/logout") {
    if (running || authBusy) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    printLoginPicker(line);
    showPrompt();
    return;
  }
  if (line.startsWith("/login ") || line.startsWith("/logout ")) {
    if (running || authBusy) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    startAuthCommand(line);
    return;
  }
  if (line === "/models" || line.startsWith("/models ") || line === "/model" || line.startsWith("/model ")) {
    startCatalogCommand(line);
    return;
  }
  if (line === "/resume") {
    if (running || authBusy) out("(engine busy)\n");
    else if (history.length > 0) out("(session already live — /resume only on a fresh engine)\n");
    else resumeSession();
    showPrompt();
    return;
  }
  if (line.startsWith("/")) {
    out(`(unknown command: ${line} — type /help)\n`);
    showPrompt();
    return;
  }
  submit(line);
  showPrompt();
}

async function main(): Promise<void> {
  resetTraces();
  freezeFrontMatter();
  await bootCatalog();
  const auth = await resolveAuth(route.provider);
  const banner = `termina agent-core v1 · model ${route.provider}/${route.model} · ${authBanner(auth)} · Ctrl+C interrupts · /exit quits\n`;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    surface = new AgentTui({
      stdin: process.stdin,
      stdout: process.stdout,
      commands: SLASH_COMMANDS,
      onSubmit: (line) => {
        try {
          dispatchLine(line);
        } catch (err) {
          out(`\nengine error: ${(err as Error).message}\n`);
        }
      },
      onInterrupt: () => {
        if (running) {
          interrupted = true;
          currentAbort?.abort();
        } else if (authBusy) cancelLogin();
      },
      onExit: () => {
        currentAbort?.abort();
        cancelLogin();
        surface?.stop();
        surface = null;
        process.exit(0);
      },
    });
    const teardown = (): void => {
      surface?.stop();
      surface = null;
    };
    process.on("exit", teardown);
    process.on("SIGTERM", () => {
      teardown();
      process.exit(0);
    });
    process.on("SIGHUP", () => {
      teardown();
      process.exit(0);
    });
    surface.setStatus({ model: `${route.provider}/${route.model}`, auth: authBanner(auth) });
    if (!surface.start()) surface = null;
  }
  if (!surface) out(banner);
  if (catalog && catalog.length > 0) out(`${formatModelBanner(catalog, route.model)}\n`);
  if (process.env.TERMINA_CORE_RESUME === "1") resumeSession();
  showPrompt();
}

if (isDirectRun()) {
  void main();
}
