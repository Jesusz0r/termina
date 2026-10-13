/**
 * Additive hook install for each external CLI.
 * Writes only Termina's own file, or merges one command into an existing
 * settings object without removing the user's other keys or hooks.
 */
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { errorCode, isRecord } from "../../shared/guards.ts";
import { durableAtomicWrite } from "../../shared/durable-write.ts";
import type { ExternalCli } from "../../shared/types.ts";

const CLAUDE_EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
] as const;

const GROK_EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "Stop", "SubagentStart", "SubagentStop",
] as const;

const GEMINI_EVENTS = [
  "SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "Notification",
] as const;

const MUSE_EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStart", "SubagentStop", "Notification",
] as const;

export const EXTERNAL_CLI_LAUNCH = {
  codex: { bin: "codex", label: "Codex" },
  claude: { bin: "claude", label: "Claude" },
  grok: { bin: "grok", label: "Grok" },
  gemini: { bin: "gemini", label: "Gemini" },
  muse: { bin: "muse", label: "Muse" },
} as const satisfies Record<ExternalCli, { bin: string; label: string }>;

export function externalCliLaunch(cli: ExternalCli): { bin: string; label: string } {
  return EXTERNAL_CLI_LAUNCH[cli];
}

export type PreparedCli = {
  args: string[];
  env: Record<string, string>;
};

function commandGroup(command: string, timeout: number, name?: string): Record<string, unknown> {
  return {
    hooks: [{
      ...(name ? { name } : {}),
      type: "command",
      command,
      timeout,
    }],
  };
}

export function hookConfig(events: readonly string[], command: string, timeout: number, name?: string): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const event of events) hooks[event] = [commandGroup(command, timeout, name)];
  return { hooks };
}

const TERMINA_HOOK_SCRIPT = "external-hook.mjs";

function withoutTerminaHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(existing)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups.filter((group) => !JSON.stringify(group).includes(TERMINA_HOOK_SCRIPT));
    if (kept.length > 0) hooks[event] = kept;
  }
  return hooks;
}

function mergeHookEvents(
  existing: unknown,
  events: readonly string[],
  command: string,
  timeout: number,
  name?: string,
): Record<string, unknown> {
  const hooks = withoutTerminaHooks(isRecord(existing) ? existing : {});
  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    groups.push(commandGroup(command, timeout, name));
    hooks[event] = groups;
  }
  return hooks;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (await readFile(path, "utf8") === next) return;
  } catch { /* create it */ }
  await durableAtomicWrite(path, next);
}

export async function installClaudeSettings(dir: string, command: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "claude-hooks.json");
  await writeJson(path, hookConfig(CLAUDE_EVENTS, command, 5));
  return path;
}

export function claudeLaunchArgs(settingsPath: string): string[] {
  return ["--settings", settingsPath];
}

export function grokHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.GROK_HOME?.trim();
  if (configured && isAbsolute(configured) && !configured.includes("\0")) return configured;
  return join(home, ".grok");
}

export async function installGrokHooks(grokHomeDir: string, command: string): Promise<void> {
  const dir = join(grokHomeDir, "hooks");
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "termina.json"), hookConfig(GROK_EVENTS, command, 5));
}

export function geminiSettingsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.GEMINI_CLI_HOME?.trim();
  if (configured && isAbsolute(configured) && !configured.includes("\0")) return configured;
  return join(home, ".gemini");
}

/** Merge Termina's hooks into the user settings file. A system-settings override would replace the user's other Gemini settings. */
export async function installGeminiSettings(configDir: string, command: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const settingsPath = join(configDir, "settings.json");
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!isRecord(parsed)) throw new Error("gemini settings are not a JSON object");
    current = parsed;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await writeJson(settingsPath, {
    ...current,
    hooks: mergeHookEvents(current.hooks, GEMINI_EVENTS, command, 5000, "termina-observe"),
  });
}

export function museConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.XDG_CONFIG_HOME?.trim();
  const root = configured && isAbsolute(configured) && !configured.includes("\0") ? configured : join(home, ".config");
  return join(root, "muse");
}

export async function installMuseHooks(configDir: string, command: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const managed = join(configDir, "termina-hooks.json");
  await writeJson(managed, hookConfig(MUSE_EVENTS, command, 5));
  const settingsPath = join(configDir, "settings.json");
  let current: Record<string, unknown> = {};
  let existed = false;
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!isRecord(parsed)) throw new Error("muse settings are not a JSON object");
    current = parsed;
    existed = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const foreign = typeof current.managed_hooks_path === "string" && current.managed_hooks_path !== managed;
  const next: Record<string, unknown> = foreign
    ? { ...current, hooks: mergeHookEvents(current.hooks, MUSE_EVENTS, command, 5) }
    : { ...current, managed_hooks_path: managed, ...(existed ? {} : { schema_version: 1 }) };
  await writeJson(settingsPath, next);
}

export async function prepareExternalCli(cli: ExternalCli, command: string, roots: {
  userData: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): Promise<PreparedCli> {
  const env = roots.env ?? process.env;
  const home = roots.home ?? homedir();
  if (cli === "codex") return { args: [], env: {} };
  if (cli === "claude") {
    const settings = await installClaudeSettings(roots.userData, command);
    return { args: claudeLaunchArgs(settings), env: {} };
  }
  if (cli === "grok") {
    await installGrokHooks(grokHome(env, home), command);
    return { args: [], env: {} };
  }
  if (cli === "gemini") {
    await installGeminiSettings(geminiSettingsDir(env, home), command);
    return { args: [], env: {} };
  }
  await installMuseHooks(museConfigDir(env, home), command);
  return { args: [], env: {} };
}
