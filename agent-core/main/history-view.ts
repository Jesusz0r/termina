/**
 * History view: paint stored messages into the live transcript (TUI or
 * plain stdout). Pure over its inputs plus the passed surface.
 */
import type { AgentTui, TranscriptHandle } from "../tui.ts";
import { displayToolOutput, formatToolAnnounce, toolTranscriptDetail, type ToolUse } from "./tools.ts";

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

function blockBodyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function replayToolOutput(text: string): string {
  return displayToolOutput(text);
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
  const pending: Array<{ id: string; handle: TranscriptHandle | null }> = [];

  const writeFollowup = (state: "success" | "error" | "cancelled", output?: string): void => {
    const label = state === "error" ? "failed" : state === "cancelled" ? "cancelled" : "done";
    process.stdout.write(`◇ ${label}${output ? `\n${output}` : ""}\n`);
  };

  const finishHandle = (handle: TranscriptHandle | null, state: "success" | "error" | "cancelled", output?: string): void => {
    if (handle && tui) tui.finishTool(handle, state, output);
    else if (!tui) writeFollowup(state, output);
  };

  const finish = (id: string, state: "success" | "error" | "cancelled", output?: string): void => {
    let idx = pending.findIndex((item) => item.id === id);
    if (idx < 0 && !id) idx = 0;
    if (idx < 0 || idx >= pending.length) {
      if (tui) {
        const handle = tui.startTool("tool", "");
        tui.finishTool(handle, state, output);
      } else writeFollowup(state, output);
      return;
    }
    const rec = pending.splice(idx, 1)[0]!;
    finishHandle(rec.handle, state, output);
  };

  const start = (id: string, name: string, detail: string, announce: string): void => {
    if (tui) pending.push({ id, handle: tui.startTool(name, detail) });
    else {
      process.stdout.write(`\n${announce}\n`);
      pending.push({ id, handle: null });
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
        start(use.id, name, toolTranscriptDetail(use), formatToolAnnounce(use));
        continue;
      }
      if (block.type === "tool_result" || block.type === "web_search_tool_result") {
        const id = String(block.tool_use_id ?? block.toolUseId ?? "");
        const text = replayToolOutput(blockBodyText(block.content));
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
