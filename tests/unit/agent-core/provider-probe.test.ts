import { describe, it, expect } from "vitest";
/**
 * Tests for the controlled provider cache probe.
 *
 * The live-mode cases use an in-memory HTTP fetch mock only. They never
 * contact a provider. The probe itself remains dry-run unless its caller
 * explicitly opts into live mode.
 *
 *   node scripts/agent-core-provider-probe-test.mjs
 */
import assert from "node:assert/strict";

import {
  FIXTURE_ID,
  ProbeConfigurationError,
  buildProbePlan,
  runProviderCacheProbe,
} from "./provider-probe.ts";

describe("Agent Core Provider Probe Invariants", () => {
  it("passes provider probe tests", async () => {
    const SOURCE_URLS = {
      anthropic: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
      openai: "https://developers.openai.com/api/docs/guides/prompt-caching",
      xai: "https://docs.x.ai/developers/advanced-api-usage/prompt-caching",
      openrouter: "https://openrouter.ai/docs/guides/best-practices/prompt-caching",
    };
    
    const RETRIEVED_AT = "2026-08-30T12:00:00.000Z";
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
    
    function config(overrides = {}) {
      const provider = overrides.provider ?? "openai";
      return {
        endpoint: "https://api.openai.com/v1/responses",
        provider,
        model: "gpt-5.6-mini",
        protocol: "openai-responses",
        sessionId: "sensitive-project-session",
        sourceUrl: SOURCE_URLS[provider] ?? SOURCE_URLS.openai,
        retrievedAt: RETRIEVED_AT,
        apiKey: "provider-test-token",
        ...overrides,
      };
    }
    
    async function startMockProvider({ status = 200, payload, onRequest } = {}) {
      const requests = [];
      const fetchImpl = async (input, init = {}) => {
        const raw = typeof init.body === "string" ? init.body : "";
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        const item = {
          method: init.method,
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          raw,
          body,
          redirect: init.redirect,
          signal: init.signal,
        };
        requests.push(item);
        const result = onRequest ? await onRequest(item, requests.length, init) : { status, payload };
        return new Response(JSON.stringify(result.payload ?? payload ?? {}), {
          status: result.status ?? status,
          headers: { "content-type": "application/json" },
        });
      };
      return {
        endpoint: "http://127.0.0.1:1/probe",
        requests,
        fetchImpl,
      };
    }
    
    await test("dry-run is the default and never invokes fetch", async () => {
      let calls = 0;
      const result = await runProviderCacheProbe(config(), {
        fetchImpl: async () => {
          calls += 1;
          throw new Error("network must not be reached in dry-run mode");
        },
      });
      assert.equal(result.mode, "dry-run");
      assert.equal(calls, 0);
      assert.equal(result.fixtureId, FIXTURE_ID);
      assert.equal(result.attempts.length, 0);
      assert.ok(result.requestPlan.requestBodyHash);
      assert.ok(result.requestPlan.stablePrefixHash);
      assert.ok(result.source.url.startsWith("https://"));
      assert.equal(result.source.retrievedAt, RETRIEVED_AT);
      const serialized = JSON.stringify(result);
      assert.doesNotMatch(serialized, /sensitive-project-session/);
      assert.doesNotMatch(serialized, /provider-test-token/);
      assert.doesNotMatch(serialized, /You are an agent-core provider probe/);
      assert.equal(result.requestPlan.body, undefined, "dry-run must not expose the prompt body");
    });
    
    await test("endpoint, provider, model, and protocol are mandatory", async () => {
      for (const field of ["endpoint", "provider", "model", "protocol"]) {
        const missing = config();
        delete missing[field];
        await assert.rejects(
          () => runProviderCacheProbe(missing),
          (error) => error instanceof ProbeConfigurationError && error.code === "MISSING_FIELD",
          `missing ${field} should fail closed`,
        );
      }
    });
    
    await test("documentation retrieval time is explicit and distinct from probe time", async () => {
      const missing = config();
      delete missing.retrievedAt;
      await assert.rejects(
        () => runProviderCacheProbe(missing),
        (error) => error instanceof ProbeConfigurationError && error.code === "MISSING_FIELD",
      );
      const result = await runProviderCacheProbe(config());
      assert.equal(result.source.retrievedAt, RETRIEVED_AT);
      assert.ok(result.startedAt);
      assert.ok(result.finishedAt);
      assert.notEqual(result.source.retrievedAt, result.startedAt);
    });
    
    await test("live mode requires an explicit opt-in before fetch", async () => {
      const mock = await startMockProvider({ payload: { output_text: "not recorded" } });
      await assert.rejects(
        () => runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          allowHosts: ["127.0.0.1"],
          live: true,
        }), { fetchImpl: mock.fetchImpl }),
        (error) => error instanceof ProbeConfigurationError && error.code === "LIVE_OPT_IN_REQUIRED",
      );
      assert.equal(mock.requests.length, 0);
    });
    
    await test("route allowlist rejects an endpoint outside the provider route", async () => {
      assert.throws(
        () => buildProbePlan(config({ endpoint: "https://example.invalid/probe" })),
        (error) => error instanceof ProbeConfigurationError && error.code === "ROUTE_NOT_ALLOWED",
      );
      assert.throws(
        () => buildProbePlan(config({ provider: "opencode-zen", protocol: "openai-responses", model: "gpt-5.6" })),
        (error) => error instanceof ProbeConfigurationError && error.code === "PROBE_DISABLED",
      );
      assert.throws(
        () => buildProbePlan(config({ provider: "google", protocol: "openai-completions", model: "gemini-2.5-flash" })),
        (error) => error instanceof ProbeConfigurationError && error.code === "PROBE_DISABLED",
      );
    });
    
    await test("OpenAI optional-field rejection gets exactly one retry with an identical stable prefix", async () => {
      const mock = await startMockProvider({
        onRequest: (_request, attempt) => attempt === 1
          ? { status: 400, payload: { error: { message: "prompt_cache_options is unsupported" } } }
          : {
            status: 200,
            payload: {
              id: "resp_probe",
              output_text: "probe output must not be recorded",
              usage: {
                input_tokens: 12,
                input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
                output_tokens: 3,
                output_tokens_details: { reasoning_tokens: 1 },
              },
            },
          },
      });
      try {
        const result = await runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          allowHosts: ["127.0.0.1"],
          live: true,
          allowLive: true,
        }), { fetchImpl: mock.fetchImpl });
        assert.equal(mock.requests.length, 2);
        assert.equal(result.mode, "live-mock");
        assert.equal(result.attempts.length, 2);
        assert.equal(result.retry.count, 1);
        assert.equal(result.retry.reason, "optional-field-rejection");
        assert.equal(result.attempts[0].requestedPolicy.cacheFields.includes("prompt_cache_options"), true);
        assert.equal(result.attempts[0].requestedPolicy.cacheFields.includes("prompt_cache_breakpoint"), true);
        assert.equal(mock.requests[0].body.store, false);
        assert.equal(mock.requests[0].body.tool_choice, "auto");
        assert.equal(mock.requests[0].body.parallel_tool_calls, true);
        assert.equal(mock.requests[0].body.tools[0].strict, false);
        assert.equal(result.attempts[1].effectivePolicy.cacheFields.length, 0);
        assert.equal(result.attempts[1].stablePrefixByteIdentical, true);
        assert.equal(result.attempts[1].usage.input, 6);
        assert.equal(result.attempts[1].usage.cacheRead, 4);
        assert.equal(result.attempts[1].usage.cacheWrite, 2);
        assert.equal(result.attempts[1].usage.output, 3);
        assert.equal(result.attempts[1].usage.reasoning, 1);
        assert.equal(result.attempts[1].policyAcceptance, "unknown");
        assert.equal(result.attempts[1].responseHash.length, 64);
        assert.equal(result.attempts[1].responseBody, undefined);
        assert.equal(result.attempts[0].requestBody, undefined);
        assert.equal(result.trace.format, "agent-core-trace-v2");
        assert.equal(result.trace.attempts.length, 2);
        assert.equal(result.trace.attempts[0].recordType, "attempt");
        assert.equal(result.trace.attempts[0].schemaVersion, 2);
        assert.equal(result.trace.attempts[0].taskId, result.trace.taskSettled.taskId);
        assert.equal(result.trace.attempts[1].retryOfAttemptId, result.trace.attempts[0].attemptId);
        assert.equal(result.trace.taskSettled.attemptCount, 2);
        assert.equal(result.trace.taskSettled.outcome.correctness, null);
        assert.equal(result.trace.attempts[1].cache.effective.rejected, null);
        assert.deepEqual(result.trace.providerUsage, [
          { attemptId: result.trace.attempts[0].attemptId, cacheWriteBreakdown: null },
          { attemptId: result.trace.attempts[1].attemptId, cacheWriteBreakdown: null },
        ]);
        const serialized = JSON.stringify(result);
        assert.doesNotMatch(serialized, /provider-test-token/);
        assert.doesNotMatch(serialized, /probe output must not be recorded/);
        assert.doesNotMatch(serialized, /sensitive-project-session/);
        assert.ok(result.attempts[0].startedAt);
        assert.ok(result.attempts[0].finishedAt);
        assert.equal(result.source.retrievedAt, RETRIEVED_AT);
      } finally {
        /* The in-memory mock has no socket to close. */
      }
    });

    await test("OpenRouter Responses probe requests use documented fields", async () => {
      const openaiPlan = buildProbePlan(config({
        endpoint: "https://openrouter.ai/api/v1/responses",
        provider: "openrouter",
        model: "openai/gpt-5.6",
        protocol: "openai-responses",
        sourceUrl: SOURCE_URLS.openrouter,
      }));
      assert.equal(openaiPlan.requestPlan.requestedPolicy.cacheFields.includes("prompt_cache_key"), true);
      assert.equal(openaiPlan.requestPlan.requestedPolicy.cacheFields.includes("prompt_cache_options"), true);
      assert.equal(openaiPlan.requestPlan.requestedPolicy.cacheFields.includes("prompt_cache_breakpoint"), true);
      assert.equal(openaiPlan.requestPlan.requestedPolicy.cacheFields.includes("session_id"), true);
      assert.equal(openaiPlan.requestPlan.headers["x-session-id"], "[REDACTED]");

      const anthropicPlan = buildProbePlan(config({
        endpoint: "https://openrouter.ai/api/v1/responses",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        protocol: "openai-responses",
        sourceUrl: SOURCE_URLS.openrouter,
      }));
      assert.equal(anthropicPlan.requestPlan.requestedPolicy.cacheFields.includes("prompt_cache_breakpoint"), true);
      assert.equal(anthropicPlan.requestPlan.requestedPolicy.cacheFields.includes("prompt_cache_options"), false);
    });
    
    await test("a repeated optional-field rejection is not retried a second time", async () => {
      let calls = 0;
      const mock = await startMockProvider({
        onRequest: () => {
          calls += 1;
          return { status: 400, payload: { error: { message: "prompt_cache_breakpoint is unsupported" } } };
        },
      });
      try {
        const result = await runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          allowHosts: ["127.0.0.1"],
          live: true,
          allowLive: true,
        }), { fetchImpl: mock.fetchImpl });
        assert.equal(calls, 2);
        assert.equal(result.attempts.length, 2);
        assert.equal(result.retry.count, 1);
        assert.equal(result.attempts.at(-1).httpStatus, 400);
      } finally {
        /* The in-memory mock has no socket to close. */
      }
    });
    
    await test("Anthropic direct requests use documented markers and preserve nullable usage", async () => {
      const mock = await startMockProvider({
        payload: {
          id: "msg_probe",
          content: [{ type: "text", text: "not recorded" }],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 6,
            cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 },
            output_tokens: 2,
          },
        },
      });
      try {
        const result = await runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          protocol: "anthropic-messages",
          sourceUrl: SOURCE_URLS.anthropic,
          allowHosts: ["127.0.0.1"],
          live: true,
          allowLive: true,
        }), { fetchImpl: mock.fetchImpl });
        assert.equal(mock.requests.length, 1);
        const body = mock.requests[0].body;
        assert.equal(body.model, "claude-sonnet-4-20250514");
        assert.ok(Array.isArray(body.system));
        assert.ok(Array.isArray(body.messages));
        assert.ok(JSON.stringify(body).includes("cache_control"));
        assert.equal(result.attempts[0].usage.input, 10);
        assert.equal(result.attempts[0].usage.cacheRead, 4);
        assert.equal(result.attempts[0].usage.cacheWrite, 6);
        assert.deepEqual(result.attempts[0].usage.cacheWriteBreakdown, { ephemeral5m: 2, ephemeral1h: 4 });
        assert.deepEqual(result.trace.providerUsage[0].cacheWriteBreakdown, { ephemeral5m: 2, ephemeral1h: 4 });
        assert.equal(result.attempts[0].usage.output, 2);
        assert.equal(result.attempts[0].usage.reasoning, null);
        assert.equal(result.attempts[0].policyAcceptance, "unknown");
        assert.equal(result.attempts[0].requestedPolicy.ttl, "1h");
      } finally {
        /* The in-memory mock has no socket to close. */
      }
    });
    
    await test("impossible cached totals are recorded as unknown, not as a cache hit", async () => {
      const mock = await startMockProvider({
        payload: {
          output_text: "not recorded",
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 20 }, output_tokens: 1 },
        },
      });
      try {
        const result = await runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          allowHosts: ["127.0.0.1"],
          live: true,
          allowLive: true,
        }), { fetchImpl: mock.fetchImpl });
        assert.equal(result.attempts[0].usage.input, null);
        assert.equal(result.attempts[0].usage.cacheRead, null);
        assert.equal(result.attempts[0].cacheObservation, "unknown");
        assert.equal(result.attempts[0].missCause, "unknown");
      } finally {
        /* The in-memory mock has no socket to close. */
      }
    });
    
    await test("xAI Responses and OpenRouter session fields remain route-specific", async () => {
      const mock = await startMockProvider({
        payload: { output_text: "not recorded", usage: { input_tokens: 2, output_tokens: 1 } },
      });
      try {
        const xai = await runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          provider: "xai",
          model: "grok-4.6",
          protocol: "openai-responses",
          sourceUrl: SOURCE_URLS.xai,
          allowHosts: ["127.0.0.1"],
          live: true,
          allowLive: true,
        }), { fetchImpl: mock.fetchImpl });
        const xaiBody = mock.requests[0].body;
        assert.ok(typeof xaiBody.prompt_cache_key === "string");
        assert.equal(xaiBody.prompt_cache_options, undefined);
        assert.equal(mock.requests[0].headers["x-grok-conv-id"], undefined);
        assert.equal(xai.attempts[0].usage.cacheRead, null);
    
        mock.requests.length = 0;
        const openrouter = await runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          provider: "openrouter",
          model: "openai/gpt-5.6",
          protocol: "openai-completions",
          sourceUrl: SOURCE_URLS.openrouter,
          allowHosts: ["127.0.0.1"],
          live: true,
          allowLive: true,
        }), { fetchImpl: mock.fetchImpl });
        const routerBody = mock.requests[0].body;
        assert.ok(typeof routerBody.session_id === "string");
        assert.ok(routerBody.session_id.length <= 256);
        assert.equal(mock.requests[0].headers["x-session-id"], routerBody.session_id);
        assert.equal(routerBody.prompt_cache_options, undefined);
        assert.equal(openrouter.attempts[0].policyAcceptance, "unknown");
      } finally {
        /* The in-memory mock has no socket to close. */
      }
    });
    
    await test("missing provider usage remains null instead of being reported as a miss", async () => {
      const mock = await startMockProvider({ payload: { output_text: "not recorded", usage: { input_tokens: 7, output_tokens: 1 } } });
      try {
        const result = await runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          allowHosts: ["127.0.0.1"],
          live: true,
          allowLive: true,
        }), { fetchImpl: mock.fetchImpl });
        assert.equal(result.attempts[0].usage.input, 7);
        assert.equal(result.attempts[0].usage.cacheRead, null);
        assert.equal(result.attempts[0].usage.cacheWrite, null);
        assert.equal(result.attempts[0].usage.reasoning, null);
        assert.equal(result.attempts[0].cacheObservation, "unknown");
        assert.equal(result.attempts[0].missCause, "unknown");
      } finally {
        /* The in-memory mock has no socket to close. */
      }
    });
    
    await test("repeat requests keep identical fixture bytes while preserving unknown hit attribution", async () => {
      const mock = await startMockProvider({
        payload: { output_text: "not recorded", usage: { input_tokens: 7, output_tokens: 1 } },
      });
      try {
        const result = await runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          allowHosts: ["127.0.0.1"],
          repeat: 3,
          gapsMs: [0, 0],
          live: true,
          allowLive: true,
        }), { fetchImpl: mock.fetchImpl });
        assert.equal(mock.requests.length, 3);
        assert.equal(result.attempts.length, 3);
        assert.equal(result.retry.count, 0);
        assert.deepEqual(
          result.attempts.map((attempt) => attempt.requestBodyHash),
          [result.attempts[0].requestBodyHash, result.attempts[0].requestBodyHash, result.attempts[0].requestBodyHash],
        );
        assert.ok(result.attempts.every((attempt) => attempt.missCause === "unknown"));
        assert.equal(result.cacheHit, undefined);
      } finally {
        /* The in-memory mock has no socket to close. */
      }
    });
    
    await test("caller-selected threshold fixture is bounded and never returned", async () => {
      const result = await runProviderCacheProbe(config({
        fixture: { id: "threshold-2048-bytes", targetBytes: 2048 },
      }));
      assert.equal(result.fixtureId, "threshold-2048-bytes");
      assert.ok(result.requestPlan.fixtureSizeBytes >= 2048);
      assert.equal(result.requestPlan.body, undefined);
      assert.doesNotMatch(JSON.stringify(result), /threshold fixture padding/);
    });
    
    await test("redirects are sent manually and rejected without a fallback request", async () => {
      const mock = await startMockProvider({
        onRequest: () => ({
          status: 302,
          payload: { error: { message: "prompt_cache_options is unsupported" } },
        }),
      });
      try {
        const result = await runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          allowHosts: ["127.0.0.1"],
          live: true,
          allowLive: true,
        }), { fetchImpl: mock.fetchImpl });
        assert.equal(mock.requests.length, 1);
        assert.equal(mock.requests[0].redirect, "manual");
        assert.equal(result.attempts[0].errorKind, "redirect-rejected");
        assert.equal(result.retry.count, 0);
      } finally {
        /* The in-memory mock has no socket to close. */
      }
    });
    
    await test("response reads are bounded before hashing", async () => {
      const mock = await startMockProvider({
        payload: { output_text: "x".repeat(2 * 1024 * 1024 + 32) },
      });
      try {
        const result = await runProviderCacheProbe(config({
          endpoint: mock.endpoint,
          allowHosts: ["127.0.0.1"],
          live: true,
          allowLive: true,
        }), { fetchImpl: mock.fetchImpl });
        assert.equal(result.attempts[0].responseOversized, true);
        assert.equal(result.attempts[0].responseHash.length, 64);
        assert.equal(result.attempts[0].responseBody, undefined);
      } finally {
        /* The in-memory mock has no socket to close. */
      }
    });
    
    await test("request timeout aborts an attempt without retrying", async () => {
      let calls = 0;
      const result = await runProviderCacheProbe(config({
        live: true,
        allowLive: true,
        timeoutMs: 1,
      }), {
        fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
          calls += 1;
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
      }).catch((error) => {
        throw error;
      });
      assert.equal(calls, 1);
      assert.equal(result.attempts[0].errorKind, "AbortError");
      assert.equal(result.retry.count, 0);
    });
    
    if (failures.length) {
      console.error(`\n${failures.length} provider-probe test(s) failed`);
      process.exitCode = 1;
    }
  }, 60_000);
});
