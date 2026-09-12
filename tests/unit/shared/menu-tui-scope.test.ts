import { describe, it, expect } from "vitest";
import {
  COMMAND_DEFINITIONS,
  QUICK_OPEN_TERMINAL_NOTE,
  isTuiOwnedShortcut,
} from "../../../shared/commands.ts";
import { TUI_SHORTCUTS } from "../../../agent-core/tui-text.ts";
import { paletteRowDetail } from "../../../src/quick-open.ts";

/**
 * Menu accelerator scoping for the core TUI (issue #68): a focused core
 * terminal owns Ctrl+P (next model) and Ctrl+R (history search). The menu
 * blanks those accelerators and the renderer lets them fall through to the
 * pty, so /help no longer lies on Windows/Linux. These are the pure,
 * importable pieces; electron/main.ts and src/main.ts wiring is probed in
 * tests/unit/electron/menu-tui-scope.test.ts and tests/unit/ui/.
 */
describe("isTuiOwnedShortcut", () => {
  it("owns the resolved Ctrl+P and Ctrl+R chords", () => {
    expect(isTuiOwnedShortcut("Ctrl+P")).toBe(true);
    expect(isTuiOwnedShortcut("Ctrl+R")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isTuiOwnedShortcut("ctrl+p")).toBe(true);
    expect(isTuiOwnedShortcut("CTRL+R")).toBe(true);
  });

  it("yields every other chord to the menu", () => {
    for (const chord of ["Cmd+P", "Cmd+R", "Ctrl+Shift+P", "Ctrl+Q", "Ctrl+L", "F5", "Ctrl+Tab", ""]) {
      expect(isTuiOwnedShortcut(chord)).toBe(false);
    }
  });

  it("covers the platform-resolved defaults: CmdOrCtrl is Ctrl off macOS, Cmd on it", () => {
    const resolve = (value: string, isMac: boolean): string =>
      value.replace("CmdOrCtrl", isMac ? "Cmd" : "Ctrl");
    expect(isTuiOwnedShortcut(resolve("CmdOrCtrl+P", false))).toBe(true);
    expect(isTuiOwnedShortcut(resolve("CmdOrCtrl+R", false))).toBe(true);
    expect(isTuiOwnedShortcut(resolve("CmdOrCtrl+P", true))).toBe(false);
    expect(isTuiOwnedShortcut(resolve("CmdOrCtrl+R", true))).toBe(false);
  });
});

describe("quick open split documentation", () => {
  it("shares one terminal note between settings and the palette", () => {
    expect(QUICK_OPEN_TERMINAL_NOTE).toContain("core terminal");
    expect(QUICK_OPEN_TERMINAL_NOTE).toContain("Ctrl+P");
    expect(QUICK_OPEN_TERMINAL_NOTE).toContain("cycles models");
  });

  it("carries the split in the registry description", () => {
    const quickOpen = COMMAND_DEFINITIONS.find((d) => d.command === "quick-open");
    expect(quickOpen?.description).toContain("Open a project file by name");
    expect(quickOpen?.description).toContain(QUICK_OPEN_TERMINAL_NOTE);
  });
});

describe("palette row detail", () => {
  it("appends the terminal split to quick open only", () => {
    expect(paletteRowDetail("quick-open", "View", "CmdOrCtrl+P")).toBe(
      `View · CmdOrCtrl+P · ${QUICK_OPEN_TERMINAL_NOTE}`,
    );
    expect(paletteRowDetail("command-palette", "View", "CmdOrCtrl+K")).toBe("View · CmdOrCtrl+K");
  });

  it("keeps the split when the shortcut is unset", () => {
    expect(paletteRowDetail("quick-open", "View", "")).toBe(`View · ${QUICK_OPEN_TERMINAL_NOTE}`);
    expect(paletteRowDetail("refresh", "File", "")).toBe("File");
  });
});

describe("/help model chord", () => {
  it("prefers Ctrl+L as the one advertised model chord", () => {
    const names = TUI_SHORTCUTS.map((row) => row.name);
    expect(names).toContain("Ctrl+L");
    expect(names).not.toContain("Ctrl+P");
  });

  it("keeps the history-search row the menu now yields", () => {
    expect(TUI_SHORTCUTS).toContainEqual({ name: "Ctrl+R", hint: "session · search prompt history" });
  });
});
