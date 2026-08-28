/**
 * Per-project terminal roster. Main owns when to load and save.
 * This module only parses and caps the on-disk shape.
 */
// Use .ts so the source harness can load this module with strip-types.
import { isCoreSessionId } from "../agent-core/session.ts";

export const MAX_TERMINAL_ROSTER = 16;
export const MAX_ROSTER_BYTES = 64 * 1024;
const MAX_ID = 64;
const MAX_PATH = 1024;
const MAX_SESSION_ID = 128;
const TERM_ID = /^term-[1-9][0-9]{0,5}$/;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export type TerminalRosterEntry = {
  id: string;
  type: "agent" | "shell";
  engine?: "pi" | "core";
  shell?: string;
  sessionId?: string | null;
  sessionFile?: string | null;
};

function isAbsPath(value: string): boolean {
  if (!value || value.length > MAX_PATH || /[\x00-\x1f]/.test(value)) return false;
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function isRosterSessionId(value: string): boolean {
  return value.length <= MAX_SESSION_ID && SESSION_ID.test(value);
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
    if (rec.type === "agent") {
      if (rec.engine === "core" || rec.engine === "pi") entry.engine = rec.engine;
      else entry.engine = "core";
    }
    if (rec.type === "shell" && typeof rec.shell === "string" && isAbsPath(rec.shell)) entry.shell = rec.shell;
    if (
      typeof rec.sessionId === "string" &&
      (entry.engine === "core" ? isCoreSessionId(rec.sessionId) : isRosterSessionId(rec.sessionId))
    ) {
      entry.sessionId = rec.sessionId;
    }
    if (entry.engine !== "core" && typeof rec.sessionFile === "string" && isAbsPath(rec.sessionFile)) {
      entry.sessionFile = rec.sessionFile;
    }
    seen.add(entry.id);
    out.push(entry);
    if (out.length >= MAX_TERMINAL_ROSTER) break;
  }
  return out;
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
