/**
 * Trace record factories, link validation, and scan support.
 *
 * Owns attempt/settlement factories, link-index validation, and existing-file
 * scanning. Split from agent-core/trace.ts (issue #38).
 */
import { errorCode } from "../../shared/guards.ts";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { cache, cost, criticalClass, freezeDeep, id, nullableInteger, nullableNumber, optionalText, pair, reclaimEvidence, revisions, stringArray, toolOutcomes, usage, parseTraceRecord, validExistingId } from "./normalize.ts";
import { TRACE_FILE_PATTERN, TRACE_SCHEMA_VERSION } from "./schema.ts";
import type { ExistingTraceRole, FrozenTraceAttempt, FrozenTraceManifest, FrozenTraceTaskSettled, TraceAttempt, TraceAttemptInput, TraceManifest, TraceManifestLinkIndex, TraceTaskSettled, TraceTaskSettledInput, TraceWriteFailureKind } from "./schema.ts";


/**
 * Collapse a raw provider failure message to one printable line (max 500
 * chars). Returns null when nothing printable remains — control/binary junk
 * must not reach the trace file or the terminal.
 */
export function sanitizeProviderError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  let sliced = collapsed.slice(0, 500);
  // Never strand a lead surrogate at the cut; lone surrogates in short
  // inputs pass through untouched, as before.
  if (sliced.length === 500 && collapsed.length > 500) {
    const last = sliced.charCodeAt(499);
    if (last >= 0xd800 && last <= 0xdbff) sliced = sliced.slice(0, 499);
  }
  const trimmed = sliced.trim();
  return trimmed || null;
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
    route: optionalText(input.route, "route"),
    model: id(input.model, "model"),
    taskClass: optionalText(input.taskClass, "taskClass"),
    requestedEffort: optionalText(input.requestedEffort, "requestedEffort"),
    effectiveEffort: optionalText(input.effectiveEffort, "effectiveEffort"),
    status: id(input.status, "status"),
    retryCount: nullableInteger(input.retryCount),
    fallbackReason: optionalText(input.fallbackReason, "fallbackReason"),
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
    wasteCause: optionalText(input.wasteCause, "wasteCause"),
    providerError: optionalText(sanitizeProviderError(input.providerError), "providerError"),
  };
  return freezeDeep(record);
}


/** Construct one immutable logical task outcome. */
export function createTaskSettledRecord(input: TraceTaskSettledInput): FrozenTraceTaskSettled {
  const attemptIds = stringArray(input.attemptIds, "attemptIds");
  const summaryAttemptIds = stringArray(input.summaryAttemptIds, "summaryAttemptIds");
  if (new Set(attemptIds).size !== attemptIds.length) throw new Error("attemptIds must contain unique IDs");
  if (new Set(summaryAttemptIds).size !== summaryAttemptIds.length) throw new Error("summaryAttemptIds must contain unique IDs");
  const attemptCount = input.attemptCount === undefined
    ? attemptIds.length
    : nullableInteger(input.attemptCount);
  if (attemptCount === null) throw new Error("attemptCount must be a nonnegative safe integer");
  // Link checks the runtime also enforces (#227): fail at construction with
  // the same messages instead of persisting an unlinkable settlement. The
  // runtime keeps its copies for defense in depth (it accepts frozen records
  // that bypass this factory).
  const known = new Set(attemptIds);
  for (const summaryId of summaryAttemptIds) {
    if (!known.has(summaryId)) throw new Error(`settlement summary does not resolve: ${summaryId}`);
  }
  const finalAttemptId = input.finalAttemptId === null || input.finalAttemptId === undefined
    ? null
    : id(input.finalAttemptId, "finalAttemptId");
  if (finalAttemptId !== null && !known.has(finalAttemptId)) {
    throw new Error(`settlement final attempt does not resolve: ${finalAttemptId}`);
  }
  if (attemptCount < attemptIds.length) throw new Error("settlement attemptCount is smaller than attemptIds.length");
  const record: TraceTaskSettled = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    recordType: "task-settled",
    runId: id(input.runId, "runId"),
    taskId: id(input.taskId, "taskId"),
    taskClass: optionalText(input.taskClass, "taskClass"),
    attemptCount,
    finalAttemptId,
    attemptIds,
    summaryAttemptIds,
    outcome: freezeDeep({
      status: optionalText(input.outcome?.status, "outcome status"),
      criteriaHash: optionalText(input.outcome?.criteriaHash, "outcome criteria hash"),
    }),
    criticalClass: criticalClass(input.criticalClass),
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
  readonly role: ExistingTraceRole;
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
      const value = parseTraceRecord(JSON.parse(textValue));
      if (value === null) {
        malformedRecords++;
        continue;
      }
      if (value.recordType === "attempt") {
        if (value.role === null) {
          malformedRecords++;
          continue;
        }
        validRecords++;
        attempts.push({
          turn: traceTurnFromName(name)!, runId: value.runId, taskId: value.taskId,
          attemptId: value.attemptId, role: value.role,
          parentAttemptId: value.parentAttemptId, retryOfAttemptId: value.retryOfAttemptId,
        });
      } else {
        if (value.attemptIds === null || value.summaryAttemptIds === null) {
          malformedRecords++;
          continue;
        }
        validRecords++;
        settlements.push({
          turn: traceTurnFromName(name)!, runId: value.runId, taskId: value.taskId,
          attemptIds: value.attemptIds, summaryAttemptIds: value.summaryAttemptIds,
          finalAttemptId: value.finalAttemptId,
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
