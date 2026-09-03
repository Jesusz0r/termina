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
