import { describe, expect, it } from "vitest";
import { TOOL_DISPLAY_BYTES, toolTranscriptOutput, type ToolOutcome, type ToolUse } from "../../../agent-core/main/tools.ts";
import { AgentTui } from "../../../agent-core/tui.ts";
import { renderHistoryTranscript } from "../../../agent-core/main/history-view.ts";

const edit: ToolUse = { id: "edit-1", name: "edit", input: { path: "file.ts", old_text: "before", new_text: "after" } };
const success: ToolOutcome = { isError: false, result: { content: "ok: edited file.ts" } };

describe("expanded file tool previews", () => {
  it("shows both sides of an executed edit without changing the model result", () => {
    expect(toolTranscriptOutput(edit, success)).toBe("ok: edited file.ts\n\nBefore:\nbefore\n\nAfter:\nafter");
    expect(success.result.content).toBe("ok: edited file.ts");
  });

  it("shows written content", () => {
    const use = { id: "write-1", name: "write_file", input: { path: "file.ts", content: "new file contents" } };
    expect(toolTranscriptOutput(use, success)).toContain("Written content:\nnew file contents");
  });

  it.each([{ isError: true }, { executed: false }])("does not imply an unapplied edit succeeded: %j", fields => {
    expect(toolTranscriptOutput(edit, { ...success, ...fields })).toBe("ok: edited file.ts");
  });

  it("leaves other tool output unchanged", () => {
    expect(toolTranscriptOutput({ id: "read", name: "read_file", input: { path: "file.ts" } }, success)).toBe("ok: edited file.ts");
  });

  it.each([
    edit,
    { id: "write-1", name: "write_file", input: { path: "file.ts", content: "new file contents" } },
  ])("replays $name with the same expanded success and error output as the live transcript", use => {
    const makeTui = () => new AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24 }, stdin: {},
      onSubmit() {}, onInterrupt() {}, onExit() {},
    });
    for (const isError of [false, true]) {
      const content = isError ? "permission denied" : "ok: done";
      const live = makeTui();
      live.finishTool(live.startTool(use.name, "file.ts"), isError ? "error" : "success",
        toolTranscriptOutput(use, { result: { content }, isError }));
      const resumed = makeTui();
      renderHistoryTranscript([
        { role: "assistant", content: [{ type: "tool_use", ...use }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content, is_error: isError }] },
      ], resumed);
      live.feed("\r");
      resumed.feed("\r");
      expect(resumed.frame()).toBe(live.frame());
    }
  });

  it("bounds each side independently, preserving the outcome and both labels", () => {
    const text = "🧪".repeat(10_000);
    const output = toolTranscriptOutput({ ...edit, input: { old_text: text, new_text: text } }, success);
    expect(output.startsWith("ok: edited file.ts\n\nBefore:\n")).toBe(true);
    expect(output).toContain("After:\n");
    expect(output.match(/preview truncated/g)).toHaveLength(2);
    expect(output).not.toContain("�");
    expect(Buffer.byteLength(output)).toBeLessThan(2 * TOOL_DISPLAY_BYTES + 200);
  });
});
