/**
 * MCP client sessions.
 *
 * Owns stdio/HTTP connections, handshake, env, and startMcp.
 * Split from agent-core/mcp.ts (issue #38).
 */
import { resolvedHostError } from "../main/url.ts";
import { type CompletionState } from "../tool-output.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { MAX_MCP_SERVERS, MCP_CALL_MS, MCP_HANDSHAKE_MS, MCP_HTTP_BODY_BYTES, MCP_PROTOCOL, mcpHttpUrlError, parseHeaderMap } from "./config.ts";
import type { McpServerConfig } from "./config.ts";
import { createMcpContinuation, mcpErrorResult, normalizeMcpCallResult } from "./results.ts";
import type { McpCallResult, McpCancellationScope } from "./results.ts";
import { normalizeInputSchema, normalizeMcpDiscovery, selectMcpTools } from "./tools.ts";
import type { McpClientTool } from "./tools.ts";


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


const MCP_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
] as const;


const MCP_DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";


/**
 * Mint the stdio MCP environment: a small allowlist (PATH, HOME, locale,
 * terminal, temp, Windows system) plus the user-owned mcp.json `env` for
 * that server. Provider keys and session pins never cross implicitly; a
 * server that needs a secret must declare it per-server in mcp.json.
 */
export function mcpEnv(extra: Record<string, string>, host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of MCP_ENV_ALLOWLIST) {
    const value = host[key];
    if (value !== undefined && !value.includes("\0")) env[key] = value;
  }
  if (!env.PATH) env.PATH = MCP_DEFAULT_PATH;
  for (const [key, value] of Object.entries(extra)) {
    if (!key || key.startsWith("PI_")) continue;
    if (typeof value !== "string" || value.includes("\0")) continue;
    env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_")) delete env[key];
  }
  return env;
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


export async function startMcp(
  configs: McpServerConfig[],
  opts: { projectRoot: string; confineCwd: (cwd: string | undefined) => string | null },
): Promise<McpSession> {
  const procs: McpConn[] = [];
  const discovered: McpClientTool[] = [];
  const notes: string[] = [];
  const liveByServer = new Map<string, McpConn>();
  const serverConfigs = new Map<string, McpServerConfig>();
  const reconnecting = new Map<string, Promise<McpConn | null>>();
  let isShutdown = false;

  const connectOne = async (cfg: McpServerConfig): Promise<{
    cfg: McpServerConfig;
    proc: McpConn | null;
    tools: McpClientTool[];
    note: string;
  }> => {
    if (cfg.url) {
      const bad = mcpHttpUrlError(cfg.url);
      if (bad) {
        return { cfg, proc: null, tools: [], note: `mcp ${cfg.name}: ${bad}` };
      }
      let hopHost: string;
      try {
        hopHost = new URL(cfg.url).hostname;
      } catch {
        return { cfg, proc: null, tools: [], note: `mcp ${cfg.name}: error: invalid URL` };
      }
      const resolved = await resolvedHostError(hopHost);
      if (resolved) {
        return { cfg, proc: null, tools: [], note: `mcp ${cfg.name}: ${resolved}` };
      }
      const proc = new McpHttp(cfg.name, cfg.url, cfg.headers ?? {});
      try {
        const tools = await handshake(proc);
        return { cfg, proc, tools, note: "" };
      } catch (err) {
        proc.kill();
        const why = err instanceof Error ? err.message : String(err);
        return { cfg, proc: null, tools: [], note: `mcp ${cfg.name}: ${why}` };
      }
    }
    const cwd = opts.confineCwd(cfg.cwd);
    if (!cwd) return { cfg, proc: null, tools: [], note: `mcp ${cfg.name}: cwd is outside the project` };
    const proc = new McpProcess(cfg.name);
    try {
      proc.start(cfg, cwd, mcpEnv(cfg.env));
      const tools = await handshake(proc);
      return { cfg, proc, tools, note: "" };
    } catch (err) {
      proc.kill();
      const extra = proc.stderrTail();
      const why = err instanceof Error ? err.message : String(err);
      return { cfg, proc: null, tools: [], note: `mcp ${cfg.name}: ${why}${extra ? ` (${extra.slice(0, 200)})` : ""}` };
    }
  };

  const started = await Promise.all(configs.slice(0, MAX_MCP_SERVERS).map(connectOne));
  for (const row of started) {
    if (row.note) notes.push(row.note);
    if (!row.proc) continue;
    procs.push(row.proc);
    liveByServer.set(row.cfg.name, row.proc);
    serverConfigs.set(row.cfg.name, row.cfg);
    for (const tool of row.tools) discovered.push(tool);
  }

  const ensureLive = async (server: string): Promise<McpConn | null> => {
    const current = liveByServer.get(server);
    if (current && !current.dead) return current;
    if (isShutdown) return null;
    const ongoing = reconnecting.get(server);
    if (ongoing) return ongoing;
    const cfg = serverConfigs.get(server);
    if (!cfg) return current ?? null;
    const attempt = (async (): Promise<McpConn | null> => {
      try {
        const fresh = await connectOne(cfg);
        if (isShutdown) {
          fresh.proc?.kill();
          return null;
        }
        if (!fresh.proc) return null;
        const old = liveByServer.get(server);
        liveByServer.set(server, fresh.proc);
        if (old) {
          const index = procs.indexOf(old);
          if (index >= 0) procs[index] = fresh.proc;
          else procs.push(fresh.proc);
          try {
            old.kill();
          } catch {
            /* already dead */
          }
        } else {
          procs.push(fresh.proc);
        }
        return fresh.proc;
      } catch {
        return null;
      } finally {
        reconnecting.delete(server);
      }
    })();
    reconnecting.set(server, attempt);
    return attempt;
  };

  const normalized = normalizeMcpDiscovery(discovered);
  notes.push(...normalized.conflicts);
  const tools = selectMcpTools(normalized.tools);
  const byPrefixed = new Map<string, { server: string; original: string }>();
  for (const tool of tools) {
    if (liveByServer.has(tool.server)) byPrefixed.set(tool.name, { server: tool.server, original: tool.original });
  }

  return {
    tools,
    notes,
    async call(name, args, callOpts) {
      const hit = byPrefixed.get(name);
      if (!hit) return mcpErrorResult(`error: unknown tool ${name}`);
      const continuation = createMcpContinuation(hit.server, name);
      let proc = liveByServer.get(hit.server);
      if (!proc) return mcpErrorResult(`error: mcp ${hit.server} is not running`, "failed", "none", continuation);
      if (proc.dead) {
        const revived = await ensureLive(hit.server);
        if (!revived || revived.dead) {
          return mcpErrorResult(`error: mcp ${hit.server} is not running`, "failed", "none", continuation);
        }
        proc = revived;
      }
      const active = proc;
      const timeoutMs = callOpts?.timeoutMs ?? MCP_CALL_MS;
      const stop = callOpts?.shouldStop;
      let poll: ReturnType<typeof setInterval> | null = null;
      try {
        const result = await new Promise<unknown>((resolve, reject) => {
          const req = active.request("tools/call", { name: hit.original, arguments: args ?? {} }, timeoutMs);
          req.then(resolve, reject);
          poll = setInterval(() => {
            if (stop?.()) active.kill(new Error("interrupted"));
          }, 50);
          if (stop?.()) active.kill(new Error("interrupted"));
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
        const result = mcpErrorResult(`error: mcp ${active.name}: ${why}`, state, cancellationScope, continuation);
        if (active.dead && (state === "timeout" || state === "interrupted")) {
          void ensureLive(hit.server).catch(() => {});
        }
        return result;
      } finally {
        if (poll) clearInterval(poll);
      }
    },
    shutdown() {
      isShutdown = true;
      for (const proc of procs) proc.kill();
    },
  };
}
