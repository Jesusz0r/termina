/**
 * Local socket that receives observational Codex hook messages.
 * One token per terminal generation. A late or cross-terminal message is dropped.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { isRecord } from "../../shared/guards.ts";

export const CODEX_HOOK_MESSAGE_MAX_BYTES = 256 * 1024;

export type CodexHookMessage = {
  token: string;
  terminalId: string;
  generation: number;
  payload: string;
};

type BoundToken = { terminalId: string; generation: number };

export class CodexHookServer {
  private server: Server | null = null;
  private readonly tokens = new Map<string, BoundToken>();

  constructor(private readonly onMessage: (message: CodexHookMessage) => void) {}

  async listen(socketPath: string): Promise<void> {
    if (this.server) return;
    try { unlinkSync(socketPath); } catch { /* first listen */ }
    const server = createServer((socket) => this.take(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        server.close();
        this.server = null;
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
  accept(raw: string): CodexHookMessage | null {
    if (raw.length === 0 || Buffer.byteLength(raw) > CODEX_HOOK_MESSAGE_MAX_BYTES) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!isRecord(parsed) || parsed.v !== 1) return null;
    if (typeof parsed.token !== "string" || typeof parsed.terminalId !== "string") return null;
    if (typeof parsed.generation !== "number" || !Number.isSafeInteger(parsed.generation) || parsed.generation < 1) return null;
    if (typeof parsed.payload !== "string" || Buffer.byteLength(parsed.payload) > CODEX_HOOK_MESSAGE_MAX_BYTES) return null;
    const bound = this.tokens.get(parsed.token);
    if (!bound || bound.terminalId !== parsed.terminalId || bound.generation !== parsed.generation) return null;
    return {
      token: parsed.token,
      terminalId: parsed.terminalId,
      generation: parsed.generation,
      payload: parsed.payload,
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.tokens.clear();
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
      if (bytes > CODEX_HOOK_MESSAGE_MAX_BYTES) {
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
