import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { parseTerminalCreateOptions } from "../../../electron/main/ipc-validate.ts";

/**
 * Mid-teardown creation gates (refs #214).
 *
 * dispatchRun and the terminals:create handler are extracted from
 * electron/main.ts and transpiled (the save-revert-lease suite's pattern:
 * main imports Electron and cannot be imported here), then driven with
 * fake projects that are live or switching.
 */

const root = process.cwd();
const main = readFileSync(join(root, "electron", "main.ts"), "utf8");

function extractMethod(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing method ${signature}`);
  const paramsEnd = source.indexOf(")", start + signature.length) + 1;
  let angle = 0;
  let brace = -1;
  for (let i = paramsEnd; i < source.length; i++) {
    const ch = source[i];
    if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
    else if (ch === "{" && angle === 0) {
      brace = i;
      break;
    }
  }
  if (brace < 0) throw new Error(`unclosed method ${signature}`);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed method ${signature}`);
}

function loadMethod(factoryName: string, signature: string, names: string[], values: unknown[]): unknown {
  const methodSource = extractMethod(main, signature).replace(/^private /, "");
  const factory = ts.transpileModule(`return ({ ${methodSource} }).${factoryName};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const construct = new Function(...names, factory) as unknown as (...args: unknown[]) => unknown;
  return construct(...values);
}

/** Extract an ipcMain.handle callback as a callable function. */
function loadHandler(channel: string, paramNames: string, names: string[], values: unknown[]): unknown {
  const handleAt = main.indexOf(`ipcMain.handle("${channel}"`);
  if (handleAt < 0) throw new Error(`missing handler ${channel}`);
  const arrow = main.indexOf("=>", handleAt);
  const bodyStart = main.indexOf("{", arrow);
  let depth = 0;
  for (let i = bodyStart; i < main.length; i++) {
    const ch = main[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const body = main.slice(bodyStart, i + 1);
        const factory = ts.transpileModule(`return (async function handler(${paramNames}) ${body});`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const construct = new Function(...names, factory) as unknown as (...args: unknown[]) => unknown;
        return construct(...values);
      }
    }
  }
  throw new Error(`unclosed handler ${channel}`);
}

type DispatchRun = (ownerId: string, taskText?: string) => Promise<{ ok: boolean; error?: string; dispatched?: number }>;
type TerminalsCreate = (event: unknown, opts?: unknown) => Promise<{ ok: boolean; id?: string; error?: string }>;

const dispatchRun = loadMethod("dispatchRun", "private async dispatchRun(", [], []) as DispatchRun;
const terminalsCreate = loadHandler("terminals:create", "_e, opts", ["detectShells", "parseTerminalCreateOptions"], [
  async () => [{ path: "/bin/zsh", name: "zsh" }],
  parseTerminalCreateOptions,
]) as TerminalsCreate;

interface FakeProject {
  id: string;
}

function makeHarness(opts: { switching: Set<string>; activeId: string | null }) {
  const created: Array<Record<string, unknown>> = [];
  const projects = new Map<string, FakeProject>([
    ["proj-live", { id: "proj-live" }],
    ["proj-closing", { id: "proj-closing" }],
  ]);
  const terminals = new Map<string, { id: string; type: string; plan: unknown[] }>([
    ["term-1", { id: "term-1", type: "agent", plan: [] }],
  ]);
  const terminalProjects = new Map<string, string>([["term-1", "proj-live"]]);
  const app = {
    disposed: false,
    projects,
    terminals,
    runtime: { get: (id: string) => terminals.get(id), subscribe() { return true; } },
    project: () => (opts.activeId ? (projects.get(opts.activeId) ?? null) : null),
    projectOfTerminal: (id: string) => {
      const pid = terminalProjects.get(id);
      return pid ? (projects.get(pid) ?? null) : null;
    },
    projectIsSwitching: (id: string | undefined) => id !== undefined && opts.switching.has(id),
    captureRendererSendTarget: () => null,
    createTerminal: async (_cwd: unknown, createOpts: unknown) => {
      created.push(createOpts as Record<string, unknown>);
      return { id: "term-99" };
    },
  };
  const moveTerminal = (terminalId: string, projectId: string) => {
    terminalProjects.set(terminalId, projectId);
  };
  return { app, created, moveTerminal };
}

describe("mid-teardown creation gates (refs #214)", () => {
  it("refuses dispatch into a switching project", async () => {
    const h = makeHarness({ switching: new Set(["proj-closing"]), activeId: "proj-live" });
    h.moveTerminal("term-1", "proj-closing");
    const result = await dispatchRun.call(h.app, "term-1");
    expect(result).toEqual({ ok: false, error: "the project is changing" });
    expect(h.created).toHaveLength(0);
  });

  it("lets dispatch into a live project pass the gate", async () => {
    const h = makeHarness({ switching: new Set(["proj-closing"]), activeId: "proj-live" });
    // Empty plan bails after the gate: the gate itself passed.
    const result = await dispatchRun.call(h.app, "term-1");
    expect(result).toEqual({ ok: false, error: "the plan board is empty — run /plan first" });
  });

  it("re-checks the gate after the pick and flush awaits", () => {
    const source = extractMethod(main, "private async dispatchRun(");
    const gates = source.match(/the project is changing/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(2);
    const flushAt = source.indexOf("flushDirtyModels(dispatchWriter");
    const lastGate = source.lastIndexOf("projectIsSwitching(this.projectOfTerminal(ownerId)?.id)");
    expect(lastGate).toBeGreaterThan(flushAt);
  });

  it("refuses IPC terminal creation into a switching project", async () => {
    const h = makeHarness({ switching: new Set(["proj-closing"]), activeId: "proj-live" });
    const explicit = await terminalsCreate.call(h.app, {}, { projectId: "proj-closing" });
    expect(explicit).toEqual({ ok: false, error: "the project is changing" });
    expect(h.created).toHaveLength(0);
    const activeClosing = makeHarness({ switching: new Set(["proj-live"]), activeId: "proj-live" });
    const implicit = await terminalsCreate.call(activeClosing.app, {}, {});
    expect(implicit).toEqual({ ok: false, error: "the project is changing" });
    expect(activeClosing.created).toHaveLength(0);
  });

  it("lets IPC terminal creation into a live project through", async () => {
    const h = makeHarness({ switching: new Set(["proj-closing"]), activeId: "proj-live" });
    const result = await terminalsCreate.call(h.app, {}, { projectId: "proj-live" });
    expect(result).toEqual({ ok: true, id: "term-99" });
    expect(h.created).toHaveLength(1);
  });

  it("fails an unresolvable project id closed (refs #219 item 3)", async () => {
    // Unknown ids never fall back to the active project: the terminal would
    // otherwise land in a project the caller never named.
    const h = makeHarness({ switching: new Set([]), activeId: "proj-live" });
    const result = await terminalsCreate.call(h.app, {}, { projectId: "proj-unknown" });
    expect(result).toEqual({ ok: false, error: "unknown project" });
    expect(h.created).toHaveLength(0);
    const switching = makeHarness({ switching: new Set(["proj-live"]), activeId: "proj-live" });
    const gated = await terminalsCreate.call(switching.app, {}, { projectId: "proj-unknown" });
    expect(gated).toEqual({ ok: false, error: "unknown project" });
    expect(switching.created).toHaveLength(0);
  });

  it("leaves createTerminal itself ungated for internal callers", () => {
    // Restore-during-open, promotion install, and candidate creation run
    // while switching: only the IPC/dispatch layer gates. The roster
    // persist check lives on the runtime host exit hook.
    const start = main.indexOf("private async createTerminal(");
    const end = main.indexOf("private async handlePtyExitBeforeRelease(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = main.slice(start, end);
    expect(body.match(/projectIsSwitching/g) ?? []).toHaveLength(0);
    const exitHook = main.slice(end, main.indexOf("private handlePtyExitAfterRelease(", end));
    expect(exitHook).toContain("projectIsSwitching(exitOwner.id)");
  });
});
