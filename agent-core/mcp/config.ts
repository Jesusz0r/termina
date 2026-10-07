/**
 * MCP server configuration.
 *
 * Owns config parsing/loading, cwd jailing, and shared budgets.
 * Split from agent-core/mcp.ts (issue #38).
 */
import { outboundUrlError } from "../main/url.ts";
import { durableAtomicWrite } from "../../shared/durable-write.ts";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";


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


export type McpInventoryEntry = {
  name: string;
  disabled: boolean;
  transport: "stdio" | "http" | "invalid";
  /** Credential posture only. Never a header value, env value, or query string. */
  auth: "header" | "env" | "none";
  /** Command name or URL host. Not args, path, or query. */
  target: string;
  problem: string | null;
};


export type McpConfigEdit =
  | { op: "add-http"; name: string; url: string }
  | { op: "add-stdio"; name: string; command: string; args: string[] }
  | { op: "remove"; name: string }
  | { op: "disable"; name: string }
  | { op: "enable"; name: string };


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function mcpServerNameError(name: string): string | null {
  if (!name || name.length > 64 || /[\0\n\r\s]/.test(name)) return "server name must be 1-64 characters without whitespace";
  return null;
}


function publicHttpTarget(url: string): string {
  try {
    return new URL(url).host || "http";
  } catch {
    return "http";
  }
}


function authPosture(rec: Record<string, unknown>): McpInventoryEntry["auth"] {
  if (isRecord(rec.headers)) {
    for (const key of Object.keys(rec.headers)) {
      if (key.toLowerCase() === "authorization" && typeof rec.headers[key] === "string" && rec.headers[key]) return "header";
    }
  }
  if (isRecord(rec.env) && Object.keys(rec.env).length > 0) return "env";
  return "none";
}


/** Every configured server, including disabled and invalid entries the connect path skips. */
export function inspectMcpConfig(raw: unknown): McpInventoryEntry[] {
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) return [];
  const rows: McpInventoryEntry[] = [];
  for (const [name, rec] of Object.entries(raw.mcpServers)) {
    if (!isRecord(rec)) {
      rows.push({ name, disabled: false, transport: "invalid", auth: "none", target: "", problem: "server entry is not an object" });
      continue;
    }
    const disabled = rec.disabled === true;
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    const httpType = rec.type === "http" || rec.type === "sse";
    if (url || httpType) {
      const problem = !url ? "missing URL" : mcpHttpUrlError(url);
      rows.push({
        name,
        disabled,
        transport: problem ? "invalid" : "http",
        auth: authPosture(rec),
        target: url ? publicHttpTarget(url) : "http",
        problem,
      });
      continue;
    }
    const command = typeof rec.command === "string" ? rec.command.trim() : "";
    if (!command) {
      rows.push({ name, disabled, transport: "invalid", auth: authPosture(rec), target: "", problem: "missing command" });
      continue;
    }
    rows.push({ name, disabled, transport: "stdio", auth: authPosture(rec), target: command, problem: null });
  }
  return rows;
}


function enabledCount(raw: unknown): number {
  return inspectMcpConfig(raw).filter((row) => !row.disabled && row.transport !== "invalid").length;
}


function configRoot(raw: unknown): Record<string, unknown> {
  const root = isRecord(raw) ? { ...raw } : {};
  root.mcpServers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {};
  return root;
}


/** Return a new config object. Does not write. Refuses a ninth enabled server. */
export function editMcpConfig(raw: unknown, edit: McpConfigEdit): { ok: true; value: unknown } | { ok: false; error: string } {
  const nameError = mcpServerNameError(edit.name);
  if (nameError) return { ok: false, error: nameError };
  const root = configRoot(raw);
  const servers = root.mcpServers as Record<string, unknown>;
  const existing = servers[edit.name];
  if (edit.op === "remove") {
    if (!isRecord(existing)) return { ok: false, error: `no MCP server ${edit.name}` };
    delete servers[edit.name];
    return { ok: true, value: root };
  }
  if (edit.op === "disable" || edit.op === "enable") {
    if (!isRecord(existing)) return { ok: false, error: `no MCP server ${edit.name}` };
    if (edit.op === "enable" && existing.disabled !== true) return { ok: false, error: `${edit.name} is already enabled` };
    if (edit.op === "disable" && existing.disabled === true) return { ok: false, error: `${edit.name} is already disabled` };
    if (edit.op === "enable" && enabledCount(raw) >= MAX_MCP_SERVERS) return { ok: false, error: `at most ${MAX_MCP_SERVERS} MCP servers can be enabled` };
    servers[edit.name] = { ...existing, ...(edit.op === "disable" ? { disabled: true } : { disabled: undefined }) };
    if (edit.op === "enable") delete (servers[edit.name] as Record<string, unknown>).disabled;
    return { ok: true, value: root };
  }
  if (isRecord(existing)) return { ok: false, error: `${edit.name} already exists; remove it first` };
  if (enabledCount(raw) >= MAX_MCP_SERVERS) return { ok: false, error: `at most ${MAX_MCP_SERVERS} MCP servers can be enabled` };
  if (edit.op === "add-http") {
    const urlError = mcpHttpUrlError(edit.url);
    if (urlError) return { ok: false, error: urlError };
    servers[edit.name] = { type: "http", url: edit.url };
    return { ok: true, value: root };
  }
  if (!edit.command || edit.command.length > 512 || /[\0\n]/.test(edit.command)) return { ok: false, error: "invalid MCP command" };
  if (edit.args.length > 32 || edit.args.some((arg) => arg.length > 4096 || /[\0]/.test(arg))) return { ok: false, error: "invalid MCP arguments" };
  servers[edit.name] = { command: edit.command, args: edit.args };
  return { ok: true, value: root };
}


export function readMcpConfigFile(path: string): { ok: true; value: unknown; missing: boolean } | { ok: false; error: string } {
  try {
    const info = statSync(path);
    if (!info.isFile()) return { ok: false, error: "MCP config is not a file" };
    if (info.size > MAX_MCP_JSON_BYTES) return { ok: false, error: "MCP config exceeds its size cap" };
    if (info.size === 0) return { ok: true, value: { mcpServers: {} }, missing: false };
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) as unknown, missing: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, value: { mcpServers: {} }, missing: true };
    if (err instanceof SyntaxError) return { ok: false, error: "MCP config is not valid JSON" };
    return { ok: false, error: "cannot read MCP config" };
  }
}


export async function writeMcpConfigFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await durableAtomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}
