/**
 * Host → agent environment filter (issue #44).
 *
 * The primary agent and headless subagents inherit the host environment so the
 * toolchain (PATH, HOME, provider credentials, locale) keeps working, but a few
 * host variables must never cross the spawn boundary:
 *
 * - Node/loader injection: NODE_OPTIONS and NODE_PATH are in-process RCE in the
 *   agent (a hostile `--require` hook sees credentials and the project FS), and
 *   LD_PRELOAD / LD_LIBRARY_PATH / DYLD_* hijack native library loading for
 *   the child.
 * - ELECTRON_* pins: the host's Electron flags must not leak into children; the
 *   spawn sites set ELECTRON_RUN_AS_NODE explicitly after filtering.
 * - Session pins: PI_* (any pi-mono leftover) and TERMINA_CORE_SESSION_* would
 *   attach the child to the wrong session; the spawn sites mint fresh session
 *   bindings explicitly after filtering. TERMINA_CORE_RESUME is launch-only and
 *   likewise minted per spawn.
 *
 * This is a denylist, not the candidate allowlist: the primary agent is the
 * user's own process and needs ambient credentials and config. Candidates stay
 * on filterCandidateEnvironment in electron/sandbox.ts; MCP servers stay on
 * mcpEnv in agent-core/mcp.ts.
 */

/** Exact host variables that never reach an agent child. */
const AGENT_ENV_DENY_EXACT = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "TERMINA_CORE_RESUME",
]);

/** Host variable prefixes that never reach an agent child. */
const AGENT_ENV_DENY_PREFIX = ["PI_", "TERMINA_CORE_SESSION_", "DYLD_", "ELECTRON_"] as const;

/**
 * Pure agent-env policy used by main's cleanEnv factory. Copies the host env
 * minus loader-injection variables, Electron pins, and session pins. The
 * caller sets the child's own ELECTRON_RUN_AS_NODE / TERMINA_CORE_SESSION_*
 * bindings after filtering.
 */
export function filterAgentEnvironment(
  hostEnv: NodeJS.Dict<string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (!key || AGENT_ENV_DENY_EXACT.has(key)) continue;
    let denied = false;
    for (const prefix of AGENT_ENV_DENY_PREFIX) {
      if (key.startsWith(prefix)) {
        denied = true;
        break;
      }
    }
    if (!denied) env[key] = value;
  }
  return env;
}
