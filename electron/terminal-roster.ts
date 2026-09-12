/**
 * Per-project terminal roster. Main owns when to load and save.
 * This module only parses and caps the on-disk shape.
 */
// Use .ts so the source harness can load this module with strip-types.
import { isCoreSessionId } from "../agent-core/session.ts";

export const MAX_TERMINAL_ROSTER = 16;
export const MAX_ROSTER_BYTES = 64 * 1024;
/** Handoff tasks per terminal: the board survives restarts, not archives. */
export const MAX_ROSTER_PLAN_TASKS = 50;
const MAX_PLAN_TEXT = 500;
const MAX_PLAN_PATHS = 100;
const MAX_PLAN_PATH = 256;
const MAX_VERIFY_TEXT = 256;
const MAX_ID = 64;
const MAX_PATH = 1024;
const TERM_ID = /^term-[1-9][0-9]{0,5}$/;

export type TerminalRosterEntry = {
  id: string;
  type: "agent" | "shell";
  engine?: "core";
  shell?: string;
  sessionId?: string | null;
  sessionFile?: string | null;
  /** Provider-qualified model the session last used (core resume pin). */
  model?: string;
  /** Handoff plan: task text, paths, and state. Worker assignments never
   *  persist — the restoring side resets active tasks to pending. */
  plan?: Array<{ text: string; paths: string[]; state: "pending" | "active" | "done" }>;
  /** Last verify verdict for the badge. */
  verify?: { state: "untested" | "pass" | "fail" | "timeout" | "cancelled"; command: string | null; summary: string | null };
};

function isAbsPath(value: string): boolean {
  if (!value || value.length > MAX_PATH || /[\x00-\x1f]/.test(value)) return false;
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/** provider/model without whitespace or control characters. The model part
 *  may itself contain slashes; the split is on the first one. */
export function isRosterModel(value: string): boolean {
  if (value.length < 3 || value.length > 200 || /[\x00-\x1f\x7f\s]/.test(value)) return false;
  const cut = value.indexOf("/");
  return cut > 0 && cut < value.length - 1;
}

function parseRosterPlan(value: unknown): TerminalRosterEntry["plan"] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<TerminalRosterEntry["plan"]> = [];
  for (const item of value) {
    if (out.length >= MAX_ROSTER_PLAN_TASKS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.text !== "string" || !rec.text || rec.text.length > MAX_PLAN_TEXT || /[\x00-\x1f]/.test(rec.text)) continue;
    if (rec.state !== "pending" && rec.state !== "active" && rec.state !== "done") continue;
    const paths: string[] = [];
    if (Array.isArray(rec.paths)) {
      for (const p of rec.paths) {
        if (paths.length >= MAX_PLAN_PATHS) break;
        if (typeof p === "string" && p && p.length <= MAX_PLAN_PATH && !/[\x00-\x1f]/.test(p)) paths.push(p);
      }
    }
    out.push({ text: rec.text, paths, state: rec.state });
  }
  return out.length > 0 ? out : undefined;
}

function parseRosterVerify(value: unknown): TerminalRosterEntry["verify"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (rec.state !== "untested" && rec.state !== "pass" && rec.state !== "fail" && rec.state !== "timeout" && rec.state !== "cancelled") return undefined;
  if (rec.state === "untested") return undefined;
  const text = (v: unknown): string | null =>
    typeof v === "string" && v.length <= MAX_VERIFY_TEXT && !/[\x00-\x1f]/.test(v) ? v : null;
  return { state: rec.state, command: text(rec.command), summary: text(rec.summary) };
}

export function parseTerminalRoster(raw: unknown): TerminalRosterEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { terminals?: unknown }).terminals)
      ? (raw as { terminals: unknown[] }).terminals
      : null;
  if (!list) return [];
  const out: TerminalRosterEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (rec.type !== "agent" && rec.type !== "shell") continue;
    if (typeof rec.id !== "string" || rec.id.length > MAX_ID || !TERM_ID.test(rec.id) || seen.has(rec.id)) continue;
    const entry: TerminalRosterEntry = { id: rec.id, type: rec.type };
    // Agent tabs are always core. A stale engine field on disk is ignored.
    if (rec.type === "agent") entry.engine = "core";
    if (rec.type === "shell" && typeof rec.shell === "string" && isAbsPath(rec.shell)) entry.shell = rec.shell;
    if (typeof rec.sessionId === "string" && isCoreSessionId(rec.sessionId)) {
      entry.sessionId = rec.sessionId;
    }
    // The session's own last model, so resume restores it instead of the
    // global last-used one. Entries written before this field exist stay
    // valid without it. Same shape rule as the spawn-time model flag.
    if (entry.type === "agent" && typeof rec.model === "string" && isRosterModel(rec.model)) {
      entry.model = rec.model;
    }
    // Handoff state: the board and the last verdict survive restarts.
    // Entries written before these fields exist stay valid without them.
    if (entry.type === "agent") {
      const plan = parseRosterPlan(rec.plan);
      if (plan) entry.plan = plan;
      const verify = parseRosterVerify(rec.verify);
      if (verify) entry.verify = verify;
    }
    seen.add(entry.id);
    out.push(entry);
    if (out.length >= MAX_TERMINAL_ROSTER) break;
  }
  return out;
}

/**
 * Fit entries into the roster byte budget, degrading handoff state before
 * identity: other entries' plans go first, then all verdicts. The first
 * entry keeps its plan longest. Core resume fields always fit, so tabs are
 * never lost to a full board.
 */
export function fitTerminalRoster(entries: TerminalRosterEntry[]): TerminalRosterEntry[] {
  const size = (list: TerminalRosterEntry[]): number => Buffer.byteLength(JSON.stringify({ terminals: list }), "utf8");
  if (size(entries) <= MAX_ROSTER_BYTES) return entries;
  const stripped = entries.map((entry, i) =>
    i === 0 ? entry : { ...entry, plan: undefined },
  );
  if (size(stripped) <= MAX_ROSTER_BYTES) return stripped;
  const bare = stripped.map(({ plan: _plan, verify: _verify, ...rest }) => rest);
  if (size(bare) <= MAX_ROSTER_BYTES) return bare;
  return bare.slice(0, MAX_TERMINAL_ROSTER);
}

/**
 * Live persist tabs win. Failed restores stay on the roster so a later
 * launch can retry them. The cap prefers live tabs.
 */
export function composeTerminalRoster(
  live: TerminalRosterEntry[],
  unrestored: TerminalRosterEntry[],
): TerminalRosterEntry[] {
  const out: TerminalRosterEntry[] = [];
  const seen = new Set<string>();
  for (const list of [live, unrestored]) {
    for (const entry of list) {
      if (seen.has(entry.id) || out.length >= MAX_TERMINAL_ROSTER) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}
