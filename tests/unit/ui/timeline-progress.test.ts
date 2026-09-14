import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineView } from "../../../src/timeline.ts";
import type { TimelineEvent, TimelineProgress } from "../../../shared/types";

/** Minimal DOM stand-in: TimelineView only needs elements, listeners, and classes. */
class FakeEl {
  children: FakeEl[] = [];
  listeners = new Map<string, Array<() => void>>();
  dataset: Record<string, string> = {};
  textContent = "";
  title = "";
  hidden = false;
  tabIndex = -1;
  offsetLeft = 0;
  scrollLeft = 0;
  scrollWidth = 0;
  clientWidth = 0;
  private classes = new Set<string>();
  classList = {
    add: (...names: string[]): void => {
      for (const name of names) this.classes.add(name);
    },
    remove: (...names: string[]): void => {
      for (const name of names) this.classes.delete(name);
    },
    toggle: (name: string, force?: boolean): void => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
    },
    contains: (name: string): boolean => this.classes.has(name),
  };

  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  appendChild(child: FakeEl): FakeEl {
    this.children.push(child);
    return child;
  }
  append(...nodes: FakeEl[]): void {
    this.children.push(...nodes);
  }
  remove(): void {
    this.children = [];
  }
  replaceChildren(...nodes: FakeEl[]): void {
    this.children = [...nodes];
  }
  setAttribute(_name: string, _value: string): void {}
  removeAttribute(_name: string): void {}
  focus(_opts?: unknown): void {}
  querySelector(_sel: string): FakeEl | null {
    return null;
  }
}

class FakeContainer extends FakeEl {
  private byId = new Map<string, FakeEl>();
  register(id: string, el: FakeEl): void {
    this.byId.set(id, el);
  }
  override querySelector(sel: string): FakeEl | null {
    return this.byId.get(sel) ?? null;
  }
}

function toolEvent(seq: number): TimelineEvent {
  return { seq, t: "tool", ts: Date.now(), toolName: "edit", relPath: "a.ts", stateId: `state-${seq}` };
}

interface Harness {
  view: TimelineView;
  calls: number[];
  resolvers: Map<number, (p: TimelineProgress) => void>;
  dot(seq: number): FakeEl;
  hover(seq: number): Promise<void>;
}

function makeHarness(): Harness {
  const container = new FakeContainer();
  for (const id of ["#timeline-dots", "#timeline-count", "#timeline-prefix", "#timeline-recorder", "#btn-timeline-play"]) {
    container.register(id, new FakeEl());
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

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).document = {
    createElement: () => new FakeEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
  };
  (globalThis as Record<string, unknown>).HTMLElement = class {};
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).HTMLElement;
});

describe("timeline progress across eviction (refs #145)", () => {
  it("retries a surviving dot after an unrelated eviction strands its first lookup", async () => {
    const h = makeHarness();
    h.view.push(toolEvent(1));
    h.view.push(toolEvent(2));

    await h.hover(1);
    expect(h.calls).toEqual([1]);

    // An unrelated eviction bumps the epoch while seq 1 is still pending.
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
    const h = makeHarness();
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
    const h = makeHarness();
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
    const h = makeHarness();
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
