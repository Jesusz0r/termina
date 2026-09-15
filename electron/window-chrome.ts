/**
 * macOS window chrome for the single BrowserWindow.
 *
 * `hiddenInset` installs a native toolbar so the traffic lights can sit
 * inset. On recent macOS that toolbar stays reserved (a dead strip at the
 * top) and only paints when hovered — the web contents never get the space
 * back. `hidden` is full-size content; the same buttons sit on #project-bar
 * via trafficLightPosition. Windows/Linux keep the default framed title bar
 * (`hidden` would strip their window controls).
 *
 * Create/show options and the clipboard-only permission surface live here
 * so TerminaApp does not grow a second window manager.
 */
import type { ThemeId } from "../shared/types.js";

export type MacWindowChrome = {
  titleBarStyle: "hidden";
  trafficLightPosition: { x: number; y: number };
};

/** Traffic lights sit in the 36px project bar (12px inset, ~14px buttons). */
export const MAC_TRAFFIC_LIGHTS = { x: 12, y: 12 } as const;

export function macWindowChrome(platform: NodeJS.Platform): MacWindowChrome | Record<string, never> {
  if (platform !== "darwin") return {};
  return {
    titleBarStyle: "hidden",
    trafficLightPosition: { ...MAC_TRAFFIC_LIGHTS },
  };
}

export type MacTitlebarWindow = {
  isDestroyed(): boolean;
  getBounds(): { x: number; y: number; width: number; height: number };
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setWindowButtonVisibility(visible: boolean): void;
  on(event: "enter-full-screen" | "leave-full-screen", listener: () => void): void;
};

/**
 * Native fullscreen still slides the macOS menu bar in on hover. AppKit
 * shrinks the content view for it and often never grows it back. Hide the
 * window buttons in fullscreen (the overlay titlebar is what steals the
 * strip) and nudge bounds on leave so the web contents reclaim the height.
 */
export function attachMacTitlebarReclaim(win: MacTitlebarWindow, platform: NodeJS.Platform = "darwin"): void {
  if (platform !== "darwin") return;
  const reclaim = (): void => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    win.setBounds({ ...bounds, height: bounds.height + 1 });
    win.setBounds(bounds);
  };
  win.on("enter-full-screen", () => {
    if (win.isDestroyed()) return;
    win.setWindowButtonVisibility(false);
  });
  win.on("leave-full-screen", () => {
    if (win.isDestroyed()) return;
    win.setWindowButtonVisibility(true);
    reclaim();
  });
}

/** Native window fill for each ThemeId. */
export const APP_WINDOW_BACKGROUNDS: Record<ThemeId, string> = {
  dark: "#1e1e1e",
  light: "#f6f8fa",
  "high-contrast": "#000000",
  atom: "#282c34",
};

export type AppWindowOptionsInput = {
  theme: ThemeId;
  hidden: boolean;
  preload: string;
  platform?: NodeJS.Platform;
};

export type AppWindowOptions = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  title: string;
  backgroundColor: string;
  show?: false;
  titleBarStyle?: "hidden";
  trafficLightPosition?: { x: number; y: number };
  webPreferences: {
    preload: string;
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
    backgroundThrottling?: false;
  };
};

/** Constructor options for the one app BrowserWindow, including mac chrome. */
export function appWindowOptions(input: AppWindowOptionsInput): AppWindowOptions {
  const platform = input.platform ?? process.platform;
  return {
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Termina",
    backgroundColor: APP_WINDOW_BACKGROUNDS[input.theme],
    ...macWindowChrome(platform),
    ...(input.hidden ? { show: false } : {}),
    webPreferences: {
      preload: input.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(input.hidden ? { backgroundThrottling: false } : {}),
    },
  };
}

export function isRendererClipboardPermission(permission: string): boolean {
  return permission === "clipboard-read" || permission === "clipboard-sanitized-write";
}

export function denyRendererWindowOpen(): { action: "deny" } {
  return { action: "deny" };
}

export type AppWindowSecurityTarget = {
  webContents: {
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    session: {
      setPermissionRequestHandler(
        handler: (
          webContents: unknown,
          permission: string,
          callback: (allow: boolean) => void,
        ) => void,
      ): void;
      setPermissionCheckHandler(
        handler: (webContents: unknown, permission: string) => boolean,
      ): void;
    };
  };
};

/** Deny window.open and every web permission except the DOM clipboard. */
export function attachAppWindowSecurity(win: AppWindowSecurityTarget): void {
  win.webContents.setWindowOpenHandler(denyRendererWindowOpen);
  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) =>
    callback(isRendererClipboardPermission(permission)),
  );
  win.webContents.session.setPermissionCheckHandler((_webContents, permission) =>
    isRendererClipboardPermission(permission),
  );
}
