/**
 * Codex TUI. User hooks live in `~/.codex/hooks.json`, which Codex loads on
 * every launch. The command does not bypass hook trust.
 */
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { mergeHookEvents, readJsonObject, writeJson } from "./hook-config.ts";
import type { CliRoots, PreparedCli } from "./types.ts";

export const CODEX_LAUNCH = { bin: "codex", label: "Codex" };

const PROFILE_NAME = "termina";

const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "SubagentStart",
  "SubagentStop",
] as const;

export function codexLaunchArgs(): string[] {
  return [];
}

export function codexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.CODEX_HOME?.trim();
  if (configured && isAbsolute(configured) && !configured.includes("\0")) return configured;
  return join(home, ".codex");
}

export async function installCodexHooks(codexHomeDir: string, command: string): Promise<void> {
  await mkdir(codexHomeDir, { recursive: true });
  const path = join(codexHomeDir, "hooks.json");
  const current = await readJsonObject(path, "codex hooks are not a JSON object") ?? {};
  await writeJson(path, { ...current, hooks: mergeHookEvents(current.hooks, HOOK_EVENTS, command, 5) });
  await rm(join(codexHomeDir, `${PROFILE_NAME}.config.toml`), { force: true });
}

export async function prepareCodex(command: string, roots: CliRoots): Promise<PreparedCli> {
  await installCodexHooks(codexHome(roots.env, roots.home), command);
  return { args: codexLaunchArgs(), env: {} };
}
