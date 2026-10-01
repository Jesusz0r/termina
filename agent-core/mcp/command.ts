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


const MCP_NAME_TOKEN = /[^A-Za-z0-9]+/;

/** Names a prompt actually says. Short names are ignored so ordinary words do not connect a server. */
export function mcpServersNamedIn(text: string, names: readonly string[]): string[] {
  const tokens = new Set(text.split(MCP_NAME_TOKEN).map((token) => token.toLowerCase()).filter((token) => token.length >= 3));
  const found: string[] = [];
  for (const name of names) {
    if (name.length < 3 || !tokens.has(name.toLowerCase())) continue;
    found.push(name);
  }
  return found;
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
