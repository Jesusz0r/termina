import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivityPane } from "../../../src/main/activity-pane.ts";
import type { PlanTask, TerminaBridge } from "../../../shared/types.ts";
import { installFakeDom } from "./fake-dom.ts";

vi.mock("../../../src/components/modals.ts", () => ({ toast: vi.fn(), showConfirm: vi.fn() }));
let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createActivityPane>;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { view?.dispose(); dom.cleanup(); vi.unstubAllGlobals(); });

function harness(loaded = true) {
  const task: PlanTask = { text: "Repair the parser", paths: ["parser.ts"], state: "pending",
    dispatchResult: { workerId: "old-worker", outcome: "interrupted" } };
  const pane = { instanceId: "term-owner", projectId: "project-1", workspaceId: "workspace-1", reverted: new Set<string>(), plan: loaded ? [task] : [], planLoaded: loaded,
    planLoadAttempts: 0, planVersion: 1, modified: [], accepted: new Map<string, number>(), tabs: { setBadge: vi.fn() } };
  let active = pane;
  const nodes = Object.fromEntries(["planPanel", "planCount", "planList", "btnDispatch", "modifiedPanel", "modifiedCount", "modifiedList", "btnClearModified", "btnAcceptAll"]
    .map((name) => { const node = dom.document.createElement("div"); dom.document.body.append(node); return [name, node]; }));
  const dispatchRun = vi.fn<TerminaBridge["dispatchRun"]>().mockResolvedValue({ ok: true });
  const getPlan = vi.fn<TerminaBridge["getPlan"]>().mockResolvedValue([task]);
  const onShowWorker = vi.fn();
  const unsub = vi.fn();
  vi.stubGlobal("window", { termina: { dispatchRun, getPlan, onPlanUpdate: () => unsub, onModifiedList: () => unsub } });
  view = createActivityPane({
    elements: nodes as unknown as Parameters<typeof createActivityPane>[0]["elements"],
    getActivePane: () => active, getActivePaneId: () => active.instanceId,
    getPaneById: (id) => id === pane.instanceId ? pane : undefined, getAllPanes: () => [pane],
    onShowWorker, getRecentModels: () => [], getLiveModels: () => [],
    onPlanContent: vi.fn(), onModifiedContent: vi.fn(), onModifiedListChanged: vi.fn(), onReviewChanged: vi.fn(), openReview: vi.fn(),
  });
  return { pane, task, nodes, dispatchRun, getPlan, onShowWorker,
    changeActive: () => { active = { ...pane, instanceId: "term-other" }; },
    action: () => nodes.planList!.querySelector(".plan-task-action")! };
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
describe("existing Plan Board contextual retry", () => {
  it("reveals and focuses the exact accessible retry button without dispatching", () => {
    const h = harness();
    view.focusTask(h.pane, h.task.text);
    expect(h.action().textContent).toBe("Retry task");
    expect(h.action().getAttribute("aria-label")).toBe(`Retry task: ${h.task.text}`);
    expect(dom.document.activeElement).toBe(h.action());
    expect(h.action().lastScrollIntoView).toEqual({ block: "nearest" });
    expect(h.dispatchRun).not.toHaveBeenCalled();
    h.action().click();
    expect(h.dispatchRun).toHaveBeenCalledExactlyOnceWith("term-owner", "Repair the parser", "inherit");
  });

  it("waits for the canonical plan load, then focuses without executing", async () => {
    const h = harness(false);
    view.focusTask(h.pane, h.task.text);
    expect(h.getPlan).toHaveBeenCalledExactlyOnceWith("term-owner");
    await flush();
    expect(dom.document.activeElement).toBe(h.action());
    expect(h.dispatchRun).not.toHaveBeenCalled();
  });

  it("never uses an obsolete row to dispatch in another selected context", () => {
    const h = harness();
    view.renderPlan(h.pane);
    const oldAction = h.action();
    h.changeActive();
    oldAction.click();
    expect(h.dispatchRun).not.toHaveBeenCalled();
    expect(h.onShowWorker).not.toHaveBeenCalled();
  });

  it("opens a live retry worker instead of dispatching the historical failure again", () => {
    const h = harness();
    h.task.workerId = "term-retry";
    h.task.state = "active";
    view.focusTask(h.pane, h.task.text);
    expect(h.action().textContent).toBe("Show worker");
    h.action().click();
    expect(h.onShowWorker).toHaveBeenCalledExactlyOnceWith("term-retry");
    expect(h.dispatchRun).not.toHaveBeenCalled();
  });

  it("preserves the exact focused task action across a live plan refresh without executing it", () => {
    const h = harness();
    view.focusTask(h.pane, h.task.text);
    h.pane.plan = [{ ...h.task, state: "active", workerId: "term-retry" }];
    view.renderPlan(h.pane);
    expect(dom.document.activeElement).toBe(h.action());
    expect(h.action().textContent).toBe("Show worker");
    expect(h.dispatchRun).not.toHaveBeenCalled();
    expect(h.onShowWorker).not.toHaveBeenCalled();
    h.action().click();
    expect(h.onShowWorker).toHaveBeenCalledExactlyOnceWith("term-retry");
  });

  it("preserves a focused model selector when the same owner's plan refreshes", () => {
    const h = harness(); view.renderPlan(h.pane);
    h.nodes.planList!.querySelector(".plan-model")!.focus();
    view.renderPlan(h.pane);
    expect(dom.document.activeElement).toBe(h.nodes.planList!.querySelector(".plan-model"));
    expect(h.dispatchRun).not.toHaveBeenCalled();
  });

  it("does not steal focus back after the user leaves a selected task", () => {
    const h = harness(); view.focusTask(h.pane, h.task.text);
    const outside = dom.document.createElement("button"); dom.document.body.append(outside); outside.focus();
    view.renderPlan(h.pane);
    expect(dom.document.activeElement).toBe(outside);
    expect(h.dispatchRun).not.toHaveBeenCalled();
  });

  it("does not resurrect a pending focus after switching context during plan load", async () => {
    const h = harness(false);
    view.focusTask(h.pane, h.task.text);
    h.changeActive(); view.clear();
    await flush();
    expect(h.nodes.planList!.children).toHaveLength(0);
    expect(h.dispatchRun).not.toHaveBeenCalled();
  });
});
