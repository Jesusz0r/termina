import { prepareCandidateContext } from "../../../src/main/candidate-navigation.ts";
import { projectCards, taskTarget, type OverviewWorkCard } from "../../../src/main/project-overview.ts";
import type { WorldlineSummary } from "../../../shared/types.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttentionView } from "../../../src/main/attention-view.ts";
import type { PlanTask, TerminaBridge, WorkAttentionInspectResult, WorkAttentionItem, WorkOverview, WorkSummaryAction } from "../../../shared/types.ts";
import { projectWorkSummary, workOverview } from "../../../electron/main/work-summary.ts";
import { FakeEl, installFakeDom } from "./fake-dom.ts";

function item(overrides: Partial<WorkAttentionItem> = {}): WorkAttentionItem {
  return {
    id: "attention-1", projectId: "proj-1", terminalId: "term-1", generation: 3,
    model: "provider/model", taskText: "Repair the parser", reason: "task-incomplete", detail: "Last attempt incomplete",
    workArea: { workspaceId: "ws-1", root: "/projects/first", kind: "project", comparisonId: null },
    action: { kind: "plan", terminalId: "term-1", generation: 3 }, ...overrides,
  };
}

function overview(items: WorkAttentionItem[] = [item()]): WorkOverview {
  return {
    projects: [
      { projectId: "proj-1", name: "First project", root: "/projects/full/path/first", terminals: [], candidateRecoveries: [], working: 0, attentionCount: items.filter((row) => row.projectId === "proj-1").length },
      { projectId: "proj-2", name: "Other project", root: "/projects/full/path/other", terminals: [], candidateRecoveries: [], working: 1, attentionCount: items.filter((row) => row.projectId === "proj-2").length },
    ],
    items,
  };
}

function inspectResult(terminalId = "current-term", projectId = "proj-2"): Extract<WorkAttentionInspectResult, { ok: true }> {
  return {
    ok: true,
    folder: { cwd: "/projects/full/path/other", projectId, workspaceId: "current-ws", activationGeneration: 7, needsLogin: false,
      projectRoot: "/projects/full/path/other", primaryWorkspaceId: "current-ws" },
    action: { kind: "evidence", terminalId, generation: 9 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const refreshDelay = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(150); await flush(); };
const text = (node: FakeEl): string => [node.textContent, ...node.children.map(text)].join("\n");
const hooks = ["onInstances", "onPlanUpdate", "onModifiedList", "onFileChanged", "onFileDeleted", "onVerifyState", "onTimelineClear", "onFolderOpened", "onProjectClosed", "onAgentStatus", "onTimelinePrefix"] as const;
let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createAttentionView> | undefined;

beforeEach(() => { dom = installFakeDom(); vi.useFakeTimers(); });
afterEach(() => { view?.dispose(); view = undefined; vi.useRealTimers(); dom.cleanup(); });

function harness(initial = overview(), pending?: Promise<WorkOverview>) {
  const element = dom.document.createElement("section");
  element.hidden = true;
  const toggle = dom.document.createElement("button");
  toggle.setAttribute("aria-expanded", "false");
  const count = dom.document.createElement("span");
  count.className = "attention-count";
  toggle.append(count);
  const child = (tag: string, id: string): FakeEl => {
    const node = dom.document.createElement(tag);
    node.id = id;
    element.append(node);
    return node;
  };
  const title = child("h2", "work-view-title");
  const projectContent = child("div", "project-overview");
  const attentionHeading = child("h3", "overview-attention-heading");
  const overviewToggle = dom.document.createElement("button");
  const workspace = dom.document.createElement("div");
  const list = child("ul", "attention-list");
  const status = child("p", "attention-status");
  const message = child("p", "attention-message");
  const close = child("button", "btn-close-attention");
  const refresh = child("button", "btn-refresh-attention");
  const more = child("button", "btn-more-attention");
  const outside = dom.document.createElement("button");
  dom.document.body.append(toggle, overviewToggle, element, workspace, outside);
  const callbacks = new Map<string, (payload: unknown) => void>();
  const unsubs = hooks.map(() => vi.fn());
  const getWorkOverview = vi.fn(async (): Promise<WorkOverview> => initial);
  if (pending) getWorkOverview.mockReturnValueOnce(pending);
  const inspectWorkAttention = vi.fn(async (_id: string): Promise<WorkAttentionInspectResult> => inspectResult());
  const getVerifyReport = vi.fn(async (_id: string, _generation: number): Promise<string | null> => "Check output");
  const getReviewFiles = vi.fn<TerminaBridge["getReviewFiles"]>().mockResolvedValue({ ok: true, files: [], total: 0 });
  const getReviewDiff = vi.fn<TerminaBridge["getReviewDiff"]>().mockResolvedValue({ ok: false, error: "Baseline unavailable" });
  const createPlanTask = vi.fn<TerminaBridge["createPlanTask"]>().mockResolvedValue({ ok: false, error: "Fixture rejection" });
  const startPlanTask = vi.fn<TerminaBridge["startPlanTask"]>().mockResolvedValue({ ok: true, dispatched: 1 });
  const bridge = { getWorkOverview, inspectWorkAttention, getVerifyReport, getReviewFiles, getReviewDiff, createPlanTask, startPlanTask } as unknown as TerminaBridge;
  hooks.forEach((hook, index) => {
    bridge[hook] = ((callback: (payload: unknown) => void) => {
      callbacks.set(hook, callback);
      return unsubs[index]!;
    }) as never;
  });
  const onOverview = vi.fn<(value: WorkOverview | null) => void>();
  const onNavigate = vi.fn(async (_projectId: string, _action: WorkSummaryAction | null, _isCurrent: () => boolean): Promise<boolean> => false);
  const onReveal = vi.fn();
  const onViewChange = vi.fn();
  const onNewProject = vi.fn();
  const onCandidateNavigate = vi.fn().mockResolvedValue(false);
  const onRevealCandidate = vi.fn();
  const onInspect = vi.fn(async (_result: Extract<WorkAttentionInspectResult, { ok: true }>, _isCurrent: () => boolean): Promise<boolean> => false);
  view = createAttentionView({
    element: element as unknown as HTMLElement, toggle: toggle as unknown as HTMLButtonElement,
    overviewToggle: overviewToggle as unknown as HTMLButtonElement,
    workspace: [workspace as unknown as HTMLElement],
    bridge, onOverview, onInspect, onNavigate, onReveal, onViewChange, onNewProject,
    onFocusTerminal: vi.fn().mockResolvedValue(null),
    onTerminalControl: vi.fn().mockResolvedValue({ ok: true }),
    onCandidateNavigate, onRevealCandidate,
  });
  return {
    element, toggle, overviewToggle, workspace, title, projectContent, attentionHeading,
    onNavigate, onReveal, onViewChange, onNewProject, onCandidateNavigate, onRevealCandidate,
    count, list, status, message, close, refresh, more, outside,
    getWorkOverview, inspectWorkAttention, getVerifyReport, getReviewFiles, getReviewDiff, createPlanTask, startPlanTask, onOverview, onInspect, unsubs,
    emit: (hook: typeof hooks[number], payload: unknown = {}) => callbacks.get(hook)!(payload),
    open: async () => { view!.open(); await refreshDelay(); },
    inspectButton: (index = 0) => list.children[index]!.querySelector("button")!,
  };
}

function overviewWithTask(extra: PlanTask[] = []): WorkOverview {
  const project = projectWorkSummary({ id: "proj-1", cwd: "/projects/first" }, [{
    id: "term-1", generation: 3, type: "agent", model: "provider/model",
    activity: { state: "idle", reason: null }, workspace: { id: "ws-1", root: "/projects/first", primary: true },
    verify: { state: "untested", command: null, summary: null }, dispatchAssignment: null, trackedChanges: 0, planCreationError: null, planStartOwnerError: null,
    plan: [{ text: "Repair the parser", paths: [], state: "pending" }, ...extra],
  }]);
  const value = workOverview([project]);
  value.items = [item({ projectId: "proj-2" })];
  return value;
}

describe("integrated All projects surface", () => {
  it("reveals retained candidate controls only for the current task selection", async () => {
    const value = overviewWithTask([{ text: "Other task", paths: [], state: "pending" }]);
    const task = value.projects[0]!.terminals[0]!.tasks[0]!;
    task.task.candidate = { comparisonId: "retained", label: "A" };
    task.candidate = { ...task.task.candidate, root: "/worlds/A", version: 3, state: "settled", error: null, headStateId: "captured-result" };
    task.task.state = "done";
    const h = harness(value); view!.open(undefined, "overview"); await refreshDelay();
    h.projectContent.querySelectorAll(".overview-inspect")[0]!.click();
    const pending = deferred<boolean>();
    h.onCandidateNavigate.mockReturnValueOnce(pending.promise);
    h.projectContent.querySelector(".overview-inspector-candidate")!.click();
    expect(h.onCandidateNavigate).toHaveBeenCalledWith({ mode: "inspect", projectId: "proj-1", task: expect.objectContaining({ projectId: "proj-1" }) }, expect.any(Function));
    h.projectContent.querySelectorAll(".overview-inspect")[1]!.click();
    pending.resolve(true); await flush();
    expect(h.onRevealCandidate).not.toHaveBeenCalled();
    expect(h.element.hidden).toBe(false);
    h.projectContent.querySelectorAll(".overview-inspect")[0]!.click();
    h.onCandidateNavigate.mockResolvedValueOnce(true);
    h.projectContent.querySelector(".overview-inspector-candidate")!.click(); await flush();
    expect(h.onRevealCandidate).toHaveBeenCalledOnce();
    expect(h.element.hidden).toBe(true);
    expect(h.startPlanTask).not.toHaveBeenCalled();
  });
  it("refreshes the actual selected task assignment after explicit Start without activation or fabricated progress", async () => {
    const h = harness(overviewWithTask()); view!.open(undefined, "overview"); await refreshDelay();
    h.projectContent.querySelector(".overview-inspect")!.click();
    const start = h.projectContent.querySelector(".overview-inspector-start")!;
    expect(start.hidden).toBe(false); expect(start.disabled).toBe(false);
    expect(h.startPlanTask).not.toHaveBeenCalled();
    const next = overviewWithTask(); const owner = next.projects[0]!.terminals[0]!;
    owner.tasks[0]!.task.state = "active"; owner.tasks[0]!.task.workerId = "term-worker";
    owner.tasks[0]!.worker = { terminalId: "term-worker", generation: 8 };
    owner.tasks[0]!.startError = "Only an initial pending task can be started here.";
    next.projects[0]!.terminals.push({ ...structuredClone(owner), terminalId: "term-worker", generation: 8,
      tasks: [], activity: { state: "working", reason: null } });
    const actual = workOverview(next.projects);
    h.getWorkOverview.mockResolvedValue(actual);
    const reads = h.getWorkOverview.mock.calls.length;
    start.click(); start.click(); await flush(); await refreshDelay();
    expect(h.startPlanTask).toHaveBeenCalledExactlyOnceWith({ projectRoot: "/projects/first",
      owner: { projectId: "proj-1", workspaceId: "ws-1", root: "/projects/first", terminalId: "term-1", generation: 3 },
      task: { text: "Repair the parser", paths: [], state: "pending" } });
    expect(h.getWorkOverview).toHaveBeenCalledTimes(reads + 1);
    const inspector = h.projectContent.querySelector("#project-work-inspector")!;
    expect(inspector.hidden).toBe(false);
    expect(text(inspector)).toContain("term-worker"); expect(text(inspector)).toContain("working");
    expect(inspector.querySelector(".overview-inspector-start")!.hidden).toBe(true);
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.onInspect).not.toHaveBeenCalled();
    expect(h.getVerifyReport).not.toHaveBeenCalled(); expect(h.getReviewFiles).not.toHaveBeenCalled();
  });

  it("invalidates pending Start immediately on a plan update, before debounced facts arrive", async () => {
    const h = harness(overviewWithTask()); view!.open(undefined, "overview"); await refreshDelay();
    h.projectContent.querySelector(".overview-inspect")!.click();
    const pending = deferred<{ ok: boolean; error?: string }>(); h.startPlanTask.mockReturnValueOnce(pending.promise);
    const start = h.projectContent.querySelector(".overview-inspector-start")!;
    start.click(); h.emit("onPlanUpdate", { instanceId: "term-1" });
    start.click(); expect(h.startPlanTask).toHaveBeenCalledOnce();
    pending.resolve({ ok: false, error: "obsolete feedback before refresh" }); await flush();
    expect(h.projectContent.querySelector(".overview-inspector-start-status")!.textContent).not.toContain("obsolete feedback");
  });

  it("does not reopen or mark execution from a Start reply received after Overview closes", async () => {
    const h = harness(overviewWithTask()); view!.open(undefined, "overview"); await refreshDelay();
    h.projectContent.querySelector(".overview-inspect")!.click();
    const pending = deferred<{ ok: boolean; error?: string }>(); h.startPlanTask.mockReturnValueOnce(pending.promise);
    h.projectContent.querySelector(".overview-inspector-start")!.click(); view!.close();
    pending.resolve({ ok: false, error: "closed feedback" }); await flush(); await refreshDelay();
    expect(h.element.hidden).toBe(true); expect(h.workspace.inert).toBe(false);
    expect(h.projectContent.querySelector("#project-work-inspector")!.hidden).toBe(true);
    expect(h.projectContent.querySelector(".overview-inspector-start-status")!.textContent).not.toContain("closed feedback");
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.onInspect).not.toHaveBeenCalled();
  });

  it("refreshes the canonical overview and reveals the newly queued task without activating or executing", async () => {
    const h = harness(overviewWithTask()); view!.open(undefined, "overview"); await refreshDelay();
    const queued: PlanTask = { text: "New queue outcome", paths: [], state: "pending" };
    h.getWorkOverview.mockResolvedValue(overviewWithTask([queued]));
    h.createPlanTask.mockResolvedValue({ ok: true, task: queued });
    const opener = h.projectContent.querySelector(".overview-new-task")!;
    h.projectContent.dispatch("click", { target: opener });
    const form = h.projectContent.querySelector(".overview-task-composer")!;
    const input = form.querySelector("input")!;
    input.value = queued.text; input.dispatch("input"); form.dispatch("submit"); await flush(); await flush();
    expect(form.hidden).toBe(true);
    expect(h.createPlanTask).toHaveBeenCalledExactlyOnceWith({ text: queued.text, projectRoot: "/projects/first",
      owner: { projectId: "proj-1", workspaceId: "ws-1", root: "/projects/first", terminalId: "term-1", generation: 3 } });
    expect(h.getWorkOverview).toHaveBeenCalledTimes(3);
    expect(h.message.textContent).toBe("");
    expect(h.onOverview).toHaveBeenLastCalledWith(overviewWithTask([queued]));
    expect(h.projectContent.querySelectorAll(".overview-work-card")).toHaveLength(2);
    const inspector = h.projectContent.querySelector("#project-work-inspector")!;
    expect(inspector.hidden).toBe(false); expect(text(inspector)).toContain(queued.text);
    expect(text(inspector)).toContain("No live worker assigned");
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.onInspect).not.toHaveBeenCalled();
    expect(h.getVerifyReport).not.toHaveBeenCalled(); expect(h.getReviewFiles).not.toHaveBeenCalled();
  });
  it("does not reopen Overview when the post-create canonical refresh completes after leaving", async () => {
    const h = harness(overviewWithTask()); view!.open(undefined, "overview"); await refreshDelay();
    const queued: PlanTask = { text: "Pending after close", paths: [], state: "pending" };
    const loading = deferred<WorkOverview>();
    h.getWorkOverview.mockReturnValueOnce(loading.promise); h.createPlanTask.mockResolvedValue({ ok: true, task: queued });
    h.projectContent.dispatch("click", { target: h.projectContent.querySelector(".overview-new-task")! });
    const form = h.projectContent.querySelector(".overview-task-composer")!; const input = form.querySelector("input")!;
    input.value = queued.text; input.dispatch("input"); form.dispatch("submit"); await flush();
    view!.close(); loading.resolve(overviewWithTask([queued])); await flush(); await flush();
    expect(h.element.hidden).toBe(true); expect(h.workspace.inert).toBe(false);
    expect(h.projectContent.querySelector("#project-work-inspector")!.hidden).toBe(true);
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.onReveal).not.toHaveBeenCalled();
    expect(h.createPlanTask).toHaveBeenCalledOnce();
  });
  it("forwards retained recovery navigation, reveals only after current hydration, and preserves selection", async () => {
    const value = overview([]);
    const recovery = { comparisonId: "cmp-failed", label: "B" as const, root: "/worlds/B", version: 4,
      error: "Session startup failed", recovery: "open" as const };
    value.projects[0]!.candidateRecoveries = [recovery];
    const h = harness(value);
    h.onCandidateNavigate.mockResolvedValue(true);
    view!.open(undefined, "overview"); await refreshDelay();
    h.projectContent.querySelector(".overview-inspect")!.click();
    h.projectContent.querySelector(".overview-inspector-primary")!.click(); await flush();
    expect(h.onCandidateNavigate).toHaveBeenCalledExactlyOnceWith({ projectId: "proj-1", candidate: recovery, mode: recovery.recovery }, expect.any(Function));
    expect(h.onRevealCandidate).toHaveBeenCalledExactlyOnceWith({ projectId: "proj-1", candidate: recovery, mode: recovery.recovery });
    expect(h.element.hidden).toBe(true);
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.inspectWorkAttention).not.toHaveBeenCalled();
    view!.open(undefined, "overview"); await refreshDelay();
    expect(h.projectContent.querySelector(".overview-work-card")!.classList.contains("is-selected")).toBe(true);
  });

  it("does not reveal recovery when the user exits during its navigation", async () => {
    const value = overview([]);
    value.projects[0]!.candidateRecoveries = [{ comparisonId: "cmp-failed", label: "A", root: "/worlds/A", version: 4,
      error: "Session startup failed", recovery: "discard" }];
    const h = harness(value);
    const pending = deferred<boolean>();
    h.onCandidateNavigate.mockReturnValueOnce(pending.promise);
    view!.open(undefined, "overview"); await refreshDelay();
    h.projectContent.querySelector(".overview-inspect")!.click();
    h.projectContent.querySelector(".overview-inspector-primary")!.click();
    view!.close();
    pending.resolve(true); await flush();
    expect(h.onRevealCandidate).not.toHaveBeenCalled();
    expect(h.element.hidden).toBe(true);
  });

  it.each(["onFileChanged", "onFileDeleted"] as const)("invalidates a pending diff on %s in its source, preserving global attention and workspace", async (hook) => {
    const value = overviewWithTask(); const before = JSON.stringify(value);
    const h = harness(value); await flush();
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview"); await refreshDelay();
    const recorded = { path: "/projects/first/actual.ts", relPath: "actual.ts", status: "modified" as const };
    h.getReviewFiles.mockResolvedValue({ ok: true, files: [recorded], total: 1 });
    const pending = deferred<Awaited<ReturnType<TerminaBridge["getReviewDiff"]>>>();
    h.getReviewDiff.mockReturnValueOnce(pending.promise);
    h.projectContent.querySelector(".overview-inspect")!.click();
    h.projectContent.querySelector(".overview-inspector-inspect-changes")!.click(); await flush();
    const list = h.projectContent.querySelector(".overview-changes-list")!;
    list.querySelector("button")!.click();
    expect(h.getReviewDiff).toHaveBeenCalledExactlyOnceWith({ projectId: "proj-1", workspaceId: "ws-1", root: "/projects/first", terminalId: "term-1", generation: 3 }, recorded.path);
    h.emit(hook, { projectId: "proj-2", workspaceId: "other-tree", path: recorded.path });
    expect(list.children).toHaveLength(1);
    h.emit(hook, { projectId: "proj-1", workspaceId: "ws-1", path: recorded.path });
    expect(list.children).toHaveLength(0);
    pending.resolve({ ok: true, ...recorded, baseline: "before", current: "obsolete", deleted: false }); await flush();
    expect(h.projectContent.querySelector(".overview-changes-diff-section")!.hidden).toBe(true);
    expect(h.element.hidden).toBe(false);
    expect(h.workspace.inert).toBe(true);
    expect(h.list.children).toHaveLength(1);
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).toBe(before);
  });

  it("lets the diff's nested controls consume Escape before closing selected work", async () => {
    const h = harness(overviewWithTask()); await flush();
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview"); await refreshDelay();
    h.projectContent.querySelector(".overview-inspect")!.click();
    const control = h.projectContent.querySelector(".overview-inspector-inspect-changes")!;
    control.addEventListener("keydown", (event) => event.preventDefault());
    control.dispatch("keydown", { key: "Escape" });
    expect(h.projectContent.querySelector(".overview-work-inspector")!.hidden).toBe(false);
    expect(h.element.hidden).toBe(false);
  });

  it("opens the real card overview without activating a project, and keeps attention global while filtering", async () => {
    const h = harness(overviewWithTask()); await flush();
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview"); await refreshDelay();
    expect(h.element.getAttribute("aria-label")).toBe("All projects");
    expect(h.title.textContent).toBe("All projects");
    expect(h.overviewToggle.getAttribute("aria-expanded")).toBe("true");
    expect(h.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(h.workspace.inert).toBe(true);
    expect(h.onViewChange).toHaveBeenLastCalledWith(true);
    expect(h.projectContent.hidden).toBe(false);
    expect(text(h.projectContent)).toContain("Repair the parser");
    expect(h.list.children[0]!.dataset.projectId).toBe("proj-2");
    const filter = h.projectContent.querySelector("input")!;
    filter.value = "no matching task"; filter.dispatch("input");
    expect(h.projectContent.querySelectorAll(".overview-work-card")).toHaveLength(0);
    expect(h.list.children).toHaveLength(1);
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.inspectWorkAttention).not.toHaveBeenCalled();
    h.element.dispatch("keydown", { key: "Escape" });
    expect(h.workspace.inert).toBe(false);
    expect(h.onViewChange).toHaveBeenLastCalledWith(false);
    expect(dom.document.activeElement).toBe(h.overviewToggle);
  });

  it("restores the exact workspace inert state when changing mode or disposing", async () => {
    const h = harness(overviewWithTask()); await flush();
    h.workspace.inert = true;
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview");
    h.toggle.click();
    expect(h.element.getAttribute("aria-label")).toBe("Attention across all projects");
    expect(h.workspace.inert).toBe(true);
    expect(h.projectContent.hidden).toBe(true);
    h.workspace.inert = false;
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview");
    view!.dispose();
    expect(h.workspace.inert).toBe(false);
  });

  it("refreshes card facts on tracked-change events without replacing focused actions", async () => {
    const h = harness(overviewWithTask()); await flush();
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview"); await refreshDelay();
    const button = h.projectContent.querySelector(".overview-inspect")!; button.focus();
    const next = overviewWithTask(); next.projects[0]!.terminals[0]!.trackedChanges = 9;
    h.getWorkOverview.mockResolvedValue(next);
    h.emit("onModifiedList", { instanceId: "term-1" }); await refreshDelay();
    expect(text(h.projectContent)).toContain("9 tracked paths");
    expect(h.projectContent.querySelector(".overview-inspect")).toBe(button);
    expect(dom.document.activeElement).toBe(button);
  });

  it("reveals the workspace before handing focus to a successfully opened, generation-fenced task owner", async () => {
    const h = harness(overviewWithTask()); await flush();
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview");
    h.onNavigate.mockImplementation(async (_projectId, _action, isCurrent) => isCurrent());
    h.onReveal.mockImplementation(() => {
      expect(h.workspace.inert).toBe(false);
      expect(h.element.hidden).toBe(true);
      h.outside.focus();
    });
    h.projectContent.querySelector(".overview-inspect")!.click();
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.element.hidden).toBe(false);
    h.projectContent.querySelector(".overview-inspector-primary")!.click(); await flush();
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("proj-1", { kind: "plan", terminalId: "term-1", generation: 3 }, expect.any(Function));
    expect(h.onReveal).toHaveBeenCalledExactlyOnceWith("proj-1", { kind: "plan", terminalId: "term-1", generation: 3 });
    expect(dom.document.activeElement).toBe(h.outside);
    expect(h.inspectWorkAttention).not.toHaveBeenCalled();
  });

  it.each(["close", "new inspection", "select context", "close details", "change mode", "dispose"] as const)("fences pending project navigation after %s", async (action) => {
    const h = harness(overviewWithTask()); await flush();
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview");
    const pending = deferred<boolean>(); h.onNavigate.mockReturnValueOnce(pending.promise);
    h.projectContent.querySelector(".overview-inspect")!.click();
    h.projectContent.querySelector(".overview-inspector-primary")!.click();
    const isCurrent = h.onNavigate.mock.calls[0]![2];
    expect(isCurrent()).toBe(true);
    if (action === "close") h.close.click();
    else if (action === "new inspection") h.inspectButton().click();
    else if (action === "select context") h.projectContent.querySelector(".overview-inspect")!.click();
    else if (action === "close details") h.projectContent.querySelector(".overview-inspector-close")!.click();
    else if (action === "change mode") h.toggle.click();
    else view!.dispose();
    expect(isCurrent()).toBe(false);
    pending.resolve(true); await flush();
    expect(h.onReveal).not.toHaveBeenCalled();
  });

  it("keeps prior cards with an explicit unavailable status, rather than claiming an empty current workspace", async () => {
    const h = harness(overviewWithTask()); await flush();
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview");
    h.getWorkOverview.mockRejectedValue(new Error("IPC unavailable"));
    await refreshDelay();
    expect(text(h.projectContent)).toContain("Repair the parser");
    expect(h.status.textContent).toContain("Previous rows may be outdated");
    expect(h.onOverview).toHaveBeenLastCalledWith(null);
    h.onNavigate.mockResolvedValue(false);
    h.projectContent.querySelector(".overview-inspect")!.click(); await flush();
    expect(h.element.hidden).toBe(false);
    expect(h.projectContent.querySelector(".overview-inspector-status")!.textContent).toContain("overview unavailable");
    expect(h.projectContent.querySelector(".overview-inspector-primary")!.disabled).toBe(true);
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it("closes selected details before the overview and preserves global attention and workspace context", async () => {
    const value = overviewWithTask(); const before = JSON.stringify(value);
    const h = harness(value); await flush();
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview"); await refreshDelay();
    const card = h.projectContent.querySelector(".overview-inspect")!;
    card.click();
    const inspector = h.projectContent.querySelector(".overview-work-inspector")!;
    expect(inspector.hidden).toBe(false);
    expect(h.list.children).toHaveLength(1);
    expect(h.workspace.inert).toBe(true);
    inspector.querySelector(".overview-inspector-title")!.dispatch("keydown", { key: "Escape" });
    expect(inspector.hidden).toBe(true);
    expect(h.element.hidden).toBe(false);
    expect(h.workspace.inert).toBe(true);
    expect(dom.document.activeElement).toBe(card);
    expect(JSON.stringify(value)).toBe(before);
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.inspectWorkAttention).not.toHaveBeenCalled();
    card.dispatch("keydown", { key: "Escape" });
    expect(h.element.hidden).toBe(true);
    expect(h.workspace.inert).toBe(false);
    expect(dom.document.activeElement).toBe(h.overviewToggle);
  });

  it("loads check details without activation and invalidates pending output before a verify refresh", async () => {
    const h = harness(overviewWithTask()); await flush();
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview"); await refreshDelay();
    h.projectContent.querySelector(".overview-inspect")!.click();
    const pending = deferred<string | null>(); h.getVerifyReport.mockReturnValueOnce(pending.promise);
    h.projectContent.querySelector(".overview-inspector-check")!.click();
    expect(h.getVerifyReport).toHaveBeenCalledExactlyOnceWith("term-1", 3);
    h.emit("onVerifyState", { terminalId: "term-1" });
    pending.resolve("Obsolete report"); await flush();
    const report = h.projectContent.querySelector(".overview-inspector-report")!;
    expect(report.hidden).toBe(true);
    expect(report.textContent).toBe("");
    await refreshDelay();
    h.projectContent.querySelector(".overview-inspector-check")!.click(); await flush();
    expect(report.textContent).toBe("Check output");
    expect(h.element.hidden).toBe(false);
    expect(h.list.children).toHaveLength(1);
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.inspectWorkAttention).not.toHaveBeenCalled();
  });

  it("fences pending navigation when refresh removes the selected task", async () => {
    const h = harness(overviewWithTask()); await flush();
    view!.open(h.overviewToggle as unknown as HTMLElement, "overview"); await refreshDelay();
    const pending = deferred<boolean>(); h.onNavigate.mockReturnValueOnce(pending.promise);
    h.projectContent.querySelector(".overview-inspect")!.click();
    h.projectContent.querySelector(".overview-inspector-primary")!.click();
    const isCurrent = h.onNavigate.mock.calls[0]![2];
    const next = overviewWithTask(); next.projects[0]!.terminals[0]!.tasks = [];
    h.getWorkOverview.mockResolvedValue(next);
    h.emit("onPlanUpdate", { instanceId: "term-1" }); await refreshDelay();
    expect(isCurrent()).toBe(false);
    pending.resolve(true); await flush();
    expect(h.onReveal).not.toHaveBeenCalled();
    expect(h.element.hidden).toBe(false);
    expect(h.projectContent.querySelector(".overview-inspector-status")!.textContent).toContain("changed or closed");
  });
});

describe("global attention projection", () => {
  it("loads global facts while closed and updates disclosure accessibility on explicit open/close", async () => {
    const value = overview();
    const h = harness(value); await flush();
    expect(h.getWorkOverview).toHaveBeenCalledExactlyOnceWith();
    expect(h.onOverview).toHaveBeenCalledExactlyOnceWith(value);
    expect(h.element.hidden).toBe(true);
    expect(h.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(h.count.textContent).toBe("1");
    expect(h.toggle.getAttribute("aria-label")).toBe("Attention across all projects: 1 recorded items");
    expect(h.list.children).toHaveLength(0);
    h.toggle.click();
    expect(h.element.hidden).toBe(false);
    expect(h.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(dom.document.activeElement).toBe(h.close);
    h.close.click();
    expect(h.element.hidden).toBe(true);
    expect(h.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement).toBe(h.toggle);
    expect(h.inspectWorkAttention).not.toHaveBeenCalled();
    expect(h.onInspect).not.toHaveBeenCalled();
  });

  it("renders canonical project paths, model, task and work area without filtering to a selected project", async () => {
    const second = item({ id: "other-reason", projectId: "proj-2", terminalId: "term-8", model: null, taskText: null,
      reason: "verify-failed", detail: "exit 1", workArea: { workspaceId: "candidate", root: "/worlds/candidate/tree", kind: "candidate", comparisonId: "comparison-1" } });
    const h = harness(overview([item(), second])); await h.open();
    expect(h.list.children.map((row) => row.dataset.projectId)).toEqual(["proj-1", "proj-2"]);
    const firstText = text(h.list.children[0]!);
    expect(firstText).toContain("Task attempt incomplete");
    expect(firstText).toContain("First project · /projects/full/path/first");
    expect(firstText).toContain("Repair the parser · term-1 · provider/model");
    expect(firstText).toContain("Shared project files · /projects/first");
    const secondText = text(h.list.children[1]!);
    expect(secondText).toContain("Other project · /projects/full/path/other");
    expect(secondText).toContain("No single task assignment recorded · term-8 · model unknown");
    expect(secondText).toContain("Separate candidate tree · /worlds/candidate/tree");
    expect(secondText).not.toMatch(/sandbox|isolated|safe to execute/i);
    expect(h.status.textContent).toBe("2 recorded attention items across all projects.");
    expect(h.inspectWorkAttention).not.toHaveBeenCalled();
  });

  it("describes repeated inspection controls with their exact owner, work area and failure detail", async () => {
    const h = harness(overview([item(), item({ id: "other", projectId: "proj-2", terminalId: "term-2" })]));
    await h.open();
    for (let index = 0; index < 2; index++) {
      const row = h.list.children[index]!;
      const ids = h.inspectButton(index).getAttribute("aria-describedby")?.split(" ");
      expect(ids).toEqual([row.querySelector(".attention-context")!.id, row.querySelector(".attention-area")!.id, row.querySelector(".attention-detail")!.id]);
      expect(ids!.every(Boolean)).toBe(true);
    }
    expect(h.inspectButton(0).getAttribute("aria-describedby")).not.toBe(h.inspectButton(1).getAttribute("aria-describedby"));
  });

  it("uses factual unknowns when project and assigned work area are unavailable", async () => {
    const h = harness(overview([item({ projectId: "closed-project", workArea: null, model: null, taskText: null })]));
    await h.open();
    expect(text(h.list)).toContain("Project unavailable · path unavailable");
    expect(text(h.list)).toContain("Assigned work area unavailable");
    expect(text(h.list)).toContain("model unknown");
  });

  it("does not infer completion from a successful empty overview", async () => {
    const h = harness(overview([])); await h.open();
    expect(h.count.textContent).toBe("0");
    expect(h.status.textContent).toBe("No recorded attention. Idle is not proof of task completion or review.");
    expect(h.more.hidden).toBe(true);
  });

  it("bounds the initial list to 50 items and reveals further canonical pages only on Show more", async () => {
    const items = Array.from({ length: 123 }, (_, index) => item({ id: `reason-${index}`, taskText: `Task ${index}` }));
    const h = harness(overview(items)); await h.open();
    expect(h.count.textContent).toBe("123");
    expect(h.list.children).toHaveLength(50);
    expect(h.list.children.map((row) => row.dataset.id)).toEqual(items.slice(0, 50).map((row) => row.id));
    expect(h.more.hidden).toBe(false);
    expect(h.more.textContent).toBe("Show more (73 remaining)");
    const firstButton = h.inspectButton();
    const queries = h.getWorkOverview.mock.calls.length;
    h.more.focus();
    h.more.click();
    expect(h.list.children).toHaveLength(100);
    expect(dom.document.activeElement).toBe(h.inspectButton(50));
    expect(h.more.textContent).toBe("Show more (23 remaining)");
    h.more.focus();
    h.more.click();
    expect(dom.document.activeElement).toBe(h.inspectButton(100));
    expect(h.list.children.map((row) => row.dataset.id)).toEqual(items.map((row) => row.id));
    expect(h.more.hidden).toBe(true);
    expect(h.inspectButton()).toBe(firstButton);
    expect(h.getWorkOverview).toHaveBeenCalledTimes(queries);
    expect(h.inspectWorkAttention).not.toHaveBeenCalled();
  });
});

describe("refresh scheduling and stable rows", () => {
  it("coalesces updates across every project without stealing focus or clearing unresolved items", async () => {
    const h = harness(); await h.open();
    const row = h.list.children[0]!;
    const button = h.inspectButton(); button.focus();
    const before = h.getWorkOverview.mock.calls.length;
    for (let index = 0; index < 20; index++) {
      h.emit("onPlanUpdate", { instanceId: "other-project-terminal" });
      h.emit("onVerifyState", { terminalId: "other-project-terminal" });
      h.emit("onTimelineClear", { terminalId: "other-project-terminal" });
      h.emit("onFolderOpened", { projectId: "proj-2" });
      h.emit("onProjectClosed", { projectId: "proj-2" });
    }
    await vi.advanceTimersByTimeAsync(149);
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before + 1);
    expect(h.list.children[0]).toBe(row);
    expect(h.inspectButton()).toBe(button);
    expect(dom.document.activeElement).toBe(button);
    expect(text(h.list)).toContain("Task attempt incomplete");
    expect(h.count.textContent).toBe("1");
  });

  it("ignores repeated timeline state and reason, but refreshes when either changes", async () => {
    const h = harness(); await h.open();
    h.emit("onInstances", [{ id: "term-1", model: "provider/model", activity: { state: "blocked", reason: "approval" } }]);
    await refreshDelay();
    const before = h.getWorkOverview.mock.calls.length;
    const row = h.list.children[0]!;
    const insertion = vi.spyOn(h.list, "insertBefore");
    for (let index = 0; index < 20; index++) {
      h.emit("onTimelinePrefix", { terminalId: "term-1", activity: { state: "blocked", reason: "approval" }, seq: index });
      h.emit("onTimelinePrefix", { terminalId: "term-1" });
    }
    await refreshDelay();
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before);
    expect(insertion).not.toHaveBeenCalled();
    expect(h.list.children[0]).toBe(row);
    h.emit("onTimelinePrefix", { terminalId: "term-1", activity: { state: "blocked", reason: "permission" } });
    await refreshDelay();
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before + 1);
    h.emit("onTimelinePrefix", { terminalId: "term-1", activity: { state: "working", reason: "permission" } });
    await refreshDelay();
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before + 2);
  });

  it("ignores model status events with unchanged models and queries once for changed models", async () => {
    const h = harness(); await h.open();
    h.emit("onInstances", [{ id: "term-1", model: "provider/model" }]); await refreshDelay();
    const before = h.getWorkOverview.mock.calls.length;
    const row = h.list.children[0]!;
    for (let index = 0; index < 20; index++) h.emit("onAgentStatus", { terminalId: "term-1", model: "provider/model", tokens: index });
    await refreshDelay();
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before);
    expect(h.list.children[0]).toBe(row);
    for (let index = 0; index < 20; index++) h.emit("onAgentStatus", { terminalId: "term-1", model: "provider/new-model" });
    await refreshDelay();
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before + 1);
    h.emit("onAgentStatus", { terminalId: "term-1", model: null }); await refreshDelay();
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before + 2);
    h.emit("onAgentStatus", { terminalId: "term-1", model: null }); await refreshDelay();
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before + 2);
  });

  it("keeps canonical ordering and the unchanged focused row when a preceding row is replaced", async () => {
    const first = item({ id: "first" });
    const second = item({ id: "second", taskText: "Second task" });
    const h = harness(overview([first, second])); await h.open();
    const stable = h.list.children[1]!;
    const button = h.inspectButton(1); button.focus();
    h.getWorkOverview.mockResolvedValue(overview([item({ id: "replacement" }), { ...second, detail: "New factual detail" }]));
    h.emit("onPlanUpdate"); await refreshDelay();
    expect(h.list.children.map((row) => row.dataset.id)).toEqual(["replacement", "second"]);
    expect(h.list.children[1]).toBe(stable);
    expect(h.inspectButton(1)).toBe(button);
    expect(text(stable)).toContain("New factual detail");
    expect(dom.document.activeElement).toBe(button);
  });

  it("preserves the focused control when the same row changes canonical position", async () => {
    const first = item({ id: "first" });
    const second = item({ id: "second" });
    const h = harness(overview([first, second])); await h.open();
    const button = h.inspectButton(1); button.focus();
    h.getWorkOverview.mockResolvedValue(overview([second, first]));
    h.emit("onPlanUpdate"); await refreshDelay();
    expect(h.list.children.map((row) => row.dataset.id)).toEqual(["second", "first"]);
    expect(h.inspectButton()).toBe(button);
    expect(dom.document.activeElement).toBe(button);
  });

  it("moves focus to Refresh only when the focused row is no longer present", async () => {
    const h = harness(); await h.open(); h.inspectButton().focus();
    h.getWorkOverview.mockResolvedValue(overview([])); h.emit("onPlanUpdate"); await refreshDelay();
    expect(h.list.children).toHaveLength(0);
    expect(dom.document.activeElement).toBe(h.refresh);
  });

  it("invalidates a focused cached failure when the current stale-check projection arrives", async () => {
    const h = harness(overview([item({ id: "failed", reason: "verify-failed" })]));
    await h.open();
    h.close.click();
    h.getWorkOverview.mockResolvedValue(overview([item({ id: "stale", reason: "verify-stale" })]));
    h.toggle.click();
    expect(text(h.list)).toContain("Verify failed");
    const old = h.inspectButton();
    old.focus();
    await refreshDelay();
    expect(text(h.list)).toContain("Verify is outdated");
    expect(h.inspectButton()).not.toBe(old);
    expect(dom.document.activeElement).toBe(h.refresh);
  });

  it("does not steal focus outside the panel during a background refresh", async () => {
    const h = harness(); await h.open(); h.outside.focus();
    h.emit("onPlanUpdate"); await refreshDelay();
    expect(dom.document.activeElement).toBe(h.outside);
    h.close.click(); h.outside.focus();
    h.emit("onPlanUpdate"); await refreshDelay();
    expect(h.element.hidden).toBe(true);
    expect(dom.document.activeElement).toBe(h.outside);
  });
});

describe("request fencing and unavailable facts", () => {
  it("invalidates a pending overview immediately on a newer owner update", async () => {
    const old = deferred<WorkOverview>();
    const h = harness(overview([item({ id: "new" })]), old.promise);
    h.emit("onPlanUpdate");
    old.resolve(overview([item({ id: "old" })])); await flush();
    expect(h.onOverview).not.toHaveBeenCalled();
    await refreshDelay();
    expect(h.onOverview).toHaveBeenCalledTimes(1);
    expect(h.onOverview.mock.calls[0]![0]!.items[0]!.id).toBe("new");
  });

  it.each(["success", "failure"] as const)("rejects out-of-order overview %s after a newer request completes", async (outcome) => {
    const old = deferred<WorkOverview>();
    const h = harness(overview(), old.promise);
    const next = overview([item({ id: "current" }), item({ id: "second" })]);
    h.getWorkOverview.mockResolvedValue(next);
    h.emit("onProjectClosed"); await refreshDelay();
    if (outcome === "success") old.resolve(overview([]));
    else old.reject(new Error("Old unavailable response"));
    await flush();
    expect(h.count.textContent).toBe("2");
    expect(h.onOverview).toHaveBeenCalledExactlyOnceWith(next);
    expect(h.status.textContent).not.toContain("unavailable");
  });

  it("retains prior rows on refresh failure, publishes null overview and never claims a fresh empty result", async () => {
    const h = harness(); await h.open();
    const row = h.list.children[0]!;
    const button = h.inspectButton(); button.focus();
    h.getWorkOverview.mockRejectedValue(new Error("IPC failed"));
    h.emit("onVerifyState"); await refreshDelay();
    expect(h.count.textContent).toBe("?");
    expect(h.toggle.getAttribute("aria-label")).toBe("Attention across all projects: unavailable");
    expect(h.onOverview).toHaveBeenLastCalledWith(null);
    expect(h.status.textContent).toBe("Attention unavailable. Previous rows may be outdated. Refresh to load current facts.");
    expect(h.status.textContent).not.toContain("No recorded attention");
    expect(h.list.children[0]).toBe(row);
    expect(h.inspectButton()).toBe(button);
    expect(dom.document.activeElement).toBe(button);
    h.close.click(); view!.open();
    expect(h.status.textContent).toContain("Previous rows may be outdated");
    expect(h.list.children[0]).toBe(row);
    h.getWorkOverview.mockResolvedValue(overview([])); await refreshDelay();
    expect(h.count.textContent).toBe("0");
    expect(h.toggle.getAttribute("aria-label")).toBe("Attention across all projects: 0 recorded items");
    expect(h.onOverview).toHaveBeenLastCalledWith(overview([]));
    expect(h.list.children).toHaveLength(0);
    expect(h.status.textContent).toContain("Idle is not proof");
  });

  it("shows unavailable on an initial rejection even when opened later", async () => {
    const failed = deferred<WorkOverview>();
    const h = harness(overview(), failed.promise);
    failed.reject(new Error("Initial unavailable")); await flush();
    expect(h.count.textContent).toBe("?");
    expect(h.toggle.getAttribute("aria-label")).toBe("Attention across all projects: unavailable");
    expect(h.onOverview).toHaveBeenCalledExactlyOnceWith(null);
    view!.open();
    expect(h.status.textContent).toContain("Attention unavailable");
    expect(h.status.textContent).not.toContain("No recorded attention");
  });

  it("disposes all subscriptions, cancels scheduled refresh and ignores late overview responses", async () => {
    const old = deferred<WorkOverview>();
    const h = harness(overview(), old.promise);
    h.emit("onPlanUpdate");
    view!.dispose(); view!.dispose();
    old.resolve(overview()); await refreshDelay();
    expect(h.getWorkOverview).toHaveBeenCalledTimes(1);
    expect(h.onOverview).not.toHaveBeenCalled();
    for (const unsub of h.unsubs) expect(unsub).toHaveBeenCalledTimes(1);
    h.toggle.click(); h.refresh.click(); view!.open();
    await refreshDelay();
    expect(h.element.hidden).toBe(true);
    expect(h.getWorkOverview).toHaveBeenCalledTimes(1);
  });
});

describe("explicit current-owner inspection", () => {
  it("forwards only the current row ID and navigates with the canonical main result and a live guard", async () => {
    const h = harness(); await h.open();
    h.getWorkOverview.mockResolvedValue(overview([item({ model: "new/model", action: { kind: "terminal", terminalId: "term-1", generation: 4 } })]));
    h.emit("onPlanUpdate"); await refreshDelay();
    const result = inspectResult(); h.inspectWorkAttention.mockResolvedValue(result);
    h.onInspect.mockImplementation(async (_result, isCurrent) => {
      expect(isCurrent()).toBe(true);
      h.outside.focus();
      return true;
    });
    h.inspectButton().click(); await flush();
    expect(h.inspectWorkAttention).toHaveBeenCalledExactlyOnceWith("attention-1");
    expect(h.onInspect).toHaveBeenCalledExactlyOnceWith(result, expect.any(Function));
    expect(h.element.hidden).toBe(true);
    expect(h.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement).toBe(h.outside);
    expect(h.onInspect.mock.calls[0]![1]()).toBe(false);
  });

  it("keeps a rejected owner message separate from refresh status and retains it across background refreshes", async () => {
    const h = harness(); await h.open();
    h.inspectWorkAttention.mockResolvedValue({ ok: false, error: "The exact owner generation closed." });
    const before = h.getWorkOverview.mock.calls.length;
    h.inspectButton().click(); await flush();
    expect(h.message.textContent).toBe("The exact owner generation closed.");
    expect(h.onInspect).not.toHaveBeenCalled();
    await refreshDelay();
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before + 1);
    expect(h.message.textContent).toBe("The exact owner generation closed.");
    expect(h.status.textContent).toBe("1 recorded attention item across all projects.");
    h.emit("onPlanUpdate"); await refreshDelay();
    expect(h.message.textContent).toBe("The exact owner generation closed.");
    expect(text(h.list)).toContain("Task attempt incomplete");
  });

  it("reports a rejected IPC promise persistently and refreshes current ownership", async () => {
    const h = harness(); await h.open();
    h.inspectWorkAttention.mockRejectedValue(new Error("IPC rejected"));
    const before = h.getWorkOverview.mock.calls.length;
    h.inspectButton().click(); await flush();
    expect(h.message.textContent).toContain("Could not open this item");
    expect(h.onInspect).not.toHaveBeenCalled();
    await refreshDelay();
    expect(h.getWorkOverview).toHaveBeenCalledTimes(before + 1);
    expect(h.message.textContent).toContain("Could not open this item");
  });

  it.each(["close", "Escape", "dispose"] as const)("invalidates a pending main inspection after %s", async (action) => {
    const h = harness(); await h.open();
    const pending = deferred<WorkAttentionInspectResult>();
    h.inspectWorkAttention.mockReturnValueOnce(pending.promise);
    h.inspectButton().click();
    if (action === "close") h.close.click();
    else if (action === "Escape") h.element.dispatch("keydown", { key: "Escape" });
    else view!.dispose();
    pending.resolve(inspectResult()); await flush();
    expect(h.onInspect).not.toHaveBeenCalled();
    if (action !== "dispose") {
      expect(h.element.hidden).toBe(true);
      expect(dom.document.activeElement).toBe(h.toggle);
    }
  });

  it("invalidates an older click when another current row is inspected", async () => {
    const h = harness(overview([item(), item({ id: "attention-2" })])); await h.open();
    const first = deferred<WorkAttentionInspectResult>();
    const second = deferred<WorkAttentionInspectResult>();
    h.inspectWorkAttention.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    h.inspectButton().click(); h.inspectButton(1).click();
    first.resolve(inspectResult("old-term")); await flush();
    expect(h.onInspect).not.toHaveBeenCalled();
    const current = inspectResult("latest-term"); second.resolve(current); await flush();
    expect(h.inspectWorkAttention.mock.calls).toEqual([["attention-1"], ["attention-2"]]);
    expect(h.onInspect).toHaveBeenCalledExactlyOnceWith(current, expect.any(Function));
    expect(h.element.hidden).toBe(false);
  });

  it.each(["close", "new click", "dispose"] as const)("invalidates the navigation guard during an awaited onInspect after %s", async (action) => {
    const h = harness(overview([item(), item({ id: "attention-2" })])); await h.open();
    const navigation = deferred<boolean>();
    h.onInspect.mockReturnValueOnce(navigation.promise);
    h.inspectButton().click(); await flush();
    const isCurrent = h.onInspect.mock.calls[0]![1];
    expect(isCurrent()).toBe(true);
    if (action === "close") {
      h.close.click(); view!.open();
    } else if (action === "new click") {
      h.inspectWorkAttention.mockReturnValueOnce(deferred<WorkAttentionInspectResult>().promise);
      h.inspectButton(1).click();
    } else view!.dispose();
    expect(isCurrent()).toBe(false);
    navigation.resolve(true); await flush();
    expect(h.element.hidden).toBe(false);
    expect(h.toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("returns focus to a connected custom opener on Close and Escape, but ignores other keys", async () => {
    const h = harness(); await flush();
    view!.open(h.outside as unknown as HTMLElement);
    h.element.dispatch("keydown", { key: "Enter" });
    expect(h.element.hidden).toBe(false);
    h.close.click();
    expect(dom.document.activeElement).toBe(h.outside);
    view!.open(h.outside as unknown as HTMLElement);
    h.element.dispatch("keydown", { key: "Escape" });
    expect(h.element.hidden).toBe(true);
    expect(h.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement).toBe(h.outside);
  });

  it("does not resolve a reason merely by inspecting its current owner", async () => {
    const h = harness(); await h.open();
    h.onInspect.mockResolvedValue(true);
    h.inspectButton().click(); await flush();
    await h.open();
    expect(h.list.children).toHaveLength(1);
    expect(h.count.textContent).toBe("1");
    expect(text(h.list)).toContain("Task attempt incomplete");
  });
});


describe("canonical retained candidate navigation", () => {
  function context() {
    const candidate = { comparisonId: "retained", label: "B" as const, root: "/worlds/B", version: 4, state: "settled" as const, error: null, headStateId: "captured-result" };
    const project = projectWorkSummary({ id: "p", cwd: "/source" }, [{ id: "owner", generation: 7, type: "agent", model: null,
      activity: { state: "idle", reason: null }, workspace: { id: "source", root: "/source", primary: true },
      verify: { state: "pass", command: "owner-check", summary: null }, trackedChanges: 1,
      planCreationError: null, planStartOwnerError: null, dispatchAssignment: null,
      plan: [{ text: "Task", paths: [], state: "done", candidate: { comparisonId: candidate.comparisonId, label: candidate.label } }] }],
      [], [candidate as WorldlineSummary]);
    const card = projectCards(project)[0] as OverviewWorkCard;
    const target = { mode: "inspect" as const, projectId: "p", task: taskTarget(project, card) };
    const bridge = { getProjectWorkSummary: vi.fn().mockResolvedValue(project), getWorldlines: vi.fn().mockResolvedValue([candidate]) };
    return { candidate, project, target, bridge };
  }
  it("resolves the retained task link through fresh work and manager summaries without opening a session", async () => {
    const h = context();
    expect(await prepareCandidateContext(h.target, h.bridge, () => true)).toEqual(h.candidate);
    expect(h.bridge.getProjectWorkSummary).toHaveBeenCalledTimes(2);
  });
  it.each(["selection", "root", "version", "link", "unavailable", "manager version"])("rejects changed %s across awaits", async (change) => {
    const h = context(); const pending = deferred<WorldlineSummary[]>();
    h.bridge.getWorldlines.mockReturnValueOnce(pending.promise);
    let current = true;
    const result = prepareCandidateContext(h.target, h.bridge, () => current);
    await Promise.resolve(); await Promise.resolve();
    const next = structuredClone(h.project);
    if (change === "selection") current = false;
    if (change === "root") next.terminals[0]!.tasks[0]!.candidate!.root = "/replacement";
    if (change === "version") next.terminals[0]!.tasks[0]!.candidate!.version++;
    if (change === "link") next.terminals[0]!.tasks[0]!.task.candidate!.comparisonId = "retry";
    if (change === "unavailable") next.terminals[0]!.tasks[0]!.candidate = null;
    h.bridge.getProjectWorkSummary.mockResolvedValue(next);
    pending.resolve([{ ...h.candidate, version: change === "manager version" ? 99 : h.candidate.version } as WorldlineSummary]);
    expect(await result).toBeNull();
  });
});
