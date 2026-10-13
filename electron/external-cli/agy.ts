/** Antigravity CLI (`agy`). Hooks live in `~/.gemini/config/hooks.json`. */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonObject, writeJson } from "./hook-config.ts";
import type { CliRoots, PreparedCli } from "./types.ts";

export const AGY_LAUNCH = { bin: "agy", label: "Gemini" };

const HOOK_NAME = "termina-observe";
const DIRECT_EVENTS = ["PreInvocation", "Stop"] as const;
const TOOL_EVENTS = ["PreToolUse", "PostToolUse"] as const;

function agyHookCommand(command: string, event: string): string {
  return `TERMINA_HOOK_EVENT=${event} ${command}`;
}

export function agyConfigHome(home = homedir()): string {
  return join(home, ".gemini");
}

export function agyHooksFile(configHome: string): string {
  return join(configHome, "config", "hooks.json");
}

export async function installAgyHooks(configHome: string, command: string): Promise<void> {
  const path = agyHooksFile(configHome);
  const current = await readJsonObject(path, "agy hooks are not a JSON object") ?? {};
  await mkdir(join(configHome, "config"), { recursive: true });
  const hook: Record<string, unknown> = {};
  for (const event of DIRECT_EVENTS) {
    hook[event] = [{ type: "command", command: agyHookCommand(command, event), timeout: 5 }];
  }
  for (const event of TOOL_EVENTS) {
    hook[event] = [{
      matcher: "*",
      hooks: [{ type: "command", command: agyHookCommand(command, event), timeout: 5 }],
    }];
  }
  await writeJson(path, { ...current, [HOOK_NAME]: hook });
}

export async function prepareAgy(command: string, roots: CliRoots): Promise<PreparedCli> {
  await installAgyHooks(agyConfigHome(roots.home), command);
  return { args: [], env: {} };
}
