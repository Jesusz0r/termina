/**
 * Trace record factories, link validation, and scan support.
 *
 * Owns attempt/settlement factories, link-index validation, existing-file
 * scanning, and atomic-write helpers. Split from agent-core/trace.ts (issue #38).
 */
import { errorCode, isRecord } from "../../shared/guards.ts";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { cache, cost, freezeDeep, id, nullableInteger, nullableNumber, optionalText, pair, reclaimEvidence, revisions, stringArray, text, toolOutcomes, usage } from "./normalize.ts";
import { MAX_ARRAY_ITEMS, MAX_ID_CHARS, MAX_TRACE_INDEX_ENTRIES, TRACE_FILE_PATTERN, TRACE_SCHEMA_VERSION } from "./schema.ts";
import type { FrozenTraceAttempt, FrozenTraceManifest, FrozenTraceTaskSettled, TraceAttempt, TraceAttemptInput, TraceLinkIndex, TraceManifest, TraceManifestLinkIndex, TraceRole, TraceTaskSettled, TraceTaskSettledInput, TraceWriteFailureKind } from "./schema.ts";


/**
 * Collapse a raw provider failure message to one printable line (max 500
 * chars). Returns null when nothing printable remains — control/binary junk
 * must not reach the trace file or the terminal.
 */
export function sanitizeProviderError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  const sliced = collapsed.slice(0, 500).trim();
  return sliced || null;
}


/** Construct one immutable provider-call attempt without inventing task facts. */
export function createAttemptRecord(input: TraceAttemptInput): FrozenTraceAttempt {
  if (input.role !== "main" && input.role !== "summary") {
    throw new Error("role must be main or summary");
  }
  const record: TraceAttempt = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    recordType: "attempt",
    runId: id(input.runId, "runId"),
    taskId: id(input.taskId, "taskId"),
    attemptId: id(input.attemptId, "attemptId"),
    parentAttemptId: input.parentAttemptId === null || input.parentAttemptId === undefined ? null : id(input.parentAttemptId, "parentAttemptId"),
    retryOfAttemptId: input.retryOfAttemptId === null || input.retryOfAttemptId === undefined ? null : id(input.retryOfAttemptId, "retryOfAttemptId"),
    role: input.role,
    provider: id(input.provider, "provider"),
    protocol: id(input.protocol, "protocol"),
    route: input.route === null || input.route === undefined ? null : text(input.route, "route"),
    model: id(input.model, "model"),
    taskClass: input.taskClass === null || input.taskClass === undefined ? null : text(input.taskClass, "taskClass"),
    requestedEffort: input.requestedEffort === null || input.requestedEffort === undefined ? null : text(input.requestedEffort, "requestedEffort"),
    effectiveEffort: input.effectiveEffort === null || input.effectiveEffort === undefined ? null : text(input.effectiveEffort, "effectiveEffort"),
    status: id(input.status, "status"),
    retryCount: nullableInteger(input.retryCount),
    fallbackReason: input.fallbackReason === null || input.fallbackReason === undefined ? null : text(input.fallbackReason, "fallbackReason"),
    storageSeqRange: pair(input.storageSeqRange, "storageSeqRange"),
    toolNames: stringArray(input.toolNames, "toolNames"),
    startedAtMs: nullableNumber(input.startedAtMs),
    endedAtMs: nullableNumber(input.endedAtMs),
    ttftMs: nullableNumber(input.ttftMs),
    turnMs: nullableNumber(input.turnMs),
    usage: usage(input.usage),
    cost: cost(input.cost),
    cache: cache(input.cache),
    toolOutcomes: toolOutcomes(input.toolOutcomes),
    reclaimEvidence: reclaimEvidence(input.reclaimEvidence),
    revisions: revisions(input.revisions),
    wasteTokens: nullableNumber(input.wasteTokens),
    wasteCause: input.wasteCause === null || input.wasteCause === undefined ? null : text(input.wasteCause, "wasteCause"),
    providerError: optionalText(sanitizeProviderError(input.providerError), "providerError"),
  };
  return freezeDeep(record);
}


/** Construct one immutable logical task outcome; correctness is caller-supplied. */
export function createTaskSettledRecord(input: TraceTaskSettledInput): FrozenTraceTaskSettled {
  const attemptIds = stringArray(input.attemptIds, "attemptIds");
  const summaryAttemptIds = stringArray(input.summaryAttemptIds, "summaryAttemptIds");
  if (new Set(attemptIds).size !== attemptIds.length) throw new Error("attemptIds must contain unique IDs");
  if (new Set(summaryAttemptIds).size !== summaryAttemptIds.length) throw new Error("summaryAttemptIds must contain unique IDs");
  const attemptCount = input.attemptCount === undefined
    ? attemptIds.length
    : nullableInteger(input.attemptCount);
  if (attemptCount === null) throw new Error("attemptCount must be a nonnegative safe integer");
  const record: TraceTaskSettled = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    recordType: "task-settled",
    runId: id(input.runId, "runId"),
    taskId: id(input.taskId, "taskId"),
    taskClass: input.taskClass === null || input.taskClass === undefined ? null : text(input.taskClass, "taskClass"),
    attemptCount,
    finalAttemptId: input.finalAttemptId === null || input.finalAttemptId === undefined ? null : id(input.finalAttemptId, "finalAttemptId"),
    attemptIds,
    summaryAttemptIds,
    outcome: freezeDeep({
      status: text(input.outcome?.status, "outcome status"),
      correctness: text(input.outcome?.correctness, "outcome correctness"),
      criteriaHash: text(input.outcome?.criteriaHash, "outcome criteria hash"),
    }),
  };
  return freezeDeep(record);
}


export function timestamp(now: (() => string | number | Date) | undefined): string {
  const value = now ? now() : new Date();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString();
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }
  return typeof value === "string" && validExistingId(value) ? value : new Date(0).toISOString();
}


export function traceTurnFromName(name: string): number | null {
  const match = TRACE_FILE_PATTERN.exec(name);
  if (!match) return null;
  const turn = Number(match[1]);
  return Number.isSafeInteger(turn) && turn > 0 ? turn : null;
}


function likelyPartial(textValue: string): boolean {
  const value = textValue.trim();
  if (value.length === 0) return true;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let rootComplete = false;
  for (const character of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (rootComplete && !/\s/.test(character)) return false;
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      if (rootComplete) return false;
      stack.push(character);
    } else if (character === "}" || character === "]") {
      const opening = stack.pop();
      if ((character === "}" && opening !== "{") || (character === "]" && opening !== "[")) return false;
      if (stack.length === 0) rootComplete = true;
    }
  }
  if (inString || escaped) return true;
  if (stack.length === 0) return false;
  const last = value[value.length - 1]!;
  return "{[,:}]".includes(last) || /[0-9eE+\-\.]/.test(last) || /[tTfFnNuUrRaAlLsSe]/.test(last);
}


type ExistingFileInfo = {
  readonly names: string[];
  readonly maxTurn: number;
  readonly malformedRecords: number;
  readonly partialRecords: number;
  readonly scanOmittedRecords: number;
  readonly validRecords: number;
};


type ExistingAttempt = {
  readonly turn: number;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly role: TraceRole;
  readonly parentAttemptId: string | null;
  readonly retryOfAttemptId: string | null;
};


type ExistingSettlement = {
  readonly turn: number;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptIds: readonly string[];
  readonly summaryAttemptIds: readonly string[];
  readonly finalAttemptId: string | null;
};


export type ExistingScan = ExistingFileInfo & {
  readonly attempts: readonly ExistingAttempt[];
  readonly settlements: readonly ExistingSettlement[];
};


function existingStringArray(value: unknown): { valid: boolean; values: string[] } {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return { valid: false, values: [] };
  const values: string[] = [];
  for (const item of value) {
    if (!validExistingId(item)) return { valid: false, values: [] };
    values.push(item);
  }
  return { valid: true, values };
}


function validTraceTurn(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}


export function validTraceLinkIndex(value: unknown): value is TraceLinkIndex {
  if (!isRecord(value) || value.schemaVersion !== TRACE_SCHEMA_VERSION || value.kind !== "trace-link-index" ||
    typeof value.complete !== "boolean" || !validExistingId(value.updatedAt) ||
    !Array.isArray(value.attempts) || !Array.isArray(value.settlements) ||
    value.attempts.length > MAX_TRACE_INDEX_ENTRIES || value.settlements.length > MAX_TRACE_INDEX_ENTRIES ||
    value.attempts.length + value.settlements.length > MAX_TRACE_INDEX_ENTRIES) return false;
  const attemptKeys = new Set<string>();
  for (const item of value.attempts) {
    if (!isRecord(item) || !validExistingId(item.runId) || !validExistingId(item.taskId) || !validExistingId(item.attemptId) ||
      (item.role !== "main" && item.role !== "summary") || typeof item.retained !== "boolean" ||
      !validTraceTurn(item.traceTurn) || typeof item.unknown !== "boolean") return false;
    const key = compositeKey(item.runId, item.attemptId);
    if (attemptKeys.has(key)) return false;
    attemptKeys.add(key);
  }
  const settlementKeys = new Set<string>();
  for (const item of value.settlements) {
    const attemptIds = existingStringArray(item && isRecord(item) ? item.attemptIds : undefined);
    const summaryAttemptIds = existingStringArray(item && isRecord(item) ? item.summaryAttemptIds : undefined);
    if (!isRecord(item) || !validExistingId(item.runId) || !validExistingId(item.taskId) ||
      !attemptIds.valid || !summaryAttemptIds.valid ||
      (item.finalAttemptId !== null && item.finalAttemptId !== undefined && !validExistingId(item.finalAttemptId)) ||
      typeof item.retained !== "boolean" || !validTraceTurn(item.traceTurn) || typeof item.unknown !== "boolean") return false;
    if (new Set(attemptIds.values).size !== attemptIds.values.length ||
      new Set(summaryAttemptIds.values).size !== summaryAttemptIds.values.length ||
      summaryAttemptIds.values.some((idValue) => !attemptIds.values.includes(idValue)) ||
      (item.finalAttemptId !== null && item.finalAttemptId !== undefined && !attemptIds.values.includes(item.finalAttemptId))) return false;
    const key = taskKey(item.runId, item.taskId);
    if (settlementKeys.has(key)) return false;
    settlementKeys.add(key);
  }
  return true;
}


export async function inspectExisting(directory: string, maxScanFiles: number, maxRecordBytes: number): Promise<ExistingScan> {
  let names: string[];
  try {
    names = (await readdir(directory))
      .map((name) => ({ name, turn: traceTurnFromName(name) }))
      .filter((item): item is { name: string; turn: number } => item.turn !== null)
      .sort((left, right) => left.turn - right.turn || left.name.localeCompare(right.name))
      .map((item) => item.name);
  } catch {
    return { names: [], maxTurn: 0, malformedRecords: 0, partialRecords: 0, scanOmittedRecords: 0, validRecords: 0, attempts: [], settlements: [] };
  }
  const selected = names.slice(-maxScanFiles);
  const scanOmittedRecords = Math.max(0, names.length - selected.length);
  let malformedRecords = 0;
  let partialRecords = 0;
  let validRecords = 0;
  const attempts: ExistingAttempt[] = [];
  const settlements: ExistingSettlement[] = [];
  for (const name of selected) {
    try {
      const file = join(directory, name);
      if ((await stat(file)).size > maxRecordBytes) {
        malformedRecords++;
        continue;
      }
      const textValue = await readFile(file, "utf8");
      const value = JSON.parse(textValue) as unknown;
      if (!isRecord(value) || value.schemaVersion !== TRACE_SCHEMA_VERSION ||
        (value.recordType !== "attempt" && value.recordType !== "task-settled") ||
        !validExistingId(value.runId) || !validExistingId(value.taskId)) {
        malformedRecords++;
        continue;
      }
      if (value.recordType === "attempt") {
        const parentAttemptId = value.parentAttemptId === null || value.parentAttemptId === undefined
          ? null
          : validExistingId(value.parentAttemptId) ? value.parentAttemptId : undefined;
        const retryOfAttemptId = value.retryOfAttemptId === null || value.retryOfAttemptId === undefined
          ? null
          : validExistingId(value.retryOfAttemptId) ? value.retryOfAttemptId : undefined;
        if (!validExistingId(value.attemptId) || (value.role !== "main" && value.role !== "summary") ||
          parentAttemptId === undefined || retryOfAttemptId === undefined) {
          malformedRecords++;
          continue;
        }
        validRecords++;
        attempts.push({
          turn: traceTurnFromName(name)!,
          runId: value.runId,
          taskId: value.taskId,
          attemptId: value.attemptId,
          role: value.role,
          parentAttemptId,
          retryOfAttemptId,
        });
      } else {
        const attemptIds = existingStringArray(value.attemptIds);
        const summaryAttemptIds = existingStringArray(value.summaryAttemptIds);
        const finalAttemptId = value.finalAttemptId === null || value.finalAttemptId === undefined
          ? null
          : validExistingId(value.finalAttemptId) ? value.finalAttemptId : undefined;
        if (!attemptIds.valid || !summaryAttemptIds.valid || finalAttemptId === undefined) {
          malformedRecords++;
          continue;
        }
        validRecords++;
        settlements.push({
          turn: traceTurnFromName(name)!,
          runId: value.runId,
          taskId: value.taskId,
          attemptIds: attemptIds.values,
          summaryAttemptIds: summaryAttemptIds.values,
          finalAttemptId,
        });
      }
    } catch (error) {
      malformedRecords++;
      /* Syntax errors are the only errors for which truncation is knowable. */
      if (error instanceof SyntaxError) {
        try {
          const textValue = await readFile(join(directory, name), "utf8");
          if (likelyPartial(textValue)) partialRecords++;
        } catch {
          /* The malformed file remains accounted for even when it disappears. */
        }
      }
    }
  }
  const maxTurn = names.reduce((max, name) => Math.max(max, traceTurnFromName(name) ?? 0), 0);
  return { names, maxTurn, malformedRecords, partialRecords, scanOmittedRecords, validRecords, attempts, settlements };
}


export function stableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


export function retryableFailureKind(kind: TraceWriteFailureKind): boolean {
  return kind === "write-failure" || kind === "manifest-write-failure" || kind === "retention-failure" ||
    kind === "index-write-failure" || kind === "queue-full";
}


export async function countTurnFiles(directory: string): Promise<number> {
  try {
    return (await readdir(directory)).reduce((count, name) => count + (traceTurnFromName(name) === null ? 0 : 1), 0);
  } catch {
    return 0;
  }
}


export async function newestTurnFiles(directory: string): Promise<Array<{ name: string; turn: number }>> {
  try {
    return (await readdir(directory))
      .map((name) => ({ name, turn: traceTurnFromName(name) }))
      .filter((item): item is { name: string; turn: number } => item.turn !== null)
      .sort((left, right) => left.turn - right.turn || left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}


export function normalizeNamespace(value: string | undefined, directory: string): string {
  const candidate = (value ?? basename(directory)) || "trace";
  return id(candidate, "namespace");
}


export function emptyManifestLinkIndex(path: string): TraceManifestLinkIndex {
  return {
    path,
    complete: false,
    attempts: 0,
    settlements: 0,
    unknown: 0,
    writeFailures: 0,
    error: null,
  };
}


export function freezeManifest(manifest: TraceManifest): FrozenTraceManifest {
  return freezeDeep(manifest);
}


export function emptyExistingScan(): ExistingScan {
  return {
    names: [],
    maxTurn: 0,
    malformedRecords: 0,
    partialRecords: 0,
    scanOmittedRecords: 0,
    validRecords: 0,
    attempts: [],
    settlements: [],
  };
}


export function compositeKey(runId: string, idValue: string): string {
  return `${runId}\u0000${idValue}`;
}


export function taskKey(runId: string, taskId: string): string {
  return compositeKey(runId, taskId);
}


export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}


function validExistingId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
}


export function nonnegativeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}


export function validPriorManifest(value: unknown): value is TraceManifest {
  if (!isRecord(value) || value.schemaVersion !== TRACE_SCHEMA_VERSION || value.kind !== "trace-manifest") return false;
  for (const field of [
    "retainedRecords",
    "omittedRecords",
    "writeFailures",
    "malformedRecords",
    "partialRecords",
    "scanOmittedRecords",
    "manifestErrors",
    "retentionFailures",
    "manifestWriteFailures",
    "indexWriteFailures",
    "lastTraceTurn",
  ]) {
    if (!nonnegativeCounter(value[field])) return false;
  }
  if (!validExistingId(value.updatedAt)) return false;
  if (!isRecord(value.startup) || !validExistingId(value.startup.namespace) ||
    !validExistingId(value.startup.startedAt) || !isRecord(value.startup.reset) ||
    typeof value.startup.reset.requested !== "boolean" || typeof value.startup.reset.applied !== "boolean" ||
    !nonnegativeCounter(value.startup.reset.omittedRecords) || !nonnegativeCounter(value.startup.reset.failedRecords) ||
    !nonnegativeCounter(value.startup.preexistingRecords) ||
    !nonnegativeCounter(value.startup.preexistingMalformedRecords) ||
    !nonnegativeCounter(value.startup.preexistingPartialRecords) ||
    !nonnegativeCounter(value.startup.preexistingScanOmittedRecords) ||
    (value.startup.error !== null && typeof value.startup.error !== "string")) return false;
  if (!isRecord(value.linkIndex) || typeof value.linkIndex.path !== "string" || value.linkIndex.path.length === 0 ||
    typeof value.linkIndex.complete !== "boolean" || !nonnegativeCounter(value.linkIndex.attempts) ||
    !nonnegativeCounter(value.linkIndex.settlements) || !nonnegativeCounter(value.linkIndex.unknown) ||
    !nonnegativeCounter(value.linkIndex.writeFailures) ||
    (value.linkIndex.error !== null && typeof value.linkIndex.error !== "string")) return false;
  return true;
}
