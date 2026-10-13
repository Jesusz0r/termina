/**
 * Codex TUI. The profile is additive and does not bypass hook trust.
 */
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { durableAtomicWrite } from "../../shared/durable-write.ts";
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
  return ["-p", PROFILE_NAME];
}

export function codexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.CODEX_HOME?.trim();
  if (configured && isAbsolute(configured) && !configured.includes("\0")) return configured;
  return join(home, ".codex");
}

function tomlBasic(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

/** Profile text. The command prints `{}` and does not steer Codex. */
export function codexProfileToml(command: string): string {
  const lines = [
    "# Termina observational hooks. Codex merges this profile with user hooks.",
    "# Trust the command in Codex with /hooks. This file does not grant approvals.",
  ];
  for (const event of HOOK_EVENTS) {
    lines.push(`[[hooks.${event}]]`);
    lines.push(`[[hooks.${event}.hooks]]`);
    lines.push(`type = "command"`);
    lines.push(`command = ${tomlBasic(command)}`);
    lines.push(`timeout = 5`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeCodexProfile(codexHomeDir: string, command: string): Promise<void> {
  await mkdir(codexHomeDir, { recursive: true });
  const path = join(codexHomeDir, `${PROFILE_NAME}.config.toml`);
  const next = codexProfileToml(command);
  try {
    if (await readFile(path, "utf8") === next) return;
  } catch { /* create it */ }
  await durableAtomicWrite(path, next);
}

export async function prepareCodex(command: string, roots: CliRoots): Promise<PreparedCli> {
  await writeCodexProfile(codexHome(roots.env, roots.home), command);
  return { args: codexLaunchArgs(), env: {} };
}
