import { describe, expect, it } from "vitest";

import { AgentTui } from "../../../agent-core/tui.ts";
import { graphemeSafeTail } from "../../../agent-core/tui/layout.ts";
import { closeSanitize, freshSanitizer } from "../../../agent-core/tui/transcript.ts";
import { cellWidth, isWideCode } from "../../../agent-core/tui-text.ts";

function makeTui() {
  const submitted: string[] = [];
  const tui = new AgentTui({
    stdout: { write: () => true, columns: 120, rows: 40, isTTY: false },
    stdin: { isTTY: false },
    onSubmit: (line) => submitted.push(line),
    onInterrupt: () => {},
    onExit: () => {},
  });
  return { tui, submitted };
}

describe("TUI text hardening (#227)", () => {
  it("consumes charset-selection escapes without leaking the designator", () => {
    expect(closeSanitize("a\x1b(Bb", freshSanitizer())).toBe("ab");
    expect(closeSanitize("a\x1b)0b", freshSanitizer())).toBe("ab");
    expect(closeSanitize("a\x1b#8b", freshSanitizer())).toBe("ab");
    expect(closeSanitize("a\x1b%Gb", freshSanitizer())).toBe("ab");
  });

  it("swallows SOS/PM/APC string content like OSC/DCS", () => {
    expect(closeSanitize("a\x1bXsecret\x1b\\b", freshSanitizer())).toBe("ab");
    expect(closeSanitize("a\x1b^secret\x07b", freshSanitizer())).toBe("ab");
    expect(closeSanitize("a\x1b_secret\x1b\\b", freshSanitizer())).toBe("ab");
  });

  it("still consumes plain two-character escapes and CSI", () => {
    expect(closeSanitize("a\x1bMb", freshSanitizer())).toBe("ab");
    expect(closeSanitize("a\x1b[31mb\x1b[0m", freshSanitizer())).toBe("ab");
  });

  it("measures zero-width and wide code points per rendering", () => {
    expect(cellWidth("a\u200Bb")).toBe(2);
    expect(cellWidth("a\u200Cb")).toBe(2);
    expect(isWideCode(0x20000)).toBe(true);
    expect(isWideCode(0x2ceaf)).toBe(true);
    expect(isWideCode(0x17000)).toBe(true);
    expect(isWideCode(0x187ff)).toBe(true);
    expect(isWideCode(0x4e00)).toBe(true);
    expect(isWideCode(0x0041)).toBe(false);
    expect(cellWidth("中")).toBe(2);
  });

  it("never splits ZWJ or regional-indicator clusters at a tail cut", () => {
    // Flag split between indicators: the orphaned half is dropped.
    expect(graphemeSafeTail("012345🇫🇷ab", 4)).toBe("ab");
    // ZWJ split: the orphaned join is dropped, the partner kept.
    expect(graphemeSafeTail("01234👨\u200D👩ab", 5)).toBe("👩ab");
    // Clean boundaries keep whole clusters.
    expect(graphemeSafeTail("012345🇫🇷", 4)).toBe("🇫🇷");
    expect(graphemeSafeTail("plain-ascii-tail", 4)).toBe("tail");
  });

  it("drops escape-only chunks instead of opening blank entries", () => {
    const withEscape = makeTui();
    withEscape.tui.appendPlain("A");
    withEscape.tui.appendPlain("[31m");
    withEscape.tui.appendPlain("B");
    const plain = makeTui();
    plain.tui.appendPlain("A");
    plain.tui.appendPlain("B");
    expect(withEscape.tui.frame()).toBe(plain.tui.frame());
  });
});

describe("TUI app hardening (#227)", () => {
  it("leaves the cursor alone when Tab completes nothing", () => {
    const { tui, submitted } = makeTui();
    tui.feed("ab");
    tui.feed("");
    tui.feed("\t");
    tui.feed("!");
    tui.feed("\r");
    expect(submitted).toEqual(["!ab"]);
  });

  it("restores cooked mode when start fails after setRawMode", () => {
    const rawModes: boolean[] = [];
    const tui = new AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: {
        isTTY: true,
        setRawMode: (value: boolean) => {
          rawModes.push(value);
        },
        resume: () => {
          throw new Error("resume failed");
        },
      },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    expect(tui.start()).toBe(false);
    expect(rawModes).toEqual([true, false]);
  });

  it("scrolls over-tall drafts to keep the cursor row visible", () => {
    const { tui } = makeTui();
    const rows = Array.from({ length: 60 }, (_, i) => `L${String(i).padStart(2, "0")}`);
    tui.setDraft(rows.join("\n"));
    const frame = tui.frame();
    expect(frame).toContain("L59");
    expect(frame).not.toContain("L00");
  });

  it("amortizes scrollback markdown parsing across pages", () => {
    const { tui } = makeTui();
    const chunk = "line of text with **bold** and `code` and more words here\n";
    const big = chunk.repeat(Math.ceil((380 * 1024) / chunk.length));
    tui.appendAssistant(big);
    const before = tui.markdownScannedChars;
    for (let i = 0; i < 274; i++) {
      tui.feed("[5~");
      tui.frame();
    }
    // Pre-fix this re-parsed ~40M chars; the cached prefix bounds it near the entry size.
    expect(tui.markdownScannedChars - before).toBeLessThan(5 * 1024 * 1024);
  }, 120_000);
});
