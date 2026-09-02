import { describe, it, expect } from "vitest";
/**
 * Focused RED/GREEN tests for the agent-core main integration seam.
 *
 *   TERMINA_CORE_TEST=1 node --experimental-strip-types --no-warnings scripts/agent-core-main-p0-test.mjs
 */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";

describe("Agent Core Main P0 Invariants", () => {
  it("passes P0 focused main integration tests", async () => {
    const core = await import("../../../agent-core/main.ts");
    
    const failures = [];
    function check(name, fn) {
      try {
        fn();
        console.log(`PASS  ${name}`);
      } catch (error) {
        failures.push(`${name} — ${String(error?.message ?? error)}`);
        console.log(`FAIL  ${name} — ${String(error?.message ?? error)}`);
      }
    }
    
    check("main exposes nullable provider usage normalization", () => {
      assert.equal(typeof core.normalizeProviderUsage, "function");
      assert.deepEqual(core.normalizeProviderUsage({ input_tokens: 10, output_tokens: 4 }), {
        input: 10,
        cacheRead: null,
        cacheWrite: null,
        output: 4,
        reasoning: null,
      });
    });
    
    check("missing provider usage does not become a zero-token record", () => {
      assert.equal(core.normalizeProviderUsage(undefined), null);
      assert.deepEqual(core.normalizeProviderUsage({}), {
        input: null,
        cacheRead: null,
        cacheWrite: null,
        output: null,
        reasoning: null,
      });
    });
    
    check("usage indicators do not display unknown counters as zero", () => {
      const text = core.formatUsageIndicators(
        { input: 10, cacheRead: null, cacheWrite: null, output: null },
        0,
        100,
      );
      assert.match(text, /tokens \? in\/\? out/);
      assert.match(text, /cache --/);
    });
    
    check("trace integration keeps failed writes retryable", () => {
      assert.equal(typeof core.traceWriteDisposition, "function");
      assert.deepEqual(core.traceWriteDisposition({ ok: false, persisted: false, retryable: true }), {
        persisted: false,
        retry: true,
        terminal: false,
      });
    });
    
    check("main request projection keeps host context volatile", () => {
      assert.equal(typeof core.projectMainRequest, "function");
      const messages = [{ role: "user", content: "inspect", sseq: 1, tokens: 1 }];
      const first = core.projectMainRequest(messages, "<working-set>one</working-set>");
      const second = core.projectMainRequest(messages, "<working-set>two</working-set>");
      assert.equal(first.persistedMessages.length, 1);
      assert.equal(first.messages.length, 2);
      assert.equal(first.messages[0].content, "inspect");
      assert.notEqual(first.overlay.hash, second.overlay.hash);
      assert.equal(JSON.stringify(messages).includes("working-set"), false);
    });
    
    if (failures.length > 0) {
      console.error(`\n${failures.length} focused main integration test(s) failed`);
      process.exitCode = 1;
    } else {
      console.log("\nall focused main integration tests passed");
    }
  }, 60_000);
});
