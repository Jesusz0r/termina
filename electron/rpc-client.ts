/**
 * JSONL RPC client for pi's `--mode rpc`.
 *
 * pi is spawned as a child process and speaks a strict JSONL protocol over
 * stdio: commands (with optional id) go in on stdin, responses and events come
 * out on stdout (one JSON object per line, LF-delimited).
 *
 * See pi docs: packages/coding-agent/docs/rpc.md
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface PiRpcOptions {
  /** Path to the pi binary (e.g. "pi" resolved from PATH, or an absolute path). */
  bin: string;
  /** Extra CLI args, e.g. ["--model", "qwen3.6-flash"]. */
  args: string[];
  /** Working directory for the agent. */
  cwd: string;
}

export class PiRpcClient {
  private proc: ChildProcess | null = null;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private pending = new Map<string, { resolve: (m: RpcResponse) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private intentionalStop = false;

  constructor(private opts: PiRpcOptions) {}

  /** Every non-response message pi emits (agent events, extension UI requests). */
  onEvent: (event: RpcEvent) => void = () => {};
  /**
   * The child process exited. code is null on spawn failure.
   * `intentional` is true when stop() was called (restart/quit) rather than an
   * unexpected crash — callers can suppress spurious error messages.
   */
  onExit: (code: number | null, signal: NodeJS.Signals | null, error?: Error, intentional?: boolean) => void = () => {};
  /** Raw stderr lines (diagnostics). */
  onStderr: (line: string) => void = () => {};

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.proc) this.stop();
    const { bin, args, cwd } = this.opts;
    this.buffer = "";
    this.pending.clear();

    const proc = spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;

    proc.stdout!.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line.trim()) this.onStderr(line);
      }
    });
    proc.on("error", (err) => {
      this.proc = null;
      this.onExit(null, null, err);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) this.proc = null;
      // Reject anything still pending so callers don't hang forever.
      for (const [, p] of this.pending) p.reject(new Error("pi exited"));
      this.pending.clear();
      this.onExit(code, signal, undefined, this.intentionalStop);
    });
  }

  stop(): void {
    // Mark the exit as intentional so onExit callers don't report a crash.
    this.intentionalStop = true;
    if (!this.proc) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.proc = null;
  }

  /**
   * Send a command and resolve with its response. Response correlation uses the
   * optional `id` field. Commands with no id still get one so we can correlate.
   */
  send<T = unknown>(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse<T>> {
    return new Promise((resolve, reject) => {
      const id = `r${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command ${cmd.type} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg as RpcResponse<T>);
        },
        reject,
      });
      this.writeRaw({ ...cmd, id });
    });
  }

  /** Write a raw JSON command without expecting a response (e.g. extension UI responses). */
  writeRaw(cmd: Record<string, unknown>): void {
    const proc = this.proc;
    if (!proc || !proc.stdin || !proc.stdin.writable) {
      throw new Error("pi process is not running");
    }
    proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  // ---- Convenience commands -------------------------------------------------

  prompt(message: string, opts: { images?: unknown[]; streamingBehavior?: "steer" | "followUp" } = {}): Promise<RpcResponse> {
    return this.send({ type: "prompt", message, ...opts });
  }

  abort(): Promise<RpcResponse> {
    return this.send({ type: "abort" });
  }

  newSession(): Promise<RpcResponse> {
    return this.send({ type: "new_session" });
  }

  getState(): Promise<RpcResponse> {
    return this.send({ type: "get_state" });
  }

  getAvailableModels(): Promise<RpcResponse<{ models: PiModel[] }>> {
    return this.send({ type: "get_available_models" });
  }

  getAvailableThinkingLevels(): Promise<RpcResponse<{ levels: string[] }>> {
    return this.send({ type: "get_available_thinking_levels" });
  }

  getCommands(): Promise<RpcResponse<{ commands: PiCommand[] }>> {
    return this.send({ type: "get_commands" });
  }

  setModel(provider: string, modelId: string): Promise<RpcResponse> {
    return this.send({ type: "set_model", provider, modelId });
  }

  setThinkingLevel(level: string): Promise<RpcResponse> {
    return this.send({ type: "set_thinking_level", level });
  }

  // ---- Internals ------------------------------------------------------------

  private handleChunk(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as RpcResponse | RpcEvent;
        if (msg.type === "response") {
          const res = msg as RpcResponse;
          const pending = this.pending.get(res.id ?? "");
          if (pending) {
            this.pending.delete(res.id ?? "");
            pending.resolve(res);
          }
        } else {
          this.onEvent(msg as RpcEvent);
        }
      } catch (err) {
        this.onStderr(`[rpc] failed to parse: ${(err as Error).message} — ${line.slice(0, 200)}`);
      }
    }
  }
}

// ---- Types (subset of pi's RPC protocol) ------------------------------------

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  api: string;
  contextWindow: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: Record<string, number>;
}

export interface PiCommand {
  name: string;
  description: string;
  source: string;
}

export interface RpcResponse<T = unknown> {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface ToolExecutionStartEvent extends RpcEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionUpdateEvent extends RpcEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult: { content: Array<{ type: string; text?: string }>; details?: unknown };
}

export interface ToolExecutionEndEvent extends RpcEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };
  isError: boolean;
}

export interface MessageUpdateEvent extends RpcEvent {
  type: "message_update";
  assistantMessageEvent:
    | { type: "text_start" | "text_end"; contentIndex: number; content?: string }
    | { type: "text_delta"; contentIndex: number; delta: string }
    | { type: "thinking_start" | "thinking_end"; contentIndex: number }
    | { type: "thinking_delta"; contentIndex: number; delta: string }
    | { type: "toolcall_start"; contentIndex: number }
    | { type: "toolcall_delta"; contentIndex: number; delta: string }
    | { type: "toolcall_end"; contentIndex: number; toolCall?: { id: string; name: string; arguments: unknown } };
}

export interface AgentSettledEvent extends RpcEvent {
  type: "agent_settled";
}

export interface ExtensionUiRequest extends RpcEvent {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: string;
  [key: string]: unknown;
}