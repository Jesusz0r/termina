/** Claude Code. Additional settings for one launch; the user's settings file stays untouched. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hookConfig, writeJson } from "./hook-config.ts";
import type { CliRoots, PreparedCli } from "./types.ts";

export const CLAUDE_LAUNCH = { bin: "claude", label: "Claude" };

const EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
] as const;

export async function installClaudeSettings(dir: string, command: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "claude-hooks.json");
  await writeJson(path, hookConfig(EVENTS, command, 5));
  return path;
}

export function claudeLaunchArgs(settingsPath: string): string[] {
  return ["--settings", settingsPath];
}

export async function prepareClaude(command: string, roots: CliRoots): Promise<PreparedCli> {
  const settings = await installClaudeSettings(roots.userData, command);
  return { args: claudeLaunchArgs(settings), env: {} };
}
