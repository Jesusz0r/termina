/**
 * Trace input normalization into schema shapes.
 *
 * Owns coercion helpers that build immutable schema values from unknown
 * inputs. Split from agent-core/trace.ts (issue #38).
 */
import { isRecord } from "../../shared/guards.ts";
import { MAX_ARRAY_ITEMS, MAX_ID_CHARS, MAX_RECLAIM_TARGETS, MAX_STRING_CHARS, MAX_TOOL_OUTCOMES } from "./schema.ts";
import type { TraceBoundedToolOutput, TraceCache, TraceCacheInput, TraceCacheMissAttribution, TraceCachePolicy, TraceCachePolicyInput, TraceContinuation, TraceCost, TraceCostComponents, TraceCostInput, TraceCostScope, TraceCostUnits, TraceReclaimEvidence, TraceReclaimTarget, TraceRevisions, TraceRevisionsInput, TraceToolOutcome, TraceUsage, TraceUsageInput } from "./schema.ts";


export function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const item of value) freezeDeep(item);
    } else {
      for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item);
    }
    Object.freeze(value);
  }
  return value;
}


export function text(value: unknown, name: string, required = false): string | null {
  if (value === null || value === undefined) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string or null`);
  if (value.length > MAX_STRING_CHARS) throw new Error(`${name} exceeds ${MAX_STRING_CHARS} characters`);
  if ([...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  })) throw new Error(`${name} contains a control character`);
  const normalized = required ? value.trim() : value;
  if (required && normalized.length === 0) throw new Error(`${name} must not be empty`);
  return normalized || (required ? null : null);
}


export function id(value: unknown, name: string): string {
  const normalized = text(value, name, true)!;
  if (normalized.length > MAX_ID_CHARS) throw new Error(`${name} exceeds ${MAX_ID_CHARS} characters`);
  return normalized;
}


export function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}


export function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}


function requiredInteger(value: unknown, name: string): number {
  const normalized = nullableInteger(value);
  if (normalized === null) throw new Error(`${name} must be a nonnegative safe integer`);
  return normalized;
}


function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}


export function optionalText(value: unknown, name: string): string | null {
  if (value === null || value === undefined || typeof value !== "string") return null;
  try {
    return text(value, name);
  } catch {
    return null;
  }
}


export function stringArray(value: readonly unknown[] | null | undefined, name: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > MAX_ARRAY_ITEMS) throw new Error(`${name} exceeds ${MAX_ARRAY_ITEMS} items`);
  return value.map((item, index) => text(item, `${name}[${index}]`, true)!).filter((item) => item.length > 0);
}


function numberArray(value: readonly unknown[] | null | undefined, name: string): number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > 256 || value.some((item) => !Number.isSafeInteger(item) || (item as number) < 0)) return null;
  return value.slice() as number[];
}


function emptyCostComponents(): TraceCostComponents {
  return { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, storage: null };
}


function costComponents(value: unknown): TraceCostComponents {
  if (!isRecord(value)) return emptyCostComponents();
  return {
    input: nullableNumber(value.input),
    cacheRead: nullableNumber(value.cacheRead),
    cacheWrite: nullableNumber(value.cacheWrite),
    output: nullableNumber(value.output),
    reasoning: nullableNumber(value.reasoning),
    storage: nullableNumber(value.storage),
  };
}


function costScope(value: unknown): TraceCostScope | null {
  if (!isRecord(value)) return null;
  const provider = optionalText(value.provider, "cost scope provider");
  const protocol = optionalText(value.protocol, "cost scope protocol");
  const model = optionalText(value.model, "cost scope model");
  const route = optionalText(value.route, "cost scope route");
  const role = value.role === "main" || value.role === "summary" ? value.role : null;
  if (provider === null || protocol === null || model === null || route === null || role === null) return null;
  return freezeDeep({ provider, protocol, model, route, role });
}


function costUnits(value: unknown): TraceCostUnits | null {
  if (!isRecord(value)) return null;
  return freezeDeep({
    input: optionalText(value.input, "cost units input"),
    cacheRead: optionalText(value.cacheRead, "cost units cacheRead"),
    cacheWrite: optionalText(value.cacheWrite, "cost units cacheWrite"),
    output: optionalText(value.output, "cost units output"),
    reasoning: optionalText(value.reasoning, "cost units reasoning"),
    storage: optionalText(value.storage, "cost units storage"),
  });
}


function missAttribution(value: TraceCacheInput["missAttribution"] | null | undefined): TraceCacheMissAttribution {
  if (!isRecord(value)) {
    return freezeDeep({
      attributed: null,
      primary: null,
      contributing: [],
      missedTokens: null,
      gapMs: null,
      missingFields: [],
      noiseFloorTokens: null,
    });
  }
  let contributing: string[] = [];
  let missingFields: string[] = [];
  try {
    contributing = stringArray(value.contributing as readonly unknown[] | null | undefined, "cache miss contributing");
    missingFields = stringArray(value.missingFields as readonly unknown[] | null | undefined, "cache miss missingFields");
  } catch {
    /* Unknown provider diagnostics remain empty rather than breaking the trace. */
  }
  return freezeDeep({
    attributed: nullableBoolean(value.attributed),
    primary: optionalText(value.primary, "cache miss primary"),
    contributing,
    missedTokens: nullableNumber(value.missedTokens),
    gapMs: nullableNumber(value.gapMs),
    missingFields,
    noiseFloorTokens: nullableNumber(value.noiseFloorTokens),
  });
}


function boundedToolOutput(value: unknown): TraceBoundedToolOutput | null {
  if (!isRecord(value)) return null;
  return freezeDeep({
    state: optionalText(value.state, "tool output state"),
    direction: optionalText(value.direction, "tool output direction"),
    limitBytes: nullableInteger(value.limitBytes),
    inputBytes: nullableInteger(value.inputBytes),
    retainedBytes: nullableInteger(value.retainedBytes),
    omittedBytes: nullableInteger(value.omittedBytes),
    outputBytes: nullableInteger(value.outputBytes ?? value.bytes),
    truncated: nullableBoolean(value.truncated),
  });
}


function continuation(value: unknown): TraceContinuation | null {
  if (!isRecord(value)) return null;
  return freezeDeep({
    server: optionalText(value.server, "continuation server"),
    tool: optionalText(value.tool, "continuation tool"),
    guidance: optionalText(value.guidance, "continuation guidance"),
  });
}


function toolOutcome(value: unknown): TraceToolOutcome | null {
  if (!isRecord(value)) return null;
  return freezeDeep({
    toolName: optionalText(value.toolName ?? value.name ?? value.tool, "tool outcome name"),
    toolCallId: optionalText(value.toolCallId ?? value.callId, "tool outcome call id"),
    isError: nullableBoolean(value.isError),
    bounded: boundedToolOutput(value.bounded ?? value),
    cancellationScope: optionalText(value.cancellationScope, "tool cancellation scope"),
    continuation: continuation(value.continuation),
    repro: optionalText(value.repro, "tool reproduction"),
    stdout: boundedToolOutput(value.stdout),
    stderr: boundedToolOutput(value.stderr),
    exitCode: nullableInteger(value.exitCode),
    signal: optionalText(value.signal, "tool signal"),
  });
}


export function toolOutcomes(value: readonly unknown[] | null | undefined): TraceToolOutcome[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_TOOL_OUTCOMES)
    .map((item) => toolOutcome(item))
    .filter((item): item is TraceToolOutcome => item !== null);
}


function nestedRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}


function reclaimTarget(value: unknown): TraceReclaimTarget | null {
  if (!isRecord(value)) return null;
  const original = nestedRecord(value.original);
  const fallback = nestedRecord(value.fallback) ?? nestedRecord(value.recovery);
  return freezeDeep({
    sseq: nullableInteger(value.sseq),
    sourceSseq: nullableInteger(value.sourceSseq),
    blockIndex: nullableInteger(value.blockIndex),
    action: optionalText(value.action ?? value.kind, "reclaim action"),
    originalType: optionalText(value.originalType ?? original?.type, "reclaim original type"),
    originalChars: nullableInteger(value.originalChars ?? original?.chars),
    originalBytes: nullableInteger(value.originalBytes ?? original?.bytes),
    originalSha256: optionalText(value.originalSha256 ?? value.originalHash ?? original?.sha256 ?? original?.hash, "reclaim original hash"),
    stubSha256: optionalText(value.stubSha256 ?? value.stubHash, "reclaim stub hash"),
    reclaimedTokens: nullableInteger(value.reclaimedTokens),
    tool: optionalText(value.tool ?? fallback?.tool, "reclaim tool"),
    repro: optionalText(value.repro ?? fallback?.repro, "reclaim reproduction"),
    recovery: optionalText(value.recovery ?? fallback?.source, "reclaim recovery"),
    result: optionalText(value.result ?? value.status, "reclaim result"),
  });
}


export function reclaimEvidence(value: unknown): TraceReclaimEvidence | null {
  if (!isRecord(value)) return null;
  const rawTargets = Array.isArray(value.targets) ? value.targets : Array.isArray(value.receipts) ? value.receipts : [];
  const targets = rawTargets.slice(0, MAX_RECLAIM_TARGETS)
    .map((item) => reclaimTarget(item))
    .filter((item): item is TraceReclaimTarget => item !== null);
  return freezeDeep({
    attempted: nullableBoolean(value.attempted ?? value.planned),
    planned: nullableBoolean(value.planned),
    applied: nullableBoolean(value.applied),
    recovered: nullableBoolean(value.recovered),
    revisionId: optionalText(value.revisionId, "reclaim revision id"),
    targetCount: nullableInteger(value.targetCount) ?? (rawTargets.length > 0 ? rawTargets.length : null),
    reclaimedBytes: nullableInteger(value.reclaimedBytes ?? value.bytes),
    reclaimedTokens: nullableInteger(value.reclaimedTokens ?? value.tokens),
    source: optionalText(value.source, "reclaim source"),
    recovery: optionalText(value.recovery, "reclaim recovery"),
    error: optionalText(value.error, "reclaim error"),
    targets,
  });
}


export function pair(value: readonly [unknown, unknown] | null | undefined, name: string): [number, number] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${name} must contain two integers`);
  const first = requiredInteger(value[0], `${name}[0]`);
  const second = requiredInteger(value[1], `${name}[1]`);
  if (second < first) throw new Error(`${name} must be ordered`);
  return [first, second];
}


function policy(value: TraceCachePolicyInput | null | undefined): TraceCachePolicy {
  return freezeDeep({
    mode: text(value?.mode, "cache policy mode"),
    ttlMs: nullableNumber(value?.ttlMs),
    namespace: text(value?.namespace, "cache policy namespace"),
    markerCount: nullableInteger(value?.markerCount),
    markerPositions: numberArray(value?.markerPositions, "cache policy markerPositions"),
    rejected: nullableBoolean(value?.rejected),
    fallbackReason: text(value?.fallbackReason, "cache policy fallback reason"),
  });
}


export function usage(value: TraceUsageInput | null | undefined): TraceUsage {
  return freezeDeep({
    input: nullableNumber(value?.input),
    cacheRead: nullableNumber(value?.cacheRead),
    cacheWrite: nullableNumber(value?.cacheWrite),
    output: nullableNumber(value?.output),
    reasoning: nullableNumber(value?.reasoning),
  });
}


export function cost(value: TraceCostInput | null | undefined): TraceCost {
  return freezeDeep({
    usd: nullableNumber(value?.usd),
    source: text(value?.source, "cost source"),
    version: text(value?.version, "cost version"),
    lookedUpAt: text(value?.lookedUpAt, "cost lookup timestamp"),
    knownFields: stringArray(value?.knownFields, "cost knownFields"),
    unknownFields: stringArray(value?.unknownFields, "cost unknownFields"),
    unknownReasons: stringArray(value?.unknownReasons, "cost unknownReasons"),
    scope: costScope(value?.scope),
    units: costUnits(value?.units),
    components: costComponents(value?.components),
    rates: costComponents(value?.rates),
    cacheWriteTtlClass: optionalText(value?.cacheWriteTtlClass, "cost cacheWriteTtlClass"),
    reasoningBilling: optionalText(value?.reasoningBilling, "cost reasoningBilling"),
  });
}


export function cache(value: TraceCacheInput | null | undefined): TraceCache {
  const requested = policy(value?.requested);
  const effective = policy(value?.effective);
  return freezeDeep({
    namespace: text(value?.namespace, "cache namespace"),
    requested,
    effective,
    markerCount: nullableInteger(value?.markerCount),
    markerPositions: numberArray(value?.markerPositions, "cache markerPositions"),
    rejected: nullableBoolean(value?.rejected),
    fallbackReason: text(value?.fallbackReason, "cache fallback reason"),
    cacheKeyHash: text(value?.cacheKeyHash, "cache key hash"),
    modelSettingsHash: text(value?.modelSettingsHash, "model settings hash"),
    toolsHash: text(value?.toolsHash, "tools hash"),
    serializedToolsHash: optionalText(value?.serializedToolsHash, "serialized tools hash"),
    serializedToolsBytes: nullableInteger(value?.serializedToolsBytes),
    stablePrefixHash: text(value?.stablePrefixHash, "stable prefix hash"),
    reusablePrefixHash: text(value?.reusablePrefixHash, "reusable prefix hash"),
    reusablePrefixItems: nullableInteger(value?.reusablePrefixItems),
    comparedPrefixHash: optionalText(value?.comparedPrefixHash, "compared prefix hash"),
    comparedPrefixItems: nullableInteger(value?.comparedPrefixItems),
    messagePrefixHash: text(value?.messagePrefixHash, "message prefix hash"),
    workingSetHash: text(value?.workingSetHash, "working set hash"),
    workingSetChanged: nullableBoolean(value?.workingSetChanged),
    retryPromptIdentical: nullableBoolean(value?.retryPromptIdentical),
    codexTurnStateUsed: typeof value?.codexTurnStateUsed === "boolean" ? value.codexTurnStateUsed : null,
    missAttribution: missAttribution(value?.missAttribution),
  });
}


export function revisions(value: TraceRevisionsInput | number | null | undefined): TraceRevisions {
  if (typeof value === "number") return freezeDeep({ count: nullableInteger(value), kinds: [] });
  return freezeDeep({
    count: nullableInteger(value?.count),
    kinds: stringArray(value?.kinds, "revision kinds"),
  });
}
