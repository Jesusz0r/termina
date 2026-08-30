/**
 * Pure reclamation planning and receipt construction.
 *
 * This module never appends, replays, or forks a session. It uses the same
 * JSON/hash primitives as the session owner so recovery metadata describes
 * the exact stored block without creating a second durability path.
 */
import {
  MAX_SESSION_RECORD_BYTES,
  sessionBlockBytes,
  sessionBlockHash,
  validateSessionReclaimReceipt,
} from "./session.ts";
import type {
  SessionReclaimOriginal,
  SessionReclaimReceipt,
  SessionReclaimReceiptTarget,
  SessionReclaimRecovery,
} from "./session.ts";

const HIGH_WATER = 0.8;
const LOW_WATER = 0.6;
const PROTECT_TURNS = 2;
const PRUNE_MIN_CHARS = 2_048;
const MAX_RECEIPT_TARGETS = 256;

export type PruneAction = "stub" | "drop";

export type ReclaimMessage = {
  role: string;
  content: unknown;
  sseq: number;
  tokens?: number;
};

export type ReclaimPlanOptions = {
  systemTokens: number;
  toolSchemaTokens?: number;
  usable: number;
  protectTokens: number;
  fillTokens?: number;
};

/** Planner picks add only measurement/recovery context to the session target. */
export type PrunePick = {
  sseq: number;
  sourceSseq?: number;
  blockIndex: number;
  action: PruneAction;
  original: SessionReclaimOriginal;
  reclaimedTokens: number;
  tool?: string;
  repro?: string;
  fallback: SessionReclaimRecovery;
};

export type PruneRevision = SessionReclaimReceipt & {
  type: "revision";
  kind: "prune";
};

export type RecoveryPlan = {
  source: "session-record";
  revisionId: string;
  sseq: number;
  blockIndex: number;
  expectedHash: string;
  expectedBytes: number;
  tool: string;
  repro: string | null;
};

type Block = Record<string, unknown> & { type?: unknown };
type IndexedMessage = ReclaimMessage & { inputIndex: number; messageTokens: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeInteger(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function payloadText(block: Block): string | null {
  try {
    if (block.type === "tool_result") {
      if (typeof block.content === "string") return block.content;
      return block.content === undefined ? null : stableJson(block.content);
    }
    if (block.type === "thinking") {
      if (typeof block.thinking === "string") return block.thinking;
      return block.thinking === undefined ? null : stableJson(block.thinking);
    }
    if (block.type === "redacted_thinking") {
      if (typeof block.thinking === "string") return block.thinking;
      if (block.thinking !== undefined) return stableJson(block.thinking);
      if (block.data !== undefined) return stableJson(block.data);
      return stableJson(block);
    }
  } catch {
    return null;
  }
  return null;
}

/** Mirrors session.ts's blockChars calculation for eligibility and receipts. */
function blockChars(block: Block): number {
  if (typeof block.chars === "number") return block.chars;
  if (block.type === "text") return String(block.text ?? "").length;
  if (block.type === "tool_result") return String(block.content ?? "").length;
  if (block.type === "tool_use") return JSON.stringify(block.input ?? {}).length;
  if (block.type === "thinking" || block.type === "redacted_thinking") return String(block.thinking ?? JSON.stringify(block)).length;
  if (block.type === "image") return 8_000;
  return 0;
}

/** Conservative local estimate; provider usage remains authoritative. */
export function estimateReclaimTokens(value: unknown): number {
  try {
    const text = typeof value === "string" ? value : stableJson(value);
    return text ? Math.ceil(Buffer.byteLength(text, "utf8") / 4) : 0;
  } catch {
    return 0;
  }
}

function isThinkingBlock(block: Block): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

function isUserPrompt(message: IndexedMessage): boolean {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return true;
  return Array.isArray(message.content) && message.content.some((block) =>
    isRecord(block) && (block.type === "text" || block.type === "image"));
}

function normalizeMessages(messages: unknown): IndexedMessage[] | null {
  if (!Array.isArray(messages)) return null;
  const seen = new Set<number>();
  const normalized: IndexedMessage[] = [];
  for (let inputIndex = 0; inputIndex < messages.length; inputIndex++) {
    const message = messages[inputIndex];
    if (!isRecord(message) || typeof message.role !== "string" || !isSafeInteger(message.sseq, 1)) return null;
    if (seen.has(message.sseq)) return null;
    seen.add(message.sseq);
    if (message.tokens !== undefined && !isFiniteNonNegative(message.tokens)) return null;
    const messageTokens = message.tokens === undefined
      ? estimateReclaimTokens(message.content)
      : Math.ceil(message.tokens);
    normalized.push({
      role: message.role,
      content: message.content,
      sseq: message.sseq,
      ...(message.tokens === undefined ? {} : { tokens: message.tokens }),
      inputIndex,
      messageTokens,
    });
  }
  normalized.sort((left, right) => left.sseq - right.sseq || left.inputIndex - right.inputIndex);
  return normalized;
}

function validPlanOptions(opts: unknown): opts is ReclaimPlanOptions {
  if (!isRecord(opts)) return false;
  return isFiniteNonNegative(opts.systemTokens) &&
    isFiniteNonNegative(opts.toolSchemaTokens ?? 0) &&
    isFiniteNonNegative(opts.protectTokens) &&
    isFiniteNonNegative(opts.usable) && opts.usable > 0 &&
    (opts.fillTokens === undefined || isFiniteNonNegative(opts.fillTokens));
}

/**
 * Pick oldest eligible blocks until the low-water mark is projected. Source
 * sequence numbers, not mutable array positions, are the durable addresses.
 */
export function planPruneStubs(messages: ReclaimMessage[], opts: ReclaimPlanOptions | null | undefined): PrunePick[] {
  if (!validPlanOptions(opts)) return [];
  const normalized = normalizeMessages(messages);
  if (!normalized) return [];

  const historyTotal = opts.systemTokens + (opts.toolSchemaTokens ?? 0) +
    normalized.reduce((sum, message) => sum + message.messageTokens, 0);
  const fill = opts.fillTokens ?? historyTotal;
  if (fill < opts.usable * HIGH_WATER) return [];
  const quota = historyTotal - opts.usable * LOW_WATER;
  if (quota <= 0) return [];

  const protectedIndexes = new Set<number>();
  let userTurns = 0;
  let guarded = 0;
  for (let index = normalized.length - 1; index >= 0; index--) {
    const message = normalized[index]!;
    protectedIndexes.add(index);
    guarded += message.messageTokens;
    if (isUserPrompt(message)) {
      userTurns++;
      if (userTurns >= PROTECT_TURNS) break;
    }
  }
  for (let index = normalized.length - 1; index >= 0 && guarded < opts.protectTokens; index--) {
    if (protectedIndexes.has(index)) continue;
    protectedIndexes.add(index);
    guarded += normalized[index]!.messageTokens;
  }

  const picks: PrunePick[] = [];
  // session.ts applies targets in ascending block-index order.  Dropping a
  // block shifts later indexes, so emit at most one drop per message and do
  // not target blocks after that drop in the same revision.
  const dropSelectedByMessage = new Set<number>();
  let reclaimed = 0;
  for (let messageIndex = 0; messageIndex < normalized.length && reclaimed < quota; messageIndex++) {
    if (protectedIndexes.has(messageIndex)) continue;
    const message = normalized[messageIndex]!;
    if (!Array.isArray(message.content)) continue;
    const blocks = message.content as unknown[];
    for (let blockIndex = 0; blockIndex < blocks.length && reclaimed < quota; blockIndex++) {
      if (dropSelectedByMessage.has(message.sseq)) break;
      const rawBlock = blocks[blockIndex];
      if (!isRecord(rawBlock)) continue;
      const block = rawBlock as Block;
      const type = block.type;
      if (type !== "tool_result" && !isThinkingBlock(block)) continue;
      if (type === "tool_result" && block.stubbed) continue;
      if (isThinkingBlock(block) && !blocks.some((candidate) => isRecord(candidate) && !isThinkingBlock(candidate))) continue;
      const payload = payloadText(block);
      if (payload === null || blockChars(block) < PRUNE_MIN_CHARS) continue;
      const originalBytes = sessionBlockBytes(block);
      const originalHash = sessionBlockHash(block);
      if (originalBytes === null || originalHash === null || originalBytes < 1 || originalBytes > MAX_SESSION_RECORD_BYTES) continue;
      const original: SessionReclaimOriginal = {
        type: type as string,
        chars: blockChars(block),
        bytes: originalBytes,
        sha256: originalHash,
      };
      if (original.bytes < original.chars) continue;
      const tool = typeof block.tool === "string" ? block.tool : undefined;
      const repro = typeof block.repro === "string" ? block.repro : undefined;
      const action: PruneAction = isThinkingBlock(block) ? "drop" : "stub";
      const reclaimedTokens = estimateReclaimTokens(payload);
      if (reclaimedTokens <= 0) continue;
      const fallback: SessionReclaimRecovery = {
        source: "session-record",
        tool: tool ?? original.type,
        repro: repro ?? null,
      };
      const candidate: SessionReclaimReceiptTarget = {
        sseq: message.sseq,
        blockIndex,
        action,
        original,
        reclaimedTokens,
        ...(tool === undefined ? {} : { tool }),
        ...(repro === undefined ? {} : { repro }),
        fallback: "full-read",
        revisionId: "planner",
        recovery: fallback,
      };
      // Reuse the durable owner's receipt validator for metadata and address
      // bounds; the planner must never emit a pick that construction rejects.
      if (!validateSessionReclaimReceipt({ revisionId: "planner", targets: [candidate] }).ok) continue;
      picks.push({
        sseq: message.sseq,
        blockIndex,
        action,
        original,
        reclaimedTokens,
        ...(tool ? { tool } : {}),
        ...(repro !== undefined ? { repro } : {}),
        fallback,
      });
      reclaimed += reclaimedTokens;
      if (action === "drop") dropSelectedByMessage.add(message.sseq);
      if (picks.length >= MAX_RECEIPT_TARGETS) return picks;
    }
  }
  return picks;
}

/** Build one bounded durable-owner input; callers must split larger plans. */
export function makePruneRevision(revisionId: string, picks: PrunePick[]): PruneRevision {
  if (!Array.isArray(picks) || picks.length === 0) throw new TypeError("prune revision requires targets");
  if (picks.length > MAX_RECEIPT_TARGETS) throw new RangeError("prune revision exceeds 256 targets; split the plan");
  const targets: SessionReclaimReceiptTarget[] = [];
  for (const pick of picks) {
    if (!isRecord(pick)) throw new TypeError("invalid prune pick");
    const target: SessionReclaimReceiptTarget = {
      sseq: pick.sseq,
      ...(pick.sourceSseq === undefined ? {} : { sourceSseq: pick.sourceSseq }),
      blockIndex: pick.blockIndex,
      action: pick.action,
      original: { ...pick.original },
      reclaimedTokens: pick.reclaimedTokens,
      ...(pick.tool === undefined ? {} : { tool: pick.tool }),
      ...(pick.repro === undefined ? {} : { repro: pick.repro }),
      fallback: "full-read",
      revisionId,
      recovery: {
        source: "session-record",
        tool: pick.fallback?.tool ?? pick.tool ?? pick.original?.type,
        repro: pick.fallback?.repro ?? pick.repro ?? null,
      },
    };
    targets.push(target);
  }
  targets.sort((left, right) => left.sseq - right.sseq || left.blockIndex - right.blockIndex || left.original.sha256.localeCompare(right.original.sha256));
  const revision: PruneRevision = { type: "revision", kind: "prune", revisionId, targets };
  const valid = validateSessionReclaimReceipt(revision);
  if (!valid.ok) throw new TypeError(valid.error);
  return revision;
}

/**
 * Translate a validated target into a source-record recovery request. This is
 * only a pure mapping; session.ts performs the actual read and hash check.
 */
export function recoveryPlan(value: unknown): RecoveryPlan | null {
  if (!isRecord(value)) return null;
  const checked = validateSessionReclaimReceipt({ revisionId: value.revisionId, targets: [value] });
  if (!checked.ok) return null;
  const target = checked.receipt.targets[0];
  if (!target) return null;
  return {
    source: "session-record",
    revisionId: target.revisionId,
    sseq: target.sourceSseq ?? target.sseq,
    blockIndex: target.blockIndex,
    expectedHash: target.original.sha256,
    expectedBytes: target.original.bytes,
    tool: target.recovery.tool,
    repro: target.recovery.repro,
  };
}
