import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARMS, MAX_REQUESTS, TURNS, prepareArm, runGroup, summarize } from "../../../scripts/codex-cache-probe.ts";
import { httpTransport, ProbeFailure, websocketTransport, type Json } from "../../../scripts/codex-cache-probe-transport.ts";
import { stripResponsesBreakpoints } from "../../../agent-core/openai-compat.ts";

const access = { baseUrl: "https://chatgpt.com/backend-api", headers: { authorization: "Bearer fixture" } };
const signal = () => new AbortController().signal;
const output = (code: string) => [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: code }] }];
const response = (code: string, id = "resp_fixture") => ({
  id, model: "gpt-6-astra", status: "completed", output: output(code),
  usage: { input_tokens: 3500, output_tokens: 7, input_tokens_details: { cached_tokens: 0 } },
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("bounded OpenAI cache parity experiment", () => {
  it("runs directly in Node strip-types mode and defaults to a no-credentials, no-network plan", () => {
    const path = fileURLToPath(new URL("../../../scripts/codex-cache-probe.ts", import.meta.url));
    const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path], {
      encoding: "utf8", timeout: 5000,
      env: { PATH: process.env.PATH, HOME: "/var/empty", TERMINA_AUTH_PATH: "/var/empty/probe-auth.json" },
    });
    expect(JSON.parse(stdout)).toMatchObject({ live: false, maxRequests: 24, groups: ["identity", "transport", "mode"] });
  });

  it("caps the complete plan at 24 requests with three samples per arm", () => {
    expect(Object.values(ARMS).flat().length * TURNS).toBe(MAX_REQUESTS);
    expect(MAX_REQUESTS).toBe(24);
  });

  it("isolates prefixes and aligns the key with actual Codex HTTP headers, not a session_id body field", () => {
    const none = prepareArm("identity", ARMS.identity[0]!, "run");
    const key = prepareArm("identity", ARMS.identity[1]!, "run");
    const aligned = prepareArm("identity", ARMS.identity[2]!, "run");
    expect(none.body.prompt_cache_key).toBeUndefined();
    expect(none.headers).toEqual({});
    expect(key.body.prompt_cache_key).toBeDefined();
    expect(key.headers).toEqual({});
    expect(aligned.headers).toEqual({ "session-id": aligned.body.prompt_cache_key, "x-client-request-id": aligned.body.prompt_cache_key });
    expect(aligned.body.session_id).toBeUndefined();
    expect(String(aligned.body.prompt_cache_key).length).toBeLessThanOrEqual(64);
    expect(new Set([none.prefixHash, key.prefixHash, aligned.prefixHash]).size).toBe(3);
    for (const prepared of [none, key, aligned]) {
      expect(prepared.provider).toBe("openai-codex");
      expect(prepared.body.store).toBe(false);
      expect(prepared.body.prompt_cache_options).toBeUndefined();
      expect(prepared.body.max_output_tokens).toBeUndefined();
    }
  });

  it("uses the canonical public-API explicit markers, leaving the last user message unmarked", () => {
    const implicit = prepareArm("mode", ARMS.mode[0]!, "run");
    const explicit = prepareArm("mode", ARMS.mode[1]!, "run");
    expect(implicit.provider).toBe("openai");
    expect(explicit.provider).toBe("openai");
    expect(implicit.body.prompt_cache_options).toBeUndefined();
    expect(explicit.body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    const input = explicit.body.input as Array<{ content: Json[] }>;
    expect(input[0]!.content[0]!.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    expect(input.at(-1)!.content[0]!.prompt_cache_breakpoint).toBeUndefined();
    const clean = stripResponsesBreakpoints(explicit.body);
    expect(JSON.stringify(clean)).not.toContain("prompt_cache_breakpoint");
    expect(clean.reasoning).toEqual(implicit.body.reasoning);
    expect(clean.tools).toEqual(implicit.body.tools);
    expect(clean.instructions).toEqual(implicit.body.instructions);
  });

  it("interleaves matched repeats, records unknown write usage as null, and never retries", async () => {
    const requests: Json[] = [];
    const close = vi.fn();
    const rows = await runGroup("identity", access, "run", signal(), () => {}, (_wire, _url, headers) => {
      return { close, async send(body) {
        requests.push(body);
        const code = JSON.stringify(body.input).match(/Verification code: ([A-F0-9]+)/)![1]!;
        expect(headers.authorization).toBe("Bearer fixture");
        return { text: code, response: response(code), elapsedMs: 12, firstTextMs: 7, connectMs: 0, requestBytes: 10 };
      } };
    });
    expect(requests).toHaveLength(9);
    expect(rows.map((row) => row.arm)).toEqual([
      "no-identifiers", "key-only", "aligned-identifiers", "key-only", "aligned-identifiers", "no-identifiers",
      "aligned-identifiers", "no-identifiers", "key-only",
    ]);
    for (const arm of ARMS.identity) {
      const subset = rows.filter((row) => row.arm === arm.name);
      expect(new Set(subset.map((row) => row.bodyHash)).size).toBe(1);
      expect(subset.every((row) => row.outputMatches && row.usage?.cacheWrite === null)).toBe(true);
    }
    expect(summarize(rows).every((item) => item.warmReadFractions.every((value) => value === 0))).toBe(true);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("replays actual output for controls but sends only new input + previous response ID for incremental WS", async () => {
    let index = 0;
    const sent = new Map<string, Json[]>();
    const rows = await runGroup("transport", access, "run", signal(), () => {}, (wire) => {
      const arm = ARMS.transport[index++]!;
      const code = prepareArm("transport", arm, "run").code;
      const requests: Json[] = [];
      sent.set(arm.name, requests);
      return { close() {}, async send(body) {
        requests.push(structuredClone(body));
        const number = requests.length;
        expect(wire).toBe(arm.wire);
        return { text: code, response: response(code, `resp_${arm.name}_${number}`), elapsedMs: 10, firstTextMs: 5, connectMs: number === 1 ? 1 : 0, requestBytes: 10 };
      } };
    });
    expect(rows).toHaveLength(9);
    const incremental = sent.get("ws-incremental")!;
    const code = prepareArm("transport", ARMS.transport[2]!, "run").code;
    expect(incremental[0]!.previous_response_id).toBeUndefined();
    expect(incremental[1]!.previous_response_id).toBe("resp_ws-incremental_1");
    expect(incremental[2]!.previous_response_id).toBe("resp_ws-incremental_2");
    expect(incremental[1]!.input).toHaveLength(1);
    expect(JSON.stringify(incremental[1]!.input)).not.toContain(code);
    for (const name of ["sse-full", "ws-full"]) {
      const requests = sent.get(name)!;
      expect(requests[1]!.previous_response_id).toBeUndefined();
      expect(requests[1]!.input).toHaveLength(4);
      expect((requests[1]!.input as Json[])[2]!.id).toBe("msg_fixture");
    }
  });

  it("stops the provider after an auth/quota refusal, closes every owned transport, and does not turn failures into misses", async () => {
    const send = vi.fn().mockRejectedValue(new ProbeFailure("HTTP 429", 429));
    const close = vi.fn();
    const rows = await runGroup("identity", access, "run", signal(), () => {}, () => ({ send, close }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ ok: false, status: 429 });
    expect(rows[0]!.usage).toBeUndefined();
    expect(summarize(rows)[0]).toMatchObject({ measuredWarmSamples: 0, warmReadFractions: [], medianWarmMs: null });
    expect(close).toHaveBeenCalled();
  });

  it("does not silently fall back when WebSocket continuation fails", async () => {
    let index = 0;
    const counts = new Map<string, number>();
    const rows = await runGroup("transport", access, "run", signal(), () => {}, () => {
      const arm = ARMS.transport[index++]!;
      const code = prepareArm("transport", arm, "run").code;
      return { close() {}, async send() {
        const count = (counts.get(arm.name) ?? 0) + 1;
        counts.set(arm.name, count);
        if (arm.incremental && count === 2) throw new ProbeFailure("provider-error:previous_response_not_found");
        return { text: code, response: response(code), elapsedMs: 1, firstTextMs: 1, connectMs: 0, requestBytes: 10 };
      } };
    });
    expect(counts.get("ws-incremental")).toBe(2);
    expect(counts.get("sse-full")).toBe(3);
    expect(rows.filter((row) => !row.ok)).toHaveLength(1);
  });

  it("refuses credential forwarding to a custom endpoint before any request", async () => {
    const factory = vi.fn();
    await expect(runGroup("identity", { ...access, baseUrl: "https://example.invalid" }, "run", signal(), () => {}, factory))
      .rejects.toThrow("refusing-noncanonical-provider-route");
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("probe transport", () => {
  it("parses split/CRLF SSE and requires a completed terminal response", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "CODE" },
      { type: "response.output_item.done", output_index: 0, item: output("CODE")[0] },
      { type: "response.completed", response: { ...response("CODE"), output: [] } },
    ];
    const text = ": comment\r\n\r\n" + events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    const encoder = new TextEncoder();
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < text.length; i += 7) controller.enqueue(encoder.encode(text.slice(i, i + 7)));
      controller.close();
    } })));
    vi.stubGlobal("fetch", fetch);
    const result = await httpTransport("https://example.invalid", {}, signal()).send({ model: "fixture" });
    expect(result.response.id).toBe("resp_fixture");
    expect(result.text).toBe("CODE");
    expect(result.response.output).toEqual(output("CODE"));
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    expect(fetch.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    fetch.mockResolvedValueOnce(new Response("data: [DONE]\n\n"));
    await expect(httpTransport("https://example.invalid", {}, signal()).send({})).rejects.toThrow("without-completion");
  });

  it("reuses a real owned WebSocket and sends response.create without HTTP stream fields", async () => {
    const require = createRequire(import.meta.url);
    const testRequire = createRequire(require.resolve("@playwright/test"));
    const pwRequire = createRequire(testRequire.resolve("playwright"));
    const { wsServer: WebSocketServer } = pwRequire("playwright-core/lib/utilsBundle");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const wsServer = new WebSocketServer({ server });
    const requests: Json[] = [];
    let connections = 0;
    wsServer.on("connection", (socket: any, request: any) => {
      connections++;
      expect(request.headers["session-id"]).toBe("fixture-session");
      socket.on("message", (raw: Buffer) => {
        requests.push(JSON.parse(raw.toString()));
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "CODE" }));
        socket.send(JSON.stringify({ type: "response.completed", response: response("CODE") }));
      });
    });
    const client = websocketTransport(`ws://127.0.0.1:${port}`, { "session-id": "fixture-session" }, signal());
    try {
      await client.send({ model: "fixture", stream: true, background: false, input: [] });
      await client.send({ model: "fixture", stream: true, previous_response_id: "resp_fixture", input: [] });
      expect(connections).toBe(1);
      expect(requests[0]).toEqual({ type: "response.create", model: "fixture", input: [] });
      expect(requests[1]!.previous_response_id).toBe("resp_fixture");
    } finally {
      client.close();
      await new Promise<void>((resolve) => wsServer.close(resolve));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
