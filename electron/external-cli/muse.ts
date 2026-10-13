/** Muse Code. A managed hooks file, unless the user already points elsewhere. */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { hookConfig, mergeHookEvents, readJsonObject, writeJson } from "./hook-config.ts";
import type { HookFact } from "./activity.ts";
import type { CliRoots, PreparedCli } from "./types.ts";

export const MUSE_LAUNCH = { bin: "muse", label: "Muse" };

const EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStart", "SubagentStop", "Notification",
] as const;

/** Muse uses Notification as the approval wait. Other CLIs do not. */
export function museNotificationFacts(requestId: string): HookFact[] {
  return [
    { t: "external_turn" },
    { t: "external_permission", requestId },
  ];
}

export function museConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.XDG_CONFIG_HOME?.trim();
  const root = configured && isAbsolute(configured) && !configured.includes("\0") ? configured : join(home, ".config");
  return join(root, "muse");
}

export async function installMuseHooks(configDir: string, command: string): Promise<void> {
  const managed = join(configDir, "termina-hooks.json");
  const settingsPath = join(configDir, "settings.json");
  const current = await readJsonObject(settingsPath, "muse settings are not a JSON object");
  await mkdir(configDir, { recursive: true });
  await writeJson(managed, hookConfig(EVENTS, command, 5));
  const existed = current !== null;
  const settings = current ?? {};
  const foreign = typeof settings.managed_hooks_path === "string" && settings.managed_hooks_path !== managed;
  const next: Record<string, unknown> = foreign
    ? { ...settings, hooks: mergeHookEvents(settings.hooks, EVENTS, command, 5) }
    : { ...settings, managed_hooks_path: managed, ...(existed ? {} : { schema_version: 1 }) };
  await writeJson(settingsPath, next);
}

export async function prepareMuse(command: string, roots: CliRoots): Promise<PreparedCli> {
  await installMuseHooks(museConfigDir(roots.env, roots.home), command);
  return { args: [], env: {} };
}
