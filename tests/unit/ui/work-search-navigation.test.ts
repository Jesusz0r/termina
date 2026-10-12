import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttentionView } from "../../../src/main/attention-view.ts";
import { searchWork, type WorkSearchTarget } from "../../../src/main/work-search.ts";
import { projectWorkSummary, workOverview } from "../../../electron/main/work-summary.ts";
import type { TerminaBridge, WorkOverview } from "../../../shared/types.ts";
import { installFakeDom } from "./fake-dom.ts";

function overview(): WorkOverview {
  return workOverview(["first", "other"].map((name, index) => projectWorkSummary({ id: `p${index}`, cwd: `/${name}/same-name` }, [{
    id: `owner-${index}`, generation: 3, type: "agent", model: "provider/model", activity: { state: "idle", reason: null, intervention: null },
    workspace: { id: `ws-${index}`, root: `/${name}/same-name`, primary: true },
    verify: { state: "untested", command: null, summary: null }, dispatchAssignment: null, trackedChanges: 0,
    plan: [{ text: "Repair the parser", paths: ["parser.ts"], state: "pending" }],
  }])));
}
function target(value: WorkOverview): WorkSearchTarget {
  return searchWork(value, "/other Repair").rows[0]!.target;
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createAttentionView>;
beforeEach(() => { dom = installFakeDom(); vi.useFakeTimers(); });
afterEach(() => { view?.dispose(); vi.useRealTimers(); dom.cleanup(); });
function harness(value = overview()) {
  const element = dom.document.createElement("section");
  for (const id of ["attention-list", "attention-status",
    "attention-message", "btn-more-attention"]) {
    const node = dom.document.createElement(id.startsWith("btn-") ? "button" : "div"); node.id = id; element.append(node);
  }
  const heading = dom.document.createElement("h2");
  const count = dom.document.createElement("span"); count.className = "attention-count"; heading.append(count);
  element.append(heading);
  const workspace = dom.document.createElement("div");
  dom.document.body.append(element, workspace);
  const callbacks = new Map<string, () => void>();
  const getWorkOverview = vi.fn(async (): Promise<WorkOverview> => value);
  const getVerifyReport = vi.fn().mockResolvedValue(null);
  const bridge = { getWorkOverview, getVerifyReport } as unknown as TerminaBridge;
  for (const hook of ["onInstances", "onPlanUpdate", "onModifiedList", "onFileChanged", "onFileDeleted", "onVerifyState",
    "onTimelineClear", "onFolderOpened", "onProjectClosed", "onAgentStatus", "onTimelinePrefix"] as const) {
    bridge[hook] = ((callback: () => void) => { callbacks.set(hook, callback); return () => {}; }) as never;
  }
  const onNavigate = vi.fn().mockResolvedValue(true);
  const onReveal = vi.fn(); const onOverview = vi.fn();
  const onTerminalControl = vi.fn().mockResolvedValue({ ok: true });
  view = createAttentionView({ element: element as unknown as HTMLElement, heading: heading as unknown as HTMLElement,
    bridge, onOverview, onInspect: vi.fn().mockResolvedValue(false), onNavigate, onReveal });
  return { element, workspace, getWorkOverview, onNavigate, onReveal, onOverview, onTerminalControl,
    getVerifyReport, emit: (hook: string) => (callbacks.get(hook)! as (payload: unknown) => void)({ instanceId: "owner-1", projectId: "p1" }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("canonical terminal navigation readiness", () => {
  function navigationHarness() {
    const source = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
    const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
    const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "navigateWorkAction");
    if (!declaration) throw new Error("Missing canonical navigation owner");
    const code = ts.transpileModule(declaration.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const pane = { instanceId: "worker", projectId: "p", generation: 4 };
    const panes = new Map([[pane.instanceId, pane]]);
    const pending = deferred<boolean>();
    const activatePane = vi.fn().mockReturnValue(pending.promise);
    const focusWorkContext = vi.fn();
    const layout = { revealTerminal: vi.fn(), setModifiedVisible: vi.fn() };
    const navigate = new Function("panes", "activatePane", "focusWorkContext", "layout",
      `let activeProjectId = "p"; let activeId = "worker"; ${code}; return navigateWorkAction;`)(panes, activatePane, focusWorkContext, layout) as
      (action: { kind: "terminal"; terminalId: string; generation: number }, projectId: string) => Promise<boolean>;
    return { navigate, pane, panes, pending, activatePane, focusWorkContext };
  }
  it("waits for canonical candidate selection even when the renderer tab is already active", async () => {
    const h = navigationHarness();
    const result = h.navigate({ kind: "terminal", terminalId: "worker", generation: 4 }, "p");
    await flush();
    expect(h.activatePane).toHaveBeenCalledExactlyOnceWith("worker");
    expect(h.focusWorkContext).not.toHaveBeenCalled();
    h.pending.resolve(true);
    expect(await result).toBe(true);
    expect(h.focusWorkContext).toHaveBeenCalledOnce();
  });
  it.each(["refused", "generation", "replaced"])("does not reveal a %s target after canonical selection settles", async (change) => {
    const h = navigationHarness();
    const result = h.navigate({ kind: "terminal", terminalId: "worker", generation: 4 }, "p");
    if (change === "generation") h.pane.generation++;
    if (change === "replaced") h.panes.set("worker", { ...h.pane });
    h.pending.resolve(change !== "refused");
    expect(await result).toBe(false);
    expect(h.focusWorkContext).not.toHaveBeenCalled();
  });
});

describe("Jump to work navigation", () => {
  it("opens the exact task owner’s native Plan Board without an inspector, worker execution or evidence fetch", async () => {
    const value = overview(); const before = JSON.stringify(value); const h = harness(value); await flush();
    expect(await view.revealWork(target(value), () => true)).toBe(true);
    expect(h.element.hidden).toBe(false); expect(h.workspace.inert).toBe(false);
    expect(h.element.querySelector("#project-work-inspector")).toBeNull();
    const action = { kind: "plan", terminalId: "owner-1", generation: 3, taskText: "Repair the parser" };
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("p1", action, expect.any(Function));
    expect(h.onReveal).toHaveBeenCalledExactlyOnceWith("p1", action);
    for (const action of [h.onTerminalControl, h.getVerifyReport]) {
      expect(action).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each(["generation", "source", "cancel"])("revalidates the task after activation when its %s changes", async (change) => {
    const value = overview(); const h = harness(value); await flush();
    const activating = deferred<boolean>(); h.onNavigate.mockReturnValueOnce(activating.promise);
    let current = true;
    const opening = view.revealWork(target(value), () => current); await flush();
    expect(h.onNavigate).toHaveBeenCalledOnce();
    const next = structuredClone(value);
    if (change === "generation") next.projects[1]!.terminals[0]!.generation++;
    else if (change === "source") next.projects[1]!.terminals[0]!.workArea!.root = "/replaced/source";
    else current = false;
    h.getWorkOverview.mockResolvedValueOnce(next);
    activating.resolve(true);
    expect(await opening).toBe(false);
    expect(h.element.hidden).toBe(false); expect(h.workspace.inert).toBe(false);
    expect(h.onReveal).not.toHaveBeenCalled();
  });

  it("rechecks project ID and root before delegating only canonical project navigation", async () => {
    const value = overview(); const h = harness(value); await flush();
    const project: WorkSearchTarget = { kind: "project", projectId: "p1", root: "/other/same-name" };
    expect(await view.revealWork({ ...project, root: "/different" }, () => true)).toBe(false);
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(await view.revealWork(project, () => true)).toBe(true);
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("p1", null, expect.any(Function));
    expect(h.onReveal).toHaveBeenCalledExactlyOnceWith("p1", null);
    expect(h.element.hidden).toBe(false);
    expect(h.onTerminalControl).not.toHaveBeenCalled();
  });

  it.each(["removed", "generation", "source", "renamed"])("refuses a task whose %s context no longer matches", async (change) => {
    const value = overview(); const destination = target(value); const h = harness(value); await flush();
    const fresh = structuredClone(value);
    if (change === "removed") fresh.projects.pop();
    else if (change === "generation") fresh.projects[1]!.terminals[0]!.generation++;
    else if (change === "source") fresh.projects[1]!.terminals[0]!.workArea!.root = "/different/source";
    else fresh.projects[1]!.terminals[0]!.tasks[0]!.task.text = "Renamed task";
    h.getWorkOverview.mockResolvedValueOnce(fresh);
    expect(await view.revealWork(destination, () => true)).toBe(false);
    expect(h.element.hidden).toBe(false); expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it.each(["closed project event", "plan update", "external cancel", "cancel navigation", "dispose"])("rejects a held genuine read after %s", async (change) => {
    const value = overview(); const h = harness(value); await flush();
    const pending = deferred<WorkOverview>(); h.getWorkOverview.mockReturnValueOnce(pending.promise);
    let current = true;
    const opening = view.revealWork(target(value), () => current);
    if (change === "closed project event") h.emit("onProjectClosed");
    else if (change === "plan update") h.emit("onPlanUpdate");
    else if (change === "external cancel") current = false;
    else if (change === "cancel navigation") view.cancelNavigation();
    else view.dispose();
    pending.resolve(value);
    expect(await opening).toBe(false);
    expect(h.element.hidden).toBe(false); expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.workspace.inert).toBe(false);
  });
});
