import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for the renderer half of menu accelerator scoping
 * (issue #68): the renderer reports core-terminal focus to main and lets
 * the TUI-owned chords fall through to the pty instead of running their
 * bound command. Electron e2e covers the visible behavior; this probe
 * covers the focus wiring without a live display server.
 */
describe("Renderer TUI scope invariants", () => {
  it("reports core-terminal focus and yields its chords to the pty", async () => {
    const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
    const palette = readFileSync(new URL("../../../src/quick-open.ts", import.meta.url), "utf8");
    const checks: string[] = [];
    function check(name: string, value: unknown) {
      assert.equal(Boolean(value), true, name);
      checks.push(name);
    }

    // Focus means the active pane is a live core TUI whose textarea owns DOM focus.
    check("focus requires a live core pane behind the focused textarea",
      renderer.includes("if (!pane || pane.error || pane.exited || pane.engine !== \"core\") return false;")
      && renderer.includes("return !!textarea && document.activeElement === textarea;"));
    // Scope pushes to main on every focus transition, but only on change.
    check("focus transitions sync scope to main",
      renderer.includes('document.addEventListener("focusin", syncTerminalFocusScope);')
      && renderer.includes('document.addEventListener("focusout", syncTerminalFocusScope);'));
    check("scope reports to main only on change",
      renderer.includes("if (focused === lastReportedTerminalFocus) return;")
      && renderer.includes("void window.termina.setTerminalFocus(focused).catch(() => undefined);"));
    // An exited TUI un-scopes: its chords run their bound commands again.
    check("exited panes release the scope",
      renderer.includes("pane.exited = true;\n    // The TUI is gone: un-scope the menu")
      && renderer.includes("syncTerminalFocusScope();"));
    // The renderer keydown fallback yields TUI chords before resolving a command.
    check("keydown yields TUI chords to the pty while a core terminal is focused",
      renderer.includes("if (isTuiOwnedShortcut(target) && isCoreTerminalFocused()) return;"));
    const skipAt = renderer.indexOf("if (isTuiOwnedShortcut(target) && isCoreTerminalFocused()) return;");
    const resolveAt = renderer.indexOf("const entries = Object.entries(preferences.shortcuts)");
    check("the yield runs before shortcut resolution", skipAt > 0 && resolveAt > 0 && skipAt < resolveAt);
    // The palette documents the split on the quick-open row.
    check("palette rows render through the split-aware detail helper",
      palette.includes("detail: paletteRowDetail(d.command as CommandId, d.category, shortcut)"));
    assert.ok(checks.length >= 7);
  });
});
