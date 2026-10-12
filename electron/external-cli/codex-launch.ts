/**
 * Launch the original Codex TUI with an observational hook profile.
 * The profile is additive. It does not replace the user's Codex config,
 * and it does not bypass hook trust.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { durableAtomicWrite } from "../../shared/durable-write.ts";

export const CODEX_PROFILE_NAME = "termina";

export const CODEX_HOOK_EVENTS = [
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

/** Args for `codex`. Trust review stays Codex's own `/hooks` flow. */
export function codexLaunchArgs(): string[] {
  return ["-p", CODEX_PROFILE_NAME];
}

export function codexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? configured : join(home, ".codex");
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
  for (const event of CODEX_HOOK_EVENTS) {
    lines.push(`[[hooks.${event}]]`);
    lines.push(`[[hooks.${event}.hooks]]`);
    lines.push(`type = "command"`);
    lines.push(`command = ${tomlBasic(command)}`);
    lines.push(`timeout = 5`);
  }
  lines.push("");
  return lines.join("\n");
}

export const CODEX_HOOK_SCRIPT = `#!/usr/bin/env node
import { connect } from "node:net";
import { readFileSync } from "node:fs";

const MAX = 256 * 1024;

function finish() {
  try { process.stdout.write("{}\\n"); } catch { /* observational hook still exits 0 */ }
}

try {
  const socketPath = process.env.TERMINA_CODEX_HOOK_SOCKET ?? "";
  const token = process.env.TERMINA_CODEX_HOOK_TOKEN ?? "";
  const terminalId = process.env.TERMINA_TERMINAL_ID ?? "";
  const generation = Number(process.env.TERMINA_TERMINAL_GENERATION);
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { raw = ""; }
  if (raw.length > MAX) raw = raw.slice(0, MAX);
  if (!socketPath || !token || !terminalId || !Number.isInteger(generation)) {
    finish();
    process.exit(0);
  }
  const body = JSON.stringify({ v: 1, token, terminalId, generation, payload: raw });
  const sock = connect(socketPath);
  const done = () => { sock.destroy(); finish(); process.exit(0); };
  sock.setTimeout(1000);
  sock.on("timeout", done);
  sock.on("error", done);
  sock.on("connect", () => sock.end(body));
  sock.on("close", done);
} catch {
  finish();
  process.exit(0);
}
`;

export async function writeCodexHookScript(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, CODEX_HOOK_SCRIPT, { mode: 0o755 });
}

export async function writeCodexProfile(codexHomeDir: string, command: string): Promise<void> {
  await mkdir(codexHomeDir, { recursive: true });
  await durableAtomicWrite(join(codexHomeDir, `${CODEX_PROFILE_NAME}.config.toml`), codexProfileToml(command));
}
