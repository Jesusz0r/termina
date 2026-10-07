import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttentionView } from "../../../src/main/attention-view.ts";
import type { TerminaBridge, WorkAttentionInspectResult, WorkAttentionItem, WorkOverview } from "../../../shared/types.ts";
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
      { projectId: "proj-1", name: "First project", root: "/projects/full/path/first", working: 0, attentionCount: items.filter((row) => row.projectId === "proj-1").length },
      { projectId: "proj-2", name: "Other project", root: "/projects/full/path/other", working: 1, attentionCount: items.filter((row) => row.projectId === "proj-2").length },
    ],
    items,
  };
}

function inspectResult(terminalId = "current-term", projectId = "proj-2"): Extract<WorkAttentionInspectResult, { ok: true }> {
  return {
    ok: true,
    folder: { cwd: "/projects/full/path/other", projectId, workspaceId: "current-ws", activationGeneration: 7, needsLogin: false },
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
const hooks = ["onInstances", "onPlanUpdate", "onVerifyState", "onTimelineClear", "onFolderOpened", "onProjectClosed", "onAgentStatus", "onTimelinePrefix"] as const;
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
  const list = child("ul", "attention-list");
  const status = child("p", "attention-status");
  const message = child("p", "attention-message");
  const close = child("button", "btn-close-attention");
  const refresh = child("button", "btn-refresh-attention");
  const more = child("button", "btn-more-attention");
  const outside = dom.document.createElement("button");
  dom.document.body.append(toggle, element, outside);
  const callbacks = new Map<string, (payload: unknown) => void>();
  const unsubs = hooks.map(() => vi.fn());
  const getWorkOverview = vi.fn(async (): Promise<WorkOverview> => initial);
  if (pending) getWorkOverview.mockReturnValueOnce(pending);
  const inspectWorkAttention = vi.fn(async (_id: string): Promise<WorkAttentionInspectResult> => inspectResult());
  const bridge = { getWorkOverview, inspectWorkAttention } as unknown as TerminaBridge;
  hooks.forEach((hook, index) => {
    bridge[hook] = ((callback: (payload: unknown) => void) => {
      callbacks.set(hook, callback);
      return unsubs[index]!;
    }) as never;
  });
  const onOverview = vi.fn<(value: WorkOverview | null) => void>();
  const onInspect = vi.fn(async (_result: Extract<WorkAttentionInspectResult, { ok: true }>, _isCurrent: () => boolean): Promise<boolean> => false);
  view = createAttentionView({
    element: element as unknown as HTMLElement, toggle: toggle as unknown as HTMLButtonElement,
    bridge, onOverview, onInspect,
  });
  return {
    element, toggle, count, list, status, message, close, refresh, more, outside,
    getWorkOverview, inspectWorkAttention, onOverview, onInspect, unsubs,
    emit: (hook: typeof hooks[number], payload: unknown = {}) => callbacks.get(hook)!(payload),
    open: async () => { view!.open(); await refreshDelay(); },
    inspectButton: (index = 0) => list.children[index]!.querySelector("button")!,
  };
}

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
