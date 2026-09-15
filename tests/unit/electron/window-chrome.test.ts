import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  APP_WINDOW_BACKGROUNDS,
  appWindowOptions,
  attachAppWindowSecurity,
  attachMacTitlebarReclaim,
  denyRendererWindowOpen,
  isRendererClipboardPermission,
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

  it("builds BrowserWindow options with chrome, sandbox, and e2e hide", () => {
    const shown = appWindowOptions({ theme: "dark", hidden: false, preload: "/p.js", platform: "darwin" });
    expect(shown).toMatchObject({
      title: "Termina",
      backgroundColor: APP_WINDOW_BACKGROUNDS.dark,
      titleBarStyle: "hidden",
      trafficLightPosition: { ...MAC_TRAFFIC_LIGHTS },
      webPreferences: {
        preload: "/p.js",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    expect(shown.show).toBeUndefined();
    expect(shown.webPreferences.backgroundThrottling).toBeUndefined();

    const hidden = appWindowOptions({ theme: "light", hidden: true, preload: "/p.js", platform: "linux" });
    expect(hidden.show).toBe(false);
    expect(hidden.webPreferences.backgroundThrottling).toBe(false);
    expect(hidden.titleBarStyle).toBeUndefined();
    expect(hidden.backgroundColor).toBe(APP_WINDOW_BACKGROUNDS.light);
  });

  it("denies every web permission except the DOM clipboard and every window.open", () => {
    expect(isRendererClipboardPermission("clipboard-read")).toBe(true);
    expect(isRendererClipboardPermission("clipboard-sanitized-write")).toBe(true);
    expect(isRendererClipboardPermission("notifications")).toBe(false);
    expect(denyRendererWindowOpen()).toEqual({ action: "deny" });

    const requests: boolean[] = [];
    const checks: boolean[] = [];
    let openHandler: (() => { action: "deny" }) | null = null;
    attachAppWindowSecurity({
      webContents: {
        setWindowOpenHandler(handler) {
          openHandler = handler;
        },
        session: {
          setPermissionRequestHandler(handler) {
            handler({}, "clipboard-read", (allow) => requests.push(allow));
            handler({}, "media", (allow) => requests.push(allow));
          },
          setPermissionCheckHandler(handler) {
            checks.push(handler({}, "clipboard-sanitized-write"));
            checks.push(handler({}, "geolocation"));
          },
        },
      },
    });
    expect(openHandler?.()).toEqual({ action: "deny" });
    expect(requests).toEqual([true, false]);
    expect(checks).toEqual([true, false]);
  });

  it("wires the window owner from createWindow", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    expect(main.includes("appWindowOptions(")).toBe(true);
    expect(main.includes("attachMacTitlebarReclaim(win, process.platform)")).toBe(true);
    expect(main.includes("attachAppWindowSecurity(win)")).toBe(true);
    expect(main.includes("titleBarStyle: \"hiddenInset\"")).toBe(false);
  });
});
