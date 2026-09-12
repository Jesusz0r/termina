/**
 * Terminal roster persistence.
 *
 * terminal-roster.ts owns the on-disk shape (parse and cap); this module owns
 * the roster file: path shaping, atomic load/save, and the per-roster commit
 * chain that preserves close/open ordering off the main loop. Main owns when
 * to load and save, and supplies live terminals plus model validation behind
 * the TerminalRosterHost seam.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename as fsRename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncParentDir } from "../shared/fsync.js";
import type { PlanTask, VerifyInfo } from "../shared/types.js";
import {
  MAX_ROSTER_BYTES,
  MAX_ROSTER_PLAN_TASKS,
  composeTerminalRoster,
  fitTerminalRoster,
  parseTerminalRoster,
  type TerminalRosterEntry,
} from "./terminal-roster.js";

/** Minimal terminal surface roster persistence needs; AgentTerminalInstance is assignable. */
export interface RosterTerminal {
  readonly id: string;
  readonly type: "agent" | "shell";
  readonly shellPath?: string;
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  readonly model: string | null;
  readonly plan: PlanTask[];
  readonly verify: VerifyInfo;
}

/** Live reads into main-owned state, evaluated at call time. */
export interface TerminalRosterHost {
  usableModel(model: string | null | undefined): string | null;
}

/** Roster file for a project session key (see sanitizeSessionDir in main). */
export function rosterFilePath(userDataDir: string, sessionKey: string): string {
  return join(userDataDir, "terminal-rosters", `${sessionKey}.json`);
}

/** Load one roster file. A present but unreadable roster reports exists so a
 * corrupt file is never mistaken for first launch. */
export async function loadRosterFile(path: string): Promise<{ exists: boolean; entries: TerminalRosterEntry[] }> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    // Only a clean absence means first launch. Anything else (unreadable,
    // oversized handled below) must not spawn an unrequested terminal.
    return { exists: (error as NodeJS.ErrnoException)?.code !== "ENOENT", entries: [] };
  }
  try {
    if (!info.isFile() || info.size > MAX_ROSTER_BYTES) return { exists: true, entries: [] };
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return { exists: true, entries: parseTerminalRoster(raw) };
  } catch {
    // A present but unreadable roster must not be mistaken for first launch:
    // doing so would create and persist a terminal the user did not request.
    return { exists: true, entries: [] };
  }
}

export class TerminalRosterStore {
  /** Per-roster async commit tails preserve close/open ordering off the main loop. */
  private commits = new Map<string, Promise<void>>();

  constructor(private readonly host: TerminalRosterHost) {}

  entryFor(inst: RosterTerminal): TerminalRosterEntry {
    const entry: TerminalRosterEntry = { id: inst.id, type: inst.type };
    if (inst.type === "agent") entry.engine = "core";
    if (inst.type === "shell" && inst.shellPath) entry.shell = inst.shellPath;
    if (inst.sessionId) entry.sessionId = inst.sessionId;
    if (inst.sessionFile) entry.sessionFile = inst.sessionFile;
    // The session's own last model (tracked from sidecar agent_settings /
    // agent_start). Resume restores it; without it a restart falls back to
    // the global last-used model or the provider default.
    const lastModel = this.host.usableModel(inst.model);
    if (inst.type === "agent" && lastModel) {
      entry.model = lastModel;
    }
    if (inst.type === "agent") {
      // Handoff: board tasks (assignments never survive — workers are gone)
      // and the last settled verdict. A running verify restores as untested.
      if (inst.plan.length > 0) {
        entry.plan = inst.plan.slice(0, MAX_ROSTER_PLAN_TASKS).map((t) => ({
          text: t.text.slice(0, 500),
          paths: t.paths.slice(0, 100),
          state: t.state,
        }));
      }
      if (inst.verify.state !== "untested" && inst.verify.state !== "running") {
        entry.verify = { state: inst.verify.state, command: inst.verify.command, summary: inst.verify.summary };
      }
    }
    return entry;
  }

  save(path: string, terminals: RosterTerminal[], unrestored: TerminalRosterEntry[]): void {
    const live = terminals.map((inst) => this.entryFor(inst));
    const entries = fitTerminalRoster(composeTerminalRoster(live, unrestored));
    const dir = dirname(path);
    const previous = this.commits.get(path) ?? Promise.resolve();
    const commit = previous.then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(tmp, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ terminals: entries })}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fsRename(tmp, path);
        syncParentDir(path);
      } catch (error) {
        try {
          await handle?.close();
        } catch {
          /* best-effort fd cleanup */
        }
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    const settled = commit.catch((err) => {
      console.warn(`[main] could not save terminal roster: ${(err as Error).message}`);
    });
    this.commits.set(path, settled);
    void settled.then(() => {
      if (this.commits.get(path) === settled) this.commits.delete(path);
    });
  }

  async drain(): Promise<void> {
    while (this.commits.size > 0) {
      await Promise.all(this.commits.values());
    }
  }
}
