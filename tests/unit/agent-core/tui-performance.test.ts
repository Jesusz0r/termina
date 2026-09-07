import { describe, expect, it } from "vitest";
import { AgentTui } from "../../../agent-core/tui.ts";

function makeTui(): AgentTui {
  return new AgentTui({
    stdout: { write: () => true, columns: 120, rows: 40, isTTY: false },
    stdin: { isTTY: false },
    onSubmit: () => {},
    onInterrupt: () => {},
    onExit: () => {},
  });
}

function makeTuiRows(rows: number): AgentTui {
  return new AgentTui({
    stdout: { write: () => true, columns: 80, rows, isTTY: false },
    stdin: { isTTY: false },
    onSubmit: () => {},
    onInterrupt: () => {},
    onExit: () => {},
  });
}

describe("agent-core TUI picker highlight", () => {
  it("highlights the selected row including the last option, at any height", () => {
    for (const rows of [24, 12, 8]) {
      const tui = makeTuiRows(rows);
      tui.start();
      tui.setChoices("Approve bash?", [
        { name: "Deny", hint: "reject", submit: "/approve deny" },
        { name: "Approve once", hint: "run", submit: "/approve once" },
        { name: "Always approve", hint: "always", submit: "/approve always" },
      ]);
      // Arrow to the last row: Down, Down.
      tui.feed("\x1b[B");
      tui.feed("\x1b[B");
      const painted = tui.paintedFrame();
      const highlighted = painted.filter((row) => row.startsWith("\x1b[30;104m"));
      expect(highlighted.some((row) => row.includes("Always approve"))).toBe(true);
      // The title keeps its own highlight; the separator stays dim.
      expect(highlighted.some((row) => row.includes("termina"))).toBe(true);
      tui.stop();
    }
  });
});

describe("agent-core TUI streaming bounds", () => {
  it("scans markdown boundaries incrementally across a long active response", () => {
    const tui = makeTui();
    const line = "streamed response line with **markdown** and some text\n";

    for (let i = 0; i < 100; i++) {
      tui.appendAssistant(line);
      tui.frame();
    }
    const before = tui.markdownScannedChars;
    tui.appendAssistant("tail-only");
    const frame = tui.frame();
    const scanned = tui.markdownScannedChars - before;

    expect(frame).toContain("tail-only");
    expect(scanned).toBeGreaterThan(0);
    expect(scanned).toBeLessThanOrEqual("tail-only".length * 4);
  });

  it("keeps markdown rendering correct as fenced blocks stream", () => {
    const tui = makeTui();
    tui.appendAssistant("before\n```ts\nconst value = 1;");
    expect(tui.frame()).toContain("```ts");
    tui.appendAssistant("\n```\nafter\n");
    const frame = tui.frame();
    expect(frame).toContain("const value = 1;");
    expect(frame).toContain("after");
    expect(frame).not.toContain("```ts");
  });
});
