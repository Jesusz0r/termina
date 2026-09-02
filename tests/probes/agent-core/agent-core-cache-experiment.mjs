#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readTraceDirectory } from "./agent-core-trace-report.mjs";

const SCHEMA_VERSION = 1;
const TRACE_SCHEMA_VERSION = 2;
const DEFAULT_TTL_BUCKETS = [
  { label: "0-300000", minMs: 0, maxMs: 300_000 },
  { label: "300000-600000", minMs: 300_000, maxMs: 600_000 },
  { label: "600000+", minMs: 600_000, maxMs: null },
];
const UNKNOWN_RETENTION_BUCKET = "unknown-retention";
const UNKNOWN_GAP_BUCKET = "unknown-gap";
const RATE_PER_MILLION = 1_000_000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeTimestamp(value) {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? new Date(parsed).toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 100_000_000_000) {
    return new Date(value).toISOString();
  }
  return null;
}

function stableCompare(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function sortedObject(entries) {
  return Object.fromEntries(entries.sort(([left], [right]) => stableCompare(left, right)));
}

function recordTimeMs(record) {
  for (const field of ["atMs", "startedAtMs", "timestampMs", "timeMs", "turnStartedAtMs"]) {
    const value = finiteNonnegative(record?.[field]);
    if (value !== null) return value;
  }
  for (const field of ["at", "startedAt", "timestamp", "createdAt", "retrievedAt"]) {
    const normalized = normalizeTimestamp(record?.[field]);
    if (normalized !== null) return Date.parse(normalized);
  }
  return null;
}

function absoluteRecordTimeMs(record) {
  for (const field of ["startedAt", "timestamp", "createdAt", "at", "occurredAt"]) {
    const normalized = normalizeTimestamp(record?.[field]);
    if (normalized !== null) return Date.parse(normalized);
  }
  for (const field of ["startedAtMs", "timestampMs", "createdAtMs", "occurredAtMs", "atMs"]) {
    const value = finiteNonnegative(record?.[field]);
    // Relative monotonic clocks are useful for TTL gaps but cannot establish
    // whether an epoch-timestamped rate snapshot existed at attempt time.
    if (value !== null && value >= 100_000_000_000) return value;
  }
  return null;
}

function traceOrder(record) {
  const turn = Number.isSafeInteger(record?.traceTurn) && record.traceTurn >= 0 ? record.traceTurn : null;
  const storage = Array.isArray(record?.storageSeqRange) && Number.isSafeInteger(record.storageSeqRange[0])
    ? record.storageSeqRange[0]
    : null;
  return {
    timeMs: recordTimeMs(record),
    traceTurn: turn,
    storageSeq: storage,
    runId: nonempty(record?.runId) ?? "",
    taskId: nonempty(record?.taskId) ?? "",
    role: nonempty(record?.role) ?? "",
    attemptId: nonempty(record?.attemptId) ?? "",
  };
}

function compareTraceRecords(left, right) {
  const a = traceOrder(left);
  const b = traceOrder(right);
  for (const [leftValue, rightValue] of [
    [a.timeMs, b.timeMs],
    [a.traceTurn, b.traceTurn],
    [a.storageSeq, b.storageSeq],
  ]) {
    if (leftValue === null && rightValue !== null) return 1;
    if (leftValue !== null && rightValue === null) return -1;
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) return leftValue - rightValue;
  }
  for (const [leftValue, rightValue] of [
    [a.runId, b.runId],
    [a.taskId, b.taskId],
    [a.role, b.role],
    [a.attemptId, b.attemptId],
  ]) {
    const result = stableCompare(leftValue, rightValue);
    if (result !== 0) return result;
  }
  return 0;
}

function compositeKey(runId, taskId) {
  return `${runId ?? "unknown"}\u0000${taskId ?? "unknown"}`;
}

function usageFromRecord(record) {
  const usage = isObject(record?.usage) ? record.usage : null;
  const pick = (name, ...aliases) => {
    if (!usage) return null;
    for (const field of [name, ...aliases]) {
      if (Object.hasOwn(usage, field)) return finiteNonnegative(usage[field]);
    }
    return null;
  };
  return {
    input: pick("input", "input_tokens", "prompt_tokens"),
    cacheRead: pick("cacheRead", "cache_read_input_tokens", "cached_tokens"),
    cacheWrite: pick("cacheWrite", "cache_creation_input_tokens", "cache_write_tokens"),
    output: pick("output", "output_tokens", "completion_tokens"),
    reasoning: pick("reasoning", "reasoning_tokens", "thoughtsTokenCount"),
  };
}

function completeInputUsage(usage) {
  return usage.input !== null && usage.cacheRead !== null && usage.cacheWrite !== null
    ? usage.input + usage.cacheRead + usage.cacheWrite
    : null;
}

function normalizePositions(value) {
  if (!Array.isArray(value)) return null;
  const positions = value.filter((item) => Number.isSafeInteger(item) && item >= 0);
  return [...new Set(positions)].sort((left, right) => left - right);
}

function normalizePolicy(value) {
  const policy = isObject(value) ? value : {};
  return {
    mode: nonempty(policy.mode),
    ttlMs: finiteNonnegative(policy.ttlMs),
    markerCount: finiteNonnegative(policy.markerCount),
    markerPositions: normalizePositions(policy.markerPositions),
    rejected: typeof policy.rejected === "boolean" ? policy.rejected : null,
    fallbackReason: nonempty(policy.fallbackReason),
    eligibleBlockCount: finiteNonnegative(policy.eligibleBlockCount),
    blocksAddedSincePrior: finiteNonnegative(policy.blocksAddedSincePrior),
    retentionKnown: typeof policy.retentionKnown === "boolean" ? policy.retentionKnown : null,
  };
}

function normalizeCache(record) {
  const cache = isObject(record?.cache) ? record.cache : {};
  const effective = normalizePolicy(cache.effective ?? record?.effectiveCache);
  const requested = normalizePolicy(cache.requested ?? record?.requestedCache);
  const topPositions = normalizePositions(cache.markerPositions ?? record?.markerPositions);
  if (effective.markerPositions === null && topPositions !== null) effective.markerPositions = topPositions;
  if (effective.markerCount === null && effective.markerPositions !== null) effective.markerCount = effective.markerPositions.length;
  return {
    namespace: nonempty(cache.namespace),
    effective,
    requested,
    markerPositions: effective.markerPositions ?? topPositions,
    retryPromptIdentical: typeof cache.retryPromptIdentical === "boolean" ? cache.retryPromptIdentical : null,
    fallbackReason: nonempty(cache.fallbackReason) ?? nonempty(record?.fallbackReason),
    cacheKeyHash: nonempty(cache.cacheKeyHash),
    modelSettingsHash: nonempty(cache.modelSettingsHash),
    toolsHash: nonempty(cache.toolsHash),
    stablePrefixHash: nonempty(cache.stablePrefixHash),
    messagePrefixHash: nonempty(cache.messagePrefixHash),
    workingSetHash: nonempty(cache.workingSetHash),
    workingSetChanged: typeof cache.workingSetChanged === "boolean" ? cache.workingSetChanged : null,
    retentionKnown: typeof cache.retentionKnown === "boolean"
      ? cache.retentionKnown
      : effective.retentionKnown,
    eligibleBlockCount: finiteNonnegative(effective.eligibleBlockCount ?? cache.eligibleBlockCount ?? record?.eligibleBlockCount),
    blocksAddedSincePrior: finiteNonnegative(cache.blocksAddedSincePrior ?? record?.blocksAddedSincePrior),
  };
}

function variantFromRecord(record) {
  return nonempty(record?.variant)
    ?? nonempty(record?.runVariant)
    ?? nonempty(record?.experimentVariant)
    ?? nonempty(record?.metadata?.variant)
    ?? nonempty(record?.experiment?.variant);
}

function corpusFromRecord(record) {
  return {
    id: nonempty(record?.corpusId)
      ?? nonempty(record?.corpus)
      ?? nonempty(record?.metadata?.corpusId)
      ?? nonempty(record?.taskClass),
    source: nonempty(record?.corpusId)
      ? "corpusId"
      : nonempty(record?.corpus)
        ? "corpus"
        : nonempty(record?.metadata?.corpusId)
          ? "metadata.corpusId"
          : nonempty(record?.taskClass)
            ? "taskClass"
            : null,
  };
}

function normalizeCost(record) {
  const cost = isObject(record?.cost) ? record.cost : null;
  const usd = finiteNonnegative(cost?.usd ?? (cost && Object.hasOwn(cost, "usd") ? null : record?.usd));
  return {
    usd,
    source: nonempty(cost?.source) ?? nonempty(record?.priceSource),
    version: nonempty(cost?.version) ?? nonempty(record?.priceVersion),
    retrievedAt: normalizeTimestamp(cost?.lookedUpAt) ?? normalizeTimestamp(cost?.retrievedAt) ?? normalizeTimestamp(record?.priceRetrievedAt),
  };
}

function normalizeAttempt(record) {
  if (!isObject(record) || record.schemaVersion !== TRACE_SCHEMA_VERSION || record.recordType !== "attempt") return null;
  const runId = nonempty(record.runId);
  const taskId = nonempty(record.taskId);
  const attemptId = nonempty(record.attemptId);
  if (!runId || !taskId || !attemptId) return null;
  const corpus = corpusFromRecord(record);
  return {
    raw: record,
    runId,
    taskId,
    attemptId,
    role: nonempty(record.role) ?? "unknown",
    provider: nonempty(record.provider) ?? "unknown",
    protocol: nonempty(record.protocol) ?? "unknown",
    route: nonempty(record.route) ?? `${nonempty(record.provider) ?? "unknown"}/${nonempty(record.protocol) ?? "unknown"}`,
    model: nonempty(record.model) ?? "unknown",
    taskClass: nonempty(record.taskClass),
    corpusId: corpus.id,
    corpusSource: corpus.source,
    variant: variantFromRecord(record),
    status: nonempty(record.status) ?? "unknown",
    atMs: recordTimeMs(record),
    observedAtMs: absoluteRecordTimeMs(record),
    traceTurn: Number.isSafeInteger(record.traceTurn) ? record.traceTurn : null,
    usage: usageFromRecord(record),
    cost: normalizeCost(record),
    cache: normalizeCache(record),
    ttftMs: finiteNonnegative(record.ttftMs),
    turnMs: finiteNonnegative(record.turnMs),
  };
}

function normalizeSettlement(record) {
  if (!isObject(record) || record.schemaVersion !== TRACE_SCHEMA_VERSION || record.recordType !== "task-settled") return null;
  const runId = nonempty(record.runId);
  const taskId = nonempty(record.taskId);
  if (!runId || !taskId) return null;
  const outcome = isObject(record.outcome) ? record.outcome : {};
  const corpus = corpusFromRecord(record);
  return {
    runId,
    taskId,
    corpusId: corpus.id,
    corpusSource: corpus.source,
    status: nonempty(outcome.status),
    correctness: nonempty(outcome.correctness),
    finalAttemptId: nonempty(record.finalAttemptId),
    attemptIds: Array.isArray(record.attemptIds) ? record.attemptIds.filter((id) => typeof id === "string") : [],
    summaryAttemptIds: Array.isArray(record.summaryAttemptIds) ? record.summaryAttemptIds.filter((id) => typeof id === "string") : [],
  };
}

function normalizeRecords(records) {
  const attempts = [];
  const settlements = [];
  const invalidRecords = [];
  const attemptKeys = new Set();
  const settlementKeys = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    const identity = {
      schemaVersion: isObject(record) ? record.schemaVersion ?? null : null,
      recordType: isObject(record) ? nonempty(record.recordType) : null,
      runId: isObject(record) ? nonempty(record.runId) : null,
      taskId: isObject(record) ? nonempty(record.taskId) : null,
      attemptId: isObject(record) ? nonempty(record.attemptId) : null,
    };
    if (!isObject(record)) {
      invalidRecords.push({ ...identity, reason: "record-is-not-an-object" });
      continue;
    }
    if (record.schemaVersion !== TRACE_SCHEMA_VERSION) {
      invalidRecords.push({ ...identity, reason: "unsupported-trace-schema" });
      continue;
    }
    if (record.recordType === "attempt") {
      const attempt = normalizeAttempt(record);
      if (attempt) attempts.push(attempt);
      else invalidRecords.push({ ...identity, reason: "attempt-missing-required-identity" });
      continue;
    }
    if (record.recordType === "task-settled") {
      const settlement = normalizeSettlement(record);
      if (settlement) settlements.push(settlement);
      else invalidRecords.push({ ...identity, reason: "settlement-missing-required-identity" });
      continue;
    }
    invalidRecords.push({ ...identity, reason: "unsupported-record-type" });
  }
  const uniqueAttempts = [];
  for (const attempt of attempts) {
    const key = `${attempt.runId}\u0000${attempt.attemptId}`;
    if (attemptKeys.has(key)) {
      invalidRecords.push({ schemaVersion: TRACE_SCHEMA_VERSION, recordType: "attempt", runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId, reason: "duplicate-attempt-id" });
      continue;
    }
    attemptKeys.add(key);
    uniqueAttempts.push(attempt);
  }
  attempts.length = 0;
  attempts.push(...uniqueAttempts);
  const uniqueSettlements = [];
  for (const settlement of settlements) {
    const key = compositeKey(settlement.runId, settlement.taskId);
    if (settlementKeys.has(key)) {
      invalidRecords.push({ schemaVersion: TRACE_SCHEMA_VERSION, recordType: "task-settled", runId: settlement.runId, taskId: settlement.taskId, attemptId: null, reason: "duplicate-task-settled-record" });
      continue;
    }
    settlementKeys.add(key);
    uniqueSettlements.push(settlement);
  }
  settlements.length = 0;
  settlements.push(...uniqueSettlements);
  const attemptsByKey = new Map(attempts.map((attempt) => [`${attempt.runId}\u0000${attempt.attemptId}`, attempt]));
  const validSettlements = [];
  for (const settlement of settlements) {
    const ids = settlement.attemptIds;
    const summaryIds = settlement.summaryAttemptIds;
    const idSet = new Set(ids);
    let reason = null;
    if (idSet.size !== ids.length) reason = "settlement-attempt-ids-not-unique";
    if (!reason && ids.some((id) => {
      const attempt = attemptsByKey.get(`${settlement.runId}\u0000${id}`);
      return !attempt || attempt.taskId !== settlement.taskId;
    })) reason = "settlement-attempt-reference-invalid";
    if (!reason && summaryIds.some((id) => {
      const attempt = attemptsByKey.get(`${settlement.runId}\u0000${id}`);
      return !idSet.has(id) || !attempt || attempt.taskId !== settlement.taskId || attempt.role !== "summary";
    })) reason = "settlement-summary-reference-invalid";
    if (!reason && settlement.finalAttemptId !== null && !idSet.has(settlement.finalAttemptId)) reason = "settlement-final-attempt-invalid";
    if (reason) {
      invalidRecords.push({ schemaVersion: TRACE_SCHEMA_VERSION, recordType: "task-settled", runId: settlement.runId, taskId: settlement.taskId, attemptId: settlement.finalAttemptId, reason });
    } else {
      validSettlements.push(settlement);
    }
  }
  settlements.length = 0;
  settlements.push(...validSettlements);
  attempts.sort(compareNormalizedAttempts);
  settlements.sort((left, right) => stableCompare(compositeKey(left.runId, left.taskId), compositeKey(right.runId, right.taskId)));
  invalidRecords.sort((left, right) => {
    for (const [a, b] of [[left.reason, right.reason], [left.runId ?? "", right.runId ?? ""], [left.taskId ?? "", right.taskId ?? ""], [left.attemptId ?? "", right.attemptId ?? ""]]) {
      const result = stableCompare(a, b);
      if (result !== 0) return result;
    }
    return 0;
  });
  return { attempts, settlements, invalidRecords };
}

function compareNormalizedAttempts(left, right) {
  return compareTraceRecords(left.raw, right.raw);
}

function groupAttempts(attempts, selector) {
  const groups = new Map();
  for (const attempt of attempts) {
    const name = selector(attempt) ?? "unknown";
    const group = groups.get(name) ?? [];
    group.push(attempt);
    groups.set(name, group);
  }
  return [...groups.entries()].sort(([left], [right]) => stableCompare(left, right));
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function usageAggregate(attempts) {
  const fields = ["input", "cacheRead", "cacheWrite", "output", "reasoning"];
  const result = {};
  for (const field of fields) {
    const values = attempts.map((attempt) => attempt.usage[field]).filter((value) => value !== null);
    result[field] = {
      total: values.reduce((sum, value) => sum + value, 0),
      knownSamples: values.length,
      unknownSamples: attempts.length - values.length,
    };
  }
  const complete = attempts.filter((attempt) => completeInputUsage(attempt.usage) !== null);
  const input = complete.reduce((sum, attempt) => sum + attempt.usage.input, 0);
  const cacheRead = complete.reduce((sum, attempt) => sum + attempt.usage.cacheRead, 0);
  const cacheWrite = complete.reduce((sum, attempt) => sum + attempt.usage.cacheWrite, 0);
  const denominator = input + cacheRead + cacheWrite;
  result.completeSamples = complete.length;
  result.partialSamples = attempts.filter((attempt) => {
    const values = [attempt.usage.input, attempt.usage.cacheRead, attempt.usage.cacheWrite];
    return values.some((value) => value !== null) && values.some((value) => value === null);
  }).length;
  result.unknownSamples = attempts.filter((attempt) => [attempt.usage.input, attempt.usage.cacheRead, attempt.usage.cacheWrite].every((value) => value === null)).length;
  result.cacheShareDenominator = {
    input,
    cacheRead,
    cacheWrite,
    totalInput: denominator,
    knownSamples: complete.length,
  };
  result.cachedInputShare = denominator > 0 ? cacheRead / denominator : null;
  return result;
}

function normalizeRateNumber(value, unit) {
  const number = finiteNonnegative(value);
  if (number === null) return null;
  if (unit === "usd-per-million-tokens" || unit === "per-million-tokens" || unit === "perMillionTokens") return number / RATE_PER_MILLION;
  return number;
}

function normalizeRateSnapshot(snapshot) {
  if (!isObject(snapshot)) return null;
  const nested = isObject(snapshot.rates) ? snapshot.rates : snapshot;
  const unit = nested.unit ?? snapshot.unit;
  const field = (name, ...aliases) => {
    for (const key of [name, ...aliases]) {
      if (Object.hasOwn(nested, key)) return normalizeRateNumber(nested[key], unit);
      if (Object.hasOwn(snapshot, key)) return normalizeRateNumber(snapshot[key], unit);
    }
    return null;
  };
  const retrievedAt = normalizeTimestamp(snapshot.retrievedAt)
    ?? normalizeTimestamp(snapshot.lookedUpAt)
    ?? normalizeTimestamp(snapshot.timestamp);
  return {
    source: nonempty(snapshot.source),
    version: nonempty(snapshot.version),
    retrievedAt,
    provider: nonempty(snapshot.provider),
    protocol: nonempty(snapshot.protocol),
    route: nonempty(snapshot.route),
    model: nonempty(snapshot.model),
    role: nonempty(snapshot.role),
    inputPerToken: field("inputPerToken", "input", "input_rate"),
    outputPerToken: field("outputPerToken", "output", "output_rate"),
    cacheReadPerToken: field("cacheReadPerToken", "cacheRead", "cache_read", "cache_read_rate"),
    cacheWritePerToken: field("cacheWritePerToken", "cacheWrite", "cache_write", "cache_write_rate"),
    storagePerTokenHour: field("storagePerTokenHour", "storage", "storage_rate", "storage_per_token_hour"),
  };
}

function rateSnapshotSpecificity(snapshot, attempt) {
  let score = 0;
  for (const field of ["provider", "protocol", "route", "model", "role"]) {
    if (snapshot[field] === null) continue;
    if (snapshot[field] !== attempt[field]) return -1;
    score++;
  }
  return score;
}

function rateAvailableAtAttempt(snapshot, attempt) {
  if (snapshot.retrievedAt === null) return false;
  if (attempt.observedAtMs === null) return false;
  const retrievedAtMs = Date.parse(snapshot.retrievedAt);
  return Number.isFinite(retrievedAtMs) && retrievedAtMs <= attempt.observedAtMs;
}

function traceCostAvailableAtAttempt(attempt) {
  if (attempt.cost.retrievedAt === null || attempt.observedAtMs === null) return false;
  const retrievedAtMs = Date.parse(attempt.cost.retrievedAt);
  return Number.isFinite(retrievedAtMs) && retrievedAtMs <= attempt.observedAtMs;
}

function chooseRateSnapshot(attempt, snapshots) {
  const candidates = snapshots
    .map((snapshot) => ({ snapshot, specificity: rateSnapshotSpecificity(snapshot, attempt) }))
    .filter((item) => item.specificity >= 0 && rateAvailableAtAttempt(item.snapshot, attempt))
    .sort((left, right) => {
      if (left.specificity !== right.specificity) return right.specificity - left.specificity;
      const date = stableCompare(right.snapshot.retrievedAt, left.snapshot.retrievedAt);
      if (date !== 0) return date;
      const source = stableCompare(left.snapshot.source ?? "", right.snapshot.source ?? "");
      if (source !== 0) return source;
      return stableCompare(left.snapshot.version ?? "", right.snapshot.version ?? "");
    });
  return candidates[0]?.snapshot ?? null;
}

function requiredRateFieldsKnown(snapshot) {
  return snapshot !== null && snapshot.source !== null && snapshot.retrievedAt !== null && snapshot.inputPerToken !== null
    && snapshot.cacheReadPerToken !== null && snapshot.cacheWritePerToken !== null && snapshot.outputPerToken !== null;
}

function storageCostForAttempt(attempt, snapshot) {
  if (snapshot === null) return { usd: null, known: false, reason: "missing-rate-snapshot" };
  if (snapshot.storagePerTokenHour === null) return { usd: null, known: false, reason: "missing-storage-rate" };
  if (attempt.usage.cacheWrite === null) return { usd: null, known: false, reason: "missing-cache-write" };
  if (snapshot.storagePerTokenHour === 0 || attempt.usage.cacheWrite === 0) {
    return { usd: 0, known: true, reason: null };
  }
  const ttlMs = attempt.cache.effective.ttlMs ?? attempt.cache.requested.ttlMs;
  if (ttlMs === null) return { usd: null, known: false, reason: "missing-storage-ttl" };
  return {
    usd: attempt.usage.cacheWrite * snapshot.storagePerTokenHour * (ttlMs / 3_600_000),
    known: true,
    reason: null,
  };
}

function costForAttempt(attempt, snapshots) {
  const usage = attempt.usage;
  const rateSnapshot = chooseRateSnapshot(attempt, snapshots);
  const storage = storageCostForAttempt(attempt, rateSnapshot);
  if (rateSnapshot && requiredRateFieldsKnown(rateSnapshot)
    && usage.input !== null && usage.cacheRead !== null && usage.cacheWrite !== null && usage.output !== null
    && storage.known) {
    return {
      usd: usage.input * rateSnapshot.inputPerToken
        + usage.cacheRead * rateSnapshot.cacheReadPerToken
        + usage.cacheWrite * rateSnapshot.cacheWritePerToken
        + usage.output * rateSnapshot.outputPerToken
        + storage.usd,
      source: rateSnapshot.source,
      version: rateSnapshot.version,
      retrievedAt: rateSnapshot.retrievedAt,
      rateSnapshot,
      storage,
      known: true,
      reason: null,
    };
  }
  if (attempt.cost.usd !== null && attempt.cost.source !== null && traceCostAvailableAtAttempt(attempt)) {
    return {
      usd: attempt.cost.usd,
      source: attempt.cost.source,
      version: attempt.cost.version,
      retrievedAt: attempt.cost.retrievedAt,
      rateSnapshot,
      storage: { usd: null, known: null, reason: "included-in-trace-cost" },
      known: true,
      reason: "trace-cost",
    };
  }
  return {
    usd: null,
    source: rateSnapshot?.source ?? attempt.cost.source,
    version: rateSnapshot?.version ?? attempt.cost.version,
    retrievedAt: rateSnapshot?.retrievedAt ?? attempt.cost.retrievedAt,
    rateSnapshot,
    storage,
    known: false,
    reason: rateSnapshot ? storage.reason ?? "incomplete-rate-or-usage" : "missing-rate-snapshot",
  };
}

function costAggregate(attempts, snapshots) {
  const values = attempts.map((attempt) => costForAttempt(attempt, snapshots));
  const known = values.filter((value) => value.known);
  const fromRates = known.filter((value) => value.reason !== "trace-cost");
  const storageKnown = values.filter((value) => value.storage?.known === true);
  const storageValues = storageKnown.map((value) => value.storage.usd);
  return {
    totalUsd: known.reduce((sum, value) => sum + value.usd, 0),
    knownSamples: known.length,
    unknownSamples: values.length - known.length,
    knownRateSamples: fromRates.length,
    unknownRateSamples: values.length - fromRates.length,
    unknownSourceSamples: values.filter((value) => !value.source).length,
    storage: {
      totalUsd: storageValues.reduce((sum, value) => sum + value, 0),
      knownSamples: storageKnown.length,
      unknownSamples: values.length - storageKnown.length,
    },
    bySource: sortedObject([...new Set(known.map((value) => value.source).filter(Boolean))].map((source) => [source, known.filter((value) => value.source === source).length])),
  };
}

function latencyAggregate(attempts) {
  const ttft = attempts.map((attempt) => attempt.ttftMs).filter((value) => value !== null);
  const turn = attempts.map((attempt) => attempt.turnMs).filter((value) => value !== null);
  return {
    ttftMs: {
      p50: percentile(ttft, 0.5),
      p95: percentile(ttft, 0.95),
      knownSamples: ttft.length,
      unknownSamples: attempts.length - ttft.length,
    },
    turnMs: {
      p50: percentile(turn, 0.5),
      p95: percentile(turn, 0.95),
      knownSamples: turn.length,
      unknownSamples: attempts.length - turn.length,
    },
  };
}

function dimensionGroup(attempts, snapshots) {
  const usage = usageAggregate(attempts);
  return {
    attempts: attempts.length,
    tasks: new Set(attempts.map((attempt) => compositeKey(attempt.runId, attempt.taskId))).size,
    usage,
    cost: costAggregate(attempts, snapshots),
    latency: latencyAggregate(attempts),
    cachedInputShare: usage.cachedInputShare,
  };
}

function dimensionGroups(attempts, selector, snapshots) {
  return sortedObject(groupAttempts(attempts, selector).map(([name, group]) => [name, dimensionGroup(group, snapshots)]));
}

function continuityKey(attempt) {
  return [
    attempt.runId,
    attempt.taskId,
    attempt.role,
    attempt.provider,
    attempt.protocol,
    attempt.route,
    attempt.model,
    attempt.variant ?? "unknown",
    attempt.cache.namespace ?? "unknown",
    attempt.cache.cacheKeyHash ?? "unknown",
  ].join("\u0000");
}

function continuityGroups(attempts) {
  return groupAttempts(attempts, continuityKey);
}

function breakpointDeltas(attempts) {
  const pairs = [];
  for (const [, group] of continuityGroups(attempts)) {
    const ordered = group.slice().sort(compareNormalizedAttempts);
    for (let index = 1; index < ordered.length; index++) {
      const before = ordered[index - 1];
      const after = ordered[index];
      const beforeCount = before.cache.effective.markerCount;
      const afterCount = after.cache.effective.markerCount;
      const beforePositions = before.cache.markerPositions;
      const afterPositions = after.cache.markerPositions;
      const countDelta = beforeCount !== null && afterCount !== null ? afterCount - beforeCount : null;
      const addedPositions = beforePositions !== null && afterPositions !== null
        ? afterPositions.filter((position) => !beforePositions.includes(position))
        : null;
      const removedPositions = beforePositions !== null && afterPositions !== null
        ? beforePositions.filter((position) => !afterPositions.includes(position))
        : null;
      const beforeEligible = before.cache.eligibleBlockCount;
      const afterEligible = after.cache.eligibleBlockCount;
      pairs.push({
        runId: after.runId,
        taskId: after.taskId,
        role: after.role,
        provider: after.provider,
        protocol: after.protocol,
        route: after.route,
        model: after.model,
        cacheNamespace: after.cache.namespace,
        cacheKeyHash: after.cache.cacheKeyHash,
        beforeAttemptId: before.attemptId,
        afterAttemptId: after.attemptId,
        markerCountBefore: beforeCount,
        markerCountAfter: afterCount,
        markerCountDelta: countDelta,
        markerPositionsAdded: addedPositions,
        markerPositionsRemoved: removedPositions,
        eligibleBlockDelta: beforeEligible !== null && afterEligible !== null ? afterEligible - beforeEligible : null,
        blocksAddedSincePrior: after.cache.blocksAddedSincePrior,
      });
    }
  }
  pairs.sort((left, right) => {
    for (const [a, b] of [[left.runId, right.runId], [left.taskId, right.taskId], [left.role, right.role], [left.beforeAttemptId, right.beforeAttemptId]]) {
      const result = stableCompare(a, b);
      if (result !== 0) return result;
    }
    return 0;
  });
  const markerDeltas = pairs.map((pair) => pair.markerCountDelta).filter((value) => value !== null);
  const eligibleDeltas = pairs.map((pair) => pair.eligibleBlockDelta).filter((value) => value !== null);
  return {
    comparisons: pairs.length,
    markerCountDelta: {
      knownSamples: markerDeltas.length,
      unknownSamples: pairs.length - markerDeltas.length,
      added: markerDeltas.filter((value) => value > 0).reduce((sum, value) => sum + value, 0),
      removed: markerDeltas.filter((value) => value < 0).reduce((sum, value) => sum + Math.abs(value), 0),
      unchanged: markerDeltas.filter((value) => value === 0).length,
      median: percentile(markerDeltas, 0.5),
    },
    eligibleBlockDelta: {
      knownSamples: eligibleDeltas.length,
      unknownSamples: pairs.length - eligibleDeltas.length,
      median: percentile(eligibleDeltas, 0.5),
    },
    pairs,
    // The external OpenAI lookback conflict is deliberately not represented
    // as a number. A live route probe must establish any accepted boundary.
    openAiLookbackLimit: null,
  };
}

function sampleTime(sample) {
  if (sample && Object.hasOwn(sample, "atMs")) return finiteNonnegative(sample.atMs);
  if (sample && Object.hasOwn(sample, "timeMs")) return finiteNonnegative(sample.timeMs);
  return recordTimeMs(sample?.raw ?? sample);
}

function sampleCacheRead(sample) {
  if (Object.hasOwn(sample, "cacheRead")) return finiteNonnegative(sample.cacheRead);
  if (sample?.usage && Object.hasOwn(sample.usage, "cacheRead")) return finiteNonnegative(sample.usage.cacheRead);
  return finiteNonnegative(sample?.usage?.cache_read_input_tokens);
}

function sampleTtl(sample) {
  if (Object.hasOwn(sample, "effectiveTtlMs")) return finiteNonnegative(sample.effectiveTtlMs);
  if (sample?.cache?.effective) return finiteNonnegative(sample.cache.effective.ttlMs);
  return finiteNonnegative(sample?.cache?.effectiveTtlMs);
}

function sampleRetentionKnown(sample) {
  if (typeof sample?.retentionKnown === "boolean") return sample.retentionKnown;
  if (typeof sample?.cache?.retentionKnown === "boolean") return sample.cache.retentionKnown;
  if (typeof sample?.cache?.effective?.retentionKnown === "boolean") return sample.cache.effective.retentionKnown;
  // An effective TTL is a requested/observed policy field, not proof of
  // backend retention. Keep the retention denominator unknown unless runtime
  // or a controlled probe records explicit evidence.
  return null;
}

function normalizeTtlBuckets(input) {
  const source = Array.isArray(input) && input.length ? input : DEFAULT_TTL_BUCKETS;
  const buckets = [];
  for (const item of source) {
    if (typeof item === "number") {
      const maxMs = finitePositive(item);
      if (maxMs === null) continue;
      const previous = buckets.at(-1)?.maxMs ?? 0;
      buckets.push({ label: `${previous}-${maxMs}`, minMs: previous, maxMs });
      continue;
    }
    if (!isObject(item)) continue;
    const minMs = finiteNonnegative(item.minMs ?? item.min ?? 0);
    const maxMs = item.maxMs === null || item.max === null ? null : finitePositive(item.maxMs ?? item.max);
    if (minMs === null || (item.maxMs !== null && item.max !== null && maxMs === null)) continue;
    const label = nonempty(item.label) ?? `${minMs}-${maxMs === null ? "infinity" : maxMs}`;
    buckets.push({ label, minMs, maxMs });
  }
  return buckets.length ? buckets : DEFAULT_TTL_BUCKETS;
}

function emptyTtlBuckets(buckets) {
  const result = {};
  for (const bucket of buckets) {
    result[bucket.label] = { samples: 0, completeSamples: 0, observedHits: 0, observedMisses: 0, unknownSamples: 0, effectiveTtlExceededSamples: 0 };
  }
  result[UNKNOWN_RETENTION_BUCKET] = { samples: 0, completeSamples: 0, observedHits: 0, observedMisses: 0, unknownSamples: 0, effectiveTtlExceededSamples: 0 };
  result[UNKNOWN_GAP_BUCKET] = { samples: 0, completeSamples: 0, observedHits: 0, observedMisses: 0, unknownSamples: 0, effectiveTtlExceededSamples: 0 };
  return result;
}

export function compareTtlBuckets(samples, options = {}) {
  const bucketOptions = Array.isArray(options) ? options : options.buckets;
  const buckets = normalizeTtlBuckets(bucketOptions);
  const outputBuckets = emptyTtlBuckets(buckets);
  const ordered = (Array.isArray(samples) ? samples : []).slice().sort((left, right) => {
    const a = sampleTime(left);
    const b = sampleTime(right);
    if (a === null && b !== null) return 1;
    if (a !== null && b === null) return -1;
    if (a !== null && b !== null && a !== b) return a - b;
    return stableCompare(left?.attemptId ?? "", right?.attemptId ?? "");
  });
  let unknownRetentionSamples = 0;
  let effectiveTtlExceededSamples = 0;
  let timestampedPairs = 0;
  let retentionEvidencePairs = 0;
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const before = sampleTime(previous);
    const after = sampleTime(current);
    const gapMs = before !== null && after !== null ? Math.max(0, after - before) : null;
    const ttlMs = sampleTtl(current);
    const retentionKnown = sampleRetentionKnown(current);
    if (gapMs !== null) timestampedPairs++;
    if (gapMs !== null && ttlMs !== null && retentionKnown === true) retentionEvidencePairs++;
    let bucketName;
    if (retentionKnown !== true || ttlMs === null) {
      bucketName = UNKNOWN_RETENTION_BUCKET;
      unknownRetentionSamples++;
    } else if (gapMs === null) {
      bucketName = UNKNOWN_GAP_BUCKET;
    } else {
      bucketName = buckets.find((bucket) => gapMs >= bucket.minMs && (bucket.maxMs === null || gapMs < bucket.maxMs))?.label ?? UNKNOWN_GAP_BUCKET;
    }
    const bucket = outputBuckets[bucketName] ?? outputBuckets[UNKNOWN_GAP_BUCKET];
    bucket.samples++;
    const cacheRead = sampleCacheRead(current);
    if (cacheRead === null) bucket.unknownSamples++;
    else if (cacheRead > 0) {
      bucket.completeSamples++;
      bucket.observedHits++;
    } else {
      bucket.completeSamples++;
      bucket.observedMisses++;
    }
    if (ttlMs !== null && gapMs !== null && retentionKnown === true && gapMs > ttlMs) {
      bucket.effectiveTtlExceededSamples++;
      effectiveTtlExceededSamples++;
    }
  }
  return {
    retentionClaims: 0,
    unknownRetentionSamples,
    effectiveTtlExceededSamples,
    timestampedPairs,
    retentionEvidencePairs,
    buckets: outputBuckets,
  };
}

function mergeTtlComparisons(comparisons, unknownRetentionAttemptSamples) {
  const buckets = {};
  let unknownPairSamples = 0;
  let exceeded = 0;
  let timestampedPairs = 0;
  let retentionEvidencePairs = 0;
  for (const comparison of comparisons) {
    unknownPairSamples += comparison.unknownRetentionSamples;
    exceeded += comparison.effectiveTtlExceededSamples;
    timestampedPairs += comparison.timestampedPairs;
    retentionEvidencePairs += comparison.retentionEvidencePairs;
    for (const [name, value] of Object.entries(comparison.buckets)) {
      const target = buckets[name] ?? (buckets[name] = { samples: 0, completeSamples: 0, observedHits: 0, observedMisses: 0, unknownSamples: 0, effectiveTtlExceededSamples: 0 });
      for (const field of Object.keys(target)) target[field] += value[field];
    }
  }
  return {
    retentionClaims: 0,
    unknownRetentionSamples: unknownRetentionAttemptSamples,
    unknownRetentionPairSamples: unknownPairSamples,
    effectiveTtlExceededSamples: exceeded,
    timestampedPairs,
    retentionEvidencePairs,
    buckets: sortedObject(Object.entries(buckets)),
  };
}

function taskModel(attempts, settlements) {
  const groups = new Map();
  for (const attempt of attempts) {
    const key = compositeKey(attempt.runId, attempt.taskId);
    const group = groups.get(key) ?? {
      runId: attempt.runId,
      taskId: attempt.taskId,
      corpusIds: new Set(),
      corpusSources: new Set(),
      attempts: [],
      settlement: null,
    };
    if (attempt.corpusId) group.corpusIds.add(attempt.corpusId);
    if (attempt.corpusSource) group.corpusSources.add(attempt.corpusSource);
    group.attempts.push(attempt);
    groups.set(key, group);
  }
  for (const settlement of settlements) {
    const key = compositeKey(settlement.runId, settlement.taskId);
    const group = groups.get(key) ?? {
      runId: settlement.runId,
      taskId: settlement.taskId,
      corpusIds: new Set(),
      corpusSources: new Set(),
      attempts: [],
      settlement: null,
    };
    if (settlement.corpusId) group.corpusIds.add(settlement.corpusId);
    if (settlement.corpusSource) group.corpusSources.add(settlement.corpusSource);
    group.settlement = settlement;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.corpusId = group.corpusIds.size === 1 ? [...group.corpusIds][0] : null;
    group.corpusSource = group.corpusSources.size === 1 ? [...group.corpusSources][0] : null;
    delete group.corpusIds;
    delete group.corpusSources;
  }
  return [...groups.values()].sort((left, right) => stableCompare(compositeKey(left.runId, left.taskId), compositeKey(right.runId, right.taskId)));
}

function taskVariant(group) {
  const variants = [...new Set(group.attempts.map((attempt) => attempt.variant).filter(Boolean))];
  return variants.length === 1 ? variants[0] : null;
}

function taskAccounting(group, snapshots) {
  const inputValues = group.attempts.map((attempt) => completeInputUsage(attempt.usage));
  const costs = group.attempts.map((attempt) => costForAttempt(attempt, snapshots));
  return {
    inputKnown: inputValues.every((value) => value !== null),
    inputTotal: inputValues.every((value) => value !== null) ? inputValues.reduce((sum, value) => sum + value, 0) : null,
    costKnown: costs.every((value) => value.known),
    costTotal: costs.every((value) => value.known) ? costs.reduce((sum, value) => sum + value.usd, 0) : null,
  };
}

function boundedRate(count, denominator) {
  return denominator > 0 ? Math.min(1, Math.max(0, count / denominator)) : null;
}

function sumKnownReaderField(diagnostics, field) {
  const values = diagnostics.map((item) => finiteNonnegative(item?.[field]));
  return values.length && values.every((value) => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function pairedTaskGroups(taskGroups) {
  const byVariant = new Map();
  let unknownCorpusTasks = 0;
  let unknownVariantTasks = 0;
  for (const group of taskGroups) {
    const variant = taskVariant(group);
    if (!variant) {
      unknownVariantTasks++;
      continue;
    }
    if (!group.corpusId) {
      unknownCorpusTasks++;
      continue;
    }
    const key = `${group.corpusId}\u0000${group.taskId}`;
    const tasks = byVariant.get(variant) ?? new Map();
    const matches = tasks.get(key) ?? [];
    matches.push(group);
    tasks.set(key, matches);
    byVariant.set(variant, tasks);
  }
  const baseline = byVariant.get("baseline") ?? new Map();
  const candidate = byVariant.get("candidate") ?? new Map();
  const keys = [...new Set([...baseline.keys(), ...candidate.keys()])].sort(stableCompare);
  const pairs = [];
  let ambiguous = 0;
  let unpaired = 0;
  for (const key of keys) {
    const left = baseline.get(key) ?? [];
    const right = candidate.get(key) ?? [];
    if (left.length === 1 && right.length === 1) pairs.push({ key, baseline: left[0], candidate: right[0] });
    else if (left.length > 1 || right.length > 1) ambiguous++;
    else unpaired++;
  }
  return { pairs, ambiguous, unpaired, unknownCorpusTasks, unknownVariantTasks };
}

function qualitySummary(taskGroups, snapshots) {
  const successful = taskGroups.filter((group) => group.settlement?.status === "success");
  const settled = taskGroups.filter((group) => group.settlement !== null);
  const accounting = new Map(taskGroups.map((group) => [compositeKey(group.runId, group.taskId), taskAccounting(group, snapshots)]));
  const knownInput = successful.map((group) => accounting.get(compositeKey(group.runId, group.taskId))).filter((value) => value?.inputKnown);
  const knownCost = successful.map((group) => accounting.get(compositeKey(group.runId, group.taskId))).filter((value) => value?.costKnown);
  const correctness = {
    correct: settled.filter((group) => group.settlement.correctness === "correct").length,
    incorrect: settled.filter((group) => group.settlement.correctness === "incorrect").length,
    unknown: taskGroups.length - settled.filter((group) => ["correct", "incorrect"].includes(group.settlement.correctness)).length,
    denominator: "all-tasks",
  };
  const allCorrectness = { ...correctness };
  const variantGroups = new Map();
  for (const group of taskGroups) {
    const variant = taskVariant(group) ?? "unknown";
    const entry = variantGroups.get(variant) ?? { total: 0, settled: 0, successful: 0, failed: 0, correct: 0, incorrect: 0 };
    entry.total++;
    if (group.settlement) {
      entry.settled++;
      if (group.settlement.status === "success") entry.successful++;
      if (group.settlement.status === "failure") entry.failed++;
      if (group.settlement.correctness === "correct") entry.correct++;
      if (group.settlement.correctness === "incorrect") entry.incorrect++;
    }
    variantGroups.set(variant, entry);
  }
  const variantStats = sortedObject([...variantGroups.entries()].map(([name, value]) => [name, {
    ...value,
    successRate: boundedRate(value.successful, value.settled),
    failureRate: boundedRate(value.failed, value.settled),
    correctnessRate: boundedRate(value.correct, value.successful),
  }]));
  const pairing = pairedTaskGroups(taskGroups);
  const pairedOutcomes = pairing.pairs.filter((pair) => [pair.baseline.settlement?.status, pair.candidate.settlement?.status]
    .every((status) => status === "success" || status === "failure"));
  const pairedSuccessful = pairedOutcomes.filter((pair) => pair.baseline.settlement.status === "success" && pair.candidate.settlement.status === "success");
  const pairedCorrectness = pairedSuccessful.filter((pair) => [pair.baseline.settlement.correctness, pair.candidate.settlement.correctness]
    .every((value) => value === "correct" || value === "incorrect"));
  const baselinePairedSuccesses = pairedOutcomes.filter((pair) => pair.baseline.settlement.status === "success").length;
  const candidatePairedSuccesses = pairedOutcomes.filter((pair) => pair.candidate.settlement.status === "success").length;
  const baselinePairedFailures = pairedOutcomes.filter((pair) => pair.baseline.settlement.status === "failure").length;
  const candidatePairedFailures = pairedOutcomes.filter((pair) => pair.candidate.settlement.status === "failure").length;
  const baselineCorrect = pairedCorrectness.filter((pair) => pair.baseline.settlement.correctness === "correct").length;
  const candidateCorrect = pairedCorrectness.filter((pair) => pair.candidate.settlement.correctness === "correct").length;
  const pairedAccounting = pairedSuccessful.map((pair) => ({
    baseline: accounting.get(compositeKey(pair.baseline.runId, pair.baseline.taskId)),
    candidate: accounting.get(compositeKey(pair.candidate.runId, pair.candidate.taskId)),
  }));
  const pairedKnownInput = pairedAccounting.filter((pair) => pair.baseline?.inputKnown && pair.candidate?.inputKnown);
  const pairedKnownCost = pairedAccounting.filter((pair) => pair.baseline?.costKnown && pair.candidate?.costKnown);
  const pairingAvailable = pairing.pairs.length > 0 && pairedOutcomes.length > 0;
  const successGate = !pairingAvailable
    ? { status: "insufficient-data", reason: "paired-baseline-candidate-outcomes-required", denominator: pairedOutcomes.length }
    : boundedRate(candidatePairedSuccesses, pairedOutcomes.length) >= boundedRate(baselinePairedSuccesses, pairedOutcomes.length)
      && boundedRate(candidatePairedFailures, pairedOutcomes.length) <= boundedRate(baselinePairedFailures, pairedOutcomes.length)
      ? { status: "pass", reason: null, denominator: pairedOutcomes.length }
      : { status: "fail", reason: "candidate-success-or-failure-rate-regressed", denominator: pairedOutcomes.length };
  const correctnessGate = pairedCorrectness.length === 0
    ? { status: "insufficient-data", reason: "paired-successful-correctness-outcomes-required", denominator: 0 }
    : boundedRate(candidateCorrect, pairedCorrectness.length) >= boundedRate(baselineCorrect, pairedCorrectness.length)
      ? { status: "pass", reason: null, denominator: pairedCorrectness.length }
      : { status: "fail", reason: "candidate-correctness-rate-regressed", denominator: pairedCorrectness.length };
  const gateStatuses = [successGate.status, correctnessGate.status];
  const overallStatus = gateStatuses.includes("fail") ? "fail" : gateStatuses.includes("insufficient-data") ? "insufficient-data" : "pass";
  const pairedCorrectnessSummary = {
    samples: pairedCorrectness.length,
    unknownSamples: pairedSuccessful.length - pairedCorrectness.length,
    baselineCorrect: baselineCorrect,
    candidateCorrect: candidateCorrect,
    denominator: "paired-successful-identical-corpus-and-task-id",
    baselineRate: boundedRate(baselineCorrect, pairedCorrectness.length),
    candidateRate: boundedRate(candidateCorrect, pairedCorrectness.length),
  };
  return {
    taskCount: taskGroups.length,
    settledTasks: settled.length,
    successfulTasks: {
      count: successful.length,
      knownInputTasks: knownInput.length,
      unknownInputTasks: successful.length - knownInput.length,
      knownCostTasks: knownCost.length,
      unknownCostTasks: successful.length - knownCost.length,
      medianInputTokens: percentile(knownInput.map((value) => value.inputTotal), 0.5),
      medianCostUsd: percentile(knownCost.map((value) => value.costTotal), 0.5),
      denominator: "successful-settled-tasks",
    },
    paired: {
      taskPairs: pairing.pairs.length,
      outcomePairs: pairedOutcomes.length,
      successfulPairs: pairedSuccessful.length,
      correctnessPairs: pairedCorrectness.length,
      ambiguousPairs: pairing.ambiguous,
      unpairedTasks: pairing.unpaired,
      unknownCorpusTasks: pairing.unknownCorpusTasks,
      unknownVariantTasks: pairing.unknownVariantTasks,
      denominator: "paired-identical-corpus-and-task-id",
    },
    pairedSuccessfulTasks: {
      count: pairedSuccessful.length,
      knownInputPairs: pairedKnownInput.length,
      unknownInputPairs: pairedSuccessful.length - pairedKnownInput.length,
      knownCostPairs: pairedKnownCost.length,
      unknownCostPairs: pairedSuccessful.length - pairedKnownCost.length,
      denominator: "paired-successful-identical-corpus-and-task-id",
      baselineMedianInputTokens: percentile(pairedKnownInput.map((pair) => pair.baseline.inputTotal), 0.5),
      candidateMedianInputTokens: percentile(pairedKnownInput.map((pair) => pair.candidate.inputTotal), 0.5),
      baselineMedianCostUsd: percentile(pairedKnownCost.map((pair) => pair.baseline.costTotal), 0.5),
      candidateMedianCostUsd: percentile(pairedKnownCost.map((pair) => pair.candidate.costTotal), 0.5),
    },
    correctness: pairedCorrectnessSummary,
    allCorrectness,
    variants: variantStats,
    gates: {
      status: overallStatus,
      successRate: successGate,
      correctness: correctnessGate,
    },
  };
}

function breakEvenFields(snapshot, options) {
  const prefixTokens = finitePositive(typeof options === "number" ? options : options?.prefixTokens);
  const storageTtlMs = finiteNonnegative(typeof options === "object" ? options?.storageTtlMs : null);
  const unknowns = [];
  if (snapshot.source === null) unknowns.push("source");
  if (snapshot.retrievedAt === null) unknowns.push("retrievedAt");
  if (snapshot.inputPerToken === null) unknowns.push("inputPerToken");
  if (snapshot.cacheReadPerToken === null) unknowns.push("cacheReadPerToken");
  if (snapshot.cacheWritePerToken === null) unknowns.push("cacheWritePerToken");
  const storagePerToken = snapshot.storagePerTokenHour !== null && storageTtlMs !== null
    ? snapshot.storagePerTokenHour * (storageTtlMs / 3_600_000)
    : 0;
  if (snapshot.storagePerTokenHour === null) unknowns.push("storagePerTokenHour");
  const storage = {
    perTokenHour: snapshot.storagePerTokenHour,
    ttlMs: storageTtlMs,
    included: snapshot.storagePerTokenHour !== null && storageTtlMs !== null,
  };
  const required = [snapshot.inputPerToken, snapshot.cacheReadPerToken, snapshot.cacheWritePerToken, snapshot.storagePerTokenHour];
  if (snapshot.storagePerTokenHour > 0 && storageTtlMs === null) unknowns.push("storageTtlMs");
  if (required.some((value) => value === null) || snapshot.retrievedAt === null || (snapshot.storagePerTokenHour > 0 && storageTtlMs === null)) {
    return {
      prefixTokens,
      rateSnapshot: snapshot,
      readsToStrictSavings: null,
      readsToRecoverWrite: null,
      savingsPerRead: null,
      costAtReads: {},
      storage,
      unknowns: [...new Set(unknowns)],
    };
  }
  const uncached = snapshot.inputPerToken;
  const read = snapshot.cacheReadPerToken;
  const write = snapshot.cacheWritePerToken + storagePerToken;
  const perReadSavings = uncached - read;
  const threshold = (write - uncached) / perReadSavings;
  const recoveryThreshold = write / perReadSavings;
  const strictReads = perReadSavings > 0 ? Math.max(0, Math.floor(threshold + Number.EPSILON) + 1) : null;
  const recoverReads = perReadSavings > 0 ? Math.max(0, Math.floor(recoveryThreshold + Number.EPSILON) + 1) : null;
  const readCounts = [0, 1, 2, 3, 5, 10];
  const costAtReads = {};
  for (const reads of readCounts) {
    const uncachedCost = (reads + 1) * uncached + storagePerToken * 0;
    const cachedCost = write + reads * read;
    const scale = prefixTokens ?? 1;
    costAtReads[reads] = {
      uncachedUsd: uncachedCost * scale,
      cachedUsd: cachedCost * scale,
      savingsUsd: (uncachedCost - cachedCost) * scale,
    };
  }
  return {
    prefixTokens,
    rateSnapshot: snapshot,
    readsToStrictSavings: strictReads,
    readsToRecoverWrite: recoverReads,
    savingsPerRead: perReadSavings * (prefixTokens ?? 1),
    costAtReads,
    storage,
    unknowns: [...new Set(unknowns)],
  };
}

export function breakEvenFromRateSnapshot(snapshot, options = {}) {
  const normalized = normalizeRateSnapshot(snapshot);
  if (!normalized) throw new Error("rate snapshot must be an object");
  return breakEvenFields(normalized, options);
}

function analyzeBreakEven(snapshots, options) {
  return snapshots
    .map((snapshot) => breakEvenFields(snapshot, { prefixTokens: options.prefixTokens, storageTtlMs: options.storageTtlMs }))
    .sort((left, right) => {
      const a = left.rateSnapshot;
      const b = right.rateSnapshot;
      for (const [leftValue, rightValue] of [[a.provider ?? "", b.provider ?? ""], [a.protocol ?? "", b.protocol ?? ""], [a.model ?? "", b.model ?? ""], [a.retrievedAt ?? "", b.retrievedAt ?? ""], [a.source, b.source]]) {
        const result = stableCompare(leftValue, rightValue);
        if (result !== 0) return result;
      }
      return 0;
    });
}

export function analyzeCacheExperiment(records, options = {}) {
  const normalizedOptions = isObject(options) ? options : {};
  const normalizedRates = (Array.isArray(normalizedOptions.rateSnapshots) ? normalizedOptions.rateSnapshots : [])
    .map(normalizeRateSnapshot)
    .filter(Boolean)
    .sort((left, right) => {
      for (const [a, b] of [[left.retrievedAt ?? "", right.retrievedAt ?? ""], [left.source, right.source], [left.version ?? "", right.version ?? ""]]) {
        const result = stableCompare(a, b);
        if (result !== 0) return result;
      }
      return stableCompare(left.model ?? "", right.model ?? "");
    });
  const sourceRecords = Array.isArray(records)
    ? records
    : isObject(records) && Array.isArray(records.records)
      ? records.records
      : [];
  const inheritedReaderDiagnostics = Array.isArray(normalizedOptions.readerDiagnostics)
    ? normalizedOptions.readerDiagnostics
    : isObject(records?.traceDiagnostics)
      ? [records.traceDiagnostics]
      : [];
  const { attempts, settlements, invalidRecords } = normalizeRecords(sourceRecords);
  const usage = usageAggregate(attempts);
  const taskGroups = taskModel(attempts, settlements);
  const ttlComparisons = continuityGroups(attempts).map(([, group]) => compareTtlBuckets(group, { buckets: normalizedOptions.ttlBuckets }));
  const unknownRetentionAttemptSamples = continuityGroups(attempts)
    .filter(([, group]) => group.length > 1)
    .flatMap(([, group]) => group)
    .filter((attempt) => sampleTtl(attempt) === null).length;
  const ttl = mergeTtlComparisons(ttlComparisons, unknownRetentionAttemptSamples);
  ttl.availability = {
    available: ttl.timestampedPairs > 0,
    timestampAvailable: ttl.timestampedPairs > 0,
    retentionEvidenceAvailable: ttl.retentionEvidencePairs > 0,
    status: ttl.timestampedPairs === 0
      ? "unavailable"
      : ttl.retentionEvidencePairs === 0
        ? "retention-unknown"
        : ttl.retentionEvidencePairs < ttl.timestampedPairs
          ? "partial"
          : "available",
    reason: ttl.timestampedPairs === 0
      ? "attempt-timestamps-required"
      : ttl.retentionEvidencePairs === 0
        ? "explicit-retention-evidence-required"
        : ttl.retentionEvidencePairs < ttl.timestampedPairs
          ? "some-attempts-lack-retention-evidence"
          : null,
  };
  const roles = sortedObject(groupAttempts(attempts, (attempt) => attempt.role).map(([name, group]) => {
    const usageRole = usageAggregate(group);
    return [name, {
      attempts: group.length,
      usage: usageRole,
      cost: costAggregate(group, normalizedRates),
      latency: latencyAggregate(group),
      cachedInputShare: usageRole.cachedInputShare,
    }];
  }));
  const cost = costAggregate(attempts, normalizedRates);
  return {
    schemaVersion: SCHEMA_VERSION,
    attempts: {
      total: attempts.length,
      byStatus: sortedObject([...new Set(attempts.map((attempt) => attempt.status))].map((status) => [status, attempts.filter((attempt) => attempt.status === status).length])),
    },
    tasks: {
      total: taskGroups.length,
      settled: taskGroups.filter((group) => group.settlement !== null).length,
      successful: taskGroups.filter((group) => group.settlement?.status === "success").length,
      failed: taskGroups.filter((group) => group.settlement?.status === "failure").length,
      unknownOutcome: taskGroups.filter((group) => !group.settlement || !["success", "failure"].includes(group.settlement.status)).length,
    },
    usage: {
      completeKnown: {
        samples: usage.completeSamples,
        partialSamples: usage.partialSamples,
        unknownSamples: attempts.length - usage.completeSamples,
        input: usage.cacheShareDenominator.input,
        cacheRead: usage.cacheShareDenominator.cacheRead,
        cacheWrite: usage.cacheShareDenominator.cacheWrite,
        denominator: "complete-cache-input-samples",
        cacheReadShare: usage.cachedInputShare,
      },
      byField: {
        input: usage.input,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        output: usage.output,
        reasoning: usage.reasoning,
      },
    },
    roles,
    groups: {
      byProvider: dimensionGroups(attempts, (attempt) => attempt.provider, normalizedRates),
      byRoute: dimensionGroups(attempts, (attempt) => attempt.route, normalizedRates),
      byModel: dimensionGroups(attempts, (attempt) => attempt.model, normalizedRates),
      byEffectivePolicy: dimensionGroups(attempts, (attempt) => `${attempt.cache.effective.mode ?? "unknown"}/${attempt.cache.effective.ttlMs === null ? "unknown" : attempt.cache.effective.ttlMs}`, normalizedRates),
      byTaskClass: dimensionGroups(attempts, (attempt) => attempt.taskClass, normalizedRates),
      byVariant: dimensionGroups(attempts, (attempt) => attempt.variant, normalizedRates),
    },
    cost: {
      totalUsd: cost.totalUsd,
      knownSamples: cost.knownSamples,
      unknownSamples: cost.unknownSamples,
      knownRateSamples: cost.knownRateSamples,
      unknownRateSamples: cost.unknownRateSamples,
      unknownSourceSamples: cost.unknownSourceSamples,
      bySource: cost.bySource,
      denominator: "attempts-with-complete-usage-and-timestamped-rate",
    },
    ttl,
    breakpoints: breakpointDeltas(attempts),
    breakEven: analyzeBreakEven(normalizedRates, normalizedOptions),
    quality: qualitySummary(taskGroups, normalizedRates),
    unknowns: {
      usageAttempts: attempts.filter((attempt) => completeInputUsage(attempt.usage) === null).length,
      costAttempts: cost.unknownSamples,
      retentionAttempts: unknownRetentionAttemptSamples,
      unsettledTasks: taskGroups.filter((group) => group.settlement === null).length,
      correctnessTasks: taskGroups.filter((group) => group.settlement?.correctness === "unknown" || !group.settlement?.correctness).length,
    },
    diagnostics: {
      inputRecords: sourceRecords.length,
      acceptedAttempts: attempts.length,
      acceptedSettlements: settlements.length,
      invalidRecords,
      reader: inheritedReaderDiagnostics.length
        ? inheritedReaderDiagnostics.slice().sort((left, right) => stableCompare(JSON.stringify(left), JSON.stringify(right)))
        : [],
      readerTotals: {
        retainedRecords: sumKnownReaderField(inheritedReaderDiagnostics, "retainedRecords"),
        omittedRecords: sumKnownReaderField(inheritedReaderDiagnostics, "omittedRecords"),
        writeFailures: sumKnownReaderField(inheritedReaderDiagnostics, "writeFailures"),
        malformedRecords: sumKnownReaderField(inheritedReaderDiagnostics, "malformedRecords"),
        readerOmittedRecords: sumKnownReaderField(inheritedReaderDiagnostics, "readerOmittedRecords"),
        manifestErrors: sumKnownReaderField(inheritedReaderDiagnostics, "manifestErrors"),
      },
    },
  };
}

function defaultDirectories(env) {
  const events = env.TERMINA_EVENTS_DIR;
  const terminal = env.TERMINA_TERMINAL_ID;
  if (!events) return [];
  if (terminal) return [`${events}/${terminal}.traces`];
  return [];
}

function readJsonFile(path) {
  const value = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.records)) return value.records;
  if (isObject(value) && Array.isArray(value.snapshots)) return value.snapshots;
  throw new Error(`expected an array or { records: [...] } in ${path}`);
}

function usageText() {
  return "usage: node scripts/agent-core-cache-experiment.mjs [--json] [--rates rate-snapshots.json] [trace-directory ...]";
}

export function run(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usageText());
    return 0;
  }
  const json = argv.includes("--json");
  const ratesIndex = argv.indexOf("--rates");
  const ratePath = ratesIndex >= 0 ? argv[ratesIndex + 1] : null;
  const allowed = new Set(["--json", "--rates"]);
  const unknownOption = argv.find((arg, index) => arg.startsWith("-") && !allowed.has(arg) && index !== ratesIndex + 1);
  if (unknownOption) {
    console.error(`unknown option: ${unknownOption}\n${usageText()}`);
    return 2;
  }
  if (ratesIndex >= 0 && (!ratePath || ratePath.startsWith("-"))) {
    console.error(`--rates requires a JSON file\n${usageText()}`);
    return 2;
  }
  const paths = argv.filter((arg, index) => !arg.startsWith("-") && index !== ratesIndex + 1);
  const inputs = paths.length ? paths : defaultDirectories(env);
  if (inputs.length === 0) {
    console.error(`no trace directory found\n${usageText()}`);
    return 1;
  }
  const records = [];
  const sourceErrors = [];
  const readerDiagnostics = [];
  for (const input of inputs) {
    try {
      const resolved = resolve(input);
      if (existsSync(resolved) && statSync(resolved).isDirectory()) {
        const source = readTraceDirectory(resolved);
        records.push(...source.records);
        sourceErrors.push(...source.errors.map((error) => ({ source: basename(resolved), ...error })));
        readerDiagnostics.push({ source: basename(resolved), ...source.diagnostics });
      } else {
        records.push(...readJsonFile(resolved));
      }
    } catch (error) {
      sourceErrors.push({ source: input, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (records.length === 0) {
    console.error(`no trace-v2 records found\n${usageText()}`);
    return 1;
  }
  let rateSnapshots = [];
  if (ratePath) {
    try {
      const value = readJsonFile(ratePath);
      rateSnapshots = value;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  const report = analyzeCacheExperiment(records, { rateSnapshots, readerDiagnostics });
  sourceErrors.sort((left, right) => stableCompare(JSON.stringify(left), JSON.stringify(right)));
  const output = { report, sourceErrors };
  if (json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`cache experiment: ${report.tasks.total} tasks, ${report.attempts.total} attempts`);
    console.log(`complete-known cache share: ${report.usage.completeKnown.cacheReadShare === null ? "--" : `${(report.usage.completeKnown.cacheReadShare * 100).toFixed(1)}%`} (${report.usage.completeKnown.samples} samples)`);
    console.log(`quality gate: ${report.quality.gates.status}`);
    if (sourceErrors.length || report.diagnostics.invalidRecords.length) {
      console.log(`warnings: ${sourceErrors.length + report.diagnostics.invalidRecords.length}`);
    }
  }
  return 0;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) process.exitCode = run();
