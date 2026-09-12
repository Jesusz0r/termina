/**
 * Background static diagnostics.
 *
 * After an agent settles, run the project's own TypeScript compiler for the
 * workspace and land the capped result in the terminal's diagnostics context
 * file for the next turn. Generation-cached and silent by design. Main owns
 * authoritative app state; this module owns diagnostics state and logic
 * behind the DiagnosticsHost seam, and never throws out of run().
 */
import { spawn } from "node:child_process";
import { stat, realpath as fsRealpath } from "node:fs/promises";
import { join } from "node:path";
import { terminateSandboxProcessGroup } from "./sandbox.js";
import { writeBoundOwnedFile, type PromotionFsIdentity } from "./worldline-git.js";

/** Bound for one diagnostics run's captured output. */
const MAX_DIAGNOSTICS_OUTPUT = 32 * 1024;
/** Bound for one diagnostics context file. */
const MAX_DIAGNOSTICS_CONTEXT_BYTES = 6 * 1024;
/** Background typecheck budget per run; slower suites stay manual. */
const DIAGNOSTICS_TIMEOUT_MS = 120_000;
/** Cap for cached workspace diagnostics state (project open/close churn). */
const MAX_DIAGNOSTICS_WORKSPACES = 64;
/** Minimum gap between diagnostics runs of one workspace. */
const MIN_DIAGNOSTICS_INTERVAL_MS = 60_000;

/** Minimal terminal surface diagnostics needs; AgentTerminalInstance is assignable. */
export interface DiagnosticsTerminal {
  readonly id: string;
  readonly workspaceId: string;
  readonly closed: boolean;
}

/** Minimal workspace shape; WorkspaceState is assignable. Reads happen at the
 * same points as before the extraction, so a live object stays behavior-identical. */
export interface DiagnosticsWorkspace {
  readonly id: string;
  readonly root: string;
  readonly primary: boolean;
  readonly generation: number;
}

/** Live reads into main-owned state, evaluated at call time. */
export interface DiagnosticsHost {
  workspaceById(workspaceId: string): DiagnosticsWorkspace | null;
  isProjectSwitching(workspaceId: string): boolean;
  isDisposed(): boolean;
  isTerminalCurrent(inst: DiagnosticsTerminal): boolean;
  eventsTarget(terminalId: string): { dir: string; binding: PromotionFsIdentity } | null;
  /** Minted Verify env (PATH + locale/TERM + home/tmp); never ambient credentials. */
  verifyEnv(): Record<string, string | undefined>;
}

/**
 * Detect a fast static diagnostics command: TypeScript via the project's
 * own compiler. Other stacks stay manual until a cheap probe exists.
 */
async function detectDiagnosticsCommand(cwd: string): Promise<{ command: string; args: string[]; label: string } | null> {
  try {
    const root = await fsRealpath(cwd);
    await stat(join(root, "tsconfig.json"));
    const tsc = join(root, "node_modules", ".bin", "tsc");
    const info = await stat(tsc);
    if (!info.isFile()) return null;
    return { command: tsc, args: ["--noEmit", "-p", join(root, "tsconfig.json")], label: "tsc --noEmit" };
  } catch {
    return null;
  }
}

export class DiagnosticsRunner {
  /** Workspaces with an in-flight background diagnostics run. */
  private diagnosticsRuns = new Set<string>();
  /** Last diagnostics run per workspace: proven-clean generation and start
   *  time. Failures keep the old generation so the next settle retries. */
  private lastDiagnostics = new Map<string, { generation: number; atMs: number }>();

  constructor(private readonly host: DiagnosticsHost) {}

  /**
   * Run static diagnostics in the background after an agent settles.
   * TypeScript-only v1, primary workspaces only. Skipped when the workspace
   * generation has not moved since the last clean run, and at most once a
   * minute per workspace. Silent: the capped result lands in the diagnostics
   * context file for the next turn. Never throws.
   */
  async run(inst: DiagnosticsTerminal): Promise<void> {
    const ws = this.host.workspaceById(inst.workspaceId);
    if (!ws || !ws.primary || this.host.isDisposed()) return;
    if (this.host.isProjectSwitching(ws.id)) return;
    if (this.diagnosticsRuns.has(ws.id)) return;
    const startGeneration = ws.generation;
    const last = this.lastDiagnostics.get(ws.id);
    if (last && last.generation >= startGeneration) return;
    if (last && Date.now() - last.atMs < MIN_DIAGNOSTICS_INTERVAL_MS) return;
    const cwd = ws.root;
    let tc: { command: string; args: string[]; label: string } | null;
    try {
      tc = await detectDiagnosticsCommand(cwd);
    } catch {
      return;
    }
    if (!tc) return;
    if (!this.host.isTerminalCurrent(inst) || this.host.isDisposed()) return;
    this.diagnosticsRuns.add(ws.id);
    // Refresh recency: re-setting a Map key keeps its original position.
    this.lastDiagnostics.delete(ws.id);
    this.lastDiagnostics.set(ws.id, { generation: last?.generation ?? -1, atMs: Date.now() });
    if (this.lastDiagnostics.size > MAX_DIAGNOSTICS_WORKSPACES) {
      const oldest = this.lastDiagnostics.keys().next().value;
      if (oldest !== undefined && oldest !== ws.id) this.lastDiagnostics.delete(oldest);
    }
    let child: ReturnType<typeof spawn> | null = null;
    let output = "";
    let finished = false;
    const finish = (code: number | null, timedOut: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.diagnosticsRuns.delete(ws.id);
      if (!this.host.isTerminalCurrent(inst) || this.host.isDisposed()) return;
      const pass = !timedOut && code === 0;
      // A passing run proves the start generation clean. Failures and
      // timeouts keep the old watermark (plus the fresh timestamp above) so
      // the next settle retries after the interval.
      if (pass) {
        const current = this.lastDiagnostics.get(ws.id);
        this.lastDiagnostics.set(ws.id, { generation: startGeneration, atMs: current?.atMs ?? Date.now() });
      }
      const body = output.trim().slice(-MAX_DIAGNOSTICS_CONTEXT_BYTES);
      const md =
        `## Diagnostics — \`${tc.label}\` — ${new Date().toISOString()}\n\n` +
        `**Status:** ${pass ? "✅ clean" : timedOut ? "⏰ timed out" : "❌ errors"}\n\n` +
        (body && !pass ? `<details>\n<summary>Output</summary>\n\n\`\`\`text\n${body}\n\`\`\`\n</details>\n` : "");
      const target = this.host.eventsTarget(inst.id);
      if (!target) return;
      void writeBoundOwnedFile({
        root: target.dir,
        rootIdentity: target.binding,
        components: [`diagnostics-${inst.id}.md`],
        parentIdentity: target.binding,
        content: Buffer.from(md, "utf8"),
        mode: 0o600,
        maxBytes: MAX_DIAGNOSTICS_CONTEXT_BYTES + 1024,
      }).catch((err) => {
        console.warn(`[main] could not write diagnostics context: ${String(err)}`);
      });
    };
    const timer = setTimeout(() => {
      if (child) {
        try {
          terminateSandboxProcessGroup(child, "SIGKILL", 1500);
        } catch {
          /* The close handler owns the result. */
        }
      }
      finish(null, true);
    }, DIAGNOSTICS_TIMEOUT_MS);
    try {
      child = spawn(tc.command, tc.args, {
        cwd,
        detached: process.platform !== "win32",
        env: { ...this.host.verifyEnv() },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      clearTimeout(timer);
      this.diagnosticsRuns.delete(ws.id);
      return;
    }
    child.stdout?.on("data", (data: Buffer | string) => {
      if (output.length < MAX_DIAGNOSTICS_OUTPUT) output += data.toString().slice(0, MAX_DIAGNOSTICS_OUTPUT - output.length);
    });
    child.stderr?.on("data", (data: Buffer | string) => {
      if (output.length < MAX_DIAGNOSTICS_OUTPUT) output += data.toString().slice(0, MAX_DIAGNOSTICS_OUTPUT - output.length);
    });
    child.once("error", () => finish(null, false));
    child.once("close", (code) => finish(code, false));
  }
}
