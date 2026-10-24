/**
 * External CLI hook payloads → the shared activity signals.
 *
 * Observational only. This does not approve a tool, inject a prompt, or
 * decide that a Stop hook finished the turn. UserPromptSubmit can still be
 * rejected by another hook, so it does not start work.
 */
import type { ActivitySignal } from "../agent-activity.ts";
import { isRecord } from "../../shared/guards.ts";
import type { ExternalCli } from "../../shared/types.ts";
import { museNotificationFacts } from "./muse.ts";

export type HookFact =
  | { t: "external_turn" }
  | { t: "external_stop" }
  | { t: "external_permission"; requestId: string }
  | { t: "external_permission_clear"; requestId: string }
  | { t: "external_tool"; target: string }
  | { t: "external_tool_end"; target: string; isError: boolean }
  | { t: "external_subagent_stop" };

function textField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function toolCallRecord(record: Record<string, unknown>): Record<string, unknown> | null {
  const call = record.toolCall ?? record.tool_call;
  return isRecord(call) ? call : null;
}

function toolName(record: Record<string, unknown>): string {
  return textField(record, "tool_name", "toolName") || textField(toolCallRecord(record) ?? {}, "name");
}

function stepTarget(record: Record<string, unknown>): string {
  const step = record.stepIdx ?? record.step_idx;
  return typeof step === "number" && Number.isInteger(step) && step >= 0 ? `step:${step}` : "";
}

function toolTarget(record: Record<string, unknown>): string {
  return textField(record, "tool_use_id", "toolUseId") || stepTarget(record) || toolName(record);
}

function permissionId(prefix: string, record: Record<string, unknown>): string {
  const name = toolName(record);
  return name ? `${prefix}:${name}` : `${prefix}:permission`;
}

const EVENT_NAMES: Record<string, string> = {
  userpromptsubmit: "UserPromptSubmit",
  pretooluse: "PreToolUse",
  posttooluse: "PostToolUse",
  posttoolusefailure: "PostToolUseFailure",
  permissionrequest: "PermissionRequest",
  stop: "Stop",
  stopfailure: "StopFailure",
  sessionstart: "SessionStart",
  sessionend: "SessionEnd",
  subagentstart: "SubagentStart",
  subagentstop: "SubagentStop",
  notification: "Notification",
  preinvocation: "PreInvocation",
  postinvocation: "PostInvocation",
};

function eventName(record: Record<string, unknown>): string {
  const raw = textField(record, "hook_event_name", "hookEventName", "event_name", "eventName");
  return EVENT_NAMES[raw.toLowerCase().replaceAll("_", "")] ?? "";
}

function toolFailed(response: unknown): boolean {
  if (!isRecord(response)) return false;
  if (response.is_error === true || response.isError === true) return true;
  const code = response.exit_code ?? response.exitCode;
  return typeof code === "number" && Number.isFinite(code) && code !== 0;
}

function field(raw: string, name: string): string | null {
  const match = new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]{1,200})"`).exec(raw);
  return match?.[1] ?? null;
}

function fieldAny(raw: string, names: readonly string[]): string | null {
  for (const name of names) {
    const found = field(raw, name);
    if (found) return found;
  }
  return null;
}

function responseFrom(raw: string): Record<string, unknown> | undefined {
  const exit = /"exit_code"\s*:\s*(-?\d+)/.exec(raw);
  const isError = /"(?:is_error|isError)"\s*:\s*true/.test(raw);
  if (!exit && !isError) return undefined;
  const code = exit ? Number(exit[1]) : undefined;
  return {
    ...(code !== undefined && Number.isFinite(code) ? { exit_code: code } : {}),
    ...(isError ? { is_error: true } : {}),
  };
}

function normalizedHook(record: Record<string, unknown>): Record<string, unknown> | null {
  const event = eventName(record);
  if (!event) return null;
  const name = toolName(record);
  const id = textField(record, "tool_use_id", "toolUseId") || stepTarget(record);
  const type = textField(record, "type", "notification_type", "notificationType");
  const response = record.tool_response ?? record.toolResponse ?? record.result;
  const error = typeof record.error === "string" ? record.error : undefined;
  // Each CLI names its conversation differently; session.ts picks the field.
  const sessionId = textField(record, "session_id");
  const camelSessionId = textField(record, "sessionId");
  const conversationId = textField(record, "conversationId");
  return {
    hook_event_name: event,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(camelSessionId ? { sessionId: camelSessionId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(name ? { tool_name: name } : {}),
    ...(id ? { tool_use_id: id } : {}),
    ...(type ? { type } : {}),
    ...(response !== undefined ? { tool_response: response } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Keep the fields activity needs. A complete body is parsed. A body split
 * around a huge tool input uses the head for names and the tail for the result.
 * Antigravity nests the tool under `toolCall` and identifies a step with `stepIdx`.
 */
export function observeHookWire(parts: { payload?: string; head?: string; tail?: string }): unknown {
  if (typeof parts.payload === "string") {
    try {
      const parsed = JSON.parse(parts.payload);
      if (isRecord(parsed)) return normalizedHook(parsed);
    } catch { /* truncated body */ }
    return scannedHook(parts.payload, parts.payload);
  }
  return scannedHook(parts.head ?? "", parts.tail ?? "");
}

function toolCallName(raw: string): string | null {
  const match = /"toolCall"\s*:\s*\{\s*"name"\s*:\s*"([^"\\]{1,200})"/.exec(raw);
  return match?.[1] ?? null;
}

function stepIndex(raw: string): number | undefined {
  const match = /"(?:stepIdx|step_idx)"\s*:\s*(\d+)/.exec(raw);
  if (!match) return undefined;
  const step = Number(match[1]);
  return Number.isInteger(step) ? step : undefined;
}

function scannedHook(head: string, tail: string): Record<string, unknown> | null {
  const event = fieldAny(head, ["hook_event_name", "hookEventName"]) ?? fieldAny(tail, ["hook_event_name", "hookEventName"]);
  if (!event) return null;
  const tool_name = fieldAny(head, ["tool_name", "toolName"]) ?? fieldAny(tail, ["tool_name", "toolName"])
    ?? toolCallName(head) ?? toolCallName(tail);
  const tool_use_id = fieldAny(head, ["tool_use_id", "toolUseId"]) ?? fieldAny(tail, ["tool_use_id", "toolUseId"]);
  const type = fieldAny(head, ["type", "notification_type", "notificationType"])
    ?? fieldAny(tail, ["type", "notification_type", "notificationType"]);
  const error = fieldAny(tail, ["error"]) ?? fieldAny(head, ["error"]);
  const stepIdx = stepIndex(head) ?? stepIndex(tail);
  const response = responseFrom(tail);
  const session_id = fieldAny(head, ["session_id"]) ?? fieldAny(tail, ["session_id"]);
  const sessionId = fieldAny(head, ["sessionId"]) ?? fieldAny(tail, ["sessionId"]);
  const conversationId = fieldAny(head, ["conversationId"]) ?? fieldAny(tail, ["conversationId"]);
  return normalizedHook({
    hook_event_name: event,
    ...(session_id ? { session_id } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(tool_name ? { tool_name } : {}),
    ...(tool_use_id ? { tool_use_id } : {}),
    ...(stepIdx !== undefined ? { stepIdx } : {}),
    ...(type ? { type } : {}),
    ...(response ? { tool_response: response } : {}),
    ...(error ? { error } : {}),
  });
}

function toolErrored(payload: Record<string, unknown>, force = false): boolean {
  if (force) return true;
  return toolFailed(payload.tool_response) || toolFailed(payload.toolResponse) || toolFailed(payload.result)
    || (typeof payload.error === "string" && payload.error.trim().length > 0)
    || isRecord(payload.error);
}

function toolEnd(cli: ExternalCli, payload: Record<string, unknown>, forceError = false): HookFact[] {
  const target = toolTarget(payload);
  const facts: HookFact[] = [
    { t: "external_turn" },
    { t: "external_permission_clear", requestId: permissionId(cli, payload) },
  ];
  if (target) facts.push({ t: "external_tool_end", target, isError: toolErrored(payload, forceError) });
  return facts;
}

/** Facts for one external CLI hook. Unknown events produce none. */
export function hookFacts(cli: ExternalCli, payload: unknown): HookFact[] {
  if (!isRecord(payload)) return [];
  switch (eventName(payload)) {
    case "UserPromptSubmit":
    case "SessionStart":
    case "SubagentStart":
      return [];
    case "PreInvocation":
      return cli === "gemini" ? [{ t: "external_turn" }] : [];
    case "PostInvocation":
      return [];
    case "PreToolUse": {
      const target = toolTarget(payload);
      return target ? [{ t: "external_turn" }, { t: "external_tool", target }] : [{ t: "external_turn" }];
    }
    case "PermissionRequest":
      return [{ t: "external_turn" }, { t: "external_permission", requestId: permissionId(cli, payload) }];
    case "Notification":
      if (cli === "muse") return museNotificationFacts(permissionId(cli, payload));
      return [];
    case "PostToolUse":
      return toolEnd(cli, payload);
    case "PostToolUseFailure":
      return toolEnd(cli, payload, true);
    case "Stop":
    case "StopFailure":
    case "SessionEnd":
      return [{ t: "external_stop" }];
    case "SubagentStop":
      return [{ t: "external_subagent_stop" }];
    default:
      return [];
  }
}

/** Activity signals for one hook. Permission uses the existing intervention owner. */
export function hookActivitySignals(cli: ExternalCli, payload: unknown, seq: number, at: number): ActivitySignal[] {
  const signals: ActivitySignal[] = [];
  for (const fact of hookFacts(cli, payload)) {
    if (fact.t === "external_permission") {
      signals.push({
        t: "intervention_requested",
        seq,
        at,
        requestId: fact.requestId,
        kind: "permission",
        since: at,
      });
      continue;
    }
    if (fact.t === "external_permission_clear") {
      signals.push({ t: "intervention_resolved", seq, at, requestId: fact.requestId });
      continue;
    }
    signals.push({ ...fact, seq, at });
  }
  return signals;
}
