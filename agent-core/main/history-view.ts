/**
 * History view: paint stored messages into the live transcript (TUI or
 * plain stdout). Pure over its inputs plus the passed surface.
 */
import type { AgentTui, TranscriptHandle } from "../tui.ts";
import { toolResultText } from "../tool-output.ts";
import { displayToolOutput, formatToolAnnounce, toolTranscriptDetail, toolTranscriptOutput, type ToolUse } from "./tools.ts";

export type ContentBlock = Record<string, unknown> & {
  type: string;
  /** View metadata. Stripped before any request leaves the process. */
  chars?: number;
  tool?: string;
  repro?: string;
  stubbed?: boolean;
};

function blockInput(block: ContentBlock): ToolUse["input"] {
  const raw = block.input;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ToolUse["input"];
  return {};
}

function replayToolState(block: ContentBlock, text: string): "success" | "error" {
  if (block.is_error === true || block.isError === true) return "error";
  if (text.startsWith("error:")) return "error";
  return "success";
}

function paintPlain(tui: AgentTui | null, text: string): void {
  if (!text) return;
  if (tui) tui.appendPlain(text);
  else process.stdout.write(text);
}

function paintUserEcho(tui: AgentTui | null, text: string): void {
  const body = text.trimEnd();
  if (!body) return;
  paintPlain(tui, `\n> ${body}\n`);
}

/** Paint stored messages into the live transcript. Skip encrypted reasoning. */
export function renderHistoryTranscript(
  messages: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }>,
  tui: AgentTui | null,
): void {
  const pending: Array<{ use: ToolUse; handle: TranscriptHandle | null }> = [];

  const writeFollowup = (state: "success" | "error" | "cancelled", output?: string): void => {
    const label = state === "error" ? "failed" : state === "cancelled" ? "cancelled" : "done";
    process.stdout.write(`◇ ${label}${output ? `\n${output}` : ""}\n`);
  };

  const finishHandle = (handle: TranscriptHandle | null, state: "success" | "error" | "cancelled", output?: string): void => {
    if (handle && tui) tui.finishTool(handle, state, output);
    else if (!tui) writeFollowup(state, output);
  };

  const finish = (id: string, state: "success" | "error" | "cancelled", output?: string): void => {
    let idx = pending.findIndex((item) => item.use.id === id);
    if (idx < 0 && !id) idx = 0;
    if (idx < 0 || idx >= pending.length) {
      const shown = output === undefined ? undefined : displayToolOutput(output);
      if (tui) {
        const handle = tui.startTool("tool", "");
        tui.finishTool(handle, state, shown);
      } else writeFollowup(state, shown);
      return;
    }
    const rec = pending.splice(idx, 1)[0]!;
    const shown = output === undefined ? undefined : toolTranscriptOutput(rec.use, {
      result: { content: output }, isError: state !== "success",
    });
    finishHandle(rec.handle, state, shown);
  };

  const start = (use: ToolUse): void => {
    if (tui) pending.push({ use, handle: tui.startTool(use.name, toolTranscriptDetail(use)) });
    else {
      process.stdout.write(`\n${formatToolAnnounce(use)}\n`);
      pending.push({ use, handle: null });
    }
  };

  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      if (content.startsWith("<context-handoff>")) {
        const handoff = content.replace(/<\/?context-handoff>/g, "").trim();
        if (handoff) paintPlain(tui, `${handoff}\n`);
        continue;
      }
      if (message.role === "user") paintUserEcho(tui, content);
      else if (tui) tui.appendAssistant(content);
      else process.stdout.write(content);
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "redacted_thinking") continue;
      if (block.type === "thinking") {
        const text = String(block.thinking ?? "");
        if (!text) continue;
        if (tui) tui.appendThinking(text);
        else process.stdout.write(`\n◆ Thinking\n${text}`);
        continue;
      }
      if (block.type === "text") {
        const text = String(block.text ?? "");
        if (!text) continue;
        if (message.role === "user") paintUserEcho(tui, text);
        else if (tui) tui.appendAssistant(text);
        else process.stdout.write(text);
        continue;
      }
      if (block.type === "image") {
        paintPlain(tui, "(image)\n");
        continue;
      }
      if (block.type === "tool_use" || block.type === "server_tool_use") {
        const name = String(block.name ?? (block.type === "server_tool_use" ? "web_search" : "tool"));
        const use: ToolUse = { id: String(block.id ?? ""), name, input: blockInput(block) };
        start(use);
        continue;
      }
      if (block.type === "tool_result" || block.type === "web_search_tool_result") {
        const id = String(block.tool_use_id ?? block.toolUseId ?? "");
        const text = toolResultText(block.content);
        const err =
          block.type === "web_search_tool_result" &&
          Boolean(block.content) &&
          typeof block.content === "object" &&
          !Array.isArray(block.content) &&
          (block.content as { type?: string }).type === "web_search_tool_result_error";
        finish(id, err ? "error" : replayToolState(block, text), text);
        continue;
      }
    }
  }
  while (pending.length > 0) {
    const rec = pending.pop()!;
    finishHandle(rec.handle, "cancelled");
  }
}
