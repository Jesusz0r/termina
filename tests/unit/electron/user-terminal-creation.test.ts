import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { sourceTreesOverlap } from "../../../electron/main/source-admission.ts";
import { sanitizeSessionDir } from "../../../electron/main/project-workspace.ts";

// Exercise the actual orchestration methods without booting the Electron app.
const source = ts.createSourceFile("main.ts", readFileSync(join(process.cwd(), "electron/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
function method(name: string): (...args: any[]) => Promise<any> {
  let node: ts.MethodDeclaration | undefined;
  function find(current: ts.Node): void {
    if (ts.isMethodDeclaration(current) && current.name.getText(source) === name) node = current;
    else ts.forEachChild(current, find);
  }
  find(source);
  if (!node) throw new Error(`missing ${name}`);
  const body = node.getText(source).replace(/^private /, "");
  return new Function("sourceTreesOverlap", "rosterFilePath", "sanitizeSessionDir", "parsePlanModelMarker", "invalidateVerify", "join",
    ts.transpileModule(`return ({ ${body} }).${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
    sourceTreesOverlap, () => "roster", sanitizeSessionDir, () => null, (value: unknown) => value, join);
}
const create = method("createUserTerminal");
const restore = method("restoreProjectTerminals");
const sidecar = method("shouldAdmitTerminalSidecar");
const sessionDirectory = method("coreProjectSessionDir");

function fixture() {
  const project = { id: "requested", cwd: "/requested", canonicalRoot: "/requested", unrestoredTerminals: [] as unknown[], worldlines: {
    openMigratedSession: vi.fn(async (_source: string): Promise<any> => null),
    createIndependentSession: vi.fn(async (_options: unknown) => ({ ok: true, terminalId: "isolated" })),
    candidateContextOf: (id: string) => id === "isolated" ? { sourceRunId: null } : null,
  } };
  const foreground = { id: "foreground", cwd: "/foreground", canonicalRoot: "/foreground" };
  const terminals = new Map<string, any>();
  const isolated = { id: "isolated", persist: false };
  const app = {
    disposed: false, userDataDir: "/app-owned-test", userTerminalCreation: Promise.resolve(),
    projects: new Map([[project.id, project]]), project: () => foreground,
    projectIsSwitching: () => false, primaryWorkspace: () => ({ id: "primary" }),
    runtime: { values: () => terminals.values(), get: (id: string) => id === "isolated" ? isolated : terminals.get(id),
      loadRoster: vi.fn(async () => ({ exists: true, entries: [{ id: "legacy", type: "agent", sessionId: "old-session" }] })) },
    workspaceOfTerminal: (inst: any) => ({ canonicalRoot: inst.root }),
    coreSessionFile: vi.fn(async () => "/saved/old-session/current/active.jsonl"),
    rememberedAgentSettings: () => null,
    createTerminal: vi.fn(async (cwd: string, _opts: unknown) => {
      const inst = { id: "primary", root: cwd, persist: true, closed: false, pty: { hasExited: false } };
      terminals.set(inst.id, inst);
      return inst;
    }),
    createUserTerminal: (...args: any[]) => create.call(app, ...args),
    noteTerminalId: vi.fn(), saveTerminalRoster: vi.fn(),
  };
  return { project, terminals, app };
}

describe("user terminal creation", () => {
  it("uses the same canonical session root for aliases and native promotion", async () => {
    const context = { coreSessionRoot: () => "/var/app/agent-sessions",
      canonicalPath: async (path: string) => path.replace(/^\/var\//, "/private/var/") };
    expect(await sessionDirectory.call(context, "/var/project")).toBe(
      join("/private/var/app/agent-sessions", sanitizeSessionDir("/private/var/project")));
  });
  it("admits registered startup events while opening but holds them while closing", () => {
    const { app, project } = fixture();
    const context = { ...app, runtime: { has: (id: string) => ["isolated", "primary"].includes(id) },
      subagents: { hasStream: () => false }, projectOfTerminal: () => project,
      projectIsSwitching: () => true, projectClosePromises: new Map() };
    expect(sidecar.call(context, "isolated")).toBe(true);
    expect(sidecar.call(context, "primary")).toBe(false);
    expect(sidecar.call(context, "not-adopted")).toBe(false);
    context.projectClosePromises.set(project.id, Promise.resolve());
    expect(sidecar.call(context, "isolated")).toBe(false);
  });
  it("keeps the requested folder through asynchronous session resolution", async () => {
    const { app } = fixture();
    await create.call(app, { projectId: "requested", resume: { sessionId: "old-session" } }, true);
    expect(app.createTerminal).toHaveBeenCalledWith("/requested", expect.anything());
  });

  it("serializes simultaneous empty-project requests before testing occupancy", async () => {
    const { app, project } = fixture();
    const results = await Promise.all([create.call(app, { projectId: project.id }), create.call(app, { projectId: project.id })]);
    expect(results.map((r) => r.id)).toEqual(["primary", "isolated"]);
    expect(app.createTerminal).toHaveBeenCalledTimes(1);
    expect(project.worldlines.createIndependentSession).toHaveBeenCalledTimes(1);
  });

  it("keeps creating independent user agents past the experiment quota without replacing live sessions", async () => {
    const { app, project, terminals } = fixture();
    project.worldlines.createIndependentSession.mockImplementation(async () => {
      const id = `isolated-${terminals.size}`;
      terminals.set(id, { id, root: `/worlds/${id}/A`, persist: false, closed: false, pty: { hasExited: false } });
      return { ok: true, terminalId: id };
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => create.call(app, { projectId: project.id, type: "agent" })));
    expect(new Set(results.map((r) => r.id)).size).toBe(8);
    expect(terminals.size).toBe(8);
    expect(app.createTerminal).toHaveBeenCalledTimes(1);
    expect(project.worldlines.createIndependentSession).toHaveBeenCalledTimes(7);
  });

  it("creates requested shells beyond sixteen saved tabs without invoking agent isolation", async () => {
    const { app, project, terminals } = fixture();
    app.createTerminal.mockImplementation(async (cwd: string) => {
      const id = `term-${terminals.size + 1}`;
      const inst = { id, root: cwd, persist: true, closed: false, pty: { hasExited: false } };
      terminals.set(id, inst);
      return inst;
    });
    const results = await Promise.all(Array.from({ length: 24 }, () => create.call(app, { projectId: project.id, type: "shell" })));
    expect(new Set(results.map((r) => r.id)).size).toBe(24);
    expect(app.createTerminal).toHaveBeenCalledTimes(24);
    expect(project.worldlines.createIndependentSession).not.toHaveBeenCalled();
  });

  it("reuses the durable migration when its old roster row survives a crash", async () => {
    const { app, project } = fixture();
    project.worldlines.openMigratedSession.mockResolvedValue({ ok: true, terminalId: "isolated" });
    await restore.call(app, project);
    expect(project.worldlines.openMigratedSession).toHaveBeenCalledWith("/saved/old-session/current/active.jsonl");
    expect(project.worldlines.createIndependentSession).not.toHaveBeenCalled();
    expect(app.createTerminal).not.toHaveBeenCalled();
    expect(project.unrestoredTerminals).toEqual([]);
    expect(app.saveTerminalRoster).toHaveBeenCalledWith(project);
  });

  it("retains a failed migration row without allocating a duplicate area", async () => {
    const { app, project } = fixture();
    project.worldlines.openMigratedSession.mockResolvedValue({ ok: false, error: "saved area unavailable" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { await restore.call(app, project); }
    finally { warning.mockRestore(); }
    expect(project.unrestoredTerminals).toHaveLength(1);
    expect(project.worldlines.createIndependentSession).not.toHaveBeenCalled();
    expect(app.createTerminal).not.toHaveBeenCalled();
  });

  it("isolates the default terminal of a newly opened overlapping project", async () => {
    const { app, project, terminals } = fixture();
    terminals.set("other", { id: "other", root: "/requested/nested", closed: false, pty: { hasExited: false } });
    app.runtime.loadRoster.mockResolvedValue({ exists: false, entries: [] });
    await restore.call(app, project);
    expect(project.worldlines.createIndependentSession).toHaveBeenCalledTimes(1);
    expect(app.createTerminal).not.toHaveBeenCalled();
  });
});
