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
 * - cwd jail; grep/glob; unique edit; ranged read_file; dir listing; interruptible bash; web_search; skill index; prefix cache_control; traces
 * - last tool_result cache pin (Anthropic); session prompt_cache_key by model family; 429/network retry; model-aware effort
 * - provider auth (Anthropic, OpenAI, ChatGPT Codex, xAI, Google, OpenRouter)
 */
import {
  EFFORT_LEVELS,
  acceptedContextWindow,
  catalogOutputLimit,
  catalogSupportsTools,
  defaultContextWindow,
  effortControlFor,
  supportedEffortLevels,
  clampEffortLevel,
  thinkingRequestFor,
  adaptiveEffortFor,
  reasoningEffortFor,
  includeEncryptedReasoning,
  type EffortLevel,
} from "./models/capabilities.ts";
import { gpt56ReasoningContext, gpt5TextVerbosity } from "./models/families/openai.ts";
import { modelLeaf } from "./models/families/identity.ts";
import { claudeThinkingApi } from "./models/families/anthropic.ts";
import { consumeAgentSessionEnvironment } from "../shared/agent-environment.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join, relative } from "node:path";
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
  providerProtocol as configuredProviderProtocol,
  usesResponsesApi as configuredUsesResponsesApi,
  CACHE_CAPABILITY_FEATURE,
  cacheSessionSeed,
  cacheSessionHeaders,
  protocolEndpoint,
  providerProtocolHeaders,
  refreshOauth,
  resolveAuth,
  runLogin,
  runLogout,
  type CacheIdentity,
  type ProviderId,
  type ProviderProtocol,
} from "./auth.ts";
import {
  completionsBody,
  completionLiveDelta,
  completionResultFromEvents,
  googleGenerateBody,
  googleLiveDelta,
  googleResultFromEvents,
  isTruncatedStopReason,
  ProviderSseError,
  readSseJson,
  responsesBody,
  responsesLiveDelta,
  mergeProviderUsage,
  normalizeProviderUsage,
  providerReportedUsd,
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
  prependRequestOverlay,
  buildRequestOverlay,
  projectRequest,
  type RequestMessage,
  type RequestOverlay,
  userPromptContent as projectedUserPromptContent,
} from "./request-projection.ts";
import { salvageAssistantBlocks, type SalvageBlock } from "./main/stream-salvage.ts";
import {
  cacheWriteSupportedFor,
  classifyCacheMiss,
  emptyCacheFlipTally,
  tallyCacheFlip,
  type CacheFlipTally,
  type CacheAttemptSnapshot,
  type CachePolicyDiagnostics,
} from "./cache.ts";
import {
  emptyToolLoopTracker,
  trackToolLoopTurn,
} from "./stall.ts";
import { providerToolAdmissionError, toolExecutionWaves, toolInputError } from "./tool-dispatch.ts";
import {
  HIGH_WATER,
  LOW_WATER,
  PROTECT_TURNS,
  isContextOverflowMessage,
  cutOnlyRestoresHandoff,
  overflowProtectTurns,
  planSummary,
  restoreHandoffAfterCut,
  serializeForSummary,
  shouldCompactForCacheCost,
  summaryPrompt,
  truncateCut,
} from "./compaction.ts";
import {
  catalogFetchAllowed,
  filterCatalogModels,
  formatCatalogLines,
  formatModelBanner,
  catalogProviderId,
  contextCatalogEntryKey,
  contextCatalogProviderId,
  loadProviderModels,
  parseModelSwitch,
  pickDefaultModel,
  type CatalogModel,
  type ModelInfo,
} from "./models.ts";
import {
  acknowledgePendingImages,
  claimPendingImages,
  consumeStartupControl,
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
  logicalToolText,
  readBoundedResponseBody,
  utf8TextPrefix,
  type CompletionState,
  type ToolTextResult,
} from "./tool-output.ts";
import {
  confinePath,
  freezeCwd,
  globFiles,
  listTaggedFiles,
  readBoundedRegularFile,
  shellQuote,
} from "./main/files.ts";
import { runBash } from "./main/bash.ts";
export { runBash };
import { isDirectRunFrom } from "./main/env.ts";
import { DNS_LOOKUP_ABORTED, DNS_LOOKUP_TIMED_OUT, dnsAbortError, outboundUrlError, resolvedHostError } from "./main/url.ts";
import { policyRequest } from "./main/policy-fetch.ts";
import { grepFiles } from "./main/grep.ts";
import {
  editProjectFile,
  expandFileTags,
  fileMutationKey,
  isReplaceAll,
  readProjectFile,
  readProjectFiles,
  withFileMutation,
  writeProjectFile,
} from "./main/file-ops.ts";
import {
  createSidecarWriter,
  isValidTerminalId,
  tracesDirFor,
} from "./main/sidecar.ts";
import {
  TOOL_DISPLAY_BYTES,
  capDisplay,
  done,
  formatToolAnnounce,
  formatToolFollowup,
  reproFor,
  shouldAskPermission,
  sidecarStartFor,
  toolOutcomeTraceFields,
  toolOutcomeTraceInput,
  toolTranscriptDetail,
  toolTranscriptOutput,
  type PermissionMode,
  type ToolOutcome,
  type ToolUse,
} from "./main/tools.ts";
import { createFrontMatter } from "./main/front-matter.ts";
import { renderHistoryTranscript, type ContentBlock } from "./main/history-view.ts";
import { shouldAutoOpenLogin } from "./main/login-hint.ts";
import { buildCachedPrefix, stampHistoryCache } from "./main/anthropic-cache.ts";
import { cacheRouteForProvider, createCacheCapabilityGate } from "./main/cache-capabilities.ts";
import {
  buildCacheRequestDiagnostics,
  cacheMarkerDetails,
  type HostContextTrace,
  type TraceCacheDiagnostics,
} from "./main/cache-diagnostics.ts";
import { formatNetworkError, isRetryableNetworkError, retryAfter, retryNetworkAfter } from "./main/retry-after.ts";
import { planSidecarText, planSlashSubmit } from "./main/plan-slash.ts";
import { parseSkillCommand, skillSlashSubmit } from "./main/skill-slash.ts";
import {
  SubagentRegistry,
  MAX_SUBAGENT_MESSAGE_CHARS,
  appendSubagentInboxMessage,
  appendSubagentOutboxMessage,
  clearSubagentApprovalFiles,
  formatSubagentBrief,
  formatSubagentResultFrame,
  isApprovalAnswer,
  isLiveSubagentRun,
  isWorldlineCandidateEnv,
  parseSubagentApprovalName,
  parseSubagentTaskFile,
  readSubagentApprovalRequest,
  readSubagentInbox,
  takeSubagentOutboxLines,
  reconcileSubagentRuns,
  resolveSubagentPermissionMode,
  SUBAGENT_APPROVAL_POLL_MS,
  admitSubagentFanout,
  subagentApprovalTimeoutMs,
  subagentChildTid,
  subagentDepthFromEnv,
  subagentSpawnSidecarRecord,
  visibleSubagentTools,
  writeSubagentAckFile,
  writeSubagentApprovalRequest,
  writeSubagentTaskFile,
  MAX_SUBAGENT_FILE_BYTES,
  MAX_SUBAGENT_RESULT_CHARS,
  type SubagentTaskFile,
} from "./subagents.ts";
import {
  estimateReclaimTokens,
  makePruneRevision,
  planPruneStubs as planReclaimStubs,
  pruneCooldownHolds,
  type PruneCooldown,
  type PrunePick as ReclaimPick,
} from "./reclaim.ts";
import {
  createTraceRuntime,
  DEFAULT_TRACE_RETENTION_CAP,
  isRetriableProviderTermination,
  isTerminalTraceAttemptStatus,
  sanitizeProviderError,
  storageSeqRange,
  traceWriteDisposition,
  type TraceAttemptInput,
  type TraceCacheInput,
  type TraceCostInput as TraceRecordCostInput,
  type TraceRole,
  type TraceRuntime,
  type TraceWriteOutcome,
} from "./trace.ts";
import { applyNoQuietWins, collectTaskToolOutcomes } from "./trace/quiet-wins.ts";
import {
  SessionWriter,
  applySessionRecord,
  clearSessionBundle,
  createReplayState,
  isSessionModel,
  mayPrepareSessionForSettings,
  prepareFreshSession,
  quarantineSessionBundle,
  replaySessionBundle,
  resolveSessionFile,
  sessionBundleExists,
  sessionBundleHasContent,
  sessionBlockBytes,
  sessionBlockHash,
  isSessionBudgetExceeded,
  type SessionResult,
} from "./session.ts";
import {
  jailMcpCwd,
  loadMcpConfigs,
  mergeClientTools,
  mcpToolDefs,
  startMcp,
  userMcpPath,
  type McpSession,
} from "./mcp.ts";

import { AgentTui } from "./tui.ts";
import { SLASH_COMMANDS, TUI_SHORTCUTS, skillCommandRows } from "./tui-text.ts";
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
  if (!probe) return null;
  return hasStoredCredential(probe.provider) || hasEnvCredential(probe.provider) ? probe : null;
})();
const PINNED_ROUTE = ENV_ROUTE !== null;
let route = ENV_ROUTE ?? parseModelRef(DEFAULT_MODELS.anthropic.main, "anthropic");
/** Routing map, role → model. Mechanical work rides the cheap lane. */
let summaryRoute = (() => {
  const pinned = process.env.TERMINA_CORE_SUMMARY_MODEL;
  if (pinned) {
    const parsed = parseModelRef(pinned);
    if (parsed) return parsed;
  }
  return parseModelRef(DEFAULT_MODELS[route.provider].summary, route.provider);
})();
const catalogs = new Map<ProviderId, ModelInfo[]>();

function routeReasoningLevels(provider: ProviderId = route.provider, model: string = route.model): string[] | undefined {
  return catalogs.get(provider)?.find((entry) => entry.id === model)?.reasoningLevels;
}

// Resolve model metadata from the existing catalog for every request role,
// endpoint, serializer, and effort decision. auth.ts remains the mapper.
function providerProtocol(provider: ProviderId, model = "") {
  return configuredProviderProtocol(provider, model, catalogs.get(provider)?.find((entry) => entry.id === model)?.supportedEndpoints);
}

function usesResponsesApi(provider: ProviderId, model = "") {
  return configuredUsesResponsesApi(provider, model, catalogs.get(provider)?.find((entry) => entry.id === model)?.supportedEndpoints);
}
/** Set only after a successful catalog proves the configured/default model is unavailable. */
let modelAvailabilityError: string | null = null;
/** Leave room for thinking output. Thinking counts against max_tokens. */
const OUTPUT_CAP = 16_384;
const THINKING_OUTPUT_CAP = 64_000;
/** Consecutive server-tool pause_turn resumptions before treating the stream as wedged. */
const MAX_PAUSE_TURN_CONTINUATIONS = 5;
/** Trailing tool-output span never reclaimed (fraction of usable, clamped). */
const PROTECT_MIN = 4_000;
const PROTECT_MAX = 40_000;

/**
 * Resolve a context window from the sources in precedence order.
 *
 * Exported so the precedence is testable without a route or a network. Pure:
 * every source is passed in, so a test can exercise each layer in isolation.
 *
 * Order matters. The route's own catalog is most specific (a provider that
 * reports a window knows its own models); the shared catalog is next and is
 * what covers routes that report nothing (openai, both relays); the static
 * fallback answers last, when neither catalog is loaded.
 */
export function resolveContextWindow(sources: {
  env: string | undefined;
  providerContext: number | undefined;
  catalogContext: number | undefined;
  provider: ProviderId;
  model: string;
}): number {
  const env = acceptedContextWindow(sources.env ?? "");
  if (env !== undefined) return env;
  const provider = acceptedContextWindow(sources.providerContext);
  if (provider !== undefined) return provider;
  const catalog = acceptedContextWindow(sources.catalogContext);
  if (catalog !== undefined) return catalog;
  return defaultContextWindow(sources.provider, sources.model);
}

function contextWindow(): number {
  // The route's own catalog: a provider that reports a window knows its models.
  const hit = catalogs.get(route.provider)?.find((m) => m.id === route.model);
  return resolveContextWindow({
    env: process.env.TERMINA_CORE_CONTEXT,
    providerContext: typeof hit?.context === "number" ? hit.context : undefined,
    // The shared models.dev catalog, which covers every route whose endpoint
    // reports no window at all (openai, both relays).
    catalogContext: contextCatalogMap.get(contextCatalogEntryKey(route.provider, route.model)),
    provider: route.provider,
    model: route.model,
  });
}

function usableTokens(window = contextWindow()): number {
  const thinking = clampEffortLevel(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels()) !== "off";
  const reserved = Math.min(outputTokenBudget({ thinking }), Math.max(0, window - 1));
  return Math.max(1, window - reserved);
}

/** Catalog rejection ceiling, or the operating window when the route has one limit. */
function contextCeiling(): number {
  const hit = catalogs.get(route.provider)?.find((m) => m.id === route.model);
  const ceiling = typeof hit?.contextCeiling === "number" ? hit.contextCeiling : undefined;
  const window = contextWindow();
  return ceiling !== undefined && ceiling > window ? ceiling : window;
}

function protectTokens(): number {
  return Math.min(PROTECT_MAX, Math.max(PROTECT_MIN, Math.floor(usableTokens() * 0.25)));
}
const NOISE_FLOOR_TOKENS = 1_024;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_CAP_BYTES = 20 * 1024;
const FETCH_REDIRECT_CAP = 5;

export function parsePrintPrompt(argv: string[]): string | null {
  const i = argv.findIndex((a) => a === "-p" || a === "--print");
  if (i < 0) return null;
  return argv.slice(i + 1).join(" ").trim();
}

/** Headless subagent child mode: `--subagent-task <task-file>` (Phase 2). */
function parseSubagentTaskFlag(argv: string[]): string | null {
  const i = argv.findIndex((a) => a === "--subagent-task");
  if (i < 0) return null;
  return (argv[i + 1] ?? "").trim();
}

/** Active headless child run. Null everywhere except `--subagent-task`. */
let activeSubagent: { task: SubagentTaskFile; inboxSeq: number } | null = null;
/** Last settled run outcome, for the subagent result frame. Set at the single settle point. */
let lastRunOutcome: { status: string; failure: string | null } | null = null;

let effortWanted: EffortLevel = ((value) => {
  const wanted = value.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(wanted) ? (wanted as EffortLevel) : "medium";
})(process.env.TERMINA_CORE_EFFORT ?? "");
let currentHostContext: HostContextTrace | null = null;
let activeRequestOverlay: RequestOverlay | null = null;

export function outputTokenBudget(opts: { thinking: boolean }): number {
  return opts.thinking ? THINKING_OUTPUT_CAP : OUTPUT_CAP;
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

const sessionEnvironment = consumeAgentSessionEnvironment();
const eventsDir = sessionEnvironment.TERMINA_EVENTS_DIR ?? "";
const rawTerminalId = sessionEnvironment.TERMINA_TERMINAL_ID ?? "";
const terminalId = isValidTerminalId(rawTerminalId) ? rawTerminalId : "";
const sessionId = sessionEnvironment.TERMINA_CORE_SESSION_ID?.trim() || terminalId;
/** Stable for one logical session boundary; rotated by /clear/quarantine. */
let cacheSeed = cacheSessionSeed(sessionId);
const cacheGate = createCacheCapabilityGate({
  protocolFor: providerProtocol,
  sessionSeed: () => cacheSeed,
});
const cacheCapabilitySupported = cacheGate.supported;
const recordRejectedCacheFields = cacheGate.recordRejectedFields;
const cacheIdentityForRole = cacheGate.identityForRole;
const bridgeId = `core-${randomUUID()}`;
const traceRunId = `run-${randomUUID()}`;
const sidecar = createSidecarWriter({ eventsDir, terminalId, bridgeId });
const canonicalCwd = freezeCwd(process.cwd());
const frontMatter = createFrontMatter({ canonicalCwd });
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

type MainCacheIdentity = CacheIdentity;

function rotateCacheSession(): void {
  cacheSeed = cacheSessionSeed(undefined);
  resetCacheContinuity();
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
  role: TraceRole;
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
  role: TraceRole,
  opts: {
    parentAttemptId?: string | null;
    retryOfAttemptId?: string | null;
    fallbackReason?: string | null;
    retryCount?: number;
    provider?: ProviderId;
    model?: string;
  } = {},
): TraceAttemptState | null {
  const task = activeTraceTask;
  if (!task) return null;
  const parentAttemptId = opts.parentAttemptId === undefined
    ? role === "summary" ? task.lastMainAttemptId : task.lastMainAttemptId
    : opts.parentAttemptId;
  const retryOfAttemptId = opts.retryOfAttemptId ?? null;
  const provider = opts.provider ?? (role === "main" ? route.provider : summaryRoute.provider);
  const model = opts.model ?? (role === "main" ? route.model : summaryRoute.model);
  const attempt: TraceAttemptState = {
    task,
    attemptId: `attempt-${randomUUID()}`,
    role,
    provider,
    protocol: providerProtocol(provider, model),
    model,
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
  sidecar.logEvent({
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
      sidecar.logEvent({
        t: "trace_manifest_failure",
        kind: outcome.kind,
        path: outcome.path,
        error: outcome.error,
      });
    }
    return outcome.ok;
  } catch (error) {
    sidecar.logEvent({
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
  role: TraceRole,
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
    reusablePrefixItems: cache.reusablePrefixItems,
    comparedPrefixHash: cache.comparedPrefixHash,
    comparedPrefixItems: cache.comparedPrefixItems,
    messagePrefixHash: cache.messagePrefixHash,
    workingSetHash: cache.workingSetHash,
    workingSetChanged: cache.workingSetChanged,
    hostContext: cache.hostContext,
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
    providerError?: string | null;
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
    requestedEffort: attempt.role === "main" ? effortWanted : "off",
    effectiveEffort: attempt.role === "main"
      ? clampEffortLevel(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels())
      : clampEffortLevel(summaryRoute.provider, summaryRoute.model, "off", providerProtocol(summaryRoute.provider, summaryRoute.model), routeReasoningLevels(summaryRoute.provider, summaryRoute.model)),
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
    providerError: fields.providerError ?? null,
  };
  try {
    let outcome = await traceRuntime.writeAttempt(input);
    let disposition = traceWriteDisposition(outcome);
    if (disposition.retry && attempt.traceWriteRetries < 1) {
      attempt.traceWriteRetries += 1;
      const failure = outcome.ok ? null : outcome;
      sidecar.logEvent({
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
      sidecar.logEvent({
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
    sidecar.logEvent({ t: "trace_write_failure", kind: "write-failure", persisted: false, error: error instanceof Error ? error.message : String(error) });
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
    const collected = collectTaskToolOutcomes(traceRuntime.directory, task.runId, task.taskId);
    const gated = applyNoQuietWins(status, collected.readable ? collected.outcomes : null);
    traceFailure(await traceRuntime.writeTaskSettled({
      runId: task.runId,
      taskId: task.taskId,
      taskClass: task.taskClass,
      attemptCount: task.attemptIds.length,
      finalAttemptId: task.finalAttemptId,
      attemptIds: task.attemptIds,
      summaryAttemptIds: task.summaryAttemptIds,
      outcome: { status: gated.status, criteriaHash: task.criteriaHash },
      criticalClass: gated.criticalClass,
    }));
  } catch (error) {
    sidecar.logEvent({ t: "trace_write_failure", kind: "write-failure", persisted: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    activeTraceTask = null;
    inFlightTraceAttempt = null;
  }
}

function hashSystem(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
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
  return buildCacheRequestDiagnostics({
    body,
    identity,
    cacheIdentity,
    overlay,
    hostContext,
    fallbackReason,
    priorPolicy,
    retryPromptIdentical,
    previousDiagnostics: cacheIdentity?.role === "main" ? previousCacheAttempt?.diagnostics : null,
    cacheKeySupported: cacheCapabilitySupported(identity.provider, identity.model, CACHE_CAPABILITY_FEATURE.promptCacheKey),
    codexTurnStateUsed: identity.provider === "openai-codex" && Boolean(codexTurnState),
    noiseFloorTokens: NOISE_FLOOR_TOKENS,
  });
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
  providerError?: string | null;
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
    providerError: opts.providerError ?? null,
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
  if (testOnlyOpenSessionWriterOverride) {
    testOnlyOpenSessionWriterOverride();
    return;
  }
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

function persistRouteSettings(): number {
  const model = `${route.provider}/${route.model}`;
  return persist({
    type: "settings",
    effort: effortWanted,
    ...(isSessionModel(model) ? { model } : {}),
  });
}

function persistRouteSettingsOrWarn(label: string): void {
  try {
    ensureRouteSettingsWritable();
    persistRouteSettings();
  } catch (err) {
    out(`(${label}; setting not persisted: ${notPersistedReason(err)})\n`);
  }
}

/**
 * Pre-stream /model and /effort run before any submit opened the session
 * writer. Preparing is safe only when no stored bundle could be disturbed,
 * so a later /resume still finds it untouched.
 */
function ensureRouteSettingsWritable(): void {
  const hasContent = sessionFile ? sessionBundleHasContent(sessionFile) : false;
  if (mayPrepareSessionForSettings(sessionFile, sessionWriter !== null, hasContent)) {
    ensureFreshSession();
  }
}

/**
 * Human cause for a settings write failure. A closed writer over a stored
 * bundle means resume-or-submit comes first (a submit re-pins the route on
 * its own; resume restores the stored route, so the switch must be
 * repeated after it); anything else is the raw error.
 */
function notPersistedReason(err: unknown): string {
  if (!sessionWriter && sessionFile && sessionBundleHasContent(sessionFile)) {
    return "a stored session is waiting — send a message to pin it, or repeat after /resume";
  }
  return err instanceof Error ? err.message : String(err);
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

export function fetchUrlError(url: string): string | null {
  return outboundUrlError(url);
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
  // One operation deadline for DNS, connect, TLS, redirects, and body: the
  // abort below races the resolve precheck as well as the socket (#159).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const poll = setInterval(() => {
    if (shouldStop()) ac.abort();
  }, 50);
  if (shouldStop()) ac.abort();
  try {
    let current = url;
    for (let hop = 0; hop <= FETCH_REDIRECT_CAP; hop++) {
      const bad = fetchUrlError(current);
      if (bad) return fail(bad);
      let hopHost: string;
      try {
        hopHost = new URL(current).hostname;
      } catch {
        return fail("error: invalid URL");
      }
      try {
        // An already-requested stop fails before DNS, never after it.
        if (shouldStop()) throw dnsAbortError();
        const resolved = await resolvedHostError(hopHost, { signal: ac.signal });
        if (resolved === DNS_LOOKUP_ABORTED || resolved === DNS_LOOKUP_TIMED_OUT) throw dnsAbortError();
        if (resolved) return fail(resolved);
        const res = await policyRequest({
          url: current,
          method: "GET",
          headers: { accept: "text/*, application/json, application/xml;q=0.9, */*;q=0.1" },
          signal: ac.signal,
        });
        if (res.status >= 300 && res.status < 400) {
          res.cancel();
          const loc = res.headers.get("location");
          if (!loc) return fail("error: redirect without location");
          try {
            current = new URL(loc, current).href;
          } catch {
            return fail("error: invalid redirect location");
          }
          continue;
        }
        if (res.status < 200 || res.status >= 300) {
          const detailAccumulator = new BoundedTextAccumulator({ maxBytes: 2 * 1024, direction: "head", marker: "" });
          let detailSeen = 0;
          try {
            for await (const chunk of res.body) {
              const bytes = chunk as Uint8Array;
              detailAccumulator.push(bytes);
              detailSeen += bytes.byteLength;
              if (detailSeen > 2 * 1024) {
                res.cancel();
                break;
              }
            }
          } catch (err) {
            // A decoding or socket error mid-body must still release the
            // connection; the outer catch maps the failure.
            res.cancel();
            throw err;
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
        try {
          for await (const chunk of res.body) {
            const bytes = chunk as Uint8Array;
            body.push(bytes);
            bodySeen += bytes.byteLength;
            if (bodySeen > FETCH_CAP_BYTES) {
              sourceTruncated = true;
              res.cancel();
              break;
            }
          }
        } catch (err) {
          // A decoding or socket error mid-body must still release the
          // connection; the outer catch maps the failure.
          res.cancel();
          throw err;
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
      }
    }
    return fail("error: too many redirects");
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
  }
}

/** Bash approval policy for this terminal process. `/clear`/`/new` rotate the conversation, not this policy. */
let permissionMode: PermissionMode = process.env.TERMINA_CORE_APPROVE === "all" ? "always" : "ask";
let approvalResolve: ((line: string) => void) | null = null;
let approvalQueue = Promise.resolve();
const protectedTaskApprovals = new Set<string>();

/** Resolve an in-flight permission prompt before tearing down its surface. */
function cancelPendingApproval(line = "/approve deny"): boolean {
  const resolve = approvalResolve;
  if (!resolve) return false;
  approvalResolve = null;
  surface?.clearChoices();
  resolve(line);
  return true;
}

/** Approve bash in the TUI, where the command and its context already live. */
/**
 * Headless child approval (Phase 3): ask the parent through the approval
 * file channel and wait for the ack. Anything but an explicit `{ok: true}`
 * ack — timeout, missing channel, stale run — denies. Approval is strictly
 * once-only: the child can never grant itself (or its parent) `always`.
 */
let subagentApprovalSeq = 0;
async function requestParentApproval(kind: "bash" | "protected", text: string): Promise<boolean> {
  const run = activeSubagent;
  if (!run || !eventsDir) return false;
  const parentTid = run.task.parentTerminalId;
  const childTid = subagentChildTid(parentTid, run.task.runId);
  if (!childTid) return false;
  subagentApprovalSeq += 1;
  // The pid separates retried attempts (fresh processes reset the counter);
  // without it two attempts in the same millisecond could share a reqId and
  // the parent's pending-set would hide the second request forever.
  const reqId = `appr-${process.pid.toString(36)}-${Date.now().toString(36)}-${subagentApprovalSeq}`;
  const written = writeSubagentApprovalRequest(eventsDir, parentTid, run.task.runId, { reqId, kind, text });
  if (!written.ok) return false;
  const ack = await waitForAck(eventsDir, childTid, reqId, subagentApprovalTimeoutMs(), childTid, {
    shouldStop: () => interrupted,
  });
  return ack?.ok === true;
}

async function confirmBashNow(command: string): Promise<boolean> {
  if (interrupted) return false;
  if (!shouldAskPermission(permissionMode, command)) return true;
  if (activeSubagent && !surface?.active()) return requestParentApproval("bash", command);
  if (!surface?.active()) return false;
  surface.setChoices(`Approve bash? ${command.slice(0, 160)}`, [
    { name: "Deny", hint: "reject this command", submit: "/approve deny" },
    { name: "Approve once", hint: "run this command", submit: "/approve once" },
    { name: "Always approve", hint: "run bash without asking this terminal", submit: "/approve always" },
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

/** Approval requests already queued or answered this session (no double pickers). */
const pendingSubagentApprovals = new Set<string>();

/** Drop this session's approval queue state (called on `/clear`). Runs stay
 *  for reconcile to settle via their killed results; only the picker queue
 *  and dead request files go, so a cleared session never re-offers approvals
 *  for children the host just killed. */
function clearSubagentApprovals(): void {
  pendingSubagentApprovals.clear();
  if (!eventsDir || !terminalId) return;
  clearSubagentApprovalFiles(eventsDir, terminalId);
}

let subagentApprovalTimer: ReturnType<typeof setInterval> | null = null;

/** True while the parent turn is live or a child can still ask for approval. */
function subagentApprovalsNeedPoll(): boolean {
  return running || subagentRegistry.activeRuns().length > 0;
}

/** Mid-stream poller: a long parent stream must not hold child approvals hostage.
 *  Fire-and-forget children also need this after the parent settles: bash/protected
 *  asks land while the parent is idle, and a stopped timer used to deny them all.
 *  The same tick reconciles result files so the title-line count drops without
 *  waiting for the next user turn. */
function startSubagentApprovalTimer(): void {
  if (subagentApprovalTimer) return;
  subagentApprovalTimer = setInterval(() => {
    if (!subagentApprovalsNeedPoll()) return;
    try {
      syncSubagentChrome();
      pollSubagentApprovals();
    } catch {
      /* Best-effort: the per-turn poll retries. */
    }
  }, SUBAGENT_APPROVAL_POLL_MS);
  const timer = subagentApprovalTimer as unknown as { unref?: () => void };
  if (typeof timer.unref === "function") timer.unref();
}

function stopSubagentApprovalTimer(): void {
  if (subagentApprovalsNeedPoll()) return;
  if (!subagentApprovalTimer) return;
  clearInterval(subagentApprovalTimer);
  subagentApprovalTimer = null;
}

/** Registry truth plus the TUI live-run count. Reconcile first so finished
 *  children leave the title as soon as their result files land. */
function syncSubagentChrome(): void {
  if (eventsDir && terminalId) reconcileSubagentRuns(eventsDir, terminalId, subagentRegistry);
  surface?.setSubagentCount(subagentRegistry.activeRuns().length);
  stopSubagentApprovalTimer();
}

/**
 * Parent side of child approvals (Phase 3). Surface fresh requests from
 * live runs in the parent's own choice picker — Deny and Approve once
 * only, never Always, so a child can never escalate either side to
 * auto-approve. Stale requests, runs that already settled, and headless
 * parents (no picker surface) resolve to a fast deny ack instead of
 * making the child hang the full timeout.
 */
function pollSubagentApprovals(): void {
  if (!eventsDir || !terminalId || subagentRegistry.activeRuns().length === 0) return;
  let names: string[];
  try {
    names = readdirSync(eventsDir);
  } catch {
    return;
  }
  const timeout = subagentApprovalTimeoutMs();
  for (const name of names) {
    const parsed = parseSubagentApprovalName(terminalId, name);
    if (!parsed) continue;
    const runId = parsed.runId;
    const reqId = parsed.reqId;
    const key = `${runId}/${reqId}`;
    if (pendingSubagentApprovals.has(key)) continue;
    const run = subagentRegistry.get(runId);
    const req = readSubagentApprovalRequest(join(eventsDir, name));
    const fresh = req.ok && Date.now() - req.file.createdAt < timeout;
    if (!isLiveSubagentRun(run) || !fresh) {
      try {
        rmSync(join(eventsDir, name));
      } catch {
        /* Dead letter stays for the startup sweep. */
      }
      continue;
    }
    const childTid = subagentChildTid(terminalId, runId);
    if (!childTid) continue;
    pendingSubagentApprovals.add(key);
    if (!surface?.active()) {
      writeSubagentAckFile(eventsDir, childTid, reqId, { ok: false });
      try {
        rmSync(join(eventsDir, name));
      } catch {
        /* Dead letter stays for the startup sweep. */
      }
      pendingSubagentApprovals.delete(key);
      continue;
    }
    const kind = req.file.kind;
    const text = req.file.text;
    const createdAt = req.file.createdAt;
    void queueApproval(async () => {
      // Re-check freshness: a request queued behind other pickers may have
      // outlived the child's wait. Asking about a dead request wastes
      // attention and writes an orphan ack.
      if (Date.now() - createdAt >= timeout) {
        try {
          rmSync(join(eventsDir, name));
        } catch {
          /* Dead letter stays for the startup sweep. */
        }
        pendingSubagentApprovals.delete(key);
        return false;
      }
      // Re-check liveness too: the run may have settled while queued. A
      // picker for a dead run would write an orphan ack for a child that is
      // no longer waiting.
      const live = subagentRegistry.get(runId);
      if (!isLiveSubagentRun(live)) {
        try {
          rmSync(join(eventsDir, name));
        } catch {
          /* Dead letter stays for the startup sweep. */
        }
        pendingSubagentApprovals.delete(key);
        return false;
      }
      const question = kind === "bash"
        ? `Subagent ${runId} asks to run bash: ${text.slice(0, 160)}`
        : `Subagent ${runId} asks to edit protected file: ${text.slice(0, 160)}`;
      surface!.setChoices(question, [
        { name: "Deny", hint: "reject this request", submit: "/approve deny" },
        { name: "Approve once", hint: "allow this once", submit: "/approve once" },
      ]);
      const line = await new Promise<string>((resolve) => {
        approvalResolve = resolve;
      });
      if (approvalResolve) approvalResolve = null;
      surface?.clearChoices();
      const ok = line === "/approve once";
      writeSubagentAckFile(eventsDir, childTid, reqId, { ok });
      try {
        rmSync(join(eventsDir, name));
      } catch {
        /* Dead letter stays for the startup sweep. */
      }
      pendingSubagentApprovals.delete(key);
      return ok;
    });
  }
}

/**
 * Child side of parent messaging (Phase 3): inject newly arrived parent
 * inbox entries as one user turn per model turn. Retried attempts may
 * re-inject older entries; entries carry sequence numbers so repeats are
 * recognizable. Returns whether a message was injected.
 */
function drainSubagentInbox(): boolean {
  const run = activeSubagent;
  if (!run || !eventsDir) return false;
  const inbox = readSubagentInbox(eventsDir, run.task.parentTerminalId, run.task.runId);
  if (!inbox) return false;
  const fresh = inbox.messages.filter((m) => m.seq > run.inboxSeq);
  if (fresh.length === 0) return false;
  run.inboxSeq = fresh[fresh.length - 1]!.seq;
  const lines = fresh.map((m) => `Parent message (seq ${m.seq}): ${m.text}`);
  pushMessage("user", [{ type: "text", text: lines.join("\n") }]);
  return true;
}

/** Child → parent after a finished model turn. Same events-dir file the parent drains live. */
const subagentOutboxSeen = new Map<string, number>();

function reportSubagentTurn(text: string, tools: string[]): void {
  const run = activeSubagent;
  if (!run || !eventsDir) return;
  const parts = [text.trim()];
  if (tools.length > 0) parts.push(`Tools: ${tools.join(", ")}`);
  let body = parts.filter(Boolean).join("\n");
  if (!body) return;
  if (body.length > MAX_SUBAGENT_MESSAGE_CHARS) body = body.slice(0, MAX_SUBAGENT_MESSAGE_CHARS);
  appendSubagentOutboxMessage(eventsDir, run.task.parentTerminalId, run.task.runId, body);
}

function drainSubagentOutbox(): boolean {
  if (activeSubagent || !eventsDir || !terminalId) return false;
  const lines = takeSubagentOutboxLines(eventsDir, terminalId, subagentOutboxSeen);
  if (lines.length === 0) return false;
  pushMessage("user", [{ type: "text", text: lines.join("\n") }]);
  return true;
}

/** Parent stays in this run until live children settle. A child turn continues the model. */
async function waitForSubagentTurns(): Promise<boolean> {
  if (activeSubagent) return false;
  while (!interrupted) {
    syncSubagentChrome();
    pollSubagentApprovals();
    if (drainSubagentOutbox()) return true;
    if (subagentRegistry.activeRuns().length === 0) return false;
    await new Promise((resolve) => setTimeout(resolve, SUBAGENT_APPROVAL_POLL_MS));
  }
  return false;
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
  // A headless child enforces its parent's Mine marks: user-owned files stay
  // off-limits across the process boundary with no channel to widen them.
  const policyTid = activeSubagent ? activeSubagent.task.parentTerminalId : terminalId;
  if (protectedTaskApprovals.has(target)) return true;
  const protectedPaths = readProtectedPaths(eventsDir, policyTid);
  // Fail closed: an unreadable policy denies the mutation (#218). Only a
  // missing policy file reads as empty (allowed).
  if (protectedPaths === null) return false;
  if (!protectedPaths.has(target)) return true;
  const label = relative(canonicalCwd, target) || target;
  if (activeSubagent && !surface?.active()) return requestParentApproval("protected", label);
  if (!surface?.active()) return false;
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

async function executeTool(use: ToolUse, parentTruncated = false): Promise<ToolOutcome> {
  const notExecuted = (text: string): ToolOutcome => ({ ...done(use, text, true), executed: false });
  if (interrupted) return notExecuted("(interrupted by user; tool not executed)");
  if (!clientTools.some((tool) => tool.name === use.name)) return notExecuted(`error: unknown tool ${use.name}`);
  if (use.name === "read_file") {
    if (use.input.paths !== undefined) {
      const got = readProjectFiles(canonicalCwd, use.input, frontMatter.allowPaths);
      return done(use, got);
    }
    const got = readProjectFile(canonicalCwd, use.input, frontMatter.allowPaths);
    return done(use, got);
  }
  if (use.name === "write_file") {
    return withFileMutation(fileMutationKey(canonicalCwd, use.input.path), async () => {
      if (!(await confirmProtectedMutation(use.input.path))) return notExecuted("error: protected file edit denied");
      if (interrupted) return notExecuted("(interrupted by user; tool not executed)");
      const got = writeProjectFile(canonicalCwd, use.input.path, use.input.content ?? "");
      return done(use, got.content, got.isError);
    });
  }
  if (use.name === "edit") {
    return withFileMutation(fileMutationKey(canonicalCwd, use.input.path), async () => {
      if (!(await confirmProtectedMutation(use.input.path))) return notExecuted("error: protected file edit denied");
      if (interrupted) return notExecuted("(interrupted by user; tool not executed)");
      const got = editProjectFile(
        canonicalCwd,
        use.input.path,
        use.input.old_text ?? "",
        use.input.new_text ?? "",
        isReplaceAll(use.input.replace_all),
      );
      return done(use, got.content, got.isError);
    });
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
    if (!(await confirmBash(command))) return notExecuted("error: bash denied");
    if (interrupted) return notExecuted("(interrupted by user; tool not executed)");
    const got = await runBash(command, { cwd: canonicalCwd, shouldStop: () => interrupted });
    return done(use, got);
  }
  if (use.name === "spawn_subagent") {
    // Worldline candidates run sandboxed with auto-approve; a host-spawned
    // child would escape that sandbox, so the tool fails closed here and the
    // host refuses their sidecar spawns too.
    if (IS_WORLDLINE_CANDIDATE) return done(use, "error: spawn_subagent is disabled in worldline candidates", true);
    // A length-truncated turn may carry cut-off brief arguments that parse
    // but are silently incomplete. Never spawn from one: the child would boot
    // on a broken brief and burn its run failing.
    if (parentTruncated) {
      return done(use, "error: parent turn hit the output limit, so the brief may be truncated — re-issue spawn_subagent with the complete brief", true);
    }
    // Forward paths/user_requested raw: the registry validates them so
    // malformed input fails closed instead of silently dropping protection.
    const got = await subagentRegistry.spawn({
      task: String(use.input.task ?? ""),
      ...(use.input.model === undefined ? {} : { model: String(use.input.model) }),
      ...(use.input.effort === undefined ? {} : { effort: String(use.input.effort) }),
      ...(use.input.paths === undefined ? {} : { paths: use.input.paths }),
      ...(use.input.resume === undefined ? {} : { resume: use.input.resume }),
      ...(use.input.user_requested === undefined ? {} : { userRequested: use.input.user_requested }),
      parent: {
        provider: route.provider,
        model: route.model,
        protocol: providerProtocol(route.provider, route.model),
        permissionMode,
        depth: SUBAGENT_DEPTH,
      },
    });
    if (!got.ok) {
      syncSubagentChrome();
      return done(use, `error: ${got.error}`, true);
    }
    if (interrupted) {
      subagentRegistry.settleRun(got.run.id, "interrupted before host handoff", "failed");
      syncSubagentChrome();
      return done(use, "(interrupted by user; subagent not started)", true);
    }
    // Hand the validated run to the host: task file first (it lands before
    // the queued sidecar record), then announce. A failed handoff fails the
    // run exactly once so the slot and claims release. The child-facing
    // brief carries live sibling claims (Phase 4 coordination); the run
    // record keeps the original task.
    const siblingPaths = subagentRegistry
      .activeRuns()
      .filter((r) => r.id !== got.run.id)
      .flatMap((r) => r.paths);
    const brief = formatSubagentBrief(got.run.task, siblingPaths);
    const handoff = writeSubagentTaskFile(eventsDir, got.run, { parentTerminalId: terminalId, cwd: canonicalCwd, brief });
    if (!handoff.ok) {
      subagentRegistry.settleRun(got.run.id, `host handoff failed: ${handoff.error}`, "failed");
      syncSubagentChrome();
      return done(use, `error: ${handoff.error}`, true);
    }
    sidecar.logEvent(subagentSpawnSidecarRecord(got.run.id, handoff.file, got.run.userRequested));
    syncSubagentChrome();
    return done(use, JSON.stringify({ runId: got.run.id }));
  }
  if (use.name === "message_subagent") {
    const runId = String(use.input.run_id ?? "");
    const text = String(use.input.text ?? "");
    const got = subagentRegistry.message(runId, text);
    if (!got.ok) return done(use, `error: ${got.error}`, true);
    // Mirror accepted messages to the inbox file the child drains. A failed
    // mirror errors (fail closed) so the parent never believes an undelivered
    // message landed.
    if (eventsDir && terminalId) {
      const mirrored = appendSubagentInboxMessage(eventsDir, terminalId, runId, text);
      if (!mirrored.ok) return done(use, `error: ${mirrored.error}`, true);
    }
    return done(use, JSON.stringify({ ok: true }));
  }
  if (mcpSession?.tools.some((t) => t.name === use.name)) {
    const got = await mcpSession.call(use.name, use.input, { shouldStop: () => interrupted });
    return done(use, got);
  }
  return done(use, `error: unknown tool ${use.name}`, true);
}

const TOOLS: Array<Record<string, unknown>> = [
  {
    name: "read_file",
    description:
      "Read a text file relative to the working directory. Results start with a path and line-range header, then the file bytes for that range — copy those bytes into edit old_text. Caps near 40 KB of file bytes. Optional start_line and end_line (inclusive). Pass offset (bytes) only to continue a truncated read; do not combine with start_line. A directory path lists that directory. Pass paths (up to 10) to read several files in one bounded 40 KB result; omitted tail files are named — read them explicitly. Use path or paths, not both; offset/start_line/end_line apply to path only.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "File or directory path relative to the working directory." },
        paths: { type: "array", description: "Up to 10 file paths for one bounded batch read.", items: { type: "string" } },
        offset: { type: "number", description: "Byte offset to continue a truncated read. Do not combine with start_line." },
        start_line: { type: "number", description: "1-based inclusive start line." },
        end_line: { type: "number", description: "1-based inclusive end line." },
      },
      required: [],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file relative to the working directory. Parent directories are created. Paths stay inside the project. After you have a template or the contents, call this with the file body. For a large new file, write a complete first version, then edit to append; do not re-read a template instead of writing.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Replace old_text with new_text in an existing file. Prefer this over write_file when the file already exists. Default: one unique occurrence (fails if missing or repeated). Set replace_all to replace every occurrence. Miss errors include occurrence count and nearby lines; copy a corrected unique old_text from those lines and retry. Do not re-read unless the nearby lines are not enough.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Existing file path relative to the working directory." },
        old_text: {
          type: "string",
          description:
            "Exact current text to replace, copied from observed file content (complete grep hit, working-set overlay, or a prior read). Preserve tabs/spaces. Include enough surrounding context for a unique match unless replace_all is true. Empty string is rejected.",
        },
        new_text: { type: "string", description: "Replacement text. Preserve the file's indentation and whitespace style." },
        replace_all: { type: "boolean", description: "When true, replace every occurrence of old_text instead of requiring a unique match." },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with a regular expression. Uses ripgrep when available. Prefer this over bash rg or grep. Groups hits by file, shows sparse files first, and caps per file. Skip ignored directories. Narrow with path or glob when a file has more hits. An empty result is exactly (no matches); broaden the pattern or try a different path/glob, or list files with glob. Edit from a grep hit only when the shown line is complete and unique; copy the hit text, not the line-number header. Otherwise read.",
    input_schema: {
      type: "object",
      additionalProperties: false,
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
    description: "Find files relative to the working directory. Pattern supports * ** and ? only. An empty result is exactly (no matches); widen the pattern or check the path.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "bash",
    description:
      "Run one bash command in the working directory. 10 min timeout. Waits for background jobs and the process group (`&` does not return early). Combined output caps near 20 KB and always ends with [exit N]. Use grep or glob for file search; do not call rg.",
    input_schema: { type: "object", additionalProperties: false, properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "fetch",
    description: "Fetch an https URL. Output caps near 20 KB. No file or data URLs.",
    input_schema: { type: "object", additionalProperties: false, properties: { url: { type: "string" } }, required: ["url"] },
  },
];

/**
 * Background subagents (SUBAGENTS-PLAN.md Phase 1: tool surface + registry).
 * Depth comes from the environment so headless children (Phase 2) inherit it;
 * children never receive `spawn_subagent` (max depth 1). Worldline candidates
 * never receive it either: the host refuses their spawns, so offering the
 * tool would only burn a run that fails closed.
 */
const SUBAGENT_DEPTH = subagentDepthFromEnv(process.env);
const IS_WORLDLINE_CANDIDATE = isWorldlineCandidateEnv(process.env);
for (const def of visibleSubagentTools(SUBAGENT_DEPTH)) {
  if (IS_WORLDLINE_CANDIDATE && def.name === "spawn_subagent") continue;
  TOOLS.push(def);
}

/** Built-in client tools before MCP merge. Tests inspect input contracts here. */
export function builtinClientTools(): ReadonlyArray<Record<string, unknown>> {
  return TOOLS;
}

const subagentRegistry = new SubagentRegistry();

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
  sidecar.logEvent(sidecarStartFor(use));
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
      sidecar.logEvent(sidecarStartFor({ name, id: b.id ?? "", input: {} }));
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
      if (b.tool_use_id) sidecar.logEvent({ t: "tool_end", toolCallId: b.tool_use_id, isError: err });
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

interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  tokens: number;
  /** Stable storage address. Revision records point here, never at
   *  shifting array indices. */
  sseq: number;
}

const history: Message[] = [];

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
    overlay: buildRequestOverlay({ hostContext }),
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

let postRevision = false;
type RevisionKind = "prune" | "summarize" | "truncate";
let revisions = 0;
let revisionKinds: RevisionKind[] = [];
let lastBilledTokens: number | null = null;
let lastCacheReadShare: number | null = null;
let lastRequestFollowedRevision = false;
let pendingReclaimEvidence: Record<string, unknown> | null = null;
// Growth-based prune pacing: set after each applied prune, cleared by
// summarize/truncate/continuity resets. See pruneCooldownHolds.
let pruneCooldown: PruneCooldown | null = null;

function recordRevision(kind: RevisionKind): void {
  revisions++;
  revisionKinds.push(kind);
  postRevision = true;
  // Every durable revision changes the billed request, including pruning.
  // Reusing that stale pressure can immediately trigger a second revision.
  lastBilledTokens = null;
  lastCacheReadShare = null;
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

/** Install a replayed prior-run bundle into a resuming headless child, so the
 *  new brief runs as a follow-up instead of a fresh session. Mirrors the
 *  core of resumeSessionBody without interactive output: the task file pins
 *  the effort for this run, so a saved effort is intentionally not restored.
 *  Marks the stream prepared so runPrompt cannot rotate the bundle away. */
function installReplayedMessages(replayed: {
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: unknown; sseq: number }>;
  maxSeq: number;
}): void {
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
}

export function installResumedSubagentHistory(replayed: {
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: unknown; sseq: number }>;
  maxSeq: number;
}): void {
  installReplayedMessages(replayed);
  openSessionWriter();
  streamPrepared = true;
  resetCacheContinuity();
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

/** Plan and durably apply the canonical reclaim receipt before changing the view.
 * Automatic loop calls pace back-to-back prunes by token growth; explicit
 * intents (overflow retry, /compact) pass ignoreCooldown. */
async function reclaim(ignoreCooldown = false): Promise<number> {
  const usable = usableTokens();
  if (!ignoreCooldown && pruneCooldown !== null) {
    // Growth-based pacing, not turn-based: hold until new pressure exceeds
    // what the last prune reclaimed plus one hysteresis band of noise.
    // Must-fit always proceeds so pacing can never force an overflow.
    const current = totalTokens();
    const margin = Math.ceil(usable * (HIGH_WATER - LOW_WATER));
    if (Math.max(current, lastBilledTokens ?? 0) < usable &&
        pruneCooldownHolds(pruneCooldown, current, margin)) {
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
        skipped: "prune-cooldown",
        growthTokens: current - pruneCooldown.baseTotal,
        cooldownReclaimedTokens: pruneCooldown.reclaimedTokens,
        cooldownMarginTokens: margin,
      };
      return 0;
    }
    pruneCooldown = null;
  }
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
      systemTokens: estimateReclaimTokens(frontMatter.systemPrompt()) + activeOverlayTokens(),
      toolSchemaTokens: toolSchemaTokens(),
      usable,
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
  recordRevision("prune");
  pruneCooldown = {
    baseTotal: totalTokens(),
    reclaimedTokens: revision.targets.reduce((sum, target) => sum + target.reclaimedTokens, 0),
  };
  syncIndicators();
  return revision.targets.length;
}

/** Last resort when reclamation alone cannot fit the window: drop whole old
 *  turns, cutting only at real prompts. Storage keeps every dropped byte.
 *  Continuity is the existing summarize handoff, re-inserted when the cut
 *  would drop it. protectTurns=1 is overflow-only, and only when that
 *  handoff already exists. */
function truncate(protectTurns: number = PROTECT_TURNS): boolean {
  const estimate = totalTokens();
  const effective = Math.max(estimate, lastBilledTokens ?? 0);
  if (effective < usableTokens()) return false;
  // Walk in one scale: billed truth and the byte heuristic disagree by a
  // ratio, so decrement each message's estimate share scaled to the effective
  // total. Without this a billed-high/estimate-low window walks the whole
  // history and drops everything but the tail.
  const scale = estimate > 0 ? effective / estimate : 1;
  const cut = truncateCut(history, effective, usableTokens(), usableTokens() * LOW_WATER, scale, protectTurns);
  if (cut <= 0 || cutOnlyRestoresHandoff(history, cut, lastHandoff)) return false;
  const restore = restoreHandoffAfterCut(lastHandoff, history.slice(cut));
  const sseq = storageSeq + 1;
  persist({
    type: "revision",
    kind: "truncate",
    dropped: cut,
    ...(restore ? { summarySseq: sseq, message: { role: "user" as const, content: restore } } : {}),
  });
  history.splice(0, cut);
  if (restore) {
    const m: Message = { role: "user", content: restore, tokens: estimateReclaimTokens(restore), sseq };
    history.unshift(m);
  }
  recordRevision("truncate");
  pruneCooldown = null;
  syncIndicators();
  out(`[context truncated: ${cut} messages dropped]\n`);
  return true;
}

// ---- summarization ----

/** The chained handoff. Each summary folds the previous one in. */
let lastHandoff: string | null = null;

function totalTokens(): number {
  return estimateReclaimTokens(frontMatter.systemPrompt()) + toolSchemaTokens() + activeOverlayTokens() + history.reduce((s, m) => s + m.tokens, 0);
}

/**
 * Compaction decisions use billed truth when the provider reported it: the
 * local bytes/4 heuristic undercounts some tokenizers, so gating only on the
 * estimate lets a 507k-token request pass an 80% high-water check and then
 * fail with `maximum prompt length`. Take the larger of estimate and last
 * billed total; display paths keep using totalTokens().
 */
function effectiveTotalTokens(): number {
  return Math.max(totalTokens(), lastBilledTokens ?? 0);
}

/** Collapse old turns into one handoff message. Runs on the cheap lane,
 *  falling back to the current main model when the cheap lane fails.
 *  Returns false when there is nothing safely evictable or every call fails;
 *  callers fall back to truncate. */
async function summarize(required = false): Promise<boolean> {
  const usable = usableTokens();
  const plan = planSummary(history, {
    lastHandoffBody: lastHandoff,
    guardTokens: Math.min(protectTokens(), usable / 4),
    minimumReclaimTokens: required || effectiveTotalTokens() >= usable ? 0 : Math.ceil(usable * (HIGH_WATER - LOW_WATER)),
  });
  if (!plan) return false;
  const { boundary, evicted } = plan;
  const prompt = summaryPrompt(lastHandoff, serializeForSummary(evicted));
  const started = Date.now();
  currentAbort ??= new AbortController();
  let foldedResult: Awaited<ReturnType<typeof completeText>> | null = null;
  try {
    const summarySystem = "You compress coding-agent session history. Only output the structured handoff.";
    let folded: Awaited<ReturnType<typeof completeText>>;
    try {
      folded = await completeText(summaryRoute.provider, summaryRoute.model, summarySystem, prompt, currentAbort.signal);
    } catch (err) {
      // Cheap-lane credentials can lapse while the main route still works
      // (e.g. a 401 on the summary model). Retry once on the current model
      // before giving up; skip the retry when both routes already match.
      if (summaryRoute.provider === route.provider && summaryRoute.model === route.model) throw err;
      folded = await completeText(route.provider, route.model, summarySystem, prompt, currentAbort.signal);
    }
    foldedResult = folded;
    const u = folded.usage;
    if (u) {
      accumulateUsage(u);
      lastUsd = null;
      syncIndicators();
    }
    const text = folded.text;
    const handoff = `<context-handoff>\n${text}\n</context-handoff>`;
    const handoffTokens = estimateReclaimTokens(handoff);
    const evictedTokens = history.slice(0, boundary).reduce((sum, message) => sum + message.tokens, 0);
    if (!text || handoffTokens >= evictedTokens) {
      await writeSummaryTrace({
        status: text ? "no-reduction" : "empty",
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
    const sseq = storageSeq + 1;
    persist({ type: "revision", kind: "summarize", evicted: boundary, summarySseq: sseq, message: { role: "user", content: handoff } });
    lastHandoff = handoffBody;
    history.splice(0, boundary);
    const m: Message = { role: "user", content: handoff, tokens: handoffTokens, sseq };
    history.unshift(m);
    recordRevision("summarize");
    pruneCooldown = null;
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

/** Keep client results paired even when a server tool is still outstanding.
 * Claude forbids sibling user text in that case; attach harness guidance as a
 * nested text block without mutating the original tool outcome. */
export function toolResultsWithRecovery(
  results: readonly ContentBlock[],
  response: readonly Record<string, unknown>[],
  recovery: string,
): ContentBlock[] {
  const answered = new Set(response.filter((block) => block.type === "web_search_tool_result").map((block) => block.tool_use_id));
  const pendingServer = response.some((block) => block.type === "server_tool_use" && !answered.has(block.id));
  if (!pendingServer) return [...results, { type: "text", text: recovery }];
  return results.map((block, index) => index === 0 ? {
    ...block,
    content: [
      ...(Array.isArray(block.content) ? block.content : [{ type: "text", text: String(block.content ?? "") }]),
      { type: "text", text: `[Harness recovery guidance]\n${recovery}` },
    ],
  } : block);
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
  flips: CacheFlipTally | null = null,
  provider: ProviderId | null = null,
): string {
  const uncachedInput = safeTokenCount(usage.input);
  const cacheRead = safeTokenCount(usage.cacheRead);
  const cacheWrite = safeTokenCount(usage.cacheWrite);
  const input = uncachedInput + cacheRead + cacheWrite;
  const known = (value: number | null): boolean =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  // Providers without a cache-write concept report no write count; a null
  // write from them is a zero, not an unknown. Anywhere else it stays unknown.
  const writeKnown = known(usage.cacheWrite) ||
    (provider !== null && cacheWriteSupportedFor(provider, usage.cacheWrite) === false);
  const inputKnown = known(usage.input) && known(usage.cacheRead) && writeKnown;
  const cache = inputKnown && input > 0 ? `${Math.round((cacheRead / input) * 100)}%` : "--";
  const context = safeTokenCount(contextTokens);
  const limit = Math.max(1, safeTokenCount(maxContext));
  const contextPct = Math.round((context / limit) * 100);
  const cost = usd !== null && Number.isFinite(usd) && usd >= 0 ? ` · last $${usd.toFixed(4)}` : "";
  // Stable-prefix breaks per evaluated attempt. Working-set churn is expected
  // (host context moves most turns) and stays in the tally only, so the
  // indicator flags prefix breaks without training users to ignore it.
  const flipCount = flips && Number.isInteger(flips.evaluations) && flips.evaluations > 0
    && Number.isInteger(flips.prefixFlips) && flips.prefixFlips >= 0
    ? ` · flips ${flips.prefixFlips}/${flips.evaluations}`
    : "";
  const inputDisplay = inputKnown ? compactTokenCount(input) : "?";
  const outputDisplay = typeof usage.output === "number" && Number.isFinite(usage.output) && usage.output >= 0
    ? compactTokenCount(usage.output)
    : "?";
  return `tokens ${inputDisplay} in/${outputDisplay} out · cache ${cache} · context ~${compactTokenCount(context)}/${compactTokenCount(limit)} ${contextPct}%${cost}${flipCount}`;
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

type ProviderRetryEvent = {
  status: number;
  kind: "oauth-refresh" | "retryable-status" | "network";
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
    const protocol = providerProtocol(providerId, model);
    const headers = providerProtocolHeaders(providerId, { ...auth.headers, ...cacheSessionHeaders(cacheIdentity) }, protocol);
    if (codexAffinity && providerId === "openai-codex" && codexTurnState) {
      headers["x-codex-turn-state"] = codexTurnState;
    }
    if (body && typeof body === "object" && (body as { stream?: unknown }).stream === true) {
      headers.accept = "text/event-stream";
    }
    if (stream && protocol === "google-generate") headers.accept = "text/event-stream";
    let res: Response;
    try {
      res = await fetch(protocolEndpoint(auth.baseUrl, model, protocol, stream), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.message === "aborted")) throw new Error("aborted");
      const wait = retryNetworkAfter(err, retries);
      if (wait != null) {
        retries++;
        await onRetry?.({ status: 0, kind: "network", retryCount: retries });
        // Tests already force HTTP Retry-After to 0; keep network waits off the
        // spawn clock the same way without changing the production budget.
        await sleep(process.env.TERMINA_CORE_TEST === "1" ? 0 : wait, signal);
        continue;
      }
      throw isRetryableNetworkError(err) ? new Error(formatNetworkError(err)) : err;
    }
    if (res.ok && codexAffinity && providerId === "openai-codex") {
      const nextTurnState = res.headers.get("x-codex-turn-state")?.trim();
      if (nextTurnState) codexTurnState = nextTurnState;
    }
    if (res.status === 401) {
      await readBoundedResponseBody(res, { maxBytes: PROVIDER_ERROR_BODY_CAP_BYTES });
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
      await readBoundedResponseBody(res, { maxBytes: PROVIDER_ERROR_BODY_CAP_BYTES });
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
  const reason = event.kind === "oauth-refresh"
    ? "oauth-refresh"
    : event.kind === "network"
      ? "provider-network"
      : `provider-${event.status}`;
  const ended = Date.now();
  await writeTraceAttempt(attempt, {
    status: "retrying",
    storageSeqRange: null,
    toolNames: [],
    usage: null,
    usd: null,
    cost: traceCostForUsage(
      null,
      attempt.provider,
      attempt.model,
      attempt.role,
      cache,
    ),
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
    provider: attempt.provider,
    model: attempt.model,
  });
}

const PROVIDER_BODY_CAP_BYTES = 256 * 1024;
const PROVIDER_ERROR_BODY_CAP_BYTES = 64 * 1024;

async function readBoundedJson(res: Response, maxBytes = PROVIDER_BODY_CAP_BYTES): Promise<unknown> {
  const body = await readBoundedResponseBody(res, { maxBytes });
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
  blocks: Block[] | null;
  events: Array<Record<string, unknown>> | null;

  constructor(
    message: string,
    cache: TraceCacheDiagnostics | null,
    opts?: { blocks?: Block[] | null; events?: Array<Record<string, unknown>> | null },
  ) {
    super(`provider output incomplete: ${message}`);
    this.name = "ProviderStreamLimitError";
    this.cache = cache;
    this.blocks = opts?.blocks ?? null;
    this.events = opts?.events ?? null;
  }
}

function sseEventsFromError(error: unknown): Array<Record<string, unknown>> {
  if (error instanceof ProviderSseError) return error.events;
  if (error instanceof ProviderStreamLimitError && error.events) return error.events;
  return [];
}

function salvageBlocksFromError(error: unknown): Block[] {
  if (error instanceof ProviderStreamLimitError && error.blocks?.length) return error.blocks;
  if (error && typeof error === "object" && "blocks" in error) {
    const blocks = (error as { blocks?: unknown }).blocks;
    if (Array.isArray(blocks)) return salvageAssistantBlocks(blocks as SalvageBlock[]) as Block[];
  }
  return [];
}

function attachSalvage(error: unknown, blocks: Block[], cache: TraceCacheDiagnostics | null): unknown {
  const salvaged = salvageAssistantBlocks(blocks as SalvageBlock[]) as Block[];
  if (error instanceof ProviderStreamLimitError) {
    if (salvaged.length) error.blocks = salvaged;
    return error;
  }
  const classified = classifyProviderStreamError(error, cache);
  if (classified) {
    if (salvaged.length) classified.blocks = salvaged;
    if (!classified.events?.length) classified.events = sseEventsFromError(error);
    return classified;
  }
  if (salvaged.length && error instanceof Error) {
    (error as Error & { blocks?: Block[] }).blocks = salvaged;
  }
  return error;
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
    return new ProviderStreamLimitError(message, cache, { events: sseEventsFromError(error) });
  }
  return null;
}

/** Persist what the TUI already showed so a later "continue" can see it. */
function persistFailedStreamTurn(error: unknown): void {
  if (interrupted) return;
  const salvaged = salvageAssistantBlocks(salvageBlocksFromError(error) as SalvageBlock[]) as ContentBlock[];
  if (salvaged.length === 0) return;
  try {
    const sseq = persist({ type: "message", message: { role: "assistant", content: salvaged } });
    history.push({
      role: "assistant",
      content: salvaged,
      tokens: estimateReclaimTokens(salvaged),
      sseq,
    });
    const uses = salvaged.flatMap((block): ToolUse[] => {
      if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") return [];
      const input = block.input && typeof block.input === "object" && !Array.isArray(block.input)
        ? block.input as ToolUse["input"]
        : {};
      return [{ id: block.id, name: block.name, input }];
    });
    if (uses.length === 0) {
      syncIndicators();
      return;
    }
    pushMessage("user", uses.map((use) => {
      const outcome = done(use, "(provider stream ended before this tool ran)", true);
      const b = outcome.result as ContentBlock;
      b.tool = use.name;
      b.repro = outcome.repro ?? reproFor(use);
      b.is_error = true;
      return b;
    }));
  } catch {
    /* The run already failed; keep the original provider error. */
  }
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
  const detail = (await readBoundedResponseBody(res, { maxBytes: PROVIDER_ERROR_BODY_CAP_BYTES })).text.slice(0, 300);
  throw new Error(`API ${res.status}${detail ? `: ${detail}` : ""}${hint}`);
}

function textFromStreamBlocks(blocks: Array<Record<string, unknown>>): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}

export function summaryRequestPolicy(providerId: ProviderId, model: string): {
  protocol: ProviderProtocol;
  effort: EffortLevel;
  reasoning: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  maxTokens: number;
} {
  const proto = providerProtocol(providerId, model);
  // Lowest supported effort: "off" where the route disables reasoning, the
  // clamped floor (e.g. Grok low) where it cannot, undefined where the route
  // takes no effort control and the provider default applies.
  const effort = clampEffortLevel(providerId, model, "off", proto, routeReasoningLevels(providerId, model));
  const reasoning = reasoningEffortFor(providerId, model, "off", proto, routeReasoningLevels(providerId, model));
  const catalogLimit = catalogOutputLimit(catalogs.get(providerId)?.find((m) => m.id === model));
  const thinkingBudget = outputTokenBudget({ thinking: effort !== "off" });
  // Keep the small fixed cap for non-reasoning summaries; give reasoning
  // summaries room for handoff text, bounded by the catalog ceiling.
  const maxTokens = effort === "off"
    ? 2048
    : catalogLimit === null
      ? thinkingBudget
      : Math.max(2048, Math.min(thinkingBudget, catalogLimit));
  return { protocol: proto, effort, reasoning, maxTokens };
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
  const { reasoning: summaryReasoning, maxTokens: summaryMaxTokens } =
    summaryRequestPolicy(providerId, model);
  const cacheIdentity = cacheIdentityForRole("summary", providerId, model);
  const cacheKey = cacheIdentity?.key;
  const sendCacheKey = Boolean(cacheKey) && cacheCapabilitySupported(providerId, model, CACHE_CAPABILITY_FEATURE.promptCacheKey);
  const sendSessionId = providerId === "openrouter" ? cacheKey || undefined : undefined;
  if (proto === "anthropic-messages") {
    const thinking = thinkingRequestFor(providerId, model, "off", providerProtocol(providerId, model));
    const requestBody = {
      model,
      max_tokens: summaryMaxTokens,
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
    const effort = reasoningEffortFor(providerId, model, "off", providerProtocol(providerId, model), routeReasoningLevels(providerId, model));
    const requestBody = googleGenerateBody(
      system,
      [{ role: "user", content: prompt }],
      [],
      {
        maxTokens: summaryMaxTokens,
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
      maxTokens: summaryMaxTokens,
      ...(sendCacheKey ? { cacheKey } : {}),
      ...(sendSessionId ? { sessionId: sendSessionId } : {}),
      includeEncryptedReasoning: false,
      ...(summaryReasoning ? { reasoningEffort: summaryReasoning } : {}),
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
    ...(providerId === "openai" ? { max_completion_tokens: summaryMaxTokens } : { max_tokens: summaryMaxTokens }),
    ...(summaryReasoning ? { reasoning_effort: summaryReasoning } : {}),
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
  opts?: { traceRole?: "summary" },
): Promise<{ text: string; usage: Usage | null; ttftMs: number | null; cache: TraceCacheDiagnostics | null; traceAttempt: TraceAttemptState | null }> {
  let attempt = beginTraceAttempt(opts?.traceRole ?? "summary", { provider: providerId, model });
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
  const sys = frontMatter.systemPrompt();
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
  const providerMessages = prependRequestOverlay(stampedMessages as RequestMessage[], overlay);
  const kernelMessages = providerMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content as string | Array<Record<string, unknown>>,
  }));
  const toolsForProvider = clientTools as ToolDef[];
  const actualEffort = clampEffortLevel(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels());
  const catalogLimit = catalogOutputLimit(catalogs.get(route.provider)?.find((m) => m.id === route.model));
  const budgeted = outputTokenBudget({ thinking: actualEffort !== "off" });
  // Never request more output than the catalog-reported completion ceiling.
  const maxTokens = catalogLimit === null ? budgeted : Math.max(1_024, Math.min(budgeted, catalogLimit));
  const thinking = thinkingRequestFor(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model));
  const adaptiveEffort = adaptiveEffortFor(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model));
  const reasoningEffort = reasoningEffortFor(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels());
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
            maxTokens,
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
  let res = await providerPost(route.provider, body, currentAbort?.signal, route.model, true, true, cacheIdentity, onRetry);
  if (!res.ok || !res.body) {
    const detail = (await readBoundedResponseBody(res, { maxBytes: PROVIDER_ERROR_BODY_CAP_BYTES })).text.slice(0, 300);
    const fallbackCandidate = res.status === 400 && /prompt_cache_(?:breakpoint|options)/i.test(detail);
    const optionalFieldsRequested = sendExplicitCache || sendPromptCacheOptions;
    if (
      fallbackCandidate &&
      optionalFieldsRequested &&
      usesResponsesApi(route.provider, route.model)
    ) {
      recordRejectedCacheFields(route.provider, route.model, {
        promptCacheOptions: sendPromptCacheOptions,
        promptCacheBreakpoint: sendExplicitCache,
        promptCacheKey: sendCacheKey,
      }, detail);
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
    const detail = (await readBoundedResponseBody(res, { maxBytes: PROVIDER_ERROR_BODY_CAP_BYTES })).text.slice(0, 300);
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
    const salvageCompatPartial = (error: unknown, events: Array<Record<string, unknown>>): Block[] => {
      const collected = sseEventsFromError(error);
      const source = collected.length > 0 ? collected : events;
      let parsedBlocks: Block[] = [];
      try {
        const parsed = viaResponses
          ? responsesResultFromEvents(source, () => {}, attemptStarted)
          : viaGoogle
            ? googleResultFromEvents(source, () => {}, attemptStarted)
            : completionResultFromEvents(source, () => {}, attemptStarted);
        parsedBlocks = (parsed.blocks ?? []) as Block[];
      } catch {
        parsedBlocks = [];
      }
      const salvaged = salvageAssistantBlocks(parsedBlocks as SalvageBlock[]) as Block[];
      if (streamedText && !salvaged.some((block) => block.type === "text")) {
        salvaged.unshift({ type: "text", text: streamedText });
      }
      return salvaged;
    };
    try {
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
    if (parsed.error) throw attachSalvage(new Error(parsed.error), salvageCompatPartial(null, events), cacheDiagnostics);
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
    } catch (error) {
      if (interrupted) throw error;
      throw attachSalvage(error, salvageCompatPartial(error, []), cacheDiagnostics);
    }
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
  const salvageAnthropicPartial = (): Block[] => {
    try {
      finishAggregates();
    } catch {
      /* Keep whatever text already landed on slots. */
    }
    const candidates: SalvageBlock[] = [];
    for (const block of compactStreamBlocks(slots)) {
      if (block.type === "tool_use" || block.type === "server_tool_use") continue;
      candidates.push(block);
    }
    for (const [idx, part] of jsonParts) {
      const lifecycle = blockLifecycles.get(idx);
      const target = lifecycle?.block;
      if (!target || target.type !== "tool_use") continue;
      try {
        const parsedPart = part.finish("complete");
        if (parsedPart.truncated) continue;
        const input = JSON.parse(parsedPart.text) as unknown;
        if (!input || typeof input !== "object" || Array.isArray(input)) continue;
        target.input = input as ToolUse["input"];
        candidates.push(target);
      } catch {
        continue;
      }
    }
    return salvageAssistantBlocks(candidates) as Block[];
  };
  try {
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
  } catch (error) {
    if (interrupted) throw error;
    throw attachSalvage(error, salvageAnthropicPartial(), cacheDiagnostics);
  }
}

// ---- waste attribution ----

let previousCacheAttempt: CacheAttemptSnapshot | null = null;

let cacheFlipTally: CacheFlipTally = emptyCacheFlipTally();

function resetUsageContinuity(): void {
  previousCacheAttempt = null;
  lastBilledTokens = null;
  lastCacheReadShare = null;
  lastRequestFollowedRevision = false;
  pruneCooldown = null;
  cacheFlipTally = emptyCacheFlipTally();
}

/** Aggregate prefix-flip rate for this run's cache continuity window. */
function cacheFlipStats(): CacheFlipTally {
  return { ...cacheFlipTally };
}

function resetCacheContinuity(): void {
  resetUsageContinuity();
  currentHostContext = null;
  activeRequestOverlay = null;
  codexTurnState = "";
}

// Providers bill tokens; this adapter turns one complete catalog response into
// immutable, role/route/model-scoped snapshots. `rates.ts` owns validation and
// arithmetic so missing counters/rates remain unknown and cache-write prices
// never fall back to input pricing.
type CatalogCost = Record<string, unknown>;
type CatalogModelEntry = { cost?: CatalogCost; limit?: { context?: unknown } };
type CatalogProvider = { models?: Record<string, CatalogModelEntry>; version?: unknown; updatedAt?: unknown };
type CatalogResponse = Record<string, CatalogProvider> & { version?: unknown; updatedAt?: unknown };

const RATE_CATALOG_URL = "https://models.dev/api.json";
// Background budget only: run startup races this load with a short wait
// (awaitInitialRates), so a generous timeout never blocks the terminal.
// The catalog body is ~4.5MB and growing; first byte alone can take ~200ms.
const RATE_FETCH_TIMEOUT_MS = 30_000;
const RATE_CATALOG_BODY_CAP_BYTES = 16 * 1024 * 1024;
// A transient boot-network failure must not pin an empty map forever: retry
// a bounded number of times inside the background load, then let the next
// run re-kick it via ensureRatesLoading.
const RATE_LOAD_MAX_ATTEMPTS = 3;
const RATE_LOAD_RETRY_DELAY_MS = 2_000;
const RATE_UNITS = {
  input: "usd_per_million_tokens",
  cacheRead: "usd_per_million_tokens",
  cacheWrite: "usd_per_million_tokens",
  output: "usd_per_million_tokens",
  reasoning: "usd_per_million_tokens",
  storage: "usd_per_gib_second",
} as const;
let rateSnapshotMap: ReadonlyMap<string, RateSnapshot> = new Map();
let ratesLoadPromise: Promise<void> | null = null;
/**
 * Context windows from the same models.dev payload, keyed `provider\0model`.
 *
 * Neither the OpenAI `/models` response nor either relay carries a window, so
 * without this the provider-specific fallback in `defaultContextWindow` is the
 * only answer for those routes. The catalog also covers models that fallback
 * cannot express (an Anthropic opus at 200k, a grok at 1M, glm at 200k).
 * Replaced atomically with the rate map; empty when the load has not succeeded,
 * in which case the fallback answers.
 */
let contextCatalogMap: ReadonlyMap<string, number> = new Map();


function catalogKey(provider: string, model: string, role: "main" | "summary"): string {
  return `${provider}\0${model}\0${role}`;
}

/** The context entry for a route's provider, or null when it has no models.
 *  Narrows `models` to a present record so callers need no second check. */
function contextCatalogEntry(
  db: CatalogResponse,
  provider: ProviderId,
): { models: Record<string, CatalogModelEntry> } | null {
  const entry = db[contextCatalogProviderId(provider)];
  if (!entry || typeof entry !== "object" || !entry.models || typeof entry.models !== "object") return null;
  return { models: entry.models };
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

async function loadRates(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RATE_CATALOG_URL, { signal: controller.signal });
    if (!res.ok) return false;
    const body = await readBoundedResponseBody(res, { maxBytes: RATE_CATALOG_BODY_CAP_BYTES });
    if (body.state !== "complete" || body.truncated) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text) as unknown;
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const db = parsed as CatalogResponse;
    const lookedUpAt = new Date().toISOString();
    const version = catalogMetadata(db.version) ?? catalogMetadata(db.updatedAt);
    const next = new Map<string, RateSnapshot>();
    // Context is captured here rather than in a second fetch: this payload
    // already carries `limit.context` for every model of every provider, and
    // this loop already walks exactly the (provider, model) pairs we route to.
    const nextContext = new Map<string, number>();
    for (const providerId of AUTH_PROVIDER_ORDER) {
      // Context is gathered first and independently of pricing: it comes from a
      // different provider entry (Copilot is billed as OpenAI but serves its own
      // model list), and a catalog missing pricing must not hide its windows.
      const contextCatalog = contextCatalogEntry(db, providerId);
      if (contextCatalog) {
        for (const [model, entry] of Object.entries(contextCatalog.models)) {
          const context = Number(entry?.limit?.context);
          const window = acceptedContextWindow(context);
          if (window !== undefined) {
            nextContext.set(contextCatalogEntryKey(providerId, model), window);
          }
        }
      }
      const catalog = db[catalogProviderId(providerId)];
      if (!catalog || typeof catalog !== "object" || !catalog.models || typeof catalog.models !== "object") continue;
      for (const [model, entry] of Object.entries(catalog.models)) {
        if (!entry || typeof entry !== "object") continue;
        if (!entry.cost || typeof entry.cost !== "object") continue;
        for (const role of ["main", "summary"] as const) {
          const snapshot = snapshotForCatalogEntry(providerId, model, role, entry.cost, version, lookedUpAt);
          if (snapshot) next.set(catalogKey(providerId, model, role), freezeRateSnapshot(snapshot));
        }
      }
    }
    // Replace the maps only after the response has been fully normalized. A
    // logical task keeps the previous map reference and cannot observe a
    // half-loaded or changing catalog.
    rateSnapshotMap = next;
    contextCatalogMap = nextContext;
    return true;
  } catch {
    /* Offline/catalog failure leaves the scoped snapshot unknown. */
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function loadRatesWithRetry(): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    if (await loadRates()) return true;
    if (attempt >= RATE_LOAD_MAX_ATTEMPTS) return false;
    await sleep(RATE_LOAD_RETRY_DELAY_MS * attempt);
  }
}

function ensureRatesLoading(): Promise<void> {
  if (!ratesLoadPromise) {
    ratesLoadPromise = loadRatesWithRetry().then(
      (ok) => {
        // A failed background load must not pin the failed state: the next
        // run retries instead of serving an empty map forever.
        if (!ok) ratesLoadPromise = null;
      },
      () => {
        ratesLoadPromise = null;
      },
    );
  }
  return ratesLoadPromise;
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
  const unknownReasons = cost.unknownFields.map((field) => {    if (field === "source" || field === "version" || field === "lookedUpAt" || field === "units") {
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
  // A provider-reported total is billed truth (post-discount); it wins over
  // any catalog estimate. Components stay as computed (possibly unpriced).
  const reportedUsd = providerReportedUsd(usage);
  return {
    usd: reportedUsd ?? cost.usd,
    source: reportedUsd !== null ? "provider-reported" : cost.source,
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
      cacheWriteSupported: cacheWriteSupportedFor(route.provider, usage.cacheWrite),
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
  if (previousCacheAttempt !== null) {
    cacheFlipTally = tallyCacheFlip(cacheFlipTally, classification, cache.workingSetChanged);
  }
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
  sidecar.logEvent({
    t: "agent_settings",
    model: `${route.provider}/${route.model}`,
    thinkingLevel: clampEffortLevel(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels()),
    usage: formatUsageIndicators(sessionUsage, statusContextTokens(), contextWindow(), lastUsd, cacheFlipStats(), route.provider),
    permissions: permissionMode,
  });
}

/** Final assistant text of the run, for the subagent result frame. */
function lastAssistantText(): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "assistant") return visibleAssistantText(m.content as Array<{ type?: string; text?: string }>);
  }
  return "";
}

/**
 * Headless subagent child entry (Phase 2): configure the route from the
 * validated task file, run to settlement, print exactly one framed result
 * line on stdout, and exit. Stdout keeps the full `-p`-style transcript;
 * the host takes the LAST framed line, so model text cannot collide with it.
 */

async function runSubagentTask(taskPath: string): Promise<never> {
  const fail = async (message: string): Promise<never> => {
    process.stderr.write(`agent-core: subagent task failed: ${message}\n`);
    try {
      await shutdownAgentCore({ reason: "subagent-invalid" });
    } catch {
      /* Shutdown is best-effort on a failed start. */
    }
    process.exit(2);
  };
  if (!taskPath) await fail("missing task file path");
  const taskRead = readBoundedRegularFile(taskPath, MAX_SUBAGENT_FILE_BYTES);
  let raw: string;
  if ("error" in taskRead) await fail(`cannot read task file: ${taskRead.error}`);
  else if (taskRead.truncated) await fail("task file exceeds its budget");
  else raw = taskRead.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch {
    await fail("task file is not JSON");
  }
  const checked = parseSubagentTaskFile(parsed);
  if (!checked.ok) await fail(checked.error);
  const task = (checked as { ok: true; file: SubagentTaskFile }).file;
  route = { provider: task.provider, model: task.model };
  effortWanted = task.effort;
  permissionMode = resolveSubagentPermissionMode(task.permissionMode, process.env.TERMINA_CORE_APPROVE);
  if (!process.env.TERMINA_CORE_SUMMARY_MODEL) {
    summaryRoute = parseModelRef(DEFAULT_MODELS[task.provider].summary, task.provider);
  }
  activeSubagent = { task, inboxSeq: 0 };
  lastRunOutcome = null;
  const roleLine = task.resumeRunId
    ? `[Subagent ${task.runId}: continuing ${task.resumeRunId}. Its session history is replayed above; treat the brief below as a follow-up, not a fresh task. Your final reply is delivered to your parent as the run result.`
    : `[Subagent ${task.runId}: you are a background subagent. Your final reply is delivered to your parent as the run result.`;
  if (task.resumeRunId) {
    // The host points TERMINA_CORE_SESSION_FILE at the prior run's bundle.
    // Replay it so the brief runs as a follow-up; a missing or broken bundle
    // fails closed here (exit 2 skips the host retry gate, like a bad task).
    // Note: `await fail()` does not narrow for flow analysis in this file
    // (see the `raw!` idiom above), so this uses positive-branch narrowing.
    if (!sessionFile) await fail("resumed session address is missing");
    let replayed: Awaited<ReturnType<typeof replaySessionBundle>> | null = null;
    try {
      replayed = await replaySessionBundle(sessionFile!);
    } catch {
      replayed = null;
    }
    if (replayed !== null && replayed.ok) {
      try {
        installResumedSubagentHistory(replayed);
      } catch (err) {
        await fail(`cannot resume ${task.resumeRunId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      await fail(`cannot resume ${task.resumeRunId}: ${replayed === null ? "replay failed" : replayed.error}`);
    }
  }
  await runPrompt(
    `${roleLine} Parent messages arrive as "Parent message (seq N): ..." user turns — follow redirections, answer questions in your result. Bash approvals ask your parent and default to deny; keep commands minimal and non-interactive.]\n\n${task.brief}`,
  );
  // `as`: the settle-point assignment inside runPrompt is invisible to flow
  // analysis, which would otherwise keep the pre-run `null` narrowing.
  const outcome = lastRunOutcome as { status: string; failure: string | null } | null;
  const frame = outcome && outcome.status === "success"
    ? {
      ok: true as const,
      result: utf8TextPrefix(lastAssistantText(), MAX_SUBAGENT_RESULT_CHARS),
    }
    : { ok: false as const, error: outcome?.failure ?? "no settlement" };
  process.stdout.write(`${formatSubagentResultFrame(frame)}\n`);
  await shutdownAgentCore({ reason: "subagent" });
  process.exit(frame.ok ? 0 : 1);
}

/** Abort before the model loop. Records lastRunOutcome so a headless child
 *  frames the real error instead of "no settlement". */
function abortPromptStart(message: string, draft?: string): void {
  lastRunOutcome = { status: "failure", failure: message };
  out(`(the run did not start: ${message})\n`);
  if (draft !== undefined) surface?.setDraft(draft);
  running = false;
  currentAbort = null;
  showPrompt();
}

/** Images carried into one run: pending claims first, then startup extras. */
export const RUN_IMAGE_CAP = 4;

/** Images dropped by the run cap (#222): pending claims come first, so a full claim evicts startup extras. */
export function droppedRunImageCount(loadedCount: number, extrasCount: number): number {
  return Math.max(0, loadedCount + extrasCount - RUN_IMAGE_CAP);
}

async function runPrompt(
  prompt: string,
  extraImages: Array<{ name: string; mediaType: string }> = [],
  planTurn = false,
): Promise<void> {
  if (shutdownRequested) return;
  if (modelAvailabilityError) {
    abortPromptStart(`${modelAvailabilityError}; choose an available model with /models or /model`, prompt);
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
      abortPromptStart(message, prompt);
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
    abortPromptStart(pendingResult.error, prompt);
    return;
  }
  const hasImages = pendingResult.hasImages || extraImages.length > 0;
  let preflight: { requestId: string; token: string | null } | null = null;
  const cancelPreflight = (): void => {
    if (preflight) sidecar.logEvent({ t: "preflight_cancel", requestId: preflight.requestId });
    preflight = null;
  };
  // Headless children share the parent's tree and have no terminal instance.
  // The host treats their sidecar as liveness-only and never writes preflight
  // or checkpoint acks, so waiting here used to fail every child as "no settlement".
  const hostBridge = Boolean(eventsDir && terminalId && !activeSubagent);
  if (hostBridge && eventsDir && terminalId) {
    if (sidecar.isWriteStopped()) {
      abortPromptStart("sidecar admission is paused", prompt);
      return;
    }
    const requestId = randomUUID();
    const timeoutMs = 15_000;
    sidecar.logEvent({ t: "preflight_request", requestId, hasImages, deadlineAt: Date.now() + timeoutMs });
    const ack = await waitForAck(eventsDir, terminalId, requestId, timeoutMs, bridgeId, {
      shouldStop: () => interrupted,
    });
    if (!ack || ack.ok !== true) {
      // Cancellation is request-addressed because a timed-out client never
      // received the token. The app processes this durable event after any
      // in-flight capture and cannot strand the late preflight lease.
      // A concrete ack already finished the request; do not append cancel
      // while the tailer may still be holding backpressure for capture.
      if (!ack) sidecar.logEvent({ t: "preflight_cancel", requestId });
      const err = String(ack && typeof ack.error === "string" ? ack.error : "preflight timed out");
      abortPromptStart(err, prompt);
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
    abortPromptStart(claimResult.error, prompt);
    void refreshPendingImageCount();
    return;
  }
  const claim = claimResult.claim;
  const loaded = claim.images;
  const extras = extraImages
    .map((ref) => loadImageFromRoots(ref, imageRoots))
    .filter((img): img is NonNullable<typeof img> => img !== null);
  const allImages = [...loaded, ...extras].slice(0, RUN_IMAGE_CAP);
  const droppedImages = droppedRunImageCount(loaded.length, extras.length);
  if (droppedImages > 0) {
    // Pending claims come first, so a full claim silently evicts structured
    // startup images. Say so instead of dropping them without a trace.
    out(`(note: dropped ${droppedImages} image${droppedImages === 1 ? "" : "s"} over the ${RUN_IMAGE_CAP}-image cap)\n`);
  }
  const persistedImages = persistLoadedImages(sessionFile, allImages);
  if (!persistedImages.ok) {
    cancelPreflight();
    abortPromptStart(persistedImages.error, prompt);
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
  const contextResult = eventsDir && terminalId
    ? readContextFilesResult(eventsDir, terminalId, { shouldStop: () => interrupted })
    : null;
  // Free subagent slots whose host result files landed. Display rides the
  // host mailbox note; this also refreshes the title-line live-run count.
  syncSubagentChrome();
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
        files: contextResult.files,
      }
    : null;
  if (eventsDir && terminalId) {
    const file = promptFileName(terminalId, bridgeId, randomUUID().slice(0, 8));
    const written = writePromptPayload(eventsDir, terminalId, file, { prompt: taggedPrompt, context, images });
    if (written) sidecar.logEvent({ t: "prompt", file: written, hasPreflight: preflight !== null });
  }
  let userMsg: Message;
  try {
    userMsg = pushUserPrompt(taggedPrompt, images);
    try {
      persistRouteSettings();
    } catch {
      /* The run still starts; /model and /effort retry the pin. */
    }
  } catch (err) {
    cancelPreflight();
    const message = err instanceof SessionStoreError ? err.message : err instanceof Error ? err.message : String(err);
    abortPromptStart(message, prompt);
    return;
  }
  // Build once for this logical prompt. Retries and cache-field fallbacks
  // reuse the same exact bytes instead of observing a changed host snapshot.
  try {
    activeRequestOverlay = buildRequestOverlay({ hostContext: context });
  } catch (err) {
    cancelPreflight();
    const message = err instanceof Error ? err.message : String(err);
    abortPromptStart(message, prompt);
    return;
  }
  // Rate lookup is optional and bounded. Capture the fully replaced catalog
  // map before opening the logical task so every attempt in this run shares
  // one immutable provenance snapshot.
  await awaitInitialRates();
  const traceTask = beginTraceTask();
  if (eventsDir && terminalId && claim.claimId) {
    const ackImages = await acknowledgePendingImages(eventsDir, terminalId, claim.claimId, persistedPendingNames);
    if (!ackImages.ok) out(`(host: ${ackImages.error})\n`);
  }
  sidecar.logEvent({
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
    thinkingLevel: clampEffortLevel(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels()),
    permissions: permissionMode,
  });
  let storageFailure: string | null = null;
  let taskFailure: string | null = null;
  let taskOutcomeStatus = "success";
  let retriedOverflow = false;
  let retriedProviderTermination = false;
  let terminatedDiagnostics: string | null = null;
  let resumePaused = false;
  let pauseTurnContinuations = 0;
  let lastPlanText = "";
  let cacheCostCompactionAttempted = false;
  let toolLoopTracker = emptyToolLoopTracker();
  codexTurnState = "";
  // Mid-stream poller: a long model stream must not hold child approvals
  // hostage until the turn ends. The per-turn poll below stays as the
  // deterministic backstop.
  startSubagentApprovalTimer();
  try {
    while (true) {
      if (interrupted) break;
      drainSubagentInbox();
      drainSubagentOutbox();
      // Child approval requests arrive mid-run; poll every model turn so a
      // picker (or fast deny) lands within a turn, not a user turn. Reconcile
      // first so a finished child leaves the title before the next model call.
      syncSubagentChrome();
      pollSubagentApprovals();
      if (!resumePaused) {
        await reclaim();
        // Compact an expensive cache miss before the context limit forces it.
        const shouldCompactForCost =
          !cacheCostCompactionAttempted &&
          shouldCompactForCacheCost(
            lastBilledTokens,
            lastCacheReadShare,
            effectiveTotalTokens(),
            lastRequestFollowedRevision,
            contextWindow(),
          );
        if (shouldCompactForCost) cacheCostCompactionAttempted = true;
        const compactedForCost = shouldCompactForCost ? await summarize() : false;
        // Reclaim first. Summarize at high water. Truncate only at the
        // rejection ceiling; a one-window route uses that same budget.
        if (!compactedForCost && effectiveTotalTokens() >= usableTokens() * HIGH_WATER) {
          if (!await summarize() && effectiveTotalTokens() >= usableTokens(contextCeiling())) truncate();
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
        const providerMessage = err instanceof Error ? err.message : String(err);
        const failedTurnMs = Math.max(0, Date.now() - callStarted);
        // Emergency mid-turn revision: the provider
        // rejected the window; reclaim hard and retry exactly once.
        if (!retriedOverflow && isContextOverflowMessage(providerMessage)) {
          await writeMainTrace({ status: "overflow", seqBefore, toolNames: [], usage: null, waste: null, sysHash: hashSystem(frontMatter.systemPrompt()), cache: streamFailure?.cache ?? null, started: callStarted, attempt: failedAttempt });
          retriedOverflow = true;
          await reclaim(true);
          await summarize(true);
          truncate(overflowProtectTurns(lastHandoff));
          try {
            result = await callModel(history, activeRequestOverlay, {
              retryOfAttemptId: failedAttempt?.attemptId ?? null,
              fallbackReason: "overflow",
              retryCount: (failedAttempt?.retryCount ?? 0) + 1,
            });
          } catch (retryErr) {
            const retryStreamFailure = retryErr instanceof ProviderStreamLimitError ? retryErr : null;
            const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
            await writeMainTrace({ status: retryStreamFailure?.traceStatus ?? "overflow-retry-error", seqBefore, toolNames: [], usage: null, waste: null, sysHash: hashSystem(frontMatter.systemPrompt()), cache: retryStreamFailure?.cache ?? null, started: callStarted, attempt: inFlightTraceAttempt, providerError: retryMessage });
            throw retryErr;
          }
        } else if (
          !retriedProviderTermination &&
          !interrupted &&
          (isRetriableProviderTermination(providerMessage) || isRetryableNetworkError(err))
        ) {
          // Bare provider termination or a dropped dial: retry once with
          // identical bytes, then settle with diagnostics. HTTP 429/5xx and
          // fetch() throws already retried inside providerPost.
          const networkFailure = isRetryableNetworkError(err);
          retriedProviderTermination = true;
          await writeMainTrace({ status: "error", seqBefore, toolNames: [], usage: null, waste: null, sysHash: hashSystem(frontMatter.systemPrompt()), cache: streamFailure?.cache ?? null, started: callStarted, attempt: failedAttempt, providerError: providerMessage });
          if (interrupted) throw err;
          out(networkFailure
            ? `(provider request failed (${formatNetworkError(err)}); retrying once)\n`
            : `(provider terminated the stream after ${(failedTurnMs / 1000).toFixed(0)}s with no first token; retrying once)\n`);
          try {
            result = await callModel(history, activeRequestOverlay, {
              retryOfAttemptId: failedAttempt?.attemptId ?? null,
              fallbackReason: networkFailure ? "provider-network" : "provider-terminated",
              retryCount: (failedAttempt?.retryCount ?? 0) + 1,
            });
          } catch (retryErr) {
            const retryStreamFailure = retryErr instanceof ProviderStreamLimitError ? retryErr : null;
            const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
            const retryTurnMs = Math.max(0, Date.now() - callStarted);
            // The retry can fail differently (abort, HTTP); only claim a
            // double termination when the retry message agrees.
            terminatedDiagnostics = networkFailure
              ? `provider request failed (${formatNetworkError(err)}); retry failed: ${sanitizeProviderError(retryMessage)?.slice(0, 200) ?? "(unreadable)"}; see trace providerError`
              : isRetriableProviderTermination(retryMessage)
                ? `stream ended twice before first token (${(retryTurnMs / 1000).toFixed(0)}s observed; see trace providerError)`
                : `stream ended before first token (${(failedTurnMs / 1000).toFixed(0)}s observed; retry failed: ${sanitizeProviderError(retryMessage)?.slice(0, 200) ?? "(unreadable)"}; see trace providerError)`;
            await writeMainTrace({ status: retryStreamFailure?.traceStatus ?? "error", seqBefore, toolNames: [], usage: null, waste: null, sysHash: hashSystem(frontMatter.systemPrompt()), cache: retryStreamFailure?.cache ?? null, started: callStarted, attempt: inFlightTraceAttempt, providerError: retryMessage });
            throw isRetryableNetworkError(retryErr) ? new Error(formatNetworkError(retryErr)) : retryErr;
          }
        } else {
          if (isRetriableProviderTermination(providerMessage)) {
            terminatedDiagnostics = `stream ended before first token (${(failedTurnMs / 1000).toFixed(0)}s observed; see trace providerError)`;
          }
          await writeMainTrace({ status: streamFailure?.traceStatus ?? "error", seqBefore, toolNames: [], usage: null, waste: null, sysHash: hashSystem(frontMatter.systemPrompt()), cache: streamFailure?.cache ?? null, started: callStarted, attempt: failedAttempt, providerError: providerMessage });
          throw isRetryableNetworkError(err) ? new Error(formatNetworkError(err)) : err;
        }
      }
      const admissionError = providerToolAdmissionError(result.blocks);
      if (admissionError) {
        await writeMainTrace({
          status: "error", seqBefore, toolNames: [], usage: result.usage, waste: null,
          sysHash: hashSystem(frontMatter.systemPrompt()), cache: result.cache, started: callStarted,
          attempt: result.traceAttempt, providerError: admissionError,
        });
        throw new Error(admissionError);
      }
      const sys = frontMatter.systemPrompt();
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
      const assistantText = visibleAssistantText(result.blocks);
      const plan = planTurn ? planSidecarText(assistantText, lastPlanText) : null;
      if (plan) {
        lastPlanText = plan;
        sidecar.logEvent({ t: "plan", text: plan });
      }
      const serverNames = renderServerTools(result.blocks);
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
        if (!interrupted) reportSubagentTurn(assistantText, []);
        // message_subagent already reported delivery. A note that landed
        // during this generation is still unread; settling here would drop it.
        if (!interrupted && drainSubagentInbox()) continue;
        if (!interrupted && await waitForSubagentTurns()) continue;
        break;
      }
      // Client tools are progress: only a consecutive pause streak is a wedge.
      pauseTurnContinuations = 0;
      const outcomes: ToolOutcome[] = [];
      const pendingOutcomes = new Map<number, Promise<ToolOutcome>>();
      const inputErrors = uses.map((use) => toolInputError(use, TOOLS));
      const waves = toolExecutionWaves(uses);
      const spawnFanout = admitSubagentFanout(
        subagentRegistry.activeRuns().length,
        waves.flat().filter((entry) =>
          uses[entry.index]!.name === "spawn_subagent"
          && !inputErrors[entry.index]
          && entry.duplicateOf === undefined
        ).length,
      );
      try {
      for (const wave of waves) {
        if (interrupted) break;
        const chunk = wave.map((entry) => uses[entry.index]!);
        const handles = chunk.map((use, index) => {
          const invalid = inputErrors[wave[index]!.index];
          // Invalid arguments must not reach sidecar edit formatting or the
          // filesystem before they have become an ordinary error result.
          if (invalid) sidecar.logEvent({ t: "tool", toolName: use.name, toolCallId: use.id });
          else logToolStart(use);
          nonTtyTranscriptSection = null;
          const displayed = invalid ? { ...use, input: {} } : use;
          if (surface) return surface.startTool(use.name, invalid ? "invalid arguments" : toolTranscriptDetail(use));
          process.stdout.write(`\n${formatToolAnnounce(displayed)}\n`);
          return null;
        });
        const wrapped = wave.map((entry) => {
          const use = uses[entry.index]!;
          const promise = (async (): Promise<ToolOutcome> => {
            if (inputErrors[entry.index]) return done(use, inputErrors[entry.index]!, true);
            if (entry.duplicateOf !== undefined) {
              if (!entry.reuseResult) return done(use, "error: duplicate action in the same batch was not executed again. Inspect the first result before deciding whether another action is needed.", true);
              const original = await pendingOutcomes.get(entry.duplicateOf)!;
              return { ...original, result: { ...original.result, tool_use_id: use.id } };
            }
            if (use.name === "spawn_subagent" && !spawnFanout.ok) {
              return done(use, `error: ${spawnFanout.error}`, true);
            }
            return executeTool(use, isTruncatedStopReason(result.stopReason));
          })();
          pendingOutcomes.set(entry.index, promise);
          return promise;
        });
        const settled = await Promise.allSettled(wrapped);
        for (let ci = 0; ci < chunk.length; ci++) {
          const item = settled[ci]!;
          if (item.status === "fulfilled") {
            const outcome = item.value;
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
            sidecar.logEvent({
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
            outcomes.push(outcome);
            sidecar.logEvent({ t: "tool_end", toolCallId: chunk[ci]!.id, isError: true, ...toolOutcomeTraceFields(outcome) });
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
        outcomes.push(outcome);
        sidecar.logEvent({ t: "tool_end", toolCallId: uses[i]!.id, isError: true, ...toolOutcomeTraceFields(outcome) });
      }
      let resultBlocks = outcomes.map((o, i): ContentBlock => {
        const b = o.result as ContentBlock;
        b.chars = undefined;
        b.tool = uses[i]!.name;
        b.repro = o.repro ?? reproFor(uses[i]!);
        if (o.isError) b.is_error = true;
        return b;
      });
      let stalled = false;
      if (!interrupted) {
        const turnCalls = uses.map((use, index) => ({
          name: use.name,
          input: use.input,
          result: outcomes[index]?.result ?? null,
          isError: outcomes[index]?.isError === true,
        }));
        const decision = trackToolLoopTurn(toolLoopTracker, turnCalls);
        toolLoopTracker = decision.tracker;
        stalled = decision.stalled;
        if (decision.recovery) {
          // Persist recovery in model-visible history, not just the terminal.
          resultBlocks = toolResultsWithRecovery(resultBlocks, result.blocks, decision.recovery);
          out(`\n(${decision.recovery})\n`);
        }
      }
      pushMessage("user", resultBlocks);
      await writeMainTrace({
        status: stalled ? "stalled" : "ok",
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
      if (stalled) {
        taskFailure = `stalled: tool loop continued after recovery guidance (${uses.map((u) => u.name).join(", ")})`;
        taskOutcomeStatus = "failure";
        out(`\n(${taskFailure})\n`);
        break;
      }
      if (!interrupted) reportSubagentTurn(assistantText, uses.map((use) => use.name));
      out("\n");
    }
  } catch (err) {
    persistFailedStreamTurn(err);
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
      // Bare provider terminations say nothing on their own; the sidecar
      // keeps the raw message for contract stability while the terminal
      // shows what was observed (elapsed, no first token, trace detail).
      out(`\nerror: ${taskFailure}${terminatedDiagnostics ? ` (${terminatedDiagnostics})` : ""}\n`);
    }
  } finally {
    currentAbort = null;
  }
  if (interrupted) {
    taskOutcomeStatus = "interrupted";
    taskFailure ??= "interrupted";
  }
  sidecar.logEvent({
    t: "agent_settled",
    runId: traceTask.runId,
    taskId: traceTask.taskId,
    error: storageFailure ?? taskFailure,
  });
  lastRunOutcome = { status: taskOutcomeStatus, failure: storageFailure ?? taskFailure };
  if (!storageFailure && hostBridge && eventsDir && terminalId) {
    const requestId = randomUUID();
    sidecar.logEvent({
      t: "checkpoint_request",
      requestId,
      kind: "settled",
      entryId: storageSeq > 0 ? String(storageSeq) : null,
    });
    const ack = await waitForAck(eventsDir, terminalId, requestId, 5_000, bridgeId, {
      shouldStop: () => interrupted,
    });
    sidecar.logEvent({
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
  syncSubagentChrome();
  stopSubagentApprovalTimer();
  syncIndicators();
  showPrompt();
}

// ---- session resume: replay the append-only log into a fresh view ----

/** Rebuild the context view from storage. Revision records address messages
 *  by stable sseq, so replay is order-independent and exact. */
function abortResume(message: string, file: string | null = sessionFile): void {
  out(`${message}\n`);
  history.length = 0;
  syncIndicators();
  closeSessionWriter();
  if (file) {
    const quarantined = quarantineSessionBundle(file);
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

/**
 * Writer failure keeps the bundle for retry: a transient permission or disk
 * error must not quarantine a valid session. Clears the partially installed
 * view so /resume can retry, without moving current/ or rotating the cache
 * seed. Only replay/parse failure quarantines.
 */
function abortResumeKeepBundle(message: string): void {
  out(`${message}\n`);
  history.length = 0;
  syncIndicators();
  closeSessionWriter();
  storageSeq = 0;
  streamPrepared = false;
  resetCacheContinuity();
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

async function resumeSessionBody(overrides?: {
  sessionFile?: string | null;
  openWriter?: () => void;
  testOnlyMaxBundleBytes?: number;
}): Promise<SessionResult> {
  const file = overrides?.sessionFile !== undefined ? overrides.sessionFile : sessionFile;
  const open = overrides?.openWriter ?? openSessionWriter;
  if (!file || !sessionBundleExists(file)) {
    out("(no stored session)\n");
    return { ok: false, error: "stored session is missing" };
  }
  if (!sessionBundleHasContent(file)) {
    out("(stored session is empty)\n");
    streamPrepared = false;
    return { ok: true };
  }
  const replayed = await replaySessionBundle(
    file,
    overrides?.testOnlyMaxBundleBytes === undefined
      ? undefined
      : { testOnlyMaxBundleBytes: overrides.testOnlyMaxBundleBytes },
  );
  if (!replayed.ok) {
    if (isSessionBudgetExceeded(replayed)) {
      // Capacity exhaustion is not corruption (#161): keep the acknowledged
      // bundle in place so nothing is lost, and let /resume retry. Starting
      // a fresh session archives this bundle aside for later inspection.
      abortResumeKeepBundle(`(resume failed: ${replayed.error}; the bundle is kept — start a new session to archive it)`);
      return { ok: false, error: replayed.error };
    }
    abortResume(`(resume failed: ${replayed.error})`, file);
    return { ok: false, error: replayed.error };
  }
  if (replayed.messages.length === 0 && replayed.maxSeq === 0) {
    out("(stored session is empty)\n");
    streamPrepared = false;
    return { ok: true };
  }
  installReplayedMessages(replayed);
  const savedModel = replayed.state.model;
  if (typeof savedModel === "string") {
    const next = parseModelRef(savedModel);
    if (
      next
      && savedModel.startsWith(`${next.provider}/`)
      && (hasStoredCredential(next.provider) || hasEnvCredential(next.provider))
    ) {
      if (next.provider !== route.provider) {
        route = { provider: next.provider, model: next.model };
        retargetSummary(next.provider);
      } else {
        route.model = next.model;
      }
    }
  }
  const savedEffort = replayed.state.effort;
  if (typeof savedEffort === "string" && (EFFORT_LEVELS as readonly string[]).includes(savedEffort)) {
    effortWanted = clampEffortLevel(route.provider, route.model, savedEffort as EffortLevel, providerProtocol(route.provider, route.model), routeReasoningLevels());
  }
  try {
    open();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    abortResumeKeepBundle(`(resume failed: ${error})`);
    return { ok: false, error };
  }
  streamPrepared = true;
  resetCacheContinuity();
  syncStatus();
  renderHistoryTranscript(history, surface);
  return { ok: true };
}

export type ResumeTestOverrides = {
  sessionFile?: string | null;
  openWriter?: () => void;
  testOnlyMaxBundleBytes?: number;
};

/** Test seam: drive the resume path against a temp bundle with an injected writer. */
export async function testOnlyResumeSessionBody(overrides?: ResumeTestOverrides): Promise<SessionResult> {
  return resumeSessionBody(overrides);
}

/** Test seam: inspect the resume view so tests can confirm /resume can retry. */
export function testOnlyResumeState(): { historyLength: number; storageSeq: number; streamPrepared: boolean } {
  return { historyLength: history.length, storageSeq, streamPrepared };
}

/** Test seam: bash approval policy that survives /clear on this process. */
export function testOnlyPermissionMode(): PermissionMode {
  return permissionMode;
}

/** Test seam: persist one record against the live writer (covers /clear sequence reset). */
export function testOnlyPersist(entry: Record<string, unknown> = { type: "checkpoint" }): SessionResult<{ storageSeq: number }> {
  try {
    return { ok: true, storageSeq: persist(entry) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Live-view reset shared by /clear success and its writer-open failure path.
 *  Conversation history, usage, and pending child-approval pickers go;
 *  permissionMode stays on the terminal. */
function resetLiveSessionState(): void {
  storageSeq = 0;
  history.length = 0;
  lastHandoff = null;
  clearSubagentApprovals();
  rotateCacheSession();
  sessionUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  lastUsd = null;
  postRevision = false;
  revisions = 0;
  revisionKinds = [];
  surface?.setStatus({ permissions: permissionMode });
  syncSubagentChrome();
}

/** Test seam: fail the next session-writer open (covers /clear recovery). */
let testOnlyOpenSessionWriterOverride: (() => void) | null = null;

export function testOnlySetOpenSessionWriterOverride(fn: (() => void) | null): void {
  testOnlyOpenSessionWriterOverride = fn;
}

/** Test seam: drive one input line through the command router. */
export function testOnlyDispatchLine(line: string): void {
  dispatchLine(line);
}

// ---- terminal surface ----

let surface: AgentTui | null = null;
let nonTtyTranscriptSection: "thinking" | "assistant" | null = null;
let pendingImageRefresh: Promise<void> | null = null;
let pendingImageRefreshAgain = false;

type ShutdownOptions = {
  reason?: string;
  timeoutMs?: number;
};

type ShutdownResult = {
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
  stopSubagentApprovalTimer();
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
      sidecar.logEvent({ t: "shutdown_timeout", reason, phase: "run", timeoutMs });
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
        sidecar.logEvent({ t: "shutdown_timeout", reason, phase: "trace", timeoutMs });
      } else if (closed.error) {
        ok = false;
        error = closed.error instanceof Error ? closed.error.message : String(closed.error);
        sidecar.logEvent({ t: "shutdown_failure", reason, phase: "trace", error });
      } else if (closed.value !== true) {
        ok = false;
        error = "trace runtime close failed";
        sidecar.logEvent({ t: "shutdown_failure", reason, phase: "trace", error });
      }
    }
    if (timedOut && error === null) error = "shutdown timed out";
    if (timedOut || !ok) sidecar.logEvent({ t: "shutdown_result", reason, ok: false, timedOut, error });
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
  // Usage reaches the host app through the sidecar feed; the TUI footer
  // carries controls only.
  logSettings();
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
  startSubagentApprovalTimer();
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
    stopSubagentApprovalTimer();
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

function printSkillPicker(): void {
  const rows = skillCommandRows(frontMatter.skills);
  if (rows.length === 0) {
    out("(no skills found)\n");
    return;
  }
  const width = Math.max(...rows.map((r) => r.name.length));
  out("pick a skill:\n");
  for (const r of rows) out(r.hint ? `  ${r.name.padEnd(width)}  ${r.hint}\n` : `  ${r.name}\n`);
}

let running = false;
let queuedLine: string | null = null;
let authBusy = false;

function drainQueuedLine(): void {
  if (queuedLine === null) return;
  const next = queuedLine;
  queuedLine = null;
  surface?.setQueued("");
  dispatchLine(next);
}

function engineBusy(): boolean {
  return running || authBusy || resumeBusy || mcpBusy;
}

/** Single-slot typed-ahead queue shared by mid-run submits and picker-time typing. */
function queueTypedLine(line: string): void {
  sidecar.logEvent({ t: "steer_input", behavior: "steer" });
  // Keep one typed-ahead prompt. More than one has no consumer yet.
  queuedLine = line;
  surface?.setQueued(line);
  out("(queued — runs after the current task)\n");
}

function submit(line: string, planTurn = false): void {
  if (resumeBusy || mcpBusy) {
    out("(engine busy)\n");
    return;
  }
  if (running) {
    queueTypedLine(line);
    return;
  }
  // A rejected prompt promise must never kill the engine: the pty would
  // close and the terminal looks like it quit on the user.
  void runPrompt(line, [], planTurn)
    .catch((err: unknown) => {
      out(`\nengine error: ${(err as Error).message}\n`);
      showPrompt();
    })
    .then(() => drainQueuedLine());
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

export function toSelectableCatalog(provider: ProviderId, models: ModelInfo[]): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const m of models) {
    // Explicitly toolless entries cannot drive this harness; silent stays.
    if (catalogSupportsTools(m) === false) continue;
    out.push({
      provider,
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      supportsTools: catalogSupportsTools(m),
      ...(typeof m.outputLimit === "number" ? { outputLimit: m.outputLimit } : {}),
    });
  }
  return out;
}

function allCatalogModels(): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const id of AUTH_PROVIDER_ORDER) {
    const models = catalogs.get(id);
    if (!models) continue;
    out.push(...toSelectableCatalog(id, models));
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
  const envRef = MODEL_ENV ? parseModelRef(MODEL_ENV, PROVIDER_ENV || undefined) : null;
  const preferred =
    envRef && route.provider === envRef.provider
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
    // The active provider blocks startup (availability check above); the
    // rest fill in behind it so the first /models already lists every
    // authenticated provider. Failures surface on demand, not here.
    void loadAuthenticatedCatalogs(false).then(
      (errors) => {
        for (const err of errors) process.stderr.write(`agent-core: catalog ${err}\n`);
      },
      (err) => {
        process.stderr.write(`agent-core: catalog background load failed: ${(err as Error).message}\n`);
      },
    );
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
    const refresh = /\brefresh\b|\breload\b/.test(line);
    const query = line
      .slice("/models".length)
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word && !/^(refresh|reload)$/i.test(word))
      .join(" ");
    const abort = new AbortController();
    catalogAbort = abort;
    authBusy = true;
    showPrompt();
    void (async () => {
      try {
        const errors = await loadAuthenticatedCatalogs(refresh || catalogs.size === 0, abort.signal);
        for (const err of errors) out(`(${err})\n`);
        const listed = filterCatalogModels(allCatalogModels(), query);
        if (listed.length > 0) out(`${formatCatalogLines(listed, route.provider, route.model)}\n`);
        else if (query) out(`(no models match "${query}")\n`);
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
        persistRouteSettingsOrWarn(`model ${route.provider}/${route.model}`);
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
      const switched = catalogs.get(route.provider)?.find((m) => m.id === route.model);
      if (switched && catalogSupportsTools(switched) === false) {
        out(`(warning: ${route.provider}/${route.model} does not advertise tool support)\n`);
      }
      syncStatus();
      persistRouteSettingsOrWarn(`model ${route.provider}/${route.model}`);
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
    if (result.ok && parsed.provider === route.provider) syncStatus();
    showPrompt();
    return;
  }
  authBusy = true;
  showPrompt();
  loginAbort = new AbortController();
  const abort = loginAbort;
  void runLogin(parsed.provider, parsed.mode, {
    write: (text) => out(text),
    waitForCode: (opts) => {
      // TTY masks when secret. Non-TTY readline cannot mask and must not be
      // used for key or code entry — the terminal echoes the line.
      surface?.setRawInput(true, { secret: opts?.secret === true });
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
      await resolveAuth(route.provider, abort.signal);
      syncStatus();
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

function syncStatus(): void {
  effortWanted = clampEffortLevel(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels());
  surface?.setEffortLevels(supportedEffortLevels(route.provider, route.model, providerProtocol(route.provider, route.model), routeReasoningLevels()));
  surface?.setStatus({
    model: `${route.provider}/${route.model}`,
    effort: clampEffortLevel(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels()),
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
    if (isApprovalAnswer(line)) {
      const resolve = approvalResolve;
      approvalResolve = null;
      resolve(line);
      return;
    }
    // Typed input during a picker queues as typed-ahead instead of denying.
    // The picker stays open until it gets an explicit /approve answer.
    if (!line.startsWith("/") && !line.startsWith("!")) {
      queueTypedLine(line);
      showPrompt();
      return;
    }
    // Slash and bang lines fall through to the normal dispatch below, which
    // answers with (engine busy) while the run holds the engine. The picker
    // stays pending either way.
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
  if (line === "/clear" || line === "/new") {
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
    }
    // Zero the live sequence before opening so the writer's lastStorageSeq
    // matches the empty bundle. Opening first reused the prior sequence and
    // the next persist failed with decreasing storageSeq.
    resetLiveSessionState();
    if (sessionFile) {
      try {
        openSessionWriter();
      } catch (err) {
        // The old view is archived, but there is no live writer: stay
        // not-prepared so the next prompt re-prepares (retrying the open)
        // rather than running writerless.
        streamPrepared = false;
        syncIndicators();
        out(`(could not start a fresh session: ${err instanceof Error ? err.message : String(err)}; retry with /clear or send a prompt)\n`);
        showPrompt();
        return;
      }
    }
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
        const n = await reclaim(true);
        const summed = await summarize(true);
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
    const available = supportedEffortLevels(route.provider, route.model, providerProtocol(route.provider, route.model), routeReasoningLevels());
    if ("show" in effortCmd) {
      const actual = clampEffortLevel(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels());
      if (effortControlFor(route.provider, route.model, providerProtocol(route.provider, route.model), routeReasoningLevels()) === "provider-default") {
        out(`(effort provider-default; this route sends no effort control)\n`);
      } else {
        out(`(effort ${actual}; available: ${available.join(", ")})\n`);
      }
      showPrompt();
      return;
    }
    const requested = effortCmd.effort;
    const prev = effortWanted;
    effortWanted = clampEffortLevel(route.provider, route.model, requested, providerProtocol(route.provider, route.model), routeReasoningLevels());
    if (effortWanted !== prev) {
      try {
        ensureRouteSettingsWritable();
        persistRouteSettings();
      } catch (err) {
        out(`(effort ${effortWanted}; setting not persisted: ${notPersistedReason(err)})\n`);
        syncStatus();
        showPrompt();
        return;
      }
    }
    out(effortWanted === requested ? `(effort ${effortWanted})\n` : `(effort ${effortWanted}; ${requested} is unavailable)\n`);
    syncStatus();
    showPrompt();
    return;
  }
  const planPrompt = planSlashSubmit(line);
  if (planPrompt !== null) {
    if (running) {
      queueTypedLine(line);
      showPrompt();
      return;
    }
    submit(planPrompt, true);
    showPrompt();
    return;
  }
  const skillCmd = parseSkillCommand(line, frontMatter.skills);
  if (skillCmd) {
    if ("error" in skillCmd) {
      out(`(${skillCmd.error})\n`);
      showPrompt();
      return;
    }
    if ("list" in skillCmd) {
      printSkillPicker();
      showPrompt();
      return;
    }
    if (running) {
      queueTypedLine(line);
      showPrompt();
      return;
    }
    submit(skillSlashSubmit(skillCmd.skill, skillCmd.request));
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
      sidecar.logEvent({
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
      sidecar.logEvent({ t: "trace_startup", runId: traceRunId, ok: false, error: message });
    }
  }
  // The TUI is constructed before the first MCP bind so it can render the
  // startup banner, but no prompt may be accepted until the tool schema is
  // fixed for this session.
  mcpBusy = true;
  frontMatter.systemPrompt();
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
    effortWanted = clampEffortLevel(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels());
    surface.setEffortLevels(supportedEffortLevels(route.provider, route.model, providerProtocol(route.provider, route.model), routeReasoningLevels()));
    surface.setSkillRows(skillCommandRows(frontMatter.skills));
    surface.setStatus({
      model: `${route.provider}/${route.model}`,
      effort: clampEffortLevel(route.provider, route.model, effortWanted, providerProtocol(route.provider, route.model), routeReasoningLevels()),
      permissions: permissionMode,
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
  let startupPrefilled = false;
  if (eventsDir && terminalId) {
    const control = consumeStartupControl(eventsDir, terminalId, bridgeId);
    const opId = control?.opId ?? "";
    if (!resumeResult.ok) sidecar.logEvent({ t: "session_ready", opId, ok: false, error: resumeResult.error });
    else if (!control) sidecar.logEvent({ t: "session_ready", opId, ok: true, reload: true });
    else sidecar.logEvent({ t: "session_ready", opId, ok: true });
    logSettings();
    if (control?.action === "prefill" && control.text) {
      startupPrefilled = true;
      surface?.setDraft(control.text);
      if (!surface) out(`${control.text}\n`);
    } else if (control?.action === "structured") {
      const started = structuredStartup(control);
      structured = started.text;
      structuredImages = started.images;
    }
  }
  showPrompt();
  const subagentTaskPath = parseSubagentTaskFlag(process.argv);
  const printed = parsePrintPrompt(process.argv);
  // First run with no provider: the `/login` picker is the TUI, not a
  // typed command. Prefill it so it is visible without expanding chrome.
  if (
    shouldAutoOpenLogin({
      hasSurface: surface !== null,
      historyLength: history.length,
      startupPrefilled,
      hasStructuredPrompt: structured !== "" || structuredImages.length > 0,
      isSubagent: subagentTaskPath !== null,
      isPrintMode: printed !== null,
      hasAuthenticatedProvider: firstAuthenticatedProvider() !== null,
    })
  ) {
    surface?.setDraft("/login");
  }
  if (structured || structuredImages.length > 0) {
    if (structured) out(`> ${structured}\n`);
    void runPrompt(structured, structuredImages)
      .catch((err: unknown) => {
        out(`\nengine error: ${(err as Error).message}\n`);
        showPrompt();
      });
    return;
  }
  if (subagentTaskPath !== null) {
    await runSubagentTask(subagentTaskPath);
    return;
  }
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

export function isDirectRun(): boolean {
  return isDirectRunFrom(import.meta.url, process.argv[1]);
}

if (isDirectRun()) {
  void main();
}
