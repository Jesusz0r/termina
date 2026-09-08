import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASELINE_OPTIONS, readBaseline } from "../../../scripts/trace-baseline.ts";

function attempt(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    recordType: "attempt",
    runId: "run-1",
    taskId: "task-1",
    attemptId: id,
    parentAttemptId: null,
    retryOfAttemptId: null,
    role: "main",
    provider: "anthropic",
    protocol: "messages",
    route: "direct",
    model: "claude-test",
    taskClass: "code",
    requestedEffort: null,
    effectiveEffort: null,
    status: "ok",
    retryCount: null,
    fallbackReason: null,
    storageSeqRange: null,
    toolNames: ["read_file"],
    startedAtMs: null,
    endedAtMs: null,
    ttftMs: null,
    turnMs: null,
    usage: { input: 1000, cacheRead: 800, cacheWrite: 100, output: 200, reasoning: null },
    cost: { usd: 0.01 },
    cache: {
      requested: { mode: "default" },
      effective: { mode: "default" },
      missAttribution: { primary: null },
    },
    toolOutcomes: [],
    reclaimEvidence: null,
    revisions: { count: null, kinds: [] },
    wasteTokens: null,
    wasteCause: null,
    providerError: null,
    ...overrides,
  };
}

describe("trace-baseline consumer", () => {
  it("reports one task with three attempts and keeps unknown values out of denominators", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baseline-"));
    writeFileSync(join(dir, "turn-0.json"), JSON.stringify(attempt("a-1")));
    writeFileSync(
      join(dir, "turn-1.json"),
      JSON.stringify(attempt("a-2", { retryOfAttemptId: "a-1", usage: { input: 1200, cacheRead: 0, cacheWrite: null, output: 50, reasoning: null } })),
    );
    writeFileSync(
      join(dir, "turn-2.json"),
      JSON.stringify(
        attempt("a-3", {
          retryOfAttemptId: "a-2",
          cache: { requested: { mode: "hour" }, effective: { mode: "default" }, missAttribution: { primary: "working-set" } },
        }),
      ),
    );
    writeFileSync(
      join(dir, "turn-3.json"),
      JSON.stringify({
        schemaVersion: 2,
        recordType: "task-settled",
        runId: "run-1",
        taskId: "task-1",
        taskClass: "code",
        attemptCount: 3,
        finalAttemptId: "a-3",
        attemptIds: ["a-1", "a-2", "a-3"],
        summaryAttemptIds: [],
        outcome: { status: "success", correctness: null, criteriaHash: null },
      }),
    );
    writeFileSync(join(dir, "turn-4.json"), "{not json");
    writeFileSync(join(dir, "turn-5.json"), JSON.stringify({ recordType: "attempt", broken: true }));
    writeFileSync(
      join(dir, "trace-manifest.json"),
      JSON.stringify({ kind: "trace-manifest", retainedRecords: 4, omittedRecords: 2, writeFailures: 1, malformedRecords: 0, partialRecords: 0 }),
    );

    const first = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    // §2 validation: one logical task, three attempts, settled outcome.
    assert.equal(first.tasks.count, 1);
    assert.equal(first.tasks.settled, 1);
    assert.equal(first.tasks.open, 0);
    assert.equal(first.records.attempts, 3);
    assert.equal(first.records.settlements, 1);
    assert.deepEqual(first.tasks.byOutcome, { success: 1 });
    // Correctness stays unknown: no evaluator supplied it.
    assert.deepEqual(first.tasks.byCorrectness, { unknown: 1 });
    assert.equal(first.attempts.retries, 2);
    // Usage: known sums only; nulls counted, never coerced.
    assert.equal(first.usage.input.sum, 3200);
    assert.equal(first.usage.reasoning.unknown, 3);
    assert.equal(first.usage.cacheWrite.unknown, 1);
    // Cache: two hits, one explicit zero; the zero carries no cause.
    assert.equal(first.cache.hits, 2);
    assert.equal(first.cache.explicitZeroRead, 1);
    assert.deepEqual(first.cache.byMissCause, { "working-set": 1 });
    assert.equal(first.cache.requestedVsEffectiveMismatch, 1);
    // Cost: one unknown (missing usd on attempts 2-3... attempt() default has usd;
    // override only usage, so all three known).
    assert.equal(first.cost.knownCount, 3);
    // Integrity: malformed + partial counted outside denominators.
    assert.equal(first.integrity.malformedFiles, 1);
    assert.equal(first.integrity.partialRecords, 1);
    assert.equal(first.integrity.writerOmittedRecords, 2);
    assert.equal(first.integrity.writerWriteFailures, 1);

    // §2 validation: byte-identical rerun on the immutable fixture.
    const second = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });
});
