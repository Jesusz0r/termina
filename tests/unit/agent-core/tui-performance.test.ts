import { describe, expect, it } from "vitest";
import { AgentTui } from "../../../agent-core/tui.ts";
import { formatToolSummary, matchingSlashCommands, SLASH_COMMANDS } from "../../../agent-core/tui-text.ts";

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

const MODEL_PICKER_ROWS = [
  { name: "openai-codex/gpt-5.4", hint: "openai-codex", submit: "/model openai-codex/gpt-5.4" },
  { name: "anthropic/claude-sonnet-4-5", hint: "anthropic", submit: "/model anthropic/claude-sonnet-4-5" },
];

describe("agent-core TUI settled tool fold", () => {
  it("formats the one-line tool summary", () => {
    expect(formatToolSummary("bash", "ls", "done")).toBe("◆ bash  ls  done");
    expect(formatToolSummary("bash", "ls", "failed")).toBe("◆ bash  ls  failed");
    expect(formatToolSummary("read", undefined, "done")).toBe("◆ read  done");
  });

  it("paints a settled tool as one line until Enter expands the payload", () => {
    const tui = makeTui();
    const payload = "UNIQUE_SETTLED_TOOL_PAYLOAD";
    tui.finishTool(tui.startTool("bash", "ls -la"), "success", payload);
    const folded = tui.frame();
    const toolLines = folded.split("\n").filter((line) => line.includes("◆"));
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0]).toContain("◆ bash  ls -la  done");
    expect(folded).not.toContain(payload);

    tui.feed("\r");
    const expanded = tui.frame();
    expect(expanded).toContain(payload);
    expect(expanded).toContain("◆ bash  ls -la  done");

    tui.feed("\r");
    expect(tui.frame()).not.toContain(payload);
  });

  it("does not expand a folded tool when Enter submits a prompt", () => {
    const submitted: string[] = [];
    const tui = new AgentTui({
      stdout: { write: () => true, columns: 120, rows: 40, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => submitted.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    tui.finishTool(tui.startTool("bash", "ls"), "success", "UNIQUE_SETTLED_TOOL_PAYLOAD");
    tui.feed("keep going\r");
    expect(submitted).toEqual(["keep going"]);
    expect(tui.frame()).not.toContain("UNIQUE_SETTLED_TOOL_PAYLOAD");
  });
});

describe("agent-core TUI /model picker alias", () => {
  it("matches /model to the same picker rows as /models", () => {
    const fromModels = matchingSlashCommands("/models", SLASH_COMMANDS, MODEL_PICKER_ROWS).map((row) => row.name);
    const fromModel = matchingSlashCommands("/model", SLASH_COMMANDS, MODEL_PICKER_ROWS).map((row) => row.name);
    expect(fromModel).toEqual(fromModels);
    expect(fromModel).toEqual(["openai-codex/gpt-5.4", "anthropic/claude-sonnet-4-5"]);
    expect(matchingSlashCommands("/model a", SLASH_COMMANDS, MODEL_PICKER_ROWS).map((row) => row.name)).toEqual([
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("shows models picker rows when /model is typed", () => {
    const submitted: string[] = [];
    const tui = new AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => submitted.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    tui.setModelRows(MODEL_PICKER_ROWS);
    tui.feed("/model");
    const frame = tui.frame();
    expect(frame).toContain("openai-codex/gpt-5.4");
    expect(frame).toContain("anthropic/claude-sonnet-4-5");
    expect(frame).toContain("> /model");
    tui.feed("\r");
    expect(submitted).toEqual(["/model openai-codex/gpt-5.4"]);
  });

  it("submits /models when bare /model has no picker rows yet", () => {
    const submitted: string[] = [];
    const tui = new AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => submitted.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    tui.feed("/model\r");
    expect(submitted).toEqual(["/models"]);
  });

  it("keeps /model <id> as a switch", () => {
    const submitted: string[] = [];
    const tui = new AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: (line) => submitted.push(line),
      onInterrupt: () => {},
      onExit: () => {},
    });
    tui.feed("/model anthropic/claude-sonnet-4-5\r");
    expect(submitted).toEqual(["/model anthropic/claude-sonnet-4-5"]);
  });
});

describe("agent-core TUI paste batching (#224)", () => {
  function submitTui() {
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

  it("inserts a 200 KB bracketed paste in bounded time with a capped draft", () => {
    const { tui, submitted } = submitTui();
    const paste = `x${"y".repeat(200 * 1024 - 2)}z`;
    const started = Date.now();
    tui.feed(`\x1b[200~${paste}\x1b[201~`);
    expect(Date.now() - started).toBeLessThan(2000);
    tui.feed("\r");
    expect(submitted).toHaveLength(1);
    expect(Buffer.byteLength(submitted[0]!, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(submitted[0]).toBe(paste);
  });

  it("trims past the draft cap with a visible note", () => {
    const capped = submitTui();
    capped.tui.feed(`\x1b[200~${"q".repeat(300 * 1024)}\x1b[201~`);
    capped.tui.feed("\r");
    expect(capped.submitted).toHaveLength(1);
    expect(Buffer.byteLength(capped.submitted[0]!, "utf8")).toBeLessThanOrEqual(256 * 1024);
    // The note lands in the transcript above the capped composer page.
    const noted = submitTui();
    noted.tui.feed(`\x1b[200~${"q".repeat(300 * 1024)}\x1b[201~`);
    noted.tui.setDraft("");
    expect(noted.tui.frame()).toContain("256 KiB cap");
  });

  it("keeps grapheme-correct cursors across combining-character pastes", () => {
    const { tui, submitted } = submitTui();
    tui.feed("\x1b[200~e\u0301\x1b[201~");
    tui.feed("!");
    tui.feed("\r");
    // e + combining acute is one grapheme; ! lands after it, not inside it.
    expect(submitted).toEqual(["e\u0301!"]);
  });

  it("normalizes pasted line endings like the per-character path", () => {
    const { tui, submitted } = submitTui();
    tui.feed("\x1b[200~a\r\nb\rc\x1b[201~");
    tui.feed("\r");
    expect(submitted).toEqual(["a\nb\nc"]);
  });
});

describe("agent-core TUI truncateMiddle budget (#226)", () => {
  it("never exceeds its cell budget", async () => {
    const { cellWidth, truncateMiddle } = await import("../../../agent-core/tui-text.ts");
    const inputs = [
      "ascii-title-label",
      "mixed-日本語-title",
      "with\ttab\tchars",
      "emoji-🎉-party-time",
      "sem-CJK-中文字符-long",
    ];
    for (const text of inputs) {
      for (let maxCells = 1; maxCells <= 8; maxCells++) {
        const out = truncateMiddle(text, maxCells);
        expect(cellWidth(out), `${JSON.stringify(text)} @ ${maxCells}`).toBeLessThanOrEqual(maxCells);
      }
    }
  });

  it("keeps head-heavy output for a 2-cell budget", async () => {
    const { truncateMiddle } = await import("../../../agent-core/tui-text.ts");
    expect(truncateMiddle("abcdef", 2)).toBe("a…");
  });
});
