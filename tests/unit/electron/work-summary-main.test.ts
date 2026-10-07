import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { activityFor, activityView, emptyActivityInput, type AgentActivityInput } from "../../../electron/agent-activity.ts";
import { parseTerminalTarget } from "../../../electron/main/ipc-validate.ts";
import { projectWorkSummary, workOverview } from "../../../electron/main/work-summary.ts";
import { formatVerifyContext, invalidateVerify } from "../../../electron/main/verify-source.ts";
import type { FolderOpenedPayload, PlanTask, ProjectWorkSummary, VerifyInfo, WorkAttentionInspectResult, WorkOverview } from "../../../shared/types.ts";

// Run the actual main methods with in-memory owners, without importing Electron,
// instantiating an app/provider, or reading session files from the host.
const sourceFile = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const methodNames = ["workSummary", "workOverview", "inspectWorkAttention", "verifyReport", "projectOfTerminal", "workspaceOfTerminal", "registerIpc",
  "activateProject", "sendFolderOpened", "projectIsSwitching", "beginProjectSelectionAction", "nextProjectActivationGeneration"];
const methods = new Map<string, ts.MethodDeclaration>();
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && methodNames.includes(node.name.getText(sourceFile))) {
    methods.set(node.name.getText(sourceFile), node);
  }
  ts.forEachChild(node, visit);
}
visit(sourceFile);
if (methods.size !== methodNames.length) throw new Error("main work-summary orchestration is missing");
const compiled = ts.transpile(`class TerminaApp {
  ${[...methods].filter(([name]) => name !== "registerIpc").map(([, node]) => node.getText(sourceFile)).join("\n")}
}\nreturn new TerminaApp();`, { target: ts.ScriptTarget.ES2022 });

interface Workspace {
  id: string;
  root: string;
  primary: boolean;
  comparisonId?: string;
}
interface Terminal {
  id: string;
  generation: number;
  projectId: string | null;
  workspaceId: string;
  cwd: string;
  type: "agent" | "shell";
  closed: boolean;
  model: string | null;
  modified: Map<string, object>;
  plan: PlanTask[];
  verify: VerifyInfo;
  verifyOutput: string | null;
}
interface Project {
  id: string;
  cwd: string;
  terminalIds: Set<string>;
  workspaces: Map<string, Workspace>;
  activationGeneration: number;
}
interface MainHarness {
  projects: Map<string, Project>;
  runtime: Map<string, Terminal>;
  activityInputs: Map<string, AgentActivityInput>;
  workSummary(projectId: unknown): ProjectWorkSummary | null;
  workOverview(): WorkOverview;
  inspectWorkAttention(id: unknown): Promise<WorkAttentionInspectResult>;
  activateProject(id: string): Promise<FolderOpenedPayload | null>;
  verifyReport(id: unknown, generation: unknown): string | null;
  agentNeedsLogin(): Promise<boolean>;
  switchingProjects: Set<string>;
  projectClosePromises: Map<string, Promise<unknown>>;
  disposed: boolean;
  activeProjectId: string | null;
  projectSelectionAction: number;
  projectActivationGeneration: number;
  send: ReturnType<typeof vi.fn>;
  persistOpenProjects: ReturnType<typeof vi.fn>;
}

function fixture() {
  const primary: Workspace = { id: "ws-primary", root: "/projects/active", primary: true };
  const candidate: Workspace = { id: "ws-candidate", root: "/worlds/candidate-A", primary: false, comparisonId: "comparison-1" };
  const project: Project = {
    id: "project-1", cwd: primary.root, terminalIds: new Set(),
    workspaces: new Map([[primary.id, primary], [candidate.id, candidate]]), activationGeneration: 0,
  };
  const main = new Function("activityFor", "activityView", "emptyActivityInput", "parseTerminalTarget", "projectWorkSummary", "workOverview", "formatVerifyContext", compiled)(
    activityFor, activityView, emptyActivityInput, parseTerminalTarget, projectWorkSummary, workOverview, formatVerifyContext,
  ) as MainHarness;
  Object.assign(main, {
    projects: new Map([[project.id, project]]), runtime: new Map(), activityInputs: new Map(),
    switchingProjects: new Set(), projectClosePromises: new Map(), disposed: false,
    activeProjectId: null, projectSelectionAction: 0, projectSelectionActionSeq: 0, projectActivationGeneration: 0,
    primaryWorkspace: (project: Project) => [...project.workspaces.values()].find((workspace) => workspace.primary),
    captureRendererSendTarget: () => null, agentNeedsLogin: async () => false,
    send: vi.fn(), persistOpenProjects: vi.fn(),
  });
  function add(id: string, overrides: Partial<Terminal> = {}): Terminal {
    const terminal: Terminal = {
      id, generation: 7, projectId: project.id, workspaceId: primary.id, cwd: primary.root,
      type: "agent", closed: false, model: "test-model", modified: new Map(), plan: [],
      verify: { state: "untested", command: null, summary: null }, verifyOutput: null,
      ...overrides,
    };
    main.runtime.set(id, terminal);
    project.terminalIds.add(id);
    return terminal;
  }
  return { main, project, primary, candidate, add };
}

function historicalPass(): VerifyInfo {
  return invalidateVerify({
    state: "pass", command: "pnpm run test", summary: "12 passed",
    source: { workspaceId: "ws-primary", root: "/projects/active", tree: "a".repeat(40), revision: 3, observationEpoch: 2, generation: 4 },
    result: { state: "pass", exitCode: 0, startedAt: 1_700_000_000_000, finishedAt: 1_700_000_001_250 },
  }, "source changed after verification");
}

describe("main project work-summary orchestration", () => {
  it.each([undefined, null, 1, {}, [], "", "missing-project", "p".repeat(65)])("rejects invalid or missing project %j", (projectId) => {
    const { main, add } = fixture();
    add("term-1");
    expect(main.workSummary(projectId)).toBeNull();
  });

  it("returns an empty summary for an existing project with no live terminals", () => {
    const { main, project } = fixture();
    expect(main.workSummary(project.id)).toEqual({ projectId: project.id, name: "active", root: project.cwd, terminals: [] });
  });

  it("includes only live terminals in the requested project's authoritative roster", () => {
    const { main, project, add } = fixture();
    const owner = add("term-1", { modified: new Map([["one.ts", {}], ["two.ts", {}]]) });
    add("term-2", { type: "shell", model: "misleading-model", verify: { state: "fail", command: "runner", summary: "failed" } });
    add("term-closed", { closed: true });
    add("term-foreign", { projectId: "project-2" });
    add("term-unowned", { projectId: null });
    add("term-unlisted");
    project.terminalIds.delete("term-unlisted");
    project.terminalIds.add("term-missing");
    main.projects.set("project-2", { ...project, id: "project-2", terminalIds: new Set(["term-foreign"]) });
    main.activityInputs.set(owner.id, { ...emptyActivityInput(), sidecarHeld: true });
    main.activityInputs.set("term-2", { ...emptyActivityInput(), lastBoundary: "agent_start" });

    const summary = main.workSummary(project.id)!;
    expect(summary.terminals.map((terminal) => terminal.terminalId)).toEqual(["term-1", "term-2"]);
    expect(summary.terminals[0]).toMatchObject({
      generation: 7, model: "test-model", trackedChanges: 2,
      activity: { state: "blocked", reason: "sidecar-paused" }, attention: ["blocked"],
      nextAction: { kind: "terminal", terminalId: "term-1", generation: 7 },
    });
    expect(summary.terminals[1]).toMatchObject({ type: "shell", activity: null, verify: null, model: null, attention: [] });
  });

  it("uses workspaceOfTerminal assignment rather than cwd to identify the source area", () => {
    const { main, project, primary, candidate, add } = fixture();
    add("term-primary", { cwd: candidate.root });
    add("term-candidate", { cwd: primary.root, workspaceId: candidate.id });
    add("term-unassigned", { cwd: primary.root, workspaceId: "missing-workspace" });
    const terminals = main.workSummary(project.id)!.terminals;
    expect(terminals[0]!.workArea).toEqual({ workspaceId: primary.id, root: primary.root, kind: "project", comparisonId: null });
    expect(terminals[1]!.workArea).toEqual({ workspaceId: candidate.id, root: candidate.root, kind: "candidate", comparisonId: "comparison-1" });
    expect(terminals[2]!.workArea).toBeNull();
  });

  it("preserves dispatch results after a worker disappears and fences live assignments to the same source", () => {
    const { main, project, candidate, add } = fixture();
    const owner = add("term-owner");
    add("term-worker", { generation: 9 });
    add("term-candidate", { workspaceId: candidate.id });
    add("term-foreign", { projectId: "project-2" });
    add("term-closed", { closed: true });
    add("term-shell", { type: "shell" });
    const finished: PlanTask = { text: "Finished work", paths: ["done.ts"], state: "done", dispatchResult: { workerId: "term-gone", outcome: "completed" } };
    owner.plan = [
      finished,
      { text: "Incomplete attempt", paths: [], state: "pending", dispatchResult: { workerId: "term-gone", outcome: "incomplete" } },
      ...["term-worker", "term-candidate", "term-foreign", "term-closed", "term-shell", "term-missing"].map((workerId): PlanTask => ({
        text: `Assigned to ${workerId}`, paths: [], state: "active", workerId,
        dispatchResult: { workerId: "term-gone", outcome: "failed" },
      })),
    ];
    let tasks = main.workSummary(project.id)!.terminals[0]!.tasks;
    expect(tasks[0]).toEqual({ task: finished, worker: null, attention: [], nextAction: { kind: "plan", terminalId: owner.id, generation: owner.generation } });
    expect(tasks[1]).toMatchObject({ worker: null, attention: ["task-incomplete"], task: { dispatchResult: { outcome: "incomplete" } } });
    expect(tasks[2]).toMatchObject({ worker: { terminalId: "term-worker", generation: 9 }, attention: [], nextAction: { kind: "terminal", terminalId: "term-worker", generation: 9 } });
    for (const task of tasks.slice(3)) expect(task).toMatchObject({ worker: null, attention: ["worker-unavailable"], nextAction: { kind: "plan", terminalId: owner.id, generation: owner.generation } });

    main.runtime.delete("term-worker");
    tasks = main.workSummary(project.id)!.terminals[0]!.tasks;
    expect(tasks[2]).toMatchObject({ worker: null, attention: ["worker-unavailable"], task: { workerId: "term-worker", dispatchResult: { workerId: "term-gone", outcome: "failed" } } });
    expect(tasks[0]!.task.dispatchResult).toEqual(finished.dispatchResult);
  });
});

describe("main global attention and validated inspection", () => {
  function attentionFixture() {
    const state = fixture();
    const owner = state.add("term-1", { plan: [{ text: "Recover task", paths: [], state: "pending", dispatchResult: { workerId: "gone", outcome: "incomplete" } }] });
    const item = state.main.workOverview().items[0]!;
    return { ...state, owner, item };
  }

  it("attributes global facts exactly like individual project summaries with one scoped roster pass", () => {
    const { main, project, candidate, add } = fixture();
    const owner = add("term-1", { workspaceId: candidate.id, verify: { state: "timeout", command: "test", summary: "timed out" } });
    const second: Project = { ...project, id: "project-2", cwd: "/elsewhere/active", terminalIds: new Set(["term-2"]), activationGeneration: 0 };
    main.projects.set(second.id, second);
    add("term-2", { projectId: second.id });
    project.terminalIds.delete("term-2");
    main.activityInputs.set("term-2", { ...emptyActivityInput(), lastBoundary: "agent_start" });
    add("term-closed", { closed: true, verify: { state: "fail", command: "test", summary: "failed" } });
    add("term-unlisted", { verify: { state: "fail", command: "test", summary: "failed" } });
    project.terminalIds.delete("term-unlisted");
    const single = [...main.projects.keys()].map((id) => main.workSummary(id)!);
    const lookups = vi.spyOn(main.runtime, "get");
    expect(main.workOverview()).toEqual(workOverview(single));
    // Includes workspaceOfTerminal/projectOfTerminal's constant-time owner lookup.
    expect(lookups.mock.calls.length).toBeLessThanOrEqual(6);
    expect(main.workOverview().items[0]).toMatchObject({ projectId: project.id, terminalId: owner.id, workArea: { root: candidate.root } });
    expect(main.workOverview().projects[1]).toMatchObject({ projectId: second.id, working: 1, attentionCount: 0 });
  });

  it("uses actual activation, returns exact navigation, and never resolves recorded attention", async () => {
    const { main, project, owner, item } = attentionFixture();
    const before = structuredClone(owner.plan);
    const result = await main.inspectWorkAttention(item.id);
    expect(result).toEqual({ ok: true, folder: { cwd: project.cwd, projectId: project.id,
      workspaceId: "ws-primary", activationGeneration: 1, needsLogin: false }, action: item.action });
    expect(main.send).toHaveBeenCalledWith("folder:opened", expect.objectContaining({ activationGeneration: 1 }), null);
    expect(main.activeProjectId).toBe(project.id);
    expect(main.workOverview().items).toContainEqual(item);
    expect(owner.plan).toEqual(before);
    expect(owner.verify.state).toBe("untested");
    expect(owner.modified.size).toBe(0);
    expect((await main.inspectWorkAttention(item.id)).ok).toBe(true);
    expect(main.workOverview().items).toContainEqual(item);
  });

  it.each([undefined, null, 42, {}, [], "", "work-", `work-${"a".repeat(63)}`, `work-${"A".repeat(64)}`, `work-${"a".repeat(65)}`, `work-${"0".repeat(64)}`])("rejects malformed or missing id %j without navigation", async (id) => {
    const { main } = attentionFixture();
    const activation = vi.spyOn(main, "activateProject");
    expect((await main.inspectWorkAttention(id)).ok).toBe(false);
    expect(activation).not.toHaveBeenCalled();
    expect(main.projectSelectionAction).toBe(0);
  });

  const mutations = ["closed", "missing", "recycled", "reassigned", "unlisted", "source-moved", "workspace-moved", "source-removed", "project-root-moved", "task-text", "task-index", "attempt-changed", "retry-assigned", "resolved", "project-closed", "closing", "switching", "disposed"] as const;
  function mutate(kind: typeof mutations[number], state: ReturnType<typeof attentionFixture>) {
    const { main, project, owner, primary } = state;
    if (kind === "closed") owner.closed = true;
    if (kind === "missing") main.runtime.delete(owner.id);
    if (kind === "recycled") owner.generation++;
    if (kind === "reassigned") owner.projectId = "other-project";
    if (kind === "unlisted") project.terminalIds.delete(owner.id);
    if (kind === "source-moved") primary.root = "/moved";
    if (kind === "workspace-moved") owner.workspaceId = "ws-candidate";
    if (kind === "source-removed") project.workspaces.delete(primary.id);
    if (kind === "project-root-moved") project.cwd = "/another-project-root";
    if (kind === "attempt-changed") owner.plan[0]!.dispatchResult!.outcome = "failed";
    if (kind === "retry-assigned") {
      const worker = state.add("term-retry", { generation: 10 });
      owner.plan[0]!.workerId = worker.id;
    }
    if (kind === "switching") main.switchingProjects.add(project.id);
    if (kind === "disposed") main.disposed = true;
    if (kind === "task-text") owner.plan[0]!.text = "Replaced task";
    if (kind === "task-index") owner.plan.unshift({ text: "New task", paths: [], state: "pending" });
    if (kind === "resolved") owner.plan[0]!.state = "done";
    if (kind === "project-closed") main.projects.delete(project.id);
    if (kind === "closing") main.projectClosePromises.set(project.id, new Promise(() => {}));
  }

  it.each(mutations)("rejects %s attention before activation", async (kind) => {
    const state = attentionFixture();
    mutate(kind, state);
    const activation = vi.spyOn(state.main, "activateProject");
    expect((await state.main.inspectWorkAttention(state.item.id)).ok).toBe(false);
    expect(activation).not.toHaveBeenCalled();
  });

  it.each(mutations)("revalidates %s attention after asynchronous activation", async (kind) => {
    const state = attentionFixture();
    let release!: (value: boolean) => void;
    state.main.agentNeedsLogin = () => new Promise((resolve) => { release = resolve; });
    const inspection = state.main.inspectWorkAttention(state.item.id);
    mutate(kind, state);
    release(false);
    expect((await inspection).ok).toBe(false);
  });

  it.each(["another-project", "same-project", "new-selection", "activation-epoch", "disposed"] as const)("does not return a stale action when %s wins navigation", async (race) => {
    const { main, project, item } = attentionFixture();
    let release!: (value: boolean) => void;
    main.agentNeedsLogin = () => new Promise((resolve) => { release = resolve; });
    const inspection = main.inspectWorkAttention(item.id);
    const firstRelease = release;
    if (race === "another-project" || race === "same-project") {
      const target = race === "same-project" ? project : { ...project, id: "project-2", activationGeneration: 0 };
      main.projects.set(target.id, target);
      const newer = main.activateProject(target.id);
      release(false);
      expect(await newer).not.toBeNull();
    }
    if (race === "new-selection") main.projectSelectionAction++;
    if (race === "activation-epoch") main.projectActivationGeneration++;
    if (race === "disposed") main.disposed = true;
    firstRelease(false);
    expect((await inspection).ok).toBe(false);
  });

  it("revalidates after activateProject has produced a payload but before inspection resumes", async () => {
    const { main, item } = attentionFixture();
    const activate = main.activateProject.bind(main);
    main.activateProject = async (id) => {
      const folder = await activate(id);
      main.projectSelectionAction++;
      return folder;
    };
    expect((await main.inspectWorkAttention(item.id)).ok).toBe(false);
    expect(main.send).toHaveBeenCalledTimes(1);
  });
});

describe("main generation-fenced Verify report", () => {
  it("uses canonical formatting and retains a stale pass's historical execution and output", () => {
    const { main, project, add } = fixture();
    const owner = add("term-1", { verify: historicalPass(), verifyOutput: "12 tests passed\nhistorical execution output" });
    const report = main.verifyReport(owner.id, owner.generation);
    expect(report).toBe(formatVerifyContext(owner.verify, owner.verifyOutput));
    expect(report).toContain("**Status:** ⚠️ OUTDATED");
    expect(report).toContain("**Validity:** source changed after verification");
    expect(report).toContain("**Historical execution:** ✅ PASSED (exit code 0)");
    expect(report).toContain("**Elapsed:** 1250 ms");
    expect(report).toContain(`**Tree:** ${"a".repeat(40)}`);
    expect(report).toContain("historical execution output");
    expect(main.workSummary(project.id)!.terminals[0]).toMatchObject({ verify: owner.verify, attention: ["verify-stale"], nextAction: { kind: "evidence", terminalId: owner.id, generation: 7 } });
  });

  it("does not substitute the latest generation when a terminal id is recycled", () => {
    const { main, add } = fixture();
    const owner = add("term-1", { verify: historicalPass() });
    expect(main.verifyReport(owner.id, 7)).not.toBeNull();
    add(owner.id, { generation: 8, verifyOutput: "replacement output" });
    expect(main.verifyReport(owner.id, 7)).toBeNull();
    expect(main.verifyReport(owner.id, 8)).toBe(formatVerifyContext(main.runtime.get(owner.id)!.verify, "replacement output"));
  });

  it.each([
    [undefined, 7], [null, 7], [42, 7], [{ id: "term-1" }, 7], ["", 7], [" ", 7], ["t".repeat(65), 7],
    ["term-1", undefined], ["term-1", null], ["term-1", "7"], ["term-1", 0], ["term-1", -1],
    ["term-1", 1.5], ["term-1", Number.NaN], ["term-1", Infinity], ["term-1", Number.MAX_SAFE_INTEGER + 1],
    ["term-1", 6], ["term-missing", 7],
  ])("rejects malformed, missing, or mismatched target (%j, %j)", (id, generation) => {
    const { main, add } = fixture();
    add("term-1");
    expect(main.verifyReport(id, generation)).toBeNull();
  });

  it.each(["closed", "shell", "unowned", "removed-project"] as const)("rejects a %s terminal even with the exact generation", (reason) => {
    const { main, project, add } = fixture();
    const owner = add("term-1", { verify: historicalPass() });
    if (reason === "closed") owner.closed = true;
    if (reason === "shell") owner.type = "shell";
    if (reason === "unowned") owner.projectId = null;
    if (reason === "removed-project") main.projects.delete(project.id);
    expect(main.verifyReport(owner.id, owner.generation)).toBeNull();
  });

  it("keeps the canonical missing-output explanation for restored historical evidence", () => {
    const { main, add } = fixture();
    const owner = add("term-1", { verify: historicalPass(), verifyOutput: null });
    expect(main.verifyReport(owner.id, owner.generation)).toBe(formatVerifyContext(owner.verify, null));
    expect(main.verifyReport(owner.id, owner.generation)).toContain("**Output:** not retained for this historical run");
  });
});

it("registers both summary readers through the capability-gated IPC facade and forwards exact preload targets", () => {
  const registrar = methods.get("registerIpc")!.getText(sourceFile);
  expect(registrar).toContain("this.handleIpc(channel, listener)");
  expect(registrar).toContain('ipcMain.handle("work:overview"');
  expect(registrar).toContain("return this.workOverview()");
  expect(registrar).toContain('ipcMain.handle("work:inspect", async (_e, id: unknown)');
  expect(registrar).toContain("return this.inspectWorkAttention(id)");
  expect(registrar).not.toContain('electronIpcMain.handle("work:overview"');
  expect(registrar).not.toContain('electronIpcMain.handle("work:inspect"');
  expect(registrar).toContain('ipcMain.handle("project:work-summary"');
  expect(registrar).toContain("return this.workSummary(projectId)");
  expect(registrar).toContain('ipcMain.handle("verify:report", (_e, id: unknown, generation: unknown) => this.verifyReport(id, generation))');
  expect(registrar).not.toContain('electronIpcMain.handle("project:work-summary"');
  expect(registrar).not.toContain('electronIpcMain.handle("verify:report"');
  const preload = readFileSync(new URL("../../../electron/preload.ts", import.meta.url), "utf8");
  expect(preload).toContain('getProjectWorkSummary: (projectId) => ipcRenderer.invoke("project:work-summary", projectId)');
  expect(preload).toContain('getVerifyReport: (terminalId, generation) => ipcRenderer.invoke("verify:report", terminalId, generation)');
  expect(preload).toContain("electronIpcRenderer.invoke(channel, ...args, rendererCapability)");
});
