import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkInspector } from "../../../src/main/work-inspector.ts";
import { projectCards, type OverviewWorkCard } from "../../../src/main/project-overview.ts";
import { projectWorkSummary, workOverview, type WorkSummaryTerminalFacts } from "../../../electron/main/work-summary.ts";
import type { InstanceSummary, ProjectWorkSummary, TerminaBridge, WorkSummaryAction } from "../../../shared/types.ts";
import { installFakeDom, type FakeEl } from "./fake-dom.ts";

let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createWorkInspector>;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { view?.dispose(); dom.cleanup(); });
const text = (node: FakeEl): string => [node.textContent, ...node.children.map(text)].join("\n");
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

function terminal(id: string, overrides: Partial<WorkSummaryTerminalFacts> = {}): WorkSummaryTerminalFacts {
  return {
    id, generation: 4, type: "agent", model: "provider/model", activity: { state: "idle", reason: null },
    workspace: { id: "ws-1", root: "/projects/example", primary: true },
    verify: { state: "untested", command: null, summary: null }, trackedChanges: 0, plan: [], planCreationError: null, planStartOwnerError: null, ...overrides,
  };
}
function selection(kind: WorkSummaryAction["kind"] = "evidence", shell = false): { project: ProjectWorkSummary; card: OverviewWorkCard } {
  const project = projectWorkSummary({ id: "project-1", cwd: "/projects/example" }, [
    terminal("owner", { generation: 7, plan: [{ text: "Repair parser", state: "pending", paths: ["src/parser.ts"], workerId: "worker" }] }),
    terminal("worker", {
      type: shell ? "shell" : "agent", generation: 12,
      verify: { state: "stale", command: "pnpm test", summary: "Previous check passed", staleReason: "Source changed",
        result: { state: "pass", exitCode: 0, startedAt: 1, finishedAt: 2 } },
      trackedChanges: 3,
    }),
  ]);
  const owner = project.terminals[0]!;
  const effective = project.terminals[1]!;
  return { project, card: {
    key: "task-1", title: "Repair parser", state: "Marked pending", execution: "idle · worker worker",
    context: "Plan owner owner\nworker · provider/model\nShared project files · /projects/example",
    evidence: shell ? "Check: unavailable for shells" : "Worker check: Outdated · historical pass\n3 tracked paths · not a review-completion claim",
    attention: "Check outdated", action: { kind, terminalId: kind === "plan" ? owner.terminalId : effective.terminalId,
      generation: kind === "plan" ? owner.generation : effective.generation },
    owner, terminal: effective, task: owner.tasks[0]!,
  } };
}
function pendingSelection(): { project: ProjectWorkSummary; card: OverviewWorkCard } {
  const project = projectWorkSummary({ id: "project-1", cwd: "/projects/displayed" }, [
    terminal("owner", { generation: 7, plan: [{ text: "Repair parser", state: "pending", paths: ["src/parser.ts"] }] }),
  ]);
  const card = projectCards(workOverview([project]).projects[0]!)[0]!;
  if ("recovery" in card) throw new Error("Expected a Plan Board task");
  return { project, card };
}
function deferred() {
  let resolve!: (value: string | null) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string | null>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(value = selection()) {
  const element = dom.document.createElement("aside");
  dom.document.body.append(element);
  const getVerifyReport = vi.fn<TerminaBridge["getVerifyReport"]>().mockResolvedValue("report contents");
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  const onFocus = vi.fn();
  const onCandidateRecovery = vi.fn();
  const getReviewFiles = vi.fn<TerminaBridge["getReviewFiles"]>().mockResolvedValue({ ok: true, files: [], total: 0 });
  const getReviewDiff = vi.fn<TerminaBridge["getReviewDiff"]>().mockResolvedValue({ ok: false, error: "Baseline unavailable" });
  const onTerminalControl = vi.fn<Parameters<typeof createWorkInspector>[0]["onTerminalControl"]>().mockResolvedValue({ ok: true });
  const startPlanTask = vi.fn<TerminaBridge["startPlanTask"]>().mockResolvedValue({ ok: true, dispatched: 1 });
  view = createWorkInspector({ element: element as unknown as HTMLElement, getVerifyReport, getReviewFiles, getReviewDiff, startPlanTask, onNavigate, onClose, onFocus, onTerminalControl, onCandidateRecovery });
  view.render(value.project, value.card);
  const node = (name: string): FakeEl => {
    const found = element.querySelector(`.overview-inspector-${name}`);
    expect(found, `inspector ${name}`).not.toBeNull();
    return found!;
  };
  return { ...value, element, node, getVerifyReport, getReviewFiles, getReviewDiff, startPlanTask, onNavigate, onClose, onFocus, onTerminalControl, onCandidateRecovery };
}

describe("selected work inspector", () => {
  it("starts only the exact selected pending task without navigating or marking execution", async () => {
    const h = harness(pendingSelection());
    const before = JSON.stringify({ project: h.project, card: h.card });
    expect(h.startPlanTask).not.toHaveBeenCalled();
    expect(h.node("start").hidden).toBe(false);
    expect(h.node("start").disabled).toBe(false);
    expect(h.node("start-status").textContent).toContain("shared project files");
    expect(h.node("primary").classList.contains("is-secondary")).toBe(true);
    h.node("start").click(); h.node("start").click(); await flush();
    expect(h.startPlanTask).toHaveBeenCalledExactlyOnceWith({
      projectRoot: "/projects/displayed", owner: { projectId: "project-1", workspaceId: "ws-1",
        root: "/projects/example", terminalId: "owner", generation: 7 }, task: h.card.task!.task,
    });
    expect(h.startPlanTask.mock.calls[0]![0].task).not.toBe(h.card.task!.task);
    expect(h.node("start-status").textContent).toContain("dispatched");
    expect(h.node("start-status").textContent).not.toMatch(/working|completed|verified/);
    expect(h.node("start").disabled).toBe(true);
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.onFocus).not.toHaveBeenCalled();
    expect(h.getVerifyReport).not.toHaveBeenCalled();
    expect(JSON.stringify({ project: h.project, card: h.card })).toBe(before);
  });

  it("retains the pending control, inspector focus and feedback through unrelated factual refreshes", async () => {
    const h = harness(pendingSelection());
    let resolve!: (value: { ok: boolean; error?: string }) => void;
    h.startPlanTask.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const control = h.node("start"); control.focus(); control.click();
    const next = structuredClone({ project: h.project, card: h.card });
    next.card.terminal.trackedChanges++;
    view.render(next.project, next.card);
    expect(h.node("start")).toBe(control);
    expect(control.disabled).toBe(true);
    expect(dom.document.activeElement).toBe(h.node("title"));
    expect(h.node("start-status").textContent).toContain("Starting only this task");
    control.click(); expect(h.startPlanTask).toHaveBeenCalledOnce();
    resolve({ ok: false, error: "That task overlaps a running dispatch <literal>" }); await flush();
    expect(h.node("start-status").textContent).toContain("<literal>");
    expect(h.node("start-status").children).toHaveLength(0);
    expect(control.disabled).toBe(false);
  });

  it("reports a transport failure without changing the task and allows another explicit attempt", async () => {
    const h = harness(pendingSelection());
    h.startPlanTask.mockRejectedValueOnce(new Error("bridge unavailable"));
    h.node("start").click(); await flush();
    expect(h.node("start-status").textContent).toContain("could not be started");
    expect(h.node("start").disabled).toBe(false);
    h.node("start").click(); await flush();
    expect(h.startPlanTask).toHaveBeenCalledTimes(2);
    expect(h.node("start").getAttribute("aria-busy")).toBe("false");
    expect(h.card.task!.task.state).toBe("pending");
  });

  it.each(["busy owner", "duplicate", "active", "done", "worker", "prior attempt", "no task", "no source"])(
    "does not start %s even with a programmatic click", (change) => {
      const value = pendingSelection();
      if (change === "busy owner" || change === "duplicate") value.card.task!.startError = change;
      if (change === "active" || change === "done") value.card.task!.task.state = change;
      if (change === "worker") value.card.task!.task.workerId = "assigned";
      if (change === "prior attempt") value.card.task!.task.dispatchResult = { workerId: "previous", outcome: "incomplete" };
      if (change === "no task") value.card.task = null;
      if (change === "no source") value.card.owner.workArea = null;
      const h = harness(value);
      expect(h.node("start").hidden || h.node("start").disabled).toBe(true);
      h.node("start").click(); expect(h.startPlanTask).not.toHaveBeenCalled();
      if (change === "busy owner" || change === "duplicate") expect(h.node("start-status").textContent).toBe(change);
    });

  it.each(["project", "project-root", "owner-generation", "workspace", "paths", "model", "state", "attempt", "selection", "unavailable", "clear", "dispose", "plan event", "leave view"])(
    "fences pending start feedback after %s", async (change) => {
      const h = harness(pendingSelection());
      let resolve!: (result: { ok: boolean; error?: string }) => void;
      h.startPlanTask.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
      h.node("start").click();
      const next = structuredClone({ project: h.project, card: h.card });
      switch (change) {
        case "project": next.project.projectId = "other"; break;
        case "project-root": next.project.root = "/other/project"; break;
        case "owner-generation": next.card.owner.generation++; break;
        case "workspace": next.card.owner.workArea!.workspaceId = "new-workspace"; break;
        case "paths": next.card.task!.task.paths.push("new.ts"); break;
        case "model": next.card.task!.task.model = "provider/changed"; break;
        case "state": next.card.task!.task.state = "done"; break;
        case "attempt": next.card.task!.task.dispatchResult = { workerId: "other", outcome: "failed" }; break;
        case "selection": next.card.key = "other-card"; break;
        case "unavailable": view.unavailable("Work unavailable"); break;
        case "clear": view.clear(); break;
        case "dispose": view.dispose(); break;
        case "plan event": view.invalidateStart("owner"); break;
        case "leave view": view.invalidateStart(); break;
      }
      if (!["unavailable", "clear", "dispose", "plan event", "leave view"].includes(change)) view.render(next.project, next.card);
      resolve({ ok: false, error: "obsolete start error" }); await flush();
      expect(h.node("start-status").textContent).not.toContain("obsolete start error");
      expect(h.onNavigate).not.toHaveBeenCalled();
    });

  it("only invalidates a start for its exact plan owner or workspace", async () => {
    const h = harness(pendingSelection());
    let resolve!: (value: { ok: boolean; error?: string }) => void;
    h.startPlanTask.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    h.node("start").click();
    view.invalidateStart("other-owner");
    view.invalidateStart(undefined, { projectId: "other-project", workspaceId: "ws-1" });
    view.invalidateStart(undefined, { projectId: "project-1", workspaceId: "other-workspace" });
    resolve({ ok: false, error: "current response" }); await flush();
    expect(h.node("start-status").textContent).toBe("current response");
  });

  it("reveals retry in the exact existing plan without dispatching or substituting a worker", () => {
    const value = selection("plan");
    value.card.task!.worker = null;
    value.card.task!.task.workerId = undefined;
    value.card.task!.task.dispatchResult = { outcome: "interrupted", workerId: "old-worker" };
    value.card.terminal = value.card.owner;
    const h = harness(value);
    expect(h.node("retry").hidden).toBe(false);
    h.node("retry").click();
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("project-1", {
      kind: "plan", terminalId: "owner", generation: 7, taskText: "Repair parser",
    });
    expect(h.onTerminalControl).not.toHaveBeenCalled();
    expect(h.node("interrupt").hidden).toBe(true);
    expect(h.node("close-terminal").hidden).toBe(true);
  });

  it("does not restore overview-only Focus controls during a focused refresh", () => {
    const h = harness();
    view.setFocused(true);
    view.render(h.project, h.card);
    expect(h.node("focus").hidden).toBe(true);
    expect(h.node("close").hidden).toBe(true);
    view.setFocused(false);
    expect(h.node("focus").hidden).toBe(false);
    expect(h.node("close").hidden).toBe(false);
  });

  it("opens Verify controls for the effective worker without running checks on selection", () => {
    const h = harness();
    expect(h.node("verify").hidden).toBe(false);
    expect(h.node("verify").textContent).toBe("Open Verify controls");
    expect(h.onNavigate).not.toHaveBeenCalled();
    h.node("verify").click();
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("project-1", { kind: "verify", terminalId: "worker", generation: 12 });
    expect(h.onTerminalControl).not.toHaveBeenCalled();
  });

  it("interrupts only the effective worker, coalescing clicks and leaving attention untouched", async () => {
    const value = selection("terminal");
    value.card.terminal.activity = { state: "working", reason: null };
    const h = harness(value);
    let resolve!: (result: { ok: boolean; cancelled?: boolean }) => void;
    h.onTerminalControl.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const before = JSON.stringify(h.card);
    h.node("interrupt").click(); h.node("interrupt").click(); h.node("close-terminal").click();
    expect(h.onTerminalControl).toHaveBeenCalledExactlyOnceWith({
      projectId: "project-1", workspaceId: "ws-1", root: "/projects/example", terminalId: "worker", generation: 12,
    }, "interrupt");
    resolve({ ok: false, cancelled: true }); await flush();
    expect(h.node("status").textContent).toContain("cancelled");
    expect(h.node("interrupt").disabled).toBe(false);
    expect(JSON.stringify(h.card)).toBe(before);
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it.each(["selection", "unavailable", "clear", "dispose"])("does not paint a late close result after %s", async (change) => {
    const h = harness();
    let resolve!: (result: { ok: boolean; error?: string }) => void;
    h.onTerminalControl.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    h.node("close-terminal").click();
    if (change === "selection") view.render(h.project, { ...h.card, key: "new-selection" });
    else if (change === "unavailable") view.unavailable("Work unavailable");
    else if (change === "clear") view.clear();
    else view.dispose();
    resolve({ ok: false, error: "obsolete close error" }); await flush();
    expect(h.node("status").textContent).not.toContain("obsolete close error");
    expect(h.onTerminalControl).toHaveBeenCalledOnce();
  });

  it("reads canonical worker paths lazily, not owner paths or declared plan paths", async () => {
    const h = harness();
    const recorded = { path: "/projects/example/actual.ts", relPath: "actual.ts", status: "modified" as const };
    h.getReviewFiles.mockResolvedValue({ ok: true, files: [recorded], total: 1 });
    expect(h.getReviewFiles).not.toHaveBeenCalled();
    h.node("inspect-changes").click(); await flush();
    expect(h.getReviewFiles).toHaveBeenCalledExactlyOnceWith({
      projectId: "project-1", terminalId: "worker", generation: 12, workspaceId: "ws-1", root: "/projects/example",
    }, 0);
    const list = h.element.querySelector(".overview-changes-list")!;
    expect(text(list)).toContain("actual.ts");
    expect(text(list)).not.toContain("src/parser.ts");
    list.querySelector("button")!.click(); await flush();
    expect(h.getReviewDiff).toHaveBeenCalledExactlyOnceWith(h.getReviewFiles.mock.calls[0]![0], recorded.path);
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it.each(["owner", "worker", "workspace", "overview unavailable"] as const)("clears selected paths when %s becomes invalid without navigating", async (change) => {
    const h = harness();
    h.getReviewFiles.mockResolvedValue({ ok: true, files: [{ path: "/projects/example/actual.ts", relPath: "actual.ts", status: "modified" }], total: 1 });
    h.node("inspect-changes").click(); await flush();
    const list = h.element.querySelector(".overview-changes-list")!;
    view.invalidateChanges("unrelated-terminal");
    view.invalidateChanges(undefined, { projectId: "other-project", workspaceId: "ws-1" });
    view.invalidateChanges(undefined, { projectId: "project-1", workspaceId: "other-tree" });
    expect(list.children).toHaveLength(1);
    if (change === "workspace") view.invalidateChanges(undefined, { projectId: "project-1", workspaceId: "ws-1" });
    else if (change === "overview unavailable") view.unavailable("Work unavailable");
    else view.invalidateChanges(change);
    expect(list.children).toHaveLength(0);
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it("keeps the opened changes section available for reload when its tracked count changes", async () => {
    const h = harness();
    h.getReviewFiles.mockResolvedValue({ ok: true, files: [{ path: "/projects/example/actual.ts", relPath: "actual.ts", status: "modified" }], total: 1 });
    h.node("inspect-changes").click(); await flush();
    const changes = h.element.querySelector(".overview-work-changes")!;
    const next = structuredClone(h.card);
    next.terminal.trackedChanges++;
    view.render(h.project, next);
    expect(changes.hidden).toBe(false);
    expect(changes.querySelector(".overview-changes-list")!.children).toHaveLength(0);
    expect(changes.querySelector(".overview-changes-status")!.textContent).toContain("Reload changes before inspecting");
    expect(h.getReviewFiles).toHaveBeenCalledOnce();
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it.each(["same targets", "worker generation", "owner removed", "worker tree"] as const)("reconciles roster changes for %s without clearing unrelated work", async (change) => {
    const h = harness();
    h.getReviewFiles.mockResolvedValue({ ok: true, files: [{ path: "/projects/example/actual.ts", relPath: "actual.ts", status: "modified" }], total: 1 });
    h.node("inspect-changes").click(); await flush();
    const roster = [h.card.owner, h.card.terminal].map((terminal) => ({
      id: terminal.terminalId, generation: terminal.generation, projectId: h.project.projectId,
      workspaceId: terminal.workArea!.workspaceId, cwd: terminal.workArea!.root,
      model: "new-model", busy: false,
    })) as InstanceSummary[];
    roster.push({ ...roster[0]!, id: "unrelated", projectId: "other-project" });
    if (change === "worker generation") roster[1]!.generation = h.card.terminal.generation + 1;
    if (change === "owner removed") roster.shift();
    if (change === "worker tree") roster[1]!.cwd = "/other/tree";
    view.invalidateChangesForInstances(roster);
    const list = h.element.querySelector(".overview-changes-list")!;
    expect(list.children).toHaveLength(change === "same targets" ? 1 : 0);
    expect(h.getReviewFiles).toHaveBeenCalledOnce();
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it("renders canonical facts separately from task completion without mutating input or fetching", () => {
    const value = selection();
    const before = JSON.stringify(value);
    const h = harness(value);
    expect(h.node("title").tagName).toBe("H2");
    expect(h.node("title").textContent).toBe(value.card.title);
    expect(h.node("status").getAttribute("role")).toBe("status");
    expect(h.node("facts").tagName).toBe("DL");
    const facts = text(h.element);
    for (const fact of [value.project.name, value.project.root, value.card.state, value.card.execution,
      value.card.context, value.card.evidence, value.card.attention, "Previous check passed", "Source changed", "pass", "0",
      "Declared task paths", "src/parser.ts"]) expect(facts).toContain(fact);
    expect(facts).not.toMatch(/changed files|task completed|task verified/i);
    expect(dom.document.activeElement).not.toBe(h.node("title"));
    view.focus();
    expect(dom.document.activeElement).toBe(h.node("title"));
    expect(h.getVerifyReport).not.toHaveBeenCalled();
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([
    ["terminal", "Open terminal"], ["plan", "Open plan"], ["changes", "Open changes"],
  ] as const)("navigates the explicit %s action and preserves exact worker and owner identities", (kind, label) => {
    const h = harness(selection(kind));
    expect(h.node("primary").textContent).toBe(label);
    h.node("primary").click();
    expect(h.onNavigate).toHaveBeenLastCalledWith(h.project.projectId, h.card.action);
    const worker = h.node("terminal");
    expect(worker.hidden).toBe(kind === "terminal");
    if (!worker.hidden) {
      expect(worker.textContent).toBe("Open terminal");
      worker.click();
      expect(h.onNavigate).toHaveBeenLastCalledWith("project-1", { kind: "terminal", terminalId: "worker", generation: 12 });
    }
    const plan = h.node("plan");
    expect(plan.hidden).toBe(kind === "plan");
    if (!plan.hidden) {
      expect(plan.textContent).toBe("Open plan");
      plan.click();
      expect(h.onNavigate).toHaveBeenLastCalledWith("project-1", { kind: "plan", terminalId: "owner", generation: 7 });
    }
    expect(h.getVerifyReport).not.toHaveBeenCalled();
  });

  it("does not offer check details or a plan for a standalone shell", () => {
    const value = selection("terminal", true);
    value.card.task = null;
    value.card.owner = value.card.terminal;
    value.card.attention = "";
    const h = harness(value);
    expect(h.card.terminal.verify).toBeNull();
    expect(h.node("check").hidden).toBe(true);
    expect(h.node("plan").hidden).toBe(true);
    view.focus();
    expect(h.getVerifyReport).not.toHaveBeenCalled();
  });

  it.each(["evidence", "changes"] as const)("loads reports lazily via %s and renders untrusted content literally", async (kind) => {
    const h = harness(selection(kind));
    const report = '<script>alert("untrusted")</script>\n<img src=x onerror=alert(1)> & output';
    h.getVerifyReport.mockResolvedValue(report);
    expect(h.getVerifyReport).not.toHaveBeenCalled();
    const button = h.node(kind === "evidence" ? "primary" : "check");
    expect(button.textContent).toBe("Check details");
    expect(h.node("check").hidden).toBe(kind === "evidence");
    button.click();
    await flush();
    expect(h.getVerifyReport).toHaveBeenCalledExactlyOnceWith("worker", 12);
    expect(h.node("report").tagName).toBe("PRE");
    expect(h.node("report").textContent).toBe(report);
    expect(h.node("report").children).toHaveLength(0);
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it.each(["null", "error"] as const)("makes a %s report explicitly unavailable and permits retry", async (failure) => {
    const h = harness();
    if (failure === "null") h.getVerifyReport.mockResolvedValueOnce(null);
    else h.getVerifyReport.mockRejectedValueOnce(new Error("report read failed"));
    h.node("primary").click(); await flush();
    expect(text(h.node("status"))).toMatch(/unavailable|error|failed|could not/i);
    expect(h.node("report").textContent).not.toBe("report contents");
    expect(h.node("primary").disabled).toBe(false);
    h.node("primary").click(); await flush();
    expect(h.getVerifyReport).toHaveBeenCalledTimes(2);
    expect(h.node("report").textContent).toBe("report contents");
  });

  it("keeps a loaded report, controls and focus when evidence facts are unchanged", async () => {
    const h = harness();
    const button = h.node("primary");
    button.click(); await flush(); button.focus();
    const next = structuredClone({ project: h.project, card: h.card });
    next.card.state = "Marked done";
    view.render(next.project, next.card);
    expect(h.node("primary")).toBe(button);
    expect(dom.document.activeElement).toBe(button);
    expect(h.node("report").textContent).toBe("report contents");
    expect(text(h.node("facts"))).toContain("Marked done");
    expect(h.getVerifyReport).toHaveBeenCalledTimes(1);
  });

  it.each(["project", "key", "generation", "workArea", "verify", "worker"] as const)("rejects pending reports after changing %s", async (change) => {
    const h = harness();
    const pending = deferred();
    h.getVerifyReport.mockReturnValueOnce(pending.promise);
    h.node("primary").click();
    const next = structuredClone({ project: h.project, card: h.card });
    if (change === "project") next.project.projectId = "other-project";
    if (change === "key") next.card.key = "other-task";
    if (change === "generation") next.card.terminal.generation++;
    if (change === "workArea") next.card.terminal.workArea!.root = "/other/tree";
    if (change === "verify") next.card.terminal.verify!.summary = "new evidence";
    if (change === "worker") next.card.terminal.terminalId = "replacement-worker";
    view.render(next.project, next.card);
    pending.resolve("obsolete report"); await flush();
    expect(h.node("report").textContent).not.toContain("obsolete report");
    expect(h.getVerifyReport).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "owner", "worker"])("invalidates pending and loaded evidence for %s", async (terminalId) => {
    const h = harness();
    h.node("primary").click(); await flush();
    view.invalidateEvidence("unrelated-terminal");
    expect(h.node("report").textContent).toBe("report contents");
    view.invalidateEvidence(terminalId);
    expect(h.node("report").textContent).toBe("");
    const pending = deferred();
    h.getVerifyReport.mockReturnValueOnce(pending.promise);
    h.node("primary").click();
    view.invalidateEvidence(terminalId);
    pending.resolve("invalidated report"); await flush();
    expect(h.node("report").textContent).not.toContain("invalidated report");
  });

  it("keeps the latest explicit request when reports resolve out of order", async () => {
    const h = harness();
    const first = deferred(); const second = deferred();
    h.getVerifyReport.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    h.node("primary").click(); h.node("primary").click();
    expect(h.getVerifyReport).toHaveBeenCalledTimes(2);
    second.resolve("latest report"); await flush();
    first.resolve("older report"); await flush();
    expect(h.node("report").textContent).toBe("latest report");
  });

  it("disables unavailable actions, keeps close usable and restores availability on render", async () => {
    const h = harness();
    const pending = deferred(); h.getVerifyReport.mockReturnValueOnce(pending.promise);
    h.node("primary").click();
    view.unavailable("Selected work is no longer available");
    expect(text(h.node("status"))).toContain("Selected work is no longer available");
    for (const control of ["primary", "terminal", "plan", "check"]) {
      expect(h.node(control).disabled).toBe(true);
      h.node(control).click();
    }
    expect(h.node("close").disabled).toBe(false);
    h.node("close").click(); expect(h.onClose).toHaveBeenCalledOnce();
    pending.resolve("obsolete report"); await flush();
    expect(h.node("report").textContent).toBe("");
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.getVerifyReport).toHaveBeenCalledTimes(1);
    view.render(h.project, h.card);
    expect(h.node("primary").disabled).toBe(false);
    h.node("primary").click(); await flush();
    expect(h.node("report").textContent).toBe("report contents");
  });

  it("clear hides the inspector and late results cannot reopen it", async () => {
    const h = harness();
    const pending = deferred(); h.getVerifyReport.mockReturnValueOnce(pending.promise);
    h.node("primary").click(); view.clear();
    expect(h.element.hidden).toBe(true);
    pending.resolve("obsolete report"); await flush();
    expect(h.element.hidden).toBe(true);
    expect(h.node("report").textContent).toBe("");
    view.render(h.project, h.card);
    expect(h.element.hidden).toBe(false);
  });

  it("disposal fences pending results and removes all action listeners", async () => {
    const h = harness();
    const pending = deferred(); h.getVerifyReport.mockReturnValueOnce(pending.promise);
    h.node("primary").click();
    view.dispose(); view.dispose();
    for (const control of ["primary", "terminal", "plan", "check", "close"]) h.node(control).click();
    view.render(h.project, h.card); view.focus(); view.invalidateEvidence();
    pending.resolve("disposed report"); await flush();
    expect(h.node("report").textContent).not.toContain("disposed report");
    expect(h.getVerifyReport).toHaveBeenCalledTimes(1);
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });
});
