// Private transport for the bounded cache probe; never used by agent-core.
import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";
import { readSseJson, responsesResultFromEvents } from "../agent-core/openai-compat.ts";

export type Json = Record<string, unknown>;
export type Exchange = {
  response: Json;
  text: string;
  elapsedMs: number;
  firstTextMs: number | null;
  connectMs: number;
  requestBytes: number;
};
export type ProbeTransport = { send(body: Json): Promise<Exchange>; close(): void };
export const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export class ProbeFailure extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ProbeFailure";
    this.status = status;
  }
}

function providerError(value: unknown): string {
  const object = value && typeof value === "object" ? value as Json : {};
  // Do not log response bodies, credentials, or arbitrary provider error text.
  const code = object.code ?? object.type;
  return typeof code === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : "unspecified";
}

function collector(started: number) {
  let firstTextMs: number | null = null;
  let completed: Json | null = null;
  let bytes = 0;
  const events: Json[] = [];
  return {
    accept(event: Json) {
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (bytes > MAX_RESPONSE_BYTES) throw new ProbeFailure("response-size-limit");
      events.push(event);
      if (event.type === "response.output_text.delta" && firstTextMs === null) firstTextMs = performance.now() - started;
      const response = event.response && typeof event.response === "object" ? event.response as Json : null;
      if (event.type === "error") throw new ProbeFailure(`provider-error:${providerError(event.error ?? event)}`);
      if (event.type === "response.failed" || event.type === "response.incomplete") {
        throw new ProbeFailure(`${event.type}:${providerError(response?.error ?? response?.incomplete_details)}`);
      }
      if (event.type === "response.completed") {
        if (!response || response.status !== "completed") throw new ProbeFailure("invalid-completed-response");
        completed = response;
      }
    },
    get completed() { return completed !== null; },
    finish(requestBytes: number, connectMs = 0): Exchange {
      if (!completed) throw new ProbeFailure("stream-ended-without-completion");
      const parsed = responsesResultFromEvents(events, () => {}, Date.now());
      if (parsed.error) throw new ProbeFailure("invalid-response-stream");
      const text = parsed.blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
      // Codex may omit output items from its terminal envelope. Preserve the actual
      // completed items from the stream for full-history replay, without remapping them.
      const output = Array.isArray(completed.output) && completed.output.length ? completed.output : events
        .filter((event) => event.type === "response.output_item.done" && event.item && typeof event.item === "object")
        .sort((a, b) => Number(a.output_index) - Number(b.output_index)).map((event) => event.item);
      return { response: { ...completed, output }, text, elapsedMs: performance.now() - started, firstTextMs, connectMs, requestBytes };
    },
  };
}

export function httpTransport(url: string, headers: Record<string, string>, signal: AbortSignal): ProbeTransport {
  return {
    close() {},
    async send(body) {
      const serialized = JSON.stringify(body);
      const started = performance.now();
      const events = collector(started);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      deadline.throwIfAborted();
      const response = await fetch(url, {
        method: "POST", redirect: "error",
        headers: { ...headers, accept: "text/event-stream", "content-type": "application/json" },
        body: serialized,
        signal: deadline,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProbeFailure(`HTTP ${response.status}`, response.status);
      }
      if (!response.body) throw new ProbeFailure("missing-response-stream");
      await readSseJson(response.body, deadline, (event) => { events.accept(event); return false; });
      deadline.throwIfAborted();
      return events.finish(Buffer.byteLength(serialized));
    },
  };
}

type Socket = EventEmitter & { readyState: number; send(data: string): void; terminate(): void };
type SocketConstructor = new (url: string, options: Json) => Socket;

function socketConstructor(): SocketConstructor {
  // Reuse the installed test dependency, without installing a production WS dependency.
  const require = createRequire(import.meta.url);
  const testRequire = createRequire(require.resolve("@playwright/test"));
  const playwrightRequire = createRequire(testRequire.resolve("playwright"));
  return playwrightRequire("playwright-core/lib/utilsBundle").ws as SocketConstructor;
}

export function websocketTransport(url: string, headers: Record<string, string>, signal: AbortSignal): ProbeTransport {
  let socket: Socket | undefined;
  return {
    close() { socket?.terminate(); },
    async send(body) {
      signal.throwIfAborted();
      const started = performance.now();
      const events = collector(started);
      // OpenAI documents response.create without HTTP's stream/background fields.
      const { stream: _stream, background: _background, ...payload } = body;
      const serialized = JSON.stringify({ type: "response.create", ...payload });
      const fresh = !socket;
      if (!socket) {
        const Constructor = socketConstructor();
        const outgoing = { ...headers, "openai-beta": "responses_websockets=2026-02-06" };
        // Beta value observed in pinned Pi Codex source, not inferred from public API docs.
        delete (outgoing as Json)["content-type"];
        socket = new Constructor(url.replace(/^https:/, "wss:"), {
          headers: outgoing, followRedirects: false, perMessageDeflate: false,
          handshakeTimeout: REQUEST_TIMEOUT_MS, maxPayload: MAX_RESPONSE_BYTES,
        });
        socket.on("error", () => {}); // Guard late close/handshake errors after a timed-out exchange.
      }
      const current = socket;
      let connectMs = 0;
      let bytes = 0;
      return new Promise<Exchange>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          current.off("message", message).off("error", failure).off("close", closed)
            .off("open", opened).off("unexpected-response", unexpected);
          if (error) { current.terminate(); reject(error); }
          else resolve(events.finish(Buffer.byteLength(serialized), connectMs));
        };
        const opened = () => {
          if (fresh) connectMs = performance.now() - started;
          try { current.send(serialized); } catch { finish(new ProbeFailure("websocket-send-failed")); }
        };
        const message = (raw: Buffer) => {
          try {
            bytes += raw.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw new ProbeFailure("response-size-limit");
            events.accept(JSON.parse(raw.toString()) as Json);
            if (events.completed) finish();
          } catch (error) { finish(error instanceof ProbeFailure ? error : new ProbeFailure("invalid-websocket-event")); }
        };
        const failure = () => finish(new ProbeFailure("websocket-error"));
        const closed = (code: number) => finish(new ProbeFailure(`websocket-closed:${code}`));
        const abort = () => finish(new ProbeFailure("probe-deadline"));
        const unexpected = (_request: unknown, response: { statusCode: number; destroy(): void }) => {
          response.destroy();
          finish(new ProbeFailure(`websocket-HTTP ${response.statusCode}`, response.statusCode));
        };
        const timer = setTimeout(() => finish(new ProbeFailure("request-deadline")), REQUEST_TIMEOUT_MS);
        signal.addEventListener("abort", abort, { once: true });
        current.on("message", message).on("error", failure).on("close", closed).on("unexpected-response", unexpected);
        if (current.readyState === 1) opened();
        else current.once("open", opened);
        if (signal.aborted) abort();
      });
    },
  };
}
