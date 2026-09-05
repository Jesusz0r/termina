/**
 * Termina agent-core v1 — in-house coding-agent engine.
 *
 * One of Termina's terminal engines. It uses the same pty
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
 * - Stubs carry the reproducing command; tool history remains the canonical
 *       record of file reads and mutations
 * - Per-turn usage records with waste attribution and models.dev pricing
 * - Two-role routing map (main + summary), env-overridable
 * - Streaming always; tool calls run concurrently behind a small bound
 * - cwd jail; grep/glob; unique edit; numbered read_file; dir listing; interruptible bash; web_search; skill index; prefix cache_control; traces
 * - last tool_result cache pin (Anthropic); session prompt_cache_key by model family; 429 retry; model-aware effort
 * - provider auth (Anthropic, OpenAI, ChatGPT Codex, xAI, Google, OpenRouter)
 */
import { consumeAgentSessionEnvironment } from "../shared/agent-environment.ts";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
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
  writeSync,
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
  usesResponsesApi,
  CACHE_CAPABILITY_FEATURE,
  documentedCacheCapability,
  cacheRouteDomain,
  type CacheCapabilityScope,
  cacheIdentityFor,
  cacheSessionSeed,
  cacheSessionHeaders,
  googleNativeHeaders,
  modelLeaf,
  refreshOauth,
  resolveAuth,
  runLogin,
  runLogout,
  type ProviderId,
} from "./auth.ts";
import {
  completionsBody,
  completionLiveDelta,
  completionResultFromEvents,
  googleGenerateBody,
  googleLiveDelta,
  googleResultFromEvents,
  readSseJson,
  responsesBody,
  responsesLiveDelta,
  responsesResultFromEvents,
  stripResponsesBreakpoints,
  textFromCompletionPayload,
  usageFromOpenAI,
  type ProviderUsage,
  type ToolDef,
} from "./openai-compat.ts";
import {
  computeTraceCost,
  normalizeRateSnapshot,
  type RateSnapshot,
  type RateSnapshotInput,
} from "./rates.ts";
import {
  appendRequestOverlay,
  buildRequestOverlay,
  projectRequest,
  type RequestMessage,
  type RequestOverlay,
  userPromptContent as projectedUserPromptContent,
} from "./request-projection.ts";
import {
  cacheRequestDiagnostics,
  classifyCacheMiss,
  createCapabilityCache,
  queryCapability,
  recordCapability,
  type CapabilityCacheRecord,
  type CacheAttemptSnapshot,
  type CachePolicyDiagnostics,
  type CacheRequestDiagnostics,
} from "./cache.ts";
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
  acknowledgePendingImages,
  claimPendingImages,
  consumeStartupControl,
  planTextIfChanged,
  loadImageFromRoots,
  pendingImageState,
  persistLoadedImages,
  promptFileName,
  readContextFilesResult,
  readProtectedPaths,
  structuredStartup,
  visibleAssistantText,
  waitForAck,
  writePromptPayload,
} from "./host.ts";
import {
  BoundedTextAccumulator,
  boundedToolResult,
  type BoundedText,
  type BoundedToolResult,
  type CompletionState,
} from "./tool-output.ts";
import {
  estimateReclaimTokens,
  makePruneRevision,
  planPruneStubs as planReclaimStubs,
  type PrunePick as ReclaimPick,
} from "./reclaim.ts";
import { formatSkillIndex as formatCompactSkillIndex, type SkillIndexSkill } from "./skill-index.ts";
import {
  createTraceRuntime,
  DEFAULT_TRACE_RETENTION_CAP,
  type TraceAttemptInput,
  type TraceCacheInput,
  type TraceCostInput as TraceRecordCostInput,
  type TraceRuntime,
  type TraceWriteOutcome,
} from "./trace.ts";
import {
  SessionWriter,
  applySessionRecord,
  clearSessionBundle,
  createReplayState,
  prepareFreshSession,
  quarantineSessionBundle,
  replaySessionBundle,
  resolveSessionFile,
  sessionBundleExists,
  sessionBundleHasContent,
  sessionBlockBytes,
  sessionBlockHash,
  type SessionResult,
} from "./session.ts";
import {
  jailMcpCwd,
  loadMcpConfigs,
  mergeClientTools,
  mcpToolDefs,
  startMcp,
  userMcpPath,
  type McpCancellationScope,
  type McpContinuation,
  type McpSession,
} from "./mcp.ts";

import { AgentTui, SLASH_COMMANDS, TUI_SHORTCUTS, rankFileTags, type TranscriptHandle } from "./tui.ts";
import { parseHideThinking } from "../shared/terminal-control.ts";

/** Example starting values from docs/AGENT-CORE.md; never spec constants. */
const MODEL_ENV = process.env.TERMINA_CORE_MODEL?.trim() || "";
const PROVIDER_ENV = process.env.TERMINA_CORE_PROVIDER?.trim() || "";
/** An env pin only counts for an authenticated provider: a stale remembered
 *  (or hand-set) pin must fall back to the default route instead of
 *  hijacking fresh sessions with an unreachable provider. */
const ENV_ROUTE = (() => {
  if (!MODEL_ENV && !PROVIDER_ENV) return null;
  const probe = parseModelRef(MODEL_ENV || DEFAULT_MODELS.anthropic.main, PROVIDER_ENV || undefined);
  return hasStoredCredential(probe.provider) || hasEnvCredential(probe.provider) ? probe : null;
})();
const PINNED_ROUTE = ENV_ROUTE !== null;
let route = ENV_ROUTE ?? parseModelRef(DEFAULT_MODELS.anthropic.main, undefined);
/** Routing map, role → model. Mechanical work rides the cheap lane. */
let summaryRoute = parseModelRef(
  process.env.TERMINA_CORE_SUMMARY_MODEL ?? DEFAULT_MODELS[route.provider].summary,
  process.env.TERMINA_CORE_SUMMARY_MODEL ? undefined : route.provider,
);
const catalogs = new Map<ProviderId, ModelInfo[]>();
/** Set only after a successful catalog proves the configured/default model is unavailable. */
let modelAvailabilityError: string | null = null;
/** Leave room for thinking output. Thinking counts against max_tokens. */
const OUTPUT_CAP = 16_384;
const THINKING_OUTPUT_CAP = 64_000;
/** Fixed-budget thinking on Claude 4.5 and earlier. Must stay below THINKING_OUTPUT_CAP. */
const FIXED_THINK_BUDGET = 16_384;
/** Bound server-tool continuation requests so a provider cannot loop forever. */
const MAX_PAUSE_TURN_CONTINUATIONS = 5;
const HIGH_WATER = 0.8;
const LOW_WATER = 0.6;
/** Trailing tool-output span never reclaimed (fraction of usable, clamped). */
const PROTECT_MIN = 4_000;
const PROTECT_MAX = 40_000;

export function defaultContextWindow(provider: ProviderId, model: string): number {
  const id = model.toLowerCase();
  if (id.includes("haiku")) return 200_000;
  if (provider === "xai" || modelLeaf(model).startsWith("grok")) return 500_000;
  if (provider === "anthropic" || provider === "google") return 1_000_000;
  return 1_050_000;
}

function contextWindow(): number {
  const env = Number(process.env.TERMINA_CORE_CONTEXT ?? "");
  if (Number.isFinite(env) && env >= 8_000) return env;
  const hit = catalogs.get(route.provider)?.find((m) => m.id === route.model);
  if (typeof hit?.context === "number" && Number.isFinite(hit.context) && hit.context >= 8_000) return hit.context;
  return defaultContextWindow(route.provider, route.model);
}

function usableTokens(): number {
  const thinking = effectiveEffortFor(route.provider, route.model, effortWanted) !== "off";
  return Math.max(8_000, contextWindow() - outputTokenBudget({ thinking }));
}

function protectTokens(): number {
  return Math.min(PROTECT_MAX, Math.max(PROTECT_MIN, Math.floor(usableTokens() * 0.25)));
}
/** Newest user turns whose messages are never touched. */
const PROTECT_TURNS = 2;
/** Tool results below this size are never worth a stub. */
const READ_CAP_BYTES = 40 * 1024;
const BASH_CAP_BYTES = 20 * 1024;
const BASH_TIMEOUT_MS = 60_000;
const DIR_LIST_CAP = 200;
const LINE_NUM_WIDTH = 6;
const EDIT_MISS_SHOW = 3;
const EDIT_MISS_LINE_CHARS = 240;
const READ_SCAN_MS = 2_000;
const TOOL_CONCURRENCY = 4;
const NOISE_FLOOR_TOKENS = 1_024;
/** Compact an expensive miss before the request reaches the context limit. */
const CACHE_MISS_COMPACT_TOKENS = 100_000;
const CACHE_MISS_COMPACT_SHARE = 0.5;
const USER_AGENTS_CAP = 8_192;
const PROJECT_AGENTS_CAP = 24_576;
const SKILL_XML_CAP = 8_192;
const GREP_HIT_CAP = 50;
const GREP_SHOW_PER_FILE = 8;
const GREP_SHOW_HITS = 20;
const GREP_SHOW_FILES = 8;
const GREP_SHOW_LINE_CHARS = 240;
const GREP_COLLECT_FILES = 40;
const GREP_BYTE_CAP = 64 * 1024;
const GREP_VISIT_CAP = 2_000;
const GREP_LINE_CHARS = 8_192;
const GREP_BUDGET_MS = 2_000;
const GREP_ROW = /^(.+):(\d+):(.*)$/;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_CAP_BYTES = 20 * 1024;
const FETCH_REDIRECT_CAP = 5;
const GLOB_HIT_CAP = 200;
const LISTING_CAP = 20;
const PROBE_TIMEOUT_MS = 500;
const EDIT_MAX_BYTES = 8 * 1024 * 1024;
const TOOL_DISPLAY_BYTES = 2 * 1024;

export function parsePrintPrompt(argv: string[]): string | null {
  const i = argv.findIndex((a) => a === "-p" || a === "--print");
  if (i < 0) return null;
  return argv.slice(i + 1).join(" ").trim();
}

export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
type EffortLevelMap = Partial<Record<EffortLevel, string | null>>;
type ReasoningEffort = "none" | Exclude<EffortLevel, "off">;
let effortWanted: EffortLevel = "medium";
let currentWorkingSetHash: string | null = null;
let currentWorkingSetChanged: boolean | null = null;
let previousWorkingSetHash: string | null = null;
let hasPreviousWorkingSet = false;
type HostContextTrace = Pick<
  BoundedText,
  "state" | "direction" | "limitBytes" | "inputBytes" | "retainedBytes" | "omittedBytes" | "outputBytes" | "truncated"
>;
let currentHostContext: HostContextTrace | null = null;
let activeRequestOverlay: RequestOverlay | null = null;

export type ThinkingRequest =
  | { type: "disabled" }
  | { type: "adaptive"; display: "summarized" }
  | { type: "enabled"; budget_tokens: number };

/** Claude 5 and 4.6+ reject a fixed thinking budget. */
function claudeThinkingApi(model: string): "adaptive" | "budget" | "none" {
  const id = model.toLowerCase();
  if (!id.includes("claude") || /claude-[1-3](?:-|$)/.test(id)) return "none";
  if (/(?:sonnet|opus|fable|mythos)-5(?:$|[^0-9])/.test(id)) return "adaptive";
  if (/4[.-][6-8]/.test(id)) return "adaptive";
  return "budget";
}

function thinkingLockedOn(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes("fable") || id.includes("mythos");
}

/**
 * Model families with a known Responses `reasoning.effort` contract, matched
 * against the lowercased id (prefix included, so `openai/o3` still matches).
 * A new family is one row here — not a new predicate. Anchored entries
 * (gpt-[5-9], o-series) stay regexes so older or foreign models can't
 * smuggle in on a substring.
 */
const RESPONSES_REASONING_FAMILIES: readonly RegExp[] = [
  /gpt-[5-9]/,
  /gpt-oss/,
  /codex/,
  /grok/,
  /muse-spark/,
  /(?:^|\/)o[0-9]/,
];

function responsesReasoningFamily(model: string): boolean {
  const id = model.toLowerCase();
  return RESPONSES_REASONING_FAMILIES.some((family) => family.test(id));
}

function responsesReasoningModel(model: string): boolean {
  const id = model.toLowerCase();
  return responsesReasoningFamily(model) || claudeThinkingApi(model) !== "none" || /gemini-[3-9]/.test(id);
}

function gemini3Model(model: string): boolean {
  return /gemini-[3-9]/.test(model.toLowerCase());
}

/**
 * Per-model Gemini level rejections observed as provider 400s. Newer
 * generations (live Zen docs already list up to 3.8 Flash) get the full
 * range unless a row below proves otherwise — rows only hide levels, so a
 * missing row fails loud (400) instead of hiding a working level.
 */
type GeminiEffortQuirk = {
  match: RegExp;
  unless?: RegExp;
  hide: readonly EffortLevel[];
};

const GEMINI_EFFORT_QUIRKS: readonly GeminiEffortQuirk[] = [
  // gemini-3-pro (no minor) rejects minimal; 3.1 Pro and later accept medium.
  { match: /gemini-3(?:\.\d+)?-pro/, hide: ["minimal"] },
  { match: /gemini-3-pro/, unless: /gemini-3\.\d+-pro/, hide: ["medium"] },
  // Gemini 3.7 Flash returns 400 on thinking_level minimal.
  { match: /gemini-3\.7.*flash/, unless: /lite/, hide: ["minimal"] },
];

/**
 * Zhipu GLM reasoning lineage (live Zen docs list 5, 5.1, 5.2; Go also
 * serves 5.3). Members share one contract — restricted level subset, xhigh
 * on Responses / max on Completions — so a new generation is one row here,
 * not a new predicate.
 */
const GLM_REASONING_FAMILIES: readonly RegExp[] = [/glm-5/];

function glmReasoningFamily(model: string): boolean {
  const id = model.toLowerCase();
  return GLM_REASONING_FAMILIES.some((family) => family.test(id));
}

/**
 * OpenCode relays serve third-party reasoning models behind an
 * OpenAI-compatible chat/completions endpoint: Zen lists deepseek, minimax,
 * glm, kimi, big-pickle, mimo, ling, and nemotron on /v1/chat/completions,
 * and opencode-go serves the same families plus longcat, hy, qwen, and
 * muse-spark there. Zen publishes no per-model effort metadata, so capability
 * comes from this owned family table and levels are the
 * OpenAI/OpenRouter/xAI-documented core subset, sent verbatim as Chat
 * Completions `reasoning_effort`.
 */
const RELAY_COMPLETIONS_FAMILIES = [
  "big-pickle",
  "deepseek",
  "glm",
  "kimi",
  "ling",
  "longcat",
  "mimo",
  "minimax",
  "muse-spark",
  "nemotron",
  "qwen",
] as const;

function relayCompletionsFamily(leaf: string): boolean {
  if (RELAY_COMPLETIONS_FAMILIES.some((family) => leaf.startsWith(family))) return true;
  return /^hy[34](?:[.-]|$)/.test(leaf);
}

/** Relay chat/completions models with a known reasoning contract. */
function usesRelayCompletionsEffort(provider: ProviderId, model: string): boolean {
  if (provider !== "opencode-zen" && provider !== "opencode-go") return false;
  if (providerProtocol(provider, model) !== "openai-completions") return false;
  return relayCompletionsFamily(modelLeaf(model));
}

/** Anthropic thinking fields belong on Messages + a Claude model, not on the login id. */
function usesAnthropicThinking(provider: ProviderId, model: string): boolean {
  return providerProtocol(provider, model) === "anthropic-messages" && claudeThinkingApi(model) !== "none";
}

/** Effort that this protocol actually sends. Login id is not enough. */
function usesModelEffort(provider: ProviderId, model: string): boolean {
  if (usesAnthropicThinking(provider, model)) return true;
  if (usesResponsesApi(provider, model) && responsesReasoningModel(model)) return true;
  if (gemini3Model(model) && (provider === "google" || providerProtocol(provider, model) === "google-generate")) {
    return true;
  }
  if (usesRelayCompletionsEffort(provider, model)) return true;
  return glmReasoningFamily(model);
}

function effortLevelMap(provider: ProviderId, model: string): EffortLevelMap {
  const id = model.toLowerCase();
  const map: EffortLevelMap = {};
  if (gemini3Model(model) && (provider === "google" || providerProtocol(provider, model) === "google-generate")) {
    map.off = null;
    for (const quirk of GEMINI_EFFORT_QUIRKS) {
      if (quirk.match.test(id) && !(quirk.unless && quirk.unless.test(id))) {
        for (const level of quirk.hide) map[level] = null;
      }
    }
    return map;
  }
  if (claudeThinkingApi(model) === "adaptive") {
    map.minimal = "low";
    map.max = "max";
    if (/(?:opus-4[.-][78]|(?:sonnet|opus|fable)-5)(?:$|[^0-9])/.test(id)) map.xhigh = "xhigh";
    if (thinkingLockedOn(model)) map.off = null;
    return map;
  }
  if (glmReasoningFamily(model)) {
    map.off = null;
    map.minimal = null;
    map.low = null;
    map.medium = null;
    if (usesResponsesApi(provider, model)) map.xhigh = "xhigh";
    else map.max = "max";
    return map;
  }
  if (usesRelayCompletionsEffort(provider, model)) {
    // Core subset only: the relay publishes no per-model metadata, so
    // minimal and xhigh stay hidden rather than risking a provider 400.
    map.minimal = null;
    map.xhigh = null;
    map.max = "max";
    return map;
  }
  if (!responsesReasoningFamily(model)) return map;
  if (id.includes("grok")) {
    if (!id.includes("4.3")) map.off = null;
    map.minimal = null;
    if (id.includes("4.6")) map.xhigh = "xhigh";
    map.max = null;
    return map;
  }
  if (/(?:^|\/)o[0-9]/.test(id)) {
    map.off = null;
    map.minimal = null;
    return map;
  }
  if (/gpt-(?:5\.[3-6]|[6-9])|codex/.test(id)) {
    if (provider === "openai-codex" || provider === "github-copilot") map.minimal = "low";
    else map.minimal = null;
    if (
      provider === "github-copilot" ||
      // GPT-6 Astra rejects reasoning none with HTTP 400 (live model page).
      /gpt-[6-9]/.test(id) ||
      (id.includes("codex") && provider !== "openrouter" && !id.includes("5.6"))
    ) {
      map.off = null;
    }
    map.xhigh = "xhigh";
  }
  if (id.includes("5.6") || /gpt-[6-9]/.test(id)) map.max = "max";
  return map;
}

export function supportedEffortLevels(provider: ProviderId, model: string): EffortLevel[] {
  if (!usesModelEffort(provider, model)) return ["off"];
  const map = effortLevelMap(provider, model);
  return EFFORT_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function clampEffortLevel(provider: ProviderId, model: string, effort: EffortLevel): EffortLevel {
  const available = supportedEffortLevels(provider, model);
  if (available.includes(effort)) return effort;
  const requested = EFFORT_LEVELS.indexOf(effort);
  for (let i = requested; i < EFFORT_LEVELS.length; i++) {
    if (available.includes(EFFORT_LEVELS[i]!)) return EFFORT_LEVELS[i]!;
  }
  for (let i = requested - 1; i >= 0; i--) {
    if (available.includes(EFFORT_LEVELS[i]!)) return EFFORT_LEVELS[i]!;
  }
  return "off";
}

export function thinkingEnabledFor(provider: ProviderId, model: string, effort: EffortLevel): boolean {
  return clampEffortLevel(provider, model, effort) !== "off";
}

export function reasoningEffortFor(
  provider: ProviderId,
  model: string,
  effort: EffortLevel,
): ReasoningEffort | undefined {
  if (usesAnthropicThinking(provider, model) || !usesModelEffort(provider, model)) return undefined;
  const actual = clampEffortLevel(provider, model, effort);
  const mapped = effortLevelMap(provider, model)[actual];
  if (typeof mapped === "string") return mapped as ReasoningEffort;
  return actual === "off" ? "none" : actual;
}

export function thinkingRequestFor(
  provider: ProviderId,
  model: string,
  effort: EffortLevel,
): ThinkingRequest | undefined {
  if (!usesAnthropicThinking(provider, model)) return undefined;
  const api = claudeThinkingApi(model);
  if (api === "none") return undefined;
  const actual = clampEffortLevel(provider, model, effort);
  if (api === "adaptive") {
    if (actual === "off") return { type: "disabled" };
    return { type: "adaptive", display: "summarized" };
  }
  if (actual === "off") return undefined;
  const budgets: Record<Exclude<EffortLevel, "off">, number> = {
    minimal: 1_024,
    low: 2_048,
    medium: 8_192,
    high: FIXED_THINK_BUDGET,
    xhigh: FIXED_THINK_BUDGET,
    max: FIXED_THINK_BUDGET,
  };
  return { type: "enabled", budget_tokens: budgets[actual] };
}

export function adaptiveEffortFor(provider: ProviderId, model: string, effort: EffortLevel): ReasoningEffort | undefined {
  if (!usesAnthropicThinking(provider, model) || claudeThinkingApi(model) !== "adaptive") return undefined;
  const actual = clampEffortLevel(provider, model, effort);
  if (actual === "off") return undefined;
  const mapped = effortLevelMap(provider, model)[actual];
  return (typeof mapped === "string" ? mapped : actual) as ReasoningEffort;
}

export function effectiveEffortFor(provider: ProviderId, model: string, effort: EffortLevel): EffortLevel {
  return clampEffortLevel(provider, model, effort);
}

export function outputTokenBudget(opts: { thinking: boolean }): number {
  return opts.thinking ? THINKING_OUTPUT_CAP : OUTPUT_CAP;
}

/** Grok rejects OpenAI encrypted-reasoning include, including on Zen and OpenRouter. */
export function includeEncryptedReasoning(provider: ProviderId, model: string): boolean {
  if (provider === "xai") return false;
  if (modelLeaf(model).startsWith("grok")) return false;
  return true;
}

export function gpt56ReasoningContext(model: string): "all_turns" | undefined {
  const leaf = modelLeaf(model);
  if (!(leaf.startsWith("gpt-5.6") || leaf.includes("gpt-5.6"))) return undefined;
  return "all_turns";
}

/** GPT-5 coding requests keep short answers. Pro and Codex keep provider defaults. */
export function gpt5TextVerbosity(model: string): "low" | undefined {
  const leaf = modelLeaf(model);
  if (!leaf.startsWith("gpt-5")) return undefined;
  if (leaf.includes("pro") || leaf.includes("codex")) return undefined;
  return "low";
}

export function parseEffortCommand(
  line: string,
): { show: true } | { effort: EffortLevel } | { error: string } | null {
  if (line !== "/effort" && !line.startsWith("/effort ")) return null;
  const rest = line.slice("/effort".length).trim().toLowerCase();
  if (!rest) return { show: true };
  if ((EFFORT_LEVELS as readonly string[]).includes(rest)) return { effort: rest as EffortLevel };
  return { error: "use /effort off, minimal, low, medium, high, xhigh, or max" };
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

const FILE_TAG_VISIT_CAP = GREP_VISIT_CAP;
const FILE_TAG_PICK_CAP = 50;
const FILE_TAG_ATTACH_CAP = 8;
const FILE_TAG_SCAN_MS = GREP_BUDGET_MS;

const FILE_TAG_TTL_MS = 2_000;
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

const GREP_LINE_BYTE_CAP = GREP_LINE_CHARS * 4;

function decodeGrepLine(value: Uint8Array): { text: string; truncated: boolean } {
  const bounded = new BoundedTextAccumulator({
    maxBytes: GREP_LINE_BYTE_CAP,
    direction: "head",
    // The surrounding grep result carries the actionable continuation.  A
    // marker on every clipped line would consume the page budget and obscure
    // the line number.
    marker: "",
  });
  bounded.push(value);
  const result = bounded.finish();
  return { text: result.text, truncated: result.truncated };
}

type LineScanResult = { state: CompletionState; truncated: boolean };

function forEachGrepLine(
  abs: string,
  fn: (lineNo: number, line: string) => boolean,
  shouldStop?: () => boolean,
  budgetMs = GREP_BUDGET_MS,
): LineScanResult {
  let fd: number | undefined;
  const started = Date.now();
  let truncated = false;
  const result = (state: CompletionState): LineScanResult => ({ state, truncated });
  try {
    fd = openSync(abs, "r");
    const chunk = Buffer.alloc(64 * 1024);
    let leftover = Buffer.alloc(0);
    let skipUntilNl = false;
    let lineNo = 1;
    let pos = 0;
    for (;;) {
      if (shouldStop?.()) return result("interrupted");
      if (budgetMs <= 0 || Date.now() - started >= budgetMs) return result("timeout");
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
        if (raw.length > GREP_LINE_BYTE_CAP) truncated = true;
        const line = decodeGrepLine(raw.subarray(0, GREP_LINE_BYTE_CAP));
        truncated ||= line.truncated;
        if (!fn(lineNo, line.text)) return result("complete");
        lineNo++;
        start = i + 1;
      }
      leftover = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
      if (leftover.length > GREP_LINE_BYTE_CAP) {
        truncated = true;
        const line = decodeGrepLine(leftover.subarray(0, GREP_LINE_BYTE_CAP));
        truncated ||= line.truncated;
        if (!fn(lineNo, line.text)) return result("complete");
        lineNo++;
        leftover = Buffer.alloc(0);
        skipUntilNl = true;
      }
    }
    if (!skipUntilNl && leftover.length > 0) {
      if (leftover.length > GREP_LINE_BYTE_CAP) truncated = true;
      const line = decodeGrepLine(leftover.subarray(0, GREP_LINE_BYTE_CAP));
      truncated ||= line.truncated;
      fn(lineNo, line.text);
    }
    return result("complete");
  } catch {
    return result("unreadable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseGrepRow(row: string): { file: string; line: number; text: string } | null {
  const m = GREP_ROW.exec(row.endsWith("\r") ? row.slice(0, -1) : row);
  if (!m) return null;
  const line = Number(m[2]);
  if (!Number.isInteger(line) || line < 1) return null;
  return { file: m[1]!, line, text: m[3]! };
}

function cmpUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function clipGrepText(text: string): string {
  if (text.length <= GREP_SHOW_LINE_CHARS) return text;
  return `${text.slice(0, GREP_SHOW_LINE_CHARS)}...`;
}

function countLabel(count: number, capped: boolean): string {
  return capped ? `${GREP_HIT_CAP}+` : String(count);
}

/** Drop a trailing incomplete line when ripgrep stdout hit the byte cap. */
export function completeGrepStdout(text: string, truncated: boolean): string {
  if (!truncated) return text.replace(/\n+$/, "");
  const cut = text.endsWith("\n") ? text : text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  return cut.replace(/\n+$/, "");
}

/** Ripgrep's per-file --max-count cannot distinguish exactly-cap hits from a
 * file with additional matches, so reaching the cap is always an incomplete
 * result and must carry a continuation. */
function grepHitCapReached(raw: string): boolean {
  const counts = new Map<string, number>();
  for (const row of raw.split("\n")) {
    const hit = parseGrepRow(row);
    if (!hit) continue;
    const count = (counts.get(hit.file) ?? 0) + 1;
    counts.set(hit.file, count);
    if (count >= GREP_HIT_CAP) return true;
  }
  return false;
}

/** Group hits by file, put sparse files first, and cap the page the model sees. */
export function formatGrepHits(raw: string): string {
  if (!raw) return raw;

  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const row of raw.split("\n")) {
    if (!row) continue;
    const hit = parseGrepRow(row);
    if (!hit) continue;
    const list = byFile.get(hit.file);
    if (list) list.push({ line: hit.line, text: hit.text });
    else byFile.set(hit.file, [{ line: hit.line, text: hit.text }]);
  }
  if (byFile.size === 0) return raw;

  const files = [...byFile.entries()].sort((a, b) => {
    if (a[1].length !== b[1].length) return a[1].length - b[1].length;
    return cmpUtf8(a[0], b[0]);
  });

  let total = 0;
  let totalCapped = false;
  for (const [, hits] of files) {
    total += hits.length;
    if (hits.length >= GREP_HIT_CAP) totalCapped = true;
  }

  const body: string[] = [];
  let shownHits = 0;
  let shownFiles = 0;
  const partials: Array<{ file: string; left: number }> = [];
  const omitted: Array<{ file: string; count: number; capped: boolean }> = [];

  for (const [file, hits] of files) {
    const capped = hits.length >= GREP_HIT_CAP;
    const label = countLabel(hits.length, capped);
    if (shownFiles >= GREP_SHOW_FILES || shownHits >= GREP_SHOW_HITS) {
      omitted.push({ file, count: hits.length, capped });
      continue;
    }
    const take = Math.min(GREP_SHOW_PER_FILE, hits.length, GREP_SHOW_HITS - shownHits);
    if (take <= 0) {
      omitted.push({ file, count: hits.length, capped });
      continue;
    }
    const left = hits.length - take;
    if (left > 0) {
      body.push(`${file} (${label} hits, showing ${take})`);
      partials.push({ file, left });
    } else {
      body.push(`${file} (${label} ${hits.length === 1 && !capped ? "hit" : "hits"})`);
    }
    for (let i = 0; i < take; i++) {
      const h = hits[i]!;
      body.push(`  ${h.line}:${clipGrepText(h.text)}`);
    }
    shownHits += take;
    shownFiles += 1;
  }

  const hitWord = total === 1 && !totalCapped ? "hit" : "hits";
  const fileWord = files.length === 1 ? "file" : "files";
  const out = [
    `${total}${totalCapped ? "+" : ""} ${hitWord} in ${files.length} ${fileWord}, showing ${shownHits}`,
    ...body,
  ];
  const footer = grepContinueFooter(partials, omitted);
  if (footer) out.push(footer);
  return out.join("\n");
}

function grepContinueFooter(
  partials: Array<{ file: string; left: number }>,
  omitted: Array<{ file: string; count: number; capped: boolean }>,
): string | undefined {
  if (partials.length === 0 && omitted.length === 0) return undefined;

  let bestFile = "";
  let bestScore = -1;
  for (const p of partials) {
    if (p.left > bestScore) {
      bestScore = p.left;
      bestFile = p.file;
    }
  }
  for (const o of omitted) {
    if (o.count > bestScore) {
      bestScore = o.count;
      bestFile = o.file;
    }
  }

  const parts: string[] = [];
  if (partials.length > 0) {
    let dense = partials[0]!;
    for (const p of partials) {
      if (p.left > dense.left) dense = p;
    }
    parts.push(`${dense.left} more in ${dense.file}`);
  }
  if (omitted.length > 0) {
    let largest = omitted[0]!;
    for (const item of omitted) {
      if (item.count > largest.count) largest = item;
    }
    if (bestFile === largest.file) {
      parts.push(
        `${omitted.length} more files (largest: ${largest.file} ${countLabel(largest.count, largest.capped)} hits)`,
      );
    } else {
      parts.push(`${omitted.length} more files`);
    }
  }
  parts.push(`Grep again with path=${JSON.stringify(bestFile)} or a tighter glob.`);
  return parts.join(". ");
}

function grepRipgrep(
  rg: string,
  root: string,
  searchAbs: string,
  pattern: string,
  glob: string | undefined,
  opts: { shouldStop?: () => boolean; budgetMs?: number },
): Promise<ToolTextResult> {
  const budgetMs = opts.budgetMs ?? GREP_BUDGET_MS;
  const repro = `grep ${shellQuote(pattern)}${glob ? ` --glob ${shellQuote(glob)}` : ""}`;
  const continuation = `Grep again with path=${JSON.stringify(searchAbs === root ? "." : posixRel(root, searchAbs))}${glob ? ` or a tighter glob than ${JSON.stringify(glob)}` : " or a tighter glob"}.`;
  let stopCallbackFailed = false;
  const shouldStop = (): boolean => {
    try {
      return opts.shouldStop?.() === true;
    } catch {
      stopCallbackFailed = true;
      return true;
    }
  };
  if (budgetMs <= 0) {
    return Promise.resolve(boundedToolResult("(grep timed out after 0 files)", {
      maxBytes: GREP_BYTE_CAP,
      marker: continuation,
      state: "timeout",
      isError: true,
    }));
  }
  const relSearch = searchAbs === root ? "." : posixRel(root, searchAbs);
  const args = [
    "--color=never",
    "-n",
    "--no-heading",
    "--with-filename",
    "--hidden",
    "--no-require-git",
    `--max-count=${GREP_HIT_CAP}`,
  ];
  for (const name of IGNORED_SEGMENTS) args.push("-g", `!**/${name}`, "-g", `!**/${name}/**`);
  if (glob) args.push("-g", glob);
  args.push("--", pattern, relSearch);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(rg, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve(boundedToolResult(`error: ${(err as Error).message}`, {
        maxBytes: GREP_BYTE_CAP,
        marker: "",
        state: "failed",
        isError: true,
      }));
      return;
    }
    const stdout = new BoundedTextAccumulator({ maxBytes: GREP_BYTE_CAP, direction: "head", marker: "" });
    const stderr = new BoundedTextAccumulator({ maxBytes: 8 * 1024, direction: "head", marker: "" });
    let stdoutSeen = 0;
    let outputTruncated = false;
    let killedForOutput = false;
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutSeen += chunk.byteLength;
      if (stdoutSeen > GREP_BYTE_CAP) {
        outputTruncated = true;
        killedForOutput = true;
        kill();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    let settled = false;
    let timedOut = false;
    let interruptedByUser = false;
    let spawnFailed = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      const stdoutResult = stdout.finish();
      const stderrResult = stderr.finish();
      const stderrTruncated = stderrResult.truncated;
      const text = completeGrepStdout(stdoutResult.text, outputTruncated || stdoutResult.truncated);
      const hitCap = grepHitCapReached(text);
      let state: CompletionState = "complete";
      let isError = false;
      let body = "";
      if (timedOut) {
        state = "timeout";
        isError = true;
        body = text ? `${formatGrepHits(text)}\n(grep timed out)` : "(grep timed out)";
      } else if (stopCallbackFailed) {
        state = "failed";
        isError = true;
        body = text ? `${formatGrepHits(text)}\n(grep stop callback failed)` : "error: grep stop callback failed";
      } else if (interruptedByUser) {
        state = "interrupted";
        isError = true;
        body = text ? `${formatGrepHits(text)}\n(grep interrupted)` : "(grep interrupted)";
      } else if (spawnFailed) {
        state = "failed";
        isError = true;
        body = `error: ${stderrResult.text || "could not start ripgrep"}`;
      } else if (killedForOutput) {
        // The process was stopped only because its display stream reached the
        // output cap; this is a complete search with an intentionally clipped
        // page, not a provider/tool failure.
        state = "complete";
      } else if (code === 2 && !outputTruncated) {
        state = "failed";
        isError = true;
        const err = stderrResult.text.trim().slice(0, 300);
        body = err ? `error: ${err}` : "error: invalid regular expression";
      } else if (!text) {
        body = outputTruncated ? "(more matching files not listed)" : "(no matches)";
      } else {
        const formatted = formatGrepHits(text);
        body = outputTruncated || hitCap
          ? `${formatted}\n(more matching files not listed)`
          : formatted;
      }
      const marker = state === "complete" && !outputTruncated && !stderrTruncated && !hitCap ? "" : continuation;
      const result = logicalToolText(body, {
        maxBytes: GREP_BYTE_CAP,
        state,
        isError,
        forceMarker: Boolean(marker),
        marker,
        continuation: marker || null,
        repro,
      });
      resolve(Object.freeze({
        ...result,
        continuation: state === "complete" && !outputTruncated && !stderrTruncated && !hitCap ? null : continuation,
        repro,
        stdout: stdoutResult,
        stderr: stderrResult,
      }));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, budgetMs);
    const poll = setInterval(() => {
      if (shouldStop()) {
        interruptedByUser = true;
        kill();
      }
    }, 50);
    if (shouldStop()) {
      interruptedByUser = true;
      kill();
    }
    child.on("error", () => {
      spawnFailed = true;
      if (!settled) finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

export async function grepFiles(
  cwd: string,
  input: { pattern?: string; path?: string; glob?: string },
  opts?: { shouldStop?: () => boolean; budgetMs?: number; jsOnly?: boolean },
): Promise<ToolTextResult> {
  const pattern = input.pattern ?? "";
  const repro = `grep ${shellQuote(pattern)}${input.glob ? ` --glob ${shellQuote(input.glob)}` : ""}`;
  const continuation = `Grep again with path=${JSON.stringify(input.path ?? ".")}${input.glob ? ` or a tighter glob than ${JSON.stringify(input.glob)}` : " or a tighter glob"}.`;
  let stopCallbackFailed = false;
  const shouldStop = (): boolean => {
    try {
      return opts?.shouldStop?.() === true;
    } catch {
      stopCallbackFailed = true;
      return true;
    }
  };
  const fail = (content: string): ToolTextResult => Object.freeze({
    ...boundedToolResult(content, { maxBytes: GREP_BYTE_CAP, marker: "", state: "failed", isError: true }),
    continuation: null,
    repro,
  });
  const unsafe = validateGrepPattern(pattern);
  const root = freezeCwd(cwd);
  const confined = confinePath(cwd, input.path ?? ".", { mustExist: true });
  if (!confined.ok) return fail(confined.error);
  if (input.glob) {
    if (input.glob.length < 1 || input.glob.length > 256) return fail("error: glob pattern length must be 1–256");
    if (/[\[\]{}]/.test(input.glob)) return fail("error: glob only supports * ** ?");
  }
  if (!opts?.jsOnly) {
    const rg = resolveTrustedBin("rg", root);
    if (rg) {
      if (pattern.length < 1 || pattern.length > 256) return fail(unsafe ?? "error: pattern length must be 1–256");
      return grepRipgrep(rg, root, confined.abs, pattern, input.glob, { ...opts, shouldStop });
    }
  }
  if (unsafe) return fail(unsafe);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return fail("error: invalid regular expression");
  }
  const budgetMs = opts?.budgetMs ?? GREP_BUDGET_MS;
  const started = Date.now();
  const collected = await collectFiles(confined.abs, root, GREP_VISIT_CAP, {
    shouldStop,
    budgetMs,
  });
  const hits: string[] = [];
  let filesWithHits = 0;
  let scanned = 0;
  let state: CompletionState = collected.state;
  let fileCap = false;
  let hitCap = false;
  let lineTruncated = false;
  for (const abs of collected.files) {
    if (shouldStop()) {
      state = stopCallbackFailed ? "failed" : "interrupted";
      break;
    }
    if (Date.now() - started >= budgetMs) {
      state = "timeout";
      break;
    }
    scanned++;
    if (scanned % 25 === 0) await yieldEventLoop();
    const rel = relative(root, abs).split(sep).join("/");
    if (input.glob && !matchGlob(input.glob, rel)) continue;
    if (filesWithHits >= GREP_COLLECT_FILES) {
      fileCap = true;
      break;
    }
    let fileHits = 0;
    const lineState = forEachGrepLine(
      abs,
      (lineNo, line) => {
        if (Date.now() - started >= budgetMs) {
          return false;
        }
        if (!regex.test(line)) return true;
        fileHits++;
        if (fileHits <= GREP_HIT_CAP) hits.push(`${rel}:${lineNo}:${line}`);
        return fileHits < GREP_HIT_CAP;
      },
      shouldStop,
      Math.max(1, budgetMs - (Date.now() - started)),
    );
    if (fileHits > 0) filesWithHits++;
    if (fileHits >= GREP_HIT_CAP) hitCap = true;
    lineTruncated ||= lineState.truncated;
    if (lineState.state === "interrupted" || shouldStop()) {
      state = stopCallbackFailed ? "failed" : "interrupted";
      break;
    }
    if (lineState.state === "timeout") {
      state = "timeout";
      break;
    }
    if (Date.now() - started >= budgetMs && lineState.state === "complete") {
      state = "timeout";
      break;
    }
    if (lineState.state === "unreadable" && state === "complete") state = "unreadable";
  }
  const stateError = state !== "complete";
  if (hits.length === 0) {
    const stateDesc = state === "timeout" ? "timed out" : state;
    const body = state === "complete"
      ? lineTruncated ? "(no matches in retained line prefixes; some lines were truncated)" : "(no matches)"
      : `(grep ${stateDesc} after ${scanned} files)`;
    const needsContinuation = stateError || lineTruncated;
    const result = logicalToolText(body, {
      maxBytes: GREP_BYTE_CAP,
      state,
      isError: stateError,
      forceMarker: needsContinuation,
      marker: needsContinuation ? continuation : "",
      continuation: needsContinuation ? continuation : null,
      repro,
    });
    return result;
  }
  const formatted = formatGrepHits(hits.join("\n"));
  const extra: string[] = [];
  if (fileCap) extra.push("(more matching files not listed. Grep again with path or glob.)");
  if (hitCap) extra.push("(grep hit cap; more matching lines may be omitted)");
  if (state !== "complete") extra.push(`(grep ${state === "timeout" ? "timed out" : state} after ${scanned} files)`);
  if (lineTruncated) extra.push("(some matching lines were truncated)");
  const body = extra.length > 0 ? `${formatted}\n${extra.join("\n")}` : formatted;
  const needsContinuation = stateError || fileCap || hitCap || lineTruncated;
  const result = logicalToolText(body, {
    maxBytes: GREP_BYTE_CAP,
    state,
    isError: stateError,
    forceMarker: needsContinuation,
    marker: needsContinuation ? continuation : "",
    continuation: needsContinuation ? continuation : null,
    repro,
  });
  return result;
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
      : "(no matches)";
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

export type Skill = SkillIndexSkill;

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
  return formatCompactSkillIndex(skills, { capBytes: SKILL_XML_CAP, capped: opts?.capped });
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

function extraBinDirs(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
  ];
}

/** Add user binary directories that a GUI launch leaves off PATH. Search the process PATH first. */
export function trustedPath(pathEnv = process.env.PATH ?? "", cwdRoot?: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const extra = extraBinDirs();
  const extraSet = new Set(extra);
  const root = cwdRoot ? freezeCwd(cwdRoot) : "";
  for (const dir of [...pathEnv.split(delimiter), ...extra]) {
    if (!dir || seen.has(dir)) continue;
    if (root && extraSet.has(dir)) {
      try {
        if (underRoot(realpathSync(dir), root)) continue;
      } catch {
        /* A missing extra directory stays on PATH. bash skips it. */
      }
    }
    seen.add(dir);
    parts.push(dir);
  }
  return parts.join(delimiter);
}

function resolveTrustedBin(bin: string, cwdRoot: string): string | null {
  for (const dir of trustedPath(process.env.PATH, cwdRoot).split(delimiter)) {
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

function countNewlinesInRange(fd: number, end: number, started: number): number | { error: string } {
  if (end <= 0) return 0;
  const chunk = Buffer.alloc(Math.min(64 * 1024, end));
  let pos = 0;
  let nls = 0;
  while (pos < end) {
    if (scanTimedOut(started)) return { error: "error: read timed out" };
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
): { start: number; end: number } | { error: string } {
  const startTarget = Math.max(1, startLine);
  const endTarget = endLine === undefined ? undefined : Math.max(1, endLine + 1);
  let start = startTarget <= 1 ? 0 : -1;
  let end = endTarget === undefined ? size : -1;
  if (start === 0 && endTarget === undefined) return { start, end };
  const chunk = Buffer.alloc(64 * 1024);
  let pos = 0;
  let current = 1;
  while (pos < size) {
    if (scanTimedOut(started)) return { error: "error: read timed out" };
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
      if ("error" in offsets) return fail(offsets.error, offsets.error.includes("timed out") ? "timeout" : "failed");
      from = offsets.start;
      viewStartLine = startLine;
      until = offsets.end;
    } else {
      const nls = countNewlinesInRange(fd, from, started);
      if (typeof nls === "object") return fail(nls.error, nls.error.includes("timed out") ? "timeout" : "failed");
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

function isReplaceAll(value: unknown): boolean {
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
      if (count > 1) return { content: editMissDiagnostic(body, oldText), isError: true };
      idx = at + oldText.length;
    }
    if (count === 0) return { content: editMissDiagnostic(body, oldText), isError: true };
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
  if (n === 0) return { content: editMissDiagnostic(body, oldText), isError: true };
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

/** Keep producer edit previews below the tailer's durable record limit. The
 * tool boundary and a digest/count remain even when the preview is clipped;
 * the file on disk remains the authority for the state mutation. */
export const SIDECAR_TOOL_EDIT_PREVIEW_BYTES = 512 * 1024;
const SIDECAR_TOOL_EDIT_FIELD_BYTES = 128 * 1024;

function utf8Prefix(value: string, maxBytes: number): string {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (source[end]! & 0xc0) === 0x80) end--;
  return source.subarray(0, end).toString("utf8");
}

export function boundedSidecarEdits(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const serialized = JSON.stringify(value) ?? "[]";
  const editsBytes = Buffer.byteLength(serialized, "utf8");
  const editsSha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  const edits: Array<Record<string, string>> = [];
  let retainedBytes = 2;
  let editsTruncated = false;
  for (const item of value) {
    if (!item || typeof item !== "object") {
      editsTruncated = true;
      continue;
    }
    const rec = item as Record<string, unknown>;
    const oldText = typeof rec.oldText === "string" ? rec.oldText : typeof rec.old_text === "string" ? rec.old_text : undefined;
    const newText = typeof rec.newText === "string" ? rec.newText : typeof rec.new_text === "string" ? rec.new_text : undefined;
    if (oldText === undefined && newText === undefined) {
      editsTruncated = true;
      continue;
    }
    const preview: Record<string, string> = {};
    if (oldText !== undefined) {
      preview.oldText = utf8Prefix(oldText, SIDECAR_TOOL_EDIT_FIELD_BYTES);
      if (Buffer.byteLength(preview.oldText, "utf8") !== Buffer.byteLength(oldText, "utf8")) editsTruncated = true;
    }
    if (newText !== undefined) {
      preview.newText = utf8Prefix(newText, SIDECAR_TOOL_EDIT_FIELD_BYTES);
      if (Buffer.byteLength(preview.newText, "utf8") !== Buffer.byteLength(newText, "utf8")) editsTruncated = true;
    }
    const candidateBytes = Buffer.byteLength(JSON.stringify(preview), "utf8") + (edits.length === 0 ? 0 : 1);
    if (retainedBytes + candidateBytes > SIDECAR_TOOL_EDIT_PREVIEW_BYTES) {
      editsTruncated = true;
      break;
    }
    edits.push(preview);
    retainedBytes += candidateBytes;
  }
  if (edits.length < value.length) editsTruncated = true;
  return {
    ...(edits.length > 0 ? { edits } : {}),
    ...(editsTruncated ? { editsTruncated: true } : {}),
    ...(editsTruncated ? { editsBytes, editsCount: value.length, editsSha256 } : {}),
  };
}

export function tracesDirFor(events: string, id: string): string | null {
  if (!events || !isValidTerminalId(id)) return null;
  return join(events, `${id}.traces`);
}

const sessionEnvironment = consumeAgentSessionEnvironment();
const eventsDir = sessionEnvironment.TERMINA_EVENTS_DIR ?? "";
const rawTerminalId = sessionEnvironment.TERMINA_TERMINAL_ID ?? "";
const terminalId = isValidTerminalId(rawTerminalId) ? rawTerminalId : "";
const sessionId = sessionEnvironment.TERMINA_CORE_SESSION_ID?.trim() || terminalId;
/** Stable for one logical session boundary; rotated by /clear/quarantine. */
let cacheSeed = cacheSessionSeed(sessionId);
const bridgeId = `core-${randomUUID()}`;
const traceRunId = `run-${randomUUID()}`;
let seq = 0;
// Every record carries the immutable generation of the producer-owned
// inode. A marker without this binding cannot authorize retirement.
let writerGeneration = randomUUID();
const sidecarBackpressureCell = new Int32Array(new SharedArrayBuffer(4));
const SIDECAR_MAX_BYTES = 8 * 1024 * 1024;
const SIDECAR_SEALED_SUFFIX = ".sealed";
const SIDECAR_SEALED_PROOF_SUFFIX = ".owner";
const SIDECAR_QUARANTINE_PREFIX = ".quarantine-";
const SIDECAR_MAX_BACKPRESSURE_POLLS = 80;
const SIDECAR_APPEND_RETRY_MS = 25;
const SIDECAR_MAX_APPEND_RETRIES = 80;
const SIDECAR_MAX_PENDING_EVENTS = 256;
function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  const fd = openSync(dirname(path), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeDurableMarker(path: string, content: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    syncFile(temp);
    renameSync(temp, path);
    syncDirectory(path);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}
function waitForSidecarBackpressure(): boolean {
  if (!eventsDir || !terminalId) return true;
  const marker = join(eventsDir, `.backpressure-${terminalId}`);
  let polls = 0;
  while (existsSync(marker)) {
    if (hasQuarantineSidecar()) return false;
    if (++polls > SIDECAR_MAX_BACKPRESSURE_POLLS) {
      // Checkpoint/preflight handlers can outlive this poll budget. Treat
      // the marker as advisory so a slow consumer cannot quarantine the
      // producer and permanently stall the terminal.
      return true;
    }
    try {
      Atomics.wait(sidecarBackpressureCell, 0, 0, 25);
    } catch {
      // A runtime that cannot block synchronously must fail closed rather
      // than append past the bounded durable spool.
      return false;
    }
  }
  return true;
}
const activeSidecarPath = eventsDir && terminalId ? join(eventsDir, terminalId + ".jsonl") : "";
function hasQuarantineSidecar(): boolean {
  return !!eventsDir && !!terminalId && existsSync(join(eventsDir, SIDECAR_QUARANTINE_PREFIX + terminalId));
}
function hasRetainedSidecar(): boolean {
  if (!eventsDir || !terminalId) return false;
  try {
    const prefix = "." + terminalId + ".jsonl.";
    return readdirSync(eventsDir).some((name) =>
      name.startsWith(prefix)
      && (name.includes(".retained-")
        || name.includes(".draining-")
        || name.includes(".final-"))
    );
  } catch {
    return false;
  }
}
function quarantineAdmission(reason: string): void {
  try {
    if (!hasQuarantineSidecar()) {
      writeDurableMarker(
        join(eventsDir, SIDECAR_QUARANTINE_PREFIX + terminalId),
        JSON.stringify({ version: 1, state: "quarantined", terminalId, reason }) + "\n",
      );
    }
  } catch {
    /* The caller still fails closed if the diagnostic cannot be published. */
  }
}
/** Append one exact record idempotently. If a write/fsync throws after the
 * kernel accepted the bytes, the next attempt recognizes that same line and
 * only commits its reserved sequence once durability succeeds. */
function appendDurable(path: string, line: string): void {
  const payload = Buffer.from(line, "utf8");
  const fd = openSync(path, "a+", 0o600);
  try {
    const size = fstatSync(fd).size;
    const tailSize = Math.min(size, SIDECAR_MAX_BYTES + payload.length);
    const tail = Buffer.alloc(tailSize);
    if (tailSize > 0) readSync(fd, tail, 0, tailSize, size - tailSize);
    if (tail.indexOf(payload) < 0) {
      // Recover a prefix accepted by a failed write without emitting the
      // pending identity a second time. O_APPEND keeps each syscall at EOF.
      let prefix = 0;
      const maxPrefix = Math.min(payload.length - 1, tail.length);
      for (let length = maxPrefix; length > 0; length--) {
        let equal = true;
        const start = tail.length - length;
        for (let i = 0; i < length; i++) {
          if (tail[start + i] !== payload[i]) { equal = false; break; }
        }
        if (equal) { prefix = length; break; }
      }
      let written = prefix;
      while (written < payload.length) {
        const count = writeSync(fd, payload, written, payload.length - written, undefined);
        if (!Number.isInteger(count) || count <= 0) throw new Error("sidecar append made no progress");
        written += count;
      }
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Publish a sealed generation from the producer side. Publication records
 * the active inode identity and durable close state; the tailer will not trust
 * a marker that is merely present or bound to another generation. */
function sealBeforeAppend(lineBytes: number, lastSeq: number): boolean {
  if (!activeSidecarPath) return false;
  if (hasQuarantineSidecar()) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let activeStats: ReturnType<typeof statSync>;
    try {
      activeStats = statSync(activeSidecarPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        try {
          const activeFd = openSync(activeSidecarPath, "a", 0o600);
          try { fsyncSync(activeFd); } finally { closeSync(activeFd); }
          syncDirectory(activeSidecarPath);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
    if (activeStats.size === 0 || activeStats.size + lineBytes <= SIDECAR_MAX_BYTES) return true;
    // A retained/unproven inode may continue draining while this active
    // generation has room. Once rotation is required, admission stops at
    // the bounded quarantine boundary instead of creating an overtaking
    // generation that could lose sequence order.
    if (hasRetainedSidecar()) {
      quarantineAdmission("unproven sidecar generation blocked a safe rotation");
      return false;
    }
    // Let an already-published canonical generation retire before creating
    // another one. This wait is only on the rotation boundary; ordinary
    // active appends continue while an older retained inode drains.
    let sealedPolls = 0;
    let sealedPending = false;
    try {
      const prefix = "." + terminalId + ".jsonl.";
      sealedPending = readdirSync(eventsDir).some((name) => name.startsWith(prefix) && name.endsWith(SIDECAR_SEALED_SUFFIX));
    } catch {}
    while (sealedPending) {
      if (++sealedPolls > SIDECAR_MAX_BACKPRESSURE_POLLS) {
        quarantineAdmission("sealed sidecar generation did not retire within the bounded admission budget");
        return false;
      }
      if (!waitForSidecarBackpressure()) return false;
      try { Atomics.wait(sidecarBackpressureCell, 0, 0, 25); } catch { return false; }
      if (hasQuarantineSidecar()) return false;
      if (hasRetainedSidecar()) {
        quarantineAdmission("unproven sidecar generation blocked a safe rotation");
        return false;
      }
      try {
        const prefix = "." + terminalId + ".jsonl.";
        sealedPending = readdirSync(eventsDir).some((name) => name.startsWith(prefix) && name.endsWith(SIDECAR_SEALED_SUFFIX));
      } catch {
        sealedPending = false;
      }
    }
    let proofPath: string | undefined;
    try {
      const sealedPath = activeSidecarPath + "." + Date.now().toString(36) + "-" + process.pid + "-" + randomUUID() + SIDECAR_SEALED_SUFFIX;
      proofPath = sealedPath + SIDECAR_SEALED_PROOF_SUFFIX;
      const sealedName = basename(sealedPath);
      const identity = String(activeStats.dev) + ":" + String(activeStats.ino);
      // The synchronous append path has no descriptor that survives this
      // call. Flush and revalidate the active inode immediately before the
      // publication boundary; a concurrent replacement must not be described
      // by this writer's close proof.
      syncFile(activeSidecarPath);
      const beforeRename = statSync(activeSidecarPath);
      if (String(beforeRename.dev) + ":" + String(beforeRename.ino) !== identity || beforeRename.size !== activeStats.size) continue;
      renameSync(activeSidecarPath, sealedPath);
      syncFile(sealedPath);
      const activeFd = openSync(activeSidecarPath, "a", 0o600);
      try { fsyncSync(activeFd); } finally { closeSync(activeFd); }
      syncDirectory(sealedPath);
      // Publish the close proof last. If a crash interrupts any prior
      // rename/file/parent durability step, restart sees an unproven sealed
      // inode and keeps an anchor instead of trusting an orphan marker.
      writeDurableMarker(proofPath, JSON.stringify({
        version: 2,
        state: "closed",
        writerId: bridgeId,
        bridgeId,
        generation: writerGeneration,
        sealedName,
        identity,
        lastSeq,
      }) + "\n");
      writerGeneration = randomUUID();
      return true;
    } catch (error) {
      // A failed publish may have written a proof after the sealed pathname
      // was published but before the complete operation returned. Removing
      // it makes restart use the conservative retained-anchor path.
      if (proofPath) {
        try {
          rmSync(proofPath, { force: true });
          syncDirectory(proofPath);
        } catch { /* best effort */ }
      }
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      return false;
    }
  }
  return false;
}
const canonicalCwd = freezeCwd(process.cwd());
let allowPaths = new Set<string>();
const tracesDir = tracesDirFor(eventsDir, terminalId) ?? "";
let streamPrepared = false;

let traceRuntime: TraceRuntime | null = null;
let traceRuntimeStartupError: string | null = null;
if (tracesDir) {
  try {
    traceRuntime = createTraceRuntime({
      directory: tracesDir,
      namespace: traceRunId,
      retentionCap: DEFAULT_TRACE_RETENTION_CAP,
    });
    void traceRuntime.ready.then((startup) => {
      traceRuntimeStartupError = startup.error;
    }).catch((error: unknown) => {
      traceRuntimeStartupError = error instanceof Error ? error.message : String(error);
    });
  } catch (error) {
    traceRuntimeStartupError = error instanceof Error ? error.message : String(error);
  }
}

type MainCacheIdentity = NonNullable<ReturnType<typeof cacheIdentityFor>>;

/** Route origin used for documented capability gates. Custom relay origins
 * remain unknown because a model name alone cannot establish their fields. */
function cacheRouteForProvider(provider: ProviderId): string {
  const envName: Partial<Record<ProviderId, string>> = {
    anthropic: "ANTHROPIC_BASE_URL",
    openai: "OPENAI_BASE_URL",
    xai: "XAI_BASE_URL",
    openrouter: "OPENROUTER_BASE_URL",
  };
  const env = envName[provider];
  if (env) {
    const configured = process.env[env]?.trim();
    if (configured) return configured;
  }
  if (provider === "anthropic") return "https://api.anthropic.com";
  if (provider === "openai") return "https://api.openai.com/v1";
  if (provider === "xai") return "https://api.x.ai/v1";
  if (provider === "google") return "https://generativelanguage.googleapis.com/v1beta/openai";
  return `${provider}`;
}

/** One bounded, route/model/feature-scoped cache capability cache for this
 * process.  Documentation-backed observations are seeded lazily; relay and
 * compatibility routes stay explicitly unknown and therefore disabled. */
const cacheCapabilities = createCapabilityCache();

function cacheCapabilityScope(
  provider: ProviderId,
  model: string,
  feature: string,
): CacheCapabilityScope {
  return {
    provider,
    protocol: providerProtocol(provider, model),
    route: cacheRouteDomain(cacheRouteForProvider(provider)),
    model,
    feature,
  };
}

function observeCacheCapability(
  provider: ProviderId,
  model: string,
  feature: string,
): CapabilityCacheRecord {
  const scope = cacheCapabilityScope(provider, model, feature);
  const now = Date.now();
  const cached = queryCapability(cacheCapabilities, scope, now);
  if (cached.reason !== "not-observed" && cached.reason !== "expired") return cached;
  const documented = documentedCacheCapability(scope);
  const recorded = recordCapability(cacheCapabilities, {
    scope,
    supported: documented.supported,
    status: documented.status,
    source: documented.source,
    reason: documented.reason,
    provenance: documented.provenance,
    observedAtMs: now,
    // No provider-independent expiry is assumed.  A live rejection can be
    // invalidated by a process restart or a future route-specific probe.
    expiresAtMs: null,
  });
  return recorded ?? cached;
}

function cacheCapabilitySupported(provider: ProviderId, model: string, feature: string): boolean {
  return observeCacheCapability(provider, model, feature).supported === true;
}

function recordRejectedCacheCapability(
  provider: ProviderId,
  model: string,
  feature: string,
  reason: string,
): void {
  const scope = cacheCapabilityScope(provider, model, feature);
  recordCapability(cacheCapabilities, {
    scope,
    supported: false,
    status: "rejected",
    source: "probe",
    reason: reason.slice(0, 512),
    provenance: null,
    observedAtMs: Date.now(),
    // Retention/expiry is route-specific and unknown; do not invent a TTL.
    expiresAtMs: null,
  });
}

function recordRejectedCacheFields(
  provider: ProviderId,
  model: string,
  body: Record<string, unknown>,
  detail: string,
): void {
  const lower = detail.toLowerCase();
  const serialized = JSON.stringify(body);
  const candidates: Array<{ feature: string; present: boolean; words: string[] }> = [
    {
      feature: CACHE_CAPABILITY_FEATURE.promptCacheOptions,
      present: body.prompt_cache_options !== undefined,
      words: ["prompt_cache_options", "cache options"],
    },
    {
      feature: CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint,
      present: serialized.includes("prompt_cache_breakpoint"),
      words: ["prompt_cache_breakpoint", "cache breakpoint"],
    },
    {
      feature: CACHE_CAPABILITY_FEATURE.promptCacheKey,
      present: typeof body.prompt_cache_key === "string",
      words: ["prompt_cache_key", "cache key"],
    },
  ];
  for (const candidate of candidates) {
    if (candidate.present && candidate.words.some((word) => lower.includes(word))) {
      recordRejectedCacheCapability(provider, model, candidate.feature, detail);
    }
  }
}

function cacheIdentityForRole(role: "main" | "summary", provider: ProviderId, model: string): MainCacheIdentity | null {
  const protocol = providerProtocol(provider, model);
  const identity = cacheIdentityFor({
    sessionSeed: cacheSeed,
    role,
    provider,
    protocol,
    route: cacheRouteForProvider(provider),
  });
  if (!identity) return null;
  // xAI documents different identities for Responses and Chat. A relay must
  // not receive the Chat header (or a diagnostic hash) merely because the
  // selected model happens to be a Grok model.
  if (
    provider === "xai" &&
    !cacheCapabilitySupported(provider, model, CACHE_CAPABILITY_FEATURE.promptCacheKey) &&
    !cacheCapabilitySupported(provider, model, CACHE_CAPABILITY_FEATURE.xaiConversationHeader)
  ) {
    return null;
  }
  return identity;
}

function rotateCacheSession(): void {
  cacheSeed = cacheSessionSeed(undefined);
  resetCacheContinuity();
}

type PendingSidecarWrite = {
  body: Record<string, unknown>;
  seq: number;
  generation: string | null;
  line: string | null;
  attempts: number;
};

let sidecarWriteStopped = false;
const pendingSidecarWrites: PendingSidecarWrite[] = [];
let sidecarRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSidecarRetry(): void {
  if (sidecarWriteStopped || sidecarRetryTimer !== null) return;
  sidecarRetryTimer = setTimeout(() => {
    sidecarRetryTimer = null;
    // The queue head may have committed while this timer was pending; retry
    // whichever exact identity is now blocking the FIFO.
    flushPendingSidecar();
  }, SIDECAR_APPEND_RETRY_MS);
}

function failPendingSidecar(pending: PendingSidecarWrite, error: unknown): void {
  pending.attempts++;
  if (pending.attempts >= SIDECAR_MAX_APPEND_RETRIES) {
    sidecarWriteStopped = true;
    quarantineAdmission("sidecar append did not become durable within the bounded retry budget");
    console.warn(`[sidecar] event append stopped after bounded retries: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  scheduleSidecarRetry();
}

function flushPendingSidecar(): boolean {
  if (pendingSidecarWrites.length === 0 || sidecarWriteStopped) return false;
  while (pendingSidecarWrites.length > 0) {
    const pending = pendingSidecarWrites[0]!;
    try {
      mkdirSync(eventsDir, { recursive: true });
      if (!waitForSidecarBackpressure()) throw new Error("sidecar admission is paused");
      if (pending.line === null) {
        const draft = JSON.stringify({ ...pending.body, bridgeId, producerPid: process.pid, seq: pending.seq, generation: writerGeneration }) + "\n";
        if (!sealBeforeAppend(Buffer.byteLength(draft, "utf8"), seq)) throw new Error("sidecar generation is not publishable");
        // Rotation changes the active inode generation. Freeze the post-rotation
        // line so every retry addresses this exact event identity.
        pending.generation = writerGeneration;
        pending.line = JSON.stringify({ ...pending.body, bridgeId, producerPid: process.pid, seq: pending.seq, generation: pending.generation }) + "\n";
      }
      appendDurable(activeSidecarPath, pending.line);
      // The sequence is committed only after append + fsync succeed.
      seq = pending.seq;
      pendingSidecarWrites.shift();
      pending.attempts = 0;
    } catch (error) {
      failPendingSidecar(pending, error);
      return false;
    }
  }
  return true;
}

function logEvent(body: Record<string, unknown>): void {
  if (!eventsDir || !terminalId || sidecarWriteStopped) return;
  // Reserve in call order even while an earlier append is retrying. Later
  // records stay queued behind the exact failed identity instead of being
  // silently dropped by a transient filesystem error.
  if (pendingSidecarWrites.length >= SIDECAR_MAX_PENDING_EVENTS) {
    sidecarWriteStopped = true;
    quarantineAdmission("sidecar pending event queue exceeded its bounded admission");
    console.warn("[sidecar] event append stopped after pending queue overflow");
    return;
  }
  pendingSidecarWrites.push({ body, seq: seq + pendingSidecarWrites.length + 1, generation: null, line: null, attempts: 0 });
  void flushPendingSidecar();
}

export interface TraceCacheDiagnostics extends CacheRequestDiagnostics {
  /** Hash and exact byte count of the volatile overlay, if one was sent. */
  overlayHash: string | null;
  overlayBytes: number | null;
  /** Bounded host-reader metadata retained without exposing host content. */
  hostContext: HostContextTrace | null;
  retryPromptIdentical: boolean | null;
  codexTurnStateUsed: boolean;
  /** Exact UTF-8 serialization metadata for the provider tool schema. */
  serializedToolsHash: string | null;
  serializedToolsBytes: number | null;
  /** Full local miss evidence; null fields mean the provider did not expose enough data. */
  missAttribution: NonNullable<TraceCacheInput["missAttribution"]>;
}

/** Decide whether a trace write actually persisted and whether a retry is
 * meaningful.  A failed write must not be mistaken for a durable attempt. */
export function traceWriteDisposition(
  outcome: TraceWriteOutcome,
): { persisted: boolean; retry: boolean; terminal: boolean } {
  const persisted = outcome.ok || outcome.persisted;
  const retryable = outcome.ok ? false : outcome.retryable;
  return {
    persisted,
    retry: !persisted && retryable,
    terminal: persisted || !retryable,
  };
}

/** Return a storage range only when this operation actually appended records. */
export function storageSeqRange(
  seqBefore: number,
  seqAfter: number,
): readonly [number, number] | null {
  if (!Number.isSafeInteger(seqBefore) || !Number.isSafeInteger(seqAfter)) return null;
  if (seqAfter < seqBefore + 1) return null;
  return [seqBefore + 1, seqAfter];
}

/** Intermediate provider records must not become the task's final attempt. */
export function isTerminalTraceAttemptStatus(status: string): boolean {
  return status !== "retrying" && status !== "fallback" && status !== "overflow";
}

type TraceTaskState = {
  runId: string;
  taskId: string;
  taskClass: string | null;
  criteriaHash: string | null;
  /** Immutable catalog view captured for this logical run. */
  rateSnapshots: ReadonlyMap<string, RateSnapshot>;
  attemptIds: string[];
  summaryAttemptIds: string[];
  lastMainAttemptId: string | null;
  finalAttemptId: string | null;
  settled: boolean;
};

type TraceAttemptState = {
  task: TraceTaskState;
  attemptId: string;
  role: "main" | "summary";
  provider: ProviderId;
  protocol: string;
  model: string;
  parentAttemptId: string | null;
  retryOfAttemptId: string | null;
  retryCount: number;
  fallbackReason: string | null;
  started: number;
  ended: number | null;
  written: boolean;
  traceWriteComplete: boolean;
  traceWriteRetries: number;
};

let activeTraceTask: TraceTaskState | null = null;
let inFlightTraceAttempt: TraceAttemptState | null = null;

function traceMetadataText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return null;
  return trimmed.slice(0, 256);
}

function beginTraceTask(): TraceTaskState {
  const task: TraceTaskState = {
    runId: traceRunId,
    taskId: `task-${randomUUID()}`,
    taskClass: traceMetadataText(process.env.TERMINA_CORE_TASK_CLASS),
    criteriaHash: traceMetadataText(process.env.TERMINA_CORE_SUCCESS_CRITERIA_HASH),
    rateSnapshots: new Map(rateSnapshotMap),
    attemptIds: [],
    summaryAttemptIds: [],
    lastMainAttemptId: null,
    finalAttemptId: null,
    settled: false,
  };
  activeTraceTask = task;
  return task;
}

function beginTraceAttempt(
  role: "main" | "summary",
  opts: {
    parentAttemptId?: string | null;
    retryOfAttemptId?: string | null;
    fallbackReason?: string | null;
    retryCount?: number;
  } = {},
): TraceAttemptState | null {
  const task = activeTraceTask;
  if (!task) return null;
  const parentAttemptId = opts.parentAttemptId === undefined
    ? role === "summary" ? task.lastMainAttemptId : task.lastMainAttemptId
    : opts.parentAttemptId;
  const retryOfAttemptId = opts.retryOfAttemptId ?? null;
  const attempt: TraceAttemptState = {
    task,
    attemptId: `attempt-${randomUUID()}`,
    role,
    provider: role === "summary" ? summaryRoute.provider : route.provider,
    protocol: role === "summary"
      ? providerProtocol(summaryRoute.provider, summaryRoute.model)
      : providerProtocol(route.provider, route.model),
    model: role === "summary" ? summaryRoute.model : route.model,
    parentAttemptId: parentAttemptId ?? null,
    retryOfAttemptId,
    retryCount: Number.isSafeInteger(opts.retryCount) && (opts.retryCount as number) >= 0 ? opts.retryCount as number : retryOfAttemptId ? 1 : 0,
    fallbackReason: opts.fallbackReason ?? null,
    started: Date.now(),
    ended: null,
    written: false,
    traceWriteComplete: false,
    traceWriteRetries: 0,
  };
  task.attemptIds.push(attempt.attemptId);
  if (role === "summary") task.summaryAttemptIds.push(attempt.attemptId);
  else task.lastMainAttemptId = attempt.attemptId;
  inFlightTraceAttempt = attempt;
  return attempt;
}

function traceFailure(outcome: TraceWriteOutcome): void {
  if (outcome.ok) return;
  logEvent({
    t: "trace_write_failure",
    kind: outcome.kind,
    persisted: outcome.persisted,
    path: outcome.path,
    traceTurn: outcome.traceTurn,
    error: outcome.error,
    omittedRecords: outcome.omittedRecords,
    retentionFailures: outcome.retentionFailures,
  });
}

/** Close the async trace writer on the bounded print-and-exit path. */
async function closeTraceRuntime(): Promise<boolean> {
  const runtime = traceRuntime;
  traceRuntime = null;
  if (!runtime) return true;
  try {
    const outcome = await runtime.close();
    if (!outcome.ok) {
      logEvent({
        t: "trace_manifest_failure",
        kind: outcome.kind,
        path: outcome.path,
        error: outcome.error,
      });
    }
    return outcome.ok;
  } catch (error) {
    logEvent({
      t: "trace_manifest_failure",
      kind: "manifest-write-failure",
      path: tracesDir ? join(tracesDir, "trace-manifest.json") : null,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function traceCachePolicyInput(
  cache: TraceCacheDiagnostics,
  role: "main" | "summary",
  rejected: boolean,
  effective: boolean,
): TraceCacheInput["requested"] {
  const policy = cache.policy;
  const namespace = `${policy.provider}/${policy.protocol}/${role}`;
  return {
    mode: effective ? policy.effectiveMode : policy.requestedMode,
    ttlMs: effective ? policy.effectiveTtlMs : policy.requestedTtlMs,
    namespace,
    markerCount: cache.markerCount,
    markerPositions: cache.markerPositions,
    // A rejected request is not the effective policy.  Leave the effective
    // rejection nullable rather than labeling the stripped retry rejected.
    rejected: effective ? null : rejected ? true : null,
    fallbackReason: policy.fallbackReason,
  };
}

function traceCacheInput(
  cache: TraceCacheDiagnostics | null,
  attempt: TraceAttemptState,
): TraceCacheInput | null {
  if (!cache) return null;
  const rejected = Boolean(cache.policy.fallbackReason);
  return {
    namespace: `${cache.policy.provider}/${cache.policy.protocol}/${attempt.role}`,
    requested: traceCachePolicyInput(cache, attempt.role, rejected, false),
    effective: traceCachePolicyInput(cache, attempt.role, rejected, true),
    markerCount: cache.markerCount,
    markerPositions: cache.markerPositions,
    rejected,
    fallbackReason: cache.policy.fallbackReason,
    cacheKeyHash: cache.cacheKeyHash,
    modelSettingsHash: cache.modelSettingsHash,
    toolsHash: cache.toolsHash,
    stablePrefixHash: cache.stablePrefixHash,
    reusablePrefixHash: cache.reusablePrefixHash,
    messagePrefixHash: cache.messagePrefixHash,
    workingSetHash: cache.workingSetHash,
    workingSetChanged: cache.workingSetChanged,
    retryPromptIdentical: cache.retryPromptIdentical,
    codexTurnStateUsed: cache.codexTurnStateUsed,
    serializedToolsHash: cache.serializedToolsHash,
    serializedToolsBytes: cache.serializedToolsBytes,
    missAttribution: cache.missAttribution,
  };
}

async function writeTraceAttempt(
  attempt: TraceAttemptState | null,
  fields: {
    status: string;
    storageSeqRange: readonly [number, number] | null;
    toolNames: readonly string[];
    usage: Usage | null;
    usd: number | null;
    cost?: TraceRecordCostInput | null;
    ttftMs: number | null;
    turnMs: number | null;
    revisions: number;
    revisionKinds: readonly RevisionKind[];
    wasteTokens: number | null;
    wasteCause: string | null;
    cache: TraceCacheDiagnostics | null;
    toolOutcomes?: readonly unknown[];
    reclaimEvidence?: unknown;
  },
): Promise<void> {
  if (!attempt || attempt.traceWriteComplete) return;
  const endedAtMs = attempt.ended ?? Date.now();
  attempt.ended = endedAtMs;
  if (!traceRuntime) {
    attempt.traceWriteComplete = true;
    if (inFlightTraceAttempt === attempt) inFlightTraceAttempt = null;
    return;
  }
  const input: TraceAttemptInput = {
    runId: attempt.task.runId,
    taskId: attempt.task.taskId,
    attemptId: attempt.attemptId,
    parentAttemptId: attempt.parentAttemptId,
    retryOfAttemptId: attempt.retryOfAttemptId,
    role: attempt.role,
    provider: attempt.provider,
    protocol: attempt.protocol,
    route: `${attempt.provider}/${attempt.protocol}`,
    model: attempt.model,
    taskClass: attempt.task.taskClass,
    requestedEffort: attempt.role === "summary" ? "off" : effortWanted,
    effectiveEffort: attempt.role === "summary"
      ? effectiveEffortFor(summaryRoute.provider, summaryRoute.model, "off")
      : effectiveEffortFor(route.provider, route.model, effortWanted),
    status: fields.status,
    retryCount: attempt.retryCount,
    fallbackReason: attempt.fallbackReason,
    storageSeqRange: fields.storageSeqRange,
    toolNames: fields.toolNames,
    startedAtMs: attempt.started,
    endedAtMs,
    ttftMs: fields.ttftMs,
    turnMs: fields.turnMs,
    usage: fields.usage,
    cost: fields.cost ?? { usd: fields.usd },
    cache: traceCacheInput(fields.cache, attempt),
    toolOutcomes: fields.toolOutcomes,
    reclaimEvidence: fields.reclaimEvidence,
    revisions: { count: fields.revisions, kinds: fields.revisionKinds },
    wasteTokens: fields.wasteTokens,
    wasteCause: fields.wasteCause,
  };
  try {
    let outcome = await traceRuntime.writeAttempt(input);
    let disposition = traceWriteDisposition(outcome);
    if (disposition.retry && attempt.traceWriteRetries < 1) {
      attempt.traceWriteRetries += 1;
      const failure = outcome.ok ? null : outcome;
      logEvent({
        t: "trace_write_retry",
        kind: outcome.kind,
        retryable: failure?.retryable ?? false,
        error: failure?.error ?? null,
        attemptId: attempt.attemptId,
      });
      outcome = await traceRuntime.writeAttempt(input);
      disposition = traceWriteDisposition(outcome);
    }
    traceFailure(outcome);
    if (disposition.persisted) {
      attempt.written = true;
      if (attempt.role === "main" && isTerminalTraceAttemptStatus(fields.status)) {
        attempt.task.finalAttemptId = attempt.attemptId;
      }
    } else if (!disposition.terminal) {
      const failure = outcome.ok ? null : outcome;
      logEvent({
        t: "trace_write_unpersisted",
        kind: failure?.kind ?? outcome.kind,
        retryable: failure?.retryable ?? false,
        persisted: outcome.persisted,
        error: failure?.error ?? null,
        attemptId: attempt.attemptId,
      });
    }
    attempt.traceWriteComplete = true;
  } catch (error) {
    attempt.traceWriteComplete = true;
    logEvent({ t: "trace_write_failure", kind: "write-failure", persisted: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (inFlightTraceAttempt === attempt) inFlightTraceAttempt = null;
  }
}

async function settleTraceTask(status: string): Promise<void> {
  const task = activeTraceTask;
  if (!task || task.settled) return;
  task.settled = true;
  if (!traceRuntime) {
    activeTraceTask = null;
    inFlightTraceAttempt = null;
    return;
  }
  try {
    traceFailure(await traceRuntime.writeTaskSettled({
      runId: task.runId,
      taskId: task.taskId,
      taskClass: task.taskClass,
      attemptCount: task.attemptIds.length,
      finalAttemptId: task.finalAttemptId,
      attemptIds: task.attemptIds,
      summaryAttemptIds: task.summaryAttemptIds,
      outcome: { status, correctness: null, criteriaHash: task.criteriaHash },
    }));
  } catch (error) {
    logEvent({ t: "trace_write_failure", kind: "write-failure", persisted: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    activeTraceTask = null;
    inFlightTraceAttempt = null;
  }
}

export function hashSystem(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

type CacheMarkerDetails = { count: number; positions: number[]; ttlMs: number | null };

function cacheMarkerDetails(value: unknown): CacheMarkerDetails {
  const details: CacheMarkerDetails = { count: 0, positions: [], ttlMs: null };
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) walk(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (key === "cache_control" || key === "prompt_cache_breakpoint") {
        details.count++;
        if (details.positions.length < 64) details.positions.push(details.count - 1);
        if (
          child &&
          typeof child === "object" &&
          !Array.isArray(child) &&
          (child as Record<string, unknown>).ttl === "1h"
        ) {
          details.ttlMs = 60 * 60 * 1000;
        }
      }
      walk(child);
    }
  };
  walk(value);
  return details;
}

function cachePolicyFromBody(
  body: Record<string, unknown>,
  identity: { provider: ProviderId; protocol: string; model: string },
  prior: CachePolicyDiagnostics | null,
  fallbackReason: string | null,
): { policy: CachePolicyDiagnostics; markers: CacheMarkerDetails } {
  const markers = cacheMarkerDetails(body);
  const options = body.prompt_cache_options;
  const hasExplicitOptions = Boolean(options && typeof options === "object" && !Array.isArray(options));
  const hasCacheKey = typeof body.prompt_cache_key === "string" && body.prompt_cache_key.length > 0;
  const hasSessionId = typeof body.session_id === "string" && body.session_id.length > 0;
  const requestedMode = hasExplicitOptions
    ? "explicit"
    : hasCacheKey || hasSessionId
      ? "implicit"
        : markers.count > 0
          ? identity.protocol === "anthropic-messages"
            ? "markers"
            : "explicit"
          : "none";
  // A rejected explicit field may be removed while a supported implicit key
  // remains in the same body. Derive the effective policy from that actual
  // body instead of collapsing every fallback to "none".
  const effectiveMode = requestedMode;
  let requestedTtlMs: number | null = null;
  if (hasExplicitOptions && (options as Record<string, unknown>).ttl === "30m") requestedTtlMs = 30 * 60 * 1000;
  else if (identity.provider === "anthropic" && markers.count > 0) requestedTtlMs = markers.ttlMs ?? 5 * 60 * 1000;
  else if (markers.ttlMs !== null) requestedTtlMs = markers.ttlMs;
  const effectiveTtlMs = fallbackReason ? null : requestedTtlMs;
  const retentionKnown =
    identity.provider === "anthropic" && markers.count > 0
      ? true
      : identity.provider === "openai" && hasExplicitOptions
        ? true
        : requestedMode === "none"
          ? true
          : null;
  return {
    markers,
    policy: {
      provider: identity.provider,
      protocol: identity.protocol,
      model: identity.model,
      requestedMode: prior?.requestedMode ?? requestedMode,
      effectiveMode,
      requestedTtlMs: prior?.requestedTtlMs ?? requestedTtlMs,
      effectiveTtlMs,
      retentionKnown,
      fallbackReason,
    },
  };
}

function cacheDiagnosticsForRequest(
  body: Record<string, unknown>,
  identity: { provider: ProviderId; protocol: string; model: string },
  cacheIdentity: MainCacheIdentity | null,
  overlay: RequestOverlay | null,
  hostContext: HostContextTrace | null,
  fallbackReason: string | null = null,
  priorPolicy: CachePolicyDiagnostics | null = null,
  retryPromptIdentical: boolean | null = null,
): TraceCacheDiagnostics {
  const settings = { ...body };
  const tools = settings.tools ?? [];
  let serializedToolsHash: string | null = null;
  let serializedToolsBytes: number | null = null;
  try {
    const serializedTools = JSON.stringify(tools);
    if (serializedTools !== undefined) {
      serializedToolsHash = createHash("sha256").update(serializedTools, "utf8").digest("hex").slice(0, 16);
      serializedToolsBytes = Buffer.byteLength(serializedTools, "utf8");
    }
  } catch {
    /* A cyclic/unsupported schema remains explicitly unknown in the trace. */
  }
  delete settings.tools;
  let stableSystem = settings.instructions ?? settings.system ?? settings.systemInstruction ?? null;
  delete settings.instructions;
  delete settings.system;
  delete settings.systemInstruction;
  let messages = settings.input ?? settings.messages ?? settings.contents ?? [];
  delete settings.input;
  delete settings.messages;
  delete settings.contents;
  if (stableSystem === null && Array.isArray(messages) && messages[0]?.role === "system") {
    stableSystem = messages[0];
    messages = messages.slice(1);
  }
  delete settings.prompt_cache_key;
  delete settings.session_id;
  const modelSettings = { ...identity, request: settings };
  const policyDetails = cachePolicyFromBody(body, identity, priorPolicy, fallbackReason);
  // `toGoogleContents` coalesces adjacent user turns into one contents item,
  // so its last array element is not a reliable overlay boundary. Leave that
  // reusable-prefix hash unknown rather than claiming a prefix we cannot
  // reconstruct byte-for-byte after serialization.
  const persistedMessages = identity.protocol === "google-generate" && overlay
    ? undefined
    : Array.isArray(messages) && overlay ? messages.slice(0, -1) : messages;
  // A session seed is useful for deriving provider headers, but it is not a
  // provider-facing cache key on every route (for example direct Anthropic or
  // Gemini). Only report the identity hash when this request actually emits
  // a supported body/header identity.
  const diagnosticIdentity = cacheIdentity && (
    identity.provider === "openrouter" ||
    identity.provider === "xai" ||
    cacheCapabilitySupported(identity.provider, identity.model, CACHE_CAPABILITY_FEATURE.promptCacheKey)
  ) ? cacheIdentity : null;
  const base = cacheRequestDiagnostics({
    identity: diagnosticIdentity,
    policy: policyDetails.policy,
    modelSettings,
    tools,
    stablePrefix: { system: stableSystem, tools, settings: modelSettings },
    reusablePrefix: persistedMessages,
    messagePrefix: messages,
    workingSet: overlay?.text,
    workingSetChanged: currentWorkingSetChanged,
    markerCount: policyDetails.markers.count,
    markerPositions: policyDetails.markers.positions,
  });
  return {
    ...base,
    overlayHash: overlay?.hash ?? null,
    overlayBytes: overlay?.bytes ?? null,
    hostContext: hostContext ? { ...hostContext } : null,
    retryPromptIdentical,
    codexTurnStateUsed: identity.provider === "openai-codex" && Boolean(codexTurnState),
    serializedToolsHash,
    serializedToolsBytes,
    missAttribution: {
      attributed: null,
      primary: null,
      contributing: [],
      missedTokens: null,
      gapMs: null,
      missingFields: ["previous-attempt"],
      noiseFloorTokens: NOISE_FLOOR_TOKENS,
    },
  };
}

// ---- trace runtime integration ----
async function writeSummaryTrace(opts: {
  status: string;
  usage: Usage | null;
  started: number;
  seq: readonly [number, number] | null;
  revisions: number;
  kinds: readonly RevisionKind[];
  attempt?: TraceAttemptState | null;
  cache?: TraceCacheDiagnostics | null;
  cost?: TraceRecordCostInput | null;
  ttftMs?: number | null;
}): Promise<void> {
  await writeTraceAttempt(opts.attempt ?? null, {
    status: opts.status,
    storageSeqRange: opts.seq,
    toolNames: [],
    usage: opts.usage,
    usd: opts.cost && typeof opts.cost.usd === "number" ? opts.cost.usd : null,
    ttftMs: opts.ttftMs ?? null,
    turnMs: opts.attempt?.ended !== null && opts.attempt?.ended !== undefined
      ? Math.max(0, opts.attempt.ended - opts.attempt.started)
      : Date.now() - opts.started,
    revisions: opts.revisions,
    revisionKinds: opts.kinds,
    // Summary attempts do not run cache-miss attribution. Absence of evidence
    // is unknown, not proof that the attempt wasted zero tokens.
    wasteTokens: null,
    wasteCause: null,
    cache: opts.cache ?? null,
    cost: opts.cost ?? traceCostForUsage(
      opts.usage,
      opts.attempt?.provider ?? summaryRoute.provider,
      opts.attempt?.model ?? summaryRoute.model,
      "summary",
      opts.cache ?? null,
    ),
  });
}

async function writeMainTrace(opts: {
  status: string;
  seqBefore: number;
  toolNames: string[];
  usage: Usage | null;
  waste: {
    usd: number | null;
    ttftMs: number | null;
    turnMs: number;
    revisionCount: number;
    revisionKinds: readonly RevisionKind[];
    wasteTokens: number | null;
    cause: string | null;
    cost?: TraceRecordCostInput | null;
  } | null;
  sysHash: string;
  cache: TraceCacheDiagnostics | null;
  started: number;
  attempt?: TraceAttemptState | null;
  toolOutcomes?: readonly unknown[];
  reclaimEvidence?: unknown;
}): Promise<void> {
  const w = opts.waste;
  const reclaimEvidence = opts.reclaimEvidence === undefined
    ? pendingReclaimEvidence
    : opts.reclaimEvidence;
  if (opts.reclaimEvidence === undefined) pendingReclaimEvidence = null;
  await writeTraceAttempt(opts.attempt ?? inFlightTraceAttempt, {
    status: opts.status,
    storageSeqRange: storageSeqRange(opts.seqBefore, storageSeq),
    toolNames: opts.toolNames,
    usage: opts.usage,
    usd: w?.usd ?? null,
    cost: w?.cost ?? traceCostForUsage(
      opts.usage,
      opts.attempt?.provider ?? route.provider,
      opts.attempt?.model ?? route.model,
      "main",
      opts.cache,
    ),
    ttftMs: w?.ttftMs ?? null,
    turnMs: opts.attempt?.ended !== null && opts.attempt?.ended !== undefined
      ? Math.max(0, opts.attempt.ended - opts.attempt.started)
      : w ? w.turnMs : Date.now() - opts.started,
    revisions: w ? w.revisionCount : revisions,
    revisionKinds: w ? w.revisionKinds.slice() as readonly RevisionKind[] : revisionKinds.slice(),
    wasteTokens: w?.wasteTokens ?? null,
    wasteCause: w?.cause ?? null,
    cache: opts.cache,
    toolOutcomes: opts.toolOutcomes,
    reclaimEvidence,
  });
}

// ---- append-only session storage ----

const sessionFile = resolveSessionFile(eventsDir, sessionId, sessionEnvironment.TERMINA_CORE_SESSION_FILE);
let storageSeq = 0;
let sessionWriter: SessionWriter | null = null;
let resumeBusy = false;

class SessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStoreError";
  }
}

function closeSessionWriter(): void {
  sessionWriter?.close();
  sessionWriter = null;
}

function openSessionWriter(): void {
  closeSessionWriter();
  if (!sessionFile) return;
  const opened = SessionWriter.open(sessionFile, storageSeq);
  if (!opened.ok) throw new SessionStoreError(opened.error);
  sessionWriter = opened.writer;
}

function ensureFreshSession(): void {
  if (streamPrepared) return;
  if (sessionFile) {
    closeSessionWriter();
    const prep = prepareFreshSession(sessionFile);
    if (!prep.ok) throw new SessionStoreError(prep.error);
    storageSeq = 0;
    openSessionWriter();
  }
  storageSeq = 0;
  streamPrepared = true;
}

/**
 * Persist one record, then return its durable sequence. In-memory sessions
 * increment without a file. A configured writer must succeed before the
 * caller mutates live history.
 */
function persist(entry: Record<string, unknown>): number {
  const sseq = storageSeq + 1;
  if (!sessionFile) {
    storageSeq = sseq;
    return sseq;
  }
  if (!sessionWriter) throw new SessionStoreError("session writer is not open");
  const result = sessionWriter.appendRecord({ ...entry, storageSeq: sseq });
  if (!result.ok) throw new SessionStoreError(result.error);
  storageSeq = sseq;
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

/** Zone 1 identity. Do not ask in chat to edit ordinary project files.
 *  Host notes that name a file not to touch (Mine, sibling claims) still bind. */
export const FROZEN_IDENTITY = [
  "You are the Termina agent-core. Be terse. Use tools to do real work in the user's project.",
  "For clear, reversible local work, do it in the current turn instead of asking permission conversationally. Follow an explicit host instruction not to touch a file. Prefer edit on existing files, grep/glob over bash search, and read before edit.",
].join("\n");

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
    FROZEN_IDENTITY,
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
  const skillXml = formatCompactSkillIndex(scanned.skills, {
    roots: skillDirs,
    capBytes: SKILL_XML_CAP,
    capped: scanned.capped,
  });
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
    start_line?: unknown;
    end_line?: unknown;
    pattern?: string;
    glob?: string;
    query?: string;
    old_text?: string;
    new_text?: string;
    [key: string]: unknown;
  };
}

/**
 * Result shape shared by filesystem/process/network tools.
 *
 * `content` is the bounded rendering that is safe to put in the next model
 * request.  The original stream accounting remains on `bounded`; process
 * tools additionally keep independent stdout/stderr results and exit status.
 * A continuation is deliberately metadata (the actionable hint is also in
 * the bounded text marker) so it cannot leak as an unrecognised provider
 * content block.
 */
export type ToolTextResult = BoundedToolResult & {
  continuation?: string | McpContinuation | null;
  repro?: string | null;
  stdout?: BoundedText;
  stderr?: BoundedText;
  exitCode?: number | null;
  signal?: string | null;
};

type BoundedOutcomeMetadata = Pick<
  BoundedText,
  "state" | "direction" | "limitBytes" | "inputBytes" | "retainedBytes" | "omittedBytes" | "outputBytes" | "truncated"
>;

interface ToolOutcome {
  result: Record<string, unknown>;
  isError: boolean;
  /** Preserve bounded MCP accounting through the generic tool boundary. */
  bounded?: BoundedOutcomeMetadata;
  cancellationScope?: McpCancellationScope;
  continuation?: string | McpContinuation | null;
  repro?: string | null;
  stdout?: BoundedText;
  stderr?: BoundedText;
  exitCode?: number | null;
  signal?: string | null;
}

function toolResult(use: ToolUse, content: string): Record<string, unknown> {
  return { type: "tool_result", tool_use_id: use.id, content };
}

function boundedMetadata(value: BoundedText): BoundedOutcomeMetadata {
  return {
    state: value.state,
    direction: value.direction,
    limitBytes: value.limitBytes,
    inputBytes: value.inputBytes,
    retainedBytes: value.retainedBytes,
    omittedBytes: value.omittedBytes,
    outputBytes: value.outputBytes,
    truncated: value.truncated,
  };
}

function genericToolText(content: string, isError: boolean): ToolTextResult {
  return boundedToolResult(content, {
    maxBytes: GREP_BYTE_CAP,
    direction: "head",
    marker: isError ? "" : "[output truncated — re-run the tool for the rest]",
    state: isError ? "failed" : "complete",
    isError,
  });
}

/** Render an actionable continuation even when the operation itself was
 * complete but its page/result was intentionally shortened (for example the
 * 200-entry glob page). */
function logicalToolText(
  content: string,
  opts: {
    maxBytes: number;
    state: CompletionState;
    isError: boolean;
    marker?: string | null;
    repro?: string | null;
    forceMarker?: boolean;
    continuation?: string | McpContinuation | null;
  },
): ToolTextResult {
  const marker = opts.marker === undefined
    ? "[output truncated — re-run the tool for the rest]"
    : opts.marker ?? "";
  if (!opts.forceMarker || !marker) {
    return Object.freeze({
      ...boundedToolResult(content, {
        maxBytes: opts.maxBytes,
        direction: "head",
        marker,
        state: opts.state,
        isError: opts.isError,
      }),
      continuation: opts.continuation ?? (marker || null),
      repro: opts.repro ?? null,
    });
  }
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const bodyLimit = Math.max(0, opts.maxBytes - markerBytes - 1);
  const body = boundedToolResult(content, {
    maxBytes: bodyLimit,
    direction: "head",
    marker: "",
    state: opts.state,
    isError: opts.isError,
  });
  const combined = body.content ? `${body.content}\n${marker}` : marker;
  const final = boundedToolResult(combined, {
    maxBytes: opts.maxBytes,
    direction: "head",
    marker: "",
    state: opts.state,
    isError: opts.isError,
  });
  return Object.freeze({
    ...final,
    truncated: true,
    continuation: opts.continuation ?? marker,
    repro: opts.repro ?? null,
  });
}

function done(use: ToolUse, value: string | ToolTextResult, isError?: boolean): ToolOutcome {
  const output = typeof value === "string"
    ? Object.freeze({ ...genericToolText(value, isError === true), repro: reproFor(use) ?? null })
    : value;
  return {
    result: toolResult(use, output.content),
    isError: output.isError,
    bounded: boundedMetadata(output),
    continuation: output.continuation ?? null,
    repro: output.repro ?? null,
    ...(output.stdout ? { stdout: output.stdout } : {}),
    ...(output.stderr ? { stderr: output.stderr } : {}),
    ...(output.exitCode === undefined ? {} : { exitCode: output.exitCode }),
    ...(output.signal === undefined ? {} : { signal: output.signal }),
  };
}

function toolOutcomeTraceFields(outcome: ToolOutcome): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (outcome.bounded) fields.bounded = { ...outcome.bounded };
  if (outcome.cancellationScope) fields.cancellationScope = outcome.cancellationScope;
  if (outcome.continuation) fields.continuation = outcome.continuation;
  if (outcome.repro) fields.repro = outcome.repro;
  if (outcome.stdout) fields.stdout = { ...boundedMetadata(outcome.stdout) };
  if (outcome.stderr) fields.stderr = { ...boundedMetadata(outcome.stderr) };
  if (outcome.exitCode !== undefined) fields.exitCode = outcome.exitCode;
  if (outcome.signal !== undefined) fields.signal = outcome.signal;
  return fields;
}

function toolOutcomeTraceInput(use: ToolUse, outcome: ToolOutcome): Record<string, unknown> {
  return {
    toolName: use.name,
    toolCallId: use.id,
    isError: outcome.isError,
    ...toolOutcomeTraceFields(outcome),
  };
}

export function shellQuote(raw: string): string {
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80);
  return `'${cleaned.replace(/'/g, `'\\''`)}'`;
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
      Object.assign(start, boundedSidecarEdits([{ oldText: use.input.old_text ?? "", newText: use.input.new_text ?? "" }]));
    }
    return start;
  }
  return { t: "tool", toolName: use.name, toolCallId: use.id };
}

export function formatToolAnnounce(use: ToolUse): string {
  let detail = "";
  if (use.name === "edit" || use.name === "write_file" || use.name === "read_file") detail = use.input.path ?? "";
  else if (use.name === "bash") detail = `$ ${use.input.command ?? ""}`;
  else if (use.name === "grep") detail = use.input.pattern ?? "";
  else if (use.name === "glob") detail = use.input.pattern ?? "";
  else if (use.name === "fetch") detail = String(use.input.url ?? "");
  return `◆ Tool · ${use.name}${detail ? `\n  ${detail}` : ""}`;
}

function capDisplay(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

export function formatToolFollowup(use: ToolUse, outcome: { result: Record<string, unknown>; isError: boolean }): string {
  const content = typeof outcome.result.content === "string" ? outcome.result.content : "";
  const status = outcome.isError ? "failed" : "done";
  if (use.name === "bash") {
    const shown = displayToolOutput(content);
    return `◇ ${use.name} · ${status}${shown ? `\n${shown}` : ""}\n`;
  }
  if (outcome.isError) {
    const shown = displayToolOutput(content);
    return `◇ ${use.name} · failed${shown ? `\n${shown}` : ""}\n`;
  }
  if (use.name === "grep" || use.name === "glob") {
    if (content === "(no matches)") return `◇ ${use.name} · done · no matches\n`;
    if (use.name === "grep") {
      const hm = /^(\d+\+?) hits? in /.exec(content);
      if (hm) return `◇ grep · done · ${hm[1]} hits\n`;
    }
    const n = content === "" ? 0 : content.split("\n").length;
    return `◇ ${use.name} · done · ${n} ${use.name === "grep" ? "hits" : "files"}\n`;
  }
  return `◇ ${use.name} · done\n`;
}

export function runBash(
  command: string,
  opts: { cwd: string; timeoutMs?: number; shouldStop?: () => boolean },
): Promise<ToolTextResult> {
  const timeoutMs = opts.timeoutMs ?? BASH_TIMEOUT_MS;
  const repro = `bash ${shellQuote(command)}`;
  const continuation = `Re-run the command with a narrower output or redirect noisy streams: ${repro}`;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      env.PATH = trustedPath(process.env.PATH, opts.cwd);
      child = spawn("/bin/bash", ["-c", command], {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      resolve(logicalToolText(`error: ${(err as Error).message}`, {
        maxBytes: BASH_CAP_BYTES,
        state: "failed",
        isError: true,
        repro,
      }));
      return;
    }
    const pid = child.pid;
    const stdout = new BoundedTextAccumulator({ maxBytes: BASH_CAP_BYTES, direction: "tail", marker: "" });
    const stderr = new BoundedTextAccumulator({ maxBytes: BASH_CAP_BYTES, direction: "tail", marker: "" });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let settled = false;
    let timedOut = false;
    let interruptedByUser = false;
    let stopCallbackFailed = false;
    let spawnFailed = false;
    const shouldStop = (): boolean => {
      try {
        return opts.shouldStop?.() === true;
      } catch {
        stopCallbackFailed = true;
        return true;
      }
    };
    const killGroup = (): void => {
      if (process.platform !== "win32" && typeof pid === "number" && pid > 0) {
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
    const finish = (status: { code?: number | null; signal?: string | null; failed: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      const state: CompletionState = timedOut
        ? "timeout"
        : stopCallbackFailed
          ? "failed"
          : interruptedByUser
          ? "interrupted"
          : spawnFailed
            ? "failed"
            : status.failed
              ? "failed"
              : "complete";
      const stdoutResult = stdout.finish(state);
      const stderrResult = stderr.finish(state);
      const parts = [stdoutResult.text, stderrResult.text];
      const tag = typeof status.code === "number" ? String(status.code) : status.signal ?? "error";
      let body = `${parts.filter(Boolean).join("\n") || "(no output)"}\n[exit ${tag}]`;
      const outputTruncated = stdoutResult.truncated || stderrResult.truncated;
      if (outputTruncated || state !== "complete") body += `\n${continuation}`;
      const rendered = boundedToolResult(body, {
        maxBytes: BASH_CAP_BYTES,
        direction: "tail",
        marker: "",
        state,
        isError: state !== "complete" || status.failed,
      });
      resolve(Object.freeze({
        ...rendered,
        truncated: rendered.truncated || outputTruncated,
        continuation: outputTruncated || state !== "complete" ? continuation : null,
        repro,
        stdout: stdoutResult,
        stderr: stderrResult,
        exitCode: typeof status.code === "number" ? status.code : null,
        signal: status.signal ?? null,
      }));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const poll = setInterval(() => {
      if (shouldStop()) {
        interruptedByUser = true;
        killGroup();
      }
    }, 50);
    if (shouldStop()) {
      interruptedByUser = true;
      killGroup();
    }
    child.on("error", (e) => {
      spawnFailed = true;
      finish({ signal: e.message, failed: true });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, failed: !(code === 0 && !signal) });
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
): Promise<ToolTextResult> {
  const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const repro = `fetch ${shellQuote(url)}`;
  const continuation = `Re-run fetch with a narrower response or inspect the URL in smaller ranges: ${repro}`;
  let stopCallbackFailed = false;
  const shouldStop = (): boolean => {
    try {
      return opts?.shouldStop?.() === true;
    } catch {
      stopCallbackFailed = true;
      return true;
    }
  };
  const fail = (content: string, state: CompletionState = "failed"): ToolTextResult => logicalToolText(content, {
    maxBytes: FETCH_CAP_BYTES,
    state,
    isError: true,
    repro,
  });
  let current = url;
  for (let hop = 0; hop <= FETCH_REDIRECT_CAP; hop++) {
    const bad = fetchUrlError(current);
    if (bad) return fail(bad);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const poll = setInterval(() => {
      if (shouldStop()) ac.abort();
    }, 50);
    if (shouldStop()) ac.abort();
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
          await res.body?.cancel();
        } catch {
          /* best effort: redirect bodies are never retained */
        }
        if (!loc) return fail("error: redirect without location");
        try {
          current = new URL(loc, current).href;
        } catch {
          return fail("error: invalid redirect location");
        }
        continue;
      }
      if (!res.ok) {
        const detailAccumulator = new BoundedTextAccumulator({ maxBytes: 2 * 1024, direction: "head", marker: "" });
        let detailSeen = 0;
        if (res.body) {
          const reader = res.body.getReader();
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              detailAccumulator.push(next.value);
              detailSeen += next.value.byteLength;
              if (detailSeen > 2 * 1024) {
                await reader.cancel();
                break;
              }
            }
          } finally {
            reader.releaseLock();
          }
        }
        const detailResult = detailAccumulator.finish();
        const detail = detailResult.text.trim();
        const errorBody = `error: HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
        if (detailResult.truncated) {
          return logicalToolText(errorBody, {
            maxBytes: FETCH_CAP_BYTES,
            state: "failed",
            isError: true,
            forceMarker: true,
            marker: continuation,
            continuation,
            repro,
          });
        }
        return fail(errorBody);
      }
      const body = new BoundedTextAccumulator({ maxBytes: FETCH_CAP_BYTES, direction: "head", marker: "" });
      let sourceTruncated = false;
      let bodySeen = 0;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            body.push(next.value);
            bodySeen += next.value.byteLength;
            if (bodySeen > FETCH_CAP_BYTES) {
              sourceTruncated = true;
              await reader.cancel();
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      const bodyResult = body.finish();
      const result = logicalToolText(bodyResult.text, {
        maxBytes: FETCH_CAP_BYTES,
        state: "complete",
        isError: false,
        forceMarker: sourceTruncated || bodyResult.truncated,
        marker: continuation,
        continuation: sourceTruncated || bodyResult.truncated ? continuation : null,
        repro,
      });
      return Object.freeze({
        ...result,
        inputBytes: bodyResult.inputBytes,
        retainedBytes: bodyResult.retainedBytes,
        omittedBytes: bodyResult.omittedBytes,
        truncated: result.truncated || sourceTruncated || bodyResult.truncated,
      });
    } catch (err) {
      const stopRequested = shouldStop();
      const msg = stopCallbackFailed
        ? "error: stop callback failed"
        : (err as Error).name === "AbortError" || /aborted/i.test((err as Error).message)
        ? stopRequested ? "error: interrupted" : "error: timed out"
        : `error: ${(err as Error).message}`;
      return fail(msg, stopCallbackFailed ? "failed" : stopRequested ? "interrupted" : /timed out/i.test(msg) ? "timeout" : "failed");
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
    }
  }
  return fail("error: too many redirects");
}

export type PermissionMode = "always" | "dangerous" | "ask";

export function isDangerousBash(command: string): boolean {
  const text = command.replace(/\\\n/g, " ");
  return (
    /\b(?:sudo|doas|su|rm|rmdir|unlink|shred|truncate|mkfs|fdisk|parted|shutdown|reboot|halt|poweroff|chmod|chown|kill|pkill|killall)\b/i.test(text) ||
    /\bdd\b[^\n]*\bof=/i.test(text) ||
    /\bfind\b[^\n]*(?:\s-delete\b|\s-exec\b)/i.test(text) ||
    /\bgit\b[^\n;&|]*\b(?:clean\b|restore\b|push\b|reset\s+--hard\b|checkout\s+--\b)/i.test(text) ||
    /\b(?:npm|pnpm|yarn)\s+publish\b/i.test(text) ||
    /\b(?:curl|wget)\b[^\n]*\|\s*(?:env\s+)?(?:ba|z|k|c)?sh\b/i.test(text) ||
    /\b(?:python\d*|node|ruby|perl|(?:ba|z|k|c)?sh)\b[^\n]*(?:\s-c\b|\s-e\b)/i.test(text)
  );
}

export function shouldAskPermission(mode: PermissionMode, command: string): boolean {
  return mode === "ask" || (mode === "dangerous" && isDangerousBash(command));
}

let permissionMode: PermissionMode = process.env.TERMINA_CORE_APPROVE === "all" ? "always" : "ask";
let approvalResolve: ((line: string) => void) | null = null;
let approvalQueue = Promise.resolve();
const protectedTaskApprovals = new Set<string>();

/** Resolve an in-flight permission prompt before tearing down its surface. */
export function cancelPendingApproval(line = "/approve deny"): boolean {
  const resolve = approvalResolve;
  if (!resolve) return false;
  approvalResolve = null;
  surface?.clearChoices();
  resolve(line);
  return true;
}

async function confirmBashNow(command: string): Promise<boolean> {
  if (interrupted) return false;
  if (!shouldAskPermission(permissionMode, command)) return true;
  if (!surface?.active()) return false;
  surface.setChoices(`Approve bash? ${command.slice(0, 160)}`, [
    { name: "Deny", hint: "reject this command", submit: "/approve deny" },
    { name: "Approve once", hint: "run this command", submit: "/approve once" },
    { name: "Always approve", hint: "run bash without asking this session", submit: "/approve always" },
  ]);
  const line = await new Promise<string>((resolve) => {
    approvalResolve = resolve;
  });
  if (approvalResolve) approvalResolve = null;
  surface?.clearChoices();
  if (line === "/approve always") {
    permissionMode = "always";
    surface?.setStatus({ permissions: permissionMode });
    return true;
  }
  return line === "/approve once";
}

async function queueApproval(confirm: () => Promise<boolean>): Promise<boolean> {
  const previous = approvalQueue;
  let release!: () => void;
  approvalQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await confirm();
  } finally {
    release();
  }
}

async function confirmBash(command: string): Promise<boolean> {
  return queueApproval(() => confirmBashNow(command));
}

async function confirmProtectedMutationNow(inputPath: string | undefined): Promise<boolean> {
  if (interrupted) return false;
  if (!eventsDir || !terminalId) return true;
  const confined = confinePath(canonicalCwd, inputPath);
  if (!confined.ok) return true;
  const target = confined.abs;
  if (!readProtectedPaths(eventsDir, terminalId).has(target) || protectedTaskApprovals.has(target)) return true;
  if (!surface?.active()) return false;
  const label = relative(canonicalCwd, target) || target;
  surface.setChoices(`Approve protected file edit? ${label}`, [
    { name: "Deny", hint: "leave this file unchanged", submit: "/approve deny" },
    { name: "Approve", hint: "allow edits to this file for this task", submit: "/approve protected" },
  ]);
  const line = await new Promise<string>((resolve) => {
    approvalResolve = resolve;
  });
  if (approvalResolve) approvalResolve = null;
  surface?.clearChoices();
  if (line !== "/approve protected") return false;
  protectedTaskApprovals.add(target);
  return true;
}

async function confirmProtectedMutation(inputPath: string | undefined): Promise<boolean> {
  return queueApproval(() => confirmProtectedMutationNow(inputPath));
}

async function executeTool(use: ToolUse): Promise<ToolOutcome> {
  if (use.name === "read_file") {
    const got = readProjectFile(canonicalCwd, use.input, allowPaths);
    return done(use, got);
  }
  if (use.name === "write_file") {
    if (!(await confirmProtectedMutation(use.input.path))) return done(use, "error: protected file edit denied", true);
    const got = writeProjectFile(canonicalCwd, use.input.path, use.input.content ?? "");
    return done(use, got.content, got.isError);
  }
  if (use.name === "edit") {
    if (!(await confirmProtectedMutation(use.input.path))) return done(use, "error: protected file edit denied", true);
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
    return done(use, out);
  }
  if (use.name === "glob") {
    const out = await globFiles(canonicalCwd, use.input.pattern ?? "", { shouldStop: () => interrupted });
    return done(use, out);
  }
  if (use.name === "web_search") {
    return done(use, "error: web_search is provider-executed", true);
  }
  if (use.name === "fetch") {
    const got = await fetchUrl(String(use.input.url ?? ""), { shouldStop: () => interrupted });
    return done(use, got);
  }
  if (use.name === "bash") {
    const command = use.input.command ?? "";
    if (!(await confirmBash(command))) return done(use, "error: bash denied", true);
    const got = await runBash(command, { cwd: canonicalCwd, shouldStop: () => interrupted });
    return done(use, got);
  }
  if (mcpSession?.tools.some((t) => t.name === use.name)) {
    const got = await mcpSession.call(use.name, use.input, { shouldStop: () => interrupted });
    return {
      result: toolResult(use, got.content),
      isError: got.isError,
    bounded: {
        state: got.state,
        direction: got.direction,
        limitBytes: got.limitBytes,
        inputBytes: got.inputBytes,
        retainedBytes: got.retainedBytes,
        omittedBytes: got.omittedBytes,
        outputBytes: got.outputBytes,
        truncated: got.truncated,
      },
      cancellationScope: got.cancellationScope,
      continuation: got.continuation,
      repro: reproFor(use) ?? null,
    };
  }
  return done(use, `error: unknown tool ${use.name}`, true);
}

const TOOLS = [
  {
    name: "read_file",
    description:
      "Read a text file relative to the working directory. Each line is prefixed with its 1-based line number and a pipe; do not include those prefixes in edit old_text. Caps near 40 KB of file bytes. Optional start_line and end_line (inclusive). Pass offset (bytes) only to continue a truncated read; do not combine with start_line. A directory path lists that directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        start_line: { type: "number" },
        end_line: { type: "number" },
      },
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
      "Replace old_text with new_text in a file. Default: one unique occurrence (fails if missing or repeated). Set replace_all to replace every occurrence. Prefer this over write_file for existing files. Miss errors include occurrence count and nearby lines.",
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
    description:
      "Search file contents with a regular expression. Uses ripgrep when available. Prefer this over bash rg or grep. Groups hits by file, shows sparse files first, and caps per file. Skip ignored directories. Narrow with path or glob when a file has more hits.",
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
    description:
      "Run one bash command in the working directory. 60 s timeout. Combined output caps near 20 KB and always ends with [exit N]. Use grep or glob for file search; do not call rg.",
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
let mcpBusy = false;
let mcpGeneration = 0;

async function connectMcp(): Promise<void> {
  const generation = ++mcpGeneration;
  mcpSession?.shutdown();
  mcpSession = null;
  clientTools = TOOLS.slice();
  syncIndicators();
  try {
    const session = await startMcp(loadMcpConfigs(userMcpPath(homedir())), {
      projectRoot: canonicalCwd,
      confineCwd: (cwd) => jailMcpCwd(canonicalCwd, cwd),
    });
    if (generation !== mcpGeneration) {
      session.shutdown();
      return;
    }
    mcpSession = session;
    clientTools = mergeClientTools(TOOLS, mcpToolDefs(session.tools));
    syncIndicators();
    for (const note of session.notes) out(`(${note})\n`);
  } catch (error) {
    if (generation !== mcpGeneration) return;
    mcpSession = null;
    clientTools = TOOLS.slice();
    syncIndicators();
    out(`(MCP unavailable; built-in tools remain: ${error instanceof Error ? error.message : String(error)})\n`);
  }
}

/** Provider-executed search. Same Anthropic key as the model. No Brave key. */
export const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 5,
} as const;

export type AnthropicCacheMark = { type: "ephemeral" };

/** Anthropic's default five-minute TTL is sliding and avoids the 1-hour write premium. */
export function anthropicCacheMark(): AnthropicCacheMark {
  return { type: "ephemeral" };
}

export function buildCachedPrefix(
  system: string,
  tools: Array<Record<string, unknown>>,
): {
  system: Array<{ type: "text"; text: string; cache_control: AnthropicCacheMark }>;
  tools: Array<Record<string, unknown> & { cache_control?: AnthropicCacheMark }>;
} {
  const mark = anthropicCacheMark();
  // Anthropic permits at most four explicit breakpoints. The system marker
  // consumes one, leaving three for tools. Preserve existing markers in
  // discovery order and only add the final-tool marker when budget remains.
  let toolMarkers = 0;
  const copied = tools.map((tool, index) => {
    const existing = Object.prototype.hasOwnProperty.call(tool, "cache_control");
    if (existing && toolMarkers < 3) {
      toolMarkers++;
      return { ...tool };
    }
    if (existing) {
      const { cache_control: _cacheControl, ...withoutMarker } = tool;
      return { ...withoutMarker };
    }
    if (index === tools.length - 1 && toolMarkers < 3) {
      toolMarkers++;
      return { ...tool, cache_control: mark };
    }
    return { ...tool };
  });
  return {
    system: [{ type: "text", text: system, cache_control: mark }],
    tools: copied,
  };
}

const HISTORY_CACHE_BLOCKS = new Set(["text", "tool_result", "image"]);

/** Stamp cache_control on the last stable history block. Skip thinking and
 *  tool_use. Only the provider's documented 20-block lookback is eligible. */
export function stampHistoryCache(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  const mark = anthropicCacheMark();
  let lookback = 20;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (typeof m.content === "string") {
      if (lookback <= 0) break;
      lookback--;
      if (!m.content) continue;
      const next = messages.slice();
      next[i] = {
        ...m,
        content: [{ type: "text", text: m.content, cache_control: mark }],
      };
      return next;
    }
    if (!Array.isArray(m.content)) continue;
    const blocks = m.content as Array<Record<string, unknown>>;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]!;
      if (lookback <= 0) return messages;
      lookback--;
      if (typeof b.type !== "string" || !HISTORY_CACHE_BLOCKS.has(b.type)) continue;
      if (Object.prototype.hasOwnProperty.call(b, "cache_control")) return messages;
      const next = messages.slice();
      const copied = blocks.slice();
      copied[j] = { ...b, cache_control: mark };
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

/** Append Anthropic server search after cached client tools.
 *  Only the Anthropic login: web_search is executed with that org's key
 *  and must be enabled in the Anthropic console. OpenCode Zen and
 *  OpenRouter do not run that tool; they 400 or ignore it. */
export function requestTools(
  cachedClientTools: Array<Record<string, unknown>>,
  provider: string = "anthropic",
  model: string = "",
): Array<Record<string, unknown>> {
  if (provider !== "anthropic") return cachedClientTools;
  const type = claudeThinkingApi(model) === "adaptive" ? WEB_SEARCH_TOOL.type : "web_search_20250305";
  return [...cachedClientTools, { type, name: "web_search", max_uses: 5 }];
}

function logToolStart(use: ToolUse): void {
  logEvent(sidecarStartFor(use));
}

function toolTranscriptDetail(use: ToolUse): string {
  if (use.name === "edit" || use.name === "write_file" || use.name === "read_file") return use.input.path ?? "";
  if (use.name === "bash") return use.input.command ?? "";
  if (use.name === "grep" || use.name === "glob") return use.input.pattern ?? "";
  if (use.name === "fetch") return String(use.input.url ?? "");
  return "";
}

const TOOL_TRUNCATION_HINT = "…[truncated — re-run or read_file for the rest]";

export function displayToolOutput(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= TOOL_DISPLAY_BYTES) return content;
  return `${capDisplay(content, TOOL_DISPLAY_BYTES)}\n${TOOL_TRUNCATION_HINT}`;
}

function toolTranscriptOutput(outcome: ToolOutcome): string {
  const content = typeof outcome.result.content === "string" ? outcome.result.content : "";
  return displayToolOutput(content);
}

function blockInput(block: ContentBlock): ToolUse["input"] {
  const raw = block.input;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ToolUse["input"];
  return {};
}

function blockBodyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function replayToolOutput(text: string): string {
  return displayToolOutput(text);
}

function replayToolState(block: ContentBlock, text: string): "success" | "error" {
  if (block.is_error === true || block.isError === true) return "error";
  if (text.startsWith("error:")) return "error";
  return "success";
}

function paintPlain(tui: AgentTui | null, text: string): void {
  if (!text) return;
  if (tui) tui.appendPlain(text);
  else process.stdout.write(text);
}

function paintUserEcho(tui: AgentTui | null, text: string): void {
  const body = text.trimEnd();
  if (!body) return;
  paintPlain(tui, `\n> ${body}\n`);
}

/** Paint stored messages into the live transcript. Skip encrypted reasoning. */
export function renderHistoryTranscript(
  messages: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }>,
  tui: AgentTui | null,
): void {
  const pending: Array<{ id: string; handle: TranscriptHandle | null }> = [];

  const writeFollowup = (state: "success" | "error" | "cancelled", output?: string): void => {
    const label = state === "error" ? "failed" : state === "cancelled" ? "cancelled" : "done";
    process.stdout.write(`◇ ${label}${output ? `\n${output}` : ""}\n`);
  };

  const finishHandle = (handle: TranscriptHandle | null, state: "success" | "error" | "cancelled", output?: string): void => {
    if (handle && tui) tui.finishTool(handle, state, output);
    else if (!tui) writeFollowup(state, output);
  };

  const finish = (id: string, state: "success" | "error" | "cancelled", output?: string): void => {
    let idx = pending.findIndex((item) => item.id === id);
    if (idx < 0 && !id) idx = 0;
    if (idx < 0 || idx >= pending.length) {
      if (tui) {
        const handle = tui.startTool("tool", "");
        tui.finishTool(handle, state, output);
      } else writeFollowup(state, output);
      return;
    }
    const rec = pending.splice(idx, 1)[0]!;
    finishHandle(rec.handle, state, output);
  };

  const start = (id: string, name: string, detail: string, announce: string): void => {
    if (tui) pending.push({ id, handle: tui.startTool(name, detail) });
    else {
      process.stdout.write(`\n${announce}\n`);
      pending.push({ id, handle: null });
    }
  };

  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      if (content.startsWith("<context-handoff>")) {
        const handoff = content.replace(/<\/?context-handoff>/g, "").trim();
        if (handoff) paintPlain(tui, `${handoff}\n`);
        continue;
      }
      if (message.role === "user") paintUserEcho(tui, content);
      else if (tui) tui.appendAssistant(content);
      else process.stdout.write(content);
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "redacted_thinking") continue;
      if (block.type === "thinking") {
        const text = String(block.thinking ?? "");
        if (!text) continue;
        if (tui) tui.appendThinking(text);
        else process.stdout.write(`\n◆ Thinking\n${text}`);
        continue;
      }
      if (block.type === "text") {
        const text = String(block.text ?? "");
        if (!text) continue;
        if (message.role === "user") paintUserEcho(tui, text);
        else if (tui) tui.appendAssistant(text);
        else process.stdout.write(text);
        continue;
      }
      if (block.type === "image") {
        paintPlain(tui, "(image)\n");
        continue;
      }
      if (block.type === "tool_use" || block.type === "server_tool_use") {
        const name = String(block.name ?? (block.type === "server_tool_use" ? "web_search" : "tool"));
        const use: ToolUse = { id: String(block.id ?? ""), name, input: blockInput(block) };
        start(use.id, name, toolTranscriptDetail(use), formatToolAnnounce(use));
        continue;
      }
      if (block.type === "tool_result" || block.type === "web_search_tool_result") {
        const id = String(block.tool_use_id ?? block.toolUseId ?? "");
        const text = replayToolOutput(blockBodyText(block.content));
        const err =
          block.type === "web_search_tool_result" &&
          Boolean(block.content) &&
          typeof block.content === "object" &&
          !Array.isArray(block.content) &&
          (block.content as { type?: string }).type === "web_search_tool_result_error";
        finish(id, err ? "error" : replayToolState(block, text), text);
        continue;
      }
    }
  }
  while (pending.length > 0) {
    const rec = pending.pop()!;
    finishHandle(rec.handle, "cancelled");
  }
}

function renderServerTools(
  blocks: Array<{ type: string; id?: string; name?: string; tool_use_id?: string; content?: unknown }>,
): string[] {
  const names: string[] = [];
  const unmatched: Array<{ providerId: string; handle: ReturnType<NonNullable<typeof surface>["startTool"]> }> = [];
  for (const b of blocks) {
    if (b.type === "server_tool_use") {
      const name = b.name ?? "web_search";
      names.push(name);
      logEvent(sidecarStartFor({ name, id: b.id ?? "", input: {} }));
      nonTtyTranscriptSection = null;
      if (surface) {
        const handle = surface.startTool(name, "");
        unmatched.push({ providerId: b.id ?? "", handle });
      } else {
        process.stdout.write(`\n◆ Tool · ${name}\n`);
      }
    } else if (b.type === "web_search_tool_result") {
      const err =
        Boolean(b.content) &&
        typeof b.content === "object" &&
        !Array.isArray(b.content) &&
        (b.content as { type?: string }).type === "web_search_tool_result_error";
      if (b.tool_use_id) logEvent({ t: "tool_end", toolCallId: b.tool_use_id, isError: err });
      if (surface) {
        const idx = unmatched.findIndex((item) => item.providerId && item.providerId === (b.tool_use_id ?? ""));
        const rec = idx >= 0 ? unmatched.splice(idx, 1)[0] : unmatched.shift();
        if (rec) surface.finishTool(rec.handle, err ? "error" : "success");
      } else {
        process.stdout.write(`◇ ${err ? "failed" : "done"}\n`);
      }
    }
  }
  for (const rec of unmatched) surface?.finishTool(rec.handle, "cancelled");
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

function isUserPrompt(m: { role: string; content: unknown }): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return Array.isArray(m.content) && m.content.some((b) => {
    if (!b || typeof b !== "object") return false;
    const type = (b as { type?: unknown }).type;
    return type === "text" || type === "image";
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
  const sseq = persist({ type: "message", message: { role, content } });
  const m: Message = { role, content, tokens: estimateReclaimTokens(content), sseq };
  history.push(m);
  syncIndicators();
  return m;
}

/** Provider-neutral projection used by main and focused integration tests. */
export function projectMainRequest(
  messages: Message[],
  hostContext = "",
): { messages: RequestMessage[]; persistedMessages: RequestMessage[]; overlay: RequestOverlay | null } {
  const projection = projectRequest({
    messages,
    overlay: buildRequestOverlay({ messages, hostContext }),
  });
  if (!projection.ok) throw new Error(projection.error);
  return {
    messages: projection.messages,
    persistedMessages: projection.persistedMessages,
    overlay: projection.overlay,
  };
}

function pushUserPrompt(
  prompt: string,
  images: Array<{ name: string; mediaType: string }>,
): Message {
  return pushMessage("user", projectedUserPromptContent(prompt, images) as string | ContentBlock[]);
}

export type { ReplayMessage } from "./session.ts";

let postRevision = false;
export type RevisionKind = "prune" | "summarize" | "truncate";
let revisions = 0;
let revisionKinds: RevisionKind[] = [];
let lastBilledTokens: number | null = null;
let lastCacheReadShare: number | null = null;
let lastRequestFollowedRevision = false;
let pendingReclaimEvidence: Record<string, unknown> | null = null;

export function shouldCompactForCacheCost(
  billedTokens: number | null,
  cacheReadShare: number | null,
  contextTokens: number,
  followedRevision: boolean,
): boolean {
  return (
    !followedRevision &&
    billedTokens !== null &&
    cacheReadShare !== null &&
    billedTokens >= CACHE_MISS_COMPACT_TOKENS &&
    contextTokens >= CACHE_MISS_COMPACT_TOKENS &&
    cacheReadShare < CACHE_MISS_COMPACT_SHARE
  );
}

function recordRevision(kind: RevisionKind): void {
  revisions++;
  revisionKinds.push(kind);
}

function toolSchemaTokens(): number {
  return estimateReclaimTokens(requestTools(clientTools, route.provider, route.model));
}

function activeOverlayTokens(): number {
  return activeRequestOverlay ? estimateReclaimTokens(activeRequestOverlay.text) : 0;
}

function replayStateForHistory() {
  const state = createReplayState();
  for (const message of history) {
    const replay = { role: message.role, content: message.content, sseq: message.sseq };
    state.messages.push(replay);
    state.bySeq.set(replay.sseq, replay);
  }
  state.lastSeq = storageSeq;
  state.maxSeq = storageSeq;
  return state;
}

/** Install only the canonical session replay result after its receipt is durable. */
function installReplayedHistory(state: ReturnType<typeof createReplayState>): void {
  const previous = new Map(history.map((message) => [message.sseq, message] as const));
  const next = state.messages.map((replay) => {
    const old = previous.get(replay.sseq);
    if (!old) throw new SessionStoreError(`prune replay lost storageSeq ${replay.sseq}`);
    return {
      ...old,
      role: replay.role,
      content: replay.content as Message["content"],
      tokens: estimateReclaimTokens(replay.content),
    };
  });
  history.splice(0, history.length, ...next);
}

function reclaimTargetEvidence(
  target: ReturnType<typeof makePruneRevision>["targets"][number],
  state: ReturnType<typeof createReplayState>,
): Record<string, unknown> {
  const message = state.bySeq.get(target.sseq);
  const replacement = target.action === "stub" && message && Array.isArray(message.content)
    ? message.content[target.blockIndex]
    : null;
  const replacementBytes = replacement === null ? null : sessionBlockBytes(replacement);
  const reclaimedBytes = target.action === "drop"
    ? target.original.bytes
    : replacementBytes === null
      ? null
      : Math.max(0, target.original.bytes - replacementBytes);
  return {
    sseq: target.sseq,
    ...(target.sourceSseq === undefined ? {} : { sourceSseq: target.sourceSseq }),
    blockIndex: target.blockIndex,
    action: target.action,
    original: { ...target.original },
    originalSha256: target.original.sha256,
    originalBytes: target.original.bytes,
    ...(replacement === null ? {} : { stubSha256: sessionBlockHash(replacement) }),
    reclaimedTokens: target.reclaimedTokens,
    tool: target.recovery.tool,
    repro: target.recovery.repro,
    recovery: target.recovery.source,
    fallback: { ...target.recovery },
    result: "applied",
    reclaimedBytes,
  };
}

function reclaimEvidenceForRevision(
  revision: ReturnType<typeof makePruneRevision>,
  state: ReturnType<typeof createReplayState>,
  applied: boolean,
  error: string | null = null,
): Record<string, unknown> {
  const targets = revision.targets.map((target) => reclaimTargetEvidence(target, state));
  const reclaimedBytes = targets.every((target) => typeof target.reclaimedBytes === "number")
    ? targets.reduce((sum, target) => sum + (target.reclaimedBytes as number), 0)
    : null;
  const reclaimedTokens = targets.reduce(
    (sum, target) => sum + (typeof target.reclaimedTokens === "number" ? target.reclaimedTokens : 0),
    0,
  );
  return {
    attempted: true,
    planned: true,
    applied,
    recovered: applied,
    revisionId: revision.revisionId,
    targetCount: revision.targets.length,
    reclaimedBytes,
    reclaimedTokens,
    source: "session-record",
    recovery: "full-read",
    error,
    targets,
  };
}

/** Plan and durably apply the canonical reclaim receipt before changing the view. */
async function reclaim(): Promise<number> {
  const plan = planReclaimStubs(
    history.map((message) => ({
      role: message.role,
      content: message.content,
      sseq: message.sseq,
      tokens: message.tokens,
    })),
    {
      // The overlay is not durable and is never a prune target, but it still
      // occupies the provider window for this logical prompt.
      systemTokens: estimateReclaimTokens(systemPrompt()) + activeOverlayTokens(),
      toolSchemaTokens: toolSchemaTokens(),
      usable: usableTokens(),
      protectTokens: protectTokens(),
      fillTokens: lastBilledTokens ?? undefined,
    },
  );
  if (plan.length === 0) {
    pendingReclaimEvidence = {
      attempted: false,
      planned: false,
      applied: false,
      recovered: null,
      revisionId: null,
      targetCount: 0,
      reclaimedBytes: 0,
      reclaimedTokens: 0,
      source: null,
      recovery: null,
      error: null,
      targets: [],
    };
    return 0;
  }
  const revision = makePruneRevision(`prune-${randomUUID()}`, plan as ReclaimPick[]);
  const before = replayStateForHistory();
  let storageSeqForRevision: number;
  try {
    storageSeqForRevision = persist({ ...revision });
  } catch (error) {
    pendingReclaimEvidence = reclaimEvidenceForRevision(
      revision,
      before,
      false,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
  const applied = applySessionRecord(before, { ...revision, storageSeq: storageSeqForRevision });
  if (!applied.ok) {
    pendingReclaimEvidence = reclaimEvidenceForRevision(revision, before, false, applied.error);
    throw new SessionStoreError(`durable prune receipt could not be applied: ${applied.error}`);
  }
  pendingReclaimEvidence = reclaimEvidenceForRevision(revision, before, true);
  installReplayedHistory(before);
  postRevision = true;
  recordRevision("prune");
  syncIndicators();
  return revision.targets.length;
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
  persist({ type: "revision", kind: "truncate", dropped: cut });
  history.splice(0, cut);
  postRevision = true;
  recordRevision("truncate");
  syncIndicators();
  return true;
}

// ---- summarization ----

/** The chained handoff. Each summary folds the previous one in. */
let lastHandoff: string | null = null;

function totalTokens(): number {
  return estimateReclaimTokens(systemPrompt()) + toolSchemaTokens() + activeOverlayTokens() + history.reduce((s, m) => s + m.tokens, 0);
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

function summaryValue(value: unknown, maxChars: number): string {
  if (typeof value === "string") return value.slice(0, maxChars);
  try {
    const encoded = JSON.stringify(value);
    return (typeof encoded === "string" ? encoded : String(value)).slice(0, maxChars);
  } catch {
    return String(value).slice(0, maxChars);
  }
}

/** Remove the previous handoff from the next eviction input. The handoff is
 * sent once in the explicit `<previous-handoff>` section below. */
export function messagesForSummary(messages: readonly Message[], lastHandoffBody: string | null): Message[] {
  const prior = lastHandoffBody === null
    ? null
    : `<context-handoff>\n${lastHandoffBody}\n</context-handoff>`;
  return messages.filter((message) => message.content !== prior);
}

export function serializeForSummary(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "Assistant" : "User";
    if (typeof m.content === "string") {
      parts.push(`[${role}]: ${m.content.slice(0, 2_000)}`);
      continue;
    }
    for (const b of m.content as ContentBlock[]) {
      if (b.type === "text") parts.push(`[${role}]: ${String(b.text ?? "").slice(0, 2_000)}`);
      else if (b.type === "tool_use" || b.type === "server_tool_use")
        parts.push(`[${role} tool call]: ${b.name}(${summaryValue(b.input, 300)})`);
      else if (b.type === "tool_result" && !b.stubbed)
        parts.push(`[Tool result]: ${summaryValue(b.content, 500)}`);
      else if (b.type === "web_search_tool_result")
        parts.push(`[Search evidence]: ${summaryValue((b as unknown as Record<string, unknown>).content, 800)}`);
      else if (b.type === "image")
        parts.push(`[${role} image]: ${summaryValue((b as unknown as Record<string, unknown>).source, 160)}`);
    }
  }
  return parts.join("\n").slice(0, 60_000);
}

/** Collapse old turns into one handoff message. Runs on the cheap lane.
 *  Returns false when there is nothing safely evictable or the call fails;
 *  callers fall back to truncate. */
async function summarize(): Promise<boolean> {
  const boundary = evictionBoundary();
  if (boundary <= 0) return false;
  const evicted = messagesForSummary(history.slice(0, boundary), lastHandoff);
  const prior = lastHandoff ? `<previous-handoff>\n${lastHandoff}\n</previous-handoff>\n\n` : "";
  const prompt = `${prior}<session-to-compress>\n${serializeForSummary(evicted)}\n</session-to-compress>\n\nProduce the context handoff for continuing this session: task state, decisions made, files touched, open threads, and a compact evidence inventory of tool outcomes and search references. Only output the handoff.`;
  const started = Date.now();
  currentAbort ??= new AbortController();
  let foldedResult: Awaited<ReturnType<typeof completeText>> | null = null;
  try {
    const summarySystem = "You compress coding-agent session history. Only output the structured handoff.";
    const folded = await completeText(summaryRoute.provider, summaryRoute.model, summarySystem, prompt, currentAbort.signal);
    foldedResult = folded;
    const u = folded.usage;
    if (u) {
      accumulateUsage(u);
      lastUsd = null;
      syncIndicators();
    }
    const text = folded.text;
    if (!text) {
      await writeSummaryTrace({
        status: "empty",
        usage: u,
        started,
        seq: null,
        revisions: 0,
        kinds: [],
        attempt: folded.traceAttempt,
        cache: folded.cache,
        ttftMs: folded.ttftMs,
      });
      return false;
    }
    const handoffBody = text;
    const handoff = `<context-handoff>\n${handoffBody}\n</context-handoff>`;
    const sseq = storageSeq + 1;
    persist({ type: "revision", kind: "summarize", evicted: boundary, summarySseq: sseq, message: { role: "user", content: handoff } });
    lastHandoff = handoffBody;
    history.splice(0, boundary);
    const m: Message = { role: "user", content: handoff, tokens: estimateReclaimTokens(handoff), sseq };
    history.unshift(m);
    postRevision = true;
    recordRevision("summarize");
    syncIndicators();
    await writeSummaryTrace({
      status: "ok",
      usage: u,
      started,
      seq: [m.sseq, m.sseq],
      revisions: 1,
      kinds: ["summarize"],
      attempt: folded.traceAttempt,
      cache: folded.cache,
      ttftMs: folded.ttftMs,
    });
    out(`[context summarized: ${boundary} messages folded]\n`);
    return true;
  } catch (err) {
    // completeText owns provider-error persistence. A storage failure after a
    // successful provider response still needs its summary attempt record.
    if (foldedResult?.traceAttempt && !foldedResult.traceAttempt.written) {
      await writeSummaryTrace({
        status: "storage-error",
        usage: foldedResult.usage,
        started,
        seq: null,
        revisions: 0,
        kinds: [],
        attempt: foldedResult.traceAttempt,
        cache: foldedResult.cache,
        ttftMs: foldedResult.ttftMs,
      });
    }
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

/** Final provider-to-kernel admission invariant. Provider decoders should
 * reject first; this backstop prevents malformed executable calls from being
 * made durable if a decoder regresses. */
export function providerToolAdmissionError(blocks: readonly Record<string, unknown>[]): string | null {
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    if (
      typeof block.id !== "string" || !block.id.trim() ||
      typeof block.name !== "string" || !block.name.trim()
    ) {
      return "provider protocol error: tool call identity is missing";
    }
    if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) {
      return "provider protocol error: tool call arguments must be an object";
    }
  }
  return null;
}

type Usage = ProviderUsage;

const COMPACT_TOKEN_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function safeTokenCount(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function compactTokenCount(value: number | null): string {
  return COMPACT_TOKEN_FORMAT.format(safeTokenCount(value));
}

export function formatUsageIndicators(
  usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite" | "output">,
  contextTokens: number,
  maxContext: number,
  usd: number | null = null,
): string {
  const uncachedInput = safeTokenCount(usage.input);
  const cacheRead = safeTokenCount(usage.cacheRead);
  const cacheWrite = safeTokenCount(usage.cacheWrite);
  const input = uncachedInput + cacheRead + cacheWrite;
  const inputKnown = [usage.input, usage.cacheRead, usage.cacheWrite].every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  const cache = inputKnown && input > 0 ? `${Math.round((cacheRead / input) * 100)}%` : "--";
  const context = safeTokenCount(contextTokens);
  const limit = Math.max(1, safeTokenCount(maxContext));
  const contextPct = Math.round((context / limit) * 100);
  const cost = usd !== null && Number.isFinite(usd) && usd >= 0 ? ` · last $${usd.toFixed(4)}` : "";
  const inputDisplay = inputKnown ? compactTokenCount(input) : "?";
  const outputDisplay = typeof usage.output === "number" && Number.isFinite(usage.output) && usage.output >= 0
    ? compactTokenCount(usage.output)
    : "?";
  return `tokens ${inputDisplay} in/${outputDisplay} out · cache ${cache} · context ~${compactTokenCount(context)}/${compactTokenCount(limit)} ${contextPct}%${cost}`;
}

let sessionUsage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
let lastUsd: number | null = null;

function addKnownUsage(previous: number | null, next: number | null): number | null {
  if (previous === null || next === null) return null;
  return previous + next;
}

function accumulateUsage(usage: Usage): void {
  sessionUsage.input = addKnownUsage(sessionUsage.input, usage.input);
  sessionUsage.cacheRead = addKnownUsage(sessionUsage.cacheRead, usage.cacheRead);
  sessionUsage.cacheWrite = addKnownUsage(sessionUsage.cacheWrite, usage.cacheWrite);
  sessionUsage.output = addKnownUsage(sessionUsage.output, usage.output);
  sessionUsage.reasoning = addKnownUsage(sessionUsage.reasoning, usage.reasoning);
}

interface CallResult {
  blocks: Block[];
  usage: Usage | null;
  ttftMs: number | null;
  stopReason: string | null;
  cache: TraceCacheDiagnostics;
  traceAttempt: TraceAttemptState | null;
}

let currentAbort: AbortController | null = null;
let codexTurnState = "";

function endpointFor(auth: { providerId: ProviderId; baseUrl: string }, model = "", stream = true): string {
  const base = auth.baseUrl.replace(/\/$/, "");
  const proto = providerProtocol(auth.providerId, model);
  if (proto === "anthropic-messages") {
    if (base.endsWith("/v1")) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (proto === "openai-codex-responses") {
    if (base.endsWith("/codex/responses")) return base;
    if (base.endsWith("/codex")) return `${base}/responses`;
    return `${base}/codex/responses`;
  }
  if (proto === "openai-responses") {
    if (base.endsWith("/responses")) return base;
    return `${base}/responses`;
  }
  if (proto === "google-generate") {
    const leaf = modelLeaf(model) || "gemini-3.7-flash";
    return stream
      ? `${base}/models/${leaf}:streamGenerateContent?alt=sse`
      : `${base}/models/${leaf}:generateContent`;
  }
  return `${base}/chat/completions`;
}

type ProviderRetryEvent = {
  status: number;
  kind: "oauth-refresh" | "retryable-status";
  retryCount: number;
};

type ProviderRetryHook = (event: ProviderRetryEvent, cache?: TraceCacheDiagnostics | null) => Promise<void>;

async function providerPost(
  providerId: ProviderId,
  body: unknown,
  signal: AbortSignal | undefined,
  model = "",
  stream = true,
  codexAffinity = false,
  cacheIdentity: MainCacheIdentity | null = null,
  onRetry?: ProviderRetryHook,
): Promise<Response> {
  let replayed = false;
  let retries = 0;
  for (;;) {
    if (signal?.aborted) throw new Error("aborted");
    const auth = await resolveAuth(providerId, signal);
    if (!auth.ok) throw new Error(auth.error);
    let headers: Record<string, string> = { ...auth.headers, ...cacheSessionHeaders(cacheIdentity) };
    if (codexAffinity && providerId === "openai-codex" && codexTurnState) {
      headers["x-codex-turn-state"] = codexTurnState;
    }
    if (providerProtocol(providerId, model) === "google-generate") headers = googleNativeHeaders(headers);
    if (body && typeof body === "object" && (body as { stream?: unknown }).stream === true) {
      headers.accept = "text/event-stream";
    }
    if (stream && providerProtocol(providerId, model) === "google-generate") headers.accept = "text/event-stream";
    const res = await fetch(endpointFor(auth, model, stream), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok && codexAffinity && providerId === "openai-codex") {
      const nextTurnState = res.headers.get("x-codex-turn-state")?.trim();
      if (nextTurnState) codexTurnState = nextTurnState;
    }
    if (res.status === 401) {
      await readBoundedHttpBody(res, PROVIDER_ERROR_BODY_CAP_BYTES);
      if (auth.kind === "oauth" && !replayed) {
        await onRetry?.({ status: 401, kind: "oauth-refresh", retryCount: retries + 1 });
        const refreshed = await refreshOauth(providerId, signal);
        if (!refreshed.ok) throw new Error(refreshed.error);
        replayed = true;
        continue;
      }
      throw new Error(auth.kind === "oauth" ? "auth expired — run /login" : "invalid API key");
    }
    const wait = retryAfter(res.status, res.headers, retries);
    if (wait != null) {
      await readBoundedHttpBody(res, PROVIDER_ERROR_BODY_CAP_BYTES);
      retries++;
      await onRetry?.({ status: res.status, kind: "retryable-status", retryCount: retries });
      await sleep(wait, signal);
      continue;
    }
    return res;
  }
}

/**
 * Persist the attempt that is about to be retried, then create the linked
 * attempt that will carry the eventual response.  Provider retries happen
 * below the model-loop boundary, so they must be represented here rather
 * than collapsed into one logical request record.
 */
async function rotateProviderRetryAttempt(
  attempt: TraceAttemptState | null,
  event: ProviderRetryEvent,
  cache: TraceCacheDiagnostics | null,
): Promise<TraceAttemptState | null> {
  if (!attempt || attempt.written) return attempt;
  const reason = event.kind === "oauth-refresh" ? "oauth-refresh" : `provider-${event.status}`;
  const ended = Date.now();
  await writeTraceAttempt(attempt, {
    status: "retrying",
    storageSeqRange: null,
    toolNames: [],
    usage: null,
    usd: null,
    cost: traceCostForUsage(null, attempt.provider, attempt.model, attempt.role, cache),
    ttftMs: null,
    turnMs: Math.max(0, ended - attempt.started),
    revisions,
    revisionKinds,
    wasteTokens: null,
    wasteCause: reason,
    cache,
  });
  return beginTraceAttempt(attempt.role, {
    parentAttemptId: attempt.attemptId,
    retryOfAttemptId: attempt.attemptId,
    fallbackReason: reason,
    retryCount: event.retryCount,
  });
}

function providerToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Normalize provider counters without turning an absent field into zero. */
export function normalizeProviderUsage(u: Record<string, unknown> | undefined): Usage | null {
  if (!u) return null;
  return {
    input: providerToken(u.input_tokens ?? u.prompt_tokens),
    cacheRead: providerToken(u.cache_read_input_tokens ?? u.cached_tokens),
    cacheWrite: providerToken(u.cache_creation_input_tokens ?? u.cache_write_tokens),
    output: providerToken(u.output_tokens ?? u.completion_tokens),
    reasoning: providerToken(u.reasoning_tokens),
  };
}

function mergeProviderUsage(previous: Usage | null, next: Usage | null): Usage | null {
  if (!previous) return next;
  if (!next) return previous;
  return {
    input: next.input ?? previous.input,
    cacheRead: next.cacheRead ?? previous.cacheRead,
    cacheWrite: next.cacheWrite ?? previous.cacheWrite,
    output: next.output ?? previous.output,
    reasoning: next.reasoning ?? previous.reasoning,
  };
}

const PROVIDER_BODY_CAP_BYTES = 256 * 1024;
const PROVIDER_ERROR_BODY_CAP_BYTES = 64 * 1024;

/** Read a response body through the shared UTF-8 bounded accumulator. */
export async function readBoundedHttpBody(
  res: Response,
  maxBytes = PROVIDER_BODY_CAP_BYTES,
): Promise<BoundedText> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("response body bound must be a non-negative safe integer");
  }
  const marker = "[response body truncated]";
  if (!res.body) {
    const declared = Number(res.headers.get("content-length")?.trim() ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      return boundedToolResult("", {
        maxBytes,
        marker: "[response body exceeds bound]",
        state: "failed",
        isError: true,
      });
    }
    return boundedToolResult("", { maxBytes, marker, state: "complete", isError: false });
  }
  const accumulator = new BoundedTextAccumulator({ maxBytes, marker });
  const reader = res.body.getReader();
  let sourceBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sourceBytes += value.byteLength;
      accumulator.push(value);
      if (sourceBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* The body is already bounded; cancellation is best effort. */
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return accumulator.finish("complete");
}

async function readBoundedJson(res: Response, maxBytes = PROVIDER_BODY_CAP_BYTES): Promise<unknown> {
  const body = await readBoundedHttpBody(res, maxBytes);
  if (body.state !== "complete" || body.truncated) {
    throw new Error(`response JSON exceeded ${maxBytes} bytes`);
  }
  try {
    return JSON.parse(body.text) as unknown;
  } catch {
    throw new Error("response body was not valid JSON");
  }
}

const ANTHROPIC_SSE_BUFFER_BYTES = 128 * 1024;
const ANTHROPIC_EVENT_MAX_COUNT = 4_096;
const ANTHROPIC_EVENT_MAX_BYTES = 4 * 1024 * 1024;
const ANTHROPIC_CONTENT_BLOCK_MAX_INDEX = 10_000;
const ANTHROPIC_JSON_PART_MAX_COUNT = 64;
const ANTHROPIC_JSON_PART_MAX_BYTES = 256 * 1024;
const ANTHROPIC_AGGREGATE_MAX_BYTES = 256 * 1024;
const ANTHROPIC_AGGREGATE_TOTAL_BYTES = 1 * 1024 * 1024;
const ANTHROPIC_CITATION_MAX_COUNT = 256;
const ANTHROPIC_CITATION_MAX_BYTES = 128 * 1024;

class ProviderStreamLimitError extends Error {
  readonly traceStatus = "incomplete" as const;
  readonly cache: TraceCacheDiagnostics | null;

  constructor(message: string, cache: TraceCacheDiagnostics | null) {
    super(`provider output incomplete: ${message}`);
    this.name = "ProviderStreamLimitError";
    this.cache = cache;
  }
}

function classifyProviderStreamError(
  error: unknown,
  cache: TraceCacheDiagnostics | null,
): ProviderStreamLimitError | null {
  if (error instanceof ProviderStreamLimitError) return error;
  if (interrupted || currentAbort?.signal.aborted) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /provider SSE|SSE .*incomplete|incomplete EOF|partial tool JSON|malformed SSE JSON|ended before a terminal|decoded buffer|payload bytes|event count|stream chunk/i.test(message)
  ) {
    return new ProviderStreamLimitError(message, cache);
  }
  return null;
}

async function readProviderSseJson(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  cache: TraceCacheDiagnostics | null,
  filter?: (event: Record<string, unknown>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  try {
    const events = await readSseJson(body, signal, filter);
    if (interrupted || signal?.aborted) throw new Error("aborted");
    return events;
  } catch (error) {
    if (interrupted || signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new Error("aborted");
    }
    throw classifyProviderStreamError(error, cache) ?? error;
  }
}

function failProviderStream(
  reason: string,
  cache: TraceCacheDiagnostics | null,
  reader?: ReadableStreamDefaultReader<Uint8Array>,
): never {
  if (interrupted || currentAbort?.signal.aborted) throw new Error("aborted");
  currentAbort?.abort();
  if (reader) void reader.cancel(reason).catch(() => undefined);
  throw new ProviderStreamLimitError(reason, cache);
}

async function apiFailure(res: Response, hint = ""): Promise<never> {
  const detail = (await readBoundedHttpBody(res, PROVIDER_ERROR_BODY_CAP_BYTES)).text.slice(0, 300);
  throw new Error(`API ${res.status}${detail ? `: ${detail}` : ""}${hint}`);
}

function textFromStreamBlocks(blocks: Array<Record<string, unknown>>): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}

async function completeTextBody(
  providerId: ProviderId,
  model: string,
  system: string,
  prompt: string,
  signal: AbortSignal | undefined,
  onRetry?: ProviderRetryHook,
  onCache?: (cache: TraceCacheDiagnostics) => void,
): Promise<{ text: string; usage: Usage | null; ttftMs: number | null; cache: TraceCacheDiagnostics | null }> {
  const proto = providerProtocol(providerId, model);
  const cacheIdentity = cacheIdentityForRole("summary", providerId, model);
  const cacheKey = cacheIdentity?.key;
  const sendCacheKey = Boolean(cacheKey) && cacheCapabilitySupported(providerId, model, CACHE_CAPABILITY_FEATURE.promptCacheKey);
  const sendSessionId = providerId === "openrouter" ? cacheKey || undefined : undefined;
  if (proto === "anthropic-messages") {
    const thinking = thinkingRequestFor(providerId, model, "off");
    const requestBody = {
      model,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: prompt }],
      ...(thinking ? { thinking } : {}),
    };
    const requestCache = cacheDiagnosticsForRequest(
      requestBody,
      { provider: providerId, protocol: proto, model },
      cacheIdentity,
      null,
      null,
    );
    onCache?.(requestCache);
    const res = await providerPost(
      providerId,
      requestBody,
      signal,
      model,
      true,
      false,
      cacheIdentity,
      onRetry ? async (event) => onRetry(event, requestCache) : undefined,
    );
    if (!res.ok) await apiFailure(res);
    const data = await readBoundedJson(res) as { usage?: Record<string, number>; content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? []).map((c) => c.text ?? "").join("").trim();
    return {
      text,
      usage: normalizeProviderUsage(data.usage),
      ttftMs: null,
      cache: requestCache,
    };
  }
  if (proto === "google-generate") {
    const effort = reasoningEffortFor(providerId, model, "off");
    const requestBody = googleGenerateBody(
      system,
      [{ role: "user", content: prompt }],
      [],
      {
        maxTokens: 2048,
        ...(effort ? { reasoningEffort: effort, googleThinking: true } : {}),
      },
    );
    const requestCache = cacheDiagnosticsForRequest(
      requestBody,
      { provider: providerId, protocol: proto, model },
      cacheIdentity,
      null,
      null,
    );
    onCache?.(requestCache);
    const res = await providerPost(
      providerId,
      requestBody,
      signal,
      model,
      true,
      false,
      cacheIdentity,
      onRetry ? async (event) => onRetry(event, requestCache) : undefined,
    );
    if (!res.ok) await apiFailure(res);
    if (!res.body) throw new Error(`API ${res.status}`);
    const events = await readProviderSseJson(res.body, signal, requestCache);
    const parsed = googleResultFromEvents(events, () => {}, Date.now());
    if (parsed.error) throw new Error(parsed.error);
    return {
      text: textFromStreamBlocks(parsed.blocks),
      usage: parsed.usage,
      ttftMs: parsed.ttftMs,
      cache: requestCache,
    };
  }
  if (usesResponsesApi(providerId, model)) {
    // Codex and Zen GPT require a streaming list input. String input and stream:false return 400.
    const requestBody = responsesBody(model, system, [{ role: "user", content: prompt }], [], {
      provider: providerId,
      ...(providerId === "openai-codex" ? {} : { maxTokens: 2048 }),
      ...(sendCacheKey ? { cacheKey } : {}),
      ...(sendSessionId ? { sessionId: sendSessionId } : {}),
      includeEncryptedReasoning: false,
    });
    const requestCache = cacheDiagnosticsForRequest(
      requestBody,
      { provider: providerId, protocol: proto, model },
      cacheIdentity,
      null,
      null,
    );
    onCache?.(requestCache);
    const res = await providerPost(
      providerId,
      requestBody,
      signal,
      model,
      true,
      false,
      cacheIdentity,
      onRetry ? async (event) => onRetry(event, requestCache) : undefined,
    );
    if (!res.ok) await apiFailure(res);
    if (!res.body) throw new Error(`API ${res.status}`);
    const events = await readProviderSseJson(res.body, signal, requestCache);
    const parsed = responsesResultFromEvents(events, () => {}, Date.now());
    if (parsed.error) throw new Error(parsed.error);
    return {
      text: textFromStreamBlocks(parsed.blocks),
      usage: parsed.usage,
      ttftMs: parsed.ttftMs,
      cache: requestCache,
    };
  }
  const requestBody = {
    model,
    stream: false,
    ...(providerId === "openai" ? { max_completion_tokens: 2048 } : { max_tokens: 2048 }),
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    ...(sendCacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...(sendSessionId ? { session_id: sendSessionId } : {}),
  };
  const requestCache = cacheDiagnosticsForRequest(
    requestBody,
    { provider: providerId, protocol: proto, model },
    cacheIdentity,
    null,
    null,
  );
  onCache?.(requestCache);
  const res = await providerPost(
    providerId,
    requestBody,
    signal,
    model,
    false,
    false,
    cacheIdentity,
    onRetry ? async (event) => onRetry(event, requestCache) : undefined,
  );
  if (!res.ok) await apiFailure(res);
  const got = textFromCompletionPayload(await readBoundedJson(res));
  return {
    text: got.text,
    usage: usageFromOpenAI(got.usage),
    ttftMs: null,
    cache: requestCache,
  };
}

async function completeText(
  providerId: ProviderId,
  model: string,
  system: string,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string; usage: Usage | null; ttftMs: number | null; cache: TraceCacheDiagnostics | null; traceAttempt: TraceAttemptState | null }> {
  let attempt = beginTraceAttempt("summary");
  let summaryCache: TraceCacheDiagnostics | null = null;
  const onRetry: ProviderRetryHook = async (event, cache) => {
    summaryCache = cache ?? summaryCache;
    attempt = await rotateProviderRetryAttempt(attempt, event, summaryCache);
  };
  try {
    const result = await completeTextBody(
      providerId,
      model,
      system,
      prompt,
      signal,
      onRetry,
      (cache) => { summaryCache = cache; },
    );
    if (attempt) attempt.ended = Date.now();
    return { ...result, traceAttempt: attempt };
  } catch (error) {
    const streamFailure = error instanceof ProviderStreamLimitError ? error : null;
    await writeTraceAttempt(attempt, {
      status: streamFailure?.traceStatus ?? "error",
      storageSeqRange: null,
      toolNames: [],
      usage: null,
      usd: null,
      ttftMs: null,
      turnMs: Date.now() - (attempt?.started ?? Date.now()),
      revisions: 0,
      revisionKinds: [],
      wasteTokens: null,
      wasteCause: streamFailure?.message ?? null,
      cost: traceCostForUsage(
        null,
        attempt?.provider ?? providerId,
        attempt?.model ?? model,
        "summary",
        summaryCache,
      ),
      cache: summaryCache ?? streamFailure?.cache ?? null,
    });
    throw error;
  }
}

async function callModel(
  messages: Message[],
  overlay: RequestOverlay | null = activeRequestOverlay,
  retry?: { retryOfAttemptId?: string | null; fallbackReason?: string | null; retryCount?: number },
): Promise<CallResult> {
  nonTtyTranscriptSection = null;
  const started = Date.now();
  let traceAttempt = beginTraceAttempt("main", {
    retryOfAttemptId: retry?.retryOfAttemptId,
    fallbackReason: retry?.fallbackReason,
    retryCount: retry?.retryCount ?? (retry?.retryOfAttemptId ? 1 : 0),
  });
  const sys = systemPrompt();
  const proto = providerProtocol(route.provider, route.model);
  const anthropicCacheSupported = cacheCapabilitySupported(route.provider, route.model, CACHE_CAPABILITY_FEATURE.anthropicCacheControl);
  const prefix = anthropicCacheSupported
    ? buildCachedPrefix(sys, clientTools)
    : { system: [{ type: "text", text: sys }], tools: clientTools.map((tool) => ({ ...tool })) };
  const imageRoots = [sessionFile ? dirname(sessionFile) : "", eventsDir].filter(Boolean);
  const persistedProjection = projectRequest({ messages, imageRoots, overlay: null });
  if (!persistedProjection.ok) throw new Error(`request projection failed: ${persistedProjection.error}`);
  const persistedMessages = persistedProjection.persistedMessages;
  const prefixMarkerCount = proto === "anthropic-messages" && anthropicCacheSupported
    ? cacheMarkerDetails({ system: prefix.system, tools: prefix.tools, messages: persistedMessages }).count
    : 0;
  const stampedMessages =
    proto === "anthropic-messages" && anthropicCacheSupported && prefixMarkerCount < 4
      ? stampHistoryCache(persistedMessages)
      : persistedMessages;
  const providerMessages = appendRequestOverlay(stampedMessages as RequestMessage[], overlay);
  const kernelMessages = providerMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content as string | Array<Record<string, unknown>>,
  }));
  const toolsForProvider = clientTools as ToolDef[];
  const actualEffort = effectiveEffortFor(route.provider, route.model, effortWanted);
  const maxTokens = outputTokenBudget({ thinking: actualEffort !== "off" });
  const thinking = thinkingRequestFor(route.provider, route.model, effortWanted);
  const adaptiveEffort = adaptiveEffortFor(route.provider, route.model, effortWanted);
  const reasoningEffort = reasoningEffortFor(route.provider, route.model, effortWanted);
  const cacheIdentity = cacheIdentityForRole("main", route.provider, route.model);
  const cacheKey = cacheIdentity?.key;
  const sendCacheKey = Boolean(cacheKey) && cacheCapabilitySupported(route.provider, route.model, CACHE_CAPABILITY_FEATURE.promptCacheKey);
  const sendSessionId = route.provider === "openrouter" ? cacheKey || undefined : undefined;
  const sendExplicitCache = cacheCapabilitySupported(route.provider, route.model, CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint);
  const sendPromptCacheOptions = cacheCapabilitySupported(route.provider, route.model, CACHE_CAPABILITY_FEATURE.promptCacheOptions);
  const anthropicMessages =
    proto === "anthropic-messages"
      ? providerMessages.map((m) => {
          if (!Array.isArray(m.content)) return m;
          return {
            ...m,
            content: (m.content as Array<Record<string, unknown>>).map((b) => {
              if (b.type !== "thinking") return b;
              return { type: "thinking", thinking: b.thinking, signature: b.signature };
            }),
          };
        })
      : providerMessages;
  let body =
    proto === "anthropic-messages"
      ? {
          model: route.model,
          max_tokens: maxTokens,
          stream: true,
          ...(thinking ? { thinking } : {}),
          ...(adaptiveEffort ? { output_config: { effort: adaptiveEffort } } : {}),
          system: prefix.system,
          tools: requestTools(prefix.tools, route.provider, route.model),
          messages: anthropicMessages,
        }
      : usesResponsesApi(route.provider, route.model)
        ? responsesBody(route.model, sys, kernelMessages, toolsForProvider, {
            provider: route.provider,
            ...(route.provider === "openai-codex" ? {} : { maxTokens }),
            ...(sendCacheKey ? { cacheKey } : {}),
            ...(sendSessionId ? { sessionId: sendSessionId } : {}),
            ...(sendExplicitCache
              ? {
                  explicitCacheBreakpoint: true,
                }
              : {}),
            ...(sendPromptCacheOptions ? { promptCacheMode: "explicit" as const } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(gpt56ReasoningContext(route.model) ? { reasoningContext: "all_turns" as const } : {}),
            ...(gpt5TextVerbosity(route.model) ? { textVerbosity: "low" as const } : {}),
            includeEncryptedReasoning: includeEncryptedReasoning(route.provider, route.model),
          })
        : proto === "google-generate"
          ? googleGenerateBody(sys, kernelMessages, toolsForProvider, {
              maxTokens,
              ...(reasoningEffort ? { reasoningEffort, googleThinking: true } : {}),
            })
        : completionsBody(route.model, sys, kernelMessages, toolsForProvider, "max_tokens", {
            provider: route.provider,
            maxTokens,
            ...(sendCacheKey ? { cacheKey } : {}),
            ...(sendSessionId ? { sessionId: sendSessionId } : {}),
            ...(reasoningEffort
              ? route.provider === "google"
                ? { reasoningEffort, googleThinking: true }
                : { reasoningEffort }
              : {}),
          });
  let cacheDiagnostics = cacheDiagnosticsForRequest(
    body,
    { provider: route.provider, protocol: proto, model: route.model },
    cacheIdentity,
    overlay,
    currentHostContext,
  );
  const onRetry: ProviderRetryHook = async (event) => {
    traceAttempt = await rotateProviderRetryAttempt(traceAttempt, event, cacheDiagnostics);
    // The retry body is byte-identical; keep that fact on the effective
    // attempt so cache attribution can distinguish it from a new prompt.
    cacheDiagnostics = { ...cacheDiagnostics, retryPromptIdentical: true };
  };
  let optionalCacheFallbackUsed = false;
  let res = await providerPost(route.provider, body, currentAbort?.signal, route.model, true, true, cacheIdentity, onRetry);
  if (!res.ok || !res.body) {
    const detail = (await readBoundedHttpBody(res, PROVIDER_ERROR_BODY_CAP_BYTES)).text.slice(0, 300);
    const optionalFieldsRequested = body.prompt_cache_options !== undefined || JSON.stringify(body).includes("prompt_cache_breakpoint");
    if (
      !optionalCacheFallbackUsed &&
      res.status === 400 &&
      optionalFieldsRequested &&
      /prompt_cache_(?:breakpoint|options)/i.test(detail) &&
      usesResponsesApi(route.provider, route.model)
    ) {
      optionalCacheFallbackUsed = true;
      recordRejectedCacheFields(route.provider, route.model, body, detail);
      const rejectedCacheDiagnostics = cacheDiagnosticsForRequest(
        body,
        { provider: route.provider, protocol: proto, model: route.model },
        cacheIdentity,
        overlay,
        currentHostContext,
        "unsupported-cache-field",
        cacheDiagnostics.policy,
      );
      await writeTraceAttempt(traceAttempt, {
        status: "fallback",
        storageSeqRange: null,
        toolNames: [],
        usage: null,
        usd: null,
        ttftMs: null,
        turnMs: Date.now() - (traceAttempt?.started ?? started),
        revisions,
        revisionKinds,
        wasteTokens: null,
        wasteCause: "cache-policy-fallback",
        cache: rejectedCacheDiagnostics,
      });
      const previousAttemptId = traceAttempt?.attemptId ?? null;
      traceAttempt = beginTraceAttempt("main", {
        parentAttemptId: previousAttemptId,
        retryOfAttemptId: previousAttemptId,
        fallbackReason: "unsupported-cache-field",
        retryCount: (traceAttempt?.retryCount ?? 0) + 1,
      });
      body = stripResponsesBreakpoints(body);
      cacheDiagnostics = cacheDiagnosticsForRequest(
        body,
        { provider: route.provider, protocol: proto, model: route.model },
        cacheIdentity,
        overlay,
        currentHostContext,
        "unsupported-cache-field",
        rejectedCacheDiagnostics.policy,
        true,
      );
      res = await providerPost(route.provider, body, currentAbort?.signal, route.model, true, true, cacheIdentity, onRetry);
    } else {
      const hint =
        proto === "anthropic-messages" && /web_search/i.test(detail)
          ? " — enable Web search in the Anthropic console"
          : "";
      throw new Error(`API ${res.status}: ${detail}${hint}`);
    }
  }
  if (!res.ok || !res.body) {
    const detail = (await readBoundedHttpBody(res, PROVIDER_ERROR_BODY_CAP_BYTES)).text.slice(0, 300);
    throw new Error(`API ${res.status}: ${detail}`);
  }

  // Retries rotate the trace attempt while the logical call remains in
  // progress. Stream timing must therefore be measured from the attempt that
  // produced this response, not from the outer model-loop timestamp.
  const attemptStarted = traceAttempt?.started ?? started;

  if (proto !== "anthropic-messages") {
    let streamedText = "";
    let ttftMs: number | null = null;
    const viaResponses = usesResponsesApi(route.provider, route.model);
    const viaGoogle = proto === "google-generate";
    const events = await readProviderSseJson(res.body, currentAbort?.signal, cacheDiagnostics, (event) => {
      let chunk = "";
      let keepEvent = false;
      if (viaResponses) {
        const live = responsesLiveDelta(event);
        if (live?.kind === "thinking") {
          if (ttftMs === null) ttftMs = Date.now() - attemptStarted;
          streamOut("thinking", live.text);
        }
        if (live?.kind === "text") {
          chunk = live.text;
          event.delta = "";
        }
      } else if (viaGoogle) {
        const live = googleLiveDelta(event);
        if (live?.thinking) {
          if (ttftMs === null) ttftMs = Date.now() - attemptStarted;
          streamOut("thinking", live.thinking);
        }
        if (live?.text) chunk = live.text;
      } else {
        const live = completionLiveDelta(event);
        if (live?.thinking) {
          if (ttftMs === null) ttftMs = Date.now() - attemptStarted;
          keepEvent = true;
          streamOut("thinking", live.thinking);
        }
        if (live?.text) {
          chunk = live.text;
          const choice = Array.isArray(event.choices) ? event.choices[0] : null;
          const delta = choice && typeof choice === "object"
            ? (choice as { delta?: Record<string, unknown> }).delta
            : undefined;
          if (delta) delta.content = "";
        }
      }
      if (chunk) {
        if (ttftMs === null) ttftMs = Date.now() - attemptStarted;
        streamedText += chunk;
        streamOut("assistant", chunk);
      }
      if (viaResponses && event.type === "response.output_text.delta") return false;
      if (!viaResponses && chunk && Array.isArray(event.choices)) {
        const choice = event.choices[0] as { delta?: { tool_calls?: unknown }; finish_reason?: unknown } | undefined;
        if (!keepEvent && !choice?.delta?.tool_calls && !choice?.finish_reason && !event.usage) return false;
      }
      return true;
    });
    const parsed = viaResponses
      ? responsesResultFromEvents(events, () => {}, attemptStarted)
      : viaGoogle
        ? googleResultFromEvents(events, () => {}, attemptStarted)
      : completionResultFromEvents(events, () => {}, attemptStarted);
    if (parsed.error) throw new Error(parsed.error);
    const blocks = parsed.blocks as Block[];
    if (streamedText && !blocks.some((b) => b.type === "text")) {
      const at = blocks.findIndex((b) => b.type !== "thinking");
      blocks.splice(at < 0 ? blocks.length : at, 0, { type: "text", text: streamedText });
    }
    if (traceAttempt) traceAttempt.ended = Date.now();
    return {
      blocks,
      usage: parsed.usage,
      ttftMs,
      stopReason: parsed.stopReason,
      cache: cacheDiagnostics,
      traceAttempt,
    };
  }

  const slots: Array<Block | undefined> = [];
  type StreamAggregate = { accumulator: BoundedTextAccumulator; bytes: number };
  type ContentBlockLifecycle = { block: Block; state: "open" | "closed"; tool: boolean };
  const blockLifecycles = new Map<number, ContentBlockLifecycle>();
  const jsonParts = new Map<number, BoundedTextAccumulator>();
  const jsonPartBytes = new Map<number, number>();
  let jsonPartTotalBytes = 0;
  const textAggregates = new Map<number, StreamAggregate>();
  const thinkingAggregates = new Map<number, StreamAggregate>();
  const signatureAggregates = new Map<number, StreamAggregate>();
  let aggregateTotalBytes = 0;
  let citationCount = 0;
  let citationBytes = 0;
  let eventCount = 0;
  let eventBytes = 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | null = null;
  let ttftMs: number | null = null;
  let stopReason: string | null = null;
  let sawMessageStart = false;
  let sawTerminal = false;
  const eventIndex = (raw: unknown): number => {
    if (
      typeof raw !== "number" || !Number.isInteger(raw) ||
      raw < 0 || raw > ANTHROPIC_CONTENT_BLOCK_MAX_INDEX
    ) {
      failProviderStream("content block event index is invalid", cacheDiagnostics, reader);
    }
    return raw;
  };
  const openLifecycle = (idx: number): ContentBlockLifecycle => {
    const lifecycle = blockLifecycles.get(idx);
    if (!lifecycle) failProviderStream("content block event has no matching start", cacheDiagnostics, reader);
    if (lifecycle.state !== "open") failProviderStream("content block event arrived after stop", cacheDiagnostics, reader);
    if (slots[idx] !== lifecycle.block) failProviderStream("content block slot was overwritten", cacheDiagnostics, reader);
    return lifecycle;
  };
  const pushAggregate = (map: Map<number, StreamAggregate>, idx: number, value: string, label: string): void => {
    if (!value) return;
    const bytes = Buffer.byteLength(value, "utf8");
    const current = map.get(idx)?.bytes ?? 0;
    if (current + bytes > ANTHROPIC_AGGREGATE_MAX_BYTES) {
      failProviderStream(`${label} aggregate exceeded ${ANTHROPIC_AGGREGATE_MAX_BYTES} bytes`, cacheDiagnostics, reader);
    }
    if (aggregateTotalBytes + bytes > ANTHROPIC_AGGREGATE_TOTAL_BYTES) {
      failProviderStream(`aggregate output exceeded ${ANTHROPIC_AGGREGATE_TOTAL_BYTES} bytes`, cacheDiagnostics, reader);
    }
    const entry = map.get(idx) ?? {
      accumulator: new BoundedTextAccumulator({ maxBytes: ANTHROPIC_AGGREGATE_MAX_BYTES, marker: "" }),
      bytes: 0,
    };
    entry.accumulator.push(value);
    entry.bytes += bytes;
    aggregateTotalBytes += bytes;
    map.set(idx, entry);
  };
  const pushCitation = (target: Extract<Block, { type: "text" }>, citation: unknown): void => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(citation);
    } catch {
      failProviderStream("citation aggregate could not be serialized", cacheDiagnostics, reader);
    }
    if (serialized === undefined) return;
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (citationCount >= ANTHROPIC_CITATION_MAX_COUNT) {
      failProviderStream(`citation count exceeded ${ANTHROPIC_CITATION_MAX_COUNT}`, cacheDiagnostics, reader);
    }
    if (citationBytes + bytes > ANTHROPIC_CITATION_MAX_BYTES) {
      failProviderStream(`citation aggregate exceeded ${ANTHROPIC_CITATION_MAX_BYTES} bytes`, cacheDiagnostics, reader);
    }
    citationCount += 1;
    citationBytes += bytes;
    (target.citations ??= []).push(citation);
  };
  const finishAggregates = (): void => {
    for (const [idx, aggregate] of textAggregates) {
      const target = slots[idx];
      if (target?.type === "text") target.text = aggregate.accumulator.finish("complete").text;
    }
    for (const [idx, aggregate] of thinkingAggregates) {
      const target = slots[idx];
      if (target?.type === "thinking") target.thinking = aggregate.accumulator.finish("complete").text;
    }
    for (const [idx, aggregate] of signatureAggregates) {
      const target = slots[idx];
      if (target?.type === "thinking") target.signature = aggregate.accumulator.finish("complete").text;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const decoded = decoder.decode(value, { stream: true });
    if (Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(decoded, "utf8") > ANTHROPIC_SSE_BUFFER_BYTES) {
      failProviderStream(`SSE event buffer exceeded ${ANTHROPIC_SSE_BUFFER_BYTES} bytes`, cacheDiagnostics, reader);
    }
    buffer += decoded;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      eventCount += 1;
      eventBytes += payloadBytes;
      if (eventCount > ANTHROPIC_EVENT_MAX_COUNT) {
        failProviderStream(`event count exceeded ${ANTHROPIC_EVENT_MAX_COUNT}`, cacheDiagnostics, reader);
      }
      if (eventBytes > ANTHROPIC_EVENT_MAX_BYTES) {
        failProviderStream(`event bytes exceeded ${ANTHROPIC_EVENT_MAX_BYTES}`, cacheDiagnostics, reader);
      }
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(payload);
      } catch {
        failProviderStream("malformed SSE JSON", cacheDiagnostics, reader);
      }
      if (sawTerminal) {
        failProviderStream("SSE event arrived after message_stop", cacheDiagnostics, reader);
      }
      switch (ev.type) {
        case "message_start": {
          sawMessageStart = true;
          const msg = (ev.message ?? {}) as { usage?: Record<string, unknown> };
          usage = normalizeProviderUsage(msg.usage);
          break;
        }
        case "content_block_start": {
          const idx = eventIndex(ev.index);
          if (blockLifecycles.has(idx) || slots[idx] !== undefined) {
            failProviderStream("duplicate content block start", cacheDiagnostics, reader);
          }
          const cb = (ev.content_block ?? {}) as {
            type?: string;
            id?: string;
            name?: string;
            tool_use_id?: string;
            citations?: unknown[];
            content?: unknown;
          };
          let block: Block;
          let tool = false;
          if (cb.type === "tool_use") {
            if (typeof cb.id !== "string" || !cb.id.trim() || typeof cb.name !== "string" || !cb.name.trim()) {
              failProviderStream("tool call identity is missing", cacheDiagnostics, reader);
            }
            block = { type: "tool_use", id: cb.id, name: cb.name, input: {} };
            tool = true;
          } else if (cb.type === "server_tool_use") {
            if (typeof cb.id !== "string" || !cb.id.trim() || typeof cb.name !== "string" || !cb.name.trim()) {
              failProviderStream("tool call identity is missing", cacheDiagnostics, reader);
            }
            block = { type: "server_tool_use", id: cb.id, name: cb.name, input: {} };
            tool = true;
          } else if (cb.type === "web_search_tool_result") {
            block = { type: "web_search_tool_result", tool_use_id: cb.tool_use_id ?? "", content: cb.content };
          } else if (cb.type === "thinking") {
            block = { type: "thinking", thinking: "" };
          } else if (cb.type === "text") {
            block = { type: "text", text: "" };
          } else if (cb.type) {
            block = { ...(ev.content_block as Block), type: cb.type } as Block;
          } else {
            failProviderStream("content block start is malformed", cacheDiagnostics, reader);
          }
          slots[idx] = block;
          blockLifecycles.set(idx, { block, state: "open", tool });
          if (tool) {
            if (jsonParts.size >= ANTHROPIC_JSON_PART_MAX_COUNT) {
              failProviderStream(`tool JSON part count exceeded ${ANTHROPIC_JSON_PART_MAX_COUNT}`, cacheDiagnostics, reader);
            }
            jsonParts.set(idx, new BoundedTextAccumulator({ maxBytes: ANTHROPIC_JSON_PART_MAX_BYTES, marker: "" }));
            jsonPartBytes.set(idx, 0);
          }
          if (block.type === "text" && Array.isArray(cb.citations)) {
            for (const citation of cb.citations) pushCitation(block, citation);
          }
          break;
        }
        case "content_block_delta": {
          const idx = eventIndex(ev.index);
          const lifecycle = openLifecycle(idx);
          const target = lifecycle.block;
          if (!ev.delta || typeof ev.delta !== "object" || Array.isArray(ev.delta)) {
            failProviderStream("content block delta is malformed", cacheDiagnostics, reader);
          }
          const d = ev.delta as { type?: unknown; text?: unknown; partial_json?: unknown; citation?: unknown; thinking?: unknown; signature?: unknown };
          if (typeof d.type !== "string") {
            failProviderStream("content block delta is malformed", cacheDiagnostics, reader);
          }
          if (d.type === "text_delta") {
            if (target.type !== "text") failProviderStream("content block delta type does not match start", cacheDiagnostics, reader);
            if (ttftMs === null) ttftMs = Date.now() - attemptStarted;
            const chunk = typeof d.text === "string" ? d.text : "";
            pushAggregate(textAggregates, idx, chunk, "text");
            streamOut("assistant", chunk);
          } else if (d.type === "thinking_delta") {
            if (target.type !== "thinking") failProviderStream("content block delta type does not match start", cacheDiagnostics, reader);
            const chunk = typeof d.thinking === "string" ? d.thinking : "";
            if (chunk && ttftMs === null) ttftMs = Date.now() - attemptStarted;
            pushAggregate(thinkingAggregates, idx, chunk, "thinking");
            streamOut("thinking", chunk);
          } else if (d.type === "signature_delta") {
            if (target.type !== "thinking") failProviderStream("content block delta type does not match start", cacheDiagnostics, reader);
            pushAggregate(signatureAggregates, idx, typeof d.signature === "string" ? d.signature : "", "signature");
          } else if (d.type === "citations_delta") {
            if (target.type !== "text") failProviderStream("content block delta type does not match start", cacheDiagnostics, reader);
            if (d.citation !== undefined) pushCitation(target, d.citation);
          } else if (d.type === "input_json_delta") {
            if (!lifecycle.tool || (target.type !== "tool_use" && target.type !== "server_tool_use")) {
              failProviderStream("content block delta type does not match start", cacheDiagnostics, reader);
            }
            if (typeof d.partial_json !== "string") {
              failProviderStream("tool JSON fragment is malformed", cacheDiagnostics, reader);
            }
            const chunk = d.partial_json;
            const part = jsonParts.get(idx);
            if (!part) failProviderStream("tool JSON accumulator is not bound to its content block", cacheDiagnostics, reader);
            const previousBytes = jsonPartBytes.get(idx) ?? 0;
            const bytes = Buffer.byteLength(chunk, "utf8");
            if (previousBytes + bytes > ANTHROPIC_JSON_PART_MAX_BYTES) {
              failProviderStream(`tool JSON part exceeded ${ANTHROPIC_JSON_PART_MAX_BYTES} bytes`, cacheDiagnostics, reader);
            }
            if (jsonPartTotalBytes + bytes > ANTHROPIC_EVENT_MAX_BYTES) {
              failProviderStream(`tool JSON bytes exceeded ${ANTHROPIC_EVENT_MAX_BYTES}`, cacheDiagnostics, reader);
            }
            part.push(chunk);
            jsonPartBytes.set(idx, previousBytes + bytes);
            jsonPartTotalBytes += bytes;
          }
          break;
        }
        case "content_block_stop": {
          const idx = eventIndex(ev.index);
          const lifecycle = openLifecycle(idx);
          lifecycle.state = "closed";
          break;
        }
        case "message_delta": {
          usage = mergeProviderUsage(usage, normalizeProviderUsage(
            ev.usage && typeof ev.usage === "object" && !Array.isArray(ev.usage)
              ? ev.usage as Record<string, unknown>
              : undefined,
          ));
          const reason = (ev.delta as { stop_reason?: string } | undefined)?.stop_reason;
          if (typeof reason === "string") stopReason = reason;
          break;
        }
        case "message_stop":
        case "message_end":
        case "end":
          sawTerminal = true;
          break;
        default:
          break;
      }
    }
  }
  const tail = decoder.decode();
  if (Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(tail, "utf8") > ANTHROPIC_SSE_BUFFER_BYTES) {
    failProviderStream(`SSE event buffer exceeded ${ANTHROPIC_SSE_BUFFER_BYTES} bytes`, cacheDiagnostics, reader);
  }
  buffer += tail;
  if (buffer.trim()) {
    if (interrupted || currentAbort?.signal.aborted) throw new Error("aborted");
    failProviderStream("nonempty incomplete SSE EOF", cacheDiagnostics, reader);
  }
  if (!sawMessageStart) {
    failProviderStream("SSE stream had no message_start event", cacheDiagnostics, reader);
  }
  if (!sawTerminal) {
    if (interrupted || currentAbort?.signal.aborted) throw new Error("aborted");
    failProviderStream("SSE stream ended without message_stop", cacheDiagnostics, reader);
  }
  let toolLifecycleCount = 0;
  for (const [idx, lifecycle] of blockLifecycles) {
    if (lifecycle.state !== "closed") {
      failProviderStream("content block ended without a matching stop", cacheDiagnostics, reader);
    }
    if (slots[idx] !== lifecycle.block) {
      failProviderStream("content block slot was overwritten", cacheDiagnostics, reader);
    }
    if (lifecycle.tool) {
      toolLifecycleCount += 1;
      if (!jsonParts.has(idx) || !jsonPartBytes.has(idx)) {
        failProviderStream("tool JSON accumulator is not bound to its content block", cacheDiagnostics, reader);
      }
    } else if (jsonParts.has(idx) || jsonPartBytes.has(idx)) {
      failProviderStream("tool JSON accumulator is not bound to a tool block", cacheDiagnostics, reader);
    }
  }
  if (jsonParts.size !== toolLifecycleCount || jsonPartBytes.size !== toolLifecycleCount) {
    failProviderStream("tool JSON accumulator lifecycle mismatch", cacheDiagnostics, reader);
  }
  finishAggregates();
  for (const [idx, part] of jsonParts) {
    const lifecycle = blockLifecycles.get(idx);
    if (!lifecycle || !lifecycle.tool || lifecycle.state !== "closed") {
      failProviderStream("tool JSON accumulator is not bound to exactly one final tool block", cacheDiagnostics, reader);
    }
    const target = lifecycle.block;
    if (slots[idx] !== target || (target.type !== "tool_use" && target.type !== "server_tool_use")) {
      failProviderStream("tool JSON accumulator is not bound to exactly one final tool block", cacheDiagnostics, reader);
    }
    const parsedPart = part.finish("complete");
    if (parsedPart.truncated) {
      failProviderStream("partial tool JSON", cacheDiagnostics, reader);
    }
    let input: unknown;
    try {
      input = JSON.parse(parsedPart.text);
    } catch {
      failProviderStream("partial tool JSON", cacheDiagnostics, reader);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      failProviderStream("tool call arguments must be an object", cacheDiagnostics, reader);
    }
    target.input = input as typeof target.input;
  }
  if (traceAttempt) traceAttempt.ended = Date.now();
  return { blocks: compactStreamBlocks(slots), usage, ttftMs, stopReason, cache: cacheDiagnostics, traceAttempt };
}

// ---- waste attribution ----

let previousCacheAttempt: CacheAttemptSnapshot | null = null;

function resetUsageContinuity(): void {
  previousCacheAttempt = null;
  lastBilledTokens = null;
  lastCacheReadShare = null;
  lastRequestFollowedRevision = false;
}

function resetCacheContinuity(): void {
  resetUsageContinuity();
  currentWorkingSetHash = null;
  currentWorkingSetChanged = null;
  previousWorkingSetHash = null;
  hasPreviousWorkingSet = false;
  currentHostContext = null;
  activeRequestOverlay = null;
  codexTurnState = "";
}

// Providers bill tokens; this adapter turns one complete catalog response into
// immutable, role/route/model-scoped snapshots. `rates.ts` owns validation and
// arithmetic so missing counters/rates remain unknown and cache-write prices
// never fall back to input pricing.
type CatalogCost = Record<string, unknown>;
type CatalogModelEntry = { cost?: CatalogCost };
type CatalogProvider = { models?: Record<string, CatalogModelEntry>; version?: unknown; updatedAt?: unknown };
type CatalogResponse = Record<string, CatalogProvider> & { version?: unknown; updatedAt?: unknown };

const RATE_CATALOG_URL = "https://models.dev/api.json";
const RATE_FETCH_TIMEOUT_MS = 200;
const RATE_CATALOG_BODY_CAP_BYTES = 4 * 1024 * 1024;
const RATE_UNITS = {
  input: "usd_per_million_tokens",
  cacheRead: "usd_per_million_tokens",
  cacheWrite: "usd_per_million_tokens",
  output: "usd_per_million_tokens",
  reasoning: "usd_per_million_tokens",
  storage: "usd_per_gib_second",
} as const;
let rateSnapshotMap: ReadonlyMap<string, RateSnapshot> = new Map();
let ratesLoadStarted = false;
let ratesLoadPromise: Promise<void> | null = null;

function catalogKey(provider: string, model: string, role: "main" | "summary"): string {
  return `${provider}\0${model}\0${role}`;
}

function catalogProviderId(provider: ProviderId): string {
  return provider === "openai-codex" || provider === "github-copilot" ? "openai" : provider;
}

function catalogMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 256 ? value.trim() : null;
}

function rateFromCatalog(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function freezeRateSnapshot(snapshot: RateSnapshot): RateSnapshot {
  return Object.freeze({
    ...snapshot,
    scope: Object.freeze({ ...snapshot.scope }),
    units: Object.freeze({ ...snapshot.units }),
    rates: Object.freeze({ ...snapshot.rates }),
  });
}

function snapshotForCatalogEntry(
  provider: ProviderId,
  model: string,
  role: "main" | "summary",
  cost: CatalogCost,
  version: string | null,
  lookedUpAt: string,
): RateSnapshot | null {
  return normalizeRateSnapshot({
    scope: {
      provider,
      protocol: providerProtocol(provider, model),
      model,
      route: cacheRouteForProvider(provider),
      role,
    },
    source: RATE_CATALOG_URL,
    version,
    lookedUpAt,
    units: RATE_UNITS,
    // A catalog entry does not document provider retention. The request's
    // effective cache policy supplies a per-attempt TTL class later.
    cacheWriteTtlClass: "unknown",
    reasoningBilling: rateFromCatalog(cost.reasoning) === null ? null : "separate",
    rates: {
      input: rateFromCatalog(cost.input),
      cacheRead: rateFromCatalog(cost.cache_read),
      cacheWrite: rateFromCatalog(cost.cache_write),
      output: rateFromCatalog(cost.output),
      reasoning: rateFromCatalog(cost.reasoning),
      storage: null,
    },
  });
}

async function loadRates(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RATE_CATALOG_URL, { signal: controller.signal });
    if (!res.ok) return;
    const body = await readBoundedHttpBody(res, RATE_CATALOG_BODY_CAP_BYTES);
    if (body.state !== "complete" || body.truncated) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text) as unknown;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const db = parsed as CatalogResponse;
    const lookedUpAt = new Date().toISOString();
    const version = catalogMetadata(db.version) ?? catalogMetadata(db.updatedAt);
    const next = new Map<string, RateSnapshot>();
    for (const providerId of AUTH_PROVIDER_ORDER) {
      const catalog = db[catalogProviderId(providerId)];
      if (!catalog || typeof catalog !== "object" || !catalog.models || typeof catalog.models !== "object") continue;
      for (const [model, entry] of Object.entries(catalog.models)) {
        if (!entry || typeof entry !== "object" || !entry.cost || typeof entry.cost !== "object") continue;
        for (const role of ["main", "summary"] as const) {
          const snapshot = snapshotForCatalogEntry(providerId, model, role, entry.cost, version, lookedUpAt);
          if (snapshot) next.set(catalogKey(providerId, model, role), freezeRateSnapshot(snapshot));
        }
      }
    }
    // Replace the map only after the response has been fully normalized. A
    // logical task keeps the previous map reference and cannot observe a
    // half-loaded or changing catalog.
    rateSnapshotMap = next;
  } catch {
    /* Offline/catalog failure leaves the scoped snapshot unknown. */
  } finally {
    clearTimeout(timer);
  }
}

function ensureRatesLoading(): Promise<void> {
  if (!ratesLoadStarted) {
    ratesLoadStarted = true;
    ratesLoadPromise = loadRates();
  }
  return ratesLoadPromise ?? Promise.resolve();
}

async function awaitInitialRates(timeoutMs = 250): Promise<void> {
  const pending = ensureRatesLoading();
  if (timeoutMs <= 0) return;
  await Promise.race([
    pending,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function cacheTtlClass(cache: TraceCacheDiagnostics | null): RateSnapshotInput["cacheWriteTtlClass"] {
  const ttlMs = cache?.policy.effectiveTtlMs ?? null;
  if (ttlMs === 5 * 60 * 1000) return "5m";
  if (ttlMs === 30 * 60 * 1000) return "30m";
  if (ttlMs === 60 * 60 * 1000) return "1h";
  return "unknown";
}

function rateSnapshotFor(
  provider: ProviderId,
  model: string,
  role: "main" | "summary",
  cache: TraceCacheDiagnostics | null,
): RateSnapshot | null {
  const source = activeTraceTask?.rateSnapshots ?? rateSnapshotMap;
  const catalogProvider = catalogProviderId(provider);
  const candidate = source.get(catalogKey(provider, model, role)) ??
    source.get(catalogKey(provider, modelLeaf(model), role)) ??
    source.get(catalogKey(catalogProvider, model, role)) ??
    source.get(catalogKey(catalogProvider, modelLeaf(model), role));
  if (!candidate) return null;
  // Re-scope a catalog row to the exact request route/model while retaining
  // the immutable rate/provenance payload captured for this task.
  const scoped: RateSnapshotInput = {
    ...candidate,
    scope: {
      provider,
      protocol: providerProtocol(provider, model),
      model,
      route: cacheRouteForProvider(provider),
      role,
    },
    // The catalog does not establish retention. The actual request policy
    // supplies a TTL class; unknown stays unknown when no policy was sent.
    cacheWriteTtlClass: cacheTtlClass(cache),
  };
  return normalizeRateSnapshot(scoped);
}

function usageTotal(usage: Usage): number | null {
  const values = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return null;
  return (values[0] as number) + (values[1] as number) + (values[2] as number);
}

function traceCostForUsage(
  usage: Usage | null,
  provider: ProviderId,
  model: string,
  role: "main" | "summary",
  cache: TraceCacheDiagnostics | null,
): TraceRecordCostInput {
  const snapshot = rateSnapshotFor(provider, model, role, cache);
  const scope = {
    provider,
    protocol: providerProtocol(provider, model),
    model,
    route: cacheRouteForProvider(provider),
  };
  // When the provider did not report reasoning, only bill it when the rate
  // snapshot explicitly says it is separately billed. This keeps the trace
  // honest without inventing a reasoning counter or relation.
  const requiredFields = usage && usage.reasoning === null && snapshot?.reasoningBilling !== "separate"
    ? (["input", "cacheRead", "cacheWrite", "output"] as const)
    : undefined;
  const cost = computeTraceCost({ role, scope, usage, snapshot, requiredFields });
  const unknownReasons = cost.unknownFields.map((field) => {
    if (field === "source" || field === "version" || field === "lookedUpAt" || field === "units") {
      return `rate-provenance.${field}-unknown`;
    }
    if (field === "scope") return "rate-provenance.scope-mismatch";
    if (field === "cacheWriteTtlClass") return "cache-write-ttl-unknown";
    if (field === "reasoningBilling") return "reasoning-billing-relation-unknown";
    if (field === "aggregate") return "cost-aggregate-invalid";
    const quantity = field === "storage" ? undefined : usage?.[field as keyof Usage];
    if (usage === null || quantity === undefined || quantity === null) return `usage.${field}-unknown`;
    if (!snapshot) return `rate-snapshot.${field}-unknown`;
    if (snapshot.rates[field] === null) return `rate.${field}-unknown`;
    return `cost.${field}-unknown`;
  });
  return {
    usd: cost.usd,
    source: cost.source,
    version: cost.version,
    lookedUpAt: cost.lookedUpAt,
    knownFields: cost.knownFields,
    unknownFields: cost.unknownFields,
    unknownReasons,
    scope: cost.scope,
    units: cost.units,
    components: cost.components,
    rates: snapshot?.rates ?? null,
    cacheWriteTtlClass: cost.cacheWriteTtlClass,
    reasoningBilling: cost.reasoningBilling,
  };
}

function reportUsage(
  usage: Usage,
  ttftMs: number | null,
  turnStarted: number,
  cache: TraceCacheDiagnostics,
): {
  cause: string | null;
  usd: number | null;
  turnMs: number;
  ttftMs: number | null;
  revisionCount: number;
  revisionKinds: RevisionKind[];
  wasteTokens: number | null;
  cost: TraceRecordCostInput;
  cache: TraceCacheDiagnostics;
} {
  const cur = usageTotal(usage);
  const snapshot: CacheAttemptSnapshot = {
    atMs: turnStarted,
    usage: {
      inputTokens: usage.input,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
    },
    diagnostics: cache,
    postRevision,
  };
  let waste: { tokens: number; cause: string } | null = null;
  const classification = classifyCacheMiss({
    previous: previousCacheAttempt,
    current: snapshot,
    noiseFloorTokens: NOISE_FLOOR_TOKENS,
  });
  const traceCache: TraceCacheDiagnostics = {
    ...cache,
    missAttribution: {
      attributed: classification.attributed,
      primary: classification.primary,
      contributing: classification.contributing.slice(),
      missedTokens: classification.missedTokens,
      gapMs: classification.gapMs,
      missingFields: classification.missingFields.slice(),
      noiseFloorTokens: NOISE_FLOOR_TOKENS,
    },
  };
  if (classification.missedTokens !== null && classification.missedTokens > NOISE_FLOOR_TOKENS) {
    waste = { tokens: classification.missedTokens, cause: classification.primary ?? "unknown" };
  }
  lastRequestFollowedRevision = postRevision;
  postRevision = false;
  previousCacheAttempt = { ...snapshot, diagnostics: traceCache };
  lastBilledTokens = cur;
  lastCacheReadShare = cur !== null && cur > 0 && usage.cacheRead !== null ? usage.cacheRead / cur : null;
  // Keep one cost calculation and its provenance. In particular, a catalog
  // miss must not turn a reported zero-token request into an artificial
  // non-null price (or erase a mathematically-known zero).
  const cost = traceCostForUsage(usage, route.provider, route.model, "main", cache);
  const usd = typeof cost.usd === "number" && Number.isFinite(cost.usd) && cost.usd >= 0 ? cost.usd : null;
  const revisionCount = revisions;
  const kinds = revisionKinds.slice();
  const wasteTokens = classification.missedTokens === null ? null : waste?.tokens ?? 0;
  revisions = 0;
  revisionKinds = [];
  return {
    cause: waste?.cause ?? null,
    usd,
    turnMs: Date.now() - turnStarted,
    ttftMs,
    revisionCount,
    revisionKinds: kinds,
    wasteTokens,
    cost,
    cache: traceCache,
  };
}

// ---- agent loop ----

let interrupted = false;

function logSettings(): void {
  logEvent({
    t: "agent_settings",
    model: `${route.provider}/${route.model}`,
    thinkingLevel: effectiveEffortFor(route.provider, route.model, effortWanted),
  });
}

async function runPrompt(prompt: string, extraImages: Array<{ name: string; mediaType: string }> = []): Promise<void> {
  if (shutdownRequested) return;
  if (modelAvailabilityError) {
    out(`(the run did not start: ${modelAvailabilityError}; choose an available model with /models or /model)\n`);
    surface?.setDraft(prompt);
    showPrompt();
    return;
  }
  // The overlay belongs to one logical prompt.  Do not let an earlier
  // prompt's volatile context inflate idle reclaim estimates or leak into a
  // preflight failure before this prompt has built its own snapshot.
  activeRequestOverlay = null;
  protectedTaskApprovals.clear();
  if (!streamPrepared) {
    try {
      ensureFreshSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out(`(the run did not start: ${message})\n`);
      surface?.setDraft(prompt);
      running = false;
      currentAbort = null;
      showPrompt();
      return;
    }
  }
  running = true;
  showPrompt();
  interrupted = shutdownRequested;
  currentAbort = new AbortController();
  const pendingResult = eventsDir && terminalId
    ? await pendingImageState(eventsDir, terminalId)
    : { ok: true as const, count: 0, hasImages: false };
  if (!pendingResult.ok) {
    out(`(the run did not start: ${pendingResult.error})\n`);
    surface?.setDraft(prompt);
    running = false;
    currentAbort = null;
    showPrompt();
    return;
  }
  const hasImages = pendingResult.hasImages || extraImages.length > 0;
  let preflight: { requestId: string; token: string | null } | null = null;
  const cancelPreflight = (): void => {
    if (preflight) logEvent({ t: "preflight_cancel", requestId: preflight.requestId });
    preflight = null;
  };
  if (eventsDir && terminalId) {
    if (sidecarWriteStopped) {
      out("(the run did not start: sidecar admission is paused)\n");
      surface?.setDraft(prompt);
      running = false;
      currentAbort = null;
      showPrompt();
      return;
    }
    const requestId = randomUUID();
    const timeoutMs = 15_000;
    logEvent({ t: "preflight_request", requestId, hasImages, deadlineAt: Date.now() + timeoutMs });
    const ack = await waitForAck(eventsDir, terminalId, requestId, timeoutMs, bridgeId, {
      shouldStop: () => interrupted,
    });
    if (!ack || ack.ok !== true) {
      // Cancellation is request-addressed because a timed-out client never
      // received the token. The app processes this durable event after any
      // in-flight capture and cannot strand the late preflight lease.
      // A concrete ack already finished the request; do not append cancel
      // while the tailer may still be holding backpressure for capture.
      if (!ack) logEvent({ t: "preflight_cancel", requestId });
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
  const claimResult = eventsDir && terminalId
    ? await claimPendingImages(eventsDir, terminalId)
    : { ok: true as const, claim: { claimId: "", images: [] } };
  if (!claimResult.ok) {
    cancelPreflight();
    out(`(the run did not start: ${claimResult.error})\n`);
    surface?.setDraft(prompt);
    running = false;
    currentAbort = null;
    showPrompt();
    void refreshPendingImageCount();
    return;
  }
  const claim = claimResult.claim;
  const loaded = claim.images;
  const extras = extraImages
    .map((ref) => loadImageFromRoots(ref, imageRoots))
    .filter((img): img is NonNullable<typeof img> => img !== null);
  const allImages = [...loaded, ...extras].slice(0, 4);
  const persistedImages = persistLoadedImages(sessionFile, allImages);
  if (!persistedImages.ok) {
    cancelPreflight();
    out(`(the run did not start: ${persistedImages.error})\n`);
    surface?.setDraft(prompt);
    running = false;
    currentAbort = null;
    showPrompt();
    return;
  }
  const images = persistedImages.images;
  const persistedPendingNames: string[] = [];
  if (eventsDir && terminalId && claim.claimId) {
    if (sessionFile) {
      const sessionDir = dirname(sessionFile);
      for (let i = 0; i < loaded.length && i < images.length; i++) {
        const ref = images[i]!;
        const src = loaded[i]!;
        if (ref.name === src.name) continue;
        try {
          if (existsSync(join(sessionDir, ref.name))) persistedPendingNames.push(src.name);
        } catch {
          /* Keep the pending source until acknowledgement. */
        }
      }
    }
  }
  void refreshPendingImageCount();
  const taggedPrompt = prompt.startsWith("/") ? prompt : expandFileTags(canonicalCwd, prompt);
  const contextResult = eventsDir && terminalId ? readContextFilesResult(eventsDir, terminalId) : null;
  const context = contextResult?.text ?? "";
  currentHostContext = contextResult
    ? {
        state: contextResult.state,
        direction: contextResult.direction,
        limitBytes: contextResult.limitBytes,
        inputBytes: contextResult.inputBytes,
        retainedBytes: contextResult.retainedBytes,
        omittedBytes: contextResult.omittedBytes,
        outputBytes: contextResult.outputBytes,
        truncated: contextResult.truncated,
      }
    : null;
  if (eventsDir && terminalId) {
    const file = promptFileName(terminalId, bridgeId, randomUUID().slice(0, 8));
    const written = writePromptPayload(eventsDir, terminalId, file, { prompt: taggedPrompt, context, images });
    if (written) logEvent({ t: "prompt", file: written, hasPreflight: preflight !== null });
  }
  let userMsg: Message;
  try {
    userMsg = pushUserPrompt(taggedPrompt, images);
  } catch (err) {
    cancelPreflight();
    const message = err instanceof SessionStoreError ? err.message : err instanceof Error ? err.message : String(err);
    out(`(the run did not start: ${message})\n`);
    surface?.setDraft(prompt);
    running = false;
    currentAbort = null;
    showPrompt();
    return;
  }
  // Build once for this logical prompt. Retries and cache-field fallbacks
  // reuse the same exact bytes instead of observing a changed host snapshot.
  try {
    activeRequestOverlay = buildRequestOverlay({ messages: history, hostContext: context });
  } catch (err) {
    cancelPreflight();
    const message = err instanceof Error ? err.message : String(err);
    out(`(the run did not start: ${message})\n`);
    surface?.setDraft(prompt);
    running = false;
    currentAbort = null;
    showPrompt();
    return;
  }
  currentWorkingSetHash = activeRequestOverlay?.hash ?? null;
  currentWorkingSetChanged = hasPreviousWorkingSet ? currentWorkingSetHash !== previousWorkingSetHash : null;
  previousWorkingSetHash = currentWorkingSetHash;
  hasPreviousWorkingSet = true;
  // Rate lookup is optional and bounded. Capture the fully replaced catalog
  // map before opening the logical task so every attempt in this run shares
  // one immutable provenance snapshot.
  await awaitInitialRates();
  const traceTask = beginTraceTask();
  if (eventsDir && terminalId && claim.claimId) {
    const ackImages = await acknowledgePendingImages(eventsDir, terminalId, claim.claimId, persistedPendingNames);
    if (!ackImages.ok) out(`(host: ${ackImages.error})\n`);
  }
  logEvent({
    t: "agent_start",
    runId: traceTask.runId,
    taskId: traceTask.taskId,
    model: `${route.provider}/${route.model}`,
    sessionFile,
    sessionId,
    preflightRequestId: preflight?.requestId ?? null,
    preflightToken: preflight?.token ?? null,
    hostContext: currentHostContext,
    overlayHash: activeRequestOverlay?.hash ?? null,
    overlayBytes: activeRequestOverlay?.bytes ?? null,
    entryId: String(userMsg.sseq),
    parentEntryId: null,
    trusted: null,
    thinkingLevel: effectiveEffortFor(route.provider, route.model, effortWanted),
  });
  let storageFailure: string | null = null;
  let taskFailure: string | null = null;
  let taskOutcomeStatus = "success";
  let toolErrorObserved = false;
  let retriedOverflow = false;
  let resumePaused = false;
  let pauseTurnContinuations = 0;
  let lastPlanText = "";
  let cacheCostCompactionAttempted = false;
  codexTurnState = "";
  try {
    while (true) {
      if (interrupted) break;
      if (!resumePaused) {
        await reclaim();
        // Compact an expensive cache miss before the context limit forces it.
        const shouldCompactForCost =
          !cacheCostCompactionAttempted &&
          shouldCompactForCacheCost(
            lastBilledTokens,
            lastCacheReadShare,
            totalTokens(),
            lastRequestFollowedRevision,
          );
        if (shouldCompactForCost) cacheCostCompactionAttempted = true;
        const compactedForCost = shouldCompactForCost ? await summarize() : false;
        if (compactedForCost) {
          lastBilledTokens = null;
          lastCacheReadShare = null;
        }
        // Reclaim first. Summarize at the high-water line. Truncate last.
        if (!compactedForCost && totalTokens() >= usableTokens() * HIGH_WATER && !(await summarize()) && totalTokens() >= usableTokens()) {
          truncate();
        }
      }
      resumePaused = false;
      let result: CallResult;
      const callStarted = Date.now();
      const seqBefore = storageSeq;
      try {
        result = await callModel(history, activeRequestOverlay);
      } catch (err) {
        const streamFailure = err instanceof ProviderStreamLimitError ? err : null;
        const failedAttempt = inFlightTraceAttempt;
        // Emergency mid-turn revision: the provider
        // rejected the window; reclaim hard and retry exactly once.
        if (!retriedOverflow && /prompt is too long|maximum context|context_length/i.test(String((err as Error).message))) {
          await writeMainTrace({ status: "overflow", seqBefore, toolNames: [], usage: null, waste: null, sysHash: hashSystem(systemPrompt()), cache: streamFailure?.cache ?? null, started: callStarted, attempt: failedAttempt });
          retriedOverflow = true;
          await reclaim();
          await summarize();
          truncate();
          try {
            result = await callModel(history, activeRequestOverlay, {
              retryOfAttemptId: failedAttempt?.attemptId ?? null,
              fallbackReason: "overflow",
              retryCount: (failedAttempt?.retryCount ?? 0) + 1,
            });
          } catch (retryErr) {
            const retryStreamFailure = retryErr instanceof ProviderStreamLimitError ? retryErr : null;
            await writeMainTrace({ status: retryStreamFailure?.traceStatus ?? "overflow-retry-error", seqBefore, toolNames: [], usage: null, waste: null, sysHash: hashSystem(systemPrompt()), cache: retryStreamFailure?.cache ?? null, started: callStarted, attempt: inFlightTraceAttempt });
            throw retryErr;
          }
        } else {
          await writeMainTrace({ status: streamFailure?.traceStatus ?? "error", seqBefore, toolNames: [], usage: null, waste: null, sysHash: hashSystem(systemPrompt()), cache: streamFailure?.cache ?? null, started: callStarted, attempt: failedAttempt });
          throw err;
        }
      }
      const admissionError = providerToolAdmissionError(result.blocks);
      if (admissionError) throw new Error(admissionError);
      const sys = systemPrompt();
      if (!result.usage) resetUsageContinuity();
      const waste = result.usage
        ? reportUsage(result.usage, result.ttftMs, callStarted, result.cache)
        : {
            cause: null,
            usd: null,
            turnMs: Date.now() - callStarted,
            ttftMs: result.ttftMs,
            revisionCount: 0,
            revisionKinds: [],
            wasteTokens: 0,
            cost: traceCostForUsage(null, route.provider, route.model, "main", result.cache),
            cache: result.cache,
          };
      const traceCache = waste.cache;
      if (result.usage) accumulateUsage(result.usage);
      lastUsd = waste.usd != null && Number.isFinite(waste.usd) && waste.usd >= 0 ? waste.usd : null;
      const assistantMsg: Message = { role: "assistant", content: result.blocks as ContentBlock[], tokens: 0, sseq: 0 };
      assistantMsg.tokens = estimateReclaimTokens(assistantMsg.content);
      assistantMsg.sseq = persist({ type: "message", message: { role: "assistant", content: result.blocks } });
      history.push(assistantMsg);
      syncIndicators();
      const plan = planTextIfChanged(visibleAssistantText(result.blocks), lastPlanText);
      if (plan) {
        lastPlanText = plan;
        logEvent({ t: "plan", text: plan });
      }
      const serverNames = renderServerTools(result.blocks);
      if (result.blocks.some((block) => {
        if (block.type !== "web_search_tool_result" || !block.content || typeof block.content !== "object" || Array.isArray(block.content)) {
          return false;
        }
        return (block.content as { type?: string }).type === "web_search_tool_result_error";
      })) {
        toolErrorObserved = true;
      }
      const uses = (result.blocks.filter((b) => b.type === "tool_use") as Extract<Block, { type: "tool_use" }>[]).map(
        (b): ToolUse => ({ id: b.id, name: b.name, input: b.input }),
      );
      if (uses.length === 0) {
        const pauseTurn = result.stopReason === "pause_turn" && !interrupted;
        const pauseLimitReached = pauseTurn && pauseTurnContinuations >= MAX_PAUSE_TURN_CONTINUATIONS;
        await writeMainTrace({
          status: pauseLimitReached ? "pause-limit" : "ok",
          seqBefore,
          toolNames: serverNames,
          usage: result.usage,
          waste,
          sysHash: hashSystem(sys),
          cache: traceCache,
          started: callStarted,
          attempt: result.traceAttempt,
        });
        if (pauseLimitReached) {
          taskFailure = `server-tool continuation limit reached after ${MAX_PAUSE_TURN_CONTINUATIONS} continuations`;
          taskOutcomeStatus = "failure";
          out(`\n(${taskFailure})\n`);
          break;
        }
        if (pauseTurn) {
          pauseTurnContinuations += 1;
          resumePaused = true;
          continue;
        }
        break;
      }
      const outcomes: ToolOutcome[] = [];
      try {
      for (let i = 0; i < uses.length; i += TOOL_CONCURRENCY) {
        if (interrupted) break;
        const chunk = uses.slice(i, i + TOOL_CONCURRENCY);
        const handles = chunk.map((use) => {
          logToolStart(use);
          nonTtyTranscriptSection = null;
          if (surface) return surface.startTool(use.name, toolTranscriptDetail(use));
          process.stdout.write(`\n${formatToolAnnounce(use)}\n`);
          return null;
        });
        const wrapped = chunk.map((use) => executeTool(use));
        const settled = await Promise.allSettled(wrapped);
        for (let ci = 0; ci < chunk.length; ci++) {
          const item = settled[ci]!;
          if (item.status === "fulfilled") {
            const outcome = item.value;
            if (outcome.isError || (outcome.bounded?.state !== undefined && outcome.bounded.state !== "complete")) {
              toolErrorObserved = true;
            }
            if (interrupted) {
              if (handles[ci]) surface?.finishTool(handles[ci]!, "cancelled");
            } else if (handles[ci]) {
              surface?.finishTool(
                handles[ci]!,
                outcome.isError ? "error" : "success",
                toolTranscriptOutput(outcome),
              );
            } else {
              const follow = formatToolFollowup(chunk[ci]!, outcome);
              if (follow) process.stdout.write(follow);
            }
            outcomes.push(outcome);
            logEvent({
              t: "tool_end",
              toolCallId: chunk[ci]!.id,
              isError: outcome.isError,
              ...toolOutcomeTraceFields(outcome),
            });
          } else {
            const err = item.reason;
            const message = err instanceof Error ? err.message : String(err);
            if (handles[ci]) surface?.finishTool(handles[ci]!, "error", capDisplay(message, TOOL_DISPLAY_BYTES));
            const outcome = done(chunk[ci]!, message, true);
            toolErrorObserved = true;
            outcomes.push(outcome);
            logEvent({ t: "tool_end", toolCallId: chunk[ci]!.id, isError: true, ...toolOutcomeTraceFields(outcome) });
          }
        }
      }
      } finally {
        surface?.cancelPendingTools();
      }
      // An interrupted turn must still answer the open tool calls, or the
      // stored pair breaks the next request.
      const answered = outcomes.length;
      for (let i = answered; i < uses.length; i++) {
        const outcome = done(uses[i]!, "(interrupted by user)", true);
        toolErrorObserved = true;
        outcomes.push(outcome);
        logEvent({ t: "tool_end", toolCallId: uses[i]!.id, isError: true, ...toolOutcomeTraceFields(outcome) });
      }
      const resultBlocks = outcomes.map((o, i): ContentBlock => {
        const b = o.result as ContentBlock;
        b.chars = undefined;
        b.tool = uses[i]!.name;
        b.repro = o.repro ?? reproFor(uses[i]!);
        if (o.isError) b.is_error = true;
        return b;
      });
      pushMessage("user", resultBlocks);
      await writeMainTrace({
        status: "ok",
        seqBefore,
        toolNames: [...serverNames, ...uses.map((u) => u.name)],
        usage: result.usage,
        waste,
        sysHash: hashSystem(sys),
        cache: traceCache,
        started: callStarted,
        attempt: result.traceAttempt,
        toolOutcomes: outcomes.map((outcome, index) => toolOutcomeTraceInput(uses[index]!, outcome)),
      });
      out("\n");
    }
  } catch (err) {
    if (interrupted) {
      taskOutcomeStatus = "interrupted";
      taskFailure = "interrupted";
      out("\n(interrupted)\n");
    }
    else if (err instanceof SessionStoreError) {
      storageFailure = err.message;
      taskFailure = storageFailure;
      taskOutcomeStatus = "failure";
      out(`\n(storage failed: ${err.message})\n`);
    } else {
      taskFailure = err instanceof Error ? err.message : String(err);
      taskOutcomeStatus = "failure";
      out(`\nerror: ${taskFailure}\n`);
    }
  } finally {
    currentAbort = null;
  }
  if (interrupted) {
    taskOutcomeStatus = "interrupted";
    taskFailure ??= "interrupted";
  } else if (toolErrorObserved && taskOutcomeStatus === "success") {
    taskOutcomeStatus = "failure";
    taskFailure ??= "tool error";
  }
  logEvent({
    t: "agent_settled",
    runId: traceTask.runId,
    taskId: traceTask.taskId,
    error: storageFailure ?? taskFailure,
  });
  if (!storageFailure && eventsDir && terminalId) {
    const requestId = randomUUID();
    logEvent({
      t: "checkpoint_request",
      requestId,
      kind: "settled",
      entryId: storageSeq > 0 ? String(storageSeq) : null,
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
  await settleTraceTask(taskOutcomeStatus);
  // Keep the engine busy until checkpointing and trace settlement finish. A
  // second prompt must not replace `activeTraceTask` while this task's
  // task-settled record is still being written.
  activeRequestOverlay = null;
  running = false;
  syncIndicators();
  showPrompt();
}

// ---- session resume: replay the append-only log into a fresh view ----

/** Rebuild the context view from storage. Revision records address messages
 *  by stable sseq, so replay is order-independent and exact. */
function abortResume(message: string): void {
  out(`${message}\n`);
  history.length = 0;
  syncIndicators();
  closeSessionWriter();
  if (sessionFile) {
    const quarantined = quarantineSessionBundle(sessionFile);
    if (quarantined.ok) {
      streamPrepared = false;
      storageSeq = 0;
      rotateCacheSession();
      return;
    }
  }
  streamPrepared = true;
  storageSeq = 0;
  rotateCacheSession();
}

async function resumeSession(): Promise<SessionResult> {
  resumeBusy = true;
  showPrompt();
  try {
    return await resumeSessionBody();
  } finally {
    resumeBusy = false;
    showPrompt();
  }
}

async function resumeSessionBody(): Promise<SessionResult> {
  if (!sessionFile || !sessionBundleExists(sessionFile)) {
    out("(no stored session)\n");
    return { ok: false, error: "stored session is missing" };
  }
  if (!sessionBundleHasContent(sessionFile)) {
    out("(stored session is empty)\n");
    streamPrepared = false;
    return { ok: true };
  }
  const replayed = await replaySessionBundle(sessionFile);
  if (!replayed.ok) {
    abortResume(`(resume failed: ${replayed.error})`);
    return { ok: false, error: replayed.error };
  }
  if (replayed.messages.length === 0 && replayed.maxSeq === 0) {
    out("(stored session is empty)\n");
    streamPrepared = false;
    return { ok: true };
  }
  history.length = 0;
  for (const rm of replayed.messages) {
    const m: Message = { role: rm.role, content: rm.content as Message["content"], tokens: 0, sseq: rm.sseq };
    m.tokens = estimateReclaimTokens(m.content);
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
  try {
    openSessionWriter();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    abortResume(`(resume failed: ${error})`);
    return { ok: false, error };
  }
  streamPrepared = true;
  resetCacheContinuity();
  syncIndicators();
  renderHistoryTranscript(history, surface);
  return { ok: true };
}

// ---- terminal surface ----

let surface: AgentTui | null = null;
let nonTtyTranscriptSection: "thinking" | "assistant" | null = null;
let pendingImageRefresh: Promise<void> | null = null;
let pendingImageRefreshAgain = false;

export type ShutdownOptions = {
  reason?: string;
  timeoutMs?: number;
};

export type ShutdownResult = {
  ok: boolean;
  timedOut: boolean;
  error: string | null;
};

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
let shutdownPromise: Promise<ShutdownResult> | null = null;
let processExitPromise: Promise<void> | null = null;
let shutdownRequested = false;
let processShutdownHandlersInstalled = false;

function stopInteractiveResources(): void {
  mcpSession?.shutdown();
  mcpSession = null;
  surface?.stop();
  surface = null;
}

function shutdownSynchronousResources(): void {
  stopInteractiveResources();
  closeSessionWriter();
}

function waitForRunToSettle(deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const poll = (): void => {
      if (!running) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, Math.min(25, Math.max(1, deadline - Date.now())));
    };
    poll();
  });
}

function awaitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T; error?: unknown }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, Math.max(0, timeoutMs));
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, error });
      },
    );
  });
}

/** Stop all asynchronous resources once, waiting for in-flight work to settle. */
export function shutdownAgentCore(options: ShutdownOptions = {}): Promise<ShutdownResult> {
  if (shutdownPromise) return shutdownPromise;
  shutdownRequested = true;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs as number) >= 0
    ? options.timeoutMs as number
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const reason = options.reason?.trim() || "shutdown";
  shutdownPromise = (async (): Promise<ShutdownResult> => {
    const deadline = Date.now() + timeoutMs;
    interrupted = true;
    currentAbort?.abort();
    cancelLogin();
    cancelPendingApproval("/approve deny");
    mcpGeneration++;
    mcpBusy = false;
    stopInteractiveResources();
    clientTools = TOOLS.slice();

    const runSettled = await waitForRunToSettle(deadline);
    let timedOut = !runSettled;
    if (!runSettled) {
      logEvent({ t: "shutdown_timeout", reason, phase: "run", timeoutMs });
    }
    // The writer is synchronous and must only close after the run has had a
    // bounded opportunity to finish its final session append.
    closeSessionWriter();

    let ok = true;
    let error: string | null = null;
    const remaining = Math.max(0, deadline - Date.now());
    if (traceRuntime) {
      const closed = await awaitWithin(closeTraceRuntime(), remaining);
      if (closed.timedOut) {
        timedOut = true;
        ok = false;
        error = "trace runtime close timed out";
        logEvent({ t: "shutdown_timeout", reason, phase: "trace", timeoutMs });
      } else if (closed.error) {
        ok = false;
        error = closed.error instanceof Error ? closed.error.message : String(closed.error);
        logEvent({ t: "shutdown_failure", reason, phase: "trace", error });
      } else if (closed.value !== true) {
        ok = false;
        error = "trace runtime close failed";
        logEvent({ t: "shutdown_failure", reason, phase: "trace", error });
      }
    }
    if (timedOut && error === null) error = "shutdown timed out";
    if (timedOut || !ok) logEvent({ t: "shutdown_result", reason, ok: false, timedOut, error });
    return { ok: ok && !timedOut, timedOut, error };
  })();
  return shutdownPromise;
}

function requestProcessShutdown(code: number, reason: string): void {
  if (processExitPromise) return;
  processExitPromise = shutdownAgentCore({ reason })
    .then((result) => {
      if (!result.ok) {
        process.stderr.write(`agent-core: ${reason} incomplete${result.error ? `: ${result.error}` : ""}\n`);
      }
      process.exit(code);
    })
    .catch((error: unknown) => {
      process.stderr.write(`agent-core: ${reason} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(code);
    });
}

function installProcessShutdownHandlers(): void {
  if (processShutdownHandlersInstalled) return;
  processShutdownHandlersInstalled = true;
  process.once("exit", shutdownSynchronousResources);
  process.once("SIGTERM", () => requestProcessShutdown(0, "sigterm"));
  process.once("SIGHUP", () => requestProcessShutdown(0, "sighup"));
  process.once("SIGINT", () => requestProcessShutdown(0, "sigint"));
}

async function refreshPendingImageCount(): Promise<void> {
  if (pendingImageRefresh) {
    pendingImageRefreshAgain = true;
    return pendingImageRefresh;
  }
  pendingImageRefresh = (async () => {
    do {
      pendingImageRefreshAgain = false;
      const captured = surface;
      if (!eventsDir || !terminalId || !captured) return;
      try {
        const result = await pendingImageState(eventsDir, terminalId);
        if (surface !== captured) continue;
        if (!result.ok) {
          out(`(host: ${result.error})\n`);
          return;
        }
        captured.setPendingImageCount(result.count);
      } catch (err) {
        if (surface !== captured) continue;
        out(`(host: ${err instanceof Error ? err.message : "image queue is invalid"})\n`);
        return;
      }
    } while (pendingImageRefreshAgain);
  })().finally(() => {
    pendingImageRefresh = null;
    if (pendingImageRefreshAgain) void refreshPendingImageCount();
  });
  return pendingImageRefresh;
}

function out(text: string): void {
  if (surface) surface.appendPlain(text);
  else process.stdout.write(text);
}

function streamOut(section: "thinking" | "assistant", text: string): void {
  if (!text) return;
  if (surface) {
    if (section === "thinking") surface.appendThinking(text);
    else surface.appendAssistant(text);
    return;
  }
  if (nonTtyTranscriptSection !== section) {
    process.stdout.write(`\n◆ ${section === "thinking" ? "Thinking" : "Assistant"}\n`);
    nonTtyTranscriptSection = section;
  }
  process.stdout.write(text);
}

function statusContextTokens(): number {
  return totalTokens();
}

function syncIndicators(): void {
  surface?.setStatus({
    usage: formatUsageIndicators(sessionUsage, statusContextTokens(), contextWindow(), lastUsd),
  });
}

function showPrompt(): void {
  surface?.setBusy(running || authBusy || resumeBusy || mcpBusy);
  if (!surface && !mcpBusy) out("\n> ");
}

function printSlashHelp(): void {
  const rows = [...SLASH_COMMANDS, { name: "!cmd", hint: "run a bash command" }, ...TUI_SHORTCUTS];
  const width = Math.max(...rows.map((c) => c.name.length));
  for (const c of rows) out(`  ${c.name.padEnd(width)}  ${c.hint}\n`);
}

export function parseBangCommand(line: string): { command: string } | { error: string } | null {
  if (!line.startsWith("!")) return null;
  const command = line.slice(1);
  if (!command.trim()) return { error: "empty command" };
  return { command };
}

export function bangCommandContext(command: string, output: string): string {
  return `<local-shell-command>\n${command}\n</local-shell-command>\n<local-shell-output>\n${output}\n</local-shell-output>`;
}

async function runBangCommand(command: string): Promise<void> {
  running = true;
  interrupted = false;
  showPrompt();
  try {
    if (!(await confirmBash(command))) {
      out("(bash denied)\n");
      return;
    }
    const got = await runBash(command, { cwd: canonicalCwd, shouldStop: () => interrupted });
    out(got.content.endsWith("\n") ? got.content : `${got.content}\n`);
    if (interrupted) out("(interrupted)\n");
    // A direct ! command runs outside the model's tool loop. Persist its
    // command and bounded result so the next prompt can reason about it.
    ensureFreshSession();
    pushMessage("user", bangCommandContext(command, got.content));
  } finally {
    running = false;
    interrupted = false;
    showPrompt();
    drainQueuedLine();
  }
}

function printLoginPicker(cmd: "/login" | "/logout"): void {
  const items = loginPickerItems(cmd);
  const width = Math.max(...items.map((i) => i.label.length));
  out(cmd === "/login" ? "pick a provider:\n" : "pick a credential to drop:\n");
  for (const i of items) out(`  ${i.label.padEnd(width)}  ${i.hint}  ${i.command}\n`);
}

let running = false;
let queuedLine: string | null = null;
let authBusy = false;

function drainQueuedLine(): void {
  if (queuedLine === null) return;
  const next = queuedLine;
  queuedLine = null;
  surface?.setQueued("");
  submit(next);
}

function engineBusy(): boolean {
  return running || authBusy || resumeBusy || mcpBusy;
}

export function isEngineBusy(): boolean {
  return engineBusy();
}

function submit(line: string): void {
  if (resumeBusy || mcpBusy) {
    out("(engine busy)\n");
    return;
  }
  if (running) {
    logEvent({ t: "steer_input", behavior: "steer" });
    // Keep one typed-ahead prompt. More than one has no consumer yet.
    queuedLine = line;
    surface?.setQueued(line);
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
    .then(() => drainQueuedLine());
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

let loginCodeResolve: ((code: string) => void) | null = null;
let loginAbort: AbortController | null = null;
let catalogAbort: AbortController | null = null;

function cancelLogin(): void {
  loginAbort?.abort();
  catalogAbort?.abort();
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

async function loadCatalog(
  provider: ProviderId,
  adopt: boolean,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!catalogFetchAllowed()) return { ok: false, error: "catalog fetch skipped in tests" };
  const got = await loadProviderModels(provider, signal);
  if (!got.ok) return got;
  if (adopt && provider !== route.provider) {
    route = { provider, model: DEFAULT_MODELS[provider].main };
    retargetSummary(provider);
  }
  catalogs.set(provider, got.models);
  syncModelRows();
  if (provider !== route.provider) return { ok: true };
  const preferred =
    MODEL_ENV && route.provider === parseModelRef(MODEL_ENV, PROVIDER_ENV || undefined).provider
      ? route.model
      : DEFAULT_MODELS[provider].main;
  const pick = pickDefaultModel(got.models, preferred);
  if (!pick) {
    const error = `configured model ${provider}/${preferred} is unavailable in the live catalog`;
    modelAvailabilityError = error;
    return { ok: false, error };
  }
  if (!PINNED_ROUTE || !MODEL_ENV) route.model = pick;
  else if (pick === route.model || pick.startsWith(`${route.model}-`)) route.model = pick;
  modelAvailabilityError = null;
  return { ok: true };
}

async function loadAuthenticatedCatalogs(refresh: boolean, signal?: AbortSignal): Promise<string[]> {
  if (!catalogFetchAllowed()) return [];
  const ids = AUTH_PROVIDER_ORDER.filter((id) => hasStoredCredential(id) || hasEnvCredential(id));
  const errors: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      if (!refresh && catalogs.has(id)) return;
      const got = await loadProviderModels(id, signal);
      if (!got.ok) errors.push(`${id}: ${got.error}`);
      else catalogs.set(id, got.models);
    }),
  );
  syncModelRows();
  syncIndicators();
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
    const loaded = await loadCatalog(route.provider, false);
    if (!loaded.ok) process.stderr.write(`agent-core: ${loaded.error}\n`);
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
    if (engineBusy()) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    const refresh = /\brefresh\b/.test(line);
    const abort = new AbortController();
    catalogAbort = abort;
    authBusy = true;
    showPrompt();
    void (async () => {
      try {
        const errors = await loadAuthenticatedCatalogs(refresh || catalogs.size === 0, abort.signal);
        for (const err of errors) out(`(${err})\n`);
        const listed = allCatalogModels();
        if (listed.length > 0) out(`${formatCatalogLines(listed, route.provider, route.model)}\n`);
        else out("(no model list — run /login)\n");
      } finally {
        if (catalogAbort === abort) {
          catalogAbort = null;
          authBusy = false;
        }
        showPrompt();
      }
    })();
    return;
  }
  if (!line.startsWith("/model ")) return;
  if (engineBusy()) {
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
  const abort = new AbortController();
  catalogAbort = abort;
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
        modelAvailabilityError = null;
        resetCacheContinuity();
        out(`model ${route.provider}/${route.model}\n`);
        syncStatus();
        return;
      }
      const next = parseModelSwitch(rest, route.provider);
      const auth = await resolveAuth(next.provider, abort.signal);
      if (!auth.ok) {
        out(`(${abort.signal.aborted ? "models request cancelled" : auth.error})\n`);
        return;
      }
      if (next.provider !== route.provider) {
        const got = await loadCatalog(next.provider, true, abort.signal);
        if (!got.ok) {
          out(`(${got.error})\n`);
          return;
        }
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
      modelAvailabilityError = null;
      resetCacheContinuity();
      out(`model ${route.provider}/${route.model}\n`);
      syncStatus();
    } finally {
      if (catalogAbort === abort) {
        catalogAbort = null;
        authBusy = false;
      }
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
      const got = await loadCatalog(parsed.provider, !PINNED_ROUTE, abort.signal);
      if (!got.ok) {
        out(`(${got.error})\n`);
        return;
      }
      const listed = catalogs.get(parsed.provider);
      if (got.ok && listed && listed.length > 0 && parsed.provider === route.provider) {
        out(`${formatModelBanner(listed, route.model)}\n`);
      }
      const nextAuth = await resolveAuth(route.provider, abort.signal);
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
  effortWanted = clampEffortLevel(route.provider, route.model, effortWanted);
  surface?.setEffortLevels(supportedEffortLevels(route.provider, route.model));
  surface?.setStatus({
    model: `${route.provider}/${route.model}`,
    auth: authText,
    effort: effectiveEffortFor(route.provider, route.model, effortWanted),
    usage: formatUsageIndicators(sessionUsage, statusContextTokens(), contextWindow(), lastUsd),
  });
  logSettings();
}

function dispatchLine(line: string): void {
  if (!line) {
    showPrompt();
    return;
  }
  if (line === "/exit" || line === "/quit") {
    requestProcessShutdown(0, "slash-exit");
    return;
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
    if (engineBusy()) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    printLoginPicker(line);
    showPrompt();
    return;
  }
  if (line.startsWith("/login ") || line.startsWith("/logout ")) {
    if (engineBusy()) {
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
  if (line === "/permissions") {
    out(`(permissions ${permissionMode}; choose: always, dangerous, ask)\n`);
    showPrompt();
    return;
  }
  if (line.startsWith("/permissions ")) {
    const next = line.slice("/permissions ".length).trim();
    if (next !== "always" && next !== "dangerous" && next !== "ask") {
      out("(permissions must be always, dangerous, or ask)\n");
    } else {
      permissionMode = next;
      surface?.setStatus({ permissions: permissionMode });
      out(`(permissions ${permissionMode})\n`);
    }
    showPrompt();
    return;
  }
  if (line === "/resume") {
    if (engineBusy()) out("(engine busy)\n");
    else if (history.length > 0) out("(session already live — /resume only on a fresh engine)\n");
    else {
      resumeBusy = true;
      showPrompt();
      void resumeSession();
      return;
    }
    showPrompt();
    return;
  }
  if (line === "/clear") {
    if (engineBusy()) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    if (sessionFile) {
      closeSessionWriter();
      const cleared = clearSessionBundle(sessionFile);
      if (!cleared.ok) {
        out(`(could not keep the previous session: ${cleared.error})\n`);
        showPrompt();
        return;
      }
      storageSeq = 0;
      try {
        openSessionWriter();
      } catch (err) {
        out(`(could not start a fresh session: ${err instanceof Error ? err.message : String(err)})\n`);
        showPrompt();
        return;
      }
    }
    storageSeq = 0;
    history.length = 0;
    lastHandoff = null;
    rotateCacheSession();
    sessionUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    lastUsd = null;
    permissionMode = process.env.TERMINA_CORE_APPROVE === "all" ? "always" : "ask";
    postRevision = false;
    revisions = 0;
    revisionKinds = [];
    streamPrepared = true;
    syncIndicators();
    out("(session cleared)\n");
    mcpBusy = true;
    showPrompt();
    void connectMcp().finally(() => {
      mcpBusy = false;
      showPrompt();
    });
    return;
  }
  if (line === "/compact") {
    if (engineBusy()) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    void (async () => {
      try {
        const n = await reclaim();
        const summed = await summarize();
        syncIndicators();
        out(`(compacted${n ? `; reclaimed ${n}` : ""}${summed ? "; summarized" : ""})\n`);
      } catch (err) {
        if (err instanceof SessionStoreError) out(`(storage failed: ${err.message})\n`);
        else out(`(compact failed: ${err instanceof Error ? err.message : String(err)})\n`);
      }
      showPrompt();
    })();
    return;
  }
  const effortCmd = parseEffortCommand(line);
  if (effortCmd) {
    if (engineBusy()) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    if ("error" in effortCmd) {
      out(`(${effortCmd.error})\n`);
      showPrompt();
      return;
    }
    const available = supportedEffortLevels(route.provider, route.model);
    if ("show" in effortCmd) {
      const actual = effectiveEffortFor(route.provider, route.model, effortWanted);
      out(`(effort ${actual}; available: ${available.join(", ")})\n`);
      showPrompt();
      return;
    }
    const requested = effortCmd.effort;
    effortWanted = clampEffortLevel(route.provider, route.model, requested);
    out(effortWanted === requested ? `(effort ${effortWanted})\n` : `(effort ${effortWanted}; ${requested} is unavailable)\n`);
    syncStatus();
    showPrompt();
    return;
  }
  if (line.startsWith("/")) {
    out(`(unknown command: ${line} — type /help)\n`);
    showPrompt();
    return;
  }
  const bang = parseBangCommand(line);
  if (bang) {
    if ("error" in bang) {
      out(`(${bang.error})\n`);
      showPrompt();
      return;
    }
    if (engineBusy()) {
      out("(engine busy)\n");
      showPrompt();
      return;
    }
    void runBangCommand(bang.command).catch((err: unknown) => {
      out(`\nengine error: ${(err as Error).message}\n`);
      showPrompt();
    });
    return;
  }
  submit(line);
  showPrompt();
}

async function main(): Promise<void> {
  installProcessShutdownHandlers();
  if (!traceRuntime && traceRuntimeStartupError) {
    out(`(trace startup warning: ${traceRuntimeStartupError})\n`);
  }
  if (traceRuntime) {
    try {
      const startup = await traceRuntime.ready;
      if (!startup.ok && startup.error) out(`(trace startup warning: ${startup.error})\n`);
      const manifest = traceRuntime.manifest;
      logEvent({
        t: "trace_startup",
        runId: traceRunId,
        namespace: startup.namespace,
        ok: startup.ok,
        reset: startup.reset,
        malformedRecords: startup.malformedRecords,
        partialRecords: startup.partialRecords,
        scanOmittedRecords: startup.scanOmittedRecords,
        manifestErrors: startup.manifestErrors,
        retainedRecords: startup.retainedRecords,
        omittedRecords: manifest.omittedRecords,
        writeFailures: manifest.writeFailures,
        retentionFailures: manifest.retentionFailures,
        manifestWriteFailures: manifest.manifestWriteFailures,
        startupMetadata: manifest.startup,
        error: startup.error,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out(`(trace startup warning: ${message})\n`);
      logEvent({ t: "trace_startup", runId: traceRunId, ok: false, error: message });
    }
  }
  // The TUI is constructed before the first MCP bind so it can render the
  // startup banner, but no prompt may be accepted until the tool schema is
  // fixed for this session.
  mcpBusy = true;
  freezeFrontMatter();
  await bootCatalog();
  const auth = await resolveAuth(route.provider);
  const banner = `termina agent-core v1 · model ${route.provider}/${route.model} · ${authBanner(auth)} · Ctrl+C interrupts · /exit quits\n`;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    surface = new AgentTui({
      stdin: process.stdin,
      stdout: process.stdout,
      commands: SLASH_COMMANDS,
      fileMatches: (query) => listTaggedFiles(canonicalCwd, query),
      thinkingVisible: !parseHideThinking(process.argv),
      onHostRefresh: () => {
        void refreshPendingImageCount();
      },
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
          surface?.clearChoices();
          resolve("/approve deny");
          return;
        }
        if (running) {
          interrupted = true;
          currentAbort?.abort();
        } else if (authBusy) cancelLogin();
      },
      onExit: () => {
        requestProcessShutdown(0, "tui-exit");
      },
    });
    effortWanted = clampEffortLevel(route.provider, route.model, effortWanted);
    surface.setEffortLevels(supportedEffortLevels(route.provider, route.model));
    surface.setStatus({
      model: `${route.provider}/${route.model}`,
      auth: authBanner(auth),
      effort: effectiveEffortFor(route.provider, route.model, effortWanted),
      permissions: permissionMode,
      usage: formatUsageIndicators(sessionUsage, statusContextTokens(), contextWindow(), lastUsd),
    });
    surface.setBusy(true);
    if (!surface.start()) surface = null;
    else {
      showPrompt();
      syncModelRows();
      void refreshPendingImageCount();
    }
  }
  if (!surface) out(banner);
  const bootList = currentCatalog();
  if (bootList && bootList.length > 0) out(`${formatModelBanner(bootList, route.model)}\n`);
  try {
    await connectMcp();
  } finally {
    mcpBusy = false;
  }
  const resumeResult = sessionEnvironment.TERMINA_CORE_RESUME === "1" ? await resumeSession() : { ok: true as const };
  let structured = "";
  let structuredImages: Array<{ name: string; mediaType: string }> = [];
  if (eventsDir && terminalId) {
    const control = consumeStartupControl(eventsDir, terminalId, bridgeId);
    const opId = control?.opId ?? "";
    if (!resumeResult.ok) logEvent({ t: "session_ready", opId, ok: false, error: resumeResult.error });
    else if (!control) logEvent({ t: "session_ready", opId, ok: true, reload: true });
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
      await shutdownAgentCore({ reason: "print-invalid-prompt" });
      process.exit(1);
    }
    await runPrompt(printed);
    await shutdownAgentCore({ reason: "print" });
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
