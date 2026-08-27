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
 * - cwd jail; grep/glob; unique edit; interruptible bash; web_search; skill index; prefix cache_control; traces
 * - last tool_result cache pin (Anthropic); OpenAI/Codex prompt_cache_key; 429 retry; opt-in thinking
 * - provider auth (Anthropic, OpenAI, ChatGPT Codex, xAI, Google, OpenRouter)
 */
import { execFileSync, spawn } from "node:child_process";
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
import { createInterface } from "node:readline";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_PROVIDER_ORDER,
  authBanner,
  DEFAULT_MODELS,
  firstAuthenticatedProvider,
  hasEnvCredential,
  hasStoredCredential,
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
  formatCatalogLines,
  formatModelBanner,
  loadProviderModels,
  parseModelSwitch,
  pickDefaultModel,
  type CatalogModel,
  type ModelInfo,
} from "./models.ts";
import { IGNORED_SEGMENTS, matchGitignore, parseGitignore, type GitignoreRules } from "../shared/gitignore.ts";
import {
  consumePendingImages,
  consumeStartupControl,
  expandFileImageSource,
  planTextIfChanged,
  loadImageFromRoots,
  peekPendingImageCount,
  persistLoadedImages,
  promptFileName,
  readContextFiles,
  removePendingImageFiles,
  structuredStartup,
  visibleAssistantText,
  waitForAck,
  writePromptPayload,
} from "./host.ts";
import { MAX_SESSION_FILE_BYTES, rotateSessionFile } from "./session.ts";
import {
  jailMcpCwd,
  loadMcpConfigs,
  mergeClientTools,
  mcpToolDefs,
  startMcp,
  userMcpPath,
  type McpSession,
} from "./mcp.ts";

export { MAX_SESSION_FILE_BYTES, copySessionImageFiles, rotateSessionFile, sessionRotateStamp, sliceSessionText, writeForkedSession } from "./session.ts";
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
const catalogs = new Map<ProviderId, ModelInfo[]>();
const OUTPUT_RESERVE = 16_384;
/** Example starting values; never spec constants. Thinking counts against max_tokens. */
const THINK_BUDGET = 8_000;
const OUTPUT_CAP = 16_384;
const HIGH_WATER = 0.8;
const LOW_WATER = 0.6;
/** Trailing tool-output span never reclaimed (fraction of usable, clamped). */
const PROTECT_MIN = 4_000;
const PROTECT_MAX = 40_000;

function contextWindow(): number {
  const env = Number(process.env.TERMINA_CORE_CONTEXT ?? "");
  if (Number.isFinite(env) && env >= 8_000) return env;
  const hit = catalogs.get(route.provider)?.find((m) => m.id === route.model);
  if (hit?.context && hit.context >= 8_000) return hit.context;
  return route.provider === "anthropic" ? 200_000 : 128_000;
}

function usableTokens(): number {
  return Math.max(8_000, contextWindow() - OUTPUT_RESERVE);
}

function protectTokens(): number {
  return Math.min(PROTECT_MAX, Math.max(PROTECT_MIN, Math.floor(usableTokens() * 0.25)));
}
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
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_CAP_BYTES = 20 * 1024;
const FETCH_REDIRECT_CAP = 5;
const GLOB_HIT_CAP = 200;
const TRACE_CAP = 64;
const LISTING_CAP = 20;
const PROBE_TIMEOUT_MS = 500;
const EDIT_MAX_BYTES = 8 * 1024 * 1024;
const TOOL_DISPLAY_BYTES = 2 * 1024;

export function parsePrintPrompt(argv: string[]): string | null {
  const i = argv.findIndex((a) => a === "-p" || a === "--print");
  if (i < 0) return null;
  return argv.slice(i + 1).join(" ").trim();
}

export function parseMaxTurns(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 80;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 80;
  return n;
}

const MAX_TURNS = parseMaxTurns(process.env.TERMINA_CORE_MAX_TURNS);
let thinkingWanted = false;
let hostContextSnapshot = "";

export function thinkingEnabledFor(model: string, enabled: boolean): boolean {
  if (!enabled) return false;
  const id = model.toLowerCase();
  return id.includes("claude") && !id.includes("haiku");
}

export function outputTokenBudget(opts: { thinking: boolean }): number {
  return opts.thinking ? THINK_BUDGET + OUTPUT_CAP : OUTPUT_CAP;
}

export function parseThinkingCommand(
  line: string,
): { show: true } | { enabled: boolean } | { error: string } | null {
  if (line !== "/thinking" && !line.startsWith("/thinking ")) return null;
  const rest = line.slice("/thinking".length).trim().toLowerCase();
  if (!rest) return { show: true };
  if (rest === "on") return { enabled: true };
  if (rest === "off") return { enabled: false };
  return { error: "use /thinking on or /thinking off" };
}

function thinkingLevelFor(model: string): "on" | "off" {
  return thinkingEnabledFor(model, thinkingWanted) ? "on" : "off";
}

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

function posixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function gitignoreSkips(rules: GitignoreRules, rel: string, isDir: boolean): boolean {
  if (!rel || rel === ".") return false;
  if (matchGitignore(rules, rel)) return true;
  return isDir && matchGitignore(rules, `${rel}/x`);
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
  const gitignore: GitignoreRules = new Map();
  const classified = classifyWalkPath(start, root);
  if (!classified) return { files, hitCap: false, timedOut: false };
  if (classified.kind === "file") {
    const rel = posixRel(root, classified.real);
    if (rel && gitignoreSkips(gitignore, rel, false)) return { files, hitCap: false, timedOut: false };
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
    if (byName.has(".gitignore")) {
      try {
        gitignore.set(posixRel(root, dirReal), parseGitignore(readFileSync(join(dirReal, ".gitignore"), "utf8")));
      } catch {
        /* unreadable gitignore */
      }
    }
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
      const rel = posixRel(root, next.real);
      if (gitignoreSkips(gitignore, rel, next.kind === "dir")) continue;
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

function grepRipgrep(
  rg: string,
  root: string,
  searchAbs: string,
  pattern: string,
  glob: string | undefined,
  opts: { shouldStop?: () => boolean; budgetMs?: number },
): Promise<string> {
  const budgetMs = opts.budgetMs ?? GREP_BUDGET_MS;
  const relSearch = searchAbs === root ? "." : posixRel(root, searchAbs);
  const args = ["--color=never", "-n", "--no-heading", `--max-count=${GREP_HIT_CAP}`];
  if (glob) args.push("-g", glob);
  args.push("--", pattern, relSearch);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(rg, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve(`error: ${(err as Error).message}`);
      return;
    }
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let used = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (used >= GREP_BYTE_CAP) return;
      const piece = chunk.subarray(0, GREP_BYTE_CAP - used);
      chunks.push(piece);
      used += piece.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errChunks.length < 8) errChunks.push(chunk.subarray(0, 2 * 1024));
    });
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      const text = Buffer.concat(chunks).toString("utf8").replace(/\n+$/, "");
      if (code === 2) {
        const err = Buffer.concat(errChunks).toString("utf8").trim().slice(0, 300);
        resolve(err ? `error: ${err}` : "error: invalid regular expression");
        return;
      }
      if (!text) {
        resolve("(no matches)");
        return;
      }
      const lines = text.split("\n").slice(0, GREP_HIT_CAP);
      resolve(lines.join("\n"));
    };
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(kill, budgetMs);
    const poll = setInterval(() => {
      if (opts.shouldStop?.()) kill();
    }, 50);
    if (opts.shouldStop?.()) kill();
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(`error: ${e.message}`);
    });
    child.on("close", (code) => finish(code));
  });
}

export async function grepFiles(
  cwd: string,
  input: { pattern?: string; path?: string; glob?: string },
  opts?: { shouldStop?: () => boolean; budgetMs?: number; jsOnly?: boolean },
): Promise<string> {
  const pattern = input.pattern ?? "";
  const unsafe = validateGrepPattern(pattern);
  const root = freezeCwd(cwd);
  const confined = confinePath(cwd, input.path ?? ".", { mustExist: true });
  if (!confined.ok) return confined.error;
  if (input.glob) {
    if (input.glob.length < 1 || input.glob.length > 256) return "error: glob pattern length must be 1–256";
    if (/[\[\]{}]/.test(input.glob)) return "error: glob only supports * ** ?";
  }
  if (!opts?.jsOnly) {
    const rg = resolveTrustedBin("rg", root);
    if (rg) {
      if (pattern.length < 1 || pattern.length > 256) return unsafe ?? "error: pattern length must be 1–256";
      return grepRipgrep(rg, root, confined.abs, pattern, input.glob, opts ?? {});
    }
  }
  if (unsafe) return unsafe;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return "error: invalid regular expression";
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
    const giPath = join(root, ".gitignore");
    const listingRules: GitignoreRules = new Map();
    try {
      if (existsSync(giPath)) listingRules.set("", parseGitignore(readFileSync(giPath, "utf8")));
    } catch {
      /* listing still works without gitignore */
    }
    const names = sortUtf8(
      readdirSync(root).filter((n) => {
        if (n === "." || n === ".." || IGNORED_SEGMENTS.has(n)) return false;
        return !gitignoreSkips(listingRules, n, false) && !gitignoreSkips(listingRules, n, true);
      }),
    ).slice(0, LISTING_CAP);
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
    return { content: `ok: wrote ${confined.abs}`, isError: false };
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, isError: true };
  }
}

export type EditResult = {
  content: string;
  isError: boolean;
  edits?: Array<{ oldText: string; newText: string }>;
};

function isReplaceAll(value: unknown): boolean {
  return value === true || value === "true";
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
  if (!replaceAll) {
    let count = 0;
    let idx = 0;
    while (idx < body.length) {
      const at = body.indexOf(oldText, idx);
      if (at < 0) break;
      count++;
      if (count > 1) return { content: "error: old_text is not unique", isError: true };
      idx = at + oldText.length;
    }
    if (count === 0) return { content: "error: old_text not found", isError: true };
    const at = body.indexOf(oldText);
    const next = body.slice(0, at) + newText + body.slice(at + oldText.length);
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
    const at = next.indexOf(oldText, from);
    if (at < 0) break;
    next = next.slice(0, at) + newText + next.slice(at + oldText.length);
    from = at + newText.length;
    n++;
  }
  if (n === 0) return { content: "error: old_text not found", isError: true };
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
    old_text?: string;
    new_text?: string;
    [key: string]: unknown;
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
  if (use.name === "edit") return `edit(${JSON.stringify(use.input.path ?? "")})`;
  if (use.name === "grep") return `grep ${shellQuote(use.input.pattern ?? "")}`;
  if (use.name === "glob") return `glob ${shellQuote(use.input.pattern ?? "")}`;
  if (use.name === "web_search") return `web_search ${shellQuote(use.input.query ?? "")}`;
  if (use.name === "fetch") return `fetch ${shellQuote(String(use.input.url ?? ""))}`;
  return undefined;
}

export function sidecarStartFor(use: {
  name: string;
  id: string;
  input: { path?: string; old_text?: string; new_text?: string; replace_all?: unknown };
}): Record<string, unknown> {
  if (use.name === "write_file") {
    return { t: "tool", toolName: "write", path: use.input.path, toolCallId: use.id };
  }
  if (use.name === "edit") {
    const start: Record<string, unknown> = {
      t: "tool",
      toolName: "edit",
      path: use.input.path,
      toolCallId: use.id,
    };
    if (!isReplaceAll(use.input.replace_all)) {
      start.edits = [{ oldText: use.input.old_text ?? "", newText: use.input.new_text ?? "" }];
    }
    return start;
  }
  return { t: "tool", toolName: use.name, toolCallId: use.id };
}

export function formatToolAnnounce(use: ToolUse): string {
  if (use.name === "edit" || use.name === "write_file" || use.name === "read_file") {
    return `[${use.name} ${use.input.path ?? ""}]`;
  }
  if (use.name === "bash") return `[bash] ${use.input.command ?? ""}`;
  if (use.name === "grep") return `[grep ${use.input.pattern ?? ""}]`;
  if (use.name === "glob") return `[glob ${use.input.pattern ?? ""}]`;
  if (use.name === "fetch") return `[fetch ${String(use.input.url ?? "")}]`;
  return `[${use.name}]`;
}

function capDisplay(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(buf.length - maxBytes).toString("utf8");
}

export function formatToolFollowup(use: ToolUse, outcome: { result: Record<string, unknown>; isError: boolean }): string {
  const content = typeof outcome.result.content === "string" ? outcome.result.content : "";
  if (use.name === "bash") {
    const shown = capDisplay(content, TOOL_DISPLAY_BYTES);
    return shown ? `${shown}\n` : "";
  }
  if (outcome.isError) return content ? `${content}\n` : "";
  if (use.name === "grep" || use.name === "glob") {
    if (content === "(no matches)") return `${content}\n`;
    const n = content === "" ? 0 : content.split("\n").length;
    return `(${n} ${use.name === "grep" ? "hits" : "files"})\n`;
  }
  return "";
}

export function runBash(
  command: string,
  opts: { cwd: string; timeoutMs?: number; shouldStop?: () => boolean },
): Promise<{ content: string; isError: boolean }> {
  const timeoutMs = opts.timeoutMs ?? BASH_TIMEOUT_MS;
  const repro = `bash ${shellQuote(command)}`;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/bash", ["-c", command], {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ content: `error: ${(err as Error).message}`, isError: true });
      return;
    }
    const pid = child.pid;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    const takeTail = (tail: Buffer, chunk: Buffer): Buffer => {
      const next = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
      const cap = BASH_CAP_BYTES + 1;
      return next.length <= cap ? next : next.subarray(next.length - cap);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = takeTail(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = takeTail(stderr, chunk);
    });
    let settled = false;
    const killGroup = (): void => {
      if (typeof pid === "number") {
        try {
          process.kill(-pid, "SIGKILL");
          return;
        } catch {
          /* fall through to the child handle */
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const finish = (err: { code?: number | null; signal?: string | null } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      const parts = [stdout.toString("utf8"), stderr.toString("utf8")];
      let failed = false;
      if (err) {
        failed = true;
        parts.push(`[exit ${typeof err.code === "number" ? err.code : err.signal ?? "error"}]`);
      }
      resolve({
        content: capTail(parts.filter(Boolean).join("\n") || "(no output)", BASH_CAP_BYTES, repro),
        isError: failed,
      });
    };
    const timer = setTimeout(killGroup, timeoutMs);
    const poll = setInterval(() => {
      if (opts.shouldStop?.()) killGroup();
    }, 50);
    if (opts.shouldStop?.()) killGroup();
    child.on("error", (e) => finish({ signal: e.message }));
    child.on("close", (code, signal) => {
      if (code === 0 && !signal) finish(null);
      else finish({ code, signal });
    });
  });
}

export function fetchUrlError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "error: invalid URL";
  }
  if (parsed.protocol === "https:") return null;
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol === "http:" && loopback && process.env.TERMINA_CORE_TEST === "1") return null;
  if (parsed.protocol === "http:") return "error: only https URLs are allowed";
  return `error: URL scheme not allowed: ${parsed.protocol}`;
}

export async function fetchUrl(
  url: string,
  opts?: { shouldStop?: () => boolean; timeoutMs?: number },
): Promise<{ content: string; isError: boolean }> {
  const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = url;
  for (let hop = 0; hop <= FETCH_REDIRECT_CAP; hop++) {
    const bad = fetchUrlError(current);
    if (bad) return { content: bad, isError: true };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const poll = setInterval(() => {
      if (opts?.shouldStop?.()) ac.abort();
    }, 50);
    if (opts?.shouldStop?.()) ac.abort();
    try {
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: ac.signal,
        headers: { accept: "text/*, application/json, application/xml;q=0.9, */*;q=0.1" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        try {
          await res.arrayBuffer();
        } catch {
          /* drain */
        }
        if (!loc) return { content: "error: redirect without location", isError: true };
        current = new URL(loc, current).href;
        continue;
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        return { content: `error: HTTP ${res.status}${detail ? `: ${detail}` : ""}`, isError: true };
      }
      if (!res.body) return { content: "", isError: false };
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let used = 0;
      let truncated = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (used >= FETCH_CAP_BYTES) {
          truncated = true;
          await reader.cancel();
          break;
        }
        const piece = chunk.subarray(0, FETCH_CAP_BYTES - used);
        chunks.push(piece);
        used += piece.length;
        if (chunk.length > piece.length) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const repro = `fetch ${shellQuote(url)}`;
      return {
        content: truncated
          ? `${text}\n[truncated at ${FETCH_CAP_BYTES} bytes — reproduce: ${repro}]`
          : text,
        isError: false,
      };
    } catch (err) {
      const msg = (err as Error).name === "AbortError" || /aborted/i.test((err as Error).message)
        ? (opts?.shouldStop?.() ? "error: interrupted" : "error: timed out")
        : `error: ${(err as Error).message}`;
      return { content: msg, isError: true };
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
    }
  }
  return { content: "error: too many redirects", isError: true };
}

let approveAll = process.env.TERMINA_CORE_APPROVE === "all";
let approvalResolve: ((line: string) => void) | null = null;

async function confirmBash(command: string): Promise<boolean> {
  if (approveAll || !surface?.active()) return true;
  out(`\napprove bash?\n  ${command}\n  [y] yes  [n] no  [a] always this session\n`);
  surface.setRawInput(true);
  const line = await new Promise<string>((resolve) => {
    approvalResolve = resolve;
  });
  approvalResolve = null;
  surface.setRawInput(false);
  const ans = line.trim().toLowerCase();
  if (ans === "a" || ans === "always") {
    approveAll = true;
    return true;
  }
  return ans === "y" || ans === "yes";
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
  if (use.name === "edit") {
    const got = editProjectFile(
      canonicalCwd,
      use.input.path,
      use.input.old_text ?? "",
      use.input.new_text ?? "",
      isReplaceAll(use.input.replace_all),
    );
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
  if (use.name === "fetch") {
    const got = await fetchUrl(String(use.input.url ?? ""), { shouldStop: () => interrupted });
    return done(use, got.content, got.isError);
  }
  if (use.name === "bash") {
    const command = use.input.command ?? "";
    if (!(await confirmBash(command))) return done(use, "error: bash denied", true);
    const got = await runBash(command, { cwd: canonicalCwd, shouldStop: () => interrupted });
    return done(use, got.content, got.isError);
  }
  if (mcpSession?.tools.some((t) => t.name === use.name)) {
    const got = await mcpSession.call(use.name, use.input, { shouldStop: () => interrupted });
    return done(use, got.content, got.isError);
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
    name: "edit",
    description:
      "Replace old_text with new_text in a file. Default: one unique occurrence (fails if missing or repeated). Set replace_all to replace every occurrence. Prefer this over write_file for existing files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "grep",
    description: "Search file contents with a regular expression. Uses ripgrep when available. Caps hits and skips ignored directories.",
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
  {
    name: "fetch",
    description: "Fetch an https URL. Output caps near 20 KB. No file or data URLs.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
];

let clientTools: Array<Record<string, unknown>> = TOOLS.slice();
let mcpSession: McpSession | null = null;

async function connectMcp(): Promise<void> {
  mcpSession?.shutdown();
  mcpSession = null;
  clientTools = TOOLS.slice();
  const session = await startMcp(loadMcpConfigs(userMcpPath(homedir())), {
    projectRoot: canonicalCwd,
    confineCwd: (cwd) => jailMcpCwd(canonicalCwd, cwd),
  });
  mcpSession = session;
  clientTools = mergeClientTools(TOOLS, mcpToolDefs(session.tools));
  for (const note of session.notes) out(`(${note})\n`);
}

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

/** Stamp cache_control on a copy of the last tool_result. Do not mutate input. */
export function stampHistoryCache(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!Array.isArray(m.content)) continue;
    const blocks = m.content as Array<Record<string, unknown>>;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]!;
      if (b.type !== "tool_result") continue;
      const next = messages.slice();
      const copied = blocks.slice();
      copied[j] = { ...b, cache_control: { type: "ephemeral" as const } };
      next[i] = { ...m, content: copied };
      return next;
    }
  }
  return messages;
}

const RETRY_STATUSES = new Set([429, 529, 500, 502, 503]);
const RETRY_AFTER_CAP_S = 10;

/** Milliseconds to wait, or null when this status/attempt must not retry. */
export function retryAfter(
  status: number,
  headers: { get(name: string): string | null },
  attempt: number,
): number | null {
  if (attempt >= 2) return null;
  if (!RETRY_STATUSES.has(status)) return null;
  const raw = headers.get("retry-after");
  if (raw !== null && raw !== "") {
    const secs = Number(raw);
    if (Number.isInteger(secs) && secs >= 0 && secs <= RETRY_AFTER_CAP_S) return secs * 1000;
  }
  return attempt === 0 ? 1_000 : 2_000;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  if (b.type === "thinking" || b.type === "redacted_thinking") {
    return String((b as { thinking?: string }).thinking ?? JSON.stringify(b)).length;
  }
  if (b.type === "image") return 8_000;
  return 0;
}

function isThinkingBlock(b: { type?: string }): boolean {
  return b.type === "thinking" || b.type === "redacted_thinking";
}

function isUserPrompt(m: { role: string; content: unknown }): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return Array.isArray(m.content) && m.content.some((b) => {
    if (!b || typeof b !== "object") return false;
    const type = (b as { type?: unknown }).type;
    return type === "text" || type === "image";
  });
}

function estimate(m: Message): number {
  if (typeof m.content === "string") return tokenEstimate(m.content) + 4;
  let sum = 4;
  for (const b of m.content) {
    if (b.type === "image") {
      sum += 8_010;
      continue;
    }
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
 *  included) make the provider reject the whole request. File images
 *  expand to base64 at request time. */
export function toProviderBlock(b: ContentBlock, imageRoots: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { type: b.type };
  for (const [k, v] of Object.entries(b)) {
    if (k === "type" || VIEW_KEYS.has(k) || v === undefined) continue;
    out[k] = v;
  }
  if (b.type === "image" && out.source && typeof out.source === "object" && !Array.isArray(out.source)) {
    const expanded = expandFileImageSource(out.source as Record<string, unknown>, imageRoots);
    if (expanded) out.source = expanded;
    else return { type: "text", text: "[image missing]" };
  }
  return out;
}

export function toRequest(messages: Message[], imageRoots: string[] = []): Array<{ role: string; content: unknown }> {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const content = m.content
      .map((b) => toProviderBlock(b, imageRoots))
      .filter((b) => b.type !== "thinking" || typeof b.signature === "string");
    return { role: m.role, content };
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

function pushUserPrompt(prompt: string, images: Array<{ name: string; mediaType: string }>): Message {
  if (images.length === 0) return pushMessage("user", prompt);
  return pushMessage("user", [
    { type: "text", text: prompt },
    ...images.map((img) => ({
      type: "image",
      source: { type: "file", name: img.name, media_type: img.mediaType },
    })),
  ]);
}

// ---- reclamation with hysteresis ----

export type PruneAction = "stub" | "drop";
export type PrunePick = { msgIndex: number; blockIndex: number; action: PruneAction };

/** Pure planner: pick the oldest prunable tool results and thinking outside
 *  the protected recency window until the projected total falls under the
 *  low-water mark. */
export function planPruneStubs(
  messages: Array<{ role: string; content: unknown; tokens: number }>,
  opts: { systemTokens: number; usable: number; protectTokens: number; fillTokens?: number },
): PrunePick[] {
  const historyTotal =
    opts.systemTokens +
    messages.reduce((sum, m) => sum + m.tokens, 0);
  const fill = opts.fillTokens ?? historyTotal;
  // Hysteresis lives on the fill level: act at the high-water mark, reclaim
  // down to the low-water mark. Between the marks: do nothing.
  if (fill < opts.usable * HIGH_WATER) return [];
  const quota = historyTotal - opts.usable * LOW_WATER;
  if (quota <= 0) return [];

  // Walk from the newest message backwards marking the protected span: the
  // last PROTECT_TURNS user prompts plus PROTECT_TOKENS of context.
  const protectedIdx = new Set<number>();
  let seen = 0;
  let guarded = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    protectedIdx.add(i);
    guarded += m.tokens;
    if (isUserPrompt(m)) {
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

  // Oldest-first selection among unprotected bulky tool results and thinking.
  const picks: PrunePick[] = [];
  let reclaimed = 0;
  for (let i = 0; i < messages.length && reclaimed < quota; i++) {
    if (protectedIdx.has(i)) continue;
    const m = messages[i]!;
    if (typeof m.content === "string") continue;
    const blocks = m.content as ContentBlock[];
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      if (reclaimed >= quota) break;
      const b = blocks[blockIndex]!;
      const chars = blockChars(b);
      if (chars < PRUNE_MIN_CHARS) continue;
      if (isThinkingBlock(b)) {
        if (blocks.filter((x) => !isThinkingBlock(x)).length === 0) continue;
        picks.push({ msgIndex: i, blockIndex, action: "drop" });
        reclaimed += Math.ceil(chars / 4);
        continue;
      }
      if (b.type !== "tool_result" || b.stubbed) continue;
      picks.push({ msgIndex: i, blockIndex, action: "stub" });
      reclaimed += Math.ceil(chars / 4);
    }
  }
  return picks;
}

export type ReplayMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  sseq: number;
};

function isReplayContent(content: unknown): content is ReplayMessage["content"] {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.every((block) => {
    return Boolean(block) && typeof block === "object" && !Array.isArray(block) && typeof (block as { type?: unknown }).type === "string";
  });
}

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
      targets?: Array<{ sseq: number; blockIndex: number; action?: string }>;
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
      if (!isReplayContent(e.message.content)) return { ok: false, error: "invalid message content" };
      const m: ReplayMessage = { role: e.message.role, content: e.message.content, sseq: e.storageSeq };
      messages.push(m);
      bySeq.set(m.sseq, m);
    } else if (e.type === "revision" && e.kind === "prune" && Array.isArray(e.targets)) {
      const ordered = e.targets.slice().sort((a, b) => {
        const as = a?.sseq ?? 0;
        const bs = b?.sseq ?? 0;
        if (as !== bs) return as - bs;
        return (b?.blockIndex ?? 0) - (a?.blockIndex ?? 0);
      });
      for (const t of ordered) {
        if (!t || !Number.isInteger(t.sseq) || t.sseq < 1 || !Number.isInteger(t.blockIndex) || t.blockIndex < 0) {
          return { ok: false, error: "invalid prune target" };
        }
        const m = bySeq.get(t.sseq);
        if (!m || typeof m.content === "string") continue;
        const action = t.action === "drop" ? "drop" : "stub";
        if (action === "drop") {
          const b = m.content[t.blockIndex] as ContentBlock | undefined;
          if (!b || !isThinkingBlock(b)) continue;
          if (m.content.filter((x) => !isThinkingBlock(x as ContentBlock)).length === 0) continue;
          m.content.splice(t.blockIndex, 1);
          continue;
        }
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
      if (!Number.isInteger(e.dropped) || e.dropped < 0 || e.dropped > messages.length) {
        return { ok: false, error: "invalid truncate revision" };
      }
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
let lastBilledTokens: number | null = null;

/** Apply the planner to the live view. Storage already holds the originals. */
function reclaim(): number {
  const plan = planPruneStubs(
    history.map((m) => ({ role: m.role, content: m.content, tokens: m.tokens })),
    {
      systemTokens: tokenEstimate(systemPrompt()),
      usable: usableTokens(),
      protectTokens: protectTokens(),
      fillTokens: lastBilledTokens ?? undefined,
    },
  );
  let changed = 0;
  const targets: Array<{ sseq: number; blockIndex: number; action: PruneAction }> = [];
  const touched = new Set<number>();
  const ordered = plan.slice().sort((a, b) => a.msgIndex - b.msgIndex || b.blockIndex - a.blockIndex);
  for (const pick of ordered) {
    const m = history[pick.msgIndex]!;
    if (typeof m.content === "string") continue;
    const blocks = m.content as ContentBlock[];
    const b = blocks[pick.blockIndex];
    if (!b) continue;
    if (pick.action === "drop") {
      if (!isThinkingBlock(b)) continue;
      if (blocks.filter((x) => !isThinkingBlock(x)).length === 0) continue;
      blocks.splice(pick.blockIndex, 1);
      changed++;
      touched.add(pick.msgIndex);
      targets.push({ sseq: m.sseq, blockIndex: pick.blockIndex, action: "drop" });
      continue;
    }
    if (b.type !== "tool_result" || b.stubbed) continue;
    const c = blockChars(b);
    if (c < PRUNE_MIN_CHARS) continue;
    const stub = formatStub({ chars: c, tool: b.tool ?? "tool", sseq: m.sseq, repro: b.repro });
    (b as unknown as { content: string }).content = stub;
    b.chars = stub.length;
    b.stubbed = true;
    changed++;
    touched.add(pick.msgIndex);
    targets.push({ sseq: m.sseq, blockIndex: pick.blockIndex, action: "stub" });
  }
  for (const i of touched) history[i]!.tokens = estimate(history[i]!);
  if (changed > 0) {
    postRevision = true;
    revisions++;
    store({ type: "revision", kind: "prune", targets });
  }
  return changed;
}

/** Last resort when reclamation alone cannot fit the window: drop whole old
 *  turns, cutting only at real prompts. Storage keeps every dropped byte. */
function truncate(): boolean {
  let total = totalTokens();
  if (total < usableTokens()) return false;
  let cut = 0;
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (isUserPrompt(m)) cut = i;
    total -= m.tokens;
    if (i === cut && total < usableTokens() * LOW_WATER) break;
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
    if (isUserPrompt(history[i]!)) {
      seen++;
      if (seen >= PROTECT_TURNS && guarded >= Math.min(protectTokens(), usableTokens() / 4)) break;
    }
  }
  // The tail must start at a real prompt; walk forward past orphan results.
  while (
    boundary < history.length &&
    !isUserPrompt(history[boundary]!)
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
const INVENTORY_CAP = 40;

function formatInventoryTag(tag: string, names: Set<string>): string {
  const list = [...names];
  const shown = list.slice(0, INVENTORY_CAP);
  const omitted = list.length - shown.length;
  const extra = omitted > 0 ? `\n<!-- ${omitted} paths omitted -->` : "";
  return `<${tag}>\n${shown.join("\n")}${extra}\n</${tag}>`;
}

function fileInventories(messages: Array<{ role: string; content: unknown }>): string {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as ContentBlock[]) {
      if (b.type !== "tool_use") continue;
      const input = (b as { input?: { path?: string } }).input;
      if (!input?.path) continue;
      if (b.name === "read_file") read.add(input.path);
      if (b.name === "write_file" || b.name === "edit") modified.add(input.path);
    }
  }
  const sections: string[] = [];
  if (read.size > 0) sections.push(formatInventoryTag("read-files", read));
  if (modified.size > 0) sections.push(formatInventoryTag("modified-files", modified));
  return sections.join("\n");
}

/** Request-only working set. Not stored in session JSONL. */
export function formatOverlay(opts: {
  messages: Array<{ role: string; content: unknown }>;
  hostContext?: string;
}): string {
  const inventories = fileInventories(opts.messages);
  const host = (opts.hostContext ?? "").trim();
  if (!inventories && !host) return "";
  const parts = ["<working-set>"];
  if (inventories) parts.push(inventories);
  if (host) parts.push(host);
  parts.push("</working-set>");
  return parts.join("\n");
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
    const handoffBody = `${text}${inventories ? `\n\n${inventories}` : ""}`;
    const handoff = `<context-handoff>\n${handoffBody}\n</context-handoff>`;
    lastHandoff = handoffBody;
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
  | { type: "thinking"; thinking: string; signature?: string }
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
  let retries = 0;
  for (;;) {
    if (signal?.aborted) throw new Error("aborted");
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
    if (res.status === 401) {
      await res.text();
      if (auth.kind === "oauth" && !replayed) {
        const refreshed = await refreshOauth(providerId);
        if (!refreshed.ok) throw new Error(refreshed.error);
        replayed = true;
        continue;
      }
      throw new Error(auth.kind === "oauth" ? "auth expired — run /login" : "invalid API key");
    }
    const wait = retryAfter(res.status, res.headers, retries);
    if (wait != null) {
      await res.text();
      retries++;
      await sleep(wait, signal);
      continue;
    }
    return res;
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
  const sys = systemPrompt();
  const prefix = buildCachedPrefix(sys, clientTools);
  const proto = providerProtocol(route.provider);
  const imageRoots = [sessionFile ? dirname(sessionFile) : "", eventsDir].filter(Boolean);
  const requestMessages = toRequest(messages, imageRoots);
  const overlay = formatOverlay({ messages, hostContext: hostContextSnapshot });
  const overlayTail = overlay ? [{ role: "user" as const, content: overlay }] : [];
  const historyForProvider = proto === "anthropic-messages" ? stampHistoryCache(requestMessages) : requestMessages;
  const providerMessages = [...historyForProvider, ...overlayTail];
  const kernelMessages = providerMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content as string | Array<Record<string, unknown>>,
  }));
  const toolsForProvider = clientTools as ToolDef[];
  const think = thinkingEnabledFor(route.model, thinkingWanted);
  const maxTokens = outputTokenBudget({ thinking: think });
  const cacheKey = hashSystem(sys);
  const body =
    proto === "anthropic-messages"
      ? {
          model: route.model,
          max_tokens: maxTokens,
          stream: true,
          ...(think ? { thinking: { type: "enabled" as const, budget_tokens: THINK_BUDGET } } : {}),
          cache_control: prefix.cache_control,
          system: prefix.system,
          tools: requestTools(prefix.tools, route.provider),
          messages: providerMessages,
        }
      : proto === "openai-codex-responses"
        ? responsesBody(route.model, sys, kernelMessages, toolsForProvider, { maxTokens, cacheKey })
        : completionsBody(
            route.model,
            sys,
            kernelMessages,
            toolsForProvider,
            route.provider === "openai" ? "max_completion_tokens" : "max_tokens",
            {
              maxTokens,
              ...(route.provider === "openai" ? { cacheKey } : {}),
            },
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
    let streamedText = "";
    let ttftMs: number | null = null;
    const events = await readSseJson(res.body, currentAbort?.signal, (event) => {
      let chunk = "";
      if (proto === "openai-codex-responses" && event.type === "response.output_text.delta") {
        const delta = event.delta;
        if (typeof delta === "string") chunk = delta;
        else if (delta && typeof delta === "object" && !Array.isArray(delta)) {
          const value = (delta as { text?: unknown; delta?: unknown }).text ?? (delta as { delta?: unknown }).delta;
          if (typeof value === "string") chunk = value;
        }
        if (chunk) event.delta = "";
      } else if (proto === "openai-completions" && Array.isArray(event.choices)) {
        const choice = event.choices[0];
        if (choice && typeof choice === "object") {
          const delta = (choice as { delta?: Record<string, unknown> }).delta;
          if (delta && typeof delta.content === "string") {
            chunk = delta.content;
            delta.content = "";
          }
        }
      }
      if (chunk) {
        if (ttftMs === null) ttftMs = Date.now() - started;
        streamedText += chunk;
        out(chunk);
      }
      if (proto === "openai-codex-responses" && event.type === "response.output_text.delta") return false;
      if (proto === "openai-completions" && chunk && Array.isArray(event.choices)) {
        const choice = event.choices[0] as { delta?: { tool_calls?: unknown }; finish_reason?: unknown } | undefined;
        if (!choice?.delta?.tool_calls && !choice?.finish_reason && !event.usage) return false;
      }
      return true;
    });
    const parsed =
      proto === "openai-codex-responses"
        ? responsesResultFromEvents(events, () => {}, started)
        : completionResultFromEvents(events, () => {}, started);
    if (parsed.error) throw new Error(parsed.error);
    if (streamedText) parsed.blocks.unshift({ type: "text", text: streamedText });
    return {
      blocks: parsed.blocks as Block[],
      usage: parsed.usage,
      ttftMs,
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
          } else if (cb.type === "thinking") {
            placeStreamBlock(slots, idx, { type: "thinking", thinking: "" });
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
          const d = ev.delta as { type: string; text?: string; partial_json?: string; citation?: unknown; thinking?: string; signature?: string };
          const idx = Number(ev.index);
          const target = slots[idx];
          if (!target) break;
          if (d.type === "text_delta" && target.type === "text") {
            if (ttftMs === null) ttftMs = Date.now() - started;
            target.text += d.text ?? "";
            out(d.text ?? "");
          } else if (d.type === "thinking_delta" && target.type === "thinking") {
            const chunk = d.thinking ?? "";
            target.thinking += chunk;
            out(chunk);
          } else if (d.type === "signature_delta" && target.type === "thinking") {
            target.signature = (target.signature ?? "") + (d.signature ?? "");
          } else if (d.type === "citations_delta" && target.type === "text" && d.citation !== undefined) {
            target.citations = [...(target.citations ?? []), d.citation];
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
  lastBilledTokens = cur;
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

function logSettings(): void {
  logEvent({
    t: "agent_settings",
    model: `${route.provider}/${route.model}`,
    thinkingLevel: thinkingLevelFor(route.model),
  });
}

async function runPrompt(prompt: string, extraImages: Array<{ name: string; mediaType: string }> = []): Promise<void> {
  if (!streamPrepared) ensureFreshSession();
  running = true;
  showPrompt();
  interrupted = false;
  currentAbort = new AbortController();
  const pendingCount = eventsDir && terminalId ? peekPendingImageCount(eventsDir, terminalId) : 0;
  const hasImages = pendingCount > 0 || extraImages.length > 0;
  let preflight: { requestId: string; token: string | null } | null = null;
  if (eventsDir && terminalId) {
    const requestId = randomUUID();
    logEvent({ t: "preflight_request", requestId, hasImages });
    const ack = await waitForAck(eventsDir, terminalId, requestId, 15_000, bridgeId, {
      shouldStop: () => interrupted,
    });
    if (!ack || ack.ok !== true) {
      const err = String(ack && typeof ack.error === "string" ? ack.error : "preflight timed out");
      out(`(the run did not start: ${err})\n`);
      surface?.setDraft(prompt);
      running = false;
      currentAbort = null;
      showPrompt();
      return;
    }
    preflight = { requestId, token: typeof ack.token === "string" ? ack.token : null };
  }
  const imageRoots = [sessionFile ? dirname(sessionFile) : "", eventsDir].filter(Boolean);
  const loaded = eventsDir && terminalId ? consumePendingImages(eventsDir, terminalId) : [];
  const extras = extraImages
    .map((ref) => loadImageFromRoots(ref, imageRoots))
    .filter((img): img is NonNullable<typeof img> => img !== null);
  const allImages = [...loaded, ...extras].slice(0, 4);
  const images = persistLoadedImages(sessionFile, allImages);
  if (sessionFile) {
    const sessionDir = dirname(sessionFile);
    const done: string[] = [];
    for (let i = 0; i < loaded.length && i < images.length; i++) {
      const ref = images[i]!;
      const src = loaded[i]!;
      if (ref.name === src.name) continue;
      try {
        if (existsSync(join(sessionDir, ref.name))) done.push(src.name);
      } catch {
        /* keep the pending file */
      }
    }
    removePendingImageFiles(eventsDir, done);
  }
  const context = eventsDir && terminalId ? readContextFiles(eventsDir, terminalId) : "";
  hostContextSnapshot = context;
  if (eventsDir && terminalId) {
    const file = promptFileName(terminalId, bridgeId, randomUUID().slice(0, 8));
    const written = writePromptPayload(eventsDir, terminalId, file, { prompt, context, images });
    if (written) logEvent({ t: "prompt", file: written, hasPreflight: preflight !== null });
  }
  if (context) out("(host context injected)\n");
  const userMsg = pushUserPrompt(prompt, images);
  logEvent({
    t: "agent_start",
    model: `${route.provider}/${route.model}`,
    sessionFile,
    sessionId,
    preflightRequestId: preflight?.requestId ?? null,
    preflightToken: preflight?.token ?? null,
    entryId: String(userMsg.sseq),
    parentEntryId: null,
    trusted: null,
    thinkingLevel: thinkingLevelFor(route.model),
  });
  if (!rateLookup && !ratesFailed) void loadRates().then(() => { ratesFailed = true; });
  let retriedOverflow = false;
  let modelCalls = 0;
  let lastHadTools = false;
  let resumePaused = false;
  let lastPlanText = "";
  let lastAssistantSseq = 0;
  try {
    while (modelCalls < MAX_TURNS) {
      if (interrupted) break;
      if (!resumePaused) {
        reclaim();
        // Maintenance order: reclaim first; summarize only when reclamation cannot
        // hold the high-water line; truncate is the last resort.
        if (totalTokens() >= usableTokens() * HIGH_WATER && !(await summarize()) && totalTokens() >= usableTokens()) {
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
      if (result.usage) {
        const bits = [`in ${result.usage.input}`, result.usage.cacheRead ? `cache ${result.usage.cacheRead}` : "", `out ${result.usage.output}`];
        if (waste.usd != null) bits.push(`$${waste.usd.toFixed(4)}`);
        surface?.setStatus({ usage: bits.filter(Boolean).join("  ") });
      }
      const assistantMsg: Message = { role: "assistant", content: result.blocks as ContentBlock[], tokens: 0, sseq: 0 };
      assistantMsg.tokens = estimate(assistantMsg);
      history.push(assistantMsg);
      assistantMsg.sseq = store({ type: "message", message: { role: "assistant", content: result.blocks } });
      lastAssistantSseq = assistantMsg.sseq;
      const plan = planTextIfChanged(visibleAssistantText(result.blocks), lastPlanText);
      if (plan) {
        lastPlanText = plan;
        logEvent({ t: "plan", text: plan });
      }
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
          out(`\n${formatToolAnnounce(use)}\n`);
        }
        const chunkOutcomes = await Promise.all(chunk.map(executeTool));
        for (let ci = 0; ci < chunk.length; ci++) {
          logEvent({ t: "tool_end", toolCallId: chunk[ci]!.id, isError: chunkOutcomes[ci]!.isError });
          const follow = formatToolFollowup(chunk[ci]!, chunkOutcomes[ci]!);
          if (follow) out(follow);
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
  if (eventsDir && terminalId) {
    const requestId = randomUUID();
    logEvent({
      t: "checkpoint_request",
      requestId,
      kind: "settled",
      entryId: lastAssistantSseq > 0 ? String(lastAssistantSseq) : null,
    });
    const ack = await waitForAck(eventsDir, terminalId, requestId, 5_000, bridgeId, {
      shouldStop: () => interrupted,
    });
    logEvent({
      t: "checkpoint_result",
      requestId,
      ok: ack?.ok === true,
      error: ack && typeof ack.error === "string" ? ack.error : null,
    });
  }
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
    logEvent({ t: "steer_input", behavior: "steer" });
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

function allCatalogModels(): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const id of AUTH_PROVIDER_ORDER) {
    const models = catalogs.get(id);
    if (!models) continue;
    for (const m of models) out.push({ provider: id, id: m.id, name: m.name });
  }
  return out;
}

function currentCatalog(): ModelInfo[] | undefined {
  return catalogs.get(route.provider);
}

function modelPickerRows(): { name: string; hint: string; submit: string }[] {
  return allCatalogModels().map((m) => ({
    name: `${m.provider}/${m.id}`,
    hint: m.name && m.name !== m.id ? m.name : m.provider,
    submit: `/model ${m.provider}/${m.id}`,
  }));
}

function syncModelRows(): void {
  surface?.setModelRows(modelPickerRows());
}

async function loadCatalog(provider: ProviderId, adopt: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!catalogFetchAllowed()) return { ok: false, error: "catalog fetch skipped in tests" };
  if (adopt && provider !== route.provider) {
    route = { provider, model: DEFAULT_MODELS[provider].main };
    retargetSummary(provider);
  }
  const got = await loadProviderModels(provider);
  if (!got.ok) return got;
  catalogs.set(provider, got.models);
  syncModelRows();
  if (provider !== route.provider) return { ok: true };
  const preferred =
    MODEL_ENV && route.provider === parseModelRef(MODEL_ENV, PROVIDER_ENV || undefined).provider
      ? route.model
      : DEFAULT_MODELS[provider].main;
  const pick = pickDefaultModel(got.models, preferred);
  if (pick) {
    if (!PINNED_ROUTE || !MODEL_ENV) route.model = pick;
    else if (pick === route.model || pick.startsWith(`${route.model}-`)) route.model = pick;
  }
  return { ok: true };
}

async function loadAuthenticatedCatalogs(refresh: boolean): Promise<string[]> {
  if (!catalogFetchAllowed()) return [];
  const ids = AUTH_PROVIDER_ORDER.filter((id) => hasStoredCredential(id) || hasEnvCredential(id));
  const errors: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      if (!refresh && catalogs.has(id)) return;
      const got = await loadProviderModels(id);
      if (!got.ok) errors.push(`${id}: ${got.error}`);
      else catalogs.set(id, got.models);
    }),
  );
  syncModelRows();
  return errors;
}

async function bootCatalog(): Promise<void> {
  if (!catalogFetchAllowed()) return;
  try {
    if (!PINNED_ROUTE) {
      const id = firstAuthenticatedProvider();
      if (id) {
        route = { provider: id, model: DEFAULT_MODELS[id].main };
        retargetSummary(id);
      }
    }
    const loaded = await loadProviderModels(route.provider);
    if (loaded.ok) catalogs.set(route.provider, loaded.models);
    const current = currentCatalog();
    if (current && current.length > 0) {
      const preferred =
        MODEL_ENV && route.provider === parseModelRef(MODEL_ENV, PROVIDER_ENV || undefined).provider
          ? route.model
          : DEFAULT_MODELS[route.provider].main;
      const pick = pickDefaultModel(current, preferred);
      if (pick) {
        if (!PINNED_ROUTE || !MODEL_ENV) route.model = pick;
        else if (pick === route.model || pick.startsWith(`${route.model}-`)) route.model = pick;
      }
    }
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
        const errors = await loadAuthenticatedCatalogs(refresh || catalogs.size === 0);
        for (const err of errors) out(`(${err})\n`);
        const listed = allCatalogModels();
        if (listed.length > 0) out(`${formatCatalogLines(listed, route.provider, route.model)}\n`);
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
      const listed = allCatalogModels().find(
        (m) => `${m.provider}/${m.id}` === rest || (m.provider === route.provider && m.id === rest),
      );
      if (listed) {
        if (listed.provider !== route.provider) {
          route = { provider: listed.provider, model: listed.id };
          retargetSummary(listed.provider);
        } else {
          route.model = listed.id;
        }
        prevPrompt = null;
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
        const loaded = currentCatalog();
        if (loaded?.some((m) => m.id === next.model || m.id.startsWith(`${next.model}-`))) {
          const pick = pickDefaultModel(loaded, next.model);
          if (pick) route.model = pick;
        } else {
          route.model = next.model;
        }
      } else {
        route.model = next.model;
      }
      prevPrompt = null;
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
    if (result.ok && isSupportedProvider(parsed.provider)) {
      catalogs.delete(parsed.provider);
      syncModelRows();
    }
    out(result.ok ? `${result.summary}\n` : `(${result.error})\n`);
    if (result.ok && parsed.provider === route.provider) syncStatus("");
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
      if (!got.ok) out(`(${got.error})\n`);
      const listed = catalogs.get(parsed.provider);
      if (got.ok && listed && listed.length > 0 && parsed.provider === route.provider) {
        out(`${formatModelBanner(listed, route.model)}\n`);
      }
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
  logSettings();
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
  if (approvalResolve) {
    const resolve = approvalResolve;
    approvalResolve = null;
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
  if (line === "/clear") {
    if (running || authBusy) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    if (sessionFile) {
      const rotated = rotateSessionFile(sessionFile);
      if (!rotated.ok) {
        out(`(could not keep the previous session: ${rotated.error})\n`);
        showPrompt();
        return;
      }
      try {
        prepareSessionStream(sessionFile, "fresh");
      } catch (err) {
        out(`(could not start a fresh session: ${err instanceof Error ? err.message : String(err)})\n`);
        showPrompt();
        return;
      }
    }
    history.length = 0;
    lastHandoff = null;
    hostContextSnapshot = "";
    lastBilledTokens = null;
    approveAll = process.env.TERMINA_CORE_APPROVE === "all";
    prevPrompt = null;
    postRevision = false;
    revisions = 0;
    streamPrepared = true;
    storageSeq = 0;
    out("(session cleared)\n");
    void connectMcp().then(() => showPrompt());
    return;
  }
  if (line === "/compact") {
    if (running || authBusy) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    void (async () => {
      const n = reclaim();
      const summed = await summarize();
      out(`(compacted${n ? `; reclaimed ${n}` : ""}${summed ? "; summarized" : ""})\n`);
      showPrompt();
    })();
    return;
  }
  const thinkingCmd = parseThinkingCommand(line);
  if (thinkingCmd) {
    if (running || authBusy) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    if ("error" in thinkingCmd) {
      out(`(${thinkingCmd.error})\n`);
      showPrompt();
      return;
    }
    if ("show" in thinkingCmd) {
      const actual = thinkingLevelFor(route.model);
      out(
        thinkingWanted && actual === "off"
          ? "(thinking off for this model)\n"
          : `(thinking ${actual})\n`,
      );
      showPrompt();
      return;
    }
    thinkingWanted = thinkingCmd.enabled;
    const actual = thinkingLevelFor(route.model);
    out(
      thinkingWanted && actual === "off"
        ? "(thinking on — this model stays off)\n"
        : `(thinking ${actual})\n`,
    );
    syncStatus();
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
      pendingImages: () => (eventsDir && terminalId ? peekPendingImageCount(eventsDir, terminalId) : 0),
      onSubmit: (line) => {
        try {
          dispatchLine(line);
        } catch (err) {
          out(`\nengine error: ${(err as Error).message}\n`);
        }
      },
      onInterrupt: () => {
        if (approvalResolve) {
          const resolve = approvalResolve;
          approvalResolve = null;
          surface?.setRawInput(false);
          resolve("n");
          return;
        }
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
      mcpSession?.shutdown();
      mcpSession = null;
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
    else syncModelRows();
  }
  if (!surface) out(banner);
  const bootList = currentCatalog();
  if (bootList && bootList.length > 0) out(`${formatModelBanner(bootList, route.model)}\n`);
  process.on("exit", () => mcpSession?.shutdown());
  await connectMcp();
  if (process.env.TERMINA_CORE_RESUME === "1") resumeSession();
  let structured = "";
  let structuredImages: Array<{ name: string; mediaType: string }> = [];
  if (eventsDir && terminalId) {
    const control = consumeStartupControl(eventsDir, terminalId, bridgeId);
    const opId = control?.opId ?? "";
    if (!control) logEvent({ t: "session_ready", opId, ok: true, reload: true });
    else logEvent({ t: "session_ready", opId, ok: true });
    logSettings();
    if (control?.action === "prefill" && control.text) {
      surface?.setDraft(control.text);
      if (!surface) out(`${control.text}\n`);
    } else if (control?.action === "structured") {
      const started = structuredStartup(control);
      structured = started.text;
      structuredImages = started.images;
    }
  }
  showPrompt();
  if (structured || structuredImages.length > 0) {
    if (structured) out(`> ${structured}\n`);
    void runPrompt(structured, structuredImages)
      .catch((err: unknown) => {
        out(`\nengine error: ${(err as Error).message}\n`);
        showPrompt();
      });
    return;
  }
  const printed = parsePrintPrompt(process.argv);
  if (printed !== null) {
    if (!printed) {
      process.stderr.write("agent-core: -p needs a prompt\n");
      process.exit(1);
    }
    await runPrompt(printed);
    process.exit(0);
  }
  if (!surface) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on("line", (line) => {
      try {
        dispatchLine(line);
      } catch (err) {
        out(`\nengine error: ${(err as Error).message}\n`);
      }
    });
  }
}

if (isDirectRun()) {
  void main();
}
