/**
 * Kernel-sized MCP stdio client.
 *
 * The user config lists servers. This module spawns them, lists tools once,
 * and calls them. It is not a plugin loader. Tool schemas freeze at
 * connect; a new session reconnects.
 */
import { spawn, type ChildProcess } from "node:child_process";
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

export const KERNEL_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "edit",
  "grep",
  "glob",
  "bash",
  "web_search",
]);

const IDENT = /[^A-Za-z0-9_-]+/g;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
};

export type McpClientTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  server: string;
  original: string;
};

export type McpSession = {
  tools: McpClientTool[];
  notes: string[];
  call(
    name: string,
    args: unknown,
    opts?: { shouldStop?: () => boolean; timeoutMs?: number },
  ): Promise<{ content: string; isError: boolean }>;
  shutdown(): void;
};

export function sanitizeMcpIdent(raw: string, max = 32): string {
  const s = raw.replace(IDENT, "_").replace(/^_+|_+$/g, "").slice(0, max);
  return s || "s";
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

function parseOneServer(name: string, rec: unknown): McpServerConfig | "disabled" | null {
  if (!name || name.length > 64) return null;
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const obj = rec as Record<string, unknown>;
  if (obj.disabled === true) return "disabled";
  if (obj.type === "http" || obj.type === "sse") return null;
  if (typeof obj.url === "string" && typeof obj.command !== "string") return null;
  if (typeof obj.command !== "string" || !obj.command.trim() || obj.command.length > 512) return null;
  if (/[\0\n]/.test(obj.command)) return null;
  const args: string[] = [];
  if (Array.isArray(obj.args)) {
    for (const a of obj.args) {
      if (typeof a !== "string" || a.length > 4096 || /[\0]/.test(a)) continue;
      args.push(a);
      if (args.length >= 32) break;
    }
  }
  const env: Record<string, string> = {};
  if (obj.env && typeof obj.env === "object" && !Array.isArray(obj.env)) {
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      if (typeof k !== "string" || !k || k.length > 128) continue;
      if (typeof v !== "string" || v.length > 4096) continue;
      env[k] = v;
      if (Object.keys(env).length >= 32) break;
    }
  }
  let cwd: string | undefined;
  if (typeof obj.cwd === "string" && obj.cwd.trim() && obj.cwd.length <= 1024 && !/[\0]/.test(obj.cwd)) {
    cwd = obj.cwd.trim();
  }
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

function encode(msg: Record<string, unknown>): string {
  return `${JSON.stringify(msg)}\n`;
}

function textFromCallResult(result: unknown): { content: string; isError: boolean } {
  if (!result || typeof result !== "object") return { content: "(no output)", isError: true };
  const rec = result as { content?: unknown; isError?: unknown };
  const isError = rec.isError === true;
  const parts: string[] = [];
  if (Array.isArray(rec.content)) {
    for (const block of rec.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  } else if (typeof rec.content === "string") {
    parts.push(rec.content);
  }
  const text = parts.join("\n") || (isError ? "error: mcp tool failed" : "(no output)");
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MCP_RESULT_BYTES) return { content: text, isError };
  return { content: buf.subarray(0, MCP_RESULT_BYTES).toString("utf8"), isError };
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
    const child = spawn(cfg.command, cfg.args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
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
        reject(new Error(`mcp ${this.name} timed out`));
        this.kill();
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
    if (typeof pid === "number") {
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

function mcpEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_")) delete env[key];
  }
  return env;
}

function normalizeInputSchema(raw: unknown): Record<string, unknown> {
  const fallback = { type: "object", properties: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const schema = raw as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== "object") return fallback;
  const out: Record<string, unknown> = { ...schema, type: "object" };
  try {
    if (JSON.stringify(out).length > SCHEMA_CAP) return fallback;
  } catch {
    return fallback;
  }
  return out;
}

async function handshake(proc: McpProcess): Promise<McpClientTool[]> {
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

export function selectMcpTools(
  discovered: McpClientTool[],
  kernelNames: ReadonlySet<string> = KERNEL_TOOL_NAMES,
): McpClientTool[] {
  const out: McpClientTool[] = [];
  const used = new Set<string>(kernelNames);
  let bytes = 0;
  for (const tool of discovered) {
    if (out.length >= MAX_MCP_TOOLS) break;
    const name = mcpToolName(tool.server, tool.original);
    if (used.has(name) || kernelNames.has(name)) continue;
    const next = { ...tool, name };
    const nextBytes = Buffer.byteLength(JSON.stringify(next));
    if (bytes + nextBytes > MAX_MCP_TOOL_BYTES) continue;
    used.add(name);
    out.push(next);
    bytes += nextBytes;
  }
  return out;
}

export async function startMcp(
  configs: McpServerConfig[],
  opts: { projectRoot: string; confineCwd: (cwd: string | undefined) => string | null },
): Promise<McpSession> {
  const procs: McpProcess[] = [];
  const discovered: McpClientTool[] = [];
  const notes: string[] = [];
  const byOriginal = new Map<string, McpProcess>();

  const started = await Promise.all(
    configs.slice(0, MAX_MCP_SERVERS).map(async (cfg) => {
      const cwd = opts.confineCwd(cfg.cwd);
      if (!cwd) return { cfg, proc: null as McpProcess | null, tools: [] as McpClientTool[], note: `mcp ${cfg.name}: cwd is outside the project` };
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

  const tools = selectMcpTools(discovered);
  const byPrefixed = new Map<string, { proc: McpProcess; original: string }>();
  for (const tool of tools) {
    const proc = byOriginal.get(`${tool.server}\0${tool.original}`);
    if (proc) byPrefixed.set(tool.name, { proc, original: tool.original });
  }

  return {
    tools,
    notes,
    async call(name, args, callOpts) {
      const hit = byPrefixed.get(name);
      if (!hit) return { content: `error: unknown tool ${name}`, isError: true };
      if (hit.proc.dead) return { content: `error: mcp ${hit.proc.name} is not running`, isError: true };
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
        return textFromCallResult(result);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { content: `error: mcp ${hit.proc.name}: ${why}`, isError: true };
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
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
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
