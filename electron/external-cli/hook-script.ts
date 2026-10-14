/**
 * One observational hook script for every external CLI.
 * It prints `{}` and does not approve a tool or inject a prompt.
 */
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Single-quote a shell word. Hook commands run through a shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function hookCommand(nodePath: string, scriptPath: string): string {
  return `${shellQuote(nodePath)} ${shellQuote(scriptPath)}`;
}

/** Node that can run the hook when the app's PATH does not include nvm or Homebrew. */
export function resolveHookNode(cliBin: string, lookup: (name: string) => string | null = () => null): string | null {
  const sibling = join(dirname(cliBin), "node");
  try {
    accessSync(sibling, constants.X_OK);
    return sibling;
  } catch {
    return lookup("node");
  }
}

const HOOK_SCRIPT = `#!/usr/bin/env node
import { connect } from "node:net";

const HEAD = 32 * 1024;
const TAIL = 16 * 1024;

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  process.stdout.write("{}\\n", () => process.exit(0));
}

function stampEvent(text) {
  const hint = process.env.TERMINA_HOOK_EVENT || "";
  if (!hint) return text;
  const at = text.indexOf("{");
  if (at < 0 || text.slice(0, at).trim() !== "") return text;
  const nearStart = text.slice(at, at + 400);
  if (/"(?:hook_event_name|hookEventName|event_name|eventName)"/.test(nearStart)) return text;
  return text.slice(0, at + 1) + '"hook_event_name":' + JSON.stringify(hint) + "," + text.slice(at + 1);
}

function hookCli() {
  const named = process.env.TERMINA_EXTERNAL_CLI || "";
  if (named) return named;
  // Installed agy hooks set only the event. That prefix is agy's.
  return process.env.TERMINA_HOOK_EVENT ? "gemini" : "";
}

try {
  const socketPath = process.env.TERMINA_EXTERNAL_HOOK_SOCKET ?? "";
  const token = process.env.TERMINA_EXTERNAL_HOOK_TOKEN ?? "";
  const terminalId = process.env.TERMINA_TERMINAL_ID ?? "";
  const generation = Number(process.env.TERMINA_TERMINAL_GENERATION);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.from(stampEvent(Buffer.concat(chunks).toString("utf8")));
  const cli = hookCli();
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
  if (cli) wire.cli = cli;
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

export async function writeHookScript(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, HOOK_SCRIPT);
  await chmod(path, 0o755);
}
