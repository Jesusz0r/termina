/**
 * Subagent permission predicates.
 *
 * Owns approval-line recognition, live-run gating, and the child permission
 * mode that cannot grant `always` from a task file alone. File I/O stays in
 * approval.ts; the TUI picker queue stays in main.ts next to executeTool.
 * Extracted from agent-core/main.ts (issue #324).
 */
import type { PermissionMode } from "../main/tools.ts";

/** True when a submitted line answers the approval picker (deny/once/always/protected). */
export function isApprovalAnswer(line: string): boolean {
  return line === "/approve" || line.startsWith("/approve ");
}

/** A picker prompt is only valid for a live run; settled runs must not be asked about. */
export function isLiveSubagentRun(run: { state: string } | undefined): boolean {
  return run?.state === "active";
}

/**
 * Child permission mode (#206): the validated task file carries ask/dangerous
 * faithfully; `always` additionally requires the host bridge
 * (TERMINA_CORE_APPROVE=all), so a forged task file alone cannot grant it.
 */
export function resolveSubagentPermissionMode(
  taskMode: PermissionMode,
  approveEnv: string | undefined,
): PermissionMode {
  if (taskMode === "always") return approveEnv === "all" ? "always" : "ask";
  return taskMode;
}
