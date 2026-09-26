import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  APP_WINDOW_BACKGROUNDS,
  appWindowOptions,
  attachAppWindowSecurity,
  denyRendererWindowOpen,
  isRendererClipboardPermission,
} from "../../../electron/window-chrome.ts";

describe("window chrome", () => {
  it("keeps the framed title bar so window buttons are not painted on the page", () => {
    const shown = appWindowOptions({ theme: "dark", hidden: false, preload: "/p.js" });
    expect(shown).toMatchObject({
      title: "Termina",
      backgroundColor: APP_WINDOW_BACKGROUNDS.dark,
      webPreferences: {
        preload: "/p.js",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    expect(shown).not.toHaveProperty("titleBarStyle");
    expect(shown).not.toHaveProperty("trafficLightPosition");
    expect(shown.show).toBeUndefined();
    expect(shown.webPreferences.backgroundThrottling).toBeUndefined();

    const hidden = appWindowOptions({ theme: "light", hidden: true, preload: "/p.js" });
    expect(hidden.show).toBe(false);
    expect(hidden.webPreferences.backgroundThrottling).toBe(false);
    expect(hidden).not.toHaveProperty("titleBarStyle");
    expect(hidden.backgroundColor).toBe(APP_WINDOW_BACKGROUNDS.light);
  });

  it("denies every web permission except the DOM clipboard and every window.open", () => {
    expect(isRendererClipboardPermission("clipboard-read")).toBe(true);
    expect(isRendererClipboardPermission("clipboard-sanitized-write")).toBe(true);
    expect(isRendererClipboardPermission("notifications")).toBe(false);
    expect(denyRendererWindowOpen()).toEqual({ action: "deny" });

    const requests: boolean[] = [];
    const checks: boolean[] = [];
    let openAction: { action: "deny" } | undefined;
    attachAppWindowSecurity({
      webContents: {
        setWindowOpenHandler(handler) {
          openAction = handler();
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
    expect(openAction).toEqual({ action: "deny" });
    expect(requests).toEqual([true, false]);
    expect(checks).toEqual([true, false]);
  });

  it("wires the window owner from createWindow", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    expect(main.includes("appWindowOptions(")).toBe(true);
    expect(main.includes("attachAppWindowSecurity(win)")).toBe(true);
    expect(main.includes("titleBarStyle")).toBe(false);
  });
});
