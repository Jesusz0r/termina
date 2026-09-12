/**
 * Session replay and block recovery.
 *
 * Owns replay state, record application, framed segment reads, bundle
 * replay, and reclaim-block recovery. Split from agent-core/session.ts (issue #38).
 */
import { isRecord } from "../../shared/guards.ts";
import { createHash, type Hash } from "node:crypto";
import { readSync } from "node:fs";
import { combinedSegmentFingerprint, enforceSessionBundleLimit, fingerprintOpenSessionBundle, listCurrentSegments, openStableSessionBundle, recoverActiveSegment, validateOpenSegmentAccess } from "./bundles.ts";
import { closeOpenSessionBundle } from "./descriptors.ts";
import type { OpenSessionBundle, OpenSessionSegment } from "./descriptors.ts";
import { MAX_SESSION_RECORD_BYTES, READ_CHUNK, RECEIPT_ID, UTF8_DECODER, YIELD_EVERY_BYTES, YIELD_EVERY_RECORDS, cancellation, cloneJson, formatStub, inspectEntry, integerAtLeast, parseSessionBundlePath, recoveryKey, sessionBlockBytes, sessionBlockHash, sessionBundleLimit, validateSessionReclaimReceipt, yieldToEventLoop } from "./primitives.ts";
import type { ReplayContent, ReplayMessage, ReplayRecovery, ReplaySessionBundleOptions, ReplayState, SessionOperationOptions, SessionReclaimReceipt, SessionReclaimReceiptTarget, SessionResult } from "./primitives.ts";


function isReplayContent(content: unknown): content is ReplayContent {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.every((block) => {
    return Boolean(block) && typeof block === "object" && !Array.isArray(block) && typeof (block as { type?: unknown }).type === "string";
  });
}


function isThinkingBlock(b: { type?: string }): boolean {
  return b.type === "thinking" || b.type === "redacted_thinking";
}


function blockChars(b: Record<string, unknown>): number {
  if (typeof b.chars === "number") return b.chars;
  if (b.type === "text") return String(b.text ?? "").length;
  if (b.type === "tool_result") return String(b.content ?? "").length;
  if (b.type === "tool_use") return JSON.stringify(b.input ?? {}).length;
  if (b.type === "thinking" || b.type === "redacted_thinking") {
    return String(b.thinking ?? JSON.stringify(b)).length;
  }
  if (b.type === "image") return 8_000;
  return 0;
}


function dropIndexedMessage(state: ReplayState, message: ReplayMessage): void {
  state.bySeq.delete(message.sseq);
}


export function createReplayState(): ReplayState {
  return {
    messages: [],
    bySeq: new Map(),
    recoveries: new Map(),
    receiptRevisionIds: new Set(),
    effort: null,
    model: null,
    lastSeq: 0,
    maxSeq: 0,
  };
}


type PruneTarget = { sseq: number; blockIndex: number; action: "drop" | "stub" };


function commitSequence(state: ReplayState, storageSeq: number): void {
  state.lastSeq = storageSeq;
  state.maxSeq = storageSeq;
}


function normalizePruneTargets(value: unknown): SessionResult<{ targets: PruneTarget[] }> {
  if (!Array.isArray(value)) return { ok: false, error: "invalid prune targets" };
  const targets: PruneTarget[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) || !integerAtLeast(raw.sseq, 1) || !integerAtLeast(raw.blockIndex, 0) || (raw.action !== "drop" && raw.action !== "stub")) {
      return { ok: false, error: "invalid prune target" };
    }
    const target: PruneTarget = { sseq: raw.sseq, blockIndex: raw.blockIndex, action: raw.action };
    const key = `${target.sseq}:${target.blockIndex}`;
    if (seen.has(key)) return { ok: false, error: "duplicate prune target" };
    seen.add(key);
    targets.push(target);
  }
  targets.sort((a, b) => a.sseq - b.sseq || b.blockIndex - a.blockIndex);
  return { ok: true, targets };
}


function samePruneTargets(left: readonly PruneTarget[], right: readonly SessionReclaimReceiptTarget[]): boolean {
  if (left.length !== right.length) return false;
  const a = left.slice().sort((x, y) => x.sseq - y.sseq || x.blockIndex - y.blockIndex);
  const b = right.slice().sort((x, y) => x.sseq - y.sseq || x.blockIndex - y.blockIndex);
  return a.every((target, index) => {
    const receiptTarget = b[index]!;
    return target.sseq === receiptTarget.sseq && target.blockIndex === receiptTarget.blockIndex && target.action === receiptTarget.action;
  });
}


function receiptForPruneRevision(e: {
  targets?: unknown;
  revisionId?: unknown;
}): SessionResult<{ targets: PruneTarget[]; receipt: SessionReclaimReceipt }> {
  const rawTargets = e.targets;
  if (!Array.isArray(rawTargets)) return { ok: false, error: "invalid prune targets" };
  if (typeof e.revisionId !== "string") return { ok: false, error: "invalid recovery receipt revision" };
  const checked = validateSessionReclaimReceipt({ revisionId: e.revisionId, targets: rawTargets });
  if (!checked.ok) return { ok: false, error: "error" in checked ? checked.error : "invalid recovery receipt" };
  const targets = normalizePruneTargets(checked.receipt.targets);
  if (!targets.ok) return { ok: false, error: "error" in targets ? targets.error : "invalid prune targets" };
  if (!samePruneTargets(targets.targets, checked.receipt.targets)) return { ok: false, error: "recovery receipt target mismatch" };
  return { ok: true, targets: targets.targets, receipt: checked.receipt };
}


function applyReceiptPrune(
  state: ReplayState,
  storageSeq: number,
  targets: readonly PruneTarget[],
  receipt: SessionReclaimReceipt,
): SessionResult {
  if (state.receiptRevisionIds.has(receipt.revisionId)) return { ok: false, error: "duplicate recovery revision" };
  const receiptByTarget = new Map<string, SessionReclaimReceiptTarget>();
  for (const target of receipt.targets) receiptByTarget.set(`${target.sseq}:${target.blockIndex}`, target);
  const working = new Map<number, Record<string, unknown>[]>();
  const pendingRecoveries: ReplayRecovery[] = [];

  for (const target of targets) {
    const receiptTarget = receiptByTarget.get(`${target.sseq}:${target.blockIndex}`);
    if (!receiptTarget) return { ok: false, error: "missing recovery receipt target" };
    const message = state.bySeq.get(target.sseq);
    if (!message || typeof message.content === "string") return { ok: false, error: "missing recovery source" };
    let blocks = working.get(target.sseq);
    if (!blocks) {
      blocks = message.content.map((block) => cloneJson(block));
      working.set(target.sseq, blocks);
    }
    const block = blocks[target.blockIndex];
    if (!isRecord(block)) return { ok: false, error: "stale recovery target" };
    const originalBytes = sessionBlockBytes(block);
    const originalHash = sessionBlockHash(block);
    if (
      originalBytes !== receiptTarget.original.bytes ||
      originalHash !== receiptTarget.original.sha256 ||
      blockChars(block) !== receiptTarget.original.chars
    ) {
      return { ok: false, error: "recovery hash mismatch" };
    }
    if (target.action === "stub") {
      if (block.type !== "tool_result" || block.stubbed) return { ok: false, error: "stale recovery target" };
      const stubText = formatStub({
        chars: receiptTarget.original.chars,
        tool: receiptTarget.recovery.tool,
        sseq: message.sseq,
        repro: receiptTarget.recovery.repro ?? undefined,
      });
      const stub: Record<string, unknown> = { ...block, content: stubText, chars: stubText.length, stubbed: true };
      blocks[target.blockIndex] = stub;
    } else {
      if (!isThinkingBlock(block)) return { ok: false, error: "stale recovery target" };
      if (blocks.filter((candidate) => !isThinkingBlock(candidate)).length === 0) {
        return { ok: false, error: "cannot drop the only visible block" };
      }
      blocks.splice(target.blockIndex, 1);
    }
    pendingRecoveries.push({
      ...receiptTarget,
      fallback: "full-read",
      revisionSeq: storageSeq,
      revisionId: receipt.revisionId,
    });
  }

  // Every target and its replacement was validated against the pre-revision
  // view before any visible message is changed.
  for (const [sseq, blocks] of working) {
    const message = state.bySeq.get(sseq);
    if (message) message.content = blocks;
  }
  commitSequence(state, storageSeq);
  state.receiptRevisionIds.add(receipt.revisionId);
  for (const recovery of pendingRecoveries) state.recoveries.set(recoveryKey(recovery), recovery);
  return { ok: true };
}


/** provider/model without whitespace or control characters. */
export function isSessionModel(value: string): boolean {
  if (value.length < 3 || value.length > 200 || /[\x00-\x1f\x7f\s]/.test(value)) return false;
  const cut = value.indexOf("/");
  return cut > 0 && cut < value.length - 1;
}


export function applySessionRecord(state: ReplayState, rec: unknown): SessionResult {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { ok: false, error: "malformed session record" };
  const e = rec as {
    storageSeq?: unknown;
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
    kind?: unknown;
    targets?: unknown;
    revisionId?: unknown;
    dropped?: unknown;
    evicted?: unknown;
    summarySseq?: unknown;
    effort?: unknown;
    model?: unknown;
  };
  if (typeof e.storageSeq !== "number" || !Number.isInteger(e.storageSeq) || e.storageSeq < 1) {
    return { ok: false, error: "invalid storageSeq" };
  }
  if (e.storageSeq <= state.lastSeq) {
    return { ok: false, error: e.storageSeq === state.lastSeq ? "duplicate storageSeq" : "decreasing storageSeq" };
  }
  if (e.type === "checkpoint") {
    if ("message" in e) return { ok: false, error: "checkpoint contains a message" };
    commitSequence(state, e.storageSeq);
    return { ok: true };
  }
  if (e.type === "settings") {
    // Opaque kernel setting; the owner validates the value on apply.
    // Bound the string so a corrupt bundle cannot smuggle bulk data here.
    if ("message" in e) return { ok: false, error: "settings contains a message" };
    if (typeof e.effort !== "string" || e.effort.length < 1 || e.effort.length > 64) {
      return { ok: false, error: "invalid settings effort" };
    }
    state.effort = e.effort;
    if ("model" in e) {
      if (typeof e.model !== "string" || !isSessionModel(e.model)) {
        return { ok: false, error: "invalid settings model" };
      }
      state.model = e.model;
    }
    commitSequence(state, e.storageSeq);
    return { ok: true };
  }
  if (e.type === "message") {
    const role = e.message?.role;
    if (role !== "user" && role !== "assistant") return { ok: false, error: "invalid message role" };
    if (!e.message || !isReplayContent(e.message.content)) return { ok: false, error: "invalid message content" };
    const m: ReplayMessage = { role, content: e.message.content, sseq: e.storageSeq };
    state.messages.push(m);
    state.bySeq.set(m.sseq, m);
    commitSequence(state, e.storageSeq);
    return { ok: true };
  }
  if (e.type === "revision" && e.kind === "prune") {
    const parsed = receiptForPruneRevision(e);
    if (!parsed.ok) return parsed;
    return applyReceiptPrune(state, e.storageSeq, parsed.targets, parsed.receipt);
  }
  if (e.type === "revision" && e.kind === "truncate" && typeof e.dropped === "number") {
    if (!Number.isInteger(e.dropped) || e.dropped < 0 || e.dropped > state.messages.length) {
      return { ok: false, error: "invalid truncate revision" };
    }
    const removed = state.messages.splice(0, e.dropped);
    for (const m of removed) dropIndexedMessage(state, m);
    commitSequence(state, e.storageSeq);
    return { ok: true };
  }
  if (e.type === "revision" && e.kind === "summarize") {
    if (e.summarySseq !== e.storageSeq) {
      return { ok: false, error: "invalid summarize revision" };
    }
    if (typeof e.evicted !== "number" || !Number.isInteger(e.evicted) || e.evicted < 0 || e.evicted > state.messages.length) {
      return { ok: false, error: "invalid summarize revision" };
    }
    if (e.message?.role !== "user" || !isReplayContent(e.message.content)) {
      return { ok: false, error: "invalid summarize handoff" };
    }
    const removed = state.messages.splice(0, e.evicted);
    for (const m of removed) dropIndexedMessage(state, m);
    const handoff: ReplayMessage = { role: "user", content: e.message.content, sseq: e.storageSeq };
    state.messages.unshift(handoff);
    state.bySeq.set(handoff.sseq, handoff);
    commitSequence(state, e.storageSeq);
    return { ok: true };
  }
  return { ok: false, error: "unknown session record type" };
}


type FramedRecord =
  | { ok: true; rec: unknown; bytes: number }
  | { ok: true; skip: true; bytes: number }
  | { ok: false; error: string };


function takeFramedLine(
  pending: Buffer,
  atEnd: boolean,
  allowTruncatedTail: boolean,
): { line: Buffer | null; rest: Buffer; done?: FramedRecord } {
  const nl = pending.indexOf(0x0a);
  if (nl < 0) {
    if (pending.length > MAX_SESSION_RECORD_BYTES) {
      return { line: null, rest: pending, done: { ok: false, error: "oversized session record" } };
    }
    if (atEnd) {
      if (pending.length === 0) return { line: null, rest: pending };
      const parsed = parseFramedLine(pending);
      if (parsed.ok && !("skip" in parsed && parsed.skip)) {
        return { line: null, rest: Buffer.alloc(0), done: parsed };
      }
      if (allowTruncatedTail) return { line: null, rest: Buffer.alloc(0), done: { ok: true, skip: true, bytes: pending.length } };
      return { line: null, rest: pending, done: { ok: false, error: "truncated session record" } };
    }
    return { line: null, rest: pending };
  }
  if (nl + 1 > MAX_SESSION_RECORD_BYTES) {
    return { line: null, rest: pending, done: { ok: false, error: "oversized session record" } };
  }
  const line = pending.subarray(0, nl + 1);
  const rest = pending.subarray(nl + 1);
  return { line, rest };
}


function parseFramedLine(line: Buffer): FramedRecord {
  let text: string;
  try {
    text = UTF8_DECODER.decode(line);
  } catch {
    return { ok: false, error: "invalid UTF-8 session record" };
  }
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.trim() === "") return { ok: true, skip: true, bytes: line.length };
  try {
    return { ok: true, rec: JSON.parse(body) as unknown, bytes: line.length };
  } catch {
    return { ok: false, error: "malformed session record" };
  }
}


async function readSegmentIntoState(
  bundle: OpenSessionBundle,
  segment: OpenSessionSegment,
  readBudget: { remaining: number },
  state: ReplayState | null,
  throughSeq?: number,
  onRecord?: (record: unknown) => void,
  signal?: AbortSignal,
  hash?: Hash,
  skipRecords = false,
): Promise<SessionResult<{ bytes: number; records: number; stop: boolean }>> {
  const cancelledBeforeRead = cancellation(signal);
  if (cancelledBeforeRead) return cancelledBeforeRead;
  const stableBeforeRead = validateOpenSegmentAccess(bundle, segment);
  if (!stableBeforeRead.ok) return stableBeforeRead;
  let pending: Buffer = Buffer.alloc(0);
  const chunk = Buffer.alloc(READ_CHUNK);
  let position = 0;
  let bytes = 0;
  let records = 0;
  let sinceYieldBytes = 0;
  let sinceYieldRecords = 0;
  let stop = skipRecords;
  for (;;) {
    const cancelledBeforeChunk = cancellation(signal);
    if (cancelledBeforeChunk) return cancelledBeforeChunk;
    const remainingSegment = segment.size - position;
    if (remainingSegment < 0 || readBudget.remaining < 0) {
      return { ok: false, error: "session bundle exceeds MAX_SESSION_BUNDLE_BYTES" };
    }
    let n = 0;
    if (remainingSegment > 0) {
      const length = Math.min(chunk.length, remainingSegment, readBudget.remaining);
      if (length < 1) return { ok: false, error: "session bundle exceeds MAX_SESSION_BUNDLE_BYTES" };
      n = readSync(segment.fd, chunk, 0, length, position);
      if (n < 1) return { ok: false, error: `session segment changed while reading: ${segment.name}` };
      position += n;
      readBudget.remaining -= n;
      hash?.update(chunk.subarray(0, n));
    }
    const atEnd = position === segment.size;
    if (!stop && n > 0) pending = Buffer.concat([pending, chunk.subarray(0, n)]);
    for (; !stop;) {
      const nl = pending.indexOf(0x0a);
      if (atEnd && nl < 0 && pending.length > 0) {
        if (pending.length > MAX_SESSION_RECORD_BYTES) {
          return { ok: false, error: "oversized session record" };
        }
        try {
          // Even a crash-truncated tail is decoded strictly. It may be
          // discarded as incomplete, but malformed UTF-8 is never replaced.
          UTF8_DECODER.decode(pending);
        } catch {
          return { ok: false, error: "invalid UTF-8 session record" };
        }
        if (!segment.allowTruncatedTail) return { ok: false, error: "truncated session record" };
        bytes += pending.length;
        pending = Buffer.alloc(0);
        break;
      }
      const taken = takeFramedLine(pending, atEnd && nl < 0, segment.allowTruncatedTail);
      pending = taken.rest;
      const parsed = taken.done ?? (taken.line ? parseFramedLine(taken.line) : null);
      if (taken.done && !taken.done.ok) return taken.done;
      if (!parsed) break;
      if (!parsed.ok) return parsed;
      bytes += parsed.bytes;
      sinceYieldBytes += parsed.bytes;
      if ("skip" in parsed && parsed.skip) {
        if (taken.done) break;
        continue;
      }
      const rec = (parsed as { rec: unknown }).rec;
      const seq = rec && typeof rec === "object" && !Array.isArray(rec) ? (rec as { storageSeq?: unknown }).storageSeq : undefined;
      if (typeof throughSeq === "number" && typeof seq === "number" && seq > throughSeq) {
        stop = true;
        break;
      }
      onRecord?.(rec);
      if (state) {
        const applied = applySessionRecord(state, rec);
        if (!applied.ok) return applied;
      }
      records += 1;
      sinceYieldRecords += 1;
      if (sinceYieldBytes >= YIELD_EVERY_BYTES || sinceYieldRecords >= YIELD_EVERY_RECORDS) {
        sinceYieldBytes = 0;
        sinceYieldRecords = 0;
        await yieldToEventLoop();
        const cancelledAfterYield = cancellation(signal);
        if (cancelledAfterYield) return cancelledAfterYield;
        const stableAfterYield = validateOpenSegmentAccess(bundle, segment);
        if (!stableAfterYield.ok) return stableAfterYield;
      }
      if (taken.done) break;
    }
    if (atEnd) break;
  }
  const stableAfterRead = validateOpenSegmentAccess(bundle, segment);
  if (!stableAfterRead.ok) return stableAfterRead;
  return { ok: true, bytes, records, stop };
}


function applyFramed(state: ReplayState, framed: FramedRecord): SessionResult | "skip" {
  if (!framed.ok) return framed;
  if ("skip" in framed && framed.skip) return "skip";
  if (!("rec" in framed)) return "skip";
  return applySessionRecord(state, framed.rec);
}


export function replaySessionRecords(text: string): SessionResult<{ messages: ReplayMessage[]; maxSeq: number; effort: string | null; model: string | null }> {
  const state = createReplayState();
  const buf = Buffer.from(text, "utf8");
  let pending: Buffer = buf;
  for (;;) {
    const nl = pending.indexOf(0x0a);
    const taken = takeFramedLine(pending, nl < 0, true);
    pending = taken.rest;
    if (taken.done) {
      const applied = applyFramed(state, taken.done);
      if (applied !== "skip" && !applied.ok) return applied;
      break;
    }
    if (!taken.line) break;
    const parsed = parseFramedLine(taken.line);
    const applied = applyFramed(state, parsed);
    if (applied !== "skip" && !applied.ok) return applied;
  }
  return { ok: true, messages: state.messages, maxSeq: state.maxSeq, effort: state.effort, model: state.model };
}


export async function replaySessionBundle(
  sessionFile: string,
  opts?: ReplaySessionBundleOptions,
): Promise<SessionResult<{ messages: ReplayMessage[]; maxSeq: number; state: ReplayState; stopped: boolean; sourceFingerprint: string }>> {
  const limit = sessionBundleLimit(opts);
  if (!limit.ok) return limit;
  const cancelledBeforeReplay = cancellation(opts?.signal);
  if (cancelledBeforeReplay) return cancelledBeforeReplay;
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const project = inspectEntry(parsed.projectDir);
  if (!project) return { ok: false, error: "session project directory is missing" };
  if (project.kind === "symlink") return { ok: false, error: "session project directory is a symlink" };
  if (project.kind !== "dir") return { ok: false, error: "session project path is not a directory" };
  const bundle = inspectEntry(parsed.bundleDir);
  if (!bundle) return { ok: false, error: "session bundle is missing" };
  if (bundle.kind === "symlink") return { ok: false, error: "session bundle is a symlink" };
  if (bundle.kind !== "dir") return { ok: false, error: "session bundle is not a directory" };
  const current = inspectEntry(parsed.currentDir);
  if (!current) return { ok: false, error: "current directory is missing" };
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  let lastRaceError = "session segments changed during replay";
  for (let attempt = 0; attempt < 3; attempt++) {
    const listing = listCurrentSegments(parsed.currentDir);
    if (!listing.ok) return listing;
    const recovered = listing.active ? listing : recoverActiveSegment(parsed.currentDir, parsed.sessionFile);
    if (!recovered.ok) return recovered;
    const withinLimit = enforceSessionBundleLimit(recovered, limit.limit);
    if (!withinLimit.ok) return withinLimit;
    const cancelledBeforeFingerprint = cancellation(opts?.signal);
    if (cancelledBeforeFingerprint) return cancelledBeforeFingerprint;
    const opened = openStableSessionBundle(parsed, recovered, limit.limit, opts);
    if (!opened.ok) {
      if (opened.error.includes("MAX_SESSION_BUNDLE_BYTES")) return opened;
      lastRaceError = opened.error;
      if (attempt < 2) continue;
      return opened;
    }
    try {
      const state = createReplayState();
      const readBudget = { remaining: limit.limit };
      const segmentFingerprints: string[] = [];
      let stopped = false;
      let retry = false;
      for (const segment of opened.bundle.segments) {
        const hash = createHash("sha256");
        const got = await readSegmentIntoState(
          opened.bundle,
          segment,
          readBudget,
          state,
          opts?.throughSeq,
          undefined,
          opts?.signal,
          hash,
          stopped,
        );
        if (!got.ok) {
          if (opts?.signal?.aborted) return got;
          if (got.error.includes("MAX_SESSION_BUNDLE_BYTES")) return got;
          lastRaceError = got.error;
          if (attempt < 2) retry = true;
          else return got;
          break;
        }
        segmentFingerprints.push(hash.digest("hex"));
        stopped ||= got.stop;
      }
      if (retry) continue;
      const parsedIdentity = combinedSegmentFingerprint(opened.bundle, segmentFingerprints);
      if (!parsedIdentity.ok) {
        if (parsedIdentity.error.includes("MAX_SESSION_BUNDLE_BYTES")) return parsedIdentity;
        lastRaceError = parsedIdentity.error;
        if (attempt < 2) continue;
        return parsedIdentity;
      }
      opts?.testHooks?.afterReplayRead?.(opened.bundle.segments.map((segment) => segment.path));
      const cancelledBeforeFinalFingerprint = cancellation(opts?.signal);
      if (cancelledBeforeFinalFingerprint) return cancelledBeforeFinalFingerprint;
      // Keep this independent post-read pass.  Parsing and hashing the same
      // bytes does not prove that no same-size rewrite happened after the
      // parser consumed them; the final pass closes that TOCTOU window.
      const afterIdentity = fingerprintOpenSessionBundle(opened.bundle, limit.limit);
      if (!afterIdentity.ok) {
        if (afterIdentity.error.includes("MAX_SESSION_BUNDLE_BYTES")) return afterIdentity;
        lastRaceError = afterIdentity.error;
        if (attempt < 2) continue;
        return afterIdentity;
      }
      if (parsedIdentity.fingerprint === afterIdentity.fingerprint) {
        return {
          ok: true,
          messages: state.messages,
          maxSeq: state.maxSeq,
          state,
          stopped,
          sourceFingerprint: parsedIdentity.fingerprint,
        };
      }
      lastRaceError = "session segments changed during replay";
    } finally {
      closeOpenSessionBundle(opened.bundle);
    }
  }
  return { ok: false, error: lastRaceError };
}


export type SessionRecoveryTarget = {
  revisionId: string;
  sseq: number;
  blockIndex: number;
};


function validRecoveryTarget(value: unknown): value is SessionRecoveryTarget {
  return (
    isRecord(value) &&
    typeof value.revisionId === "string" &&
    RECEIPT_ID.test(value.revisionId) &&
    integerAtLeast(value.sseq, 1) &&
    integerAtLeast(value.blockIndex, 0)
  );
}


type RecoveryScanResult = SessionResult<{ blocks: Map<string, Record<string, unknown>> }>;


/**
 * Recover a set of blocks with one ordered session scan.  Fork materialization
 * can carry many receipts; indexing by source storage sequence prevents a
 * receipt-by-receipt full-session walk.
 */
export async function recoverSessionBlocks(
  sessionFile: string,
  targets: readonly ReplayRecovery[],
  expectedFingerprint?: string,
  options?: SessionOperationOptions,
): Promise<RecoveryScanResult> {
  const blocks = new Map<string, Record<string, unknown>>();
  if (targets.length === 0) return { ok: true, blocks };
  const limit = sessionBundleLimit(options);
  if (!limit.ok) return limit;
  const cancelledBeforeRecovery = cancellation(options?.signal);
  if (cancelledBeforeRecovery) return cancelledBeforeRecovery;
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const listing = listCurrentSegments(parsed.currentDir);
  if (!listing.ok) return listing;
  const withinLimit = enforceSessionBundleLimit(listing, limit.limit);
  if (!withinLimit.ok) return withinLimit;
  const opened = openStableSessionBundle(parsed, listing, limit.limit, options);
  if (!opened.ok) return opened;
  const beforeFingerprint = fingerprintOpenSessionBundle(opened.bundle, limit.limit);
  if (!beforeFingerprint.ok) {
    closeOpenSessionBundle(opened.bundle);
    return beforeFingerprint;
  }
  if (expectedFingerprint !== undefined && beforeFingerprint.fingerprint !== expectedFingerprint) {
    closeOpenSessionBundle(opened.bundle);
    return { ok: false, error: "session segments changed before recovery" };
  }
  const bySseq = new Map<number, Array<{ key: string; target: ReplayRecovery }>>();
  let maxSseq = 0;
  for (const target of targets) {
    const key = recoveryKey(target);
    const entries = bySseq.get(target.sseq) ?? [];
    entries.push({ key, target });
    bySseq.set(target.sseq, entries);
    if (target.sseq > maxSseq) maxSseq = target.sseq;
  }
  try {
    const readBudget = { remaining: limit.limit };
    for (const segment of opened.bundle.segments) {
      const scanned = await readSegmentIntoState(
        opened.bundle,
        segment,
        readBudget,
        null,
        maxSseq,
        (record) => {
          if (!isRecord(record) || record.type !== "message" || typeof record.storageSeq !== "number") return;
          const entries = bySseq.get(record.storageSeq);
          if (!entries) return;
          const message = record.message;
          if (!isRecord(message) || !Array.isArray(message.content)) return;
          for (const entry of entries) {
            const block = message.content[entry.target.blockIndex];
            if (isRecord(block)) blocks.set(entry.key, cloneJson(block));
          }
        },
        options?.signal,
      );
      if (!scanned.ok) return scanned;
      if (scanned.stop) break;
    }
    const afterFingerprint = fingerprintOpenSessionBundle(opened.bundle, limit.limit);
    if (!afterFingerprint.ok) return afterFingerprint;
    if (
      afterFingerprint.fingerprint !== beforeFingerprint.fingerprint ||
      (expectedFingerprint !== undefined && afterFingerprint.fingerprint !== expectedFingerprint)
    ) {
      return { ok: false, error: "session segments changed during recovery" };
    }
  } finally {
    closeOpenSessionBundle(opened.bundle);
  }
  for (const target of targets) {
    const key = recoveryKey(target);
    const block = blocks.get(key);
    if (!block) return { ok: false, error: "missing source record" };
    const bytes = sessionBlockBytes(block);
    const hash = sessionBlockHash(block);
    if (bytes !== target.original.bytes || hash !== target.original.sha256 || blockChars(block) !== target.original.chars) {
      return { ok: false, error: "recovery hash mismatch" };
    }
  }
  return { ok: true, blocks };
}


/**
 * Recover one pruned block from the original durable message record.
 *
 * The caller may address a target by its original source sequence after a
 * fork.  The receipt's local `sseq` is then used only as the child-record
 * lookup, so recovery does not assume that parent and child sequences match.
 */
export async function recoverSessionBlock(
  sessionFile: string,
  target: unknown,
): Promise<SessionResult<{ block: Record<string, unknown>; recoveredFrom: "source-record"; receipt: ReplayRecovery }>> {
  if (!validRecoveryTarget(target)) return { ok: false, error: "invalid recovery target" };
  const replayed = await replaySessionBundle(sessionFile);
  if (!replayed.ok) return replayed;
  const revisionTargets = [...replayed.state.recoveries.values()].filter((entry) => entry.revisionId === target.revisionId);
  if (revisionTargets.length === 0) return { ok: false, error: "missing recovery receipt" };
  const matched = revisionTargets.find(
    (entry) =>
      entry.blockIndex === target.blockIndex &&
      (entry.sseq === target.sseq || entry.sourceSseq === target.sseq),
  );
  if (!matched) return { ok: false, error: "stale recovery target" };
  const recovered = await recoverSessionBlocks(sessionFile, [matched], replayed.sourceFingerprint);
  if (!recovered.ok) return recovered;
  const original = recovered.blocks.get(recoveryKey(matched));
  if (!original) return { ok: false, error: "missing source record" };
  return { ok: true, block: original, recoveredFrom: "source-record", receipt: matched };
}
