import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeCopiedTerminalText } from "../../../shared/terminal-control.ts";

describe("normalizeCopiedTerminalText", () => {
  it("collapses CR/LF variants to a single newline", () => {
    expect(normalizeCopiedTerminalText("a\r\nb\nc\rd")).toBe("a\nb\nc\nd");
    expect(normalizeCopiedTerminalText("a\n\rb")).toBe("a\nb");
  });

  it("keeps an intentional blank line, a trailing newline, and trailing spaces", () => {
    expect(normalizeCopiedTerminalText("a\n\nb\n")).toBe("a\n\nb\n");
    expect(normalizeCopiedTerminalText("hello  \nworld  ")).toBe("hello  \nworld  ");
  });
});

describe("terminal copy/paste wiring", () => {
  const ptyView = readFileSync(new URL("../../../src/pty-view.ts", import.meta.url), "utf8");
  const tui = readFileSync(new URL("../../../agent-core/tui/app.ts", import.meta.url), "utf8");

  it("copies through the normalizer and swallows the native xterm clipboard events", () => {
    expect(ptyView).toContain("normalizeCopiedTerminalText(this.term.getSelection())");
    expect(ptyView).toContain("addEventListener(\"copy\", this.onCopy, true)");
    expect(ptyView).toContain("addEventListener(\"paste\", this.onPaste, true)");
    expect(ptyView).toContain("if (this.disposed || this.pasteInFlight) return");
    expect(ptyView).toContain("event.stopImmediatePropagation()");
  });

  it("applies the same normalizer on TUI paste", () => {
    expect(tui).toContain("for (const ch of normalizeCopiedTerminalText(text))");
  });
});
