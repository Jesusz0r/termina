/** Grok. One file in the hooks directory; other files there stay. */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { hookConfig, writeJson } from "./hook-config.ts";
import type { CliRoots, PreparedCli } from "./types.ts";

export const GROK_LAUNCH = { bin: "grok", label: "Grok" };

const EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "Stop", "SubagentStart", "SubagentStop",
] as const;

export function grokHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.GROK_HOME?.trim();
  if (configured && isAbsolute(configured) && !configured.includes("\0")) return configured;
  return join(home, ".grok");
}

export async function installGrokHooks(grokHomeDir: string, command: string): Promise<void> {
  const dir = join(grokHomeDir, "hooks");
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "termina.json"), hookConfig(EVENTS, command, 5));
}

export async function prepareGrok(command: string, roots: CliRoots): Promise<PreparedCli> {
  await installGrokHooks(grokHome(roots.env, roots.home), command);
  return { args: [], env: {} };
}
