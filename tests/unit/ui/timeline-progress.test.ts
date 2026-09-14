import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineView } from "../../../src/timeline.ts";
import type { TimelineEvent, TimelineProgress } from "../../../shared/types";
import { installFakeDom, type FakeDocument, type FakeEl } from "./fake-dom.ts";

function toolEvent(seq: number): TimelineEvent {
  return { seq, t: "tool", ts: Date.now(), toolName: "edit", relPath: "a.ts", stateId: `state-${seq}` };
}

interface Harness {
  view: TimelineView;
  prefix: FakeEl;
  calls: number[];
  resolvers: Map<number, (p: TimelineProgress) => void>;
  dot(seq: number): FakeEl;
  hover(seq: number): Promise<void>;
}

function makeHarness(document: FakeDocument): Harness {
  const container = document.createElement("div");
  for (const id of ["timeline-dots", "timeline-count", "timeline-prefix", "timeline-recorder", "btn-timeline-play"]) {
    const el = document.createElement("div");
    el.id = id;
    container.appendChild(el);
  }
  const view = new TimelineView(container as unknown as HTMLElement);
  const calls: number[] = [];
  const resolvers = new Map<number, (p: TimelineProgress) => void>();
  view.bind({
    onJump: () => {},
    onFork: () => {},
    onProgress: (seq: number) => {
      calls.push(seq);
      return new Promise<TimelineProgress>((resolve) => {
        resolvers.set(seq, resolve);
      });
    },
  });
  const internals = view as unknown as { dots: Map<number, FakeEl> };
  return {
    view,
    prefix: container.querySelector("#timeline-prefix") as FakeEl,
    calls,
    resolvers,
    dot: (seq: number) => {
      const dot = internals.dots.get(seq);
      if (!dot) throw new Error(`no dot for seq ${seq}`);
      return dot;
    },
    hover: async (seq: number) => {
      internals.dots.get(seq)?.dispatch("pointerenter");
      await vi.advanceTimersByTimeAsync(100);
    },
  };
}

let fake: { document: FakeDocument; modalRoot: FakeEl; cleanup: () => void };

beforeEach(() => {
  vi.useFakeTimers();
  fake = installFakeDom();
});

afterEach(() => {
  vi.useRealTimers();
  fake.cleanup();
});

describe("timeline progress across eviction (refs #145)", () => {
  it("retries a surviving dot after an unrelated eviction strands its first lookup", async () => {
    const h = makeHarness(fake.document);
    h.view.push(toolEvent(1));
    h.view.push(toolEvent(2));

    await h.hover(1);
    expect(h.calls).toEqual([1]);

    // An unrelated eviction retires pending markers while seq 1 is still pending.
    h.view.evict([2]);
    h.resolvers.get(1)!({ ok: true, seq: 1, files: 2, paths: ["a.ts"] });
    await vi.advanceTimersByTimeAsync(0);

    // The dropped completion must not strand the dot: hovering retries the lookup.
    await h.hover(1);
    expect(h.calls).toEqual([1, 1]);
    h.resolvers.get(1)!({ ok: true, seq: 1, files: 2, paths: ["a.ts"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.dot(1).title).toContain("2 files");
    expect((h.view as unknown as { progressInFlight: Map<number, object> }).progressInFlight.size).toBe(0);
  });

  it("drops a late completion for an evicted dot without stranding markers", async () => {
    const h = makeHarness(fake.document);
    h.view.push(toolEvent(1));
    h.view.push(toolEvent(2));

    await h.hover(2);
    expect(h.calls).toEqual([2]);
    h.view.evict([2]);
    h.resolvers.get(2)!({ ok: true, seq: 2, files: 1 });
    await vi.advanceTimersByTimeAsync(0);

    const internals = h.view as unknown as { progressInFlight: Map<number, object>; progressCache: Map<number, TimelineProgress> };
    expect(internals.progressInFlight.size).toBe(0);
    expect(internals.progressCache.has(2)).toBe(false);
  });

  it("retries after a same-sequence refresh lands while a request is pending", async () => {
    const h = makeHarness(fake.document);
    h.view.push(toolEvent(1));

    await h.hover(1);
    expect(h.calls).toEqual([1]);
    // Main re-sends the same moment (refresh path) before the lookup resolves.
    h.view.push({ ...toolEvent(1), relPath: "b.ts" });
    h.resolvers.get(1)!({ ok: true, seq: 1, files: 1 });
    await vi.advanceTimersByTimeAsync(0);

    // The stale result applies to nothing — not even the cache.
    const internals = h.view as unknown as { progressInFlight: Map<number, object>; progressCache: Map<number, TimelineProgress> };
    expect(internals.progressCache.has(1)).toBe(false);
    await h.hover(1);
    expect(h.calls).toEqual([1, 1]);
    h.resolvers.get(1)!({ ok: true, seq: 1, files: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.dot(1).title).toContain("5 files");
    expect(internals.progressInFlight.size).toBe(0);
  });

  it("retries after a reset lands while a request is pending", async () => {
    const h = makeHarness(fake.document);
    h.view.push(toolEvent(1));

    await h.hover(1);
    expect(h.calls).toEqual([1]);
    h.view.setEvents([toolEvent(1)]);
    h.resolvers.get(1)!({ ok: true, seq: 1, files: 1 });
    await vi.advanceTimersByTimeAsync(0);

    await h.hover(1);
    expect(h.calls).toEqual([1, 1]);
  });
});

describe("timeline activity prefix (issue #291)", () => {
  it("shows blocked activity when tool counts are still zero", () => {
    const h = makeHarness(fake.document);
    h.view.setPrefix({
      ok: 0,
      error: 0,
      open: 0,
      activity: { state: "blocked", reason: "tool-error-loop" },
    });
    expect(h.prefix.hidden).toBe(false);
    expect(h.prefix.textContent).toBe("blocked: tool-error-loop");
    expect(h.prefix.title).toBe("blocked: tool-error-loop");
  });

  it("annotates the newest dot tooltip when blocked", () => {
    const h = makeHarness(fake.document);
    h.view.push(toolEvent(1));
    h.view.setPrefix({
      ok: 0,
      error: 3,
      open: 0,
      activity: { state: "blocked", reason: "tool-error-loop" },
    });
    expect(h.dot(1).title).toContain("blocked: tool-error-loop");
  });

  it("hides the prefix when idle and counts are zero", () => {
    const h = makeHarness(fake.document);
    h.view.setPrefix({
      ok: 0,
      error: 0,
      open: 0,
      activity: { state: "idle", reason: null },
    });
    expect(h.prefix.hidden).toBe(true);
    expect(h.prefix.textContent).toBe("");
  });

  it("renders an unknown blocked reason as blocked, not as raw text", () => {
    const h = makeHarness(fake.document);
    h.view.setPrefix({
      ok: 0,
      error: 0,
      open: 0,
      activity: { state: "blocked", reason: "evil-reason" as "stalled" },
    });
    expect(h.prefix.textContent).toBe("blocked");
    expect(h.prefix.title).toBe("blocked");
  });
});
