/**
 * Tool outcome shapes and pure tool formatters: result envelopes, repro
 * strings, sidecar start records, transcript/detail display, and bash
 * permission predicates. Stateless between calls.
 */
import type { McpCancellationScope, McpContinuation } from "../mcp.ts";
import { isGrepNoMatches } from "../stall.ts";
import { genericToolText, type BoundedText, type ToolTextResult } from "../tool-output.ts";
import { isReplaceAll } from "./file-ops.ts";
import { shellQuote } from "./files.ts";
import { boundedSidecarEdits } from "./sidecar.ts";

export const TOOL_DISPLAY_BYTES = 2 * 1024;
const TOOL_TRUNCATION_HINT = "…[truncated — re-run or read_file for the rest]";

export interface ToolUse {
  id: string;
  name: string;
  input: {
    path?: string;
    command?: string;
    content?: string;
    offset?: unknown;
    start_line?: unknown;
    end_line?: unknown;
    pattern?: string;
    glob?: string;
    query?: string;
    old_text?: string;
    new_text?: string;
    [key: string]: unknown;
  };
}

/**
 * Result shape shared by filesystem/process/network tools.
 *
 * `content` is the bounded rendering that is safe to put in the next model
 * request.  The original stream accounting remains on `bounded`; process
 * tools additionally keep independent stdout/stderr results and exit status.
 * A continuation is deliberately metadata (the actionable hint is also in
 * the bounded text marker) so it cannot leak as an unrecognised provider
 * content block.
 */
type BoundedOutcomeMetadata = Pick<
  BoundedText,
  "state" | "direction" | "limitBytes" | "inputBytes" | "retainedBytes" | "omittedBytes" | "outputBytes" | "truncated"
>;

export interface ToolOutcome {
  result: Record<string, unknown>;
  isError: boolean;
  /** Preserve bounded MCP accounting through the generic tool boundary. */
  bounded?: BoundedOutcomeMetadata;
  cancellationScope?: McpCancellationScope;
  continuation?: string | McpContinuation | null;
  repro?: string | null;
  stdout?: BoundedText;
  stderr?: BoundedText;
  exitCode?: number | null;
  signal?: string | null;
}

export function toolResult(use: ToolUse, content: string): Record<string, unknown> {
  return { type: "tool_result", tool_use_id: use.id, content };
}

function boundedMetadata(value: BoundedText): BoundedOutcomeMetadata {
  return {
    state: value.state,
    direction: value.direction,
    limitBytes: value.limitBytes,
    inputBytes: value.inputBytes,
    retainedBytes: value.retainedBytes,
    omittedBytes: value.omittedBytes,
    outputBytes: value.outputBytes,
    truncated: value.truncated,
  };
}

export function done(use: ToolUse, value: string | ToolTextResult, isError?: boolean): ToolOutcome {
  const output = typeof value === "string"
    ? Object.freeze({ ...genericToolText(value, isError === true), repro: reproFor(use) ?? null })
    : value;
  return {
    result: toolResult(use, output.content),
    isError: output.isError,
    bounded: boundedMetadata(output),
    continuation: output.continuation ?? null,
    repro: output.repro ?? null,
    ...(output.stdout ? { stdout: output.stdout } : {}),
    ...(output.stderr ? { stderr: output.stderr } : {}),
    ...(output.exitCode === undefined ? {} : { exitCode: output.exitCode }),
    ...(output.signal === undefined ? {} : { signal: output.signal }),
  };
}

export function toolOutcomeTraceFields(outcome: ToolOutcome): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (outcome.bounded) fields.bounded = { ...outcome.bounded };
  if (outcome.cancellationScope) fields.cancellationScope = outcome.cancellationScope;
  if (outcome.continuation) fields.continuation = outcome.continuation;
  if (outcome.repro) fields.repro = outcome.repro;
  if (outcome.stdout) fields.stdout = { ...boundedMetadata(outcome.stdout) };
  if (outcome.stderr) fields.stderr = { ...boundedMetadata(outcome.stderr) };
  if (outcome.exitCode !== undefined) fields.exitCode = outcome.exitCode;
  if (outcome.signal !== undefined) fields.signal = outcome.signal;
  return fields;
}

export function toolOutcomeTraceInput(use: ToolUse, outcome: ToolOutcome): Record<string, unknown> {
  return {
    toolName: use.name,
    toolCallId: use.id,
    isError: outcome.isError,
    ...toolOutcomeTraceFields(outcome),
  };
}

export function reproFor(use: ToolUse): string | undefined {
  // Error results also need reproduction metadata; malformed runtime values
  // must not throw while we are trying to report their validation failure.
  const text = (key: string): string => typeof use.input[key] === "string" ? use.input[key] as string : "";
  if (use.name === "bash") return `bash ${shellQuote(text("command"))}`;
  if (use.name === "read_file") return `read_file(${JSON.stringify(text("path"))})`;
  if (use.name === "edit") return `edit(${JSON.stringify(text("path"))})`;
  if (use.name === "grep") return `grep ${shellQuote(text("pattern"))}`;
  if (use.name === "glob") return `glob ${shellQuote(text("pattern"))}`;
  if (use.name === "web_search") return `web_search ${shellQuote(text("query"))}`;
  if (use.name === "fetch") return `fetch ${shellQuote(text("url"))}`;
  return undefined;
}

export function sidecarStartFor(use: {
  name: string;
  id: string;
  input: { path?: string; old_text?: string; new_text?: string; replace_all?: unknown };
}): Record<string, unknown> {
  if (use.name === "write_file") {
    return { t: "tool", toolName: "write", path: use.input.path, toolCallId: use.id };
  }
  if (use.name === "edit") {
    const start: Record<string, unknown> = {
      t: "tool",
      toolName: "edit",
      path: use.input.path,
      toolCallId: use.id,
    };
    if (!isReplaceAll(use.input.replace_all)) {
      Object.assign(start, boundedSidecarEdits([{ oldText: use.input.old_text ?? "", newText: use.input.new_text ?? "" }]));
    }
    return start;
  }
  return { t: "tool", toolName: use.name, toolCallId: use.id };
}

export function formatToolAnnounce(use: ToolUse): string {
  let detail = "";
  if (use.name === "edit" || use.name === "write_file" || use.name === "read_file") detail = use.input.path ?? "";
  else if (use.name === "bash") detail = `$ ${use.input.command ?? ""}`;
  else if (use.name === "grep") detail = use.input.pattern ?? "";
  else if (use.name === "glob") detail = use.input.pattern ?? "";
  else if (use.name === "fetch") detail = String(use.input.url ?? "");
  else if (use.name === "spawn_subagent") {
    detail = String(use.input.task ?? "").slice(0, 80);
    // Manual-bypass runs are privileged: mark them so a self-granted
    // user_requested flag is visible in the transcript, not silent.
    if (use.input.user_requested === true) detail += " · user-requested";
  }
  else if (use.name === "message_subagent") detail = String(use.input.run_id ?? "");
  return `◆ Tool · ${use.name}${detail ? `\n  ${detail}` : ""}`;
}

export function capDisplay(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

export function formatToolFollowup(use: ToolUse, outcome: { result: Record<string, unknown>; isError: boolean }): string {
  const content = typeof outcome.result.content === "string" ? outcome.result.content : "";
  const status = outcome.isError ? "failed" : "done";
  if (use.name === "bash") {
    const shown = displayToolOutput(content);
    return `◇ ${use.name} · ${status}${shown ? `\n${shown}` : ""}\n`;
  }
  if (outcome.isError) {
    const shown = displayToolOutput(content);
    return `◇ ${use.name} · failed${shown ? `\n${shown}` : ""}\n`;
  }
  if (use.name === "grep" || use.name === "glob") {
    if (isGrepNoMatches(content)) return `◇ ${use.name} · done · no matches\n`;
    // Ripgrep-style summary header ("N hits in M files") carries the exact
    // count; prefer it over counting display lines. Pinned by harness-kernel.
    if (use.name === "grep") {
      const hm = /^(\d+\+?) hits? in /.exec(content);
      if (hm) return `◇ grep · done · ${hm[1]} hits\n`;
    }
    const n = content === "" ? 0 : content.split("\n").length;
    return `◇ ${use.name} · done · ${n} ${use.name === "grep" ? "hits" : "files"}\n`;
  }
  return `◇ ${use.name} · done\n`;
}

export function toolTranscriptDetail(use: ToolUse): string {
  if (use.name === "edit" || use.name === "write_file" || use.name === "read_file") return use.input.path ?? "";
  if (use.name === "bash") return use.input.command ?? "";
  if (use.name === "grep" || use.name === "glob") return use.input.pattern ?? "";
  if (use.name === "fetch") return String(use.input.url ?? "");
  return "";
}

export function displayToolOutput(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= TOOL_DISPLAY_BYTES) return content;
  return `${capDisplay(content, TOOL_DISPLAY_BYTES)}\n${TOOL_TRUNCATION_HINT}`;
}

export function toolTranscriptOutput(outcome: ToolOutcome): string {
  const content = typeof outcome.result.content === "string" ? outcome.result.content : "";
  return displayToolOutput(content);
}

export type PermissionMode = "always" | "dangerous" | "ask";

export function isDangerousBash(command: string): boolean {
  const text = command.replace(/\\\n/g, " ");
  return (
    /\b(?:sudo|doas|su|rm|rmdir|unlink|shred|truncate|mkfs|fdisk|parted|shutdown|reboot|halt|poweroff|chmod|chown|kill|pkill|killall)\b/i.test(text) ||
    /\bdd\b[^\n]*\bof=/i.test(text) ||
    /\bfind\b[^\n]*(?:\s-delete\b|\s-exec\b)/i.test(text) ||
    /\bgit\b[^\n;&|]*\b(?:clean\b|restore\b|push\b|reset\s+--hard\b|checkout\s+--\b)/i.test(text) ||
    /\b(?:npm|pnpm|yarn)\s+publish\b/i.test(text) ||
    /\b(?:curl|wget)\b[^\n]*\|\s*(?:env\s+)?(?:ba|z|k|c)?sh\b/i.test(text) ||
    /\b(?:python\d*|node|ruby|perl|(?:ba|z|k|c)?sh)\b[^\n]*(?:\s-c\b|\s-e\b)/i.test(text)
  );
}

export function shouldAskPermission(mode: PermissionMode, command: string): boolean {
  return mode === "ask" || (mode === "dangerous" && isDangerousBash(command));
}
