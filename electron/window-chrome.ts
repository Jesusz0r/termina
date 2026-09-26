/**
 * Window chrome for the single BrowserWindow.
 *
 * The frame owns close, minimize, and zoom. Overlay styles (`hidden`,
 * `hiddenInset`) paint those buttons on the page, so a narrow window lays
 * the project tabs under them. Every platform keeps the default title bar.
 *
 * Create/show options and the clipboard-only permission surface live here
 * so TerminaApp does not grow a second window manager.
 */
import type { ThemeId } from "../shared/types.js";

/** Native window fill for each ThemeId. */
export const APP_WINDOW_BACKGROUNDS: Record<ThemeId, string> = {
  dark: "#1e1e1e",
  light: "#f6f8fa",
  "high-contrast": "#000000",
  atom: "#282c34",
};

type AppWindowOptionsInput = {
  theme: ThemeId;
  hidden: boolean;
  preload: string;
};

type AppWindowOptions = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  title: string;
  backgroundColor: string;
  show?: false;
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
  return {
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Termina",
    backgroundColor: APP_WINDOW_BACKGROUNDS[input.theme],
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

type AppWindowSecurityTarget = {
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
