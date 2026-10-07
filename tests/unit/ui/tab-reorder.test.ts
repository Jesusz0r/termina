import { afterEach, describe, expect, it, vi } from "vitest";
import { attachTabReorder } from "../../../src/main/tab-reorder.ts";
import { FakeEl } from "./fake-dom.ts";

type Axis = "horizontal" | "vertical";

/** Only the geometry, siblings and pointer capture missing from FakeEl. */
class ReorderEl extends FakeEl {
  scrollTop = 0;
  axis: Axis | null = null;
  captured = new Set<number>();
  transforms: string[] = [];

  constructor(tagName = "div") {
    super(tagName);
    this.style = new Proxy(this.style, {
      set: (style, key: string, value: string): boolean => {
        if (key === "transform" && value) this.transforms.push(value);
        style[key] = value;
        return true;
      },
    });
  }

  get parentNode(): FakeEl | null { return this.parent; }
  get nextSibling(): FakeEl | null {
    if (!this.parent) return null;
    return this.parent.children[this.parent.children.indexOf(this) + 1] ?? null;
  }
  before(node: ReorderEl): void { this.parent?.insertBefore(node, this); }
  replaceWith(node: ReorderEl): void {
    this.before(node);
    this.remove();
  }
  setPointerCapture(id: number): void { this.captured.add(id); }
  hasPointerCapture(id: number): boolean { return this.captured.has(id); }
  releasePointerCapture(id: number): void {
    this.captured.delete(id);
    this.dispatch("lostpointercapture", { pointerId: id });
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    const width = parseFloat(this.style.width) || 100;
    const height = parseFloat(this.style.height) || 40;
    const parent = this.parent as ReorderEl | null;
    let left = 100;
    let top = 200;
    if (parent?.axis) {
      const vertical = parent.axis === "vertical";
      const siblings = parent.children.slice(0, parent.children.indexOf(this));
      const offset = siblings.reduce((sum, sibling) => {
        const rect = (sibling as ReorderEl).getBoundingClientRect();
        return sum + (vertical ? rect.height : rect.width) + 4;
      }, 0);
      if (vertical) top += offset - parent.scrollTop;
      else left += offset - parent.scrollLeft;
    } else {
      left = parseFloat(this.style.left) || left;
      top = parseFloat(this.style.top) || top;
    }
    return { left, top, width, height };
  }
}

function harness(axis?: Axis, canDrag?: (tab: HTMLElement) => boolean) {
  const body = new ReorderEl("body");
  const window = new FakeEl();
  vi.stubGlobal("document", { body, createElement: (tag: string) => new ReorderEl(tag) });
  vi.stubGlobal("window", window);
  vi.stubGlobal("Element", ReorderEl);
  vi.stubGlobal("HTMLElement", ReorderEl);
  const list = new ReorderEl();
  list.axis = axis ?? "horizontal";
  body.appendChild(list);
  const tabs = ["a", "b", "c"].map((id) => {
    const tab = new ReorderEl();
    tab.id = id;
    tab.className = "test-tab";
    list.appendChild(tab);
    return tab;
  });
  const onCommit = vi.fn();
  attachTabReorder(list as unknown as HTMLElement, { tabClass: "test-tab", axis, canDrag, onCommit });
  const point = (position: number) => list.axis === "vertical"
    ? { clientX: 120, clientY: position }
    : { clientX: position, clientY: 220 };
  const pointer = (type: string, position: number, extra: Record<string, unknown> = {}) => {
    window.dispatch(type, { pointerId: 7, buttons: 1, ...point(position), ...extra });
  };
  const press = (index: number, extra: Record<string, unknown> = {}) => {
    const tab = tabs[index]!;
    const rect = tab.getBoundingClientRect();
    tab.dispatch("pointerdown", {
      pointerId: 7, button: 0, isPrimary: true,
      clientX: rect.left + 20, clientY: rect.top + 20, ...extra,
    });
    return list.axis === "vertical" ? rect.top + 20 : rect.left + 20;
  };
  const order = () => list.children.map((tab) => tab.id || "slot");
  const click = () => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), defaultPrevented: false };
    for (const listener of list.listeners.get("click") ?? []) listener(event);
    return event;
  };
  return { body, window, list, tabs, onCommit, pointer, press, order, click };
}

afterEach(() => vi.unstubAllGlobals());

describe("tab pointer reorder", () => {
  it.each<Axis>(["horizontal", "vertical"])("reorders %s with one persisted commit and no following click", (axis) => {
    const h = harness(axis);
    const start = h.press(0);
    h.pointer("pointermove", start + 3);
    expect(h.order()).toEqual(["a", "b", "c"]);
    expect(h.list.hasPointerCapture(7)).toBe(false);
    const end = axis === "vertical" ? 330 : 410;
    h.pointer("pointermove", end);
    expect(h.order()).toEqual(["b", "c", "slot"]);
    expect(h.list.hasPointerCapture(7)).toBe(true);
    expect(h.tabs[0]!.parent).toBe(h.body);
    expect(h.tabs[0]!.style.left).toBe(axis === "vertical" ? "100px" : "390px");
    expect(h.tabs[0]!.style.top).toBe(axis === "vertical" ? "310px" : "200px");
    const transform = axis === "vertical" ? "translateY(44px)" : "translateX(104px)";
    expect(h.tabs[1]!.transforms).toContain(transform);
    h.pointer("pointerup", end);
    h.pointer("pointerup", end);
    expect(h.order()).toEqual(["b", "c", "a"]);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.list.hasPointerCapture(7)).toBe(false);
    expect(h.body.classList.contains("tab-reordering")).toBe(false);
    expect(h.tabs[0]!.classList.contains("tab-grabbed")).toBe(false);
    for (const key of ["left", "top", "width", "height"]) expect(h.tabs[0]!.style[key]).toBe("");
    const click = h.click();
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(click.stopPropagation).toHaveBeenCalledOnce();
    expect(h.click().preventDefault).not.toHaveBeenCalled();
  });

  it("retains horizontal behavior when axis is omitted", () => {
    const h = harness();
    h.press(2);
    h.pointer("pointermove", 110);
    h.pointer("pointerup", 110);
    expect(h.order()).toEqual(["c", "a", "b"]);
    expect(h.onCommit).toHaveBeenCalledOnce();
  });

  it.each<Axis>(["horizontal", "vertical"])("uses the %s scroll delta without moving targets under the pointer", (axis) => {
    const h = harness(axis);
    const scroll = axis === "vertical" ? "scrollTop" : "scrollLeft";
    h.list[scroll] = 30;
    const start = h.press(0);
    h.pointer("pointermove", start + 6);
    expect(h.order()).toEqual(["slot", "b", "c"]);
    h.list[scroll] = axis === "vertical" ? 90 : 170;
    // At the original viewport position, scrolling moves only b past the pointer.
    h.pointer("pointermove", start + 6);
    expect(h.order()).toEqual(["b", "slot", "c"]);
    h.pointer("pointermove", start + 6);
    expect(h.order()).toEqual(["b", "slot", "c"]);
    h.pointer("pointerup", start + 6);
    expect(h.order()).toEqual(["b", "a", "c"]);
    expect(h.onCommit).toHaveBeenCalledOnce();
  });

  it("uses the release coordinate for the final insertion", () => {
    const h = harness("vertical");
    const start = h.press(0);
    h.pointer("pointermove", start + 6);
    h.pointer("pointerup", 340);
    expect(h.order()).toEqual(["b", "c", "a"]);
    expect(h.onCommit).toHaveBeenCalledOnce();
  });

  it.each(["pointercancel", "Escape", "capture loss", "blur", "buttons released"])("restores the origin without committing after %s", (reason) => {
    const h = harness("vertical");
    h.press(1);
    h.pointer("pointermove", 340);
    expect(h.order()).toEqual(["a", "c", "slot"]);
    if (reason === "Escape") h.window.dispatch("keydown", { key: "Escape" });
    else if (reason === "blur") h.window.dispatch("blur");
    else if (reason === "capture loss") h.list.releasePointerCapture(7);
    else if (reason === "buttons released") h.pointer("pointermove", 340, { buttons: 0 });
    else h.pointer(reason, 340);
    h.pointer("pointerup", 340);
    expect(h.order()).toEqual(["a", "b", "c"]);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.list.hasPointerCapture(7)).toBe(false);
    expect(h.body.classList.contains("tab-reordering")).toBe(false);
    // Cancellation may emit no click; the next press must not swallow one.
    const next = h.press(0);
    h.pointer("pointerup", next);
    expect(h.click().preventDefault).not.toHaveBeenCalled();
  });

  it("restores a last tab whose origin has no next sibling", () => {
    const h = harness("vertical");
    h.press(2);
    h.pointer("pointermove", 210);
    h.pointer("pointercancel", 210);
    expect(h.order()).toEqual(["a", "b", "c"]);
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  it("does not capture or suppress an ordinary click below the threshold", () => {
    const h = harness("vertical");
    const start = h.press(0);
    h.pointer("pointermove", start + 4);
    h.pointer("pointerup", start + 4);
    expect(h.order()).toEqual(["a", "b", "c"]);
    expect(h.list.hasPointerCapture(7)).toBe(false);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.click().preventDefault).not.toHaveBeenCalled();
  });

  it("does not lift a close button or its nested icon", () => {
    const h = harness("vertical");
    const close = new ReorderEl("button");
    close.className = "tab-close";
    const icon = new ReorderEl("span");
    close.appendChild(icon);
    h.tabs[0]!.appendChild(close);
    icon.dispatch("pointerdown", { pointerId: 7, button: 0, isPrimary: true, clientX: 120, clientY: 220 });
    h.pointer("pointermove", 340);
    h.pointer("pointerup", 340);
    expect(h.order()).toEqual(["a", "b", "c"]);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.click().preventDefault).not.toHaveBeenCalled();
  });

  it("ignores non-primary presses, unrelated pointers and tabs that cannot drag", () => {
    const h = harness("vertical", (tab) => tab.id !== "b");
    h.press(0, { isPrimary: false });
    h.pointer("pointermove", 340);
    h.press(0, { button: 2 });
    h.pointer("pointermove", 340);
    h.press(1);
    h.pointer("pointermove", 340);
    expect(h.order()).toEqual(["a", "b", "c"]);
    h.press(0);
    h.pointer("pointermove", 340, { pointerId: 8 });
    h.pointer("pointerup", 340, { pointerId: 8 });
    expect(h.order()).toEqual(["a", "b", "c"]);
    expect(h.onCommit).not.toHaveBeenCalled();
    h.pointer("pointermove", 340);
    h.pointer("pointerup", 340);
    expect(h.order()).toEqual(["b", "c", "a"]);
    expect(h.onCommit).toHaveBeenCalledOnce();
  });
});
