/**
 * Launch the original Codex TUI with an observational hook profile.
 * The profile is additive. It does not replace the user's Codex config,
 * and it does not bypass hook trust.
 */
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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
  if (configured && isAbsolute(configured) && !configured.includes("\0")) return configured;
  return join(home, ".codex");
}

/** Single-quote a shell word. Codex runs the hook command through a shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function codexHookCommand(nodePath: string, scriptPath: string): string {
  return `${shellQuote(nodePath)} ${shellQuote(scriptPath)}`;
}

/** Node that can run the hook when the app's PATH does not include nvm or Homebrew. */
export function resolveCodexNode(codexBin: string, lookup: (name: string) => string | null = () => null): string | null {
  const sibling = join(dirname(codexBin), "node");
  try {
    accessSync(sibling, constants.X_OK);
    return sibling;
  } catch {
    return lookup("node");
  }
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

const HEAD = 32 * 1024;
const TAIL = 16 * 1024;

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  process.stdout.write("{}\\n", () => process.exit(0));
}

try {
  const socketPath = process.env.TERMINA_EXTERNAL_HOOK_SOCKET ?? "";
  const token = process.env.TERMINA_EXTERNAL_HOOK_TOKEN ?? "";
  const terminalId = process.env.TERMINA_TERMINAL_ID ?? "";
  const generation = Number(process.env.TERMINA_TERMINAL_GENERATION);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks);
  let wire;
  if (input.length <= HEAD) {
    wire = { v: 1, token, terminalId, generation, payload: input.toString("utf8") };
  } else {
    wire = {
      v: 1, token, terminalId, generation,
      head: input.subarray(0, HEAD).toString("utf8"),
      tail: input.subarray(input.length - TAIL).toString("utf8"),
    };
  }
  if (!socketPath || !token || !terminalId || !Number.isInteger(generation)) {
    finish();
  } else {
    const body = JSON.stringify(wire);
    const sock = connect(socketPath);
    let sent = false;
    const done = () => {
      if (sent) return;
      sent = true;
      sock.destroy();
      finish();
    };
    sock.setTimeout(1000);
    sock.on("timeout", done);
    sock.on("error", done);
    sock.on("connect", () => sock.end(body));
    sock.on("close", done);
  }
} catch {
  finish();
}
`;

export async function writeCodexHookScript(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, CODEX_HOOK_SCRIPT);
  await chmod(path, 0o755);
}

export async function writeCodexProfile(codexHomeDir: string, command: string): Promise<void> {
  await mkdir(codexHomeDir, { recursive: true });
  const path = join(codexHomeDir, `${CODEX_PROFILE_NAME}.config.toml`);
  const next = codexProfileToml(command);
  try {
    if (await readFile(path, "utf8") === next) return;
  } catch { /* create it */ }
  await durableAtomicWrite(path, next);
}
