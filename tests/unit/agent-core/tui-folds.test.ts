import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AgentTui } from "../../../agent-core/tui.ts";
import { toggleTranscriptEntryControl } from "../../../shared/terminal-control.ts";
import { terminalTranscriptEntryId } from "../../../shared/terminal-link.ts";

function setup(rows = 24) {
  const submitted: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { write: () => true, columns: 80, rows, isTTY: false });
  const tui = new AgentTui({ stdout, stdin: { isTTY: false }, onSubmit: line => submitted.push(line), onInterrupt() {}, onExit() {} });
  return { tui, stdout, submitted };
}

function headerId(tui: AgentTui, label: string): number {
  const row = tui.paintedFrame().find(line => line.includes(label));
  const uri = row?.match(/\x1b\]8;;([^\x07]+)\x07/)?.[1];
  const id = terminalTranscriptEntryId(uri ?? "");
  expect(id, `missing clickable header: ${label}`).not.toBeNull();
  return id!;
}

function toggle(tui: AgentTui, id: number) {
  tui.feed(toggleTranscriptEntryControl(id));
}

describe("clickable transcript folds", () => {
  it("expands the targeted tool, not the newest one, without touching the draft", () => {
    const { tui, submitted } = setup();
    tui.finishTool(tui.startTool("edit", "first.ts"), "success", "FIRST_EDIT_PAYLOAD");
    tui.finishTool(tui.startTool("read_file", "other.ts"), "success", "SECOND_TOOL_PAYLOAD");
    tui.setDraft("unfinished prompt");
    const id = headerId(tui, "first.ts");
    const linkLabel = tui.paintedFrame().find(row => row.includes("first.ts"))!
      .match(/\x1b\]8;;termina-transcript:[0-9]+\x07(.*?)\x1b\]8;;\x07/)?.[1];
    expect(linkLabel).toContain("◆ edit");
    expect(linkLabel).not.toContain("first.ts");
    expect(tui.frame()).not.toContain("FIRST_EDIT_PAYLOAD");
    toggle(tui, id);
    expect(tui.frame()).toContain("FIRST_EDIT_PAYLOAD");
    expect(tui.frame()).not.toContain("SECOND_TOOL_PAYLOAD");
    expect(tui.frame()).toContain("▾ ◆ edit");
    expect(tui.frame()).toContain("> unfinished prompt");
    toggle(tui, id);
    expect(tui.frame()).not.toContain("FIRST_EDIT_PAYLOAD");
    expect(submitted).toEqual([]);
  });

  it("collapses finished thinking and lets the user open it again", () => {
    const { tui } = setup();
    tui.appendThinking("thinking body");
    const id = headerId(tui, "Thinking");
    expect(tui.frame()).toContain("thinking body");
    tui.appendAssistant("answer");
    expect(tui.frame()).toContain("▸ Thinking");
    expect(tui.frame()).not.toContain("thinking body");
    toggle(tui, id);
    expect(tui.frame()).toContain("thinking body");
    expect(tui.frame()).toContain("answer");
    toggle(tui, id);
    expect(tui.frame()).not.toContain("thinking body");
  });

  it("retains explicit thinking choices across streaming, settlement and global visibility", () => {
    const { tui } = setup();
    tui.appendThinking("early reasoning");
    const id = headerId(tui, "Thinking");
    toggle(tui, id);
    tui.appendThinking(" later reasoning");
    expect(tui.frame()).not.toContain("early reasoning");
    toggle(tui, id);
    tui.appendAssistant("answer");
    expect(tui.frame()).toContain("early reasoning later reasoning");
    tui.setThinkingVisible(false);
    expect(tui.frame()).not.toContain("Thinking");
    toggle(tui, id); // A stale hidden header must not change its saved choice.
    tui.setThinkingVisible(true);
    expect(tui.frame()).toContain("early reasoning later reasoning");
  });

  it("collapses thinking when a run stops without a final answer", () => {
    const { tui } = setup();
    tui.setBusy(true);
    tui.appendThinking("unfinished reasoning");
    expect(tui.frame()).toContain("unfinished reasoning");
    tui.setBusy(false);
    expect(tui.frame()).toContain("▸ Thinking");
    expect(tui.frame()).not.toContain("unfinished reasoning");
  });

  it("keeps a running tool open when its output arrives", () => {
    const { tui } = setup();
    const handle = tui.startTool("bash", "long operation");
    toggle(tui, headerId(tui, "long operation"));
    tui.finishTool(handle, "error", "failure details");
    expect(tui.frame()).toContain("failure details");
    expect(tui.frame()).toContain("failed");
  });

  it("opens a long result at its header instead of hiding it behind the tail", () => {
    const { tui, stdout } = setup(12);
    tui.finishTool(tui.startTool("read_file", "large.txt"), "success", Array.from({ length: 200 }, (_, i) => `result line ${i}`).join("\n"));
    const id = headerId(tui, "large.txt");
    toggle(tui, id);
    expect(tui.frame()).toContain("large.txt");
    expect(tui.frame()).toContain("result line 0");
    expect(tui.frame()).not.toContain("result line 199");
    stdout.columns = 36;
    expect(headerId(tui, "large.txt")).toBe(id);
    toggle(tui, id);
    expect(tui.frame()).not.toContain("result line 0");
    expect(tui.frame()).toContain("▸ ◆ read_file");
  });

  it("does not leave a blank transcript when resize reduces an opened result's wrapped rows", () => {
    const { tui, stdout } = setup(12);
    stdout.columns = 40;
    tui.start();
    try {
      tui.finishTool(tui.startTool("read_file", "wide.txt"), "success", `first line ${"x".repeat(60)}\n${"long line ".repeat(10)}\n`.repeat(40));
      const id = headerId(tui, "wide.txt");
      toggle(tui, id);
      expect(tui.frame()).toContain("▾ ◆ read_file");
      stdout.columns = 160;
      stdout.emit("resize");
      expect(tui.frame()).toContain("▾ ◆ read_file");
      expect(tui.frame()).toContain("first line");
      toggle(tui, id);
      expect(tui.frame()).not.toContain("first line");
    } finally {
      tui.stop();
    }
  });

  it("opens long thinking at the beginning and scrolls without losing its fold", () => {
    const { tui } = setup(12);
    tui.appendThinking(`FIRST reasoning line\n${"middle line\n".repeat(20_000)}LAST reasoning line`);
    tui.appendAssistant("answer");
    const id = headerId(tui, "Thinking");
    toggle(tui, id);
    expect(tui.frame()).toContain("▾ Thinking");
    expect(tui.frame()).toContain("FIRST reasoning line");
    expect(tui.frame()).not.toContain("LAST reasoning line");
    tui.feed("\x1b[6~");
    expect(tui.frame()).toContain("middle line");
    toggle(tui, id);
    expect(tui.frame()).toContain("▸ Thinking");
    expect(tui.frame()).not.toContain("middle line");
  });

  it("supports empty-Enter thinking folds without stealing queued retries", () => {
    const { tui, submitted } = setup();
    tui.appendThinking("saved thinking");
    tui.appendAssistant("answer");
    tui.feed("\r");
    expect(tui.frame()).toContain("saved thinking");
    tui.setQueued("retry me");
    tui.feed("\r");
    expect(submitted).toEqual([""]);
  });

  it("ignores invalid, evicted, non-foldable, and pasted controls", () => {
    const { tui, submitted } = setup();
    tui.appendPlain("plain");
    tui.finishTool(tui.startTool("bash", "echo done"), "success", "HIDDEN_PAYLOAD");
    const id = headerId(tui, "echo done");
    const before = tui.frame();
    for (const control of ["\x1b[?9002;0h", "\x1b[?9002;01h", "\x1b[?9002;9007199254740992h", "\x1b[?9002;2l", "\x1b[?9002;999h", toggleTranscriptEntryControl(1)]) tui.feed(control);
    expect(tui.frame()).toBe(before);
    tui.feed(`\x1b[200~draft${toggleTranscriptEntryControl(id)}\x1b[201~`);
    expect(tui.frame()).not.toContain("HIDDEN_PAYLOAD");
    tui.feed("\r");
    expect(submitted).toEqual(["draft"]);
    for (let i = 0; i < 2100; i++) tui.appendPlain(`entry ${i}\n`);
    const evicted = tui.frame();
    toggle(tui, id);
    expect(tui.frame()).toBe(evicted);
  });

  it("cannot create fold controls from model markdown or raw terminal escapes", () => {
    const { tui } = setup();
    tui.appendAssistant("[fake](termina-transcript:123)\x1b]8;;termina-transcript:123\x07untrusted\x1b]8;;\x07");
    expect(tui.paintedFrame().join("\n")).not.toContain("\x1b]8;;termina-transcript:");
  });

  it.each(["thinking", "assistant"] as const)("keeps an opened fold anchored when a new %s stream starts", kind => {
    const { tui } = setup(12);
    tui.finishTool(tui.startTool("read_file", "anchored.txt"), "success", Array.from({ length: 40 }, (_, i) => `old line ${i}`).join("\n"));
    toggle(tui, headerId(tui, "anchored.txt"));
    const before = tui.frame();
    if (kind === "thinking") tui.appendThinking("new reasoning");
    else tui.appendAssistant("new answer");
    expect(tui.frame()).toBe(before);
  });

  it("does not move a newer opened fold when an earlier expanded tool finishes", () => {
    const { tui } = setup(12);
    const earlier = tui.startTool("bash", "earlier");
    toggle(tui, headerId(tui, "earlier"));
    tui.finishTool(tui.startTool("read_file", "anchored.txt"), "success", Array.from({ length: 40 }, (_, i) => `old line ${i}`).join("\n"));
    toggle(tui, headerId(tui, "anchored.txt"));
    const before = tui.frame();
    tui.finishTool(earlier, "success", "earlier output\n".repeat(30));
    expect(tui.frame()).toBe(before);
  });

  it("does not parse hidden thinking on each render", () => {
    const { tui } = setup();
    tui.appendThinking("large reasoning with **markdown**\n".repeat(5000));
    tui.appendAssistant("answer");
    const before = tui.markdownScannedChars;
    for (let i = 0; i < 50; i++) tui.frame();
    expect(tui.markdownScannedChars - before).toBeLessThan(100);
  });
});
