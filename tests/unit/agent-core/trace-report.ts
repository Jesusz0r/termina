#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_TRACE_FILES = 10_000;
const MAX_TRACE_BYTES = 1024 * 1024;
const TRACE_SCHEMA_VERSION = 2;
const TRACE_RECORD_TYPES = new Set(["attempt", "task-settled"]);
const MAX_REPORT_LIST_ITEMS = 256;
const MAX_REPORT_STRING_CHARS = 512;

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function knownNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableNonnegative(value) {
  return knownNonnegative(value) ? value : null;
}

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedString(value, limit = MAX_REPORT_STRING_CHARS) {
  const text = nonemptyString(value);
  return text === null ? null : text.slice(0, limit);
}

function boundedStringArray(value, limit = MAX_REPORT_LIST_ITEMS) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const text = boundedString(item);
    if (text === null || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function nullableBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function metricFromValues(values) {
  let total = 0;
  let knownSamples = 0;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    knownSamples++;
  }
  return { total, knownSamples, unknownSamples: values.length - knownSamples };
}

function compareStable(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function knownCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validTraceRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("root is not an object");
  }
  if (record.schemaVersion === undefined) {
    if ((record.role !== "main" && record.role !== "summary") || !nonemptyString(record.status) || !nonemptyString(record.model)) {
      throw new Error("legacy trace record is missing required role, status, or model");
    }
    return;
  }
  if (record.schemaVersion !== TRACE_SCHEMA_VERSION) {
    throw new Error(`unsupported trace schema version: ${String(record.schemaVersion)}`);
  }
  if (!TRACE_RECORD_TYPES.has(record.recordType)) {
    throw new Error(`unsupported trace record type: ${String(record.recordType)}`);
  }
  if (!nonemptyString(record.runId)) throw new Error("v2 record is missing runId");
  if (!nonemptyString(record.taskId)) throw new Error("v2 record is missing taskId");
  if (record.recordType === "attempt" && !nonemptyString(record.attemptId)) {
    throw new Error("v2 attempt is missing attemptId");
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function counts(values) {
  const out = Object.create(null);
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareStable(a, b)));
}

function cacheShare(record) {
  if (!record.usage || typeof record.usage !== "object") return null;
  const total = finiteNonnegative(record.usage.input) + finiteNonnegative(record.usage.cacheRead) + finiteNonnegative(record.usage.cacheWrite);
  return total > 0 ? finiteNonnegative(record.usage.cacheRead) / total : null;
}

function cacheGroups(records, field) {
  const groups = new Map();
  for (const record of records) {
    const name = field(record);
    if (!name) continue;
    const input = finiteNonnegative(record.usage?.input) + finiteNonnegative(record.usage?.cacheRead) + finiteNonnegative(record.usage?.cacheWrite);
    const cacheRead = finiteNonnegative(record.usage?.cacheRead);
    const group = groups.get(name) ?? { turns: 0, totalInput: 0, cacheRead: 0, cachedInputShare: null };
    group.turns++;
    group.totalInput += input;
    group.cacheRead += cacheRead;
    group.cachedInputShare = group.totalInput > 0 ? group.cacheRead / group.totalInput : null;
    groups.set(name, group);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => compareStable(a, b)));
}

const CACHE_HASH_FIELDS = ["cacheKeyHash", "modelSettingsHash", "toolsHash", "stablePrefixHash", "messagePrefixHash", "workingSetHash"];

function withCacheChanges(records) {
  let previous = null;
  return records.map((record) => {
    const current = record.cache && typeof record.cache === "object" ? record.cache : null;
    const changes = {};
    for (const field of CACHE_HASH_FIELDS) {
      changes[field] =
        current && previous && Object.hasOwn(current, field) && Object.hasOwn(previous, field)
          ? current[field] !== previous[field]
          : null;
    }
    if (current) previous = current;
    return { ...record, cacheChanges: changes };
  });
}

function traceNumber(name) {
  const match = /^turn-(\d+)\.json$/.exec(name);
  if (!match) return null;
  const turn = Number(match[1]);
  return Number.isSafeInteger(turn) && turn > 0 ? turn : null;
}

function recordFileName(record) {
  return Number.isInteger(record.traceTurn) ? `turn-${record.traceTurn}.json` : "<memory>";
}

function likelyPartialText(value) {
  const text = value.trimEnd();
  if (text.length === 0) return true;
  const last = text[text.length - 1];
  return last !== "}" && last !== "]";
}

function v2CompositeKey(runId, id) {
  return `${runId}\u0000${id}`;
}

function hasUniqueStrings(values) {
  if (!Array.isArray(values)) return true;
  const seen = new Set();
  for (const value of values) {
    if (!nonemptyString(value) || seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

function validateV2Relationships(records) {
  const errors = [];
  const invalid = new Set();
  const v2Attempts = records.filter((record) => record.schemaVersion === TRACE_SCHEMA_VERSION && record.recordType === "attempt");
  const v2Settlements = records.filter((record) => record.schemaVersion === TRACE_SCHEMA_VERSION && record.recordType === "task-settled");
  let changed = true;
  while (changed) {
    changed = false;
    const attemptsById = new Map();
    const settlementsByTask = new Map();
    const duplicateAttemptKeys = new Set();
    const roundInvalid = new Map();
    const markInvalid = (record, message) => {
      const messages = roundInvalid.get(record) ?? [];
      messages.push(message);
      roundInvalid.set(record, messages);
    };
    const activeAttempts = v2Attempts.filter((record) => !invalid.has(record));
    const activeSettlements = v2Settlements.filter((record) => !invalid.has(record));

    for (const record of activeAttempts) {
      const key = v2CompositeKey(record.runId, record.attemptId);
      if (attemptsById.has(key)) {
        duplicateAttemptKeys.add(key);
        markInvalid(record, `duplicate attemptId for run: ${record.attemptId}`);
      } else {
        attemptsById.set(key, record);
      }
    }
    for (const record of activeSettlements) {
      const key = v2CompositeKey(record.runId, record.taskId);
      if (settlementsByTask.has(key)) {
        markInvalid(record, `duplicate task-settled record for task: ${record.taskId}`);
      } else {
        settlementsByTask.set(key, record);
      }
    }

    for (const record of activeAttempts) {
      for (const field of ["retryOfAttemptId", "parentAttemptId"]) {
        if (record[field] === undefined || record[field] === null) continue;
        if (!nonemptyString(record[field])) {
          markInvalid(record, `${field} must be a non-empty string or null`);
          continue;
        }
        if (record[field] === record.attemptId) {
          markInvalid(record, `${field} cannot reference the attempt itself`);
          continue;
        }
        const parentKey = v2CompositeKey(record.runId, record[field]);
        if (duplicateAttemptKeys.has(parentKey)) {
          markInvalid(record, `${field} references an ambiguous duplicate attempt`);
          continue;
        }
        const parent = attemptsById.get(parentKey);
        if (!parent || parent.taskId !== record.taskId) {
          markInvalid(record, `${field} does not reference an attempt in the same run and task`);
        }
      }
    }

    for (const record of activeSettlements) {
      const attemptIds = record.attemptIds;
      const summaryAttemptIds = record.summaryAttemptIds;
      if (attemptIds !== undefined && !Array.isArray(attemptIds)) {
        markInvalid(record, "attemptIds must be an array");
        continue;
      }
      if (summaryAttemptIds !== undefined && !Array.isArray(summaryAttemptIds)) {
        markInvalid(record, "summaryAttemptIds must be an array");
        continue;
      }
      if (attemptIds !== undefined && !hasUniqueStrings(attemptIds)) {
        markInvalid(record, "attemptIds must be a duplicate-free array of non-empty strings");
        continue;
      }
      if (summaryAttemptIds !== undefined && !hasUniqueStrings(summaryAttemptIds)) {
        markInvalid(record, "summaryAttemptIds must be a duplicate-free array of non-empty strings");
        continue;
      }
      const ids = Array.isArray(attemptIds) ? attemptIds : [];
      const summaryIds = Array.isArray(summaryAttemptIds) ? summaryAttemptIds : [];
      const linked = new Set(ids);
      for (const id of ids) {
        const attemptKey = v2CompositeKey(record.runId, id);
        if (duplicateAttemptKeys.has(attemptKey)) {
          markInvalid(record, `attemptIds contains an ambiguous duplicate attempt: ${id}`);
          break;
        }
        const attempt = attemptsById.get(attemptKey);
        if (!attempt || attempt.taskId !== record.taskId) {
          markInvalid(record, `attemptIds contains an attempt outside the same run and task: ${id}`);
          break;
        }
      }
      for (const id of summaryIds) {
        const attemptKey = v2CompositeKey(record.runId, id);
        const attempt = attemptsById.get(attemptKey);
        if (!linked.has(id) || !attempt || attempt.taskId !== record.taskId || attempt.role !== "summary") {
          markInvalid(record, `summaryAttemptIds contains an invalid summary attempt: ${id}`);
          break;
        }
      }
      if (record.finalAttemptId !== undefined && record.finalAttemptId !== null) {
        if (!nonemptyString(record.finalAttemptId) || !linked.has(record.finalAttemptId)) {
          markInvalid(record, "finalAttemptId must reference an attempt listed in attemptIds");
        }
      }
      if (record.attemptCount !== undefined && !knownCount(record.attemptCount)) {
        markInvalid(record, "attemptCount must be a nonnegative integer");
      } else if (knownCount(record.attemptCount) && record.attemptCount < ids.length) {
        markInvalid(record, "attemptCount cannot be smaller than attemptIds.length");
      }
    }

    for (const [record, messages] of roundInvalid) {
      if (invalid.has(record)) continue;
      invalid.add(record);
      changed = true;
      for (const message of messages) errors.push({ file: recordFileName(record), error: message });
    }
  }

  return {
    records: records.filter((record) => !invalid.has(record)),
    errors,
    malformedRecords: invalid.size,
  };
}

export function readTraceDirectory(path) {
  const directory = resolve(path);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`trace directory does not exist: ${directory}`);
  }
  const candidateNames = readdirSync(directory)
    .map((name) => ({ name, turn: traceNumber(name) }))
    .filter((item) => item.turn !== null)
    .sort((a, b) => a.turn - b.turn || compareStable(a.name, b.name))
  const names = candidateNames.slice(-MAX_TRACE_FILES);
  const records = [];
  const recordErrors = [];
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
  const relationshipValidation = validateV2Relationships(records);
  records.splice(0, records.length, ...relationshipValidation.records);
  recordErrors.push(...relationshipValidation.errors);

  let manifest = null;
  const manifestErrors = [];
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

  const manifestCount = (field) => {
    if (!manifest || manifest[field] === undefined) return null;
    if (!knownCount(manifest[field])) {
      manifestErrors.push({ file: "trace-manifest.json", error: `${field} must be a nonnegative integer` });
      return null;
    }
    return manifest[field];
  };
  const schemaRecords = {
    legacy: records.filter((record) => record.schemaVersion === undefined).length,
    v2: records.filter((record) => record.schemaVersion === TRACE_SCHEMA_VERSION).length,
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
    mixedSchemas: schemaRecords.legacy > 0 && schemaRecords.v2 > 0,
    schemaRecords,
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

function summarizeLegacyTraces(records, label = "traces") {
  const main = withCacheChanges(records.filter((record) => record.role === "main"));
  const summaries = records.filter((record) => record.role === "summary");
  const withUsage = main.filter((record) => record.usage && typeof record.usage === "object");
  const ttft = main.map((record) => record.ttftMs).filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const turn = main.map((record) => record.turnMs).filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const record of withUsage) {
    usage.input += finiteNonnegative(record.usage.input);
    usage.cacheRead += finiteNonnegative(record.usage.cacheRead);
    usage.cacheWrite += finiteNonnegative(record.usage.cacheWrite);
    usage.output += finiteNonnegative(record.usage.output);
  }
  const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
  const knownCostTurns = main.filter((record) => typeof record.usd === "number" && Number.isFinite(record.usd) && record.usd >= 0);
  const wasteByCause = Object.create(null);
  for (const record of main) {
    const waste = finiteNonnegative(record.wasteTokens);
    if (waste === 0) continue;
    const cause = typeof record.wasteCause === "string" && record.wasteCause ? record.wasteCause : "unknown";
    wasteByCause[cause] = (wasteByCause[cause] ?? 0) + waste;
  }
  const tools = main.flatMap((record) => Array.isArray(record.toolNames) ? record.toolNames.filter((name) => typeof name === "string") : []);
  const perTurnCache = main.map((record, index) => ({
    turn: Number.isInteger(record.traceTurn) ? record.traceTurn : index + 1,
    status: typeof record.status === "string" ? record.status : "unknown",
    provider: typeof record.provider === "string" ? record.provider : "unknown",
    protocol: typeof record.protocol === "string" ? record.protocol : "unknown",
    totalInput: finiteNonnegative(record.usage?.input) + finiteNonnegative(record.usage?.cacheRead) + finiteNonnegative(record.usage?.cacheWrite),
    cacheRead: finiteNonnegative(record.usage?.cacheRead),
    cachedInputShare: cacheShare(record),
    workingSetChanged: typeof record.cache?.workingSetChanged === "boolean" ? record.cache.workingSetChanged : null,
    cacheKeyHash: typeof record.cache?.cacheKeyHash === "string" ? record.cache.cacheKeyHash : null,
    stablePrefixHash: typeof record.cache?.stablePrefixHash === "string" ? record.cache.stablePrefixHash : null,
    toolsHash: typeof record.cache?.toolsHash === "string" ? record.cache.toolsHash : null,
    modelSettingsHash: typeof record.cache?.modelSettingsHash === "string" ? record.cache.modelSettingsHash : null,
    messagePrefixHash: typeof record.cache?.messagePrefixHash === "string" ? record.cache.messagePrefixHash : null,
    workingSetHash: typeof record.cache?.workingSetHash === "string" ? record.cache.workingSetHash : null,
    cacheKeyChanged: record.cacheChanges.cacheKeyHash,
    modelSettingsChanged: record.cacheChanges.modelSettingsHash,
    toolsChanged: record.cacheChanges.toolsHash,
    stablePrefixChanged: record.cacheChanges.stablePrefixHash,
    messagePrefixChanged: record.cacheChanges.messagePrefixHash,
    workingSetHashChanged: record.cacheChanges.workingSetHash,
    codexTurnStateUsed: record.cache?.codexTurnStateUsed === true,
  }));
  return {
    label,
    records: records.length,
    mainTurns: main.length,
    summaryCalls: summaries.length,
    statuses: counts(main.map((record) => typeof record.status === "string" ? record.status : "unknown")),
    models: counts(main.map((record) => typeof record.model === "string" ? record.model : "unknown")),
    systemHashes: new Set(main.map((record) => record.systemHash).filter((hash) => typeof hash === "string" && hash)).size,
    latency: {
      ttftSamples: ttft.length,
      p50TtftMs: percentile(ttft, 0.5),
      p95TtftMs: percentile(ttft, 0.95),
      turnSamples: turn.length,
      p50TurnMs: percentile(turn, 0.5),
      p95TurnMs: percentile(turn, 0.95),
    },
    usage: {
      measuredTurns: withUsage.length,
      missingTurns: main.length - withUsage.length,
      ...usage,
      totalInput,
      cachedInputShare: totalInput > 0 ? usage.cacheRead / totalInput : null,
    },
    cache: {
      perTurn: perTurnCache,
      byProvider: cacheGroups(withUsage, (record) => typeof record.provider === "string" ? record.provider : "unknown"),
      byProtocol: cacheGroups(withUsage, (record) => typeof record.protocol === "string" ? record.protocol : "unknown"),
      byWorkingSetChange: cacheGroups(
        withUsage,
        (record) => typeof record.cache?.workingSetChanged === "boolean" ? String(record.cache.workingSetChanged) : "unknown",
      ),
      byCacheKeyChange: cacheGroups(withUsage, (record) => String(record.cacheChanges.cacheKeyHash ?? "unknown")),
      byModelSettingsChange: cacheGroups(withUsage, (record) => String(record.cacheChanges.modelSettingsHash ?? "unknown")),
      byToolsChange: cacheGroups(withUsage, (record) => String(record.cacheChanges.toolsHash ?? "unknown")),
      byStablePrefixChange: cacheGroups(withUsage, (record) => String(record.cacheChanges.stablePrefixHash ?? "unknown")),
    },
    cost: {
      usd: knownCostTurns.reduce((sum, record) => sum + record.usd, 0),
      measuredTurns: knownCostTurns.length,
      missingTurns: main.length - knownCostTurns.length,
    },
    waste: {
      tokens: Object.values(wasteByCause).reduce((sum, value) => sum + value, 0),
      byCause: Object.fromEntries(Object.entries(wasteByCause).sort(([a], [b]) => compareStable(a, b))),
    },
    revisions: main.reduce((sum, record) => sum + finiteNonnegative(record.revisions), 0),
    tools: { calls: tools.length, byName: counts(tools) },
  };
}

function isV2Record(record) {
  return record && typeof record === "object" && record.schemaVersion === TRACE_SCHEMA_VERSION && TRACE_RECORD_TYPES.has(record.recordType);
}

function v2RecordId(record, index) {
  return nonemptyString(record.attemptId) ?? `trace-${Number.isInteger(record.traceTurn) ? record.traceTurn : index + 1}`;
}

function v2TaskId(record) {
  return nonemptyString(record.taskId);
}

function v2TaskKey(taskId) {
  return taskId ?? "unknown";
}

function v2UsageValue(record, field) {
  const usage = record.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage) ? nullableNonnegative(usage[field]) : null;
}

function aggregateV2Usage(attempts) {
  const fields = ["input", "cacheRead", "cacheWrite", "output", "reasoning"];
  const result = {};
  const cacheFields = ["input", "cacheRead", "cacheWrite"];
  let completeSamples = 0;
  let partialSamples = 0;
  let unknownSamples = 0;
  const completeTotals = { input: 0, cacheRead: 0, cacheWrite: 0 };
  for (const field of fields) {
    let total = 0;
    let knownSamples = 0;
    for (const record of attempts) {
      const value = v2UsageValue(record, field);
      if (value === null) continue;
      total += value;
      knownSamples++;
    }
    result[field] = { total, knownSamples, unknownSamples: attempts.length - knownSamples };
  }
  for (const record of attempts) {
    const values = cacheFields.map((field) => v2UsageValue(record, field));
    const known = values.filter((value) => value !== null).length;
    if (known === cacheFields.length) {
      completeSamples++;
      for (const [index, field] of cacheFields.entries()) completeTotals[field] += values[index];
    } else if (known > 0) {
      partialSamples++;
    } else {
      unknownSamples++;
    }
  }
  const totalInput = completeTotals.input + completeTotals.cacheRead + completeTotals.cacheWrite;
  result.completeSamples = completeSamples;
  result.partialSamples = partialSamples;
  result.unknownSamples = unknownSamples;
  result.cachedInputShare = totalInput > 0 ? completeTotals.cacheRead / totalInput : null;
  result.cacheShareDenominator = {
    input: completeTotals.input,
    cacheRead: completeTotals.cacheRead,
    cacheWrite: completeTotals.cacheWrite,
    totalInput,
    knownSamples: completeSamples,
  };
  return result;
}

function v2CostValue(record) {
  const value = record.cost && typeof record.cost === "object" ? record.cost.usd : record.usd;
  return nullableNonnegative(value);
}

const V2_COST_COMPONENT_FIELDS = ["input", "cacheRead", "cacheWrite", "output", "reasoning", "storage"];

function v2CostObject(record) {
  return record.cost && typeof record.cost === "object" && !Array.isArray(record.cost) ? record.cost : null;
}

function v2CostComponents(record) {
  const cost = v2CostObject(record);
  const components = cost?.components && typeof cost.components === "object" && !Array.isArray(cost.components)
    ? cost.components
    : null;
  return Object.fromEntries(V2_COST_COMPONENT_FIELDS.map((field) => [field, nullableNonnegative(components?.[field])]));
}

function v2CostUnknownReasons(record) {
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

function aggregateV2Cost(attempts) {
  let totalUsd = 0;
  let knownSamples = 0;
  const byPriceSource = Object.create(null);
  for (const record of attempts) {
    const value = v2CostValue(record);
    if (value === null) continue;
    totalUsd += value;
    knownSamples++;
    const source = nonemptyString(record.cost && typeof record.cost === "object" ? record.cost.source : record.priceSource);
    if (source) byPriceSource[source] = (byPriceSource[source] ?? 0) + 1;
  }
  return {
    totalUsd,
    knownSamples,
    unknownSamples: attempts.length - knownSamples,
    byPriceSource: Object.fromEntries(Object.entries(byPriceSource).sort(([a], [b]) => compareStable(a, b))),
  };
}

function aggregateV2CostDetails(attempts) {
  const components = {};
  for (const field of V2_COST_COMPONENT_FIELDS) {
    components[field] = metricFromValues(attempts.map((attempt) => v2CostComponents(attempt)[field]));
  }
  return {
    components,
    unknownReasons: counts(attempts.flatMap((attempt) => v2CostUnknownReasons(attempt))),
  };
}

function normalizeV2Policy(value) {
  const policy = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  return {
    mode: nonemptyString(policy?.mode),
    ttlMs: nullableNonnegative(policy?.ttlMs),
  };
}

function normalizeV2SessionLengthBucket(record) {
  return boundedString(
    record.sessionLengthBucket
      ?? record.session?.lengthBucket
      ?? record.sessionLength?.bucket,
  );
}

function normalizeV2Miss(record, cache) {
  const miss = cache?.missAttribution
    ?? cache?.miss
    ?? record.missAttribution
    ?? record.miss
    ?? null;
  const contributors = miss?.contributing ?? miss?.contributors ?? record.missContributors;
  return {
    attributed: nullableBoolean(miss?.attributed),
    primary: boundedString(miss?.primary ?? miss?.primaryCause ?? record.missPrimary),
    contributing: boundedStringArray(contributors),
    missedTokens: nullableNonnegative(miss?.missedTokens),
    gapMs: nullableNonnegative(miss?.gapMs),
    missingFields: boundedStringArray(miss?.missingFields),
    noiseFloorTokens: nullableNonnegative(miss?.noiseFloorTokens),
  };
}

function normalizeV2ToolOutcome(value) {
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
    exitCode: Number.isSafeInteger(value.exitCode) ? value.exitCode : null,
    cancellationScope: boundedString(value.cancellationScope),
  };
}

function normalizeV2ToolOutcomes(record) {
  const raw = record.toolOutcomes ?? record.toolResults;
  if (!Array.isArray(raw)) return [];
  const outcomes = [];
  for (const value of raw.slice(0, MAX_REPORT_LIST_ITEMS)) {
    const outcome = normalizeV2ToolOutcome(value);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

function normalizeV2ReclaimReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    kind: boundedString(value.kind ?? value.action),
    sourceSseq: Number.isSafeInteger(value.sourceSseq ?? value.sseq) && (value.sourceSseq ?? value.sseq) >= 0
      ? (value.sourceSseq ?? value.sseq)
      : null,
    blockIndex: Number.isSafeInteger(value.blockIndex) && value.blockIndex >= 0 ? value.blockIndex : null,
    originalBytes: nullableNonnegative(value.originalBytes),
    reclaimedBytes: nullableNonnegative(value.reclaimedBytes),
    reclaimedTokens: nullableNonnegative(value.reclaimedTokens),
    originalHash: boundedString(value.originalHash ?? value.originalSha256 ?? value.contentHash),
    stubHash: boundedString(value.stubHash),
    recovery: boundedString(value.recovery),
    status: boundedString(value.status ?? value.result),
  };
}

function normalizeV2ReclaimEvidence(record) {
  const raw = record.reclaimEvidence ?? record.reclaim ?? null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawReceipts = Array.isArray(raw.receipts) ? raw.receipts : Array.isArray(raw.targets) ? raw.targets : [];
  const receipts = rawReceipts.slice(0, MAX_REPORT_LIST_ITEMS).map(normalizeV2ReclaimReceipt).filter(Boolean);
  return {
    attempted: nullableBoolean(raw.attempted ?? raw.planned),
    applied: nullableBoolean(raw.applied),
    recovered: nullableBoolean(raw.recovered),
    reclaimedBytes: nullableNonnegative(raw.reclaimedBytes ?? raw.bytes),
    reclaimedTokens: nullableNonnegative(raw.reclaimedTokens ?? raw.tokens),
    targetCount: Number.isSafeInteger(raw.targetCount) && raw.targetCount >= 0 ? raw.targetCount : null,
    receiptCount: Number.isSafeInteger(rawReceipts.length) ? rawReceipts.length : null,
    omittedReceipts: Math.max(0, rawReceipts.length - MAX_REPORT_LIST_ITEMS),
    revisionId: boundedString(raw.revisionId),
    source: boundedString(raw.source),
    error: boundedString(raw.error),
    receipts,
    targets: receipts,
  };
}

function normalizeV2Attempt(record, index) {
  const cache = record.cache && typeof record.cache === "object" && !Array.isArray(record.cache) ? record.cache : null;
  const usage = {};
  for (const field of ["input", "cacheRead", "cacheWrite", "output", "reasoning"]) usage[field] = v2UsageValue(record, field);
  const cost = record.cost && typeof record.cost === "object" && !Array.isArray(record.cost) ? record.cost : null;
  const revisions = record.revisions && typeof record.revisions === "object" ? record.revisions : null;
  const attemptId = v2RecordId(record, index);
  const unknownReasons = boundedStringArray(cost?.unknownReasons ?? record.unknownReasons);
  const unknownReason = boundedString(cost?.unknownReason ?? record.unknownReason);
  if (unknownReasons.length === 0 && unknownReason !== null) unknownReasons.push(unknownReason);
  const fallbackReason = nonemptyString(record.fallbackReason) ?? nonemptyString(cache?.fallbackReason);
  const effective = normalizeV2Policy(cache?.effective ?? record.effectiveCache);
  const requested = normalizeV2Policy(cache?.requested ?? record.requestedCache);
  const toolNames = boundedStringArray(record.toolNames);
  const markerPositions = Array.isArray(cache?.effective?.markerPositions)
    ? cache.effective.markerPositions.filter((position) => Number.isInteger(position) && position >= 0)
    : Array.isArray(cache?.markerPositions)
      ? cache.markerPositions.filter((position) => Number.isInteger(position) && position >= 0)
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
      markerCount: nullableNonnegative(cache?.effective?.markerCount ?? cache?.markerCount),
      markerPositions,
      rejected: typeof cache?.effective?.rejected === "boolean"
        ? cache.effective.rejected
        : typeof cache?.rejected === "boolean" ? cache.rejected : null,
      fallbackReason: nonemptyString(cache?.effective?.fallbackReason) ?? fallbackReason,
      cacheKeyHash: nonemptyString(cache?.cacheKeyHash),
      modelSettingsHash: nonemptyString(cache?.modelSettingsHash),
      toolsHash: nonemptyString(cache?.toolsHash),
      stablePrefixHash: nonemptyString(cache?.stablePrefixHash),
      reusablePrefixHash: nonemptyString(cache?.reusablePrefixHash),
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
    traceTurn: Number.isInteger(record.traceTurn) ? record.traceTurn : null,
  };
}

function v2CacheGroups(attempts, field) {
  const groups = new Map();
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

function v2EffectivePolicyKey(attempt) {
  const mode = attempt.cache.effective.mode ?? "unknown";
  const ttl = attempt.cache.effective.ttlMs === null ? "unknown" : String(attempt.cache.effective.ttlMs);
  return `${mode}/${ttl}`;
}

function aggregateV2Dimension(attempts, selector) {
  const groups = new Map();
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

function aggregateV2MultiDimension(attempts, selector) {
  const groups = new Map();
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

function aggregateV2ToolOutcomes(attempts) {
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

function aggregateV2Reclaim(attempts) {
  const evidence = attempts.map((attempt) => attempt.reclaimEvidence).filter(Boolean);
  const receipts = evidence.flatMap((item) => item.receipts);
  const boolCounts = (field) => ({
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

function v2TaskOutcomeClass(status, settled) {
  if (!settled) return "unsettled";
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  if (normalized === "success" || normalized === "succeeded" || normalized === "ok") return "success";
  if (["failure", "failed", "error"].includes(normalized)) return "failure";
  if (normalized === "interrupted") return "interrupted";
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["storage-error", "storage_error", "storageerror"].includes(normalized)) return "storage-error";
  return "unknown";
}

function aggregateV2BillingAttempts(attempts, taskGroups, groupPredicate, attemptPredicate = () => true, countMatchingGroups = false) {
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

function v2Diagnostics(records) {
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
      mixedSchemas: false,
      schemaRecords: { legacy: 0, v2: records.length },
    };
}

function summarizeV2Traces(records, label) {
  const v2Records = records.filter(isV2Record);
  const legacyRecords = records.filter((record) => record && typeof record === "object" && record.schemaVersion === undefined);
  const rawAttempts = v2Records.filter((record) => record.recordType === "attempt");
  const settlements = v2Records.filter((record) => record.recordType === "task-settled");
  const attempts = rawAttempts.map(normalizeV2Attempt);
  const mainAttempts = attempts.filter((attempt) => attempt.role === "main");
  const summaryAttempts = attempts.filter((attempt) => attempt.role === "summary");
  const settlementByTask = new Map();
  for (const settlement of settlements) {
    settlementByTask.set(v2CompositeKey(settlement.runId, v2TaskId(settlement)), settlement);
  }

  const taskGroups = new Map();
  const ensureTask = (runId, taskId) => {
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
    const group = ensureTask(settlement.runId, v2TaskId(settlement));
    const outcome = settlement.outcome && typeof settlement.outcome === "object" ? settlement.outcome : null;
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
  const taskIds = new Map();
  for (const group of taskGroups.values()) taskIds.set(group.taskId ?? "unknown", (taskIds.get(group.taskId ?? "unknown") ?? 0) + 1);
  const taskEntries = [...taskGroups.values()].map((group) => {
    const taskId = group.taskId ?? "unknown";
    const key = runIds.size > 1 || (taskIds.get(taskId) ?? 0) > 1
      ? `${group.runId ?? "unknown"}/${taskId}`
      : taskId;
    return [key, group];
  }).sort(([a], [b]) => compareStable(a, b));
  const byTask = Object.fromEntries(taskEntries);
  const attemptIds = new Map();
  for (const attempt of attempts) attemptIds.set(attempt.id, (attemptIds.get(attempt.id) ?? 0) + 1);
  const byId = Object.fromEntries(attempts.map((attempt) => {
    const key = runIds.size > 1 || (attemptIds.get(attempt.id) ?? 0) > 1
      ? `${attempt.runId ?? "unknown"}/${attempt.id}`
      : attempt.id;
    return [key, attempt];
  }).sort(([a], [b]) => compareStable(a, b)));
  const taskStatuses = [...taskGroups.values()].filter((group) => group.settled).map((group) => group.outcomeStatus ?? "unknown");
  const usageMain = aggregateV2Usage(rawAttempts.filter((record) => (nonemptyString(record.role) ?? "unknown") === "main"));
  const usageSummary = aggregateV2Usage(rawAttempts.filter((record) => (nonemptyString(record.role) ?? "unknown") === "summary"));
  const costMain = aggregateV2Cost(rawAttempts.filter((record) => (nonemptyString(record.role) ?? "unknown") === "main"));
  const costSummary = aggregateV2Cost(rawAttempts.filter((record) => (nonemptyString(record.role) ?? "unknown") === "summary"));
  const costMainDetails = aggregateV2CostDetails(mainAttempts);
  const costSummaryDetails = aggregateV2CostDetails(summaryAttempts);
  const tools = mainAttempts.flatMap((attempt) => attempt.toolNames);
  const wasteByCause = Object.create(null);
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
  const ttft = mainAttempts.map((attempt) => attempt.ttftMs).filter((value) => value !== null);
  const turn = mainAttempts.map((attempt) => attempt.turnMs).filter((value) => value !== null);
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
  };
  const cost = {
    main: costMain,
    summary: costSummary,
    usd: costMain.totalUsd,
    measuredTurns: costMain.knownSamples,
    missingTurns: costMain.unknownSamples,
    components: costMainDetails.components,
    unknownReasons: costMainDetails.unknownReasons,
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
  const billing = {
    successfulSettled: aggregateV2BillingAttempts(
      mainAttempts,
      taskGroups,
      (group) => group?.outcomeClass === "success",
      () => true,
      true,
    ),
    failedSettled: aggregateV2BillingAttempts(
      mainAttempts,
      taskGroups,
      (group) => group?.outcomeClass === "failure",
      () => true,
      true,
    ),
    interrupted: aggregateV2BillingAttempts(
      mainAttempts,
      taskGroups,
      (group) => group?.outcomeClass === "interrupted",
      () => true,
      true,
    ),
    cancelled: aggregateV2BillingAttempts(
      mainAttempts,
      taskGroups,
      (group) => group?.outcomeClass === "cancelled",
      () => true,
      true,
    ),
    storageError: aggregateV2BillingAttempts(
      mainAttempts,
      taskGroups,
      (group) => group?.outcomeClass === "storage-error",
      () => true,
      true,
    ),
    unknown: aggregateV2BillingAttempts(
      mainAttempts,
      taskGroups,
      (group) => group?.outcomeClass === "unknown",
      () => true,
      true,
    ),
    unsettled: aggregateV2BillingAttempts(
      mainAttempts,
      taskGroups,
      (group) => group?.outcomeClass === "unsettled",
      () => true,
      true,
    ),
    retries: aggregateV2BillingAttempts(
      mainAttempts,
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
  const perTurn = attempts.map((attempt, index) => ({
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
    totalInput: attempt.usage.input === null || attempt.usage.cacheRead === null || attempt.usage.cacheWrite === null
      ? null
      : attempt.usage.input + attempt.usage.cacheRead + attempt.usage.cacheWrite,
    cacheRead: attempt.usage.cacheRead,
    cachedInputShare: attempt.usage.input !== null && attempt.usage.cacheRead !== null && attempt.usage.cacheWrite !== null
      ? (() => {
        const total = attempt.usage.input + attempt.usage.cacheRead + attempt.usage.cacheWrite;
        return total > 0 ? attempt.usage.cacheRead / total : null;
      })()
      : null,
    cache: attempt.cache,
  }));
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
    },
    cost,
    waste: {
      tokens: Object.values(wasteByCause).reduce((sum, value) => sum + value, 0),
      unknownSamples: wasteUnknownSamples,
      byCause: Object.fromEntries(Object.entries(wasteByCause).sort(([a], [b]) => compareStable(a, b))),
    },
    revisions,
    revisionKinds,
    tools: { calls: tools.length, byName: counts(tools), outcomes: toolOutcomes },
    reclaim,
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
    ignoredLegacyRecords: legacyRecords.length,
    diagnostics: {
      ...v2Diagnostics(records),
      mixedSchemas: legacyRecords.length > 0,
      schemaRecords: {
        legacy: legacyRecords.length,
        v2: v2Records.length,
      },
    },
  };
}

export function summarizeTraces(records, label = "traces") {
  return records.some(isV2Record) ? summarizeV2Traces(records, label) : summarizeLegacyTraces(records, label);
}

function formatMs(value) {
  return value === null ? "--" : `${(value / 1000).toFixed(2)}s`;
}

function formatInt(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatCounts(value) {
  const entries = Object.entries(value);
  return entries.length ? entries.map(([name, count]) => `${name}=${count}`).join(", ") : "none";
}

function formatCacheTurns(turns) {
  const shown = turns.slice(-100);
  const prefix = turns.length > shown.length ? `${turns.length - shown.length} earlier turns omitted; ` : "";
  const values = shown.map((turn) => {
    const share = turn.cachedInputShare === null ? "--" : `${(turn.cachedInputShare * 100).toFixed(1)}%`;
    return `${turn.turn}=${share}`;
  }).join(", ");
  return `${prefix}${values || "none"}`;
}

function formatCacheGroups(groups) {
  return Object.entries(groups).map(([name, group]) => {
    const share = group.cachedInputShare === null ? "--" : `${(group.cachedInputShare * 100).toFixed(1)}%`;
    return `${name}=${share}`;
  }).join(", ") || "none";
}

function formatV2Metric(metric) {
  return `${formatInt(metric.total)} (${metric.knownSamples} known, ${metric.unknownSamples} unknown)`;
}

function formatV2TraceSummary(summary, sourceErrors = []) {
  const main = summary.usage.main;
  const cache = main.cachedInputShare === null ? "--" : `${(main.cachedInputShare * 100).toFixed(1)}%`;
  const diagnostics = summary.diagnostics;
  const lines = [
    summary.label,
    `  tasks: ${summary.tasks.total} total, ${summary.tasks.settled} settled (${summary.tasks.successful} success, ${summary.tasks.failed} failure); attempts: ${summary.attempts.total} (${summary.attempts.retries} retries, ${summary.attempts.fallbacks} fallbacks)`,
    `  turns: ${summary.mainTurns} main, ${summary.summaryCalls} summary (${formatCounts(summary.statuses)})`,
    `  latency: TTFT p50 ${formatMs(summary.latency.p50TtftMs)}, p95 ${formatMs(summary.latency.p95TtftMs)}; turn p50 ${formatMs(summary.latency.p50TurnMs)}, p95 ${formatMs(summary.latency.p95TurnMs)}`,
    `  tokens: input ${formatV2Metric(main.input)}, cache-read ${formatV2Metric(main.cacheRead)}, cache-write ${formatV2Metric(main.cacheWrite)}, output ${formatV2Metric(main.output)}, reasoning ${formatV2Metric(main.reasoning)}; cache ${cache}`,
    `  cost: $${summary.cost.main.totalUsd.toFixed(6)} (${summary.cost.main.knownSamples}/${summary.attempts.main} main attempts measured)`,
    `  diagnostics: retained=${diagnostics.retainedRecords ?? "--"}, omitted=${diagnostics.omittedRecords ?? "--"}, partial=${diagnostics.partialRecords ?? "--"}, malformed=${diagnostics.malformedRecords ?? "--"}, retention-failures=${diagnostics.retentionFailures ?? "--"}, write-failures=${diagnostics.writeFailures ?? "--"}, manifest-write-failures=${diagnostics.manifestWriteFailures ?? "--"}`,
    `  efficiency: ${summary.tools.calls} tool calls, ${summary.revisions} revisions`,
  ];
  if (sourceErrors.length > 0) lines.push(`  warning: ${sourceErrors.length} trace files could not be read`);
  return lines.join("\n");
}

export function formatTraceSummary(summary, sourceErrors = []) {
  if (summary.schemaVersion === TRACE_SCHEMA_VERSION) return formatV2TraceSummary(summary, sourceErrors);
  const cache = summary.usage.cachedInputShare === null ? "--" : `${(summary.usage.cachedInputShare * 100).toFixed(1)}%`;
  const lines = [
    summary.label,
    `  turns: ${summary.mainTurns} main, ${summary.summaryCalls} summary (${formatCounts(summary.statuses)})`,
    `  latency: TTFT p50 ${formatMs(summary.latency.p50TtftMs)}, p95 ${formatMs(summary.latency.p95TtftMs)}; turn p50 ${formatMs(summary.latency.p50TurnMs)}, p95 ${formatMs(summary.latency.p95TurnMs)}`,
    `  tokens: ${formatInt(summary.usage.totalInput)} in (${formatInt(summary.usage.cacheRead)} read, ${formatInt(summary.usage.cacheWrite)} write), ${formatInt(summary.usage.output)} out; cache ${cache}`,
    `  cost: $${summary.cost.usd.toFixed(6)} (${summary.cost.measuredTurns}/${summary.mainTurns} turns measured)`,
    `  waste: ${formatInt(summary.waste.tokens)} (${formatCounts(summary.waste.byCause)})`,
    `  efficiency: ${summary.tools.calls} tool calls, ${summary.revisions} revisions; systems=${summary.systemHashes}`,
    `  cache by turn: ${formatCacheTurns(summary.cache.perTurn)}`,
    `  cache correlation: provider [${formatCacheGroups(summary.cache.byProvider)}]; protocol [${formatCacheGroups(summary.cache.byProtocol)}]; working-set-changed [${formatCacheGroups(summary.cache.byWorkingSetChange)}]`,
    `  cache changes: key [${formatCacheGroups(summary.cache.byCacheKeyChange)}]; settings [${formatCacheGroups(summary.cache.byModelSettingsChange)}]; tools [${formatCacheGroups(summary.cache.byToolsChange)}]; stable-prefix [${formatCacheGroups(summary.cache.byStablePrefixChange)}]`,
  ];
  if (summary.usage.missingTurns > 0) lines.push(`  warning: usage missing for ${summary.usage.missingTurns} main turns`);
  if (sourceErrors.length > 0) lines.push(`  warning: ${sourceErrors.length} trace files could not be read`);
  return lines.join("\n");
}

function defaultDirectories(env) {
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
  return "usage: npm run report:agent-core -- [--json] [trace-directory ...]";
}

export function run(argv = process.argv.slice(2), env = process.env) {
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
  const reports = [];
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
