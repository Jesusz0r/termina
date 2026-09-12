import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for menu accelerator scoping (issue #68): while a
 * core TUI owns keyboard focus, the menu must not consume Ctrl+P (next
 * model) or Ctrl+R (history search) on Windows/Linux. The renderer reports
 * focus over `menu:terminal-focus`; main blanks those accelerators when
 * rebuilding the menu. Electron e2e covers the visible behavior; this probe
 * covers the no-steal wiring without a live display server.
 */
describe("Menu TUI scope invariants", () => {
  it("blanks TUI-owned accelerators only while a core terminal is focused", async () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../../../electron/preload.ts", import.meta.url), "utf8");
    const types = readFileSync(new URL("../../../shared/types.ts", import.meta.url), "utf8");
    const checks: string[] = [];
    function check(name: string, value: unknown) {
      assert.equal(Boolean(value), true, name);
      checks.push(name);
    }

    // Scope state starts unscoped: nothing has focus before the first report.
    check("scope flag defaults to unfocused",
      main.includes("private coreTerminalFocused = false;"));
    // The focus setter validates its input, rebuilds only on change, and is
    // reachable over a dedicated IPC channel behind the capability gate.
    check("focus setter rejects a non-boolean flag",
      main.includes('if (typeof raw !== "boolean") throw new Error("invalid terminal focus flag");'));
    check("focus setter rebuilds the menu only on change",
      main.includes("if (this.coreTerminalFocused === raw) return;")
      && main.includes("this.coreTerminalFocused = raw;\n    this.buildMenu();"));
    check("focus scope has a dedicated IPC channel",
      main.includes('ipcMain.handle("menu:terminal-focus", (_e, focused: unknown) => this.setCoreTerminalFocused(focused));'));
    // Every registry shortcut routes through the scoping helper, so a user
    // rebind onto Ctrl+P / Ctrl+R yields too — not just Quick Open.
    check("menu shortcuts route through the TUI scope helper",
      main.includes("const shortcut = (command: ShortcutCommand): string | undefined => this.tuiScopedAccelerator(this.shortcutMap[command] || undefined);"));
    check("scope helper resolves CmdOrCtrl per platform and blanks TUI chords",
      main.includes('const resolved = value.replace("CmdOrCtrl", process.platform === "darwin" ? "Cmd" : "Ctrl");')
      && main.includes("return isTuiOwnedShortcut(resolved) ? undefined : value;"));
    check("scope helper passes everything through while unfocused",
      main.includes("if (!value || !this.coreTerminalFocused) return value;"));
    // Reload keeps its role (menu clicks still reload) but yields its chord.
    check("Reload keeps its role behind the scope helper",
      main.includes('{ label: "Reload", accelerator: this.tuiScopedAccelerator("CmdOrCtrl+R"), role: "reload" },'));
    // Preload exposes the typed bridge method over the same channel.
    check("preload bridges terminal focus to main",
      preload.includes('setTerminalFocus: (focused: boolean) => ipcRenderer.invoke("menu:terminal-focus", focused),'));
    check("shared bridge type declares terminal focus",
      types.includes("setTerminalFocus(focused: boolean): Promise<void>;"));
    assert.ok(checks.length >= 9);
  });
});
