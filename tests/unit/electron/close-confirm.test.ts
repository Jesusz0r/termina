import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { closeConfirmation, closeTaskText, needsCloseConfirmation, type TerminalCloseImpact } from "../../../electron/main/close-confirm.ts";
import { emptyActivityInput, hasLiveAgentWork } from "../../../electron/agent-activity.ts";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const appClass = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "TerminaApp")!;

function method(name: string, bindings: Record<string, unknown>) {
  const node = appClass.members.find((member) => ts.isMethodDeclaration(member) && member.name.getText(source) === name)!;
  const text = node.getText(source).replace(/^private /, "");
  const factory = ts.transpileModule(`return ({ ${text} }).${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), factory)(...Object.values(bindings));
}

function impact(overrides: Partial<TerminalCloseImpact> = {}): TerminalCloseImpact {
  return { id: "term-1", generation: 1, projectRoot: "/one", cwd: "/one", type: "agent", working: false, exited: false, runId: null, dispatchTask: null, taskText: null, promptPayloadFile: null, childRunIds: [], verifying: false, verifyPid: null, changedFiles: 0, ...overrides };
}

function terminal(id = "term-1", projectId = "p1") {
  return { id, generation: 1, projectId, closed: false, cwd: projectId === "p1" ? "/one" : "/two", type: "agent", busy: true, currentRun: { id: `run-${id}` }, modified: new Map(), pty: { hasExited: false, interrupt: vi.fn() } };
}

function harness() {
  const first = terminal();
  const second = terminal("term-2", "p2");
  const terminals = new Map([[first.id, first], [second.id, second]]);
  const projects = new Map([
    ["p1", { id: "p1", cwd: "/one", worldlines: { activeCandidates: vi.fn(async () => 0), list: vi.fn(() => [] as { id: string }[]) } }],
    ["p2", { id: "p2", cwd: "/two", worldlines: { activeCandidates: vi.fn(async () => 0), list: vi.fn(() => [] as { id: string }[]) } }],
  ]);
  const children = new Map<string, string[]>();
  const showMessageBox = vi.fn(async (_win: unknown, _options?: unknown) => ({ response: 0 }));
  const bindings = { closeConfirmation, closeTaskText, hasLiveAgentWork, emptyActivityInput, dialog: { showMessageBox }, isPtyRendererSendTargetCurrent: (a: unknown, b: unknown) => a !== null && a === b };
  const app = {
    disposed: false,
    target: {} as object | null,
    rendererGeneration: 1,
    rendererWindowGeneration: 1,
    selected: first,
    switching: new Set<string>(),
    win: { isDestroyed: () => false } as { isDestroyed: () => boolean } | null,
    runtime: { get: (id: string) => terminals.get(id), values: () => terminals.values() },
    projects,
    activityInputs: new Map(),
    dispatchRuns: new Map<string, { ownerId: string; taskText: string }>(),
    verifyRuns: new Map(),
    verifyJobs: new Map(),
    subagents: { activeRunIds: (id: string) => children.get(id) ?? [] },
    terminalCloseRequests: new WeakMap(),
    pendingDraftDiscards: new Map(),
    captureRendererSendTarget() { return this.target; },
    projectOfTerminal: (id: string) => projects.get(terminals.get(id)?.projectId ?? "") ?? null,
    projectIsSwitching: (id: string) => app.switching.has(id),
    closeUserTerminal: vi.fn((id: string) => { terminals.get(id)!.closed = true; }),
    selectedTerminal() { return this.selected; },
    terminalCloseImpact: method("terminalCloseImpact", bindings),
    performTerminalClose: method("performTerminalClose", bindings),
    requestTerminalClose: method("requestTerminalClose", bindings),
    confirmCloseConsequences: method("confirmCloseConsequences", bindings),
    confirmClose: method("confirmClose", bindings),
    abortActive: method("abortActive", bindings),
    confirmUnsavedEditorBuffers: vi.fn(async () => ({ ok: true, discardDraftTokens: ["draft-token"] })),
    discardEditorDrafts: vi.fn(async () => undefined),
  };
  return { app, first, second, terminals, projects, children, showMessageBox };
}

function deferred() {
  let resolve!: (result: { response: number }) => void;
  const promise = new Promise<{ response: number }>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("close consequence presentation", () => {
  it("bounds task text and discloses truncation", () => {
    expect(closeTaskText("  Fix\n the parser  ")).toBe("Fix the parser");
    expect(closeTaskText("a".repeat(300))).toBe("a".repeat(240) + "…");
    expect(closeTaskText(null)).toBeNull();
    const options = closeConfirmation({ kind: "terminal", id: "term-1" }, [impact({ working: true, taskText: "Fix the parser" })])!;
    expect(options.detail).toContain("Task: Fix the parser");
    expect(options.detail).not.toContain("Task description unavailable");
  });

  it("does not ask for a clean idle agent, but shell activity is unknown", () => {
    expect(needsCloseConfirmation(impact())).toBe(false);
    expect(closeConfirmation({ kind: "terminal", id: "term-1" }, [impact()])).toBeNull();
    const options = closeConfirmation({ kind: "terminal", id: "term-1" }, [impact({ type: "shell" })])!;
    expect(options.detail).toContain("command activity unknown");
    expect(options.message).toContain("term-1");
    expect(options.defaultId).toBe(1);
    expect(options.cancelId).toBe(1);
    expect(needsCloseConfirmation(impact({ type: "shell", exited: true }))).toBe(false);
  });

  it("names tasks, projects, children, checks, review, and candidate loss", () => {
    const options = closeConfirmation({ kind: "app" }, [impact({ working: true, dispatchTask: "Fix the parser", childRunIds: ["bg-1", "bg-2"], verifying: true, changedFiles: 3 })], [{ projectRoot: "/two", count: 2, comparisonIds: ["cmp-1"] }])!;
    expect(options.detail).toContain("term-1 — dispatch worker — /one");
    for (const text of ["Fix the parser", "2 background child", "Verification in progress", "3 file(s) in Change Review", "2 candidate(s) in /two", "not reverted", "not guaranteed to stop", "not a detach"]) expect(options.detail).toContain(text);
  });

  it("does not imply that Ctrl+C stops separate workers, children, or verification", () => {
    const options = closeConfirmation({ kind: "interrupt", id: "term-1" }, [impact({ childRunIds: ["bg-1"], verifying: true })])!;
    expect(options.message).toBe("Send Ctrl+C to term-1?");
    expect(options.detail).toContain("does not close the terminal");
    expect(options.detail).toContain("not directly stopped");
    expect(options.detail).toContain("including separate dispatch workers");
  });
});

describe("main terminal close and interrupt gates", () => {
  it("denies child admission once the owner is closed or the app is disposing", () => {
    const property = appClass.members.find((member) => ts.isPropertyDeclaration(member) && member.name.getText(source) === "subagents") as ts.PropertyDeclaration;
    const sinks = (property.initializer as ts.NewExpression).arguments![0] as ts.ObjectLiteralExpression;
    const callback = sinks.properties.find((member) => ts.isPropertyAssignment(member) && member.name.getText(source) === "eventsDirFor") as ts.PropertyAssignment;
    const factory = ts.transpileModule(`return ${callback.initializer.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const h = harness();
    const app = { ...h.app, eventsDirOf: () => "/owned-events" };
    const eventsDirFor = new Function(factory).call(app);
    expect(eventsDirFor("term-1")).toBe("/owned-events");
    h.first.closed = true;
    expect(eventsDirFor("term-1")).toBeNull();
    h.first.closed = false;
    h.first.pty.hasExited = true;
    expect(eventsDirFor("term-1")).toBeNull();
    h.first.pty.hasExited = false;
    app.disposed = true;
    expect(eventsDirFor("term-1")).toBeNull();
    app.disposed = false;
    expect(eventsDirFor("term-missing")).toBeNull();
  });

  it("rejects stale generations before showing a dialog", async () => {
    const h = harness();
    expect(await h.app.requestTerminalClose("term-1", 2)).toMatchObject({ ok: false });
    expect(h.showMessageBox).not.toHaveBeenCalled();
    expect(h.app.closeUserTerminal).not.toHaveBeenCalled();
  });

  it("cancel preserves the terminal; acceptance closes exactly that target", async () => {
    const h = harness();
    h.showMessageBox.mockResolvedValueOnce({ response: 1 });
    expect(await h.app.requestTerminalClose("term-1", 1)).toEqual({ ok: false, cancelled: true });
    expect(h.first.closed).toBe(false);
    expect(h.app.closeUserTerminal).not.toHaveBeenCalled();
    expect(await h.app.requestTerminalClose("term-1", 1)).toEqual({ ok: true });
    expect(h.app.closeUserTerminal).toHaveBeenCalledExactlyOnceWith("term-1");
    expect(h.second.closed).toBe(false);
  });

  it("coalesces duplicate close requests into one confirmation", async () => {
    const h = harness();
    const d = deferred();
    h.showMessageBox.mockReturnValueOnce(d.promise);
    const first = h.app.requestTerminalClose("term-1", 1);
    const duplicate = h.app.requestTerminalClose("term-1", 1);
    expect(first).toBe(duplicate);
    expect(h.showMessageBox).toHaveBeenCalledTimes(1);
    d.resolve({ response: 0 });
    expect(await first).toEqual({ ok: true });
    expect(h.app.closeUserTerminal).toHaveBeenCalledTimes(1);
  });

  it.each(["document", "terminal", "project", "teardown", "children", "new run"])("fences a changed %s after confirmation", async (change) => {
    const h = harness();
    const d = deferred();
    h.showMessageBox.mockReturnValueOnce(d.promise);
    const request = h.app.requestTerminalClose("term-1", 1);
    if (change === "document") h.app.target = {};
    if (change === "terminal") h.terminals.set("term-1", { ...h.first, generation: 2 });
    if (change === "project") h.projects.set("p1", { ...h.projects.get("p1")! });
    if (change === "teardown") h.app.switching.add("p1");
    if (change === "children") h.children.set("term-1", ["bg-1"]);
    if (change === "new run") h.first.currentRun = { id: "new-run" };
    d.resolve({ response: 0 });
    expect(await request).toMatchObject({ ok: false, error: expect.any(String) });
    expect(h.app.closeUserTerminal).not.toHaveBeenCalled();
  });

  it.each(["child", "verification"])("rejects a replaced %s even if its count stays the same", async (kind) => {
    const h = harness();
    h.children.set("term-1", ["bg-1"]);
    h.app.verifyJobs.set("term-1", { child: { pid: 123 } });
    const d = deferred();
    h.showMessageBox.mockReturnValueOnce(d.promise);
    const request = h.app.requestTerminalClose("term-1", 1);
    if (kind === "child") h.children.set("term-1", ["bg-2"]);
    else h.app.verifyJobs.set("term-1", { child: { pid: 456 } });
    d.resolve({ response: 0 });
    expect(await request).toMatchObject({ ok: false, error: expect.stringContaining("work changed") });
    expect(h.app.closeUserTerminal).not.toHaveBeenCalled();
  });

  it("dialog failure fails closed and can be retried", async () => {
    const h = harness();
    h.showMessageBox.mockRejectedValueOnce(new Error("dialog unavailable"));
    expect(await h.app.requestTerminalClose("term-1", 1)).toMatchObject({ ok: false, error: expect.stringContaining("dialog unavailable") });
    expect(h.first.closed).toBe(false);
    expect(await h.app.requestTerminalClose("term-1", 1)).toEqual({ ok: true });
  });

  it("uses live activity admission, not just the busy flag or a retained worker label", () => {
    const h = harness();
    h.first.busy = false;
    h.app.activityInputs.set("term-1", { ...emptyActivityInput(), preflightInFlight: true });
    expect(h.app.terminalCloseImpact(h.first).working).toBe(true);
    expect(h.app.terminalCloseImpact(h.first).dispatchTask).toBeNull();
    h.app.dispatchRuns.set("term-1", { ownerId: "term-2", taskText: "Specific task" });
    h.children.set("term-1", ["bg-1", "bg-2"]);
    h.app.verifyJobs.set("term-1", { child: { pid: 123 } });
    expect(h.app.terminalCloseImpact(h.first)).toMatchObject({ dispatchTask: "Specific task", childRunIds: ["bg-1", "bg-2"], verifying: true, verifyPid: 123 });
  });

  it("native interrupt dialog failure fails closed", async () => {
    const h = harness();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      h.showMessageBox.mockRejectedValueOnce(new Error("dialog unavailable"));
      await h.app.abortActive();
      expect(h.first.pty.interrupt).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("dialog unavailable"));
    } finally { warning.mockRestore(); }
  });

  it("native Ctrl+C honours Cancel and never retargets a changed selection", async () => {
    const h = harness();
    h.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await h.app.abortActive();
    expect(h.first.pty.interrupt).not.toHaveBeenCalled();
    const d = deferred();
    h.showMessageBox.mockReturnValueOnce(d.promise);
    const request = h.app.abortActive();
    h.app.selected = h.second;
    d.resolve({ response: 0 });
    await request;
    expect(h.first.pty.interrupt).not.toHaveBeenCalled();
    expect(h.second.pty.interrupt).not.toHaveBeenCalled();
    await h.app.abortActive();
    expect(h.second.pty.interrupt).toHaveBeenCalledTimes(1);
  });
});

describe("main project and quit consequence gates", () => {
  it("allows native quit confirmation without a window, but fences a new document", async () => {
    const h = harness();
    h.app.win = null;
    h.app.target = null;
    expect(await h.app.confirmCloseConsequences()).toBe(true);
    expect(h.showMessageBox.mock.calls[0][0]).toMatchObject({ message: "Quit Termina?" });
    h.showMessageBox.mockImplementationOnce(async () => { h.app.rendererGeneration++; return { response: 0 }; });
    expect(await h.app.confirmCloseConsequences()).toBe(false);
  });

  it("scopes project close, but quit includes background projects", async () => {
    const h = harness();
    h.projects.get("p2")!.worldlines.activeCandidates.mockResolvedValue(2);
    expect(await h.app.confirmCloseConsequences("p1")).toBe(true);
    const projectOptions = h.showMessageBox.mock.calls[0][1] as { message: string; detail: string };
    expect(projectOptions.message).toBe("Close project /one?");
    expect(projectOptions.detail).toContain("term-1");
    expect(projectOptions.detail).not.toContain("term-2");
    expect(projectOptions.detail).toContain("Other projects remain open");
    expect(await h.app.confirmCloseConsequences()).toBe(true);
    const quitOptions = h.showMessageBox.mock.calls[1][1] as { detail: string };
    expect(quitOptions.detail).toContain("term-2");
    expect(quitOptions.detail).toContain("2 candidate(s) in /two");
  });

  it("does not discard editor recovery copies after consequence cancellation", async () => {
    const h = harness();
    h.showMessageBox.mockResolvedValueOnce({ response: 1 });
    expect(await h.app.confirmClose("p1")).toBe(false);
    expect(h.app.discardEditorDrafts).not.toHaveBeenCalled();
    expect(h.app.pendingDraftDiscards.size).toBe(0);
  });

  it("rechecks scope after the dialog and cancels if new affected work appears", async () => {
    const h = harness();
    h.showMessageBox.mockImplementationOnce(async () => {
      h.terminals.set("term-3", terminal("term-3"));
      return { response: 0 };
    });
    expect(await h.app.confirmCloseConsequences("p1")).toBe(false);
    expect(h.showMessageBox).toHaveBeenCalledTimes(2);
    expect(h.showMessageBox.mock.calls[1][1]).toMatchObject({ message: "Work changed while confirming" });
  });

  it("rejects replaced candidate work even if the active count is unchanged", async () => {
    const h = harness();
    h.projects.get("p1")!.worldlines.activeCandidates.mockResolvedValue(1);
    h.projects.get("p1")!.worldlines.list.mockReturnValue([{ id: "cmp-1" }]);
    h.showMessageBox.mockImplementationOnce(async () => {
      h.projects.get("p1")!.worldlines.list.mockReturnValue([{ id: "cmp-2" }]);
      return { response: 0 };
    });
    expect(await h.app.confirmCloseConsequences("p1")).toBe(false);
    expect(h.showMessageBox.mock.calls[1][1]).toMatchObject({ message: "Work changed while confirming" });
  });

  it("rejects a replaced renderer document without approving teardown", async () => {
    const h = harness();
    h.showMessageBox.mockImplementationOnce(async () => { h.app.target = {}; return { response: 0 }; });
    expect(await h.app.confirmCloseConsequences("p1")).toBe(false);
  });

  it("candidate inspection failure is not silently treated as no activity", async () => {
    const h = harness();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      h.projects.get("p1")!.worldlines.activeCandidates.mockRejectedValue(new Error("read failed"));
      expect(await h.app.confirmCloseConsequences("p1")).toBe(false);
      expect(h.showMessageBox).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("read failed"));
    } finally { warning.mockRestore(); }
  });
});
