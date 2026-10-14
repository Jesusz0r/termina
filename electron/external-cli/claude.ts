/** Claude Code. Hooks merge into the user settings Claude reads on every launch. */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mergeHookEvents, readJsonObject, writeJson } from "./hook-config.ts";
import type { CliRoots, PreparedCli } from "./types.ts";

export const CLAUDE_LAUNCH = { bin: "claude", label: "Claude" };

const EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
] as const;

export function claudeConfigDir(home = homedir()): string {
  return join(home, ".claude");
}

export async function installClaudeSettings(dir: string, command: string): Promise<void> {
  const path = join(dir, "settings.json");
  const current = await readJsonObject(path, "claude settings are not a JSON object") ?? {};
  await mkdir(dir, { recursive: true });
  await writeJson(path, { ...current, hooks: mergeHookEvents(current.hooks, EVENTS, command, 5) });
}

export function claudeLaunchArgs(): string[] {
  return [];
}

export async function prepareClaude(command: string, roots: CliRoots): Promise<PreparedCli> {
  await installClaudeSettings(claudeConfigDir(roots.home), command);
  return { args: claudeLaunchArgs(), env: {} };
}
