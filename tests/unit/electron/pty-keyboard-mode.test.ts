import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PtyKeyboardModeTracker } from "../../../electron/pty-keyboard-mode.ts";

describe("pty keyboard mode", () => {
  it("stays on legacy keys until the child enables modifier reporting", () => {
    const mode = new PtyKeyboardModeTracker();
    expect(mode.modifierReporting).toBe(false);
    mode.feed("\x1b[?1h");
    expect(mode.applicationCursor).toBe(true);
    expect(mode.modifierReporting).toBe(false);
    mode.feed("\x1b[?1l");
    expect(mode.applicationCursor).toBe(false);
  });

  it("tracks modifyOtherKeys and the kitty keyboard protocol", () => {
    const mode = new PtyKeyboardModeTracker();
    mode.feed("ready\x1b[>4;1m");
    expect(mode.modifierReporting).toBe(true);
    mode.feed("\x1b[>4;0m");
    expect(mode.modifierReporting).toBe(false);
    mode.feed("\x1b[>1u");
    expect(mode.modifierReporting).toBe(true);
    mode.feed("\x1b[<u");
    expect(mode.modifierReporting).toBe(false);
    mode.feed("\x1b[=1u");
    expect(mode.modifierReporting).toBe(true);
    mode.feed("\x1b[=0u");
    expect(mode.modifierReporting).toBe(false);
  });

  it("accepts a mode sequence split across chunks", () => {
    const mode = new PtyKeyboardModeTracker();
    mode.feed("\x1b[>4;");
    expect(mode.modifierReporting).toBe(false);
    mode.feed("2m");
    expect(mode.modifierReporting).toBe(true);
  });

  it("pushes the tracked mode to the renderer that encodes keys", () => {
    const instance = readFileSync(new URL("../../../electron/terminal-instance.ts", import.meta.url), "utf8");
    const runtime = readFileSync(new URL("../../../electron/terminal-runtime.ts", import.meta.url), "utf8");
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
    expect(instance).toContain("this.keyboardMode.feed(data)");
    expect(runtime).toContain("this.host.onPtyKeyboardMode?.(id, terminalGeneration)");
    expect(main).toContain("modifierReporting: inst.modifierReporting");
    expect(main).toContain("applicationCursor: inst.applicationCursor");
    expect(renderer).toContain("pane.view.setKeyboardMode({ modifierReporting, applicationCursor })");
  });
});