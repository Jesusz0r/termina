import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { installFakeDom, type FakeDocument, type FakeEl } from "./fake-dom.ts";

type Modals = typeof import("../../../src/components/modals.ts");

const settingsSrc = readFileSync(new URL("../../../src/settings.ts", import.meta.url), "utf8");
const keyboardSrc = readFileSync(new URL("../../../src/components/explorer-keyboard.ts", import.meta.url), "utf8");
const explorerSrc = readFileSync(new URL("../../../src/components/explorer.ts", import.meta.url), "utf8");
const filterSrc = readFileSync(new URL("../../../src/components/explorer-filter.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../../../src/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../src/styles.css", import.meta.url), "utf8");

let modals: Modals;
let fake: { document: FakeDocument; modalRoot: FakeEl; cleanup: () => void };

beforeAll(async () => {
  fake = installFakeDom();
  modals = await import("../../../src/components/modals.ts");
});

beforeEach(() => {
  fake.modalRoot.replaceChildren();
  for (const container of fake.document.body.querySelectorAll(".toast-container")) container.remove();
});

afterAll(() => {
  fake.cleanup();
});

describe("renderer UI hardening batch (refs #204)", () => {
  it("stacks rapid toasts in a flex column container", () => {
    vi.useFakeTimers();
    try {
      modals.toast("first", "info");
      modals.toast("second", "error");
      const containers = fake.document.body.querySelectorAll(".toast-container");
      expect(containers).toHaveLength(1);
      const toasts = containers[0].querySelectorAll(".toast");
      expect(toasts).toHaveLength(2);
      expect(toasts[0].textContent).toBe("first");
      expect(toasts[1].textContent).toBe("second");
      expect(toasts[1].classList.contains("toast-error")).toBe(true);
      // Toasts still dismiss themselves.
      vi.advanceTimersByTime(5000);
      expect(containers[0].querySelectorAll(".toast")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lays the toast container out as a bottom-right column", () => {
    expect(css).toMatch(/\.toast-container\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/\.toast-container\s*\{[^}]*bottom:\s*64px/);
    // The slot moved to the container; individual toasts are static children.
    const toastBlock = /\.toast\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(toastBlock).not.toContain("position: fixed");
  });

  it("builds settings rows with textContent, never innerHTML", () => {
    expect(settingsSrc).not.toContain("innerHTML");
    expect(settingsSrc).toContain("strong.textContent = title");
    expect(settingsSrc).toContain("label.textContent = theme.label");
  });

  it("documents the explorer keystroke scan honestly instead of claiming O(1)", () => {
    expect(keyboardSrc).not.toContain("does two DOM writes instead of re-scanning every row");
    expect(keyboardSrc.replace(/\s*\n\s*\*\s*/g, " ")).toContain("not O(1) end to end");
    expect(keyboardSrc).toContain("visibleRows");
    expect(keyboardSrc).toContain("0.017 ms/keystroke");
  });

  it("scopes connect-src websockets to local Vite HMR", () => {
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csp).toContain("connect-src");
    const connect = /connect-src ([^;]+);/.exec(csp)?.[1].split(/\s+/) ?? [];
    expect(connect).toContain("ws://localhost:*");
    expect(connect).toContain("http://localhost:*");
    expect(connect).not.toContain("ws:");
  });

  it("guards listDir entry shapes before mapping rows", () => {
    expect(explorerSrc).toContain("function isExplorerEntry(value: unknown): value is ExplorerEntry");
    expect(explorerSrc).toContain("Array.isArray(res.entries) ? res.entries.filter(isExplorerEntry) : null");
    expect(explorerSrc).toContain("could not list ${entry.name}: unexpected response");
    expect(explorerSrc).toContain("for (const child of entries)");
    // The filter path was already safe: its map sits inside try/catch.
    expect(filterSrc).toContain("leaves the tree unfiltered rather than empty");
  });

  describe("modal focus trap", () => {
    function openConfirm(): FakeEl[] {
      void modals.showConfirm("Title", "message");
      const backdrop = fake.modalRoot.querySelectorAll(".modal-backdrop").at(-1)!;
      return backdrop.querySelectorAll("button");
    }

    it("wraps Tab from the last button to the first", () => {
      const buttons = openConfirm();
      expect(buttons).toHaveLength(2);
      buttons[1].focus();
      const event = fake.document.dispatch("keydown", { key: "Tab", shiftKey: false, target: buttons[1] });
      expect(event.defaultPrevented).toBe(true);
      expect(fake.document.activeElement).toBe(buttons[0]);
    });

    it("wraps Shift+Tab from the first button to the last", () => {
      const buttons = openConfirm();
      buttons[0].focus();
      const event = fake.document.dispatch("keydown", { key: "Tab", shiftKey: true, target: buttons[0] });
      expect(event.defaultPrevented).toBe(true);
      expect(fake.document.activeElement).toBe(buttons[1]);
    });

    it("leaves mid-modal Tab and background keystrokes alone", () => {
      const buttons = openConfirm();
      buttons[0].focus();
      const forward = fake.document.dispatch("keydown", { key: "Tab", shiftKey: false, target: buttons[0] });
      expect(forward.defaultPrevented).toBe(false);
      expect(fake.document.activeElement).toBe(buttons[0]);
      // A Tab outside every backdrop is a background surface's own key.
      const background = fake.document.createElement("div");
      const outside = fake.document.dispatch("keydown", { key: "Tab", shiftKey: false, target: background });
      expect(outside.defaultPrevented).toBe(false);
    });

    it("traps within the topmost backdrop when modals nest", () => {
      const first = openConfirm();
      const second = openConfirm();
      second[1].focus();
      fake.document.dispatch("keydown", { key: "Tab", shiftKey: false, target: second[1] });
      expect(fake.document.activeElement).toBe(second[0]);
      expect(fake.document.activeElement).not.toBe(first[0]);
    });

    it("includes the showInput textbox in the Tab cycle", () => {
      void modals.showInput("New file", "name", "");
      const backdrop = fake.modalRoot.querySelectorAll(".modal-backdrop").at(-1)!;
      const order = backdrop.querySelectorAll("button, input");
      expect(order.map((el) => el.tagName.toLowerCase())).toEqual(["input", "button", "button"]);
      order[2].focus();
      fake.document.dispatch("keydown", { key: "Tab", shiftKey: false, target: order[2] });
      expect(fake.document.activeElement).toBe(order[0]);
    });
  });
});
