/**
 * Phase 3: child approval requests and parent-to-child inbox I/O.
 *
 * The headless child cannot show a picker, so bash approvals round-trip
 * through files: the child writes an approval request and waits on the ack
 * channel (waitForAck); the parent surfaces pending requests in its own
 * choice picker (Deny / Approve once — never Always) and writes the ack.
 * No ack, a stale request, or no parent surface all mean deny.
 * Parent-to-child messages ride a per-run inbox file the child drains on
 * every model turn.
 *
 * Owns its own atomic JSON writer so approval/inbox files never share a
 * write path with task/result handoffs. Public symbols are re-exported
 * from `agent-core/subagents.ts`.
 */

import { readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBoundedRegularFile } from "../main/files.ts";
import {
  MAX_SUBAGENT_FILE_BYTES,
  MAX_SUBAGENT_INBOX_MSGS,
  MAX_SUBAGENT_MESSAGE_CHARS,
} from "../subagents.ts";

/** How long a child waits for a parent approval before denying. */
export const SUBAGENT_APPROVAL_TIMEOUT_MS = 120_000;

/** Parent poll cadence while a run is active, so a mid-stream child request
 *  surfaces in seconds instead of waiting for the parent turn to end. */
export const SUBAGENT_APPROVAL_POLL_MS = 1000;

/** Operator/test override; clamps to 1s..1h, else the default. */
export function subagentApprovalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TERMINA_SUBAGENT_APPROVAL_TIMEOUT_MS ?? "");
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 3600_000) return raw;
  return SUBAGENT_APPROVAL_TIMEOUT_MS;
}

const TERMINAL_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_RE = /^bg-\d{1,10}$/;
const REQ_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Atomic JSON write (tmp + rename) so waiters see complete files or none. */
function atomicWriteJsonSync(dir: string, name: string, body: string): boolean {
  try {
    const target = join(dir, name);
    const temp = `${target}.${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}.tmp`;
    writeFileSync(temp, body, { mode: 0o600 });
    renameSync(temp, target);
    return true;
  } catch {
    return false;
  }
}

export type SubagentApprovalKind = "bash" | "protected";

export interface SubagentApprovalRequest {
  version: 1;
  runId: string;
  kind: SubagentApprovalKind;
  /** Command for bash, project-relative path for protected. */
  text: string;
  createdAt: number;
}

export function subagentApprovalRequestName(parentTerminalId: string, runId: string, reqId: string): string | null {
  if (!TERMINAL_RE.test(parentTerminalId) || !RUN_RE.test(runId) || !REQ_RE.test(reqId)) return null;
  return `subagent-${parentTerminalId}-${runId}.approval-${reqId}.json`;
}

/**
 * Delete one terminal's approval request files (called on `/clear` so a new
 * session never re-offers approvals for killed children). Returns the count
 * removed. Runs themselves stay for reconcile to settle via killed results.
 */
export function clearSubagentApprovalFiles(dir: string, terminalId: string): number {
  if (!dir || !TERMINAL_RE.test(terminalId)) return 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const prefix = `subagent-${terminalId}-`;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.includes(".approval-")) continue;
    if (!parseSubagentApprovalName(terminalId, name)) continue;
    try {
      rmSync(join(dir, name));
      removed += 1;
    } catch {
      /* Dead letter stays for the startup sweep. */
    }
  }
  return removed;
}

/** Parse one approval request filename. Pure and unit-tested. */
export function parseSubagentApprovalName(
  terminalId: string,
  name: string,
): { runId: string; reqId: string } | null {
  const prefix = `subagent-${terminalId}-`;
  if (!name.startsWith(prefix)) return null;
  const match = /^(bg-\d{1,10})\.approval-([A-Za-z0-9_-]{1,64})\.json$/.exec(name.slice(prefix.length));
  if (!match) return null;
  return { runId: match[1]!, reqId: match[2]! };
}

export function writeSubagentApprovalRequest(
  eventsDir: string,
  parentTerminalId: string,
  runId: string,
  req: { reqId: string; kind: SubagentApprovalKind; text: string },
): { ok: true; file: string } | { ok: false; error: string } {
  const name = subagentApprovalRequestName(parentTerminalId, runId, req.reqId);
  if (!name || !eventsDir) return { ok: false, error: "bad subagent approval identity" };
  if (!req.text.trim()) return { ok: false, error: "empty approval text" };
  const ok = atomicWriteJsonSync(
    eventsDir,
    name,
    JSON.stringify({ version: 1, runId, kind: req.kind, text: req.text.slice(0, 1000), createdAt: Date.now() }),
  );
  return ok ? { ok: true, file: name } : { ok: false, error: "approval request write failed" };
}

export function readSubagentApprovalRequest(
  path: string,
): { ok: true; file: SubagentApprovalRequest } | { ok: false; error: string } {
  const bounded = readBoundedRegularFile(path, 8192);
  if ("error" in bounded) return { ok: false, error: "unreadable" };
  if (bounded.truncated) return { ok: false, error: "oversize" };
  const raw = bounded.text;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "not an object" };
  const r = v as Record<string, unknown>;
  if (r.version !== 1 || typeof r.runId !== "string" || !RUN_RE.test(r.runId)) return { ok: false, error: "bad run" };
  if ((r.kind !== "bash" && r.kind !== "protected") || typeof r.text !== "string" || !r.text.trim()) {
    return { ok: false, error: "bad kind" };
  }
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return { ok: false, error: "bad time" };
  return { ok: true, file: { version: 1, runId: r.runId, kind: r.kind, text: r.text, createdAt: r.createdAt } };
}

/** Parent answer to a child approval wait. Atomic: the waiter claims complete files or nothing. */
export function writeSubagentAckFile(
  eventsDir: string,
  waiterTid: string,
  reqId: string,
  payload: { ok: boolean },
): boolean {
  if (!eventsDir || !TERMINAL_RE.test(waiterTid) || !REQ_RE.test(reqId)) return false;
  return atomicWriteJsonSync(eventsDir, `ack-${waiterTid}-${reqId}.json`, JSON.stringify(payload));
}

export interface SubagentInboxMessage {
  seq: number;
  text: string;
  at: number;
}

export function subagentInboxFileName(parentTerminalId: string, runId: string): string | null {
  if (!TERMINAL_RE.test(parentTerminalId) || !RUN_RE.test(runId)) return null;
  return `subagent-${parentTerminalId}-${runId}.inbox.json`;
}

/** Append a parent message to the run inbox file (transport the child drains). */
export function appendSubagentInboxMessage(
  eventsDir: string,
  parentTerminalId: string,
  runId: string,
  text: string,
): { ok: true; seq: number } | { ok: false; error: string } {
  const name = subagentInboxFileName(parentTerminalId, runId);
  if (!name || !eventsDir) return { ok: false, error: "bad subagent inbox identity" };
  const clean = text.trim();
  if (!clean) return { ok: false, error: "empty message" };
  if (clean.length > MAX_SUBAGENT_MESSAGE_CHARS) {
    return { ok: false, error: `message exceeds ${MAX_SUBAGENT_MESSAGE_CHARS} chars` };
  }
  let messages: SubagentInboxMessage[] = [];
  try {
    const existing = readSubagentInbox(eventsDir, parentTerminalId, runId);
    if (existing) messages = existing.messages;
  } catch {
    messages = [];
  }
  const seq = (messages.at(-1)?.seq ?? 0) + 1;
  messages.push({ seq, text: clean, at: Date.now() });
  while (messages.length > MAX_SUBAGENT_INBOX_MSGS) messages.shift();
  const ok = atomicWriteJsonSync(eventsDir, name, JSON.stringify({ version: 1, runId, messages }));
  return ok ? { ok: true, seq } : { ok: false, error: "inbox write failed" };
}

export function readSubagentInbox(
  eventsDir: string,
  parentTerminalId: string,
  runId: string,
): { version: 1; runId: string; messages: SubagentInboxMessage[] } | null {
  const name = subagentInboxFileName(parentTerminalId, runId);
  if (!name || !eventsDir) return null;
  const bounded = readBoundedRegularFile(join(eventsDir, name), MAX_SUBAGENT_FILE_BYTES);
  if ("error" in bounded || bounded.truncated) return null;
  const raw = bounded.text;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.version !== 1 || r.runId !== runId || !Array.isArray(r.messages)) return null;
  const messages: SubagentInboxMessage[] = [];
  for (const m of r.messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) return null;
    const e = m as Record<string, unknown>;
    if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || typeof e.text !== "string") return null;
    messages.push({ seq: e.seq, text: e.text, at: typeof e.at === "number" ? e.at : 0 });
  }
  return { version: 1, runId, messages };
}
