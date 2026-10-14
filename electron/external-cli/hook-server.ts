/**
 * Local socket that receives observational hook messages from any external CLI.
 * One token per terminal generation. A late or cross-terminal message is dropped.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { EXTERNAL_CLIS, type ExternalCli } from "../../shared/types.ts";

export const HOOK_MESSAGE_MAX_BYTES = 256 * 1024;
const HOOK_HEAD_MAX_BYTES = 32 * 1024;
const HOOK_TAIL_MAX_BYTES = 16 * 1024;

export type HookMessage = {
  token: string;
  terminalId: string;
  generation: number;
  cli?: ExternalCli;
  payload?: string;
  head?: string;
  tail?: string;
};

/** Prefer a per-process socket under user data. A too-long path gets a private tmp directory. */
export function hookSocketPath(userDataDir: string, pid = process.pid): string {
  const preferred = join(userDataDir, `external-hook-${pid}.sock`);
  if (Buffer.byteLength(preferred) <= 100) return preferred;
  const dir = join(tmpdir(), `termina-external-hook-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { mode: 0o700 });
  return join(dir, "hook.sock");
}

function externalCliName(value: unknown): ExternalCli | undefined {
  return typeof value === "string" && (EXTERNAL_CLIS as readonly string[]).includes(value) ? value as ExternalCli : undefined;
}

type BoundToken = { terminalId: string; generation: number };

export class HookServer {
  private server: Server | null = null;
  private socketPath: string | null = null;
  private readonly tokens = new Map<string, BoundToken>();

  constructor(private readonly onMessage: (message: HookMessage) => void) {}

  async listen(socketPath: string): Promise<void> {
    if (this.server) return;
    try { unlinkSync(socketPath); } catch { /* first listen */ }
    const server = createServer((socket) => this.take(socket));
    this.server = server;
    this.socketPath = socketPath;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        server.close();
        this.server = null;
        this.socketPath = null;
        reject(error);
      };
      server.once("error", fail);
      server.listen(socketPath, () => {
        server.removeListener("error", fail);
        try { chmodSync(socketPath, 0o600); } catch { /* socket mode is best-effort */ }
        resolve();
      });
    });
  }

  issue(terminalId: string, generation: number): string {
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, { terminalId, generation });
    return token;
  }

  revoke(terminalId: string): void {
    for (const [token, bound] of this.tokens) {
      if (bound.terminalId === terminalId) this.tokens.delete(token);
    }
  }

  /** Validate one connection body. Does not apply activity. */
  accept(raw: string): HookMessage | null {
    if (raw.length === 0 || Buffer.byteLength(raw) > HOOK_MESSAGE_MAX_BYTES) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!isRecord(parsed) || parsed.v !== 1) return null;
    if (typeof parsed.token !== "string" || typeof parsed.terminalId !== "string") return null;
    if (typeof parsed.generation !== "number" || !Number.isSafeInteger(parsed.generation) || parsed.generation < 1) return null;
    const cli = parsed.cli === undefined ? undefined : externalCliName(parsed.cli);
    if (parsed.cli !== undefined && !cli) return null;
    const payload = typeof parsed.payload === "string" ? parsed.payload : undefined;
    const head = typeof parsed.head === "string" ? parsed.head : undefined;
    const tail = typeof parsed.tail === "string" ? parsed.tail : undefined;
    if (payload === undefined && head === undefined) return null;
    if (payload !== undefined && Buffer.byteLength(payload) > HOOK_MESSAGE_MAX_BYTES) return null;
    if (head !== undefined && Buffer.byteLength(head) > HOOK_HEAD_MAX_BYTES) return null;
    if (tail !== undefined && Buffer.byteLength(tail) > HOOK_TAIL_MAX_BYTES) return null;
    const bound = this.tokens.get(parsed.token);
    if (!bound || bound.terminalId !== parsed.terminalId || bound.generation !== parsed.generation) return null;
    return {
      token: parsed.token,
      terminalId: parsed.terminalId,
      generation: parsed.generation,
      ...(cli !== undefined ? { cli } : {}),
      ...(payload !== undefined ? { payload } : {}),
      ...(head !== undefined ? { head } : {}),
      ...(tail !== undefined ? { tail } : {}),
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    const socketPath = this.socketPath;
    this.server = null;
    this.socketPath = null;
    this.tokens.clear();
    if (socketPath) {
      try { unlinkSync(socketPath); } catch { /* already gone */ }
    }
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private take(socket: Socket): void {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const message = this.accept(Buffer.concat(chunks).toString("utf8"));
      if (message) this.onMessage(message);
    };
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > HOOK_MESSAGE_MAX_BYTES) {
        settled = true;
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", finish);
    socket.on("error", () => { settled = true; socket.destroy(); });
  }
}
