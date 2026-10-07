import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkSummary } from "../../../src/main/work-summary.ts";
import { projectWorkSummary } from "../../../electron/main/work-summary.ts";
import type { ProjectWorkSummary, TerminaBridge } from "../../../shared/types.ts";
import { FakeEl, installFakeDom } from "./fake-dom.ts";

function summary(projectId = "proj-1", generation = 3): ProjectWorkSummary {
  return projectWorkSummary({ id: projectId, cwd: `/projects/${projectId}` }, [{
    id: "term-1", generation, type: "agent", model: "provider/model", activity: { state: "idle", reason: null },
    workspace: { id: "ws-1", root: "/projects/proj-1", primary: true },
    verify: { state: "untested", command: null, summary: null }, trackedChanges: 2,
    plan: [{ text: "Fix hello.txt", paths: ["hello.txt"], state: "pending", dispatchResult: { workerId: "term-2", outcome: "incomplete" } }],
  }]);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createWorkSummary>;
beforeEach(() => { dom = installFakeDom(); vi.useFakeTimers(); });
afterEach(() => { view?.dispose(); vi.useRealTimers(); dom.cleanup(); });

function harness() {
  const element = dom.document.createElement("details");
  const heading = dom.document.createElement("span");
  heading.className = "work-summary-heading";
  const content = dom.document.createElement("div");
  content.className = "work-summary-content";
  element.append(heading, content);
  const hooks = ["onInstances", "onPlanUpdate", "onModifiedList", "onVerifyState", "onTimelineClear", "onAgentStatus", "onTimelinePrefix"] as const;
  const callbacks = new Map<string, (payload: any) => void>();
  const unsubscribe = vi.fn();
  const getProjectWorkSummary = vi.fn(async (_id: string): Promise<ProjectWorkSummary | null> => summary());
  const getVerifyReport = vi.fn(async (): Promise<string | null> => "**Status:** NOT RUN");
  const bridge = { getProjectWorkSummary, getVerifyReport } as unknown as TerminaBridge;
  for (const hook of hooks) bridge[hook] = ((callback: (payload: any) => void) => { callbacks.set(hook, callback); return unsubscribe; }) as never;
  let context: { projectId: string; activationGeneration: number; terminalId: string; generation: number } | null = {
    projectId: "proj-1", activationGeneration: 1, terminalId: "term-1", generation: 3,
  };
  const onNavigate = vi.fn();
  view = createWorkSummary({ element: element as unknown as HTMLDetailsElement, bridge, getContext: () => context, onNavigate });
  const value = (label: string) => {
    const entries = content.querySelectorAll("dt");
    const index = entries.findIndex((entry) => entry.textContent === label);
    return content.querySelectorAll("dd")[index]!.textContent;
  };
  return { element, heading, content, getProjectWorkSummary, getVerifyReport, onNavigate, unsubscribe,
    value, emit: (hook: string, payload: unknown = { terminalId: "term-1", instanceId: "term-1" }) => callbacks.get(hook)!(payload),
    setContext: (next: typeof context) => { context = next; view.syncContext(); } };
}

describe("optional factual work context", () => {
  it("renders attributed facts and an incomplete attempt without turning idle into success", async () => {
    const h = harness(); view.syncContext(); await flush();
    expect(h.value("Project")).toBe("proj-1 · /projects/proj-1");
    expect(h.value("Agent")).toBe("term-1 · provider/model");
    expect(h.value("Execution")).toBe("idle");
    expect(h.value("Work area")).toContain("Shared project files");
    expect(h.value("Attention")).toBe("Task attempt incomplete");
    expect(h.content.querySelector("li")!.children[0]!.textContent).toContain("last incomplete (term-2)");
    expect(h.getVerifyReport).not.toHaveBeenCalled();
    expect((h.element as FakeEl & { open?: boolean }).open).toBeUndefined();
  });

  it("viewing or refreshing the same terminal does not clear factual failed-attempt attention", async () => {
    const h = harness(); view.syncContext(); await flush();
    view.syncContext(); h.emit("onInstances"); await vi.advanceTimersByTimeAsync(150);
    expect(h.value("Attention")).toBe("Task attempt incomplete");
    h.content.querySelector(".work-summary-action")!.click();
    expect(h.onNavigate).toHaveBeenCalledWith({ kind: "plan", terminalId: "term-1", generation: 3 }, "proj-1");
  });

  it.each(["project", "terminal generation", "activation generation"])("fences delayed responses after a changed %s", async (change) => {
    const h = harness(); const old = deferred<ProjectWorkSummary | null>();
    h.getProjectWorkSummary.mockReturnValueOnce(old.promise);
    view.syncContext();
    const projectId = change === "project" ? "proj-2" : "proj-1";
    const generation = change === "terminal generation" ? 4 : 3;
    h.getProjectWorkSummary.mockResolvedValueOnce(summary(projectId, generation));
    h.setContext({ projectId, terminalId: "term-1", generation, activationGeneration: 2 });
    await flush();
    old.resolve(summary("old-project")); await flush();
    expect(h.value("Project")).toBe(`${projectId} · /projects/${projectId}`);
    expect(h.heading.textContent).not.toContain("unavailable");
  });

  it("coalesces state updates, ignores unchanged activity, and preserves focused controls", async () => {
    const h = harness(); view.syncContext(); await flush();
    const button = h.content.querySelector("li")!.children[1]!;
    button.focus();
    for (let i = 0; i < 20; i++) h.emit("onTimelinePrefix", { terminalId: "term-1", activity: { state: "idle", reason: null } });
    expect(h.getProjectWorkSummary).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) h.emit("onPlanUpdate");
    await vi.advanceTimersByTimeAsync(150);
    expect(h.getProjectWorkSummary).toHaveBeenCalledTimes(2);
    expect(h.content.querySelector("li")!.children[1]).toBe(button);
    expect(dom.document.activeElement).toBe(button);
  });

  it("keeps canonical task order when a row is replaced without moving the unchanged focused row", async () => {
    const h = harness();
    const value = summary();
    const tasks = value.terminals[0]!.tasks;
    tasks.push({ ...tasks[0]!, task: { ...tasks[0]!.task, text: "Second task" } });
    h.getProjectWorkSummary.mockResolvedValue(value);
    view.syncContext(); await flush();
    const list = h.content.querySelector(".work-summary-tasks")!;
    const unchanged = list.children[1]!;
    const button = unchanged.querySelector("button")!;
    button.focus();
    tasks[0] = { ...tasks[0]!, task: { ...tasks[0]!.task, text: "Replacement task" } };
    h.emit("onPlanUpdate"); await vi.advanceTimersByTimeAsync(150);
    expect(list.children.map((row) => row.children[0]!.textContent.split(" · marked")[0])).toEqual(["Replacement task", "Second task"]);
    expect(list.children[1]).toBe(unchanged);
    expect(dom.document.activeElement).toBe(button);
  });

  it("does not query the visible project for other projects' frequent owner updates", async () => {
    const h = harness(); view.syncContext(); await flush();
    for (let i = 0; i < 20; i++) {
      for (const hook of ["onAgentStatus", "onTimelinePrefix", "onPlanUpdate", "onModifiedList", "onVerifyState", "onTimelineClear"]) {
        h.emit(hook, { terminalId: "other-project-terminal", instanceId: "other-project-terminal", model: "other-model", activity: { state: "working", reason: null } });
      }
    }
    await vi.advanceTimersByTimeAsync(150);
    expect(h.getProjectWorkSummary).toHaveBeenCalledTimes(1);
  });

  it("invalidates an in-flight projection when a newer owner event arrives", async () => {
    const h = harness(); const old = deferred<ProjectWorkSummary | null>();
    h.getProjectWorkSummary.mockReturnValueOnce(old.promise);
    view.syncContext(); h.emit("onPlanUpdate");
    old.resolve(summary()); await flush();
    expect(h.heading.textContent).toBe("Loading work context…");
    await vi.advanceTimersByTimeAsync(150);
    expect(h.value("Attention")).toBe("Task attempt incomplete");
  });

  it("loads exact-generation check details only on request, retaining inspected output during unrelated updates", async () => {
    const h = harness(); view.syncContext(); await flush();
    const buttons = h.content.querySelectorAll(".work-summary-action");
    buttons[1]!.click(); await flush();
    expect(h.getVerifyReport).toHaveBeenCalledExactlyOnceWith("term-1", 3);
    const report = h.content.querySelector("pre")!;
    expect(report.hidden).toBe(false);
    expect(report.textContent).toBe("**Status:** NOT RUN");
    h.emit("onPlanUpdate"); await vi.advanceTimersByTimeAsync(150);
    expect(report.hidden).toBe(false);
    h.emit("onVerifyState", { terminalId: "term-1" });
    expect(report.hidden).toBe(true);
  });

  it("never presents historical green as current evidence", async () => {
    const h = harness(); const data = summary();
    data.terminals[0]!.verify = { state: "stale", command: "npm run test", summary: "outdated", staleReason: "Source changed",
      result: { state: "pass", exitCode: 0, startedAt: 1, finishedAt: 2 } };
    h.getProjectWorkSummary.mockResolvedValue(data);
    view.syncContext(); await flush();
    expect(h.value("Evidence")).toBe("Outdated · npm run test · historical pass (exit 0) · Source changed");
  });

  it("discards a delayed report when its terminal generation is replaced", async () => {
    const h = harness(); const old = deferred<string | null>();
    h.getVerifyReport.mockReturnValueOnce(old.promise);
    view.syncContext(); await flush(); h.content.querySelectorAll(".work-summary-action")[1]!.click();
    h.getProjectWorkSummary.mockResolvedValue(summary("proj-1", 4));
    h.setContext({ projectId: "proj-1", activationGeneration: 1, terminalId: "term-1", generation: 4 });
    await flush(); old.resolve("OLD GREEN"); await flush();
    const report = h.content.querySelector("pre")!;
    expect(report.hidden).toBe(true);
    expect(report.textContent).not.toBe("OLD GREEN");
  });

  it("shows unavailable state rather than an empty success after rejection", async () => {
    const h = harness(); h.getProjectWorkSummary.mockRejectedValue(new Error("IPC failed"));
    view.syncContext(); await flush();
    expect(h.heading.textContent).toContain("unavailable");
    expect(h.content.hidden).toBe(true);
    h.setContext(null); expect(h.element.hidden).toBe(true);
  });

  it("disposes subscriptions and fences pending responses", async () => {
    const h = harness(); const response = deferred<ProjectWorkSummary | null>();
    h.getProjectWorkSummary.mockReturnValueOnce(response.promise); view.syncContext();
    view.dispose(); response.resolve(summary()); await flush();
    expect(h.unsubscribe).toHaveBeenCalledTimes(7);
    expect(h.heading.textContent).toBe("Loading work context…");
  });
});
