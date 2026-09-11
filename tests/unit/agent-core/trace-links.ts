/** Private retention-aware identity validation for the trace report. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  TRACE_SCHEMA_VERSION,
  validTraceLinkIndex,
  type TraceAttemptIndexEntry,
  type TraceLinkIndex,
} from "../../../agent-core/trace.ts";

/** Unvalidated trace JSON shared with the report builder. */
export type TraceJsonValue = string | number | boolean | null | undefined | TraceJsonObject | TraceJsonValue[];
export type TraceJsonObject = { [key: string]: TraceJsonValue };

/** A trace file the reader or validator rejected. */
export interface TraceFileError {
  file: string;
  error: string;
}

/** Identity health of the retained turn files. */
export type TraceLinkSummary = {
  present: boolean;
  complete: boolean | null;
  errors: number;
  prunedAttemptsReferenced: number;
};

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function knownCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function recordFileName(record: TraceJsonObject): string {
  return Number.isInteger(record.traceTurn) ? `turn-${record.traceTurn}.json` : "<memory>";
}

export function v2CompositeKey(runId: unknown, id: unknown): string {
  return `${runId}\u0000${id}`;
}

function hasUniqueStrings(values: unknown): boolean {
  return Array.isArray(values) && values.every(nonemptyString) && new Set(values).size === values.length;
}

function readTombstones(
  directory: string,
  records: TraceJsonObject[],
  retainedTurns: Set<number>,
  readerOmittedTurns: Set<number>,
): { tombstones: Map<string, TraceAttemptIndexEntry>; index: TraceLinkIndex | null; errors: TraceFileError[] } {
  const tombstones = new Map<string, TraceAttemptIndexEntry>();
  const errors: TraceFileError[] = [];
  let index: TraceLinkIndex | null = null;
  const file = join(directory, "trace-index.json");
  if (existsSync(file)) {
    try {
      if (statSync(file).size > 1024 * 1024) throw new Error("trace link index exceeds 1 MiB");
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!validTraceLinkIndex(value)) throw new Error("invalid trace link index");
      index = value;
      const observedKeys = new Set(records.filter((r) => r.recordType === "attempt")
        .map((r) => v2CompositeKey(r.runId, r.attemptId)));
      for (const entry of index.attempts) {
        const key = v2CompositeKey(entry.runId, entry.attemptId);
        // Index entries prove identity, not usage or outcomes. Never let one
        // resurrect a present-but-invalid record or excuse a missing file
        // which the index still claims is retained.
        if (observedKeys.has(key) || entry.unknown || entry.traceTurn === null || retainedTurns.has(entry.traceTurn)) continue;
        if (entry.retained && (entry.traceTurn === null || !readerOmittedTurns.has(entry.traceTurn))) continue;
        tombstones.set(key, entry);
      }
    } catch (error) {
      errors.push({ file: "trace-index.json", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { tombstones, index, errors };
}

export function validateV2Relationships(
  directory: string,
  records: TraceJsonObject[],
  retainedTurns: Set<number>,
  readerOmittedTurns: Set<number>,
): { records: TraceJsonObject[]; errors: TraceFileError[]; malformedRecords: number; linkIndex: TraceLinkSummary } {
  const { tombstones, index, errors } = readTombstones(directory, records, retainedTurns, readerOmittedTurns);
  const indexErrors = errors.length;
  const prunedReferences = new Set<string>();
  const invalid = new Set<TraceJsonObject>();
  const v2Attempts = records.filter((record) => record.schemaVersion === TRACE_SCHEMA_VERSION && record.recordType === "attempt");
  const v2Settlements = records.filter((record) => record.schemaVersion === TRACE_SCHEMA_VERSION && record.recordType === "task-settled");
  let changed = true;
  while (changed) {
    changed = false;
    const attemptsById = new Map<string, TraceAttemptIndexEntry | TraceJsonObject>(tombstones);
    const settlementsByTask = new Map<string, TraceJsonObject>();
    const duplicateAttemptKeys = new Set<string>();
    const roundInvalid = new Map<TraceJsonObject, string[]>();
    const markInvalid = (record: TraceJsonObject, message: string) => {
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
        if (parent?.taskId === record.taskId && tombstones.has(parentKey)) prunedReferences.add(parentKey);
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
        if (attempt?.taskId === record.taskId && tombstones.has(attemptKey)) prunedReferences.add(attemptKey);
        if (!attempt || attempt.taskId !== record.taskId) {
          markInvalid(record, `attemptIds contains an attempt outside the same run and task: ${id}`);
          break;
        }
      }
      for (const id of summaryIds) {
        const attemptKey = v2CompositeKey(record.runId, id);
        const attempt = attemptsById.get(attemptKey);
        if (attempt?.taskId === record.taskId && tombstones.has(attemptKey)) prunedReferences.add(attemptKey);
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
    linkIndex: { present: index !== null, complete: index?.complete ?? null, errors: indexErrors, prunedAttemptsReferenced: prunedReferences.size },
  };
}
