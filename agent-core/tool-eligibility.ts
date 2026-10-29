/**
 * One tool-eligibility policy for session declarations and call admission.
 *
 * A `/plan` turn does not remove tools from the session prefix. P1 freezes
 * tool schemas for the session; the next request in that session still has
 * to implement. Admission refuses the calls the executor will not run.
 * Bash approval is not an omission: the tool stays declared, and the
 * existing confirm path decides the command.
 */
import { READ_TOOLS } from "./tool-dispatch.ts";

export type SessionToolScope = {
  worldlineCandidate: boolean;
  /** False only when the process is already at the subagent depth cap. */
  subagentToolsVisible: boolean;
};

const SUBAGENT_TOOL_NAMES = new Set(["spawn_subagent", "message_subagent"]);

/** Process-stable omissions. Turn-scoped `/plan` is not one of them. */
export function sessionOmitsTool(name: string, scope: SessionToolScope): boolean {
  if (!scope.subagentToolsVisible && SUBAGENT_TOOL_NAMES.has(name)) return true;
  return scope.worldlineCandidate && name === "spawn_subagent";
}

/** True when a `/plan` turn must refuse the call. Reads stay admitted. */
export function planTurnRejectsTool(name: string): boolean {
  return !READ_TOOLS.has(name);
}

/** Read-only sessions inspect local files without shell, network, or MCP access. */
export function readOnlyRejectsTool(name: string): boolean {
  return planTurnRejectsTool(name) || name === "fetch";
}

/** Discovery adapters are declared only while a catalog exists. */
export function mcpDiscoveryDeclared(catalogSize: number): boolean {
  return catalogSize > 0;
}
