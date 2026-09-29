/** Stored session JSON admission. Preserve block bytes and key order for receipts. */
import { isRecord } from "../../shared/guards.ts";
import { integerAtLeast, validateSessionReclaimReceipt } from "./primitives.ts";
import type { SessionReclaimReceipt, SessionResult } from "./primitives.ts";

export type SessionBlock = Record<string, unknown> & { type: string };
export type ReplayContent = string | SessionBlock[];
export type ReplayMessage = {
  role: "user" | "assistant";
  content: ReplayContent;
  sseq: number;
  tokens?: number;
};

export function parseSessionBlock(value: unknown): SessionBlock | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return { ...value, type: value.type };
}

function parseContent(value: unknown): ReplayContent | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const blocks: SessionBlock[] = [];
  for (const raw of value) {
    const block = parseSessionBlock(raw);
    if (!block) return null;
    blocks.push(block);
  }
  return blocks;
}

/** In-memory messages carry sseq. Stored records supply it as storageSeq. */
export function parseSessionMessage(value: unknown, storageSeq?: number): SessionResult<{ message: ReplayMessage }> {
  if (!isRecord(value)) return { ok: false, error: "invalid message role" };
  const { role, content: rawContent, tokens } = value;
  const sseq = storageSeq ?? value.sseq;
  if (role !== "user" && role !== "assistant") return { ok: false, error: "invalid message role" };
  if (!integerAtLeast(sseq, 1)) return { ok: false, error: "invalid message sseq" };
  const content = parseContent(rawContent);
  if (content === null) return { ok: false, error: "invalid message content" };
  if (tokens !== undefined && !integerAtLeast(tokens, 0)) return { ok: false, error: "invalid message tokens" };
  return { ok: true, message: { role, content, sseq, ...(tokens === undefined ? {} : { tokens }) } };
}

export type StoredSessionRecord =
  | { type: "checkpoint"; storageSeq: number }
  | { type: "settings"; storageSeq: number; effort: string; model?: string }
  | { type: "message"; storageSeq: number; message: ReplayMessage }
  | { type: "revision"; kind: "prune"; storageSeq: number; receipt: SessionReclaimReceipt }
  | { type: "revision"; kind: "truncate"; storageSeq: number; dropped: number; message?: ReplayMessage }
  | { type: "revision"; kind: "summarize"; storageSeq: number; evicted: number; message: ReplayMessage };

/** provider/model without whitespace or control characters. */
export function isSessionModel(value: string): boolean {
  if (value.length < 3 || value.length > 200 || /[\x00-\x1f\x7f\s]/.test(value)) return false;
  const cut = value.indexOf("/");
  return cut > 0 && cut < value.length - 1;
}

/** A future sequence ends a prefix read before its payload is interpreted. */
export function parseStoredSessionRecord(value: unknown, throughSeq?: number): SessionResult<{ record: StoredSessionRecord | null }> {
  if (!isRecord(value)) return { ok: false, error: "malformed session record" };
  const { storageSeq, type, message, kind, effort, model, dropped, evicted, summarySseq } = value;
  if (!integerAtLeast(storageSeq, 1)) return { ok: false, error: "invalid storageSeq" };
  if (throughSeq !== undefined && storageSeq > throughSeq) return { ok: true, record: null };
  if (type === "checkpoint") {
    if ("message" in value) return { ok: false, error: "checkpoint contains a message" };
    return { ok: true, record: { type, storageSeq } };
  }
  if (type === "settings") {
    if ("message" in value) return { ok: false, error: "settings contains a message" };
    if (typeof effort !== "string" || !effort || effort.length > 64) return { ok: false, error: "invalid settings effort" };
    if ("model" in value && (typeof model !== "string" || !isSessionModel(model))) return { ok: false, error: "invalid settings model" };
    return { ok: true, record: { type, storageSeq, effort, ...(typeof model === "string" ? { model } : {}) } };
  }
  if (type === "message") {
    const parsed = parseSessionMessage(message, storageSeq);
    if (!parsed.ok) return parsed;
    return { ok: true, record: { type, storageSeq, message: parsed.message } };
  }
  if (type !== "revision") return { ok: false, error: "unknown session record type" };
  if (kind === "prune") {
    const checked = validateSessionReclaimReceipt({ revisionId: value.revisionId, targets: value.targets });
    if (!checked.ok) return checked;
    return { ok: true, record: { type, kind, storageSeq, receipt: checked.receipt } };
  }
  if (kind === "truncate") {
    if (!integerAtLeast(dropped, 0)) return { ok: false, error: "invalid truncate revision" };
    let handoff: ReplayMessage | undefined;
    if (message) {
      if (summarySseq !== storageSeq) return { ok: false, error: "invalid truncate revision" };
      const parsed = parseSessionMessage(message, storageSeq);
      if (!parsed.ok || parsed.message.role !== "user") return { ok: false, error: "invalid truncate handoff" };
      handoff = parsed.message;
    }
    return { ok: true, record: { type, kind, storageSeq, dropped, ...(handoff ? { message: handoff } : {}) } };
  }
  if (kind === "summarize") {
    if (summarySseq !== storageSeq || !integerAtLeast(evicted, 0)) return { ok: false, error: "invalid summarize revision" };
    const parsed = parseSessionMessage(message, storageSeq);
    if (!parsed.ok || parsed.message.role !== "user") return { ok: false, error: "invalid summarize handoff" };
    return { ok: true, record: { type, kind, storageSeq, evicted, message: parsed.message } };
  }
  return { ok: false, error: "unknown session record type" };
}

/** Arbitrary tool arguments remain JSON, not a second schema vocabulary. */
export function sessionToolInputs(block: SessionBlock): { input: Record<string, unknown> | null; arguments: Record<string, unknown> | null } {
  const { input, arguments: args } = block;
  return { input: isRecord(input) ? input : null, arguments: isRecord(args) ? args : null };
}

export type SessionContentPart = {
  type: string | null;
  text: string | null;
  source: { type: "file"; name: unknown } | null;
};

/** Tool-result parts may be text or images. Do not normalize their stored JSON. */
export function sessionContentParts(block: SessionBlock): SessionContentPart[] {
  const rawParts = block.type === "tool_result" && Array.isArray(block.content) ? block.content : [block];
  const parts: SessionContentPart[] = [];
  for (const value of rawParts) {
    if (!isRecord(value)) continue;
    const { type, text, source } = value;
    parts.push({
      type: typeof type === "string" ? type : null,
      text: typeof text === "string" ? text : null,
      source: isRecord(source) && source.type === "file" ? { type: "file", name: source.name } : null,
    });
  }
  return parts;
}
