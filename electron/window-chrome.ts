/**
 * macOS window chrome for the single BrowserWindow.
 *
 * `hiddenInset` installs a native toolbar so the traffic lights can sit
 * inset. On recent macOS that toolbar stays reserved (a dead strip at the
 * top) and only paints when hovered — the web contents never get the space
 * back. `hidden` is full-size content; the same buttons sit on #project-bar
 * via trafficLightPosition. Windows/Linux keep the default framed title bar
 * (`hidden` would strip their window controls).
 */

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
