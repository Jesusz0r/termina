import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttentionView } from "../../../src/main/attention-view.ts";
import { projectWorkSummary, workOverview, type WorkSummaryTerminalFacts } from "../../../electron/main/work-summary.ts";
import type { TerminaBridge, WorkOverview } from "../../../shared/types.ts";
import { installFakeDom, type FakeEl } from "./fake-dom.ts";

let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createAttentionView>;
beforeEach(() => { dom = installFakeDom(); vi.useFakeTimers(); });
afterEach(() => { view?.dispose(); vi.useRealTimers(); dom.cleanup(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const text = (node: FakeEl): string => [node.textContent, ...node.children.map(text)].join("\n");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function facts(overrides: Partial<WorkSummaryTerminalFacts> = {}): WorkSummaryTerminalFacts {
  return {
    id: "owner", generation: 4, type: "agent", model: "provider/model",
    activity: { state: "idle", reason: null }, workspace: { id: "ws-1", root: "/projects/first", primary: true },
    verify: { state: "untested", command: null, summary: null }, trackedChanges: 0,
    planCreationError: null, planStartOwnerError: null, dispatchAssignment: null,
    plan: [{ text: "Recover the parser", paths: ["parser.ts"], state: "pending",
      dispatchResult: { workerId: "previous", outcome: "incomplete" } }], ...overrides,
  };
}
function overview(terminals = [facts()]): WorkOverview {
  return workOverview([projectWorkSummary({ id: "project", cwd: "/projects/first" }, terminals)]);
}
function harness(value = overview()) {
  const element = dom.document.createElement("section"); element.hidden = true;
  for (const id of ["work-view-title", "project-overview", "overview-attention-heading", "attention-list", "attention-status", "attention-message", "btn-close-attention", "btn-refresh-attention", "btn-more-attention"]) {
    const node = dom.document.createElement(id.startsWith("btn-") ? "button" : "div"); node.id = id; element.append(node);
  }
  const toggle = dom.document.createElement("button");
  const count = dom.document.createElement("span"); count.className = "attention-count"; toggle.append(count);
  const overviewToggle = dom.document.createElement("button");
  const workspace = dom.document.createElement("div");
  dom.document.body.append(element, toggle, overviewToggle, workspace);
  const getWorkOverview = vi.fn<() => Promise<WorkOverview>>().mockResolvedValue(value);
  const inspectWorkAttention = vi.fn<TerminaBridge["inspectWorkAttention"]>();
  const getVerifyReport = vi.fn<TerminaBridge["getVerifyReport"]>().mockResolvedValue("FAILED (exit code 7)");
  const getReviewFiles = vi.fn<TerminaBridge["getReviewFiles"]>().mockResolvedValue({ ok: true, files: [], total: 0 });
  const createPlanTask = vi.fn<TerminaBridge["createPlanTask"]>();
  const startPlanTask = vi.fn<TerminaBridge["startPlanTask"]>();
  const bridge = { getWorkOverview, inspectWorkAttention, getVerifyReport, getReviewFiles, createPlanTask, startPlanTask } as unknown as TerminaBridge;
  const unsub = () => () => {};
  for (const hook of ["onInstances", "onPlanUpdate", "onModifiedList", "onFileChanged", "onFileDeleted", "onVerifyState", "onTimelineClear", "onFolderOpened", "onProjectClosed", "onAgentStatus", "onTimelinePrefix"] as const) bridge[hook] = unsub;
  const onNavigate = vi.fn().mockResolvedValue(true);
  const onInspect = vi.fn().mockResolvedValue(true);
  const onReveal = vi.fn();
  view = createAttentionView({ element: element as unknown as HTMLElement, toggle: toggle as unknown as HTMLButtonElement,
    overviewToggle: overviewToggle as unknown as HTMLButtonElement, workspace: [workspace as unknown as HTMLElement], bridge,
    onOverview: vi.fn(), onViewChange: vi.fn(), onInspect, onNavigate, onReveal, onNewProject: vi.fn(),
    onFocusTerminal: vi.fn().mockResolvedValue(null), onTerminalControl: vi.fn(),
    onCandidateNavigate: vi.fn().mockResolvedValue(false), onRevealCandidate: vi.fn() });
  const attention = () => element.querySelectorAll(".attention-inspect");
  const inspector = () => element.querySelector("#project-work-inspector")!;
  return { element, workspace, getWorkOverview, inspectWorkAttention, getVerifyReport, getReviewFiles, createPlanTask, startPlanTask,
    onNavigate, onInspect, onReveal, attention, inspector,
    open: async () => { view.open(undefined, "overview"); await vi.advanceTimersByTimeAsync(150); await flush(); } };
}

describe("attention inspection inside Overview", () => {
  it("projects persistent attention selection and expanded state without acknowledging or navigating", async () => {
    const value = overview([facts({ plan: [
      { text: "Recover first", paths: [], state: "pending", dispatchResult: { workerId: "old-1", outcome: "failed" } },
      { text: "Recover second", paths: [], state: "pending", dispatchResult: { workerId: "old-2", outcome: "incomplete" } },
    ] })]);
    const before = JSON.stringify(value); const h = harness(value); await h.open();
    const [first, second] = h.attention();
    expect(first!.getAttribute("aria-pressed")).toBe("false"); expect(second!.getAttribute("aria-expanded")).toBe("false");
    first!.click(); await flush();
    expect(first!.getAttribute("aria-pressed")).toBe("true"); expect(first!.getAttribute("aria-expanded")).toBe("true");
    expect(first!.closest(".attention-item")!.classList.contains("is-selected")).toBe(true);
    second!.click(); await flush();
    expect(first!.getAttribute("aria-pressed")).toBe("false"); expect(second!.getAttribute("aria-pressed")).toBe("true");
    expect(first!.closest(".attention-item")!.classList.contains("is-selected")).toBe(false);
    h.element.querySelector("#btn-refresh-attention")!.click(); await vi.advanceTimersByTimeAsync(150); await flush();
    expect(h.attention()[1]).toBe(second); expect(second!.getAttribute("aria-expanded")).toBe("true");
    h.inspector().dispatch("keydown", { key: "Escape" });
    expect(second!.getAttribute("aria-pressed")).toBe("false"); expect(second!.getAttribute("aria-expanded")).toBe("false");
    expect(second!.closest(".attention-item")!.classList.contains("is-selected")).toBe(false);
    expect(dom.document.activeElement).toBe(second); expect(h.element.hidden).toBe(false);
    expect(h.attention()).toHaveLength(2); expect(JSON.stringify(value)).toBe(before);
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.createPlanTask).not.toHaveBeenCalled(); expect(h.startPlanTask).not.toHaveBeenCalled();
    view.open(undefined, "attention"); await flush();
    expect(first!.getAttribute("aria-pressed")).toBeNull(); expect(first!.getAttribute("aria-expanded")).toBeNull();
  });

  it("selects the exact task without activation or losing a local filter, then navigates only explicitly", async () => {
    const value = overview(); const before = JSON.stringify(value); const h = harness(value); await h.open();
    const filter = h.element.querySelector(".overview-toolbar")!.querySelector("input")!;
    filter.value = "nothing matches"; filter.dispatch("input");
    const opener = h.attention()[0]!; opener.click(); await flush();
    expect(h.inspector().hidden).toBe(false);
    expect(h.inspector().querySelector(".overview-inspector-title")!.textContent).toBe("Recover the parser");
    expect(text(h.inspector())).toContain("Previous attempt incomplete");
    expect(filter.value).toBe("nothing matches");
    expect(h.element.hidden).toBe(false); expect(h.workspace.inert).toBe(true);
    expect(h.inspectWorkAttention).not.toHaveBeenCalled(); expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.onInspect).not.toHaveBeenCalled(); expect(h.getVerifyReport).not.toHaveBeenCalled();
    expect(h.getReviewFiles).not.toHaveBeenCalled(); expect(h.startPlanTask).not.toHaveBeenCalled();
    expect(h.createPlanTask).not.toHaveBeenCalled(); expect(JSON.stringify(value)).toBe(before);
    h.inspector().querySelector(".overview-inspector-title")!.dispatch("keydown", { key: "Escape" });
    expect(h.inspector().hidden).toBe(true); expect(h.element.hidden).toBe(false);
    expect(dom.document.activeElement).toBe(opener);
    opener.click(); await flush(); h.inspector().querySelector(".overview-inspector-primary")!.click(); await flush();
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("project", { kind: "plan", terminalId: "owner", generation: 4 }, expect.any(Function));
    expect(h.element.hidden).toBe(true); expect(h.workspace.inert).toBe(false);
    expect(h.onReveal).toHaveBeenCalledExactlyOnceWith("project", { kind: "plan", terminalId: "owner", generation: 4 });
  });

  it("inspects a retained captured result without borrowing source checks or resolving review attention", async () => {
    const area = { id: "cmp-1-A", comparisonId: "cmp-1", label: "A" as const, role: "session" as const,
      root: "/worlds/retained-result", version: 4, state: "settled" as const, error: null, headStateId: "captured-result",
      comparisonBaseStateId: "base", promotionBaseStateId: "base", sourceRunId: null, terminalId: null,
      sessionFile: null, model: "provider/model", thinkingLevel: null, createdAt: 1 };
    const value = workOverview([projectWorkSummary({ id: "project", cwd: "/projects/first" }, [facts({ plan: [
      { text: "Completed independent result", paths: ["parser.ts"], state: "done", candidate: { comparisonId: "cmp-1", label: "A" },
        dispatchResult: { workerId: "previous", outcome: "completed" } },
    ], verify: { state: "pass", command: "source check", summary: "source passed" } })], [], [area])]);
    const before = JSON.stringify(value);
    const h = harness(value); await h.open();
    expect(text(h.element.querySelector("#attention-list")!)).toContain("Result pending review");
    expect(text(h.element.querySelector("#attention-list")!)).toContain(area.root);
    h.attention()[0]!.click(); await flush();
    expect(h.inspector().querySelector(".overview-inspector-title")!.textContent).toBe("Completed independent result");
    expect(text(h.inspector())).toContain(area.root);
    expect(text(h.inspector())).toContain("Result pending review");
    expect(text(h.inspector())).not.toContain("source passed");
    expect(h.getVerifyReport).not.toHaveBeenCalled(); expect(h.getReviewFiles).not.toHaveBeenCalled();
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.inspectWorkAttention).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).toBe(before);
    h.inspector().querySelector(".overview-inspector-title")!.dispatch("keydown", { key: "Escape" });
    expect(h.attention()).toHaveLength(1); expect(dom.document.activeElement).toBe(h.attention()[0]);
  });

  it("inspects a terminal-wide failed check without attributing it to the first task", async () => {
    const value = overview([facts({ plan: [
      { text: "First unrelated task", paths: [], state: "pending" },
      { text: "Second unrelated task", paths: [], state: "pending" },
    ], verify: { state: "fail", command: "pnpm test", summary: "Actual failure" } })]);
    expect(value.items[0]!.taskText).toBeNull();
    const h = harness(value); await h.open(); h.attention()[0]!.click(); await flush();
    expect(h.inspector().hidden).toBe(false);
    expect(h.inspector().querySelector(".overview-inspector-title")!.textContent).toBe("Agent · owner");
    expect(text(h.inspector())).not.toContain("First unrelated task");
    expect(text(h.inspector())).toContain("No single task selected");
    expect(h.inspector().querySelector(".overview-inspector-primary")!.textContent).toBe("Check details");
    h.inspector().querySelector(".overview-inspector-primary")!.click(); await flush();
    expect(h.getVerifyReport).toHaveBeenCalledExactlyOnceWith("owner", 4);
    expect(h.element.hidden).toBe(false); expect(h.onNavigate).not.toHaveBeenCalled();
    const closed = overview([]); h.getWorkOverview.mockResolvedValue(closed);
    h.element.querySelector("#btn-refresh-attention")!.click(); await vi.advanceTimersByTimeAsync(150);
    expect(h.inspector().querySelector(".overview-inspector-primary")!.disabled).toBe(true);
    expect(h.inspector().querySelector(".overview-inspector-report")!.hidden).toBe(true);
  });

  it("selects the source-fenced worker's task, not a duplicate owner context", async () => {
    const value = overview([
      facts({ plan: [{ text: "Candidate task", paths: [], state: "active", workerId: "worker" }] }),
      facts({ id: "worker", generation: 7, plan: [], dispatchAssignment: { ownerId: "owner", taskText: "Candidate task" },
        activity: { state: "blocked", reason: "stalled" } }),
    ]);
    const h = harness(value); await h.open(); h.attention()[0]!.click(); await flush();
    expect(h.inspector().querySelector(".overview-inspector-title")!.textContent).toBe("Candidate task");
    expect(text(h.inspector())).toContain("worker · provider/model");
    expect(h.onNavigate).not.toHaveBeenCalled();
    h.inspector().querySelector(".overview-inspector-primary")!.click(); await flush();
    expect(h.onNavigate).toHaveBeenCalledWith("project", { kind: "terminal", terminalId: "worker", generation: 7 }, expect.any(Function));
  });

  it.each(["removed", "recycled", "root replaced", "ambiguous"])("refuses %s attention instead of selecting another task or workspace", async (reason) => {
    const value = overview(); const h = harness(value); await h.open();
    const next = reason === "removed" ? overview([]) : reason === "recycled" ? overview([facts({ generation: 5 })])
      : reason === "root replaced" ? overview([facts({ workspace: { id: "ws-2", root: "/replacement", primary: true } })])
        : overview([facts({ plan: [...facts().plan, ...facts().plan] })]);
    h.getWorkOverview.mockResolvedValue(next); h.attention()[0]!.click(); await flush();
    expect(h.inspector().hidden).toBe(true); expect(h.element.hidden).toBe(false);
    expect(h.element.querySelector("#attention-message")!.textContent).toMatch(/changed|closed|unavailable/i);
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.inspectWorkAttention).not.toHaveBeenCalled();
  });

  it("reports unavailable facts, retains rows and disables the previous inspector instead of navigating", async () => {
    const h = harness(); await h.open(); h.element.querySelector(".overview-inspect")!.click();
    h.getWorkOverview.mockRejectedValueOnce(new Error("Overview read failed"));
    h.attention()[0]!.click(); await flush();
    expect(h.element.hidden).toBe(false); expect(h.attention()).toHaveLength(1);
    expect(h.element.querySelector("#attention-message")!.textContent).toContain("unavailable");
    expect(h.element.querySelector("#attention-status")!.textContent).toContain("Previous rows may be outdated");
    expect(dom.document.body.querySelector(".attention-count")!.textContent).toBe("?");
    expect(h.inspector().querySelector(".overview-inspector-primary")!.disabled).toBe(true);
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.inspectWorkAttention).not.toHaveBeenCalled();
    h.attention()[0]!.click(); await flush();
    expect(h.inspector().querySelector(".overview-inspector-primary")!.disabled).toBe(false);
    expect(dom.document.body.querySelector(".attention-count")!.textContent).toBe("1");
  });

  it("does not replace fresh facts with a late failed inspection read", async () => {
    const h = harness(); await h.open(); const pending = deferred<WorkOverview>();
    h.getWorkOverview.mockImplementationOnce(async () => { await pending.promise; throw new Error("Outdated read failed"); });
    h.attention()[0]!.click();
    h.element.querySelector("#btn-refresh-attention")!.click(); await vi.advanceTimersByTimeAsync(150);
    pending.resolve(overview()); await flush();
    expect(dom.document.body.querySelector(".attention-count")!.textContent).toBe("1");
    expect(h.element.querySelector("#attention-status")!.textContent).not.toContain("unavailable");
    expect(h.element.querySelector("#attention-message")!.textContent).not.toContain("unavailable");
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it.each(["close", "another selection", "refresh"])("discards a late attention selection after %s", async (reason) => {
    const h = harness(); await h.open(); const pending = deferred<WorkOverview>();
    h.getWorkOverview.mockReturnValueOnce(pending.promise); h.attention()[0]!.click();
    if (reason === "close") view.close();
    else if (reason === "another selection") h.element.querySelector(".overview-inspect")!.click();
    else h.element.querySelector("#btn-refresh-attention")!.click();
    pending.resolve(overview()); await flush();
    expect(h.inspector().hidden).toBe(reason !== "another selection");
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.inspectWorkAttention).not.toHaveBeenCalled();
    if (reason === "close") expect(h.element.hidden).toBe(true);
  });
});
