import { describe, expect, it } from "vitest";

import { AgentTui } from "../../../agent-core/tui.ts";

const SECRET = "sk-secret-key-value-T12";

function makeTui() {
  const submitted: string[] = [];
  const tui = new AgentTui({
    stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
    stdin: { isTTY: false },
    onSubmit: (line) => submitted.push(line),
    onInterrupt: () => {},
    onExit: () => {},
  });
  return { tui, submitted };
}

describe("TUI secret input (refs #212)", () => {
  it("masks a secret while typing, echoes a placeholder, and skips history recall", () => {
    const { tui, submitted } = makeTui();
    tui.feed("hello\r");
    tui.setRawInput(true, { secret: true });
    tui.feed(SECRET);
    expect(tui.frame()).not.toContain(SECRET);
    expect(tui.frame()).toContain("•".repeat(SECRET.length));
    tui.feed("\r");
    expect(submitted).toEqual(["hello", SECRET]);
    expect(tui.frame()).not.toContain(SECRET);
    expect(tui.frame()).toContain("********");
    tui.setRawInput(false);
    tui.feed("\x1b[A\r");
    expect(submitted.at(-1)).toBe("hello");
    expect(submitted.filter((line) => line === SECRET)).toHaveLength(1);
    expect(tui.frame()).not.toContain(SECRET);
  });

  it("still echoes and recalls non-secret raw input", () => {
    const { tui, submitted } = makeTui();
    tui.setRawInput(true);
    tui.feed("visible-line\r");
    expect(submitted).toEqual(["visible-line"]);
    expect(tui.frame()).toContain("> visible-line");
    tui.setRawInput(false);
    tui.feed("\x1b[A\r");
    expect(submitted.at(-1)).toBe("visible-line");
  });
});
