import { describe, expect, it } from "vitest";

import { AgentTui } from "../../../agent-core/tui.ts";
import { boxContentRow, clip, graphemeSafeTail, paintBoxContentRow, paintHighlightRow, paintRow, wrapSpans } from "../../../agent-core/tui/layout.ts";
import { closeSanitize, freshSanitizer, parseMarkdown } from "../../../agent-core/tui/transcript.ts";
import { cellWidth, isWideCode, wrapText } from "../../../agent-core/tui-text.ts";

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
    expect(isWideCode(0x2ceb0)).toBe(true);
    expect(isWideCode(0x2ebe0)).toBe(true);
    expect(isWideCode(0x17000)).toBe(true);
    expect(isWideCode(0x187ff)).toBe(true);
    expect(isWideCode(0x4e00)).toBe(true);
    expect(isWideCode(0x0041)).toBe(false);
    expect(cellWidth("\u4e2d")).toBe(2);
  });

  it("never splits ZWJ or regional-indicator clusters at a tail cut", () => {
    // Flag split between indicators: the orphaned half is dropped.
    expect(graphemeSafeTail("012345\u{1F1EB}\u{1F1F7}ab", 4)).toBe("ab");
    // ZWJ split: the orphaned join is dropped, the partner kept.
    expect(graphemeSafeTail("01234\u{1F468}\u200D\u{1F469}ab", 5)).toBe("\u{1F469}ab");
    // Clean boundaries keep whole clusters.
    expect(graphemeSafeTail("012345\u{1F1EB}\u{1F1F7}", 4)).toBe("\u{1F1EB}\u{1F1F7}");
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

describe("TUI content rows do not write copy-padding spaces", () => {
  it("clips without padding and keeps box content snug", () => {
    expect(clip("hello", 80)).toBe("hello");
    expect(clip("hello world", 5)).toBe("hello");
    expect(boxContentRow("> hi", 20)).toBe("\u2502 > hi \u2502");
    expect(cellWidth(boxContentRow("> hi", 20))).toBeLessThan(20);
  });

  it("paints plain rows unpadded and tool rows with EL fill, not spaces", () => {
    const plain = paintRow([{ text: "ok", style: 0 }], 8, { kind: "plain" } as never, 2);
    expect(plain).toContain("ok");
    expect(plain).not.toContain("ok ");
    const tool = paintRow([{ text: "ls", style: 0 }], 8, { kind: "tool", toolState: "success" } as never, 2);
    expect(tool).toContain("ls");
    expect(tool).toContain("\x1b[K");
    expect(tool).not.toContain("ls ");
  });

  it("places the composer right border with CHA instead of space fill", () => {
    const painted = paintBoxContentRow("> hi", 20);
    expect(painted).toContain("\u2502 > hi");
    expect(painted).toContain("\x1b[20G\u2502");
    expect(painted).not.toMatch(/hi +?/);
  });

  it("fills a highlight row with EL 0 instead of trailing spaces", () => {
    const painted = paintHighlightRow("title", 20, "\x1b[30;104m");
    expect(painted).toContain("title\x1b[K");
    expect(painted).not.toContain("title ");
  });

  it("keeps a short transcript line short in the frame", () => {
    const { tui } = makeTui();
    tui.appendPlain("hello");
    expect(tui.frame().split("\n")).toContain("hello");
  });
});

describe("TUI scroll stays put while the user is reading", () => {
  const ANCHOR = "KEEP-ME unique-scroll-anchor";
  const LIVE = "LIVE-MARKER-SHOULD-STAY-OFFSCREEN";

  function scrollProbe(tui: AgentTui): { scroll: number; follow: boolean } {
    return tui as unknown as { scroll: number; follow: boolean };
  }

  function fillTranscript(tui: AgentTui): void {
    tui.appendPlain(`${ANCHOR}\n`);
    tui.appendAssistant("history-filler-line\n".repeat(80));
  }

  function pageToAnchor(tui: AgentTui): void {
    expect(tui.frame()).not.toContain(ANCHOR);
    let found = false;
    for (let i = 0; i < 40; i++) {
      tui.feed("\x1b[5~");
      if (tui.frame().includes(ANCHOR)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  }

  it("keeps following live output until the user scrolls", () => {
    const { tui } = makeTui();
    tui.appendAssistant("history-filler-line\n".repeat(80));
    tui.appendAssistant("LIVE-FOLLOW-MARKER\n");
    expect(tui.frame()).toContain("LIVE-FOLLOW-MARKER");
    expect(scrollProbe(tui).follow).toBe(true);
  });

  it("does not drag the view to new output after page-up", () => {
    const { tui } = makeTui();
    fillTranscript(tui);
    pageToAnchor(tui);
    const probe = scrollProbe(tui);
    expect(probe.follow).toBe(false);
    const held = probe.scroll;
    tui.appendAssistant(`${LIVE}\n`.repeat(20));
    const frame = tui.frame();
    expect(frame).toContain(ANCHOR);
    expect(frame).not.toContain(LIVE);
    expect(probe.follow).toBe(false);
    expect(probe.scroll).toBeGreaterThan(held);
  });

  it("does not drag the view to new output after mouse wheel up", () => {
    const { tui } = makeTui();
    fillTranscript(tui);
    expect(tui.frame()).not.toContain(ANCHOR);
    for (let i = 0; i < 80; i++) tui.feed("\x1b[<64;1;1M");
    expect(tui.frame()).toContain(ANCHOR);
    tui.appendAssistant(`${LIVE}\n`.repeat(20));
    const frame = tui.frame();
    expect(frame).toContain(ANCHOR);
    expect(frame).not.toContain(LIVE);
    expect(scrollProbe(tui).follow).toBe(false);
  });

  it("returns to live output with End after scrolling up", () => {
    const { tui } = makeTui();
    fillTranscript(tui);
    tui.feed("\x1b[5~");
    tui.feed("\x1b[5~");
    expect(scrollProbe(tui).follow).toBe(false);
    tui.feed("\x1b[F");
    expect(scrollProbe(tui).follow).toBe(true);
    tui.appendAssistant("LIVE-END-MARKER\n");
    expect(tui.frame()).toContain("LIVE-END-MARKER");
  });

  it("grows detached scroll by painted markdown rows, not raw wrapText", () => {
    const cols = 81;
    const tui = new AgentTui({
      stdout: { write: () => true, columns: cols, rows: 40, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    const filler = "history-filler-line\n".repeat(80);
    const extra = `# ${"h".repeat(80)}\n`;
    const mdRows = (text: string) => wrapSpans(parseMarkdown(text, { n: 0 }), cols).length;
    const paintedGrowth = mdRows(filler + extra) - mdRows(filler);
    const lastLine = "";
    const rawGrowth = Math.max(0, wrapText(lastLine + extra, cols).length - wrapText(lastLine, cols).length);
    expect(paintedGrowth).not.toBe(rawGrowth);

    tui.appendPlain(`${ANCHOR}\n`);
    tui.appendAssistant(filler);
    pageToAnchor(tui);
    const probe = scrollProbe(tui);
    const held = probe.scroll;
    tui.appendAssistant(extra);
    expect(tui.frame()).toContain(ANCHOR);
    expect(probe.scroll - held).toBe(paintedGrowth);
  });

  it("keeps a screenshot in the box when the typed note fills it", () => {
    const tui = new AgentTui({
      stdout: { write: () => true, columns: 40, rows: 8, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    tui.setDraft("evidence note\n".repeat(12));
    tui.setPendingImageCount(1);
    const lines = tui.frame().split("\n");
    const draftLine = lines.findIndex((line) => line.includes("evidence note"));
    const imgLine = lines.findIndex((line) => line.includes("1 img") && !line.includes("termina"));
    expect(imgLine).toBeGreaterThan(-1);
    expect(draftLine).toBeGreaterThan(imgLine);
  });

  it("keeps a dropped file visible when the draft already fills the box", () => {
    const tui = new AgentTui({
      stdout: { write: () => true, columns: 24, rows: 10, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    tui.setDraft("typed note that already fills the composer before the drop");
    tui.feed("\x1b[200~@evidence.md \x1b[201~");
    expect(tui.frame()).toContain("@evidence.md");
  });

  it("inserts a dropped file into an existing draft", () => {
    const { tui } = makeTui();
    tui.setDraft("see this");
    tui.feed("\x1b[200~@notes.md \x1b[201~");
    const frame = tui.frame();
    expect(frame).toContain("see this");
    expect(frame).toContain("@notes.md");
  });
});
