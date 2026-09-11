import { describe, it } from "vitest";
/**
 * Focused RED/GREEN tests for the agent-core main integration seam.
 *
 *   TERMINA_CORE_TEST=1 node --experimental-strip-types --no-warnings scripts/agent-core-main-p0-test.mjs
 */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import type { TraceWriteFailure } from "../../../agent-core/trace.ts";

describe("Agent Core Main P0 Invariants", () => {
  it("passes P0 focused main integration tests", async () => {
    const core = await import("../../../agent-core/main.ts");
    
    const failures = [];
    function check(name: string, fn: () => void) {
      try {
        fn();
        console.log(`PASS  ${name}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${name} — ${detail}`);
        console.log(`FAIL  ${name} — ${detail}`);
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

    check("usage indicators append prefix-flip counts only with evaluations", () => {
      const base = { input: 10, cacheRead: 5, cacheWrite: 0, output: 1 };
      const plain = core.formatUsageIndicators(base, 0, 100);
      assert.doesNotMatch(plain, /flips/);
      assert.doesNotMatch(core.formatUsageIndicators(base, 0, 100, null, { evaluations: 0, prefixFlips: 0, workingSetChanges: 3 }), /flips/);
      const flipped = core.formatUsageIndicators(base, 0, 100, null, { evaluations: 14, prefixFlips: 2, workingSetChanges: 9 });
      assert.match(flipped, /flips 2\/14/);
    });
    
    check("provider-reported cost gates on finite nonnegative dollars", () => {
      assert.equal(core.providerReportedUsd({ reportedUsd: 0.0037756 }), 0.0037756);
      assert.equal(core.providerReportedUsd({ reportedUsd: 0 }), 0);
      assert.equal(core.providerReportedUsd({ reportedUsd: null }), null);
      assert.equal(core.providerReportedUsd({}), null);
      assert.equal(core.providerReportedUsd(null), null);
      assert.equal(core.providerReportedUsd({ reportedUsd: -1 }), null);
      assert.equal(core.providerReportedUsd({ reportedUsd: Number.NaN }), null);
    });

    check("trace integration keeps failed writes retryable", () => {
      assert.equal(typeof core.traceWriteDisposition, "function");
      assert.deepEqual(core.traceWriteDisposition({ ok: false, persisted: false, retryable: true } as TraceWriteFailure), {
        persisted: false,
        retry: true,
        terminal: false,
      });
    });
    
    check("main request projection keeps host context volatile", () => {
      assert.equal(typeof core.projectMainRequest, "function");
      const messages = [{ role: "user" as const, content: "inspect", sseq: 1, tokens: 1 }];
      const first = core.projectMainRequest(messages, "<working-set>one</working-set>");
      const second = core.projectMainRequest(messages, "<working-set>two</working-set>");
      assert.equal(first.persistedMessages.length, 1);
      assert.equal(first.messages.length, 2);
      assert.equal(first.messages[0].content, "inspect");
      assert.notEqual(first.overlay?.hash, second.overlay?.hash);
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
