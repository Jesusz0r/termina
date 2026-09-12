#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateV2Relationships,
  v2CompositeKey,
  type TraceFileError,
  type TraceJsonObject,
  type TraceJsonValue,
} from "./trace-links.ts";

const MAX_TRACE_FILES = 10_000;
const MAX_TRACE_BYTES = 1024 * 1024;
const TRACE_SCHEMA_VERSION = 2;
const TRACE_RECORD_TYPES = new Set(["attempt", "task-settled"]);
const MAX_REPORT_LIST_ITEMS = 256;
const MAX_REPORT_STRING_CHARS = 512;

/** Records with the non-enumerable diagnostics expando readTraceDirectory attaches. */
type TraceRecordList = TraceJsonObject[] & { traceDiagnostics?: TraceJsonObject };

type V2UsageMetric = { total: number; knownSamples: number; unknownSamples: number };
type V2UsageField = "input" | "cacheRead" | "cacheWrite" | "output" | "reasoning";
type V2UsageAggregate = {
  input: V2UsageMetric;
  cacheRead: V2UsageMetric;
  cacheWrite: V2UsageMetric;
  output: V2UsageMetric;
  reasoning: V2UsageMetric;
  completeSamples: number;
  partialSamples: number;
  unknownSamples: number;
  cachedInputShare: number | null;
  cacheShareDenominator: { input: number; cacheRead: number; cacheWrite: number; totalInput: number; knownSamples: number };
};
type V2CostAggregate = { totalUsd: number; knownSamples: number; unknownSamples: number; byPriceSource: Record<string, number> };
type V2CostDetails = { components: Record<string, V2UsageMetric>; unknownReasons: Record<string, number> };
type V2CostComponents = Record<string, number | null>;
type V2Policy = { mode: string | null; ttlMs: number | null };
type V2Miss = {
  attributed: boolean | null;
  primary: string | null;
  contributing: string[];
  missedTokens: number | null;
  gapMs: number | null;
  missingFields: string[];
  noiseFloorTokens: number | null;
};
type V2ToolOutcome = {
  name: string | null;
  status: string;
  complete: boolean | null;
  truncated: boolean | null;
  isError: boolean | null;
  state: string | null;
  direction: string | null;
  limitBytes: number | null;
  inputBytes: number | null;
  retainedBytes: number | null;
  omittedBytes: number | null;
  outputBytes: number | null;
  bytes: number | null;
  tokens: number | null;
  exitCode: number | null;
  cancellationScope: string | null;
};
type V2ReclaimReceipt = {
  kind: string | null;
  sourceSseq: number | null;
  blockIndex: number | null;
  originalBytes: number | null;
  reclaimedBytes: number | null;
  reclaimedTokens: number | null;
  originalHash: string | null;
  stubHash: string | null;
  recovery: string | null;
  status: string | null;
};
type V2ReclaimEvidence = {
  attempted: boolean | null;
  applied: boolean | null;
  recovered: boolean | null;
  reclaimedBytes: number | null;
  reclaimedTokens: number | null;
  targetCount: number | null;
  receiptCount: number | null;
  omittedReceipts: number;
  revisionId: string | null;
  source: string | null;
  error: string | null;
  receipts: V2ReclaimReceipt[];
  targets: V2ReclaimReceipt[];
};
type V2Usage = { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null; reasoning: number | null };
type V2AttemptCost = {
  usd: number | null;
  source: string | null;
  version: string | null;
  lookedUpAt: string | null;
  knownFields: string[];
  unknownFields: string[];
  unknownReasons: string[];
  components: V2CostComponents;
};
type V2Cache = {
  namespace: string | null;
  requested: V2Policy;
  effective: V2Policy;
  markerCount: number | null;
  markerPositions: number[];
  rejected: boolean | null;
  fallbackReason: string | null;
  cacheKeyHash: string | null;
  modelSettingsHash: string | null;
  toolsHash: string | null;
  stablePrefixHash: string | null;
  reusablePrefixHash: string | null;
  reusablePrefixItems: number | null;
  comparedPrefixHash: string | null;
  comparedPrefixItems: number | null;
  messagePrefixHash: string | null;
  workingSetHash: string | null;
  workingSetChanged: boolean | null;
  retryPromptIdentical: boolean | null;
  codexTurnStateUsed: boolean;
  missAttribution: V2Miss;
};
type V2Revisions = { count: number | null; kinds: string[] };
type V2NormalizedAttempt = {
  id: string;
  runId: string | null;
  taskId: string | null;
  attemptId: string;
  parentAttemptId: string | null;
  retryOfAttemptId: string | null;
  role: string;
  provider: string;
  protocol: string;
  route: string | null;
  model: string;
  taskClass: string | null;
  requestedEffort: string | null;
  effectiveEffort: string | null;
  status: string;
  retryCount: number | null;
  fallbackReason: string | null;
  ttftMs: number | null;
  turnMs: number | null;
  usage: V2Usage;
  cost: V2AttemptCost;
  cache: V2Cache;
  revisions: V2Revisions;
  toolNames: string[];
  toolOutcomes: V2ToolOutcome[];
  reclaimEvidence: V2ReclaimEvidence | null;
  sessionLengthBucket: string | null;
  wasteTokens: number | null;
  wasteCause: string | null;
  traceTurn: number | null;
};
type V2TaskGroup = {
  runId: string | null;
  taskId: string | null;
  total: number;
  main: number;
  summary: number;
  unknownRole: number;
  retries: number;
  fallbacks: number;
  attemptIds: string[];
  finalAttemptId: string | null;
  settled: boolean;
  outcomeStatus: string | null;
  outcomeClass: string;
  correctness: string | null;
  taskClass: string | null;
  sessionLengthBucket: string | null;
};
type V2CacheGroup = {
  turns: number;
  totalInput: number;
  cacheRead: number;
  cachedInputShare: number | null;
  completeSamples: number;
  partialSamples: number;
  unknownSamples: number;
};
type V2DimensionGroup = {
  attempts: number;
  tasks: number;
  usage: V2UsageAggregate;
  cost: V2CostAggregate & V2CostDetails;
  cachedInputShare: number | null;
};
type V2PerTurn = {
  turn: number;
  taskId: string | null;
  attemptId: string;
  role: string;
  status: string;
  provider: string;
  protocol: string;
  route: string | null;
  model: string;
  sessionLengthBucket: string | null;
  totalInput: number | null;
  cacheRead: number | null;
  cachedInputShare: number | null;
  cache: V2Cache;
};

function knownNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableNonnegative(value: unknown): number | null {
  return knownNonnegative(value) ? value : null;
}

function nullableSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedString(value: unknown, limit = MAX_REPORT_STRING_CHARS): string | null {
  const text = nonemptyString(value);
  return text === null ? null : text.slice(0, limit);
}

function boundedStringArray(value: unknown, limit = MAX_REPORT_LIST_ITEMS): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = boundedString(item);
    if (text === null || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function metricFromValues(values: (number | null)[]): V2UsageMetric {
  let total = 0;
  let knownSamples = 0;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    knownSamples++;
  }
  return { total, knownSamples, unknownSamples: values.length - knownSamples };
}

function compareStable(left: unknown, right: unknown): number {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function knownCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTraceRecord(record: TraceJsonValue): asserts record is TraceJsonObject {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("root is not an object");
  }
  if (record.schemaVersion !== TRACE_SCHEMA_VERSION) {
    throw new Error(`unsupported trace schema version: ${String(record.schemaVersion)}`);
  }
  if (typeof record.recordType !== "string" || !TRACE_RECORD_TYPES.has(record.recordType)) {
    throw new Error(`unsupported trace record type: ${String(record.recordType)}`);
  }
  if (!nonemptyString(record.runId)) throw new Error("v2 record is missing runId");
  if (!nonemptyString(record.taskId)) throw new Error("v2 record is missing taskId");
  if (record.recordType === "attempt" && !nonemptyString(record.attemptId)) {
    throw new Error("v2 attempt is missing attemptId");
  }
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function counts(values: string[]): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareStable(a, b)));
}

function traceNumber(name: string): number | null {
  const match = /^turn-(\d+)\.json$/.exec(name);
  if (!match) return null;
  const turn = Number(match[1]);
  return Number.isSafeInteger(turn) && turn > 0 ? turn : null;
}

function likelyPartialText(value: string): boolean {
  const text = value.trimEnd();
  if (text.length === 0) return true;
  const last = text[text.length - 1];
  return last !== "}" && last !== "]";
}

export function readTraceDirectory(path: string) {
  const directory = resolve(path);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`trace directory does not exist: ${directory}`);
  }
  const candidateNames = readdirSync(directory)
    .map((name) => ({ name, turn: traceNumber(name) }))
    .filter((item): item is { name: string; turn: number } => item.turn !== null)
    .sort((a, b) => a.turn - b.turn || compareStable(a.name, b.name))
  const names = candidateNames.slice(-MAX_TRACE_FILES);
  const records: TraceJsonObject[] = [];
  const recordErrors: TraceFileError[] = [];
  let scannedPartialRecords = 0;
  for (const { name, turn } of names) {
    const file = join(directory, name);
    try {
      if (statSync(file).size > MAX_TRACE_BYTES) throw new Error("file exceeds 1 MiB");
      const record = JSON.parse(readFileSync(file, "utf8"));
      validTraceRecord(record);
      records.push({ ...record, traceTurn: turn });
    } catch (error) {
      if (error instanceof SyntaxError) {
        try {
          if (likelyPartialText(readFileSync(file, "utf8"))) scannedPartialRecords++;
        } catch {
          /* The malformed file remains accounted for even when it disappears. */
        }
      }
      recordErrors.push({ file: name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const parsedRecordErrorCount = recordErrors.length;
  const relationshipValidation = validateV2Relationships(
    directory,
    records,
    new Set(names.map(({ turn }) => turn)),
    new Set(candidateNames.slice(0, candidateNames.length - names.length).map(({ turn }) => turn)),
  );
  records.splice(0, records.length, ...relationshipValidation.records);
  recordErrors.push(...relationshipValidation.errors);

  let manifest: TraceJsonObject | null = null;
  const manifestErrors: TraceFileError[] = [];
  const manifestFile = join(directory, "trace-manifest.json");
  if (existsSync(manifestFile)) {
    try {
      if (statSync(manifestFile).size > MAX_TRACE_BYTES) throw new Error("file exceeds 1 MiB");
      const value = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest root is not an object");
      if (value.schemaVersion !== TRACE_SCHEMA_VERSION || value.kind !== "trace-manifest") {
        throw new Error("unsupported trace manifest");
      }
      manifest = value;
    } catch (error) {
      manifestErrors.push({ file: "trace-manifest.json", error: error instanceof Error ? error.message : String(error) });
    }
  }

  const manifestCount = (field: string): number | null => {
    if (!manifest) return null;
    const value = manifest[field];
    if (value === undefined) return null;
    if (!knownCount(value)) {
      manifestErrors.push({ file: "trace-manifest.json", error: `${field} must be a nonnegative integer` });
      return null;
    }
    return value;
  };
  const schemaRecords = {
    current: records.filter((record) => record.schemaVersion === TRACE_SCHEMA_VERSION).length,
  };
  const retainedRecords = manifestCount("retainedRecords");
  const omittedRecords = manifestCount("omittedRecords");
  const writeFailures = manifestCount("writeFailures");
  const manifestMalformedRecords = manifestCount("malformedRecords");
  const manifestPartialRecords = manifestCount("partialRecords");
  const retentionFailures = manifestCount("retentionFailures");
  const manifestWriteFailures = manifestCount("manifestWriteFailures");
  const lastTraceTurn = manifestCount("lastTraceTurn");
  const errors = [...recordErrors, ...manifestErrors];

  const diagnostics = {
    retainedRecords: retainedRecords ?? records.length,
    omittedRecords,
    writeFailures,
    malformedRecords: Math.max(parsedRecordErrorCount + relationshipValidation.malformedRecords, manifestMalformedRecords ?? 0),
    partialRecords: Math.max(scannedPartialRecords, manifestPartialRecords ?? 0),
    retentionFailures,
    manifestWriteFailures,
    lastTraceTurn,
    readerOmittedRecords: candidateNames.length - names.length,
    manifestErrors: manifestErrors.length,
    schemaRecords,
    linkIndex: relationshipValidation.linkIndex,
  };
  Object.defineProperty(records, "traceDiagnostics", { value: diagnostics, enumerable: false });
  return {
    directory,
    records,
    errors,
    matchedFiles: candidateNames.length,
    retainedFiles: names.length,
    diagnostics,
  };
}

function isV2Record(record: TraceJsonObject): boolean {
  return record.schemaVersion === TRACE_SCHEMA_VERSION
    && typeof record.recordType === "string"
    && TRACE_RECORD_TYPES.has(record.recordType);
}

function v2RecordId(record: TraceJsonObject, index: number): string {
  return nonemptyString(record.attemptId) ?? `trace-${Number.isInteger(record.traceTurn) ? record.traceTurn : index + 1}`;
}

function v2TaskId(record: TraceJsonObject): string | null {
  return nonemptyString(record.taskId);
}

function v2UsageValue(record: TraceJsonObject, field: string): number | null {
  const usage = record.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage) ? nullableNonnegative(usage[field]) : null;
}

function aggregateV2Usage(attempts: TraceJsonObject[]): V2UsageAggregate {
  const metric = (field: V2UsageField): V2UsageMetric => {
    let total = 0;
    let knownSamples = 0;
    for (const record of attempts) {
      const value = v2UsageValue(record, field);
      if (value === null) continue;
      total += value;
      knownSamples++;
    }
    return { total, knownSamples, unknownSamples: attempts.length - knownSamples };
  };
  const cacheFields = ["input", "cacheRead", "cacheWrite"] as const;
  let completeSamples = 0;
  let partialSamples = 0;
  let unknownSamples = 0;
  const completeTotals = { input: 0, cacheRead: 0, cacheWrite: 0 };
  for (const record of attempts) {
    const values = cacheFields.map((field) => v2UsageValue(record, field));
    const known = values.filter((value) => value !== null).length;
    if (known === cacheFields.length) {
      completeSamples++;
      for (const [index, field] of cacheFields.entries()) completeTotals[field] += values[index] ?? 0;
    } else if (known > 0) {
      partialSamples++;
    } else {
      unknownSamples++;
    }
  }
  const totalInput = completeTotals.input + completeTotals.cacheRead + completeTotals.cacheWrite;
  return {
    input: metric("input"),
    cacheRead: metric("cacheRead"),
    cacheWrite: metric("cacheWrite"),
    output: metric("output"),
    reasoning: metric("reasoning"),
    completeSamples,
    partialSamples,
    unknownSamples,
    cachedInputShare: totalInput > 0 ? completeTotals.cacheRead / totalInput : null,
    cacheShareDenominator: {
      input: completeTotals.input,
      cacheRead: completeTotals.cacheRead,
      cacheWrite: completeTotals.cacheWrite,
      totalInput,
      knownSamples: completeSamples,
    },
  };
}

function summarizeCachePhase(attempts: TraceJsonObject[]) {
  const usage = aggregateV2Usage(attempts);
  return {
    turns: attempts.length,
    completeSamples: usage.completeSamples,
    partialSamples: usage.partialSamples,
    unknownSamples: usage.unknownSamples,
    input: usage.input.total,
    cacheRead: usage.cacheRead.total,
    cacheWrite: usage.cacheWrite.total,
    totalInput: usage.cacheShareDenominator.totalInput,
    cachedInputShare: usage.cachedInputShare,
  };
}

function summarizeIdleGaps(attempts: V2NormalizedAttempt[]) {
  const gaps = attempts.slice(1).map((attempt) => attempt.cache.missAttribution.gapMs);
  const known = gaps.filter((gap): gap is number => gap !== null);
  const within5Minutes = known.filter((gap) => gap <= 5 * 60 * 1000).length;
  const between5MinutesAnd1Hour = known.filter((gap) => gap > 5 * 60 * 1000 && gap <= 60 * 60 * 1000).length;
  return {
    transitions: gaps.length,
    known: known.length,
    unknown: gaps.length - known.length,
    within5Minutes,
    between5MinutesAnd1Hour,
    over1Hour: known.filter((gap) => gap > 60 * 60 * 1000).length,
    ttlComparison: {
      fiveMinuteEligibleTransitions: within5Minutes,
      oneHourEligibleTransitions: within5Minutes + between5MinutesAnd1Hour,
      oneHourOnlyTransitions: between5MinutesAnd1Hour,
    },
  };
}

function v2CostValue(record: TraceJsonObject): number | null {
  const cost = record.cost;
  const usd = cost && typeof cost === "object" ? (!Array.isArray(cost) ? cost.usd : undefined) : record.usd;
  return nullableNonnegative(usd);
}

const V2_COST_COMPONENT_FIELDS = ["input", "cacheRead", "cacheWrite", "output", "reasoning", "storage"];

function v2CostObject(record: TraceJsonObject): TraceJsonObject | null {
  return record.cost && typeof record.cost === "object" && !Array.isArray(record.cost) ? record.cost : null;
}

function v2CostComponents(record: TraceJsonObject): V2CostComponents {
  const cost = v2CostObject(record);
  const components = cost?.components && typeof cost.components === "object" && !Array.isArray(cost.components)
    ? cost.components
    : null;
  return Object.fromEntries(V2_COST_COMPONENT_FIELDS.map((field) => [field, nullableNonnegative(components?.[field])]));
}

function v2CostUnknownReasons(record: TraceJsonObject): string[] {
  const cost = v2CostObject(record);
  const explicit = boundedStringArray(cost?.unknownReasons ?? record.unknownReasons);
  const singular = boundedString(cost?.unknownReason ?? record.unknownReason);
  if (explicit.length === 0 && singular !== null) explicit.push(singular);
  if (explicit.length > 0) return explicit;
  const value = v2CostValue(record);
  if (value !== null) return [];
  const unknownFields = boundedStringArray(cost?.unknownFields);
  if (unknownFields.length > 0) return unknownFields.map((field) => `missing-${field}`);
  return ["cost-not-reported"];
}

function aggregateV2Cost(attempts: TraceJsonObject[]): V2CostAggregate {
  let totalUsd = 0;
  let knownSamples = 0;
  const byPriceSource: Record<string, number> = Object.create(null);
  for (const record of attempts) {
    const value = v2CostValue(record);
    if (value === null) continue;
    totalUsd += value;
    knownSamples++;
    const cost = record.cost;
    const source = nonemptyString(
      cost && typeof cost === "object" ? (!Array.isArray(cost) ? cost.source : undefined) : record.priceSource,
    );
    if (source) byPriceSource[source] = (byPriceSource[source] ?? 0) + 1;
  }
  return {
    totalUsd,
    knownSamples,
    unknownSamples: attempts.length - knownSamples,
    byPriceSource: Object.fromEntries(Object.entries(byPriceSource).sort(([a], [b]) => compareStable(a, b))),
  };
}

function aggregateV2CostDetails(attempts: TraceJsonObject[]): V2CostDetails {
  const components: Record<string, V2UsageMetric> = {};
  for (const field of V2_COST_COMPONENT_FIELDS) {
    components[field] = metricFromValues(attempts.map((attempt) => v2CostComponents(attempt)[field]));
  }
  return {
    components,
    unknownReasons: counts(attempts.flatMap((attempt) => v2CostUnknownReasons(attempt))),
  };
}

function normalizeV2Policy(value: TraceJsonValue): V2Policy {
  const policy = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  return {
    mode: nonemptyString(policy?.mode),
    ttlMs: nullableNonnegative(policy?.ttlMs),
  };
}

function normalizeV2SessionLengthBucket(record: TraceJsonObject): string | null {
  const session = record.session && typeof record.session === "object" && !Array.isArray(record.session)
    ? record.session
    : null;
  const sessionLength = record.sessionLength && typeof record.sessionLength === "object" && !Array.isArray(record.sessionLength)
    ? record.sessionLength
    : null;
  return boundedString(
    record.sessionLengthBucket
      ?? session?.lengthBucket
      ?? sessionLength?.bucket,
  );
}

function normalizeV2Miss(record: TraceJsonObject, cache: TraceJsonObject | null | undefined): V2Miss {
  const miss = cache?.missAttribution
    ?? cache?.miss
    ?? record.missAttribution
    ?? record.miss
    ?? null;
  const missObj = miss && typeof miss === "object" && !Array.isArray(miss) ? miss : null;
  const contributors = missObj?.contributing ?? missObj?.contributors ?? record.missContributors;
  return {
    attributed: nullableBoolean(missObj?.attributed),
    primary: boundedString(missObj?.primary ?? missObj?.primaryCause ?? record.missPrimary),
    contributing: boundedStringArray(contributors),
    missedTokens: nullableNonnegative(missObj?.missedTokens),
    gapMs: nullableNonnegative(missObj?.gapMs),
    missingFields: boundedStringArray(missObj?.missingFields),
    noiseFloorTokens: nullableNonnegative(missObj?.noiseFloorTokens),
  };
}

function normalizeV2ToolOutcome(value: TraceJsonValue): V2ToolOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bounded = value.bounded && typeof value.bounded === "object" && !Array.isArray(value.bounded)
    ? value.bounded
    : null;
  const state = boundedString(value.state ?? bounded?.state);
  const truncated = typeof value.truncated === "boolean"
    ? value.truncated
    : typeof bounded?.truncated === "boolean" ? bounded.truncated : null;
  const complete = nullableBoolean(value.complete)
    ?? (state === "complete" && truncated !== true ? true : state !== null || truncated !== null ? false : null);
  const status = boundedString(value.status ?? value.outcome ?? value.result)
    ?? (value.isError === true ? "error" : state);
  return {
    name: boundedString(value.name ?? value.toolName ?? value.tool),
    status: status ?? "unknown",
    complete,
    truncated,
    isError: nullableBoolean(value.isError),
    state,
    direction: boundedString(value.direction ?? bounded?.direction),
    limitBytes: nullableNonnegative(value.limitBytes ?? bounded?.limitBytes),
    inputBytes: nullableNonnegative(value.inputBytes ?? bounded?.inputBytes),
    retainedBytes: nullableNonnegative(value.retainedBytes ?? bounded?.retainedBytes),
    omittedBytes: nullableNonnegative(value.omittedBytes ?? bounded?.omittedBytes),
    outputBytes: nullableNonnegative(value.outputBytes ?? bounded?.outputBytes),
    bytes: nullableNonnegative(value.bytes ?? value.outputBytes ?? bounded?.outputBytes ?? bounded?.retainedBytes),
    tokens: nullableNonnegative(value.tokens ?? value.outputTokens ?? bounded?.tokens),
    exitCode: nullableSafeInteger(value.exitCode),
    cancellationScope: boundedString(value.cancellationScope),
  };
}

function normalizeV2ToolOutcomes(record: TraceJsonObject): V2ToolOutcome[] {
  const raw = record.toolOutcomes ?? record.toolResults;
  if (!Array.isArray(raw)) return [];
  const outcomes: V2ToolOutcome[] = [];
  for (const value of raw.slice(0, MAX_REPORT_LIST_ITEMS)) {
    const outcome = normalizeV2ToolOutcome(value);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

function normalizeV2ReclaimReceipt(value: TraceJsonValue): V2ReclaimReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sseq = nullableSafeInteger(value.sourceSseq ?? value.sseq);
  const block = nullableSafeInteger(value.blockIndex);
  return {
    kind: boundedString(value.kind ?? value.action),
    sourceSseq: sseq !== null && sseq >= 0 ? sseq : null,
    blockIndex: block !== null && block >= 0 ? block : null,
    originalBytes: nullableNonnegative(value.originalBytes),
    reclaimedBytes: nullableNonnegative(value.reclaimedBytes),
    reclaimedTokens: nullableNonnegative(value.reclaimedTokens),
    originalHash: boundedString(value.originalHash ?? value.originalSha256 ?? value.contentHash),
    stubHash: boundedString(value.stubHash),
    recovery: boundedString(value.recovery),
    status: boundedString(value.status ?? value.result),
  };
}

function normalizeV2ReclaimEvidence(record: TraceJsonObject): V2ReclaimEvidence | null {
  const raw = record.reclaimEvidence ?? record.reclaim ?? null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawReceipts = Array.isArray(raw.receipts) ? raw.receipts : Array.isArray(raw.targets) ? raw.targets : [];
  const receipts = rawReceipts.slice(0, MAX_REPORT_LIST_ITEMS).map(normalizeV2ReclaimReceipt)
    .filter((receipt): receipt is V2ReclaimReceipt => receipt !== null);
  const targetCount = nullableSafeInteger(raw.targetCount);
  return {
    attempted: nullableBoolean(raw.attempted ?? raw.planned),
    applied: nullableBoolean(raw.applied),
    recovered: nullableBoolean(raw.recovered),
    reclaimedBytes: nullableNonnegative(raw.reclaimedBytes ?? raw.bytes),
    reclaimedTokens: nullableNonnegative(raw.reclaimedTokens ?? raw.tokens),
    targetCount: targetCount !== null && targetCount >= 0 ? targetCount : null,
    receiptCount: Number.isSafeInteger(rawReceipts.length) ? rawReceipts.length : null,
    omittedReceipts: Math.max(0, rawReceipts.length - MAX_REPORT_LIST_ITEMS),
    revisionId: boundedString(raw.revisionId),
    source: boundedString(raw.source),
    error: boundedString(raw.error),
    receipts,
    targets: receipts,
  };
}

function normalizeV2Attempt(record: TraceJsonObject, index: number): V2NormalizedAttempt {
  const cache = record.cache && typeof record.cache === "object" && !Array.isArray(record.cache) ? record.cache : null;
  const usage: V2Usage = { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null };
  const usageFields: V2UsageField[] = ["input", "cacheRead", "cacheWrite", "output", "reasoning"];
  for (const field of usageFields) usage[field] = v2UsageValue(record, field);
  const cost = record.cost && typeof record.cost === "object" && !Array.isArray(record.cost) ? record.cost : null;
  const revisions = record.revisions && typeof record.revisions === "object" && !Array.isArray(record.revisions)
    ? record.revisions
    : null;
  const attemptId = v2RecordId(record, index);
  const unknownReasons = boundedStringArray(cost?.unknownReasons ?? record.unknownReasons);
  const unknownReason = boundedString(cost?.unknownReason ?? record.unknownReason);
  if (unknownReasons.length === 0 && unknownReason !== null) unknownReasons.push(unknownReason);
  const fallbackReason = nonemptyString(record.fallbackReason) ?? nonemptyString(cache?.fallbackReason);
  const effective = normalizeV2Policy(cache?.effective ?? record.effectiveCache);
  const requested = normalizeV2Policy(cache?.requested ?? record.requestedCache);
  const toolNames = boundedStringArray(record.toolNames);
  const effectiveCache = cache?.effective && typeof cache.effective === "object" && !Array.isArray(cache.effective)
    ? cache.effective
    : null;
  const markerPositions = Array.isArray(effectiveCache?.markerPositions)
    ? effectiveCache.markerPositions.filter((position): position is number =>
        typeof position === "number" && Number.isInteger(position) && position >= 0)
    : Array.isArray(cache?.markerPositions)
      ? cache.markerPositions.filter((position): position is number =>
          typeof position === "number" && Number.isInteger(position) && position >= 0)
      : [];
  return {
    id: attemptId,
    runId: nonemptyString(record.runId),
    taskId: v2TaskId(record),
    attemptId,
    parentAttemptId: nonemptyString(record.parentAttemptId),
    retryOfAttemptId: nonemptyString(record.retryOfAttemptId),
    role: nonemptyString(record.role) ?? "unknown",
    provider: nonemptyString(record.provider) ?? "unknown",
    protocol: nonemptyString(record.protocol) ?? "unknown",
    route: nonemptyString(record.route),
    model: nonemptyString(record.model) ?? "unknown",
    taskClass: nonemptyString(record.taskClass),
    requestedEffort: nonemptyString(record.requestedEffort),
    effectiveEffort: nonemptyString(record.effectiveEffort),
    status: nonemptyString(record.status) ?? "unknown",
    retryCount: nullableNonnegative(record.retryCount),
    fallbackReason,
    ttftMs: nullableNonnegative(record.ttftMs),
    turnMs: nullableNonnegative(record.turnMs),
    usage,
    cost: {
      usd: nullableNonnegative(cost ? cost.usd : record.usd),
      source: nonemptyString(cost ? cost.source : record.priceSource),
      version: nonemptyString(cost ? cost.version : record.priceVersion),
      lookedUpAt: nonemptyString(cost ? cost.lookedUpAt : record.priceRetrievedAt),
      knownFields: boundedStringArray(cost?.knownFields),
      unknownFields: boundedStringArray(cost?.unknownFields ?? record.unknownFields),
      unknownReasons,
      components: v2CostComponents({ cost }),
    },
    cache: {
      namespace: nonemptyString(cache?.namespace),
      requested,
      effective,
      markerCount: nullableNonnegative(effectiveCache?.markerCount ?? cache?.markerCount),
      markerPositions,
      rejected: typeof effectiveCache?.rejected === "boolean"
        ? effectiveCache.rejected
        : typeof cache?.rejected === "boolean" ? cache.rejected : null,
      fallbackReason: nonemptyString(effectiveCache?.fallbackReason) ?? fallbackReason,
      cacheKeyHash: nonemptyString(cache?.cacheKeyHash),
      modelSettingsHash: nonemptyString(cache?.modelSettingsHash),
      toolsHash: nonemptyString(cache?.toolsHash),
      stablePrefixHash: nonemptyString(cache?.stablePrefixHash),
      reusablePrefixHash: nonemptyString(cache?.reusablePrefixHash),
      reusablePrefixItems: Number.isSafeInteger(cache?.reusablePrefixItems) ? nullableNonnegative(cache?.reusablePrefixItems) : null,
      comparedPrefixHash: nonemptyString(cache?.comparedPrefixHash),
      comparedPrefixItems: Number.isSafeInteger(cache?.comparedPrefixItems) ? nullableNonnegative(cache?.comparedPrefixItems) : null,
      messagePrefixHash: nonemptyString(cache?.messagePrefixHash),
      workingSetHash: nonemptyString(cache?.workingSetHash),
      workingSetChanged: typeof cache?.workingSetChanged === "boolean" ? cache.workingSetChanged : null,
      retryPromptIdentical: typeof cache?.retryPromptIdentical === "boolean" ? cache.retryPromptIdentical : null,
      codexTurnStateUsed: cache?.codexTurnStateUsed === true,
      missAttribution: normalizeV2Miss(record, cache),
    },
    revisions: {
      count: nullableNonnegative(revisions?.count ?? record.revisions),
      kinds: boundedStringArray(revisions?.kinds),
    },
    toolNames,
    toolOutcomes: normalizeV2ToolOutcomes(record),
    reclaimEvidence: normalizeV2ReclaimEvidence(record),
    sessionLengthBucket: normalizeV2SessionLengthBucket(record),
    wasteTokens: nullableNonnegative(record.wasteTokens),
    wasteCause: nonemptyString(record.wasteCause),
    traceTurn: nullableSafeInteger(record.traceTurn),
  };
}

function v2CacheGroups(
  attempts: V2NormalizedAttempt[],
  field: "provider" | "protocol" | "workingSetChanged",
): Record<string, V2CacheGroup> {
  const groups = new Map<string, V2NormalizedAttempt[]>();
  for (const attempt of attempts) {
    const rawName = field === "workingSetChanged" ? attempt.cache.workingSetChanged : attempt[field];
    const name = typeof rawName === "boolean" ? String(rawName) : nonemptyString(rawName) ?? "unknown";
    const bucket = groups.get(name) ?? [];
    bucket.push(attempt);
    groups.set(name, bucket);
  }
  return Object.fromEntries([...groups]
    .sort(([a], [b]) => compareStable(a, b))
    .map(([name, group]) => {
      const usage = aggregateV2Usage(group);
      return [name, {
        turns: group.length,
        totalInput: usage.cacheShareDenominator.totalInput,
        cacheRead: usage.cacheShareDenominator.cacheRead,
        cachedInputShare: usage.cachedInputShare,
        completeSamples: usage.completeSamples,
        partialSamples: usage.partialSamples,
        unknownSamples: usage.unknownSamples,
      }];
    }));
}

function v2EffectivePolicyKey(attempt: V2NormalizedAttempt): string {
  const mode = attempt.cache.effective.mode ?? "unknown";
  const ttl = attempt.cache.effective.ttlMs === null ? "unknown" : String(attempt.cache.effective.ttlMs);
  return `${mode}/${ttl}`;
}

function aggregateV2Dimension(
  attempts: V2NormalizedAttempt[],
  selector: (attempt: V2NormalizedAttempt) => string | null | undefined,
): Record<string, V2DimensionGroup> {
  const groups = new Map<string, V2NormalizedAttempt[]>();
  for (const attempt of attempts) {
    const name = selector(attempt) ?? "unknown";
    const group = groups.get(name) ?? [];
    group.push(attempt);
    groups.set(name, group);
  }
  return Object.fromEntries([...groups]
    .sort(([a], [b]) => compareStable(a, b))
    .map(([name, group]) => {
      const usage = aggregateV2Usage(group);
      const cost = aggregateV2Cost(group);
      const costDetails = aggregateV2CostDetails(group);
      const taskKeys = new Set(group.map((attempt) => v2CompositeKey(attempt.runId ?? "unknown", attempt.taskId ?? "unknown")));
      return [name, {
        attempts: group.length,
        tasks: taskKeys.size,
        usage,
        cost: { ...cost, ...costDetails },
        cachedInputShare: usage.cachedInputShare,
      }];
    }));
}

function aggregateV2MultiDimension(
  attempts: V2NormalizedAttempt[],
  selector: (attempt: V2NormalizedAttempt) => unknown,
): Record<string, V2DimensionGroup> {
  const groups = new Map<string, V2NormalizedAttempt[]>();
  for (const attempt of attempts) {
    const values = boundedStringArray(selector(attempt));
    for (const value of values) {
      const group = groups.get(value) ?? [];
      group.push(attempt);
      groups.set(value, group);
    }
  }
  return Object.fromEntries([...groups]
    .sort(([a], [b]) => compareStable(a, b))
    .map(([name, group]) => {
      const usage = aggregateV2Usage(group);
      const cost = aggregateV2Cost(group);
      const costDetails = aggregateV2CostDetails(group);
      const taskKeys = new Set(group.map((attempt) => v2CompositeKey(attempt.runId ?? "unknown", attempt.taskId ?? "unknown")));
      return [name, {
        attempts: group.length,
        tasks: taskKeys.size,
        usage,
        cost: { ...cost, ...costDetails },
        cachedInputShare: usage.cachedInputShare,
      }];
    }));
}

function aggregateV2ToolOutcomes(attempts: V2NormalizedAttempt[]) {
  const outcomes = attempts.flatMap((attempt) => attempt.toolOutcomes);
  const incomplete = outcomes.filter((outcome) =>
    outcome.complete === false || outcome.truncated === true ||
    outcome.isError === true ||
    ["truncated", "incomplete", "timeout", "interrupted", "visit-cap", "failed", "error"].includes(outcome.status.toLowerCase()),
  ).length;
  return {
    total: outcomes.length,
    incomplete,
    errors: outcomes.filter((outcome) => outcome.isError === true || ["failed", "error"].includes(outcome.status.toLowerCase())).length,
    unknown: outcomes.filter((outcome) => outcome.status === "unknown").length,
    byName: counts(outcomes.map((outcome) => outcome.name ?? "unknown")),
    byStatus: counts(outcomes.map((outcome) => outcome.status)),
    byState: counts(outcomes.map((outcome) => outcome.state ?? "unknown")),
    boundedBytes: metricFromValues(outcomes.map((outcome) => outcome.bytes)),
    omittedBytes: metricFromValues(outcomes.map((outcome) => outcome.omittedBytes)),
  };
}

function aggregateV2ToolTurnStats(mainAttempts: V2NormalizedAttempt[], calls: number) {
  const toolTurns = mainAttempts.filter((attempt) => attempt.toolNames.length > 0);
  const toolTurnCount = toolTurns.length;
  const singleToolTurns = toolTurns.filter((attempt) => attempt.toolNames.length === 1).length;
  const previousByTask = new Map<string, string[]>();
  let grepThenRead = 0;
  let readThenEdit = 0;
  for (const attempt of mainAttempts) {
    if (attempt.toolNames.length === 0) continue;
    const key = v2CompositeKey(attempt.runId, attempt.taskId);
    const previous = previousByTask.get(key);
    if (previous) {
      if (previous.includes("grep") && attempt.toolNames.includes("read_file")) grepThenRead++;
      if (previous.includes("read_file") && attempt.toolNames.includes("edit")) readThenEdit++;
    }
    previousByTask.set(key, attempt.toolNames);
  }
  return {
    toolTurns: toolTurnCount,
    singleToolTurns,
    parallelToolTurns: toolTurns.filter((attempt) => attempt.toolNames.length >= 2).length,
    singleToolShare: toolTurnCount === 0 ? null : singleToolTurns / toolTurnCount,
    callsPerTurn: toolTurnCount === 0 ? null : calls / toolTurnCount,
    byCount: counts(toolTurns.map((attempt) => String(attempt.toolNames.length))),
    grepThenRead,
    readThenEdit,
    sameTurnReadEdit: toolTurns.filter((attempt) =>
      attempt.toolNames.includes("read_file") && attempt.toolNames.includes("edit")).length,
  };
}

function aggregateV2Reclaim(attempts: V2NormalizedAttempt[]) {
  const evidence = attempts.map((attempt) => attempt.reclaimEvidence).filter((item): item is V2ReclaimEvidence => item !== null);
  const receipts = evidence.flatMap((item) => item.receipts);
  const boolCounts = (field: "attempted" | "applied" | "recovered") => ({
    true: evidence.filter((item) => item[field] === true).length,
    false: evidence.filter((item) => item[field] === false).length,
    unknown: evidence.filter((item) => item[field] === null).length,
  });
  return {
    samples: evidence.length,
    attempted: boolCounts("attempted"),
    applied: boolCounts("applied"),
    recovered: boolCounts("recovered"),
    reclaimedBytes: metricFromValues(evidence.map((item) => item.reclaimedBytes)),
    reclaimedTokens: metricFromValues(evidence.map((item) => item.reclaimedTokens)),
    originalBytes: metricFromValues(receipts.map((receipt) => receipt.originalBytes)),
    targetCount: metricFromValues(evidence.map((item) => item.targetCount)),
    receipts: receipts.length,
    receiptRecords: metricFromValues(evidence.map((item) => item.receiptCount)),
    omittedReceipts: evidence.reduce((sum, item) => sum + item.omittedReceipts, 0),
    byKind: counts(receipts.map((receipt) => receipt.kind ?? "unknown")),
    byRecovery: counts(receipts.map((receipt) => receipt.recovery ?? "unknown")),
  };
}

function v2TaskOutcomeClass(status: string | null, settled: boolean): string {
  if (!settled) return "unsettled";
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  if (normalized === "success" || normalized === "succeeded" || normalized === "ok") return "success";
  if (["failure", "failed", "error"].includes(normalized)) return "failure";
  if (normalized === "interrupted") return "interrupted";
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["storage-error", "storage_error", "storageerror"].includes(normalized)) return "storage-error";
  return "unknown";
}

function aggregateV2BillingAttempts(
  attempts: V2NormalizedAttempt[],
  taskGroups: Map<string, V2TaskGroup>,
  groupPredicate: (group: V2TaskGroup | undefined, attempt: V2NormalizedAttempt | null) => boolean,
  attemptPredicate: (attempt: V2NormalizedAttempt) => boolean = () => true,
  countMatchingGroups = false,
) {
  const selected = attempts.filter((attempt) => {
    const group = taskGroups.get(v2CompositeKey(attempt.runId, attempt.taskId));
    return groupPredicate(group, attempt) && attemptPredicate(attempt);
  });
  const taskKeys = new Set(selected.map((attempt) => v2CompositeKey(attempt.runId ?? "unknown", attempt.taskId ?? "unknown")));
  const matchingGroups = [...taskGroups.values()].filter((group) => groupPredicate(group, null));
  const cost = aggregateV2Cost(selected);
  const costDetails = aggregateV2CostDetails(selected);
  return {
    taskCount: countMatchingGroups ? matchingGroups.length : taskKeys.size,
    attempts: selected.length,
    retries: selected.filter((attempt) => (attempt.retryCount ?? 0) > 0 || attempt.retryOfAttemptId !== null).length,
    fallbacks: selected.filter((attempt) => attempt.fallbackReason !== null).length,
    usage: aggregateV2Usage(selected),
    cost: { ...cost, ...costDetails },
  };
}

function v2Diagnostics(records: TraceRecordList): TraceJsonObject {
  const diagnostics = records?.traceDiagnostics;
  return diagnostics && typeof diagnostics === "object"
    ? { ...diagnostics }
    : {
      retainedRecords: records.length,
      omittedRecords: null,
      writeFailures: null,
      malformedRecords: 0,
      partialRecords: 0,
      retentionFailures: null,
      manifestWriteFailures: null,
      lastTraceTurn: null,
      readerOmittedRecords: 0,
      manifestErrors: 0,
      schemaRecords: { current: records.length },
  };
}

const V2_INTEGRITY_FIELDS = [
  "omittedRecords",
  "writeFailures",
  "malformedRecords",
  "partialRecords",
  "retentionFailures",
  "manifestWriteFailures",
  "readerOmittedRecords",
  "manifestErrors",
];

function v2TraceIntegrity(records: TraceRecordList, diagnostics: TraceJsonObject) {
  if (!records?.traceDiagnostics || typeof records.traceDiagnostics !== "object") {
    return { status: "not-provided", complete: false, reasons: ["reader-diagnostics-not-provided"] };
  }
  const reasons: string[] = [];
  for (const field of V2_INTEGRITY_FIELDS) {
    const value = diagnostics[field];
    const numeric = typeof value === "number" ? value : NaN;
    if (!Number.isSafeInteger(numeric) || numeric < 0) reasons.push(`${field}-unknown`);
    else if (numeric > 0) reasons.push(`${field}>0`);
  }
  const linkIndex = diagnostics.linkIndex && typeof diagnostics.linkIndex === "object" && !Array.isArray(diagnostics.linkIndex)
    ? diagnostics.linkIndex
    : null;
  const linkErrors = linkIndex?.errors;
  const linkPruned = linkIndex?.prunedAttemptsReferenced;
  if (typeof linkErrors === "number" && linkErrors > 0) reasons.push("link-index-errors>0");
  if (typeof linkPruned === "number" && linkPruned > 0) reasons.push("linked-attempts-pruned");
  const uniqueReasons = [...new Set(reasons)].sort(compareStable);
  return {
    status: uniqueReasons.length === 0 ? "complete" : "incomplete",
    complete: uniqueReasons.length === 0,
    reasons: uniqueReasons,
  };
}

function summarizeV2Traces(records: TraceRecordList, label: string) {
  const v2Records = records.filter(isV2Record);
  const rawAttempts = v2Records.filter((record) => record.recordType === "attempt");
  const settlements = v2Records.filter((record) => record.recordType === "task-settled");
  const attempts = rawAttempts.map(normalizeV2Attempt);
  const mainAttempts = attempts.filter((attempt) => attempt.role === "main");
  const summaryAttempts = attempts.filter((attempt) => attempt.role === "summary");
  const settlementByTask = new Map<string, TraceJsonObject>();
  for (const settlement of settlements) {
    settlementByTask.set(v2CompositeKey(settlement.runId, v2TaskId(settlement)), settlement);
  }

  const taskGroups = new Map<string, V2TaskGroup>();
  const ensureTask = (runId: string | null, taskId: string | null): V2TaskGroup => {
    const key = v2CompositeKey(runId, taskId);
    const group = taskGroups.get(key) ?? {
      runId,
      taskId,
      total: 0,
      main: 0,
      summary: 0,
      unknownRole: 0,
      retries: 0,
      fallbacks: 0,
      attemptIds: [],
      finalAttemptId: null,
      settled: false,
      outcomeStatus: null,
      outcomeClass: "unsettled",
      correctness: null,
      taskClass: null,
      sessionLengthBucket: null,
    };
    taskGroups.set(key, group);
    return group;
  };
  for (const attempt of attempts) {
    const group = ensureTask(attempt.runId, attempt.taskId);
    group.total++;
    if (attempt.role === "main") group.main++;
    else if (attempt.role === "summary") group.summary++;
    else group.unknownRole++;
    if ((attempt.retryCount ?? 0) > 0 || attempt.retryOfAttemptId !== null) group.retries++;
    if (attempt.fallbackReason !== null) group.fallbacks++;
    if (group.taskClass === null && attempt.taskClass !== null) group.taskClass = attempt.taskClass;
    if (group.sessionLengthBucket === null && attempt.sessionLengthBucket !== null) {
      group.sessionLengthBucket = attempt.sessionLengthBucket;
    }
    group.attemptIds.push(attempt.attemptId);
  }
  for (const [key, settlement] of settlementByTask) {
    const group = ensureTask(nonemptyString(settlement.runId), v2TaskId(settlement));
    const outcome = settlement.outcome && typeof settlement.outcome === "object" && !Array.isArray(settlement.outcome)
      ? settlement.outcome
      : null;
    group.settled = true;
    group.finalAttemptId = nonemptyString(settlement.finalAttemptId);
    group.outcomeStatus = nonemptyString(outcome?.status);
    group.outcomeClass = v2TaskOutcomeClass(group.outcomeStatus, true);
    group.correctness = nonemptyString(outcome?.correctness);
    group.taskClass = nonemptyString(settlement.taskClass) ?? group.taskClass;
    group.sessionLengthBucket = normalizeV2SessionLengthBucket(settlement) ?? group.sessionLengthBucket;
    if (Array.isArray(settlement.attemptIds)) {
      const ids = settlement.attemptIds.filter((id) => typeof id === "string");
      if (ids.length > group.attemptIds.length) group.attemptIds = ids;
    }
    taskGroups.set(key, group);
  }
  const runIds = new Set([...taskGroups.values()].map((group) => group.runId ?? "unknown"));
  const taskIds = new Map<string, number>();
  for (const group of taskGroups.values()) taskIds.set(group.taskId ?? "unknown", (taskIds.get(group.taskId ?? "unknown") ?? 0) + 1);
  const taskEntries = [...taskGroups.values()].map((group): [string, V2TaskGroup] => {
    const taskId = group.taskId ?? "unknown";
    const key = runIds.size > 1 || (taskIds.get(taskId) ?? 0) > 1
      ? `${group.runId ?? "unknown"}/${taskId}`
      : taskId;
    return [key, group];
  }).sort(([a], [b]) => compareStable(a, b));
  const byTask = Object.fromEntries(taskEntries);
  const attemptIds = new Map<string, number>();
  for (const attempt of attempts) attemptIds.set(attempt.id, (attemptIds.get(attempt.id) ?? 0) + 1);
  const byId = Object.fromEntries(attempts.map((attempt): [string, V2NormalizedAttempt] => {
    const key = runIds.size > 1 || (attemptIds.get(attempt.id) ?? 0) > 1
      ? `${attempt.runId ?? "unknown"}/${attempt.id}`
      : attempt.id;
    return [key, attempt];
  }).sort(([a], [b]) => compareStable(a, b)));
  const taskStatuses = [...taskGroups.values()].filter((group) => group.settled).map((group) => group.outcomeStatus ?? "unknown");
  const rawMainAttempts = rawAttempts.filter((record) => (nonemptyString(record.role) ?? "unknown") === "main");
  const rawSummaryAttempts = rawAttempts.filter((record) => (nonemptyString(record.role) ?? "unknown") === "summary");
  const usageMain = aggregateV2Usage(rawMainAttempts);
  const usageSummary = aggregateV2Usage(rawSummaryAttempts);
  const costMain = aggregateV2Cost(rawMainAttempts);
  const costSummary = aggregateV2Cost(rawSummaryAttempts);
  const costAll = aggregateV2Cost(attempts);
  const costMainDetails = aggregateV2CostDetails(mainAttempts);
  const costSummaryDetails = aggregateV2CostDetails(summaryAttempts);
  const costAllDetails = aggregateV2CostDetails(attempts);
  const tools = mainAttempts.flatMap((attempt) => attempt.toolNames);
  const wasteByCause: Record<string, number> = Object.create(null);
  let wasteUnknownSamples = 0;
  for (const attempt of mainAttempts) {
    if (attempt.wasteTokens === null) {
      wasteUnknownSamples++;
      continue;
    }
    if (attempt.wasteTokens === 0) continue;
    const cause = attempt.wasteCause ?? "unknown";
    wasteByCause[cause] = (wasteByCause[cause] ?? 0) + attempt.wasteTokens;
  }
  const revisions = mainAttempts.reduce((sum, attempt) => sum + (attempt.revisions.count ?? 0), 0);
  const revisionKinds = counts(mainAttempts.flatMap((attempt) => attempt.revisions.kinds));
  const ttft = mainAttempts.map((attempt) => attempt.ttftMs).filter((value): value is number => value !== null);
  const turn = mainAttempts.map((attempt) => attempt.turnMs).filter((value): value is number => value !== null);
  const totalInput = usageMain.input.total + usageMain.cacheRead.total + usageMain.cacheWrite.total;
  const usage = {
    main: usageMain,
    summary: usageSummary,
    input: usageMain.input.total,
    cacheRead: usageMain.cacheRead.total,
    cacheWrite: usageMain.cacheWrite.total,
    output: usageMain.output.total,
    measuredTurns: mainAttempts.filter((record) => record.usage.input !== null || record.usage.output !== null).length,
    missingTurns: mainAttempts.filter((record) => record.usage.input === null && record.usage.output === null).length,
    totalInput,
    cachedInputShare: usageMain.cachedInputShare,
    cold: summarizeCachePhase(rawMainAttempts.slice(0, 1)),
    warm: summarizeCachePhase(rawMainAttempts.slice(1)),
  };
  const cost = {
    main: costMain,
    summary: costSummary,
    all: { ...costAll, ...costAllDetails },
    details: {
      main: costMainDetails,
      summary: costSummaryDetails,
    },
  };
  const groups = {
    byRole: aggregateV2Dimension(attempts, (attempt) => attempt.role),
    byModel: aggregateV2Dimension(attempts, (attempt) => attempt.model),
    byTask: aggregateV2Dimension(attempts, (attempt) => `${attempt.runId ?? "unknown"}/${attempt.taskId ?? "unknown"}`),
    byTaskClass: aggregateV2Dimension(attempts, (attempt) =>
      attempt.taskClass ?? taskGroups.get(v2CompositeKey(attempt.runId, attempt.taskId))?.taskClass),
    byEffectivePolicy: aggregateV2Dimension(attempts, v2EffectivePolicyKey),
    byRoute: aggregateV2Dimension(attempts, (attempt) => attempt.route),
    bySessionLengthBucket: aggregateV2Dimension(attempts, (attempt) => attempt.sessionLengthBucket),
  };
  const settledGroups = [...taskGroups.values()].filter((group) => group.settled);
  const diagnostics = v2Diagnostics(records);
  const integrity = v2TraceIntegrity(records, diagnostics);
  const billing = {
    successfulSettled: aggregateV2BillingAttempts(
      attempts,
      taskGroups,
      (group) => group?.outcomeClass === "success",
      () => true,
      true,
    ),
    failedSettled: aggregateV2BillingAttempts(
      attempts,
      taskGroups,
      (group) => group?.outcomeClass === "failure",
      () => true,
      true,
    ),
    interrupted: aggregateV2BillingAttempts(
      attempts,
      taskGroups,
      (group) => group?.outcomeClass === "interrupted",
      () => true,
      true,
    ),
    cancelled: aggregateV2BillingAttempts(
      attempts,
      taskGroups,
      (group) => group?.outcomeClass === "cancelled",
      () => true,
      true,
    ),
    storageError: aggregateV2BillingAttempts(
      attempts,
      taskGroups,
      (group) => group?.outcomeClass === "storage-error",
      () => true,
      true,
    ),
    unknown: aggregateV2BillingAttempts(
      attempts,
      taskGroups,
      (group) => group?.outcomeClass === "unknown",
      () => true,
      true,
    ),
    unsettled: aggregateV2BillingAttempts(
      attempts,
      taskGroups,
      (group) => group?.outcomeClass === "unsettled",
      () => true,
      true,
    ),
    retries: aggregateV2BillingAttempts(
      attempts,
      taskGroups,
      () => true,
      (attempt) => (attempt.retryCount ?? 0) > 0 || attempt.retryOfAttemptId !== null,
      false,
    ),
  };
  const byProvider = v2CacheGroups(attempts, "provider");
  const byProtocol = v2CacheGroups(attempts, "protocol");
  const byMissPrimary = aggregateV2Dimension(attempts, (attempt) => attempt.cache.missAttribution.primary);
  const byMissContributor = aggregateV2MultiDimension(attempts, (attempt) => attempt.cache.missAttribution.contributing);
  const toolOutcomes = aggregateV2ToolOutcomes(mainAttempts);
  const reclaim = aggregateV2Reclaim(mainAttempts);
  const perTurn: V2PerTurn[] = attempts.map((attempt, index) => {
    const input = attempt.usage.input;
    const cacheRead = attempt.usage.cacheRead;
    const cacheWrite = attempt.usage.cacheWrite;
    return {
      turn: attempt.traceTurn ?? index + 1,
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      role: attempt.role,
      status: attempt.status,
      provider: attempt.provider,
      protocol: attempt.protocol,
      route: attempt.route,
      model: attempt.model,
      sessionLengthBucket: attempt.sessionLengthBucket,
      totalInput: input === null || cacheRead === null || cacheWrite === null
        ? null
        : input + cacheRead + cacheWrite,
      cacheRead,
      cachedInputShare: input !== null && cacheRead !== null && cacheWrite !== null
        ? (() => {
          const total = input + cacheRead + cacheWrite;
          return total > 0 ? cacheRead / total : null;
        })()
        : null,
      cache: attempt.cache,
    };
  });
  const summaryDiagnostics: TraceJsonObject = {
    ...v2Diagnostics(records),
    schemaRecords: { current: v2Records.length },
  };
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    label,
    records: v2Records.length,
    mainTurns: mainAttempts.length,
    summaryCalls: summaryAttempts.length,
    statuses: counts(mainAttempts.map((attempt) => attempt.status)),
    models: counts(mainAttempts.map((attempt) => attempt.model)),
    systemHashes: 0,
    tasks: {
      total: taskGroups.size,
      settled: settledGroups.length,
      successful: settledGroups.filter((group) => group.outcomeClass === "success").length,
      failed: settledGroups.filter((group) => group.outcomeClass === "failure").length,
      interrupted: settledGroups.filter((group) => group.outcomeClass === "interrupted").length,
      cancelled: settledGroups.filter((group) => group.outcomeClass === "cancelled").length,
      storageError: settledGroups.filter((group) => group.outcomeClass === "storage-error").length,
      unknown: settledGroups.filter((group) => group.outcomeClass === "unknown").length,
      unsettled: taskGroups.size - settledGroups.length,
      byStatus: counts(taskStatuses),
      byOutcome: counts([...taskGroups.values()].map((group) => group.outcomeClass)),
      correctness: {
        correct: settledGroups.filter((group) => group.correctness === "correct").length,
        incorrect: settledGroups.filter((group) => group.correctness === "incorrect").length,
        unknown: taskGroups.size - settledGroups.filter((group) => group.correctness === "correct").length - settledGroups.filter((group) => group.correctness === "incorrect").length,
      },
    },
    attempts: {
      total: attempts.length,
      main: mainAttempts.length,
      summary: summaryAttempts.length,
      retries: attempts.filter((attempt) => (attempt.retryCount ?? 0) > 0 || attempt.retryOfAttemptId !== null).length,
      fallbacks: attempts.filter((attempt) => attempt.fallbackReason !== null).length,
      byTask,
      byId,
      perTurn,
    },
    latency: {
      ttftSamples: ttft.length,
      p50TtftMs: percentile(ttft, 0.5),
      p95TtftMs: percentile(ttft, 0.95),
      turnSamples: turn.length,
      p50TurnMs: percentile(turn, 0.5),
      p95TurnMs: percentile(turn, 0.95),
    },
    usage,
    cache: {
      perTurn,
      byProvider,
      byProtocol,
      byWorkingSetChange: v2CacheGroups(attempts, "workingSetChanged"),
      byMissPrimary,
      byMissContributor,
      idleGaps: summarizeIdleGaps(mainAttempts),
    },
    cost,
    waste: {
      tokens: Object.values(wasteByCause).reduce((sum, value) => sum + value, 0),
      unknownSamples: wasteUnknownSamples,
      byCause: Object.fromEntries(Object.entries(wasteByCause).sort(([a], [b]) => compareStable(a, b))),
    },
    revisions,
    revisionKinds,
    tools: {
      calls: tools.length,
      byName: counts(tools),
      outcomes: toolOutcomes,
      ...aggregateV2ToolTurnStats(mainAttempts, tools.length),
    },
    reclaim,
    integrity,
    billing,
    groups,
    byRole: groups.byRole,
    byModel: groups.byModel,
    byTask: groups.byTask,
    byTaskClass: groups.byTaskClass,
    byEffectivePolicy: groups.byEffectivePolicy,
    byRoute: groups.byRoute,
    bySessionLengthBucket: groups.bySessionLengthBucket,
    byMissPrimary,
    byMissContributor,
    diagnostics: summaryDiagnostics,
  };
}

export function summarizeTraces(records: TraceRecordList, label = "traces") {
  if (!records.every(isV2Record)) throw new Error("trace records must use the current schema");
  return summarizeV2Traces(records, label);
}

function formatMs(value: number | null): string {
  return value === null ? "--" : `${(value / 1000).toFixed(2)}s`;
}

function formatShare(value: number | null): string {
  return value === null ? "--" : `${(value * 100).toFixed(1)}%`;
}

function formatCallsPerTurn(value: number | null): string {
  return value === null ? "--" : String(Number(value.toFixed(2)));
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCounts(value: Record<string, number>): string {
  const entries = Object.entries(value);
  return entries.length ? entries.map(([name, count]) => `${name}=${count}`).join(", ") : "none";
}

function formatCacheTurns(turns: V2PerTurn[]): string {
  const shown = turns.slice(-100);
  const prefix = turns.length > shown.length ? `${turns.length - shown.length} earlier turns omitted; ` : "";
  const values = shown.map((turn) => {
    const share = turn.cachedInputShare === null ? "--" : `${(turn.cachedInputShare * 100).toFixed(1)}%`;
    return `${turn.turn}=${share}`;
  }).join(", ");
  return `${prefix}${values || "none"}`;
}

function formatCacheGroups(groups: Record<string, V2CacheGroup>): string {
  return Object.entries(groups).map(([name, group]) => {
    const share = group.cachedInputShare === null ? "--" : `${(group.cachedInputShare * 100).toFixed(1)}%`;
    return `${name}=${share}`;
  }).join(", ") || "none";
}

function formatV2Metric(metric: V2UsageMetric): string {
  return `${formatInt(metric.total)} (${metric.knownSamples} known, ${metric.unknownSamples} unknown)`;
}

type V2TraceSummary = ReturnType<typeof summarizeV2Traces>;

/** Pre-schema-v2 summaries; no in-repo producer remains, but the formatter still accepts them. */
type LegacyTraceSummary = {
  schemaVersion: number;
  label: string;
  mainTurns: number;
  summaryCalls: number;
  statuses: Record<string, number>;
  latency: { p50TtftMs: number | null; p95TtftMs: number | null; p50TurnMs: number | null; p95TurnMs: number | null };
  usage: {
    cachedInputShare: number | null;
    totalInput: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    missingTurns: number;
  };
  cost: { usd: number; measuredTurns: number };
  waste: { tokens: number; byCause: Record<string, number> };
  tools: { calls: number };
  revisions: number;
  systemHashes: number;
  cache: {
    perTurn: V2PerTurn[];
    byProvider: Record<string, V2CacheGroup>;
    byProtocol: Record<string, V2CacheGroup>;
    byWorkingSetChange: Record<string, V2CacheGroup>;
    byCacheKeyChange: Record<string, V2CacheGroup>;
    byModelSettingsChange: Record<string, V2CacheGroup>;
    byToolsChange: Record<string, V2CacheGroup>;
    byStablePrefixChange: Record<string, V2CacheGroup>;
  };
};

function formatV2TraceSummary(summary: V2TraceSummary, sourceErrors: TraceFileError[] = []): string {
  const main = summary.usage.main;
  const cache = main.cachedInputShare === null ? "--" : `${(main.cachedInputShare * 100).toFixed(1)}%`;
  const diagnostics = summary.diagnostics;
  const linkIndex = diagnostics.linkIndex && typeof diagnostics.linkIndex === "object" && !Array.isArray(diagnostics.linkIndex)
    ? diagnostics.linkIndex
    : null;
  const prunedAttempts = linkIndex?.prunedAttemptsReferenced;
  const lines = [
    summary.label,
    `  tasks: ${summary.tasks.total} total, ${summary.tasks.settled} settled (${summary.tasks.successful} success, ${summary.tasks.failed} failure); attempts: ${summary.attempts.total} (${summary.attempts.retries} retries, ${summary.attempts.fallbacks} fallbacks)`,
    `  turns: ${summary.mainTurns} main, ${summary.summaryCalls} summary (${formatCounts(summary.statuses)})`,
    `  latency: TTFT p50 ${formatMs(summary.latency.p50TtftMs)}, p95 ${formatMs(summary.latency.p95TtftMs)}; turn p50 ${formatMs(summary.latency.p50TurnMs)}, p95 ${formatMs(summary.latency.p95TurnMs)}`,
    `  tokens: input ${formatV2Metric(main.input)}, cache-read ${formatV2Metric(main.cacheRead)}, cache-write ${formatV2Metric(main.cacheWrite)}, output ${formatV2Metric(main.output)}, reasoning ${formatV2Metric(main.reasoning)}; cache ${cache}`,
    `  cost: $${summary.cost.main.totalUsd.toFixed(6)} (${summary.cost.main.knownSamples}/${summary.attempts.main} main attempts measured)`,
    `  diagnostics: integrity=${summary.integrity.status}, retained=${diagnostics.retainedRecords ?? "--"}, omitted=${diagnostics.omittedRecords ?? "--"}, partial=${diagnostics.partialRecords ?? "--"}, malformed=${diagnostics.malformedRecords ?? "--"}, retention-failures=${diagnostics.retentionFailures ?? "--"}, write-failures=${diagnostics.writeFailures ?? "--"}, manifest-write-failures=${diagnostics.manifestWriteFailures ?? "--"}`,
    `  efficiency: ${summary.tools.calls} tool calls, ${summary.revisions} revisions`,
    `  tool turns: ${summary.tools.toolTurns} (${formatShare(summary.tools.singleToolShare)} single, mean ${formatCallsPerTurn(summary.tools.callsPerTurn)} calls/turn); adjacent grep→read ${summary.tools.grepThenRead}, read→edit ${summary.tools.readThenEdit}; same-turn read+edit ${summary.tools.sameTurnReadEdit}`,
  ];
  if (typeof prunedAttempts === "number" && prunedAttempts > 0) {
    lines.push(`  linked attempts: ${prunedAttempts} not loaded (indexed identity only; metrics remain incomplete)`);
  }
  if (sourceErrors.length > 0) lines.push(`  warning: ${sourceErrors.length} trace files could not be read`);
  return lines.join("\n");
}

export function formatTraceSummary(
  summary: V2TraceSummary | LegacyTraceSummary,
  sourceErrors: TraceFileError[] = [],
): string {
  if (summary.schemaVersion === TRACE_SCHEMA_VERSION) return formatV2TraceSummary(summary as V2TraceSummary, sourceErrors);
  const legacy = summary as LegacyTraceSummary;
  const cache = legacy.usage.cachedInputShare === null ? "--" : `${(legacy.usage.cachedInputShare * 100).toFixed(1)}%`;
  const lines = [
    legacy.label,
    `  turns: ${legacy.mainTurns} main, ${legacy.summaryCalls} summary (${formatCounts(legacy.statuses)})`,
    `  latency: TTFT p50 ${formatMs(legacy.latency.p50TtftMs)}, p95 ${formatMs(legacy.latency.p95TtftMs)}; turn p50 ${formatMs(legacy.latency.p50TurnMs)}, p95 ${formatMs(legacy.latency.p95TurnMs)}`,
    `  tokens: ${formatInt(legacy.usage.totalInput)} in (${formatInt(legacy.usage.cacheRead)} read, ${formatInt(legacy.usage.cacheWrite)} write), ${formatInt(legacy.usage.output)} out; cache ${cache}`,
    `  cost: $${legacy.cost.usd.toFixed(6)} (${legacy.cost.measuredTurns}/${legacy.mainTurns} turns measured)`,
    `  waste: ${formatInt(legacy.waste.tokens)} (${formatCounts(legacy.waste.byCause)})`,
    `  efficiency: ${legacy.tools.calls} tool calls, ${legacy.revisions} revisions; systems=${legacy.systemHashes}`,
    `  cache by turn: ${formatCacheTurns(legacy.cache.perTurn)}`,
    `  cache correlation: provider [${formatCacheGroups(legacy.cache.byProvider)}]; protocol [${formatCacheGroups(legacy.cache.byProtocol)}]; working-set-changed [${formatCacheGroups(legacy.cache.byWorkingSetChange)}]`,
    `  cache changes: key [${formatCacheGroups(legacy.cache.byCacheKeyChange)}]; settings [${formatCacheGroups(legacy.cache.byModelSettingsChange)}]; tools [${formatCacheGroups(legacy.cache.byToolsChange)}]; stable-prefix [${formatCacheGroups(legacy.cache.byStablePrefixChange)}]`,
  ];
  if (legacy.usage.missingTurns > 0) lines.push(`  warning: usage missing for ${legacy.usage.missingTurns} main turns`);
  if (sourceErrors.length > 0) lines.push(`  warning: ${sourceErrors.length} trace files could not be read`);
  return lines.join("\n");
}

function defaultDirectories(env: NodeJS.ProcessEnv): string[] {
  const events = env.TERMINA_EVENTS_DIR;
  const terminal = env.TERMINA_TERMINAL_ID;
  if (!events) return [];
  if (terminal) return [join(events, `${terminal}.traces`)];
  if (!existsSync(events)) return [];
  return readdirSync(events)
    .filter((name) => name.endsWith(".traces"))
    .map((name) => join(events, name));
}

function usage() {
  return "usage: pnpm run report:agent-core -- [--json] [trace-directory ...]";
}

export function run(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
  const json = argv.includes("--json");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const unknown = argv.filter((arg) => arg.startsWith("-") && arg !== "--json");
  if (unknown.length) {
    console.error(`unknown option: ${unknown[0]}\n${usage()}`);
    return 2;
  }
  const paths = argv.filter((arg) => !arg.startsWith("-"));
  const directories = paths.length ? paths : defaultDirectories(env);
  if (directories.length === 0) {
    console.error(`no trace directory found\n${usage()}`);
    return 1;
  }
  const reports: Array<{ directory: string; summary: V2TraceSummary; errors: TraceFileError[] }> = [];
  for (const directory of directories) {
    try {
      const source = readTraceDirectory(directory);
      if (source.matchedFiles === 0) {
        console.error(`no turn trace files found: ${source.directory}`);
        continue;
      }
      reports.push({
        directory: source.directory,
        summary: summarizeTraces(source.records, basename(source.directory)),
        errors: source.errors,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  if (reports.length === 0) return 1;
  if (json) {
    console.log(JSON.stringify({ reports }, null, 2));
  } else {
    console.log(reports.map((report) => formatTraceSummary(report.summary, report.errors)).join("\n\n"));
  }
  return 0;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) process.exitCode = run();
