/**
 * MCP server configuration.
 *
 * Owns config parsing/loading, cwd jailing, and shared budgets.
 * Split from agent-core/mcp.ts (issue #38).
 */
import { outboundUrlError } from "../main/url.ts";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";


export const MAX_MCP_SERVERS = 8;

export const MAX_MCP_TOOLS = 32;

export const MAX_MCP_TOOL_BYTES = 64 * 1024;

export const MAX_MCP_JSON_BYTES = 64 * 1024;

export const MCP_HANDSHAKE_MS = 10_000;

export const MCP_CALL_MS = 60_000;

export const MCP_RESULT_BYTES = 20 * 1024;

export const MCP_PROTOCOL = "2024-11-05";

export const MCP_HTTP_BODY_BYTES = 256 * 1024;


export type McpServerConfig = {
  name: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
};


export const SCHEMA_CAP = 8 * 1024;

export const SCHEMA_MAX_DEPTH = 64;

const HEADER_SKIP = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
]);


function parseStringMap(raw: unknown, maxKeys: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || !k || k.length > 128) continue;
    if (typeof v !== "string" || v.length > 4096) continue;
    out[k] = v;
    if (Object.keys(out).length >= maxKeys) break;
  }
  return out;
}


export function parseHeaderMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseStringMap(raw, 32))) {
    const name = k.toLowerCase();
    if (HEADER_SKIP.has(name) || /[\0\n\r]/.test(k) || /[\0\n\r]/.test(v)) continue;
    out[k] = v;
  }
  return out;
}


export function mcpHttpUrlError(url: string): string | null {
  if (!url || url.length > 2048) return "error: invalid URL";
  return outboundUrlError(url);
}


function parseOneServer(name: string, rec: unknown): McpServerConfig | "disabled" | null {
  if (!name || name.length > 64) return null;
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const obj = rec as Record<string, unknown>;
  if (obj.disabled === true) return "disabled";
  const args: string[] = [];
  if (Array.isArray(obj.args)) {
    for (const a of obj.args) {
      if (typeof a !== "string" || a.length > 4096 || /[\0]/.test(a)) continue;
      args.push(a);
      if (args.length >= 32) break;
    }
  }
  const env = parseStringMap(obj.env, 32);
  let cwd: string | undefined;
  if (typeof obj.cwd === "string" && obj.cwd.trim() && obj.cwd.length <= 1024 && !/[\0]/.test(obj.cwd)) {
    cwd = obj.cwd.trim();
  }
  const url = typeof obj.url === "string" ? obj.url.trim() : "";
  const httpType = obj.type === "http" || obj.type === "sse";
  if (url || httpType) {
    if (!url || mcpHttpUrlError(url)) return null;
    return { name, args, env, cwd, url, headers: parseHeaderMap(obj.headers) };
  }
  if (typeof obj.command !== "string" || !obj.command.trim() || obj.command.length > 512) return null;
  if (/[\0\n]/.test(obj.command)) return null;
  return { name, command: obj.command.trim(), args, env, cwd };
}


export function parseMcpConfig(raw: unknown): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  applyMcpConfig(byName, raw);
  return [...byName.values()].slice(0, MAX_MCP_SERVERS);
}


function applyMcpConfig(byName: Map<string, McpServerConfig>, raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const servers = (raw as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const [name, rec] of Object.entries(servers as Record<string, unknown>)) {
    const parsed = parseOneServer(name, rec);
    if (parsed === "disabled") {
      byName.delete(name);
      continue;
    }
    if (!parsed) continue;
    byName.set(name, parsed);
  }
}


function readMcpFile(path: string): unknown | null {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_MCP_JSON_BYTES) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}


/** Load servers only from the user-owned configuration file. */
export function loadMcpConfigs(userFile: string): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  applyMcpConfig(byName, readMcpFile(userFile));
  return [...byName.values()].slice(0, MAX_MCP_SERVERS);
}


export function jailMcpCwd(projectRoot: string, requested: string | undefined): string | null {
  let root = resolve(projectRoot);
  try {
    root = realpathSync(root);
  } catch {
    /* missing project root still jails by lexical path */
  }
  if (!requested) return root;
  const abs = resolve(isAbsolute(requested) ? requested : join(root, requested));
  try {
    const real = realpathSync(abs);
    const rel = relative(root, real);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return real;
    return null;
  } catch {
    const rel = relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
    return null;
  }
}


export function userMcpPath(home: string): string {
  return join(home, ".termina", "agent", "mcp.json");
}
