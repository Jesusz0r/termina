/**
 * Codex hook payloads → the shared activity signals.
 *
 * Observational only. This does not approve a tool, inject a prompt, or
 * decide that a Stop hook finished the turn. UserPromptSubmit can still be
 * rejected by another hook, so it does not start work.
 */
import type { ActivitySignal } from "../agent-activity.ts";
import { isRecord } from "../../shared/guards.ts";

export type CodexHookFact =
  | { t: "external_turn" }
  | { t: "external_stop" }
  | { t: "external_permission"; requestId: string }
  | { t: "external_permission_clear"; requestId: string }
  | { t: "external_tool"; target: string }
  | { t: "external_tool_end"; target: string; isError: boolean }
  | { t: "external_subagent_stop" };

function toolTarget(record: Record<string, unknown>): string {
  if (typeof record.tool_use_id === "string" && record.tool_use_id.trim()) return record.tool_use_id.trim();
  if (typeof record.tool_name === "string" && record.tool_name.trim()) return record.tool_name.trim();
  return "";
}

function permissionId(record: Record<string, unknown>): string {
  if (typeof record.tool_name === "string" && record.tool_name.trim()) return `codex:${record.tool_name.trim()}`;
  return "codex:permission";
}

function toolFailed(response: unknown): boolean {
  if (!isRecord(response)) return false;
  if (response.is_error === true || response.isError === true) return true;
  const code = response.exit_code ?? response.exitCode;
  return typeof code === "number" && Number.isFinite(code) && code !== 0;
}

/** Facts for one Codex hook JSON object. Unknown events produce none. */
export function codexHookFacts(payload: unknown): CodexHookFact[] {
  if (!isRecord(payload) || typeof payload.hook_event_name !== "string") return [];
  switch (payload.hook_event_name) {
    case "UserPromptSubmit":
    case "SessionStart":
    case "SubagentStart":
      return [];
    case "PreToolUse": {
      const target = toolTarget(payload);
      return target ? [{ t: "external_turn" }, { t: "external_tool", target }] : [{ t: "external_turn" }];
    }
    case "PermissionRequest":
      return [{ t: "external_turn" }, { t: "external_permission", requestId: permissionId(payload) }];
    case "PostToolUse": {
      const target = toolTarget(payload);
      const end: CodexHookFact[] = [
        { t: "external_turn" },
        { t: "external_permission_clear", requestId: permissionId(payload) },
      ];
      if (target) end.push({ t: "external_tool_end", target, isError: toolFailed(payload.tool_response) });
      return end;
    }
    case "Stop":
    case "SessionEnd":
      return [{ t: "external_stop" }];
    case "SubagentStop":
      return [{ t: "external_subagent_stop" }];
    default:
      return [];
  }
}

/** Activity signals for one hook. Permission uses the existing intervention owner. */
export function codexActivitySignals(payload: unknown, seq: number, at: number): ActivitySignal[] {
  const signals: ActivitySignal[] = [];
  for (const fact of codexHookFacts(payload)) {
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
