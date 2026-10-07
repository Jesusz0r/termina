/**
 * `/mcp` status text and slash parsing.
 *
 * Config mutation stays in config.ts. This module does not connect, and it
 * does not invent an OAuth login Termina's client does not have.
 */
import { type McpConfigEdit, type McpInventoryEntry } from "./config.ts";
import { type McpServerReport } from "./client.ts";


export const MCP_SLASH_USAGE = [
  "/mcp                         list servers",
  "/mcp reconnect               reconnect all",
  "/mcp add http <name> <url>",
  "/mcp add stdio <name> -- <command> [args...]",
  "/mcp remove|disable|enable <name>",
  "Credentials belong in ~/.termina/agent/mcp.json (Authorization header or env). There is no MCP OAuth login.",
].join("\n");


export type McpSlash =
  | { action: "list" }
  | { action: "reconnect" }
  | { action: "edit"; edit: McpConfigEdit };


function splitTail(tail: string): string[] | null {
  const args: string[] = [];
  let index = 0;
  while (index < tail.length) {
    while (index < tail.length && /\s/.test(tail[index] ?? "")) index += 1;
    if (index >= tail.length) break;
    const quote = tail[index] === "\"" || tail[index] === "'" ? tail[index] : "";
    let current = "";
    if (quote) {
      index += 1;
      while (index < tail.length && tail[index] !== quote) {
        if (tail[index] === "\\") {
          index += 1;
          if (index >= tail.length) return null;
        }
        current += tail[index];
        index += 1;
      }
      if (index >= tail.length) return null;
      index += 1;
    } else {
      while (index < tail.length && !/\s/.test(tail[index] ?? "")) {
        current += tail[index];
        index += 1;
      }
    }
    args.push(current);
    if (args.length > 33) return null;
  }
  return args;
}


export function parseMcpSlash(line: string): McpSlash | { error: string } {
  const rest = line.trim().replace(/^\/mcp\b/, "").trim();
  if (!rest) return { action: "list" };
  if (rest === "reconnect") return { action: "reconnect" };
  const remove = /^(remove|disable|enable)\s+(\S+)$/.exec(rest);
  if (remove) return { action: "edit", edit: { op: remove[1] as "remove" | "disable" | "enable", name: remove[2]! } };
  const http = /^add\s+http\s+(\S+)\s+(\S+)$/.exec(rest);
  if (http) return { action: "edit", edit: { op: "add-http", name: http[1]!, url: http[2]! } };
  if (rest.startsWith("add stdio ")) {
    const tail = rest.slice("add stdio ".length);
    const splitAt = tail.indexOf(" -- ");
    if (splitAt <= 0) return { error: MCP_SLASH_USAGE };
    const name = tail.slice(0, splitAt).trim();
    if (!name || /\s/.test(name)) return { error: MCP_SLASH_USAGE };
    const argv = splitTail(tail.slice(splitAt + 4));
    if (!argv || argv.length === 0 || !argv[0]) return { error: MCP_SLASH_USAGE };
    return { action: "edit", edit: { op: "add-stdio", name, command: argv[0], args: argv.slice(1) } };
  }
  return { error: MCP_SLASH_USAGE };
}


const MCP_MENTION_SEPARATOR = /[\s,;]/u;
const MCP_MENTION_OPENING = "\"'`([{<";
const MCP_MENTION_CLOSING = "\"'`])}>.!?:";

/** Names a prompt actually says. Short names are ignored so ordinary words do not connect a server. */
export function mcpServersNamedIn(text: string, names: readonly string[]): string[] {
  const eligible = names.filter(name => name.length >= 3).map(name => name.toLowerCase());
  if (eligible.length === 0) return [];
  // Prefer complete names over their shorter pieces, including a literal final period.
  eligible.sort((a, b) => b.length - a.length);
  const input = text.toLowerCase();
  // Skip closing prose punctuation in constant time, even for long quote runs.
  const nextNonClosing = new Uint32Array(input.length + 1);
  nextNonClosing[input.length] = input.length;
  for (let index = input.length - 1; index >= 0; index--) {
    nextNonClosing[index] = MCP_MENTION_CLOSING.includes(input[index]!) ? nextNonClosing[index + 1]! : index;
  }
  const found = new Set<string>();
  mentions: for (let index = 0; index < input.length; index++) {
    if (index > 0 && !MCP_MENTION_SEPARATOR.test(input[index - 1]!)) continue;
    let start = index;
    while (start < input.length) {
      for (const name of eligible) {
        if (!input.startsWith(name, start)) continue;
        const end = nextNonClosing[start + name.length]!;
        if (end < input.length && !MCP_MENTION_SEPARATOR.test(input[end]!)) continue;
        found.add(name);
        index = end;
        continue mentions;
      }
      if (!MCP_MENTION_OPENING.includes(input[start]!)) break;
      start += 1;
    }
  }
  return names.filter(name => name.length >= 3 && found.has(name.toLowerCase()));
}


export function formatMcpStatus(
  entries: readonly McpInventoryEntry[],
  servers: readonly McpServerReport[] | null,
): string {
  const header = "MCP (~/.termina/agent/mcp.json)\nA prompt that names a server connects it. /mcp reconnect connects all.\nNo OAuth login. Put an Authorization header or env credential in that file.";
  if (entries.length === 0) return `${header}\n(no MCP servers)`;
  const live = new Map((servers ?? []).map((server) => [server.name, server]));
  const lines = entries.map((entry) => {
    const auth = entry.auth === "none" ? "auth none" : `auth ${entry.auth}`;
    const where = entry.target ? `  ${entry.transport} ${entry.target}` : `  ${entry.transport}`;
    if (entry.transport === "invalid") return `  ${entry.name}  invalid${where}  ${entry.problem ?? "invalid"}  ${auth}`;
    if (entry.disabled) return `  ${entry.name}  disabled${where}  ${auth}`;
    const report = live.get(entry.name);
    if (!servers || !report) return `  ${entry.name}  not connected${where}  ${auth}`;
    if (report.state === "needs-authentication") return `  ${entry.name}  needs authentication${where}  ${auth}`;
    if (report.state === "failed") return `  ${entry.name}  failed${where}  ${auth}`;
    return `  ${entry.name}  connected${where}  ${report.tools} tools  ${auth}`;
  });
  return `${header}\n${lines.join("\n")}`;
}
