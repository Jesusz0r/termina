import { describe, it, expect } from "vitest";
/**
 * Provider/cache contract tests for the token-efficiency roadmap.
 *
 * This file is intentionally independent from the broad agent-core harness so
 * provider usage and fallback failures stay easy to diagnose. It is expected
 * to be RED until the roadmap's nullable accounting and effective-policy work
 * lands.
 *
 *   node --experimental-strip-types --no-warnings scripts/agent-core-provider-cache-test.mjs
 */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Agent Core Provider Cache Policy Invariants", () => {
  it("passes provider cache tests", async () => {
    const auth = await import("../../../agent-core/auth.ts");
    const compat = await import("../../../agent-core/openai-compat.ts");
    const coreLoad = await import("../../../agent-core/main.ts")
      .then((module) => ({ module, error: null }))
      .catch((error) => ({ module: null, error }));
    const core = coreLoad.module;
    
    function requireCore() {
      if (core) return core;
      const detail = coreLoad.error instanceof Error ? coreLoad.error.message : String(coreLoad.error);
      throw new Error(`agent-core/main.ts could not load: ${detail}`);
    }
    
    const failures = [];
    
    async function test(name, fn) {
      try {
        await fn();
        console.log(`PASS  ${name}`);
      } catch (error) {
        failures.push({ name, error });
        console.error(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    function usageField(usage, field) {
      assert.ok(usage, "provider returned no usage object");
      return usage[field];
    }
    
    function reasoningField(usage) {
      assert.ok(usage, "provider returned no usage object");
      return Object.prototype.hasOwnProperty.call(usage, "reasoning") ? usage.reasoning : usage.reasoningTokens;
    }
    
    function allCacheMarkers(value) {
      if (!value || typeof value !== "object") return [];
      if (Array.isArray(value)) return value.flatMap(allCacheMarkers);
      const record = value;
      const own = Object.prototype.hasOwnProperty.call(record, "cache_control") ||
        Object.prototype.hasOwnProperty.call(record, "prompt_cache_breakpoint")
        ? [record]
        : [];
      return own.concat(Object.values(record).flatMap(allCacheMarkers));
    }
    
    function readJsonLines(path) {
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
    
    function streamFromChunks(chunks, onCancel = () => {}) {
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
        cancel: onCancel,
      });
    }
    
    function encoded(value) {
      return new TextEncoder().encode(value);
    }
    
    /** Run a direct agent-core request against a deterministic in-process fetch. */
    async function runLocalProvider({ provider, model, baseEnv, providerBaseUrl, scenario, terminalId }) {
      const root = mkdtempSync(join(tmpdir(), "agent-core-provider-"));
      const events = join(root, "events");
      mkdirSync(events, { recursive: true, mode: 0o700 });
      const requestLog = join(root, "provider-requests.jsonl");
      const baseUrl = providerBaseUrl ?? `http://provider.local${baseEnv.suffix ?? ""}`;
      const env = {
        ...process.env,
        TERMINA_CORE_TEST: "1",
        TERMINA_CORE_PROVIDER: provider,
        TERMINA_CORE_MODEL: model,
        TERMINA_EVENTS_DIR: events,
        TERMINA_TERMINAL_ID: terminalId,
        TERMINA_CORE_SESSION_ID: `${terminalId}-session`,
        [baseEnv.token]: "provider-test-token",
        TERMINA_AUTH_PATH: join(root, "auth.json"),
        TERMINA_PROVIDER_REQUEST_LOG: requestLog,
        TERMINA_PROVIDER_TEST_SCENARIO: scenario,
      };
      if (providerBaseUrl) delete env[baseEnv.key];
      else env[baseEnv.key] = baseUrl;
      const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
      const childScript = `
        import fs from "node:fs";
        const mainUrl = ${JSON.stringify(mainUrl)};
        const requestLog = process.env.TERMINA_PROVIDER_REQUEST_LOG;
        const providerBase = ${JSON.stringify(baseUrl)};
        let providerCalls = 0;
        globalThis.fetch = async (input, init = {}) => {
          const url = String(input);
          const isProvider = url.startsWith(providerBase);
          let body = null;
          try { body = typeof init.body === "string" ? JSON.parse(init.body) : init.body ?? null; } catch { body = null; }
          if (isProvider) {
            fs.appendFileSync(requestLog, JSON.stringify({ url, body }) + "\\n");
            const call = providerCalls++;
            const serializedInput = JSON.stringify(body?.input ?? "");
            const hasExplicitCacheOptions = Boolean(body?.prompt_cache_options);
            const hasExplicitBreakpoint = serializedInput.includes("prompt_cache_breakpoint");
            const hasCacheControl = serializedInput.includes("cache_control");
            if (
              process.env.TERMINA_PROVIDER_TEST_SCENARIO === "relay" &&
              (hasExplicitCacheOptions || hasExplicitBreakpoint || hasCacheControl)
            ) {
              return new Response(
                JSON.stringify({ error: { message: "relay does not document explicit cache controls" } }),
                { status: 400, headers: { "content-type": "application/json" } },
              );
            }
            if (
              process.env.TERMINA_PROVIDER_TEST_SCENARIO === "openai-explicit" &&
              !hasExplicitCacheOptions
            ) {
              return new Response(
                JSON.stringify({ error: { message: "direct OpenAI fixture expected explicit cache controls" } }),
                { status: 400, headers: { "content-type": "application/json" } },
              );
            }
            if (process.env.TERMINA_PROVIDER_TEST_SCENARIO === "fallback" && call === 0) {
              return new Response(JSON.stringify({ error: { message: "prompt_cache_options is unsupported" } }), { status: 400, headers: { "content-type": "application/json" } });
            }
            if (process.env.TERMINA_PROVIDER_TEST_SCENARIO === "anthropic") {
              const lines = [
                "data: " + JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 12 } } }),
                "",
                "data: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
                "",
                "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
                "",
                "data: " + JSON.stringify({ type: "content_block_stop", index: 0 }),
                "",
                "data: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
                "",
                "data: " + JSON.stringify({ type: "message_stop" }),
                "",
              ];
              return new Response(lines.join("\\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
            }
            const lines = [
              "data: " + JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
              "",
              "data: " + JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 } } }),
              "",
            ];
            return new Response(lines.join("\\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
          }
          return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
        };
        process.argv = [process.execPath, new URL(mainUrl).pathname, "-p", "provider probe"];
        await import(mainUrl);
      `;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript],
        { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    
      const ackTimer = setInterval(() => {
        try {
          const sidecar = readJsonLines(join(events, `${terminalId}.jsonl`));
          const request = sidecar.findLast((record) => record.t === "preflight_request");
          if (request?.requestId) {
            writeFileSync(
              join(events, `ack-${terminalId}-${request.requestId}.json`),
              JSON.stringify({ ok: true }),
              { mode: 0o600 },
            );
          }
        } catch {
          /* Wait until the child writes its preflight request. */
        }
      }, 10);
    
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ code: -1, signal: "SIGKILL" });
        }, 15_000);
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
      clearInterval(ackTimer);
      const requests = readJsonLines(requestLog);
      const traceDir = join(events, `${terminalId}.traces`);
      const traces = existsSync(traceDir)
        ? readdirSync(traceDir)
            .filter((name) => /^turn-\d+\.json$/.test(name))
            .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
            .map((name) => JSON.parse(readFileSync(join(traceDir, name), "utf8")))
        : [];
      rmSync(root, { recursive: true, force: true });
      return { ...result, requests, traces, stdout, stderr };
    }
    
    await test("cache identity is private, stable, bounded, and changes with the session", () => {
      const raw = "session-with-sensitive-project-name";
      const identityInput = {
        sessionSeed: auth.cacheSessionSeed(raw),
        role: "main",
        provider: "openrouter",
        protocol: "openai-responses",
        route: "https://openrouter.ai/api/v1",
      };
      const identity = auth.cacheIdentityFor(identityInput);
      const key = identity?.key;
      assert.notEqual(key, raw);
      assert.ok(key && key.length > 0 && key.length <= 256);
      assert.match(key, /^[\x21-\x7e]+$/, "cache key must be transport-safe ASCII");
      assert.equal(
        auth.cacheIdentityFor({ ...identityInput, sessionSeed: auth.cacheSessionSeed(`  ${raw}  `) })?.key,
        key,
      );
      assert.notEqual(
        key,
        auth.cacheIdentityFor({ ...identityInput, sessionSeed: auth.cacheSessionSeed(`${raw}-other`) })?.key,
      );
      assert.notEqual(auth.cacheSessionSeed(" "), auth.cacheSessionSeed(" "));
    });
    
    await test("cache header namespaces differ across provider routes", () => {
      const session = "same-session";
      const seed = auth.cacheSessionSeed(session);
      const identityFor = (provider, route, protocol = "openai-responses") => auth.cacheIdentityFor({
        sessionSeed: seed,
        role: "main",
        provider,
        protocol,
        route,
      });
      const openrouterIdentity = identityFor("openrouter", "https://openrouter.ai/api/v1");
      const zenIdentity = identityFor("opencode-zen", "https://opencode.ai/zen/v1");
      const xaiIdentity = identityFor("xai", "https://api.x.ai/v1", "openai-completions");
      const openrouter = auth.cacheSessionHeaders(openrouterIdentity)["x-session-id"];
      const xai = auth.cacheSessionHeaders(xaiIdentity)["x-grok-conv-id"];
      assert.ok(openrouter && xai);
      assert.equal(auth.cacheSessionHeaders(zenIdentity)["x-opencode-session"], undefined);
      assert.notEqual(openrouter, xai);
    });
    
    await test("OpenAI usage preserves unknown cache and reasoning counters", () => {
      const result = compat.completionResultFromEvents(
        [{ usage: { prompt_tokens: 100, completion_tokens: 5 } }],
        () => {},
        Date.now(),
      );
      assert.equal(usageField(result.usage, "input"), 100);
      assert.equal(usageField(result.usage, "cacheRead"), null);
      assert.equal(usageField(result.usage, "cacheWrite"), null);
      assert.equal(usageField(result.usage, "output"), 5);
      assert.equal(reasoningField(result.usage), null);
    });
    
    await test("Chat Completions usage merges split nested details", () => {
      const result = compat.completionResultFromEvents(
        [
          { usage: { prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } } },
          { usage: { completion_tokens: 4, prompt_tokens_details: { cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } } },
        ],
        () => {},
        Date.now(),
      );
      assert.equal(usageField(result.usage, "input"), 30);
      assert.equal(usageField(result.usage, "cacheRead"), 20);
      assert.equal(usageField(result.usage, "cacheWrite"), 3);
      assert.equal(usageField(result.usage, "output"), 4);
      assert.equal(reasoningField(result.usage), 1);
    });
    
    await test("OpenAI usage parses cached, cache-write, and reasoning details", () => {
      const result = compat.responsesResultFromEvents(
        [{
          type: "response.completed",
          response: {
            status: "completed",
            output: [],
            usage: {
              input_tokens: 130,
              input_tokens_details: { cached_tokens: 100, cache_write_tokens: 12 },
              output_tokens: 20,
              output_tokens_details: { reasoning_tokens: 7 },
            },
          },
        }],
        () => {},
        Date.now(),
      );
      assert.equal(usageField(result.usage, "input"), 30);
      assert.equal(usageField(result.usage, "cacheRead"), 100);
      assert.equal(usageField(result.usage, "cacheWrite"), 12);
      assert.equal(usageField(result.usage, "output"), 20);
      assert.equal(reasoningField(result.usage), 7);
    });
    
    await test("OpenAI usage distinguishes reported zeroes from absent counters", () => {
      const result = compat.responsesResultFromEvents(
        [{
          type: "response.completed",
          response: {
            status: "completed",
            output: [],
            usage: {
              input_tokens: 0,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: 0,
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        }],
        () => {},
        Date.now(),
      );
      assert.equal(usageField(result.usage, "input"), 0);
      assert.equal(usageField(result.usage, "cacheRead"), 0);
      assert.equal(usageField(result.usage, "cacheWrite"), 0);
      assert.equal(usageField(result.usage, "output"), 0);
      assert.equal(reasoningField(result.usage), 0);
    });
    
    await test("Google usage preserves unknown fields and records thoughtsTokenCount", () => {
      const result = compat.googleResultFromEvents(
        [{ usageMetadata: { promptTokenCount: 50, cachedContentTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 6 } }],
        () => {},
        Date.now(),
      );
      assert.equal(usageField(result.usage, "input"), 30);
      assert.equal(usageField(result.usage, "cacheRead"), 20);
      assert.equal(usageField(result.usage, "cacheWrite"), null);
      assert.equal(usageField(result.usage, "output"), 10);
      assert.equal(reasoningField(result.usage), 6);
    });
    
    await test("Google missing usage counters remain unknown instead of zero", () => {
      const result = compat.googleResultFromEvents(
        [{ usageMetadata: { candidatesTokenCount: 3 } }],
        () => {},
        Date.now(),
      );
      assert.equal(usageField(result.usage, "input"), null);
      assert.equal(usageField(result.usage, "cacheRead"), null);
      assert.equal(usageField(result.usage, "cacheWrite"), null);
      assert.equal(usageField(result.usage, "output"), 3);
      assert.equal(reasoningField(result.usage), null);
    });
    
    await test("SSE parser flushes a final unterminated UTF-8 event", async () => {
      const source = encoded(
        'data: {"type":"response.output_text.delta","delta":"é"}\n' +
          'data: {"type":"response.completed"}',
      );
      const prefixBytes = encoded('data: {"type":"response.output_text.delta","delta":"');
      const events = await compat.readSseJson(
        streamFromChunks([source.slice(0, prefixBytes.length + 1), source.slice(prefixBytes.length + 1)]),
      );
      assert.deepEqual(events, [
        { type: "response.output_text.delta", delta: "é" },
        { type: "response.completed" },
      ]);
    });
    
    await test("SSE parser surfaces malformed JSON data events", async () => {
      await assert.rejects(
        compat.readSseJson(streamFromChunks([encoded('data: {"type":"response.completed"\n')])),
        /malformed JSON/i,
      );
    });
    
    await test("SSE parser surfaces a nonempty incomplete EOF tail", async () => {
      await assert.rejects(
        compat.readSseJson(streamFromChunks([encoded('data: {"type":"response.completed"}\nevent: unfinished')])),
        /EOF tail|incomplete/i,
      );
    });
    
    await test("SSE parser rejects partial text without a terminal event", async () => {
      await assert.rejects(
        compat.readSseJson(streamFromChunks([encoded('data: {"type":"response.output_text.delta","delta":"partial"}\n')])),
        /terminal|incomplete/i,
      );
    });
    
    await test("SSE parser rejects partial tool JSON without a terminal event", async () => {
      await assert.rejects(
        compat.readSseJson(streamFromChunks([encoded('data: {"type":"response.function_call_arguments.delta","delta":"{\\\"path\\\":\\\"partial"}\n')])),
        /terminal|incomplete/i,
      );
    });
    
    await test("SSE parser preserves explicit user abort instead of reporting an incomplete stream", async () => {
      const controller = new AbortController();
      controller.abort();
      const events = await compat.readSseJson(
        streamFromChunks([encoded('data: {"type":"response.output_text.delta","delta":"partial"}\n')]),
        controller.signal,
      );
      assert.deepEqual(events, []);
    });
    
    await test("SSE parser recognizes protocol terminal markers before EOF", async () => {
      const chat = await compat.readSseJson(
        streamFromChunks([encoded('data: {"choices":[{"finish_reason":"tool_calls"}]}\n')]),
      );
      assert.equal(chat[0]?.choices?.[0]?.finish_reason, "tool_calls");
      const done = await compat.readSseJson(
        streamFromChunks([encoded('data: {"type":"response.output_text.delta","delta":"ok"}\ndata: [DONE]\n')]),
      );
      assert.equal(done.length, 1);
    });
    
    await test("SSE parser rejects an oversized unterminated final decoder buffer", async () => {
      const source = new Uint8Array(compat.MAX_SSE_BUFFER_BYTES);
      const prefix = encoded('data: {"text":"');
      source.set(prefix);
      source.fill(0x78, prefix.length, source.length - 1);
      // Leave one leading UTF-8 byte for TextDecoder's final flush. The first
      // read is within the cap; the decoded replacement at EOF crosses it.
      source[source.length - 1] = 0xc3;
      await assert.rejects(
        compat.readSseJson(streamFromChunks([source])),
        /decoded buffer/i,
      );
    });
    
    await test("SSE parser bounds aggregate parsed payload bytes", async () => {
      const chunks = [];
      const payload = "x".repeat(4096);
      const eventPayload = JSON.stringify({ type: "tick", payload });
      const count = Math.ceil(compat.MAX_SSE_PAYLOAD_BYTES / eventPayload.length) + 1;
      for (let i = 0; i < count; i++) {
        chunks.push(encoded(`data: ${eventPayload}\n`));
      }
      await assert.rejects(
        compat.readSseJson(streamFromChunks(chunks)),
        /payload bytes/i,
      );
    });
    
    await test("SSE parser cancels an endless event stream at the event cap", async () => {
      let cancelled = false;
      const stream = new ReadableStream({
        pull(controller) {
          controller.enqueue(encoded('data: {"type":"tick"}\n'));
        },
        cancel() {
          cancelled = true;
        },
      });
      await assert.rejects(compat.readSseJson(stream), /event count/i);
      assert.equal(cancelled, true);
    });
    
    await test("native Google cache lifecycle serializers use documented REST shapes", () => {
      const create = compat.googleCachedContentCreateRequest({
        model: "gemini-3.7-flash",
        contents: [{ role: "user", parts: [{ text: "stable context" }] }],
        systemInstruction: "Answer concisely.",
        tools: [{ functionDeclarations: [{ name: "lookup" }] }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        ttl: "3.5s",
        displayName: "provider-cache-fixture",
      });
      assert.equal(create.method, "POST");
      assert.equal(create.path, "/v1beta/cachedContents");
      assert.deepEqual(create.body, {
        model: "models/gemini-3.7-flash",
        contents: [{ role: "user", parts: [{ text: "stable context" }] }],
        systemInstruction: { parts: [{ text: "Answer concisely." }] },
        tools: [{ functionDeclarations: [{ name: "lookup" }] }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        ttl: "3.5s",
        displayName: "provider-cache-fixture",
      });
    
      assert.deepEqual(compat.googleCachedContentGetRequest("cachedContents/cache-1"), {
        method: "GET",
        path: "/v1beta/cachedContents/cache-1",
      });
      assert.deepEqual(compat.googleCachedContentUpdateRequest("cachedContents/cache-1", "600s"), {
        method: "PATCH",
        path: "/v1beta/cachedContents/cache-1",
        query: { updateMask: "ttl" },
        body: { ttl: "600s" },
      });
      assert.deepEqual(compat.googleCachedContentDeleteRequest("cachedContents/cache-1"), {
        method: "DELETE",
        path: "/v1beta/cachedContents/cache-1",
      });
    });
    
    await test("native Google cache serializers reject malformed names and TTLs", () => {
      assert.throws(
        () => compat.googleCachedContentGetRequest("cachedContents/cache/extra"),
        /cached content name/i,
      );
      assert.throws(
        () => compat.googleCachedContentUpdateRequest("cachedContents/cache-1", "1m"),
        /TTL/i,
      );
      assert.throws(
        () => compat.googleCachedContentCreateRequest({ model: "gemini-3.7-flash", ttl: "1.1234567890s" }),
        /TTL/i,
      );
    });
    
    await test("native Google cache request content is bounded instead of truncated", () => {
      assert.throws(
        () => compat.googleCachedContentCreateRequest({
          model: "gemini-3.7-flash",
          contents: [{ role: "user", parts: [{ text: "x".repeat(9 * 1024 * 1024) }] }],
        }),
        /cached content request exceeds/i,
      );
    });
    
    await test("native Google cache response parser validates resources and keeps nullable metadata", () => {
      const parsed = compat.parseGoogleCachedContent({
        name: "cachedContents/cache-1",
        model: "models/gemini-3.7-flash",
        ttl: "3.5s",
        usageMetadata: { totalTokenCount: 42 },
      });
      assert.deepEqual(parsed, {
        name: "cachedContents/cache-1",
        model: "models/gemini-3.7-flash",
        ttl: "3.5s",
        usageMetadata: { totalTokenCount: 42 },
      });
      assert.equal(compat.parseGoogleCachedContent({ name: "cache-1", model: "models/gemini-3.7-flash" }), null);
      assert.equal(compat.parseGoogleCachedContent({ name: "cachedContents/cache-1", ttl: "1m" }), null);
      assert.equal(compat.parseGoogleCachedContentDeleteResponse({}), true);
      assert.equal(compat.parseGoogleCachedContentDeleteResponse(undefined), true);
    });
    
    await test("cachedContent is emitted only by the native Google generateContent serializer", () => {
      const native = compat.googleGenerateBody(
        "sys",
        [{ role: "user", content: "follow-up" }],
        [],
        { provider: "google", cachedContent: "cachedContents/cache-1" },
      );
      assert.equal(native.cachedContent, "cachedContents/cache-1");
    
      const zen = compat.googleGenerateBody(
        "sys",
        [{ role: "user", content: "follow-up" }],
        [],
        { provider: "opencode-zen", cachedContent: "cachedContents/cache-1" },
      );
      assert.equal(zen.cachedContent, undefined);
    
      const compatible = compat.completionsBody(
        "gemini-3.7-flash",
        "sys",
        [{ role: "user", content: "follow-up" }],
        [],
        "max_tokens",
        { provider: "google", cachedContent: "cachedContents/cache-1" },
      );
      assert.equal(compatible.cachedContent, undefined);
    });
    
    await test("native Google generateContent cache reference validates the resource name", () => {
      assert.throws(
        () => compat.googleGenerateBody("", [{ role: "user", content: "follow-up" }], [], { provider: "google", cachedContent: "cache-1" }),
        /cached content name/i,
      );
    });
    
    await test("Google completions never emit an undocumented prompt cache key", () => {
      const body = compat.completionsBody(
        "gemini-3.7-flash",
        "sys",
        [{ role: "user", content: "hello" }],
        [],
        "max_tokens",
        { cacheKey: "derived-private-key", sessionId: "openrouter-session", provider: "google" },
      );
      assert.equal(body.prompt_cache_key, undefined);
      assert.equal(body.session_id, undefined);
    });
    
    await test("Gemini route does not emit OpenAI cache controls", () => {
      const body = compat.responsesBody(
        "google/gemini-3.7-flash",
        "sys",
        [{ role: "user", content: "hello" }],
        [],
        {
          cacheKey: "derived-private-key",
          sessionId: "openrouter-session",
          provider: "opencode-zen",
          promptCacheMode: "explicit",
          explicitCacheBreakpoint: true,
          explicitCacheSkipTail: false,
          cacheControl: true,
        },
      );
      assert.equal(body.prompt_cache_key, undefined);
      assert.equal(body.session_id, undefined);
      assert.equal(body.prompt_cache_options, undefined);
      assert.equal(body.input[0]?.content?.[0]?.prompt_cache_breakpoint, undefined);
      assert.equal(body.input[0]?.content?.[0]?.cache_control, undefined);
    });
    
    await test("optional cache controls follow documented route inputs", () => {
      const opts = {
        cacheKey: "derived-private-key",
        sessionId: "openrouter-session",
        promptCacheMode: "explicit",
        explicitCacheBreakpoint: true,
        explicitCacheSkipTail: false,
        cacheControl: true,
      };
      const openai = compat.responsesBody(
        "gpt-5.6-sol",
        "sys",
        [{ role: "user", content: "stable" }, { role: "user", content: "tail" }],
        [],
        { ...opts, provider: "openai" },
      );
      assert.equal(openai.prompt_cache_key, opts.cacheKey);
      assert.equal(openai.prompt_cache_options?.mode, "explicit");
      assert.equal(openai.input.at(-1)?.content?.[0]?.prompt_cache_breakpoint?.mode, "explicit");
      assert.equal(openai.session_id, undefined);
    
      const xai = compat.responsesBody(
        "grok-4.6",
        "sys",
        [{ role: "user", content: "stable" }, { role: "user", content: "tail" }],
        [],
        { ...opts, provider: "xai" },
      );
      assert.equal(xai.prompt_cache_key, opts.cacheKey);
      assert.equal(xai.prompt_cache_options, undefined);
      assert.equal(xai.input[0]?.content?.[0]?.prompt_cache_breakpoint, undefined);
      assert.equal(xai.input[0]?.content?.[0]?.cache_control, undefined);
      assert.equal(xai.session_id, undefined);
    });
    
    await test("OpenAI usage marks impossible cache totals unknown", () => {
      const openai = compat.responsesResultFromEvents(
        [{
          type: "response.completed",
          response: {
            status: "completed",
            output: [],
            usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 20 }, output_tokens: 1 },
          },
        }],
        () => {},
        Date.now(),
      );
      assert.equal(usageField(openai.usage, "input"), null);
      assert.equal(usageField(openai.usage, "cacheRead"), 20);
    
      const google = compat.googleResultFromEvents(
        [{ usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 20, candidatesTokenCount: 1 } }],
        () => {},
        Date.now(),
      );
      assert.equal(usageField(google.usage, "input"), null);
      assert.equal(usageField(google.usage, "cacheRead"), 20);
    });
    
    await test("non-stream payload helpers preserve absent usage", () => {
      assert.equal(compat.textFromCompletionPayload({ choices: [{ message: { content: "ok" } }] }).usage, undefined);
      assert.equal(compat.textFromResponsesPayload({ output_text: "ok" }).usage, undefined);
      const google = compat.textFromGooglePayload({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { candidatesTokenCount: 1 },
      });
      assert.equal(usageField(google.usage, "input"), null);
      assert.equal(usageField(google.usage, "cacheWrite"), null);
    });
    
    await test("xAI Responses usage records cache reads and reasoning tokens", () => {
      const result = compat.responsesResultFromEvents(
        [{
          type: "response.completed",
          response: {
            status: "completed",
            output: [],
            usage: {
              input_tokens: 80,
              input_tokens_details: { cached_tokens: 40 },
              output_tokens: 18,
              output_tokens_details: { reasoning_tokens: 9 },
            },
          },
        }],
        () => {},
        Date.now(),
      );
      assert.equal(usageField(result.usage, "input"), 40);
      assert.equal(usageField(result.usage, "cacheRead"), 40);
      assert.equal(usageField(result.usage, "cacheWrite"), null);
      assert.equal(usageField(result.usage, "output"), 18);
      assert.equal(reasoningField(result.usage), 9);
    });
    
    await test("Anthropic direct history markers stay within the documented 20-block lookback", () => {
      const history = [{ role: "user", content: [{ type: "text", text: "old reusable text" }] }];
      for (let i = 0; i < 20; i++) {
        history.push({ role: "assistant", content: [{ type: "thinking", thinking: `thought-${i}` }] });
      }
      const stamped = requireCore().stampHistoryCache(history, "anthropic");
      assert.equal(allCacheMarkers(stamped).length, 0);
    });
    
    await test("Anthropic direct prefix never exceeds four explicit breakpoints", () => {
      const premarkedTools = [0, 1, 2, 3, 4].map((i) => ({
        name: `tool-${i}`,
        description: "tool",
        input_schema: { type: "object" },
        ...(i < 4 ? { cache_control: { type: "ephemeral" } } : {}),
      }));
      const prefix = requireCore().buildCachedPrefix("system", premarkedTools, "anthropic");
      assert.ok(allCacheMarkers(prefix).length <= 4);
    });
    
    await test("route capability defaults do not claim OpenCode Zen GPT explicit caching", () => {
      assert.equal(auth.usesOpenAIExplicitCache("gpt-5.6-sol", "opencode-zen"), false);
      assert.equal(auth.usesPromptCacheOptions("opencode-zen", "gpt-5.6-sol"), false);
    });
    
    await test("direct OpenAI route may use documented explicit cache controls", async () => {
      const result = await runLocalProvider({
        provider: "openai",
        model: "gpt-5.6-sol",
        terminalId: "term-openai-explicit",
        baseEnv: { key: "OPENAI_BASE_URL", token: "OPENAI_API_KEY", suffix: "/v1" },
        providerBaseUrl: "https://api.openai.com/v1",
        scenario: "openai-explicit",
      });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(result.requests.length, 1);
      const body = result.requests[0].body;
      assert.equal(body.prompt_cache_options?.mode, "explicit");
      assert.equal(body.prompt_cache_options?.ttl, "30m");
    });
    
    await test("custom relay route does not receive undocumented explicit cache controls", async () => {
      const result = await runLocalProvider({
        provider: "xai",
        model: "grok-4.6",
        terminalId: "term-xai-relay",
        baseEnv: { key: "XAI_BASE_URL", token: "XAI_API_KEY", suffix: "/v1" },
        scenario: "relay",
      });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(result.requests.length, 1);
      const body = result.requests[0].body;
      assert.equal(body.prompt_cache_options, undefined);
      assert.equal(JSON.stringify(body.input).includes("prompt_cache_breakpoint"), false);
      assert.equal(JSON.stringify(body.input).includes("cache_control"), false);
    });
    
    await test("optional cache-field rejection is one linked, byte-identical fallback", async () => {
      const result = await runLocalProvider({
        provider: "openai",
        model: "gpt-5.6-sol",
        terminalId: "term-openai-fallback",
        baseEnv: { key: "OPENAI_BASE_URL", token: "OPENAI_API_KEY", suffix: "/v1" },
        providerBaseUrl: "https://api.openai.com/v1",
        scenario: "fallback",
      });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(result.requests.length, 2);
      const first = result.requests[0].body;
      const second = result.requests[1].body;
      assert.equal(first.prompt_cache_options?.mode, "explicit");
      assert.equal(second.prompt_cache_options, undefined);
      assert.deepEqual(second.input, first.input);
      const attempts = result.traces.filter((trace) => trace.recordType === "attempt");
      assert.ok(attempts.length >= 2, "fallback must leave one trace record per provider attempt");
      assert.equal(new Set(attempts.map((trace) => trace.attemptId)).size, attempts.length);
      assert.equal(new Set(attempts.map((trace) => trace.taskId)).size, 1);
      assert.ok(
        attempts.some((trace) =>
          Boolean(trace.fallbackReason) ||
          Boolean(trace.cache?.requested?.fallbackReason) ||
          Boolean(trace.cache?.effective?.fallbackReason),
        ),
        "fallback reason must be retained on an attempt",
      );
      assert.ok(
        attempts.some((trace) => trace.cache?.requested?.rejected === true || trace.cache?.effective?.rejected === true),
        "the rejected cache policy must remain observable",
      );
      assert.ok(attempts.some((trace) => trace.cache?.retryPromptIdentical === true));
    });
    
    await test("Anthropic trace keeps missing cache and reasoning usage unknown", async () => {
      const result = await runLocalProvider({
        provider: "anthropic",
        model: "claude-sonnet-5",
        terminalId: "term-anthropic-usage",
        baseEnv: { key: "ANTHROPIC_BASE_URL", token: "ANTHROPIC_API_KEY", suffix: "" },
        scenario: "anthropic",
      });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(result.requests.length, 1);
      const trace = result.traces.find((entry) => entry.recordType === "attempt") ?? result.traces[0];
      assert.ok(trace, "provider call must emit an attempt trace");
      const usage = trace.usage;
      assert.equal(usage.input, 12);
      assert.equal(usage.cacheRead, null);
      assert.equal(usage.cacheWrite, null);
      assert.equal(usage.output, 3);
      assert.equal(reasoningField(usage), null);
    });
    
    if (failures.length > 0) {
      console.error(`\n${failures.length} provider/cache test(s) failed as expected for RED phase.`);
      process.exitCode = 1;
    } else {
      console.log("\nprovider/cache tests passed");
    }
  }, 60_000);
});
