/**
 * Kernel-sized MCP client (stdio or HTTP).
 *
 * The user config lists servers. This module connects, lists tools once,
 * and calls them. It is not a plugin loader. Tool schemas freeze at
 * connect; a new session reconnects.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BoundedTextAccumulator, type BoundedToolResult, type CompletionState } from "./tool-output.ts";

export const MAX_MCP_SERVERS = 8;
export const MAX_MCP_TOOLS = 32;
export const MAX_MCP_TOOL_BYTES = 64 * 1024;
export const MAX_MCP_JSON_BYTES = 64 * 1024;
export const MCP_HANDSHAKE_MS = 10_000;
export const MCP_CALL_MS = 60_000;
export const MCP_RESULT_BYTES = 20 * 1024;
export const MCP_PROTOCOL = "2024-11-05";
const MCP_HTTP_BODY_BYTES = 256 * 1024;

export const KERNEL_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "edit",
  "grep",
  "glob",
  "bash",
  "web_search",
  "fetch",
]);

const IDENT = /[^A-Za-z0-9_-]+/g;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export type McpServerConfig = {
  name: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
};

export type McpClientTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  server: string;
  original: string;
};

export type McpCancellationScope = "none" | "connection";

export type McpContinuation = Readonly<{
  server: string;
  tool: string;
  guidance: string;
}>;

export type McpCallResult = BoundedToolResult & Readonly<{
  /** "connection" means sibling in-flight calls were aborted with this one. */
  cancellationScope: McpCancellationScope;
  /** Present when output was truncated or a structured payload was omitted. */
  continuation: McpContinuation | null;
}>;

export type McpSession = {
  tools: McpClientTool[];
  notes: string[];
  call(
    name: string,
    args: unknown,
    opts?: { shouldStop?: () => boolean; timeoutMs?: number },
  ): Promise<McpCallResult>;
  shutdown(): void;
};

export function sanitizeMcpIdent(raw: string, max = 32): string {
  const s = raw.replace(IDENT, "_").replace(/^_+|_+$/g, "").slice(0, max);
  return s || "s";
}

/** Build a bounded, argument-free continuation descriptor for MCP output. */
export function createMcpContinuation(server: string, tool: string): McpContinuation {
  const safeServer = sanitizeMcpIdent(server, 32);
  const safeTool = sanitizeMcpIdent(tool, 64);
  return Object.freeze({
    server: safeServer,
    tool: safeTool,
    guidance: `Call MCP tool ${JSON.stringify(safeTool)} on server ${JSON.stringify(safeServer)} again to retrieve the complete output; arguments are intentionally omitted.`,
  });
}

/** Prefix mcp_<server>_<tool> and keep the Anthropic 64-char name cap. */
export function mcpToolName(server: string, tool: string): string {
  const s = sanitizeMcpIdent(server, 24);
  const t = sanitizeMcpIdent(tool, 32);
  const name = `mcp_${s}_${t}`;
  if (name.length <= 64 && TOOL_NAME.test(name)) return name;
  const budget = 64 - "mcp_".length - 1;
  let serverPart = s;
  let toolPart = t;
  if (serverPart.length + toolPart.length > budget) {
    const keepServer = Math.min(serverPart.length, Math.max(4, Math.floor(budget / 3)));
    serverPart = serverPart.slice(0, keepServer);
    toolPart = toolPart.slice(0, budget - serverPart.length);
  }
  const out = `mcp_${serverPart}_${toolPart}`.slice(0, 64);
  return TOOL_NAME.test(out) ? out : "mcp_tool";
}

const SCHEMA_CAP = 8 * 1024;
const SCHEMA_MAX_DEPTH = 64;
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

function parseHeaderMap(raw: unknown): Record<string, string> {
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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "error: invalid URL";
  }
  if (parsed.protocol === "https:") return null;
  const loopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol === "http:" && loopback && process.env.TERMINA_CORE_TEST === "1") return null;
  if (parsed.protocol === "http:") return "error: only https URLs are allowed";
  return `error: URL scheme not allowed: ${parsed.protocol}`;
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

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RpcMsg = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown; result?: unknown; error?: unknown };

type McpConn = {
  name: string;
  dead: boolean;
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  kill(err?: Error): void;
};

function encode(msg: Record<string, unknown>): string {
  return `${JSON.stringify(msg)}\n`;
}

function mcpOutputMarker(details: { state: CompletionState }, continuation: McpContinuation | null): string {
  const guidance = continuation ? ` — ${continuation.guidance}` : " — call again for complete output";
  return details.state === "complete"
    ? `[mcp output truncated${guidance}]`
    : `[mcp output incomplete: ${details.state}${guidance}]`;
}

function mcpOmissionMarker(kind: string, reason: string, continuation: McpContinuation | null): string {
  const guidance = continuation ? `; ${continuation.guidance}` : "; call the MCP tool again for the omitted payload";
  return `[mcp ${kind} omitted: ${reason}${guidance}]`;
}

type StableOutputJson = Readonly<{
  encoded: string | null;
  reason: "too-large" | "not-json-serializable" | null;
}>;

const OUTPUT_JSON_TOO_LARGE = Symbol("mcp output JSON too large");

/**
 * Canonically encode an MCP result value without doing work beyond the
 * provider-visible result budget. This intentionally does not reuse schema
 * canonicalization: result values can be server-controlled and much larger
 * than tool schemas.
 */
function stableOutputJson(raw: unknown, maxBytes = MCP_RESULT_BYTES): StableOutputJson {
  const chunks: string[] = [];
  let bytes = 0;
  const push = (part: string): void => {
    const partBytes = Buffer.byteLength(part, "utf8");
    if (bytes + partBytes > maxBytes) throw OUTPUT_JSON_TOO_LARGE;
    chunks.push(part);
    bytes += partBytes;
  };
  const pushString = (value: string): void => {
    // JSON encoding cannot be shorter than the UTF-8 input, so avoid creating
    // an escaped copy of a string that cannot fit before the final check.
    if (Buffer.byteLength(value, "utf8") > maxBytes - bytes) throw OUTPUT_JSON_TOO_LARGE;
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") throw new Error("mcp output is not JSON-serializable");
    push(encoded);
  };
  const visit = (value: unknown, seen: WeakSet<object>, depth: number): void => {
    if (value === null) {
      push("null");
      return;
    }
    switch (typeof value) {
      case "string":
        pushString(value);
        return;
      case "boolean":
        push(value ? "true" : "false");
        return;
      case "number":
        if (!Number.isFinite(value)) throw new Error("mcp output contains a non-finite number");
        push(JSON.stringify(value));
        return;
      case "object":
        break;
      default:
        throw new Error("mcp output is not JSON-serializable");
    }
    if (depth > SCHEMA_MAX_DEPTH || seen.has(value)) throw new Error("mcp output is too deep or cyclic");
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        push("[");
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) push(",");
          visit(value[index], seen, depth + 1);
        }
        push("]");
      } else {
        push("{");
        const keys: string[] = [];
        for (const key in value as Record<string, unknown>) {
          if (!Object.hasOwn(value, key)) continue;
          keys.push(key);
          if (keys.length > maxBytes) throw OUTPUT_JSON_TOO_LARGE;
        }
        keys.sort();
        for (let index = 0; index < keys.length; index += 1) {
          if (index > 0) push(",");
          const key = keys[index]!;
          pushString(key);
          push(":");
          visit((value as Record<string, unknown>)[key], seen, depth + 1);
        }
        push("}");
      }
    } finally {
      seen.delete(value);
    }
  };

  try {
    visit(raw, new WeakSet<object>(), 0);
    return Object.freeze({ encoded: chunks.join(""), reason: null });
  } catch (err) {
    return Object.freeze({
      encoded: null,
      reason: err === OUTPUT_JSON_TOO_LARGE ? "too-large" : "not-json-serializable",
    });
  }
}

function stableOutputFailure(result: StableOutputJson): string {
  return result.reason === "too-large" ? "too large" : "not JSON-serializable";
}

function outputTypeLabel(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "unknown";
  const label = raw.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32);
  return label || "unknown";
}

function resourceMetadata(raw: unknown): { metadata: Record<string, unknown>; hasBlob: boolean } {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const metadata: Record<string, unknown> = {};
  for (const key of ["uri", "mimeType", "name", "title", "description", "text"]) {
    if (typeof source[key] === "string") metadata[key] = source[key];
  }
  return { metadata, hasBlob: Object.hasOwn(source, "blob") };
}

function finishMcpOutput(
  accumulator: BoundedTextAccumulator,
  isError: boolean,
  state: CompletionState = "complete",
  cancellationScope: McpCancellationScope = "none",
  continuation: McpContinuation | null = null,
  omitted = false,
): McpCallResult {
  const bounded = accumulator.finish(state);
  const hasOmission = omitted || bounded.truncated;
  return Object.freeze({
    ...bounded,
    content: bounded.text,
    isError,
    cancellationScope,
    truncated: hasOmission,
    continuation: hasOmission ? continuation : null,
  });
}

function mcpErrorResult(
  content: string,
  state: CompletionState = "failed",
  cancellationScope: McpCancellationScope = "none",
  continuation: McpContinuation | null = null,
): McpCallResult {
  const marker = (details: { state: CompletionState }): string => mcpOutputMarker(details, continuation);
  const accumulator = new BoundedTextAccumulator({
    maxBytes: MCP_RESULT_BYTES,
    direction: "head",
    marker,
  });
  accumulator.push(content);
  return finishMcpOutput(accumulator, true, state, cancellationScope, continuation);
}

/** Normalize MCP text content through the shared bounded UTF-8 accumulator. */
export function normalizeMcpCallResult(result: unknown, continuation: McpContinuation | null = null): McpCallResult {
  const marker = (details: { state: CompletionState }): string => mcpOutputMarker(details, continuation);
  const accumulator = new BoundedTextAccumulator({
    maxBytes: MCP_RESULT_BYTES,
    direction: "head",
    marker,
  });
  if (!result || typeof result !== "object") {
    accumulator.push("(no output)");
    return finishMcpOutput(accumulator, true, "failed", "none", continuation);
  }

  const rec = result as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const isError = rec.isError === true;
  let structuredPart: string | null = null;
  let structuredCanonical: string | null = null;
  const jsonParts: string[] = [];
  const resourceParts: string[] = [];
  const resourceLinkParts: string[] = [];
  const omittedParts: string[] = [];
  let omitted = false;
  const textParts: string[] = [];

  if (Object.hasOwn(rec, "structuredContent") && rec.structuredContent !== undefined) {
    const encoded = stableOutputJson(rec.structuredContent);
    if (encoded.encoded === null) {
      omitted = true;
      omittedParts.push(mcpOmissionMarker("structuredContent", stableOutputFailure(encoded), continuation));
    }
    else {
      structuredCanonical = encoded.encoded;
      structuredPart = `[mcp structuredContent] ${encoded.encoded}`;
    }
  }

  if (Array.isArray(rec.content)) {
    for (const block of rec.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as {
        type?: unknown;
        text?: unknown;
        json?: unknown;
        resource?: unknown;
        uri?: unknown;
        mimeType?: unknown;
        name?: unknown;
        title?: unknown;
        description?: unknown;
      };
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (b.type === "json") {
        const encoded = stableOutputJson(b.json);
        if (encoded.encoded === null) {
          omitted = true;
          jsonParts.push(mcpOmissionMarker("json", stableOutputFailure(encoded), continuation));
        } else {
          jsonParts.push(
            `[mcp json] ${encoded.encoded}`,
          );
        }
      } else if (b.type === "resource") {
        const resource = resourceMetadata(b.resource ?? b);
        const encoded = stableOutputJson(resource.metadata);
        if (encoded.encoded === null) {
          omitted = true;
          resourceParts.push(mcpOmissionMarker("resource", encoded.reason === "too-large" ? "too large" : "metadata unavailable", continuation));
        } else {
          resourceParts.push(`[mcp resource] ${encoded.encoded}`);
        }
        if (resource.hasBlob) {
          omitted = true;
          resourceParts.push(mcpOmissionMarker("resource payload", "binary blob", continuation));
        }
      } else if (b.type === "resource_link") {
        const link = resourceMetadata(b);
        const encoded = stableOutputJson(link.metadata);
        if (encoded.encoded === null) {
          omitted = true;
          resourceLinkParts.push(mcpOmissionMarker("resource_link", encoded.reason === "too-large" ? "too large" : "metadata unavailable", continuation));
        } else {
          resourceLinkParts.push(`[mcp resource_link] ${encoded.encoded}`);
        }
      } else if (b.type === "image" || b.type === "audio") {
        const kind = outputTypeLabel(b.type);
        const mime = typeof b.mimeType === "string"
          ? ` (${b.mimeType.slice(0, 96).replace(/[\x00-\x1f\x7f]/g, " ")})`
          : "";
        omitted = true;
        omittedParts.push(mcpOmissionMarker(kind, `binary payload${mime}`, continuation));
      } else {
        omitted = true;
        omittedParts.push(mcpOmissionMarker(outputTypeLabel(b.type), "unsupported content", continuation));
      }
    }
  } else if (typeof rec.content === "string") {
    textParts.push(rec.content);
  }

  let outputParts = 0;
  const pushPart = (text: string): void => {
    if (outputParts > 0) accumulator.push("\n");
    accumulator.push(text);
    outputParts += 1;
  };
  if (structuredPart !== null) pushPart(structuredPart);
  const equivalentTextIndexes = new Set<number>();
  if (structuredCanonical !== null) {
    for (let index = 0; index < textParts.length; index += 1) {
      const text = textParts[index]!;
      if (!text.trim()) continue;
      // A giant textual block cannot be a useful duplicate after the
      // provider-visible result cap. Avoid reparsing transport-sized text;
      // preserving it as a distinct summary is safer than guessing.
      if (Buffer.byteLength(text, "utf8") > MCP_RESULT_BYTES) continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        const canonical = stableOutputJson(parsed);
        if (canonical.encoded === structuredCanonical) equivalentTextIndexes.add(index);
      } catch {
        // A textual summary that merely contains JSON remains meaningful.
      }
    }
  }
  for (let index = 0; index < textParts.length; index += 1) {
    const text = textParts[index]!;
    if (text.length > 0 && !equivalentTextIndexes.has(index)) pushPart(text);
  }
  for (const text of [...jsonParts].sort()) pushPart(text);
  for (const text of [...resourceParts].sort()) pushPart(text);
  for (const text of [...resourceLinkParts].sort()) pushPart(text);
  for (const text of [...omittedParts].sort()) pushPart(text);
  if (outputParts === 0) pushPart(isError ? "error: mcp tool failed" : "(no output)");
  return finishMcpOutput(accumulator, isError, "complete", "none", continuation, omitted);
}

class McpProcess {
  readonly name: string;
  private child: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = "";
  dead = false;

  constructor(name: string) {
    this.name = name;
  }

  start(cfg: McpServerConfig, cwd: string, env: NodeJS.ProcessEnv): void {
    if (!cfg.command) throw new Error(`mcp ${this.name} needs a command`);
    const child = spawn(cfg.command, cfg.args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderr = (this.stderr + text).slice(-4096);
    });
    child.on("exit", () => this.failAll(new Error(`mcp ${this.name} exited`)));
    child.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > 2 * 1024 * 1024) this.buf = this.buf.slice(-1024 * 1024);
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (line.startsWith("{")) this.onLine(line);
      nl = this.buf.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: RpcMsg;
    try {
      msg = JSON.parse(line) as RpcMsg;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const wait = this.pending.get(msg.id);
    if (!wait) return;
    this.pending.delete(msg.id);
    clearTimeout(wait.timer);
    if (msg.error) {
      const err = msg.error as { message?: unknown };
      wait.reject(new Error(typeof err.message === "string" ? err.message : `mcp ${this.name} error`));
      return;
    }
    wait.resolve(msg.result);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.dead || !this.child?.stdin) return Promise.reject(new Error(`mcp ${this.name} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`mcp ${this.name} timed out`);
        reject(error);
        // Per-request cancellation is not available on stdio MCP, so make
        // the same timeout reason visible to sibling pending requests.
        this.kill(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child!.stdin!.write(encode({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    try {
      this.child?.stdin?.write(encode({ jsonrpc: "2.0", method, params }));
    } catch {
      /* ignore */
    }
  }

  failAll(err: Error): void {
    this.dead = true;
    for (const wait of this.pending.values()) {
      clearTimeout(wait.timer);
      wait.reject(err);
    }
    this.pending.clear();
  }

  kill(err = new Error(`mcp ${this.name} stopped`)): void {
    this.dead = true;
    this.failAll(err);
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      /* gone */
    }
    const pid = child.pid;
    if (process.platform !== "win32" && typeof pid === "number" && pid > 0) {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        /* fall through to the child handle */
      }
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }

  stderrTail(): string {
    return this.stderr.trim();
  }
}

function rpcError(name: string, error: unknown): Error {
  const rec = error && typeof error === "object" ? (error as { message?: unknown }) : null;
  return new Error(typeof rec?.message === "string" ? rec.message : `mcp ${name} error`);
}

function parseSseRpc(text: string, id: number): RpcMsg {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as RpcMsg;
      if (msg.id === id) return msg;
    } catch {
      /* next event */
    }
  }
  throw new Error("mcp SSE response missing result");
}

async function readCappedBody(res: Response, max: number, name: string): Promise<string> {
  const declared = res.headers.get("content-length")?.trim() ?? "";
  const declaredBytes = /^\d+$/.test(declared) ? Number(declared) : null;
  if (declaredBytes !== null && !Number.isSafeInteger(declaredBytes)) {
    throw new Error(`mcp ${name} response body cannot be bounded`);
  }
  if (declaredBytes !== null && declaredBytes > max) {
    try {
      await res.body?.cancel(`mcp ${name} response too large`);
    } catch {
      /* The size error remains authoritative. */
    }
    throw new Error(`mcp ${name} response too large`);
  }
  if (!res.body) {
    // A body convenience method can allocate without regard to Content-Length.
    // Only a body that is provably empty is safe when no stream is exposed.
    if (declaredBytes === 0 || res.status === 204 || res.status === 205 || res.status === 304) return "";
    throw new Error(`mcp ${name} response body cannot be bounded`);
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let used = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error(`mcp ${name} response returned non-byte data`);
      if (used + value.byteLength > max) {
        try {
          await reader.cancel(`mcp ${name} response too large`);
        } catch {
          /* The size error remains authoritative. */
        }
        throw new Error(`mcp ${name} response too large`);
      }
      chunks.push(Buffer.from(value));
      used += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* A cancelled or failed reader may already be detached. */
    }
  }
  // Do not require Content-Length to equal decoded stream bytes: fetch may
  // transparently decompress a response while preserving its wire length.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, used));
  } catch {
    throw new Error(`mcp ${name} response is not valid UTF-8`);
  }
}

class McpHttp implements McpConn {
  readonly name: string;
  dead = false;
  private nextId = 1;
  private sessionId = "";
  private inflight = new Set<AbortController>();
  private lastErr: Error | null = null;

  constructor(
    name: string,
    url: string,
    extraHeaders: Record<string, string>,
  ) {
    this.name = name;
    this.url = url;
    this.extraHeaders = parseHeaderMap(extraHeaders);
  }

  private url: string;
  private extraHeaders: Record<string, string>;

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.extraHeaders,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.dead) throw new Error(`mcp ${this.name} is not running`);
    const id = this.nextId++;
    const ac = new AbortController();
    this.inflight.add(ac);
    const timer = setTimeout(() => {
      ac.abort();
      this.kill(new Error(`mcp ${this.name} timed out`));
    }, timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: ac.signal,
        redirect: "manual",
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid && /^[\x21-\x7E]{1,128}$/.test(sid)) this.sessionId = sid;
      if (res.status >= 300 && res.status < 400) {
        try {
          await readCappedBody(res, MCP_HTTP_BODY_BYTES, this.name);
        } catch {
          /* drain */
        }
        throw new Error(`mcp ${this.name} HTTP ${res.status}`);
      }
      const text = await readCappedBody(res, MCP_HTTP_BODY_BYTES, this.name);
      if (!res.ok) throw new Error(`mcp ${this.name} HTTP ${res.status}`);
      const ctype = res.headers.get("content-type") ?? "";
      const msg = ctype.includes("text/event-stream") ? parseSseRpc(text, id) : (JSON.parse(text) as RpcMsg);
      if (msg.error) throw rpcError(this.name, msg.error);
      return msg.result;
    } catch (err) {
      if (this.lastErr) throw this.lastErr;
      if ((err as { name?: string }).name === "AbortError") throw new Error(`mcp ${this.name} timed out`);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
      this.inflight.delete(ac);
    }
  }

  notify(method: string, params?: unknown): void {
    if (this.dead) return;
    const ac = new AbortController();
    this.inflight.add(ac);
    void fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: ac.signal,
      redirect: "manual",
    })
      .then(async (res) => {
        // Notifications have no result to parse. Cancel the response stream so
        // a server cannot leave an unread or endless body attached to the session.
        try {
          await res.body?.cancel("MCP notification response is not consumed");
        } catch {
          /* ignore notify cleanup failures */
        }
      })
      .catch(() => {
        /* ignore notify failures */
      })
      .finally(() => this.inflight.delete(ac));
  }

  kill(err = new Error(`mcp ${this.name} stopped`)): void {
    this.dead = true;
    this.lastErr = err;
    for (const ac of this.inflight) ac.abort();
    this.inflight.clear();
  }
}

function mcpEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_")) delete env[key];
  }
  return env;
}

function canonicalizeJsonValue(raw: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (raw === null || typeof raw !== "object") {
    if (raw === undefined || typeof raw === "function" || typeof raw === "symbol") {
      throw new Error("mcp schema contains a non-JSON value");
    }
    if (typeof raw === "number" && !Number.isFinite(raw)) {
      throw new Error("mcp schema contains a non-finite number");
    }
    return raw;
  }
  if (depth > SCHEMA_MAX_DEPTH || seen.has(raw)) throw new Error("mcp schema is too deep or cyclic");
  seen.add(raw);
  try {
    if (Array.isArray(raw)) {
      return raw.map((value) => canonicalizeJsonValue(value, seen, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(raw).sort()) {
      const value = canonicalizeJsonValue((raw as Record<string, unknown>)[key], seen, depth + 1);
      Object.defineProperty(out, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    return out;
  } finally {
    seen.delete(raw);
  }
}

function normalizeInputSchema(raw: unknown): Record<string, unknown> {
  const fallback = { type: "object", properties: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const schema = raw as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== "object") return fallback;
  try {
    const source = { ...schema, type: "object" };
    const out = canonicalizeJsonValue(source, new WeakSet<object>(), 0);
    if (!out || typeof out !== "object" || Array.isArray(out)) return fallback;
    const encoded = JSON.stringify(out);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > SCHEMA_CAP) return fallback;
    return out as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toolIdentity(tool: McpClientTool): string {
  return JSON.stringify([tool.server, tool.original]);
}

function toolTieBreakKey(tool: McpClientTool): string {
  return JSON.stringify([tool.description, tool.input_schema]);
}

function compareMcpTools(a: McpClientTool, b: McpClientTool): number {
  return (
    compareStrings(a.server, b.server) ||
    compareStrings(a.original, b.original) ||
    compareStrings(toolTieBreakKey(a), toolTieBreakKey(b))
  );
}

function mcpConflictNote(tool: McpClientTool, variants: number): string {
  const server = JSON.stringify(tool.server.slice(0, 96));
  const original = JSON.stringify(tool.original.slice(0, 128));
  return `mcp tool conflict for ${server}/${original}: ${variants} definitions; using the deterministic canonical definition`;
}

function cloneMcpTool(tool: McpClientTool): McpClientTool | null {
  if (!tool || typeof tool !== "object") return null;
  const server = typeof tool.server === "string" ? tool.server : "";
  const original = typeof tool.original === "string"
    ? tool.original
    : typeof tool.name === "string" ? tool.name : "";
  if (!server || !original) return null;
  return {
    name: original,
    description: typeof tool.description === "string" ? tool.description.slice(0, 1024) : original,
    input_schema: normalizeInputSchema(tool.input_schema),
    server,
    original,
  };
}

/**
 * Copy and canonically order MCP discovery results before applying any caps.
 * A server can repeat a tool across pages, and different servers can return
 * the same page in different orders. Identity is server + original name; a
 * deterministic descriptor tie-breaker chooses the same winner in either
 * case.
 */
export function normalizeMcpTools(discovered: readonly McpClientTool[]): McpClientTool[] {
  return normalizeMcpDiscovery(discovered).tools;
}

function normalizeMcpDiscovery(discovered: readonly McpClientTool[]): {
  tools: McpClientTool[];
  conflicts: string[];
} {
  const candidates: McpClientTool[] = [];
  for (const raw of discovered) {
    const copy = cloneMcpTool(raw);
    if (copy) candidates.push(copy);
  }
  candidates.sort(compareMcpTools);

  const tools: McpClientTool[] = [];
  const conflicts: string[] = [];
  for (let i = 0; i < candidates.length;) {
    const first = candidates[i]!;
    const identity = toolIdentity(first);
    let end = i + 1;
    while (end < candidates.length && toolIdentity(candidates[end]!) === identity) end++;
    const variants = new Set<string>();
    for (let index = i; index < end; index++) variants.add(toolTieBreakKey(candidates[index]!));
    if (variants.size > 1) conflicts.push(mcpConflictNote(first, variants.size));
    tools.push(first);
    i = end;
  }
  return { tools, conflicts };
}

function addMcpNameSuffix(base: string, suffix: number): string {
  if (suffix <= 1) return base;
  const marker = `_${suffix}`;
  const prefix = base.slice(0, Math.max(1, 64 - marker.length));
  const out = `${prefix}${marker}`.slice(0, 64);
  return TOOL_NAME.test(out) ? out : "mcp_tool";
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item, seen);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item, seen);
  }
  return Object.freeze(value);
}

function providerMcpToolDef(tool: McpClientTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}

function providerMcpToolBytes(tool: McpClientTool): number {
  return Buffer.byteLength(JSON.stringify(providerMcpToolDef(tool)), "utf8");
}

async function handshake(proc: McpConn): Promise<McpClientTool[]> {
  await proc.request(
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "termina-agent-core", version: "1" },
    },
    MCP_HANDSHAKE_MS,
  );
  proc.notify("notifications/initialized");
  const out: McpClientTool[] = [];
  let cursor: unknown;
  for (let page = 0; page < 4; page++) {
    const listed = await proc.request("tools/list", cursor ? { cursor } : {}, MCP_HANDSHAKE_MS);
    const rec = listed && typeof listed === "object" ? (listed as { tools?: unknown; nextCursor?: unknown }) : null;
    const tools = rec && Array.isArray(rec.tools) ? rec.tools : [];
    for (const item of tools) {
      if (!item || typeof item !== "object") continue;
      const tool = item as { name?: unknown; description?: unknown; inputSchema?: unknown; input_schema?: unknown };
      if (typeof tool.name !== "string" || !tool.name) continue;
      const schema = normalizeInputSchema(tool.inputSchema ?? tool.input_schema);
      out.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description.slice(0, 1024) : tool.name,
        input_schema: schema,
        server: proc.name,
        original: tool.name,
      });
    }
    if (typeof rec?.nextCursor !== "string" || !rec.nextCursor) break;
    cursor = rec.nextCursor;
  }
  return out;
}

// Keep the complete capped discovery frozen for a session. A deferred MCP
// catalog would need a provider-facing search protocol and a new-session/cache
// boundary in main; tools/list is the canonical discovery surface today.
export function selectMcpTools(
  discovered: McpClientTool[],
  kernelNames: ReadonlySet<string> = KERNEL_TOOL_NAMES,
): McpClientTool[] {
  const normalized = normalizeMcpTools(discovered);
  const out: McpClientTool[] = [];
  const used = new Set<string>(kernelNames);
  let bytes = 0;
  for (const tool of normalized) {
    if (out.length >= MAX_MCP_TOOLS) break;
    const base = mcpToolName(tool.server, tool.original);
    let suffix = 1;
    let name = base;
    while (used.has(name)) name = addMcpNameSuffix(base, ++suffix);
    const next = {
      name,
      description: tool.description,
      input_schema: normalizeInputSchema(tool.input_schema),
      server: tool.server,
      original: tool.original,
    } satisfies McpClientTool;
    freezeDeep(next);
    const nextBytes = providerMcpToolBytes(next);
    if (bytes + nextBytes > MAX_MCP_TOOL_BYTES) continue;
    used.add(name);
    out.push(next);
    bytes += nextBytes;
  }
  return Object.freeze(out) as unknown as McpClientTool[];
}

export async function startMcp(
  configs: McpServerConfig[],
  opts: { projectRoot: string; confineCwd: (cwd: string | undefined) => string | null },
): Promise<McpSession> {
  const procs: McpConn[] = [];
  const discovered: McpClientTool[] = [];
  const notes: string[] = [];
  const byOriginal = new Map<string, McpConn>();

  const started = await Promise.all(
    configs.slice(0, MAX_MCP_SERVERS).map(async (cfg) => {
      if (cfg.url) {
        const bad = mcpHttpUrlError(cfg.url);
        if (bad) {
          return { cfg, proc: null as McpConn | null, tools: [] as McpClientTool[], note: `mcp ${cfg.name}: ${bad}` };
        }
        const proc = new McpHttp(cfg.name, cfg.url, cfg.headers ?? {});
        try {
          const tools = await handshake(proc);
          return { cfg, proc, tools, note: "" };
        } catch (err) {
          proc.kill();
          const why = err instanceof Error ? err.message : String(err);
          return { cfg, proc: null as McpConn | null, tools: [] as McpClientTool[], note: `mcp ${cfg.name}: ${why}` };
        }
      }
      const cwd = opts.confineCwd(cfg.cwd);
      if (!cwd) return { cfg, proc: null as McpConn | null, tools: [] as McpClientTool[], note: `mcp ${cfg.name}: cwd is outside the project` };
      const proc = new McpProcess(cfg.name);
      try {
        proc.start(cfg, cwd, mcpEnv(cfg.env));
        const tools = await handshake(proc);
        return { cfg, proc, tools, note: "" };
      } catch (err) {
        proc.kill();
        const extra = proc.stderrTail();
        const why = err instanceof Error ? err.message : String(err);
        return { cfg, proc: null, tools: [] as McpClientTool[], note: `mcp ${cfg.name}: ${why}${extra ? ` (${extra.slice(0, 200)})` : ""}` };
      }
    }),
  );
  for (const row of started) {
    if (row.note) notes.push(row.note);
    if (!row.proc) continue;
    procs.push(row.proc);
    for (const tool of row.tools) {
      byOriginal.set(`${row.cfg.name}\0${tool.original}`, row.proc);
      discovered.push(tool);
    }
  }

  const normalized = normalizeMcpDiscovery(discovered);
  notes.push(...normalized.conflicts);
  const tools = selectMcpTools(normalized.tools);
  const byPrefixed = new Map<string, { proc: McpConn; original: string }>();
  for (const tool of tools) {
    const proc = byOriginal.get(`${tool.server}\0${tool.original}`);
    if (proc) byPrefixed.set(tool.name, { proc, original: tool.original });
  }

  return {
    tools,
    notes,
    async call(name, args, callOpts) {
      const hit = byPrefixed.get(name);
      if (!hit) return mcpErrorResult(`error: unknown tool ${name}`);
      const continuation = createMcpContinuation(hit.proc.name, name);
      if (hit.proc.dead) return mcpErrorResult(`error: mcp ${hit.proc.name} is not running`, "failed", "none", continuation);
      const timeoutMs = callOpts?.timeoutMs ?? MCP_CALL_MS;
      const stop = callOpts?.shouldStop;
      let poll: ReturnType<typeof setInterval> | null = null;
      try {
        const result = await new Promise<unknown>((resolve, reject) => {
          const req = hit.proc.request("tools/call", { name: hit.original, arguments: args ?? {} }, timeoutMs);
          req.then(resolve, reject);
          poll = setInterval(() => {
            if (stop?.()) hit.proc.kill(new Error("interrupted"));
          }, 50);
          if (stop?.()) hit.proc.kill(new Error("interrupted"));
        });
        return normalizeMcpCallResult(result, continuation);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        const state: CompletionState = why === "interrupted"
          ? "interrupted"
          : /timed out/i.test(why) ? "timeout" : "failed";
        const cancellationScope: McpCancellationScope = state === "interrupted" || state === "timeout"
          ? "connection"
          : "none";
        return mcpErrorResult(`error: mcp ${hit.proc.name}: ${why}`, state, cancellationScope, continuation);
      } finally {
        if (poll) clearInterval(poll);
      }
    },
    shutdown() {
      for (const proc of procs) proc.kill();
    },
  };
}

export function mcpToolDefs(tools: McpClientTool[]): Array<Record<string, unknown>> {
  return tools.map(providerMcpToolDef);
}

/** Join kernel tools and MCP tools. Last client tool keeps cache_control. */
export function mergeClientTools(
  kernel: Array<Record<string, unknown>>,
  mcp: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return [...kernel, ...mcp];
}

export function userMcpPath(home: string): string {
  return join(home, ".termina", "agent", "mcp.json");
}
