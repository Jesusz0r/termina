import { readFileSync } from "node:fs";
import { basename } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchWorkerModel, MAX_DISPATCH_WORKERS, pickDispatchTasks, planOwnerError,
  planStartError, samePlanTaskSnapshot, parsePlanTaskCandidate,
  markPlanProgress, finalizePlanTasks, reattachDispatchAssignments, settleDispatchTask,
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
    model: "provider/owner-model", thinkingLevel: "high", type: "agent", persist: true, busy: false, closed: false, pty: { hasExited: false, write: vi.fn() }, plan: [task, other] };
  const main = loadMethods(["startPlanTask", "planOwnerFacts", "dispatchRun", "dispatchPreparedRun",
    "dispatchSharedPreparedRun", "ownerDispatchCount", "projectOfTerminal", "workspaceOfTerminal", "projectIsSwitching"], {
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
    closeTerminal: vi.fn((id: string) => runtime.delete(id)), sendPlan: vi.fn(), savePlanRoster: vi.fn(),
  };
  const nativeIndependentSpawn = vi.fn();
  const createIndependentSession = vi.fn(async (opts) => {
    try {
      for (const name of ["claims", "path", "lease", "flush", "briefing", "control"] as const) {
        opts.assertCurrent();
        await stage(name);
        opts.assertCurrent();
      }
      opts.beforeSpawn("term-10", { comparisonId: "cmp-1", label: "A" });
      opts.assertCurrent();
      await stage("create-return");
      opts.assertCurrent();
      nativeIndependentSpawn();
      return { ok: true, terminalId: "term-10" };
    } catch (error) { return { ok: false, error: String(error) }; }
  });
  Object.assign(project, { worldlines: { createIndependentSession } });
  Object.assign(state, { createIndependentSession });
  Object.assign(main, state);
  const request: PlanTaskStartRequest = { owner: { projectId: project.id, workspaceId: workspace.id,
    root: workspace.root, terminalId: inst.id, generation: inst.generation }, projectRoot: project.cwd, task: structuredClone(task) };
  return { main, state, project, workspace, inst, task, other, request, hooks, runtime, createIndependentSession, nativeIndependentSpawn,
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
    case "owner-replaced": f.runtime.set(f.inst.id, { ...f.inst }); break;
    case "owner-model": f.inst.model = "provider/changed-owner"; break;
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
  it("starts one isolated background task with inherited thinking and no shared-source launch", async () => {
    const f = fixture();
    expect(await f.main.startPlanTask(f.request)).toEqual({ ok: true, dispatched: 1 });
    expect(f.createIndependentSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      model: "provider/task-model", thinkingLevel: "high", initialTask: f.task.text,
    }));
    expect(f.state.createTerminal).not.toHaveBeenCalled();
    expect(f.state.dispatchPathKeysInFlight).not.toHaveBeenCalled();
    expect(f.state.activeProjectId).toBe("different-project");
    expect(f.inst.pty.write).not.toHaveBeenCalled();
    expect(f.task).toMatchObject({ state: "active", workerId: "term-10", claimed: [] });
    expect(f.other.state).toBe("pending");
    expect(f.state.dispatchRuns.get("term-10")).toEqual({ ownerId: f.inst.id, taskText: f.task.text });
  });
  it("accepts pathless named tasks on a full board and inherits the owner model", async () => {
    const f = fixture(); delete f.task.model; delete f.request.task.model;
    f.task.paths = []; f.request.task.paths = [];
    f.inst.plan.push(...Array.from({ length: 18 }, (_, i): PlanTask => ({ text: `Task ${i}`, paths: [], state: "pending" })));
    expect(await f.main.startPlanTask(f.request)).toEqual({ ok: true, dispatched: 1 });
    expect(f.createIndependentSession).toHaveBeenCalledWith(expect.objectContaining({ model: "provider/owner-model" }));
  });
  it.each(changes)("fences %s after preparation awaits", async (change) => {
    const f = fixture(); f.hooks.path = () => mutate(f, change);
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
    expect(f.state.createTerminal).not.toHaveBeenCalled();
    expect(f.state.dispatchRuns.size).toBe(0);
    expect(f.state.dispatchPreparations.size).toBe(0);
  });
  it.each(["claims", "lease", "flush", "briefing", "control", "create-return"] as const)("cleans failed admission at %s", async (stage) => {
    const f = fixture(); f.hooks[stage] = () => { f.task.paths.push("changed.ts"); };
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
    expect(f.task.workerId).toBeUndefined(); expect(f.task.state).toBe("pending");
    expect(f.state.dispatchRuns.size).toBe(0); expect(f.state.dispatchWorkers.size).toBe(0);
    expect(f.state.createTerminal).not.toHaveBeenCalled();
  });
  it("installs metadata before execution and permits exact fast settlement", async () => {
    const f = fixture(); f.hooks["create-return"] = () => {
      expect(f.state.dispatchRuns.get("term-10")).toEqual({ ownerId: f.inst.id, taskText: f.task.text });
      expect(f.task.workerId).toBe("term-10");
      delete f.task.workerId; delete f.task.claimed; f.task.state = "done";
      f.task.dispatchResult = { workerId: "term-10", outcome: "completed" };
    };
    expect(await f.main.startPlanTask(f.request)).toEqual({ ok: true, dispatched: 1 });
    expect(f.task.state).toBe("done");
  });
  it.each(["sandbox unavailable", "worldline budget exhausted", "capture unavailable"])("does not fall back after %s", async (error) => {
    const f = fixture(); f.createIndependentSession.mockResolvedValueOnce({ ok: false, error });
    expect(await f.main.startPlanTask(f.request)).toEqual({ ok: false, error });
    expect(f.state.createTerminal).not.toHaveBeenCalled(); expect(f.task.state).toBe("pending");
  });
  it.each(["initial-first", "dispatch-first"])("serializes starts and ordinary dispatch (%s)", async (order) => {
    const f = fixture(); let release!: () => void;
    f.hooks.path = () => new Promise<void>((resolve) => { release = resolve; });
    const first = order === "initial-first" ? f.main.startPlanTask(f.request) : f.main.dispatchRun(f.inst.id, f.task.text);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false, error: expect.stringContaining("preparing") });
    expect(await f.main.dispatchRun(f.inst.id, f.task.text)).toMatchObject({ ok: false, error: expect.stringContaining("preparing") });
    release(); expect(await first).toEqual({ ok: true, dispatched: 1 });
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
  });
  it("keeps named Retry in a fresh independent candidate and preserves old area on budget refusal", async () => {
    const f = fixture();
    Object.assign(f.task, { candidate: { comparisonId: "cmp-old", label: "A" }, dispatchResult: { workerId: "old", outcome: "incomplete" } });
    f.createIndependentSession.mockResolvedValueOnce({ ok: false, error: "budget exhausted" });
    expect(await f.main.dispatchRun(f.inst.id, f.task.text)).toEqual({ ok: false, error: "budget exhausted" });
    expect(f.task.candidate).toEqual({ comparisonId: "cmp-old", label: "A" });
    expect(f.state.createTerminal).not.toHaveBeenCalled();
    expect(await f.main.dispatchRun(f.inst.id, f.task.text)).toEqual({ ok: true, dispatched: 1 });
    expect(f.task.candidate).toEqual({ comparisonId: "cmp-1", label: "A" });
    expect(f.task.dispatchResult).toBeUndefined();
    expect(f.state.createTerminal).not.toHaveBeenCalled();
  });
  it("batch Dispatch keeps candidate rows isolated while ordinary rows use existing shared execution", async () => {
    const f = fixture(); f.task.candidate = { comparisonId: "cmp-old", label: "A" };
    expect(await f.main.dispatchRun(f.inst.id)).toEqual({ ok: true, dispatched: 2 });
    expect(f.createIndependentSession).toHaveBeenCalledOnce();
    expect(f.state.createTerminal).toHaveBeenCalledOnce();
    expect(f.task.candidate).toEqual({ comparisonId: "cmp-1", label: "A" });
    expect(f.other.workerId).toBeDefined();
  });
  it("initial Start ignores shared path claims and another source owner's dispatch", async () => {
    const f = fixture();
    f.state.dispatchRuns.set("shared-worker", { ownerId: "other-owner", taskText: f.task.text });
    f.state.dispatchPathKeysInFlight.mockResolvedValueOnce(new Set(["/actual/root/file.ts"]));
    expect(await f.main.startPlanTask(f.request)).toEqual({ ok: true, dispatched: 1 });
    expect(f.state.dispatchPathKeysInFlight).not.toHaveBeenCalled();
  });
  it("enforces owner worker limits even for isolated starts", async () => {
    const f = fixture();
    for (let i = 0; i < MAX_DISPATCH_WORKERS; i++) f.state.dispatchRuns.set(`worker-${i}`, { ownerId: f.inst.id, taskText: `other-${i}` });
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
    expect(f.createIndependentSession).not.toHaveBeenCalled();
  });
  it("keeps busy-owner interruption exclusive to ordinary dispatch", async () => {
    const f = fixture(); f.inst.busy = true;
    expect(await f.main.startPlanTask(f.request)).toMatchObject({ ok: false });
    expect(f.inst.pty.write).not.toHaveBeenCalled();
    expect(await f.main.dispatchRun(f.inst.id, f.task.text)).toEqual({ ok: true, dispatched: 1 });
    expect(f.inst.pty.write).toHaveBeenCalledExactlyOnceWith("\x03");
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

describe("candidate final PTY admission fence", () => {
  it("forwards the guard through asynchronous terminal preparation to the final spawn", async () => {
    const main = loadMethods(["createCandidate"], { awaitCandidateAbortable: (value: Promise<unknown>) => value });
    let stale = false;
    const ptySpawn = vi.fn(); const routing = vi.fn(); const guard = vi.fn(() => { if (stale) throw new Error("stale inspector"); });
    const tailer = {};
    const stopSidecar = vi.fn();
    Object.assign(main, {
      allocateTerminalId: () => "term-10", bindSidecarHold: vi.fn(),
      runtime: { startCandidateSidecar: () => tailer, sidecarWatchGeneration: () => 4,
        watchCandidateReady: async () => true, stopSidecar },
      createTerminal: async (_root: unknown, opts: { spawnGuard(): void }) => {
        expect(routing).toHaveBeenCalledOnce();
        await Promise.resolve(); stale = true; opts.spawnGuard(); ptySpawn();
      },
    });
    await expect(main.createCandidate({ root: "/candidate", workspaceId: "candidate",
      launch: { cmd: "/node", args: [], env: { TERMINA_EVENTS_DIR: "/events" } },
      beforeSpawn: routing, spawnGuard: guard,
    })).rejects.toThrow("stale inspector");
    expect(guard).toHaveBeenCalledOnce(); expect(ptySpawn).not.toHaveBeenCalled();
    expect(stopSidecar).toHaveBeenCalledExactlyOnceWith("term-10", 4);
  });
});

describe("canonical task candidate reference", () => {
  it("copies the bounded durable identity without unknown fields", () => {
    const input = { comparisonId: "cmp-12", label: "A", extra: "ignored" };
    expect(parsePlanTaskCandidate(input)).toEqual({ comparisonId: "cmp-12", label: "A" });
    expect(parsePlanTaskCandidate(input)).not.toBe(input);
    expect(parsePlanTaskCandidate({ comparisonId: "cmp-1", label: "B" })).toEqual({ comparisonId: "cmp-1", label: "B" });
  });
  it.each([null, {}, { comparisonId: "cmp-0", label: "A" }, { comparisonId: "cmp-01", label: "A" },
    { comparisonId: "cmp-1", label: "C" }, { comparisonId: "cmp-" + "1".repeat(61), label: "A" },
    { comparisonId: "../cmp-1", label: "A" }])("rejects malformed candidate %j", (value) => {
    expect(parsePlanTaskCandidate(value)).toBeUndefined();
  });
});

describe("isolated task durable execution provenance", () => {
  it("preserves candidate provenance through settlement and Plan Board reattachment", () => {
    const task: PlanTask = { text: "Fix file.ts", paths: ["file.ts"], state: "active", workerId: "worker",
      claimed: [], candidate: { comparisonId: "cmp-4", label: "A" } };
    expect(settleDispatchTask(task, { id: "worker", touched: new Set(["file.ts"]), toolOutcomes: new Map([["file.ts", "ok"]]) }, "settled")).toBe("completed");
    expect(task.workerId).toBeUndefined(); expect(task.candidate).toEqual({ comparisonId: "cmp-4", label: "A" });
    const replacement: PlanTask = { text: task.text, paths: [...task.paths], state: "pending" };
    reattachDispatchAssignments([replacement], [{ workerId: "next-worker", taskText: task.text }], [task]);
    expect(replacement).toMatchObject({ candidate: task.candidate, claimed: [], workerId: "next-worker", state: "active" });
  });
  it("does not infer isolated task completion from shared-source progress", () => {
    const isolated: PlanTask = { text: "Fix file.ts", paths: ["file.ts"], state: "pending", candidate: { comparisonId: "cmp-4", label: "A" } };
    expect(markPlanProgress([isolated], "file.ts")).toBe(false);
    finalizePlanTasks([isolated], new Set(["file.ts"]), new Map([["file.ts", "ok"]]));
    expect(isolated.state).toBe("pending");
  });
});

describe("independent Retry final lifecycle fence", () => {
  function retryFixture() {
    const f = fixture();
    f.task.candidate = { comparisonId: "cmp-4", label: "A" };
    f.task.dispatchResult = { workerId: "previous", outcome: "incomplete" };
    return f;
  }
  it.each(["closed", "owner-replaced", "owner-model", "plan-replaced", "task-replaced", "paths", "model", "root", "project-generation", "workspace-generation", "renderer"])(
    "refuses %s before assignment without native execution", async (change) => {
      const f = retryFixture(); f.hooks.path = () => mutate(f, change);
      expect(await f.main.dispatchRun(f.inst.id, f.task.text)).toMatchObject({ ok: false });
      expect(f.nativeIndependentSpawn).not.toHaveBeenCalled();
      expect(f.state.dispatchRuns.size).toBe(0); expect(f.state.dispatchWorkers.size).toBe(0);
    });
  it.each(["closed", "owner-replaced", "owner-model", "plan-replaced", "task-replaced", "paths", "model", "root", "project-generation", "workspace-generation", "renderer"])(
    "refuses %s after assignment at final native admission", async (change) => {
      const f = retryFixture(); f.hooks["create-return"] = () => mutate(f, change);
      expect(await f.main.dispatchRun(f.inst.id, f.task.text)).toMatchObject({ ok: false });
      expect(f.nativeIndependentSpawn).not.toHaveBeenCalled();
      expect(f.state.dispatchRuns.size).toBe(0); expect(f.state.dispatchWorkers.size).toBe(0);
      expect(f.inst.plan.every((row) => row.workerId !== "term-10")).toBe(true);
      expect(f.task.candidate).toEqual({ comparisonId: "cmp-4", label: "A" });
    });
  it("clears reattached assignments while preserving manual completion and edited fields", async () => {
    const f = retryFixture();
    f.hooks["create-return"] = () => {
      const replacement: PlanTask = { text: f.task.text, paths: ["user-change.ts"], model: "provider/user-model", state: "pending" };
      reattachDispatchAssignments([replacement], [{ workerId: "term-10", taskText: f.task.text }], f.inst.plan);
      replacement.state = "done";
      f.inst.plan = [replacement];
    };
    expect(await f.main.dispatchRun(f.inst.id, f.task.text)).toMatchObject({ ok: false });
    expect(f.nativeIndependentSpawn).not.toHaveBeenCalled();
    expect(f.inst.plan[0]).toMatchObject({ state: "done", paths: ["user-change.ts"], model: "provider/user-model",
      candidate: { comparisonId: "cmp-4", label: "A" }, dispatchResult: { workerId: "previous", outcome: "incomplete" } });
    expect(f.inst.plan[0].workerId).toBeUndefined(); expect(f.inst.plan[0].claimed).toBeUndefined();
    expect(f.state.dispatchRuns.size).toBe(0); expect(f.state.dispatchWorkers.size).toBe(0);
  });
  it("admits a background independent Retry without a renderer while retaining source guards", async () => {
    const f = retryFixture();
    Object.assign(f.main, { captureRendererSendTarget: () => null });
    expect(await f.main.dispatchRun(f.inst.id, f.task.text)).toEqual({ ok: true, dispatched: 1 });
    expect(f.nativeIndependentSpawn).toHaveBeenCalledOnce();
    expect(f.state.createTerminal).not.toHaveBeenCalled();
  });
  it("retains ordinary named shared Dispatch and admits an unchanged independent Retry", async () => {
    const shared = fixture();
    expect(await shared.main.dispatchRun(shared.inst.id, shared.task.text)).toEqual({ ok: true, dispatched: 1 });
    expect(shared.state.createTerminal).toHaveBeenCalledOnce(); expect(shared.createIndependentSession).not.toHaveBeenCalled();
    const independent = retryFixture();
    expect(await independent.main.dispatchRun(independent.inst.id, independent.task.text)).toEqual({ ok: true, dispatched: 1 });
    expect(independent.nativeIndependentSpawn).toHaveBeenCalledOnce(); expect(independent.state.createTerminal).not.toHaveBeenCalled();
  });
});
