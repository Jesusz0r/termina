import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";

import {
  analyzeCacheExperiment,
  breakEvenFromRateSnapshot,
  compareTtlBuckets,
  run,
} from "./cache-experiment.ts";

describe("Agent Core Cache Experiment Invariants", () => {
  it("passes cache experiment tests", async () => {
    const rates = [
      {
        source: "fixture-rates",
        version: "2026-08-30-v1",
        retrievedAt: "2026-08-30T00:00:00.000Z",
        provider: "openai",
        protocol: "openai-responses",
        model: "gpt-5.6-sol",
        inputPerToken: 0.00001,
        outputPerToken: 0.00002,
        cacheReadPerToken: 0.000001,
        cacheWritePerToken: 0.000012,
        storagePerTokenHour: 0,
      },
    ];
    
    const attempt = ({
      runId,
      taskId,
      attemptId,
      variant,
      corpusId = "corpus-1",
      role = "main",
      provider = "openai",
      protocol = "openai-responses",
      route = "https://api.openai.com/v1/responses",
      model = "gpt-5.6-sol",
      atMs,
      usage,
      cost = undefined,
      effectiveMode = "explicit",
      effectiveTtlMs = 300_000,
      retentionKnown = true,
      markerPositions = [0],
      retryCount = 0,
      fallbackReason = null,
    }) => ({
      schemaVersion: 2,
      recordType: "attempt",
      runId,
      taskId,
      attemptId,
      role,
      provider,
      protocol,
      route,
      model,
      taskClass: "tool-heavy",
      corpusId,
      variant,
      status: "ok",
      retryCount,
      fallbackReason,
      atMs,
      startedAt: typeof atMs === "number"
        ? new Date(Date.parse("2026-08-30T00:00:00.000Z") + atMs).toISOString()
        : undefined,
      ttftMs: role === "summary" ? null : 100,
      turnMs: role === "summary" ? 150 : 500,
      usage,
      cost,
      cache: {
        effective: {
          mode: effectiveMode,
          ttlMs: effectiveTtlMs,
          markerCount: markerPositions.length,
          markerPositions,
          retentionKnown,
        },
        requested: { mode: effectiveMode, ttlMs: effectiveTtlMs },
        markerPositions,
      },
    });
    
    const records = [
      attempt({
        runId: "run-baseline",
        taskId: "task-1",
        attemptId: "baseline-1",
        variant: "baseline",
        atMs: 0,
        usage: { input: 100, cacheRead: 0, cacheWrite: 100, output: 10, reasoning: 0 },
      }),
      attempt({
        runId: "run-baseline",
        taskId: "task-1",
        attemptId: "baseline-2",
        variant: "baseline",
        atMs: 240_000,
        usage: { input: 20, cacheRead: 80, cacheWrite: 0, output: 10, reasoning: 0 },
        markerPositions: [0, 5],
      }),
      attempt({
        runId: "run-baseline",
        taskId: "task-1",
        attemptId: "baseline-summary",
        variant: "baseline",
        role: "summary",
        atMs: 241_000,
        usage: { input: 50, cacheRead: null, cacheWrite: null, output: 5, reasoning: null },
        effectiveMode: "none",
        effectiveTtlMs: null,
        retentionKnown: null,
        markerPositions: [],
      }),
      {
        schemaVersion: 2,
        recordType: "task-settled",
        runId: "run-baseline",
        taskId: "task-1",
        attemptIds: ["baseline-1", "baseline-2", "baseline-summary"],
        summaryAttemptIds: ["baseline-summary"],
        finalAttemptId: "baseline-2",
        outcome: { status: "success", correctness: "correct" },
      },
      attempt({
        runId: "run-candidate",
        taskId: "task-1",
        attemptId: "candidate-1",
        variant: "candidate",
        atMs: 0,
        usage: { input: 100, cacheRead: 0, cacheWrite: 100, output: 10, reasoning: 0 },
      }),
      attempt({
        runId: "run-candidate",
        taskId: "task-1",
        attemptId: "candidate-2",
        variant: "candidate",
        atMs: 360_000,
        usage: { input: 10, cacheRead: 90, cacheWrite: 0, output: 10, reasoning: 0 },
        markerPositions: [0, 5, 9],
      }),
      {
        schemaVersion: 2,
        recordType: "task-settled",
        runId: "run-candidate",
        taskId: "task-1",
        attemptIds: ["candidate-1", "candidate-2"],
        summaryAttemptIds: [],
        finalAttemptId: "candidate-2",
        outcome: { status: "success", correctness: "correct" },
      },
      attempt({
        runId: "run-candidate",
        taskId: "task-failed",
        attemptId: "candidate-failed",
        variant: "candidate",
        atMs: 0,
        usage: { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null },
        effectiveMode: "unknown",
        effectiveTtlMs: null,
        retentionKnown: null,
        markerPositions: [],
      }),
      {
        schemaVersion: 2,
        recordType: "task-settled",
        runId: "run-candidate",
        taskId: "task-failed",
        attemptIds: ["candidate-failed"],
        summaryAttemptIds: [],
        finalAttemptId: "candidate-failed",
        outcome: { status: "failure", correctness: "unknown" },
      },
      attempt({
        runId: "run-xai",
        taskId: "task-xai",
        attemptId: "xai-1",
        variant: "probe",
        provider: "xai",
        protocol: "openai-responses",
        route: "xai-responses",
        model: "grok-4.6",
        atMs: 0,
        usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 1 },
        effectiveMode: "implicit",
        effectiveTtlMs: null,
        retentionKnown: null,
        markerPositions: [],
      }),
      attempt({
        runId: "run-xai",
        taskId: "task-xai",
        attemptId: "xai-2",
        variant: "probe",
        provider: "xai",
        protocol: "openai-responses",
        route: "xai-responses",
        model: "grok-4.6",
        atMs: 360_000,
        usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 1 },
        effectiveMode: "implicit",
        effectiveTtlMs: null,
        retentionKnown: null,
        markerPositions: [],
      }),
    ];
    
    records.push({
      schemaVersion: 2,
      recordType: "task-settled",
      runId: "run-xai",
      taskId: "task-xai",
      attemptIds: ["xai-1", "xai-2"],
      summaryAttemptIds: [],
      finalAttemptId: "xai-2",
      outcome: { status: "success", correctness: "unknown" },
    });
    
    const report = analyzeCacheExperiment(records, { rateSnapshots: rates });
    
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.attempts.total, 8);
    assert.equal(report.tasks.total, 4);
    assert.equal(report.tasks.successful, 3);
    assert.equal(report.tasks.failed, 1);
    
    assert.equal(report.usage.completeKnown.samples, 6);
    assert.equal(report.usage.completeKnown.unknownSamples, 2);
    assert.equal(report.usage.completeKnown.cacheReadShare, 170 / 800);
    assert.equal(report.usage.completeKnown.denominator, "complete-cache-input-samples");
    
    assert.equal(report.groups.byProvider.openai.attempts, 6);
    assert.equal(report.groups.byProvider.xai.attempts, 2);
    assert.equal(report.groups.byRoute["https://api.openai.com/v1/responses"].attempts, 6);
    assert.equal(report.groups.byModel["gpt-5.6-sol"].attempts, 6);
    assert.equal(report.groups.byEffectivePolicy["explicit/300000"].attempts, 4);
    assert.equal(report.groups.byEffectivePolicy["unknown/unknown"].attempts, 1);
    
    assert.equal(report.roles.main.attempts, 7);
    assert.equal(report.roles.summary.attempts, 1);
    assert.equal(report.roles.summary.latency.ttftMs.knownSamples, 0);
    assert.equal(report.roles.summary.cost.knownSamples, 0);
    assert.equal(report.quality.successfulTasks.knownCostTasks, 1);
    assert.equal(report.quality.successfulTasks.unknownCostTasks, 2);
    assert.equal(report.quality.successfulTasks.knownInputTasks, 2);
    assert.equal(report.quality.gates.status, "pass");
    assert.equal(report.quality.gates.correctness.status, "pass");
    assert.equal(report.quality.paired.taskPairs, 1);
    assert.equal(report.quality.paired.outcomePairs, 1);
    assert.equal(report.quality.paired.successfulPairs, 1);
    assert.equal(report.quality.pairedSuccessfulTasks.count, 1);
    
    assert.equal(report.ttl.retentionClaims, 0);
    assert.equal(report.ttl.unknownRetentionSamples, 2);
    assert.equal(report.ttl.availability.status, "partial");
    assert.equal(report.ttl.availability.timestampAvailable, true);
    assert.equal(report.ttl.availability.retentionEvidenceAvailable, true);
    assert.equal(report.ttl.buckets["0-300000"].samples, 1);
    assert.equal(report.ttl.buckets["300000-600000"].samples, 1);
    assert.equal(report.ttl.buckets["unknown-retention"].samples, 1);
    assert.equal(report.ttl.buckets["unknown-retention"].observedMisses, 1);
    
    assert.equal(report.breakpoints.comparisons, 3);
    assert.equal(report.breakpoints.markerCountDelta.knownSamples, 3);
    assert.equal(report.breakpoints.markerCountDelta.added, 3);
    assert.equal(report.breakpoints.markerCountDelta.removed, 0);
    assert.equal(report.breakpoints.openAiLookbackLimit, null);
    
    assert.equal(report.cost.knownRateSamples, 4);
    assert.equal(report.cost.unknownRateSamples, 4);
    assert.equal(report.breakEven[0].rateSnapshot.source, "fixture-rates");
    assert.equal(report.breakEven[0].readsToStrictSavings, 1);
    assert.equal(report.breakEven[0].readsToRecoverWrite, 2);
    assert.equal(report.breakEven[0].unknowns.length, 0);
    
    const directBreakEven = breakEvenFromRateSnapshot(rates[0], 100);
    assert.equal(directBreakEven.readsToStrictSavings, 1);
    assert.equal(directBreakEven.readsToRecoverWrite, 2);
    assert.equal(directBreakEven.prefixTokens, 100);
    assert.equal(directBreakEven.storage.included, false);
    const directTtl = compareTtlBuckets(
      [{ atMs: 0, cacheRead: 0, effectiveTtlMs: 300_000, retentionKnown: true }, { atMs: 301_000, cacheRead: 0, effectiveTtlMs: 300_000, retentionKnown: true }],
    );
    assert.equal(directTtl.retentionClaims, 0);
    assert.equal(directTtl.unknownRetentionSamples, 0);
    assert.equal(directTtl.buckets["300000-600000"].samples, 1);
    assert.equal(directTtl.buckets["300000-600000"].observedMisses, 1);
    assert.equal(compareTtlBuckets([
      { atMs: 0, cacheRead: 0, effectiveTtlMs: 300_000 },
      { atMs: 301_000, cacheRead: 0, effectiveTtlMs: 300_000 },
    ]).unknownRetentionSamples, 1);
    
    const withoutTimestamps = analyzeCacheExperiment([
      attempt({ runId: "run-no-time", taskId: "task-no-time", attemptId: "no-time-1", variant: "probe", atMs: undefined, startedAt: undefined }),
      attempt({ runId: "run-no-time", taskId: "task-no-time", attemptId: "no-time-2", variant: "probe", atMs: undefined, startedAt: undefined }),
    ]);
    assert.equal(withoutTimestamps.ttl.availability.status, "unavailable");
    assert.equal(withoutTimestamps.ttl.availability.reason, "attempt-timestamps-required");
    
    const invalidInput = analyzeCacheExperiment([
      records[0],
      { role: "main", status: "ok" },
      { schemaVersion: 2, recordType: "not-a-trace-record", runId: "run-invalid", taskId: "task-invalid" },
      "not-an-object",
    ]);
    assert.equal(invalidInput.diagnostics.inputRecords, 4);
    assert.equal(invalidInput.diagnostics.acceptedAttempts, 1);
    assert.equal(invalidInput.diagnostics.invalidRecords.length, 3);
    assert.equal(invalidInput.diagnostics.invalidRecords[0].reason, "record-is-not-an-object");
    assert.equal(invalidInput.diagnostics.invalidRecords[1].reason, "unsupported-record-type");
    assert.equal(invalidInput.diagnostics.invalidRecords[2].reason, "unsupported-trace-schema");
    const withReaderDiagnostics = analyzeCacheExperiment([records[0]], {
      readerDiagnostics: [{ source: "term.traces", malformedRecords: 2, omittedRecords: 3 }],
    });
    assert.deepEqual(withReaderDiagnostics.diagnostics.reader, [{ source: "term.traces", malformedRecords: 2, omittedRecords: 3 }]);
    const invalidLinks = analyzeCacheExperiment([
      records[0],
      {
        schemaVersion: 2,
        recordType: "task-settled",
        runId: "run-invalid-links",
        taskId: "task-invalid-links",
        attemptIds: ["missing"],
        summaryAttemptIds: [],
        finalAttemptId: "missing",
        outcome: { status: "success", correctness: "correct" },
      },
    ]);
    assert.equal(invalidLinks.diagnostics.acceptedSettlements, 0);
    assert.equal(invalidLinks.diagnostics.invalidRecords[0].reason, "settlement-attempt-reference-invalid");
    
    const noTimestampCost = analyzeCacheExperiment([
      attempt({ runId: "run-no-time-cost", taskId: "task-no-time-cost", attemptId: "no-time-cost", variant: "probe", atMs: undefined, startedAt: undefined }),
    ], { rateSnapshots: rates });
    assert.equal(noTimestampCost.cost.knownRateSamples, 0);
    assert.equal(noTimestampCost.cost.unknownRateSamples, 1);
    
    const futureRate = { ...rates[0], retrievedAt: "2026-08-31T00:00:00.000Z" };
    const futureRateReport = analyzeCacheExperiment([records[0]], { rateSnapshots: [futureRate] });
    assert.equal(futureRateReport.cost.knownRateSamples, 0);
    assert.equal(futureRateReport.cost.unknownRateSamples, 1);
    
    const unknownSourceBreakEven = breakEvenFromRateSnapshot({ ...rates[0], source: undefined }, 100);
    assert.ok(unknownSourceBreakEven.unknowns.includes("source"));
    const storageBreakEven = breakEvenFromRateSnapshot({ ...rates[0], storagePerTokenHour: 0.000001 }, { prefixTokens: 100, storageTtlMs: 3_600_000 });
    assert.equal(storageBreakEven.storage.included, true);
    assert.equal(storageBreakEven.unknowns.length, 0);
    assert.ok(Math.abs(storageBreakEven.costAtReads[0].cachedUsd - 0.0013) < 1e-12);
    
    const first = JSON.stringify(report);
    assert.equal(first, JSON.stringify(analyzeCacheExperiment(records.slice().reverse(), { rateSnapshots: rates })));
    
    console.log("agent-core cache experiment tests passed");
    
    void run;
  }, 60_000);
});
