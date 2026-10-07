import { readFileSync } from "node:fs";
import { basename } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchWorkerModel, MAX_DISPATCH_WORKERS, pickDispatchTasks, planOwnerError,
  planStartError, samePlanTaskSnapshot,
} from "../../../electron/plan-board.ts";
import { parsePlanTaskStartRequest } from "../../../electron/main/ipc-validate.ts";
import type { PlanTask, PlanTaskStartRequest, PlanTaskStartResult } from "../../../shared/types.ts";

// Exercise production main methods without importing Electron or starting the app.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function loadMethods(names: string[], dependencies: Record<string, unknown>) {
  const methods: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(source))) methods.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (methods.length !== names.length) throw new Error("Missing main plan start method");
  const compiled = ts.transpile(`class Main { ${methods.join("\n")} } return new Main();`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
}

type Stage = "claims" | "path" | "lease" | "flush" | "briefing" | "control" | "create-return";
function fixture() {
  const workspace = { id: "primary", root: "/actual/root", primary: true, generation: 9, terminalIds: new Set(["term-1"]) };
  const project = { id: "background", cwd: "/displayed/root", canonicalRoot: workspace.root, activationGeneration: 3,
    workspaces: new Map([[workspace.id, workspace]]), terminalIds: new Set(["term-1"]) };
  const task: PlanTask = { text: "Fix file.ts", paths: ["file.ts"], state: "pending", model: "provider/task-model" };
  const other: PlanTask = { text: "Fix other.ts", paths: ["other.ts"], state: "pending" };
  const inst = { id: "term-1", generation: 2, projectId: project.id, workspaceId: workspace.id, cwd: workspace.root,
    type: "agent", persist: true, busy: false, closed: false, pty: { hasExited: false, write: vi.fn() }, plan: [task, other] };
  const main = loadMethods(["startPlanTask", "planOwnerFacts", "dispatchRun", "dispatchPreparedRun",
    "ownerDispatchCount", "projectOfTerminal", "workspaceOfTerminal", "projectIsSwitching"], {
    parsePlanTaskStartRequest, planOwnerError, planStartError, samePlanTaskSnapshot,
    pickDispatchTasks, MAX_DISPATCH_WORKERS, dispatchWorkerModel,
    dispatchViewerId: (id: string) => `dispatch:${id}`,
    isPtyRendererSendTargetCurrent: (a: unknown, b: unknown) => a === b,
  }) as { startPlanTask(value: unknown): Promise<PlanTaskStartResult>; dispatchRun(id: string, text?: string): Promise<PlanTaskStartResult> };
  const hooks: Partial<Record<Stage, () => void | Promise<void>>> = {};
  const stage = async (name: Stage) => { await hooks[name]?.(); };
  let target: object | null = {};
  let nextId = 10;
  const runtime = new Map<string, typeof inst>([[inst.id, inst]]);
  const state = {
    projects: new Map([[project.id, project]]),
    runtime: { get: (id: string) => runtime.get(id), subscribe: vi.fn() },
    switchingProjects: new Set<string>(), projectClosePromises: new Map(), terminalCloseRequests: new WeakMap(),
    dispatchWorkers: new Map(), dispatchRuns: new Map(), dispatchPreparations: new Set<string>(),
    disposed: false, activeProjectId: "different-project", captureRendererSendTarget: () => target,
    usableAgentModel: (model: string) => model,
    dispatchPathKeysInFlight: vi.fn(async () => { await stage("claims"); return new Set<string>(); }),
    taskPathKey: vi.fn(async (path: string) => { await stage("path"); return `/actual/root/${path}`; }),
    acquireWriteLease: vi.fn(async () => { await stage("lease"); return { ok: true }; }),
    flushDirtyModels: vi.fn(async () => { await stage("flush"); return { ok: true }; }),
    releaseWriteLease: vi.fn(), allocateTerminalId: vi.fn(() => `term-${nextId++}`), ensureEventsDir: vi.fn(),
    dispatchJobsForBriefing: vi.fn((_owner: unknown, jobs: unknown) => jobs),
    writeDispatchBriefing: vi.fn(async () => { await stage("briefing"); }),
    writeDispatchStartupControl: vi.fn(async () => { await stage("control"); }),
    clearMailbox: vi.fn(), removeDispatchStartupControl: vi.fn(async () => {}),
    createTerminal: vi.fn(async (_cwd, opts) => {
      opts.spawnGuard();
      const worker = { ...inst, id: opts.id, generation: 5, persist: false, plan: [], pty: { hasExited: false, write: vi.fn() } };
      runtime.set(worker.id, worker);
      await stage("create-return");
      return worker;
    }),
    closeTerminal: vi.fn((id: string) => runtime.delete(id)), sendPlan: vi.fn(),
  };
  Object.assign(main, state);
  const request: PlanTaskStartRequest = { owner: { projectId: project.id, workspaceId: workspace.id,
    root: workspace.root, terminalId: inst.id, generation: inst.generation }, projectRoot: project.cwd, task: structuredClone(task) };
  return { main, state, project, workspace, inst, task, other, request, hooks, runtime,
    replaceRenderer: () => { target = {}; } };
}

function mutate(f: ReturnType<typeof fixture>, change: string) {
  switch (change) {
    case "workspace-generation": f.workspace.generation++; break;
    case "project-generation": f.project.activationGeneration++; break;
    case "canonical-root": f.project.canonicalRoot = "/changed"; break;
    case "root": f.workspace.root = "/changed"; break;
    case "project-root": f.project.cwd = "/changed"; break;
    case "terminal-generation": f.inst.generation++; break;
    case "workspace-id": f.inst.workspaceId = "other"; break;
    case "terminal-project": f.inst.projectId = "other"; break;
    case "project-membership": f.project.terminalIds.delete(f.inst.id); break;
    case "workspace-membership": f.workspace.terminalIds.delete(f.inst.id); break;
    case "busy": f.inst.busy = true; break;
    case "closed": f.inst.closed = true; break;
    case "exited": f.inst.pty.hasExited = true; break;
    case "changing": f.state.switchingProjects.add(f.project.id); break;
    case "closing": f.state.terminalCloseRequests.set(f.inst, {}); break;
    case "disposed": Object.assign(f.main, { disposed: true }); break;
    case "renderer": f.replaceRenderer(); break;
    case "plan-replaced": f.inst.plan = [structuredClone(f.task)]; break;
    case "task-replaced": f.inst.plan[0] = structuredClone(f.task); break;
    case "paths": f.task.paths.push("changed.ts"); break;
    case "model": f.task.model = "provider/changed"; break;
    case "state": f.task.state = "done"; break;
    case "assignment": f.task.workerId = "term-99"; break;
    case "claimed": f.task.claimed = ["changed.ts"]; break;
    case "outcome": f.task.dispatchResult = { workerId: "old", outcome: "incomplete" }; break;
    case "duplicate": f.inst.plan.push(structuredClone(f.task)); break;
    case "worker-owner": f.state.dispatchWorkers.set(f.inst.id, "worker"); break;
    case "shell-owner": f.inst.type = "shell"; break;
    case "transient-owner": f.inst.persist = false; break;
    case "candidate-owner": f.workspace.primary = false; break;
    default: throw new Error(`Unknown mutation ${change}`);
  }
}
const changes = ["workspace-generation", "project-generation", "canonical-root", "root", "project-root", "terminal-generation",
  "workspace-id", "terminal-project", "project-membership", "workspace-membership", "busy", "closed", "exited", "changing", "closing",
  "disposed", "renderer", "plan-replaced", "task-replaced", "paths", "model", "state", "assignment", "claimed", "outcome", "duplicate",
  "worker-owner", "shell-owner", "transient-owner", "candidate-owner"];

describe("main explicit Start task", () => {
  it("dispatches only the exact background owner's selected task without activation or interruption", async () => {
    const f = fixture();
    const otherBefore = structuredClone(f.other);
    expect(await f.main.startPlanTask(f.request)).toEqual({ ok: true, dispatched: 1 });
    expect(f.state.activeProjectId).toBe("different-project");
    expect(f.state.createTerminal).toHaveBeenCalledExactlyOnceWith(undefined, expect.objectContaining({
      projectId: "background", workspaceId: "primary", fromTerminalId: "term-1", model: "provider/task-model", spawnGuard: expect.any(Function),
    }));
    expect(f.state.writeDispatchStartupControl).toHaveBeenCalledExactlyOnceWith("term-10", f.task.text);
    expect(f.task).toMatchObject({ state: "active", workerId: "term-10", claimed: ["file.ts"] });
    expect(f.other).toEqual(otherBefore);
    expect(f.inst.pty.write).not.toHaveBeenCalled();
    expect(f.state.dispatchRuns.get("term-10")).toEqual({ ownerId: "term-1", taskText: f.task.text });
    expect(f.state.runtime.subscribe).toHaveBeenCalledExactlyOnceWith("term-10", "dispatch:term-1");
    expect(f.state.releaseWriteLease).toHaveBeenCalledExactlyOnceWith("primary", "dispatch:term-1");
    expect(f.state.sendPlan).toHaveBeenCalledOnce();
  });

  it("starts a task on a full board and permits named tasks with no parsed paths", async () => {
    const f = fixture();
    f.inst.plan.push(...Array.from({ length: 18 }, (_, i): PlanTask => ({ text: `Task ${i}`, paths: [], state: "pending" })));
    f.task.paths = []; f.request.task.paths = [];
    expect(f.inst.plan).toHaveLength(20);
    expect(await f.main.startPlanTask(f.request)).toEqual({ ok: true, dispatched: 1 });
    expect(f.state.createTerminal).toHaveBeenCalledOnce();
  });

  it.each([null, {}, { task: {} }, { owner: null, task: {} }])("rejects malformed request %j before preparation", async (request) => {
    const f = fixture();
    expect(await f.main.startPlanTask(request)).toMatchObject({ ok: false });
    expect(f.state.dispatchPathKeysInFlight).not.toHaveBeenCalled();
    expect(f.state.createTerminal).not.toHaveBeenCalled();
  });

  it.each(["project", "displayed-root", "actual-root", "workspace", "terminal", "generation", "task-text", "task-paths", "task-model"])(
    "rejects incorrect requested %s before awaits", async (change) => {
      const f = fixture();
      switch (change) {
        case "project": f.request.owner.projectId = "other"; break;
        case "displayed-root": f.request.projectRoot = f.workspace.root; break;
        case "actual-root": f.request.owner.root = f.project.cwd; break;
        case "workspace": f.request.owner.workspaceId = "other"; break;
        case "terminal": f.request.owner.terminalId = "other"; break;
        case "generation": f.request.owner.generation++; break;
        case "task-text": f.request.task.text = "Missing"; break;
        case "task-paths": f.request.task.paths = ["other.ts"]; break;
        case "task-model": f.request.task.model = "provider/other"; break;
      }
      expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
      expect(f.state.dispatchPathKeysInFlight).not.toHaveBeenCalled();
      expect(f.state.createTerminal).not.toHaveBeenCalled();
    });

  it.each(changes)("rejects %s changing during path canonicalization without privileged preparation", async (change) => {
    const f = fixture();
    f.hooks.path = () => mutate(f, change);
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
    expect(f.state.acquireWriteLease).not.toHaveBeenCalled();
    expect(f.state.writeDispatchBriefing).not.toHaveBeenCalled();
    expect(f.state.createTerminal).not.toHaveBeenCalled();
    expect(f.inst.pty.write).not.toHaveBeenCalled();
    expect(f.state.sendPlan).not.toHaveBeenCalled();
    expect(f.state.dispatchPreparations.size).toBe(0);
  });

  it.each(["claims", "lease", "flush", "briefing", "control", "create-return"] as const)(
    "fences a changed task after the %s await and cleans up acquired resources", async (stage) => {
      const f = fixture();
      f.hooks[stage] = () => { f.task.paths.push("changed.ts"); };
      expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
      if (stage === "claims") expect(f.state.acquireWriteLease).not.toHaveBeenCalled();
      if (stage === "lease") expect(f.state.flushDirtyModels).not.toHaveBeenCalled();
      if (["lease", "flush", "briefing", "control", "create-return"].includes(stage)) expect(f.state.releaseWriteLease).toHaveBeenCalledOnce();
      if (["claims", "lease", "flush"].includes(stage)) expect(f.state.writeDispatchBriefing).not.toHaveBeenCalled();
      if (stage === "briefing") expect(f.state.writeDispatchStartupControl).not.toHaveBeenCalled();
      if (stage !== "create-return") expect(f.state.createTerminal).not.toHaveBeenCalled();
      if (["briefing", "control", "create-return"].includes(stage)) {
        expect(f.state.clearMailbox).toHaveBeenCalledWith("term-10");
        expect(f.state.removeDispatchStartupControl).toHaveBeenCalledWith("term-10");
      }
      if (stage === "create-return") expect(f.state.closeTerminal).toHaveBeenCalledExactlyOnceWith("term-10");
      expect(f.task.workerId).toBeUndefined();
      expect(f.task.state).toBe("pending");
      expect(f.state.dispatchWorkers.size).toBe(0);
      expect(f.state.dispatchRuns.size).toBe(0);
      expect(f.state.sendPlan).not.toHaveBeenCalled();
      expect(f.state.dispatchPreparations.size).toBe(0);
    });

  it.each(["duplicate", "busy", "outcome", "assignment", "state", "worker-owner", "shell-owner", "transient-owner", "candidate-owner"])(
    "rejects ineligible %s before preparation", async (change) => {
      const f = fixture();
      mutate(f, change);
      f.request.task = structuredClone(f.task);
      expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
      expect(f.state.dispatchPathKeysInFlight).not.toHaveBeenCalled();
      expect(f.inst.pty.write).not.toHaveBeenCalled();
    });

  it.each(["initial-first", "dispatch-first"])("excludes double requests and existing dispatch races (%s)", async (order) => {
    const f = fixture();
    let release!: () => void;
    f.hooks.path = () => new Promise<void>((resolve) => { release = resolve; });
    const first = order === "initial-first" ? f.main.startPlanTask(f.request) : f.main.dispatchRun(f.inst.id, f.task.text);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false, error: expect.stringContaining("preparing") });
    expect(await f.main.dispatchRun(f.inst.id, f.task.text)).toMatchObject({ ok: false, error: expect.stringContaining("preparing") });
    release();
    expect(await first).toEqual({ ok: true, dispatched: 1 });
    expect(f.state.createTerminal).toHaveBeenCalledOnce();
    expect(f.state.dispatchPreparations.size).toBe(0);
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
    expect(f.state.createTerminal).toHaveBeenCalledOnce();
  });

  it("retains deliberate busy-owner interruption only for ordinary Plan Board dispatch", async () => {
    const f = fixture(); f.inst.busy = true;
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false, error: expect.stringContaining("busy") });
    expect(f.inst.pty.write).not.toHaveBeenCalled();
    expect(await f.main.dispatchRun(f.inst.id, f.task.text)).toEqual({ ok: true, dispatched: 1 });
    expect(f.inst.pty.write).toHaveBeenCalledExactlyOnceWith("\x03");
  });

  it("waits for private launch-file cleanup before releasing the preparation lock", async () => {
    const f = fixture();
    f.hooks.control = () => mutate(f, "paths");
    let release!: () => void;
    f.state.clearMailbox.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const result = f.main.startPlanTask(f.request);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(f.state.removeDispatchStartupControl).toHaveBeenCalledWith("term-10");
    expect(f.state.dispatchPreparations.has(f.inst.id)).toBe(true);
    expect(f.state.createTerminal).not.toHaveBeenCalled();
    release();
    expect(await result).toMatchObject({ ok: false });
    expect(f.state.dispatchPreparations.size).toBe(0);
  });

  it("releases the preparation lock on failure so a fresh valid request may start", async () => {
    const f = fixture();
    f.state.acquireWriteLease.mockResolvedValueOnce({ ok: false });
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
    expect(f.state.dispatchPreparations.size).toBe(0);
    expect(await f.main.startPlanTask(f.request)).toEqual({ ok: true, dispatched: 1 });
  });
});

describe("createTerminal strict internal spawn fence", () => {
  it.each(["session-directory", "session-reclaim", "session-file"])("fences %s during asynchronous agent preparation", async (stage) => {
    let stale = false;
    const actual = loadMethods(["createTerminal"], {
      coreEngineBinary: () => "/app/agent-core.mjs", thinkingStartupArgs: () => [],
      isCoreSessionId: () => true, randomUUID: () => "new-session",
    });
    const f = fixture();
    const createTerminal = actual.createTerminal;
    const prepareSessionDirectory = vi.fn(async () => { if (stage === "session-directory") stale = true; return "/isolated/sessions"; });
    const reclaimSession = vi.fn(async () => { if (stage === "session-reclaim") stale = true; });
    const prepareSessionFile = vi.fn(async () => { if (stage === "session-file") stale = true; return "/isolated/sessions/core-id.jsonl"; });
    const spawn = vi.fn();
    Object.assign(actual, f.state, {
      createTerminal, preferences: { showThinking: false }, allocateTerminalId: () => "term-10",
      projectOfWorkspace: () => f.project, usableAgentThinking: () => null,
      coreProjectSessionDir: prepareSessionDirectory, reclaimUnusedEmptyCoreSessions: reclaimSession,
      coreSessionFile: prepareSessionFile, runtime: { has: () => false, spawn },
    });
    await expect(actual.createTerminal(f.workspace.root, { type: "agent", projectId: f.project.id,
      workspaceId: f.workspace.id, persist: true, resume: { sessionId: "core-id", sessionFile: null },
      spawnGuard: () => { if (stale) throw new Error("stale inspector"); },
    })).rejects.toThrow("stale inspector");
    if (stage === "session-directory") expect(reclaimSession).not.toHaveBeenCalled();
    if (stage !== "session-file") expect(prepareSessionFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(f.project.terminalIds).toEqual(new Set([f.inst.id]));
  });

  it.each(["shell-discovery", "before-spawn"])("checks the guard after %s before PTY admission", async (stage) => {
    let stale = false;
    const actual = loadMethods(["createTerminal"], {
      detectShells: async () => { if (stage === "shell-discovery") stale = true; return []; },
      fsRealpath: async (root: string) => root, basename, existsSync: () => true,
    });
    const f = fixture();
    const ptySpawn = vi.fn();
    const admit = vi.fn();
    const createTerminal = actual.createTerminal;
    Object.assign(actual, f.state, {
      createTerminal,
      allocateTerminalId: () => "term-10", projectOfWorkspace: () => f.project,
      sourceAdmissions: { admit, remove: vi.fn() },
      runtime: { has: () => false, spawn: (opts: { beforeSpawn(target: unknown): void }) => {
        if (stage === "before-spawn") stale = true;
        opts.beforeSpawn({ id: "term-10", generation: 10 });
        ptySpawn();
      } },
    });
    await expect(actual.createTerminal(f.workspace.root, { type: "shell", projectId: f.project.id,
      workspaceId: f.workspace.id, persist: false, spawnGuard: () => { if (stale) throw new Error("stale inspector"); },
    })).rejects.toThrow("stale inspector");
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    expect(f.project.terminalIds).toEqual(new Set([f.inst.id]));
  });
});
