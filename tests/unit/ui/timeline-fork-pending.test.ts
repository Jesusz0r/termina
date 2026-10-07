import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimelinePane } from "../../../src/main/timeline-pane.ts";
import type { TimelineEvent } from "../../../shared/types.ts";
import { FakeEl, installFakeDom } from "./fake-dom.ts";

vi.mock("../../../src/components/modals", () => ({ toast: vi.fn() }));
import { toast } from "../../../src/components/modals";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function sourcePane(instanceId: string) {
  return {
    instanceId, generation: 1,
    timeline: [{ seq: 1, t: "tool", ts: 1, toolName: "edit", relPath: "a.ts", stateId: "state-1" } satisfies TimelineEvent],
    timelineLoaded: true, timelineRequestToken: 0, timelinePrefix: null,
    recorderState: "ready", recorderDetail: null,
  };
}

type Pane = ReturnType<typeof sourcePane>;
type ForkResult = { ok: boolean; error?: string; comparisonId?: string };
let fake: ReturnType<typeof installFakeDom>;
let controller: ReturnType<typeof createTimelinePane<Pane>>;

function harness() {
  const container = fake.document.createElement("div");
  for (const id of ["timeline-dots", "timeline-count", "timeline-prefix", "timeline-recorder", "btn-timeline-play"]) {
    const el = fake.document.createElement("div");
    el.id = id;
    container.appendChild(el);
  }
  fake.document.body.appendChild(container);
  const panes = new Map(["term-a", "term-b"].map((id) => [id, sourcePane(id)]));
  let active = panes.get("term-a")!;
  let project = { id: "project-a", generation: 1 };
  const requests: ReturnType<typeof deferred<ForkResult>>[] = [];
  const editor = { openSnapshot: vi.fn() };
  const forkPoint = vi.fn((_id: string, _seq: number) => {
    const request = deferred<ForkResult>();
    requests.push(request);
    return request.promise;
  });
  const subscribe = () => () => {};
  vi.stubGlobal("window", { termina: {
    forkPoint, getTimelineProgress: async (seq: number) => ({ ok: false, seq }),
    getTimelineContent: async () => ({ ok: true, relPath: "a.ts", content: "original source" }),
    onTimelineEvent: subscribe, onTimelineEvict: subscribe, onTimelineClear: subscribe,
    onTimelinePrefix: subscribe, onRecorderState: subscribe,
  } });
  controller = createTimelinePane({
    container: container as unknown as HTMLElement,
    getActivePane: () => active, getActivePaneId: () => active.instanceId,
    getPaneById: (id) => panes.get(id), getActiveProject: () => project,
    getEditor: () => editor,
    onContent: () => {}, onAgentSettled: () => {}, onTimelineCleared: () => {},
  });
  controller.renderTimeline();
  const dot = () => container.querySelector(".timeline-dot")!;
  const activate = (keyboard = false) => {
    if (keyboard) dot().dispatch("keydown", { key: "Enter", ctrlKey: true });
    else dot().dispatch("click", { metaKey: true });
  };
  return {
    panes, forkPoint, requests, dot, activate, editor,
    count: container.querySelector("#timeline-count")!,
    switchPane: (id: string) => { active = panes.get(id)!; controller.renderTimeline(); },
    switchProject: (id: string, generation: number) => {
      project = { id, generation };
      controller.resetForProject();
      controller.renderTimeline();
    },
  };
}

async function flushCompletion() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  fake = installFakeDom();
  vi.stubGlobal("HTMLElement", FakeEl);
  vi.stubGlobal("Element", FakeEl);
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  controller?.dispose();
  vi.unstubAllGlobals();
  fake.cleanup();
});

describe("timeline fork preparation feedback", () => {
  it("shows pending from keyboard activation until completion and suppresses repeated keyboard/click forks", async () => {
    const h = harness();
    h.activate(true);
    expect(h.forkPoint).toHaveBeenCalledExactlyOnceWith("term-a", 1);
    expect(h.dot().getAttribute("aria-busy")).toBe("true");
    expect(h.dot().getAttribute("aria-label")).toContain("Preparing candidate");
    expect(h.count.textContent).toContain("Preparing candidate");
    h.activate();
    h.activate(true);
    controller.renderTimeline();
    h.activate();
    expect(h.forkPoint).toHaveBeenCalledTimes(1);
    expect(h.dot().title).toContain("Preparing candidate");
    h.requests[0].resolve({ ok: true, comparisonId: "cmp" });
    await flushCompletion();
    expect(h.dot().hasAttribute("aria-busy")).toBe(false);
    expect(h.dot().title).toContain("to fork at this moment");
    expect(h.count.textContent).toBe("(1)");
    expect(toast).not.toHaveBeenCalled();
  });

  it("keeps pending feedback through point refreshes without blocking ordinary snapshot inspection", async () => {
    const h = harness();
    h.activate();
    controller.view.push({ ...h.panes.get("term-a")!.timeline[0], relPath: "updated.ts" });
    expect(h.dot().title).toContain("updated.ts");
    expect(h.dot().title).toContain("Preparing candidate");
    expect(h.dot().getAttribute("aria-busy")).toBe("true");
    h.activate(true);
    expect(h.forkPoint).toHaveBeenCalledTimes(1);
    h.dot().dispatch("click");
    await flushCompletion();
    expect(h.editor.openSnapshot).toHaveBeenCalledTimes(1);
    expect(h.dot().getAttribute("aria-busy")).toBe("true");
    h.requests[0].resolve({ ok: true });
    await flushCompletion();
    expect(h.dot().title).toContain("to fork at this moment");
  });

  it("does not publish a late failure after disposal", async () => {
    const h = harness();
    h.activate();
    controller.dispose();
    expect(h.dot().hasAttribute("aria-busy")).toBe(false);
    h.requests[0].reject(new Error("closed source"));
    await flushCompletion();
    expect(toast).not.toHaveBeenCalled();
    expect(h.count.textContent).toBe("(1)");
  });

  it.each(["reply", "throw"] as const)("restores the same point after a %s failure and allows explicit retry", async (failure) => {
    const h = harness();
    h.activate();
    if (failure === "reply") h.requests[0].resolve({ ok: false, error: "preparation refused" });
    else h.requests[0].reject(new Error("preparation refused"));
    await flushCompletion();
    expect(h.dot().hasAttribute("aria-busy")).toBe(false);
    expect(h.count.textContent).toBe("(1)");
    expect(toast).toHaveBeenCalledExactlyOnceWith("fork at this moment failed: preparation refused", "warning");
    h.activate(true);
    expect(h.forkPoint).toHaveBeenCalledTimes(2);
    expect(h.dot().getAttribute("aria-busy")).toBe("true");
    h.requests[1].resolve({ ok: true });
    await flushCompletion();
    expect(h.dot().hasAttribute("aria-busy")).toBe(false);
  });

  it("keeps equal sequence numbers independent across panes and ignores old-pane failure", async () => {
    const h = harness();
    h.activate();
    h.switchPane("term-b");
    expect(h.dot().hasAttribute("aria-busy")).toBe(false);
    h.activate(true);
    expect(h.forkPoint.mock.calls).toEqual([["term-a", 1], ["term-b", 1]]);
    h.requests[0].resolve({ ok: false, error: "old source failed" });
    await flushCompletion();
    expect(h.dot().getAttribute("aria-busy")).toBe("true");
    expect(toast).not.toHaveBeenCalled();
    h.requests[1].resolve({ ok: true });
    await flushCompletion();
    expect(h.dot().hasAttribute("aria-busy")).toBe(false);
  });

  it("restores a pending point when returning to its pane without admitting it twice", async () => {
    const h = harness();
    h.activate();
    h.switchPane("term-b");
    h.switchPane("term-a");
    expect(h.dot().getAttribute("aria-busy")).toBe("true");
    h.activate(true);
    expect(h.forkPoint).toHaveBeenCalledTimes(1);
    h.requests[0].resolve({ ok: false, error: "try again" });
    await flushCompletion();
    expect(h.dot().hasAttribute("aria-busy")).toBe(false);
    expect(toast).toHaveBeenCalledWith("fork at this moment failed: try again", "warning");
  });

  it.each(["project", "project generation", "terminal generation", "pane replacement"])("does not let a previous %s clear a new same-sequence request", async (change) => {
    const h = harness();
    h.activate();
    if (change === "project") h.switchProject("project-b", 2);
    else if (change === "project generation") h.switchProject("project-a", 2);
    else if (change === "terminal generation") {
      h.panes.get("term-a")!.generation++;
      controller.renderTimeline();
    } else {
      h.panes.set("term-a", sourcePane("term-a"));
      h.switchPane("term-a");
    }
    expect(h.dot().hasAttribute("aria-busy")).toBe(false);
    h.activate();
    expect(h.forkPoint).toHaveBeenCalledTimes(2);
    h.requests[0].reject(new Error("obsolete failure"));
    await flushCompletion();
    expect(h.dot().getAttribute("aria-busy")).toBe("true");
    expect(h.count.textContent).toContain("Preparing candidate");
    expect(toast).not.toHaveBeenCalled();
    h.requests[1].resolve({ ok: true });
    await flushCompletion();
    expect(h.dot().hasAttribute("aria-busy")).toBe(false);
  });
});
