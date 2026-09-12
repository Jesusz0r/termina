import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  attachMacTitlebarReclaim,
  MAC_TRAFFIC_LIGHTS,
  macWindowChrome,
  type MacTitlebarWindow,
} from "../../../electron/window-chrome.ts";

function fakeWindow(bounds = { x: 10, y: 20, width: 800, height: 600 }): MacTitlebarWindow & {
  buttons: boolean | null;
  sizes: number[];
  handlers: Record<string, () => void>;
} {
  const handlers: Record<string, () => void> = {};
  let current = { ...bounds };
  const sizes: number[] = [];
  return {
    buttons: null as boolean | null,
    sizes,
    handlers,
    isDestroyed: () => false,
    getBounds: () => ({ ...current }),
    setBounds: (next) => {
      current = { ...next };
      sizes.push(next.height);
    },
    setWindowButtonVisibility(visible) {
      this.buttons = visible;
    },
    on(event, listener) {
      handlers[event] = listener;
    },
  };
}

describe("mac window chrome", () => {
  it("uses a full-size hidden title bar only on darwin", () => {
    expect(macWindowChrome("darwin")).toEqual({
      titleBarStyle: "hidden",
      trafficLightPosition: { ...MAC_TRAFFIC_LIGHTS },
    });
    expect(macWindowChrome("win32")).toEqual({});
    expect(macWindowChrome("linux")).toEqual({});
  });

  it("ignores titlebar reclaim on non-mac platforms", () => {
    const win = fakeWindow();
    attachMacTitlebarReclaim(win, "linux");
    expect(win.handlers).toEqual({});
  });

  it("hides window buttons in fullscreen and nudges bounds on leave so contents reclaim height", () => {
    const win = fakeWindow();
    attachMacTitlebarReclaim(win, "darwin");
    win.handlers["enter-full-screen"]();
    expect(win.buttons).toBe(false);
    win.handlers["leave-full-screen"]();
    expect(win.buttons).toBe(true);
    expect(win.sizes).toEqual([601, 600]);
  });

  it("wires the chrome helper from the BrowserWindow constructor", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    expect(main.includes("...macWindowChrome(process.platform)")).toBe(true);
    expect(main.includes("attachMacTitlebarReclaim(win, process.platform)")).toBe(true);
    expect(main.includes("titleBarStyle: \"hiddenInset\"")).toBe(false);
  });
});
