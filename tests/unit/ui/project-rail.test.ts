import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectRail } from "../../../src/main/project-rail.ts";
import { projectWorkSummary, workOverview, type WorkSummaryTerminalFacts } from "../../../electron/main/work-summary.ts";
import type { WorkOverview } from "../../../shared/types.ts";
import { installFakeDom, type FakeEl } from "./fake-dom.ts";

let dom: ReturnType<typeof installFakeDom>;
let rail: ReturnType<typeof createProjectRail>;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { rail?.dispose(); dom.cleanup(); });

function harness() {
  const list = dom.document.createElement("div");
  const allProjects = dom.document.createElement("button");
  dom.document.body.append(list, allProjects);
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const onAllProjects = vi.fn();
  const onReorder = vi.fn();
  rail = createProjectRail({
    list: list as unknown as HTMLElement,
    allProjects: allProjects as unknown as HTMLButtonElement,
    onActivate, onClose, onAllProjects, onReorder,
  });
  const add = (id: string, cwd = `/projects/${id}`) => rail.upsert({ id, cwd }) as unknown as FakeEl;
  return { list, allProjects, onActivate, onClose, onAllProjects, onReorder, add };
}

function control(row: FakeEl, selector = ".project-select"): FakeEl {
  const element = row.querySelector(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}

function overview(projectId: string, working: number, attentionCount: number): WorkOverview {
  return { projects: [{ projectId, name: projectId, root: `/projects/${projectId}`, working, attentionCount }], items: [] };
}

function terminal(id: string, overrides: Partial<WorkSummaryTerminalFacts> = {}): WorkSummaryTerminalFacts {
  return {
    id, generation: 1, type: "agent", model: "provider/model",
    activity: { state: "idle", reason: null },
    workspace: { id: "ws-1", root: "/projects/p1", primary: true },
    verify: { state: "untested", command: null, summary: null },
    trackedChanges: 0, plan: [], ...overrides,
  };
}

describe("persistent project rail", () => {
  it("distinguishes same-name roots with exact identities and described paths", () => {
    const h = harness();
    const first = h.add("p1", "/projects/same-name");
    const second = h.add("p2", "/other/same-name");
    expect(rail.orderedIds()).toEqual(["p1", "p2"]);
    expect(first.dataset.projectId).toBe("p1");
    expect(second.dataset.projectId).toBe("p2");
    for (const [row, path] of [[first, "/projects/same-name"], [second, "/other/same-name"]] as const) {
      expect(control(row, ".tab-name").textContent).toBe("same-name");
      const description = control(row, ".project-path");
      const counts = control(row, ".project-counts");
      expect(description.textContent).toBe(path);
      expect(control(row).getAttribute("aria-describedby")).toBe(`${description.id} ${counts.id}`);
      expect(control(row, ".tab-close").getAttribute("aria-describedby")).toBe(description.id);
    }
    expect(control(first, ".project-path").id).not.toBe(control(second, ".project-path").id);
  });

  it("uses separate native select and close buttons, forwarding only the exact clicked ID", () => {
    const h = harness();
    const first = h.add("p1", "/projects/same-name");
    const second = h.add("p2", "/other/same-name");
    for (const row of [first, second]) {
      const select = control(row);
      const close = control(row, ".tab-close");
      expect(select.tagName).toBe("BUTTON");
      expect(close.tagName).toBe("BUTTON");
      expect(select.type).toBe("button");
      expect(close.type).toBe("button");
      expect(select.getAttribute("aria-label")).toBe("Open project same-name");
      expect(close.getAttribute("aria-label")).toBe("Close project same-name");
      expect(select.contains(close)).toBe(false);
    }
    control(second, ".project-path").click();
    expect(h.onActivate).toHaveBeenCalledExactlyOnceWith("p2");
    control(first, ".tab-close").click();
    expect(h.onClose).toHaveBeenCalledExactlyOnceWith("p1");
    expect(h.onActivate).toHaveBeenCalledTimes(1);
    first.click();
    expect(h.onActivate).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
    h.allProjects.click();
    expect(h.onAllProjects).toHaveBeenCalledExactlyOnceWith(h.allProjects);
  });

  it("renders canonical working and unresolved attention, independent of inspected notification flags", () => {
    const h = harness();
    const row = h.add("p1");
    const facts = [
      { ...terminal("working", { activity: { state: "working", reason: null } }), verifyAttention: false },
      { ...terminal("blocked", { activity: { state: "blocked", reason: "lease-wait" } }), verifyAttention: false },
      { ...terminal("checked", { verify: { state: "fail", command: "test", summary: "failed" } }), verifyAttention: false },
      { ...terminal("idle", { trackedChanges: 8 }), verifyAttention: true },
    ];
    const canonical = () => workOverview([projectWorkSummary({ id: "p1", cwd: "/projects/p1" }, facts)]);
    expect(canonical().projects[0]).toMatchObject({ working: 1, attentionCount: 2 });
    rail.setOverview(canonical());
    expect(control(row, ".project-working").textContent).toBe("1 working");
    expect(control(row, ".project-attention").textContent).toBe("2 attention");
    expect(control(row, ".project-working").classList.contains("has-work")).toBe(true);
    expect(control(row, ".project-attention").classList.contains("has-attention")).toBe(true);
    rail.setActive("p1");
    for (const fact of facts) fact.verifyAttention = !fact.verifyAttention;
    rail.setOverview(canonical());
    expect(control(row, ".project-attention").textContent).toBe("2 attention");
    expect(row.querySelector(".tab-status")).toBeNull();
  });

  it("shows unknown counts at startup, after null overview, and for missing projects", () => {
    const h = harness();
    const row = h.add("p1");
    const expectUnknown = () => {
      expect(control(row, ".project-working").textContent).toBe("Working unknown");
      expect(control(row, ".project-attention").textContent).toBe("Attention unknown");
      expect(control(row, ".project-working").classList.contains("has-work")).toBe(false);
      expect(control(row, ".project-attention").classList.contains("has-attention")).toBe(false);
      expect(row.classList.contains("idle")).toBe(false);
    };
    expectUnknown();
    rail.setOverview(overview("p1", 2, 3));
    rail.setOverview(null);
    expectUnknown();
    rail.setOverview(overview("another", 0, 0));
    expectUnknown();
    rail.setOverview(overview("p1", 0, 0));
    expect(control(row, ".project-working").textContent).toBe("0 working");
    expect(control(row, ".project-attention").textContent).toBe("0 attention");
  });

  it("updates factual counts and paths in place without replacing controls or focus", () => {
    const h = harness();
    const row = h.add("p1");
    const select = control(row);
    const close = control(row, ".tab-close");
    const counts = control(row, ".project-counts");
    close.focus();
    rail.setOverview(overview("p1", 3, 4));
    expect(h.add("p1", "/moved/p1")).toBe(row);
    rail.setOverview(overview("p1", 1, 2));
    expect(control(row)).toBe(select);
    expect(control(row, ".tab-close")).toBe(close);
    expect(control(row, ".project-counts")).toBe(counts);
    expect(dom.document.activeElement).toBe(close);
    expect(control(row, ".project-path").textContent).toBe("/moved/p1");
    expect(control(row, ".project-working").textContent).toBe("1 working");
    expect(control(row, ".project-attention").textContent).toBe("2 attention");
  });

  it("marks only the active project without changing factual attention or focus", () => {
    const h = harness();
    const first = h.add("p1");
    const second = h.add("p2");
    rail.setOverview(overview("p1", 0, 2));
    control(first).focus();
    rail.setActive("p1");
    expect(first.classList.contains("active")).toBe(true);
    expect(control(first).getAttribute("aria-current")).toBe("page");
    rail.setActive("p2");
    expect(first.classList.contains("active")).toBe(false);
    expect(control(first).getAttribute("aria-current")).toBeNull();
    expect(second.classList.contains("active")).toBe(true);
    expect(control(second).getAttribute("aria-current")).toBe("page");
    expect(control(first, ".project-attention").textContent).toBe("2 attention");
    expect(dom.document.activeElement).toBe(control(first));
    rail.setActive(null);
    expect(second.classList.contains("active")).toBe(false);
    expect(control(second).getAttribute("aria-current")).toBeNull();
    expect(control(first, ".project-attention").textContent).toBe("2 attention");
  });

  it("reads actual DOM order after pointer reordering and skips a drag slot", () => {
    const h = harness();
    const first = h.add("p1");
    const second = h.add("p2");
    const third = h.add("p3");
    const slot = dom.document.createElement("div");
    slot.className = "tab-drag-slot";
    h.list.insertBefore(slot, second);
    h.list.insertBefore(third, first);
    expect(rail.orderedIds()).toEqual(["p3", "p1", "p2"]);
    expect(h.onReorder).not.toHaveBeenCalled();
    control(third).dispatch("keydown", { key: "ArrowDown" });
    expect(dom.document.activeElement).toBe(control(first));
  });

  it("applies a canonical order to existing rows without activating or recommitting it", () => {
    const h = harness();
    const rows = [h.add("p1"), h.add("p2"), h.add("p3")];
    rail.setOrder(["p3", "p1", "p2"]);
    expect(rail.orderedIds()).toEqual(["p3", "p1", "p2"]);
    expect(h.list.children).toEqual([rows[2], rows[0], rows[1]]);
    expect(h.onReorder).not.toHaveBeenCalled();
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it.each([
    [], ["p1", "p2"], ["p1", "p2", "p2"], ["p1", "p2", "unknown"],
    ["p1", "p2", "p3", "extra"], ["p1", "p2", ""],
  ])("ignores a malformed or incomplete canonical order %j", (...ids) => {
    const h = harness();
    const rows = [h.add("p1"), h.add("p2"), h.add("p3")];
    const select = control(rows[1]!);
    select.focus();
    const refocus = vi.spyOn(select, "focus");
    rail.setOrder(ids);
    expect(rail.orderedIds()).toEqual(["p1", "p2", "p3"]);
    expect(h.list.children).toEqual(rows);
    expect(dom.document.activeElement).toBe(select);
    expect(refocus).not.toHaveBeenCalled();
    expect(h.onReorder).not.toHaveBeenCalled();
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it.each([".project-select", ".tab-close"])("restores the same focused %s after canonical reordering", (selector) => {
    const h = harness();
    const first = h.add("p1");
    h.add("p2");
    const focused = control(first, selector);
    focused.focus();
    const refocus = vi.spyOn(focused, "focus");
    // The fake DOM retains focus on detach; simulate the browser's lost focus locally.
    const appendChild = h.list.appendChild.bind(h.list);
    vi.spyOn(h.list, "appendChild").mockImplementation((child) => {
      if (child.contains(dom.document.activeElement!)) dom.document.activeElement = null;
      return appendChild(child);
    });
    rail.setOrder(["p2", "p1"]);
    expect(rail.orderedIds()).toEqual(["p2", "p1"]);
    expect(dom.document.activeElement).toBe(focused);
    expect(refocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(h.onActivate).not.toHaveBeenCalled();
    expect(h.onReorder).not.toHaveBeenCalled();
  });

  it("canonical reordering never refocuses a control outside the list", () => {
    const h = harness();
    h.add("p1");
    h.add("p2");
    h.allProjects.focus();
    const refocus = vi.spyOn(h.allProjects, "focus");
    rail.setOrder(["p2", "p1"]);
    expect(rail.orderedIds()).toEqual(["p2", "p1"]);
    expect(dom.document.activeElement).toBe(h.allProjects);
    expect(refocus).not.toHaveBeenCalled();
    expect(h.onActivate).not.toHaveBeenCalled();
    expect(h.onReorder).not.toHaveBeenCalled();
  });

  it("arrows, Home and End browse focus without activation or reorder", () => {
    const h = harness();
    const rows = [h.add("p1"), h.add("p2"), h.add("p3")];
    rail.setActive("p1");
    control(rows[0]!).focus();
    for (const [key, expected] of [["ArrowDown", 1], ["End", 2], ["ArrowDown", 0], ["ArrowUp", 2], ["Home", 0]] as const) {
      dom.document.activeElement!.dispatch("keydown", { key });
      expect(dom.document.activeElement).toBe(control(rows[expected]!));
    }
    expect(h.onActivate).not.toHaveBeenCalled();
    expect(h.onReorder).not.toHaveBeenCalled();
    expect(control(rows[0]!).getAttribute("aria-current")).toBe("page");
    expect(rail.orderedIds()).toEqual(["p1", "p2", "p3"]);
  });

  it("Alt+Up/Down commits the current permutation exactly once and retains the moved focus", () => {
    const h = harness();
    const first = h.add("p1");
    h.add("p2");
    const third = h.add("p3");
    h.list.insertBefore(third, first);
    const select = control(first);
    select.focus();
    select.dispatch("keydown", { key: "ArrowUp", altKey: true });
    expect(rail.orderedIds()).toEqual(["p1", "p3", "p2"]);
    expect(h.onReorder).toHaveBeenCalledExactlyOnceWith(["p1", "p3", "p2"]);
    expect(dom.document.activeElement).toBe(select);
    h.onReorder.mockClear();
    select.dispatch("keydown", { key: "ArrowDown", altKey: true });
    expect(rail.orderedIds()).toEqual(["p3", "p1", "p2"]);
    expect(h.onReorder).toHaveBeenCalledExactlyOnceWith(["p3", "p1", "p2"]);
    expect(dom.document.activeElement).toBe(select);
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it("does not commit boundary moves or handle browsing from a close button", () => {
    const h = harness();
    const first = h.add("p1");
    const second = h.add("p2");
    control(first).dispatch("keydown", { key: "ArrowUp", altKey: true });
    control(second).dispatch("keydown", { key: "ArrowDown", altKey: true });
    const close = control(first, ".tab-close");
    close.focus();
    close.dispatch("keydown", { key: "End" });
    expect(dom.document.activeElement).toBe(close);
    expect(rail.orderedIds()).toEqual(["p1", "p2"]);
    expect(h.onReorder).not.toHaveBeenCalled();
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it("closing the focused row restores a surviving control, then All projects when empty", () => {
    const h = harness();
    const first = h.add("p1");
    const second = h.add("p2");
    control(first, ".tab-close").focus();
    control(first, ".tab-close").click();
    expect(h.onClose).toHaveBeenCalledExactlyOnceWith("p1");
    rail.remove("p1");
    expect(rail.orderedIds()).toEqual(["p2"]);
    expect(dom.document.activeElement).toBe(control(second));
    rail.remove("p2");
    expect(dom.document.activeElement).toBe(h.allProjects);
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it("background removal never steals focus inside or outside the rail", () => {
    const h = harness();
    const first = h.add("p1");
    h.add("p2");
    control(first).focus();
    rail.remove("p2");
    expect(dom.document.activeElement).toBe(control(first));
    h.allProjects.focus();
    rail.remove("p1");
    expect(dom.document.activeElement).toBe(h.allProjects);
    rail.remove("missing");
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it("disposes list and All projects listeners and stops callbacks", () => {
    const h = harness();
    const first = h.add("p1");
    h.add("p2");
    expect(h.list.listeners.get("click")).toHaveLength(1);
    expect(h.list.listeners.get("keydown")).toHaveLength(1);
    expect(h.allProjects.listeners.get("click")).toHaveLength(1);
    rail.dispose();
    rail.dispose();
    expect(h.list.listeners.get("click")).toHaveLength(0);
    expect(h.list.listeners.get("keydown")).toHaveLength(0);
    expect(h.allProjects.listeners.get("click")).toHaveLength(0);
    control(first).click();
    control(first, ".tab-close").click();
    control(first).dispatch("keydown", { key: "ArrowDown", altKey: true });
    h.allProjects.click();
    expect(h.onActivate).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
    expect(h.onReorder).not.toHaveBeenCalled();
    expect(h.onAllProjects).not.toHaveBeenCalled();
  });
});
