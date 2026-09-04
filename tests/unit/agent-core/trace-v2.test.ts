import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTraceDirectory, summarizeTraces } from "./trace-report.ts";

// This fixture is the frozen v2 boundary for the trace reader/consumer.  An
// attempt is one provider call; task-settled is the logical outcome.  Keeping
// both records in the same fixture prevents retries and summary calls from
// being mistaken for additional successful tasks.

describe("Agent Core Trace V2 Invariants", () => {
  it("passes agent-core trace v2 tests", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-trace-v2-"));
    process.on("exit", () => rmSync(root, { recursive: true, force: true }));
    const traces = join(root, "term-v2.traces");
    mkdirSync(traces);
    
    const knownPrice = {
      source: "models.dev",
      retrievedAt: "2026-08-30T00:00:00.000Z",
      version: "fixture-v1",
    };
    
    function attempt({
      taskId,
      attemptId,
      role = "main",
      provider = "openai",
      protocol = "openai-responses",
      model = "model-a",
      status,
      retryIndex = 0,
      retryOfAttemptId = null,
      fallbackReason = null,
      usage,
      usd,
      price = null,
      effectiveMode,
      effectiveTtlMs,
      requestedMode = "explicit",
      requestedTtlMs = 1_800_000,
      rejection = null,
      markerCount = 1,
      markerPositions = [0],
      retryPromptIdentical = null,
      parentAttemptId = null,
      toolNames = [],
      sessionLengthBucket = null,
      missPrimary = null,
      missContributors = [],
      missGapMs = null,
      toolOutcomes = [],
      reclaimEvidence = null,
    }) {
      return {
        schemaVersion: 2,
        recordType: "attempt",
        runId: "run-v2",
        taskId,
        attemptId,
        parentAttemptId,
        role,
        provider,
        protocol,
        route: `${provider}/${protocol}`,
        model,
        taskClass: "fixture",
        sessionLengthBucket,
        requestedEffort: "medium",
        effectiveEffort: "medium",
        status,
        retryCount: retryIndex,
        retryOfAttemptId,
        fallbackReason,
        storageSeqRange: [1, 1],
        toolNames,
        ttftMs: role === "summary" ? null : 100 + retryIndex * 10,
        turnMs: 500 + retryIndex * 25,
        usage,
        cost: {
          usd,
          source: price?.source ?? null,
          version: price?.version ?? null,
          lookedUpAt: price?.retrievedAt ?? null,
          knownFields: usd === null ? [] : ["input", "output"],
        },
        cache: {
          namespace: `${provider}/${protocol}/${role}`,
          cacheKeyHash: `key-${attemptId}`,
          modelSettingsHash: `settings-${attemptId}`,
          toolsHash: `tools-${attemptId}`,
          stablePrefixHash: `stable-${attemptId}`,
          messagePrefixHash: `messages-${attemptId}`,
          workingSetHash: `working-${attemptId}`,
          workingSetChanged: false,
          requested: {
            mode: requestedMode,
            ttlMs: requestedTtlMs,
            namespace: `${provider}/${protocol}/${role}`,
            markerCount,
            markerPositions,
            rejected: Boolean(rejection),
            fallbackReason,
          },
          effective: {
            mode: effectiveMode,
            ttlMs: effectiveTtlMs,
            namespace: `${provider}/${protocol}/${role}`,
            markerCount,
            markerPositions,
            rejected: Boolean(rejection),
            fallbackReason,
          },
          retryPromptIdentical,
          codexTurnStateUsed: false,
          miss: missPrimary === null && missGapMs === null
            ? null
            : { primary: missPrimary, contributors: missContributors, gapMs: missGapMs },
        },
        revisions: { count: 0, kinds: [] },
        toolOutcomes,
        reclaimEvidence,
      };
    }
    
    const records = [
      // The first provider call fails.  Its missing cache-read/write/reasoning
      // counters must remain unknown rather than becoming zero.
      attempt({
        taskId: "task-1",
        attemptId: "attempt-1",
        status: "error",
        usage: { input: 100, cacheRead: null, cacheWrite: null, output: 12, reasoning: null },
        usd: null,
        price: null,
        effectiveMode: "none",
        effectiveTtlMs: null,
        rejection: "unsupported-field",
      }),
      // The second call is a cache-field fallback.  It belongs to the same task
      // and is a retry, not another task; its prompt bytes are unchanged.
      attempt({
        taskId: "task-1",
        attemptId: "attempt-2",
        status: "error",
        retryIndex: 1,
        retryOfAttemptId: "attempt-1",
        fallbackReason: "responses-400-stripped-cache-fields",
        usage: { input: 120, cacheRead: 0, cacheWrite: 15, output: 14, reasoning: 5 },
        usd: 0.002,
        price: knownPrice,
        effectiveMode: "none",
        effectiveTtlMs: null,
        rejection: "unsupported-field",
        markerCount: 0,
        markerPositions: [],
        retryPromptIdentical: true,
        missGapMs: 60_000,
      }),
      // The final main attempt succeeds with an effective explicit policy.
      attempt({
        taskId: "task-1",
        attemptId: "attempt-3",
        status: "ok",
        retryIndex: 2,
        retryOfAttemptId: "attempt-2",
        usage: { input: 80, cacheRead: 70, cacheWrite: 0, output: 18, reasoning: 8 },
        usd: 0.003,
        price: knownPrice,
        effectiveMode: "explicit",
        effectiveTtlMs: 1_800_000,
        markerCount: 2,
        markerPositions: [0, 5],
        retryPromptIdentical: true,
        toolNames: ["read_file", "edit"],
        sessionLengthBucket: "short",
        missPrimary: "working-set",
        missContributors: ["stable-prefix", "working-set"],
        missGapMs: 10 * 60 * 1000,
        toolOutcomes: [
          { name: "read_file", status: "ok", complete: true, bytes: 10 },
          { name: "edit", status: "truncated", complete: false, bytes: 20 },
        ],
        reclaimEvidence: {
          planned: true,
          applied: true,
          recovered: true,
          reclaimedBytes: 120,
          reclaimedTokens: 30,
          receipts: [{ kind: "prune", sourceSseq: 7, contentHash: "hash-7", recovery: "full-read" }],
        },
      }),
      // Summary is a separate role and namespace, but remains linked to the
      // logical task/final attempt for accounting.
      attempt({
        taskId: "task-1",
        attemptId: "summary-1",
        role: "summary",
        provider: "openai",
        protocol: "openai-responses",
        model: "summary-model",
        status: "ok",
        usage: { input: 40, cacheRead: null, cacheWrite: null, output: 8, reasoning: null },
        usd: null,
        price: null,
        requestedMode: "implicit",
        requestedTtlMs: null,
        effectiveMode: "implicit",
        effectiveTtlMs: null,
        markerCount: 0,
        markerPositions: [],
        parentAttemptId: "attempt-3",
      }),
      // A failed task with entirely unknown usage/cost must remain visible in
      // failure-rate metrics but must not pollute known token/cost denominators.
      attempt({
        taskId: "task-2",
        attemptId: "attempt-4",
        status: "error",
        usage: { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null },
        usd: null,
        price: null,
        requestedMode: "unknown",
        requestedTtlMs: null,
        effectiveMode: "unknown",
        effectiveTtlMs: null,
        markerCount: null,
        markerPositions: [],
        sessionLengthBucket: "long",
        missGapMs: 2 * 60 * 60 * 1000,
      }),
      {
        schemaVersion: 2,
        recordType: "task-settled",
        runId: "run-v2",
        taskId: "task-1",
        attemptCount: 4,
        finalAttemptId: "attempt-3",
        attemptIds: ["attempt-1", "attempt-2", "attempt-3", "summary-1"],
        summaryAttemptIds: ["summary-1"],
        outcome: { status: "success", correctness: "correct", criteriaHash: "criteria-task-1" },
      },
      {
        schemaVersion: 2,
        recordType: "task-settled",
        runId: "run-v2",
        taskId: "task-2",
        attemptCount: 1,
        finalAttemptId: "attempt-4",
        attemptIds: ["attempt-4"],
        summaryAttemptIds: [],
        outcome: { status: "failure", correctness: "unknown", criteriaHash: "criteria-task-2" },
      },
    ];
    
    records.forEach((record, index) => {
      writeFileSync(join(traces, `turn-${index + 1}.json`), JSON.stringify(record));
    });
    // A partial record and a valid-but-unsupported schema record are both
    // malformed input for the frozen v2 reader and must be counted separately
    // from retention omissions and writer failures.
    writeFileSync(join(traces, "turn-8.json"), "{\"schemaVersion\":2");
    writeFileSync(join(traces, "turn-9.json"), JSON.stringify({ schemaVersion: 1, recordType: "attempt", taskId: "unsupported-version" }));
    writeFileSync(join(traces, "trace-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      kind: "trace-manifest",
      retainedRecords: records.length,
      omittedRecords: 2,
      writeFailures: 1,
      malformedRecords: 2,
      partialRecords: 1,
      retentionFailures: 3,
      manifestWriteFailures: 4,
      lastTraceTurn: 7,
    }));
    
    function check(label, callback, failures) {
      try {
        callback();
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    const failures = [];
    const source = readTraceDirectory(traces);
    check("reader accepts only frozen v2 records", () => {
      assert.equal(source.matchedFiles, 9);
      assert.equal(source.records.length, records.length);
      assert.equal(source.errors.length, 2);
    }, failures);
    check("reader reports manifest accounting", () => {
      assert.deepEqual(source.diagnostics, {
        retainedRecords: records.length,
        omittedRecords: 2,
        writeFailures: 1,
        malformedRecords: 2,
        partialRecords: 1,
        retentionFailures: 3,
        manifestWriteFailures: 4,
        lastTraceTurn: 7,
        readerOmittedRecords: 0,
        manifestErrors: 0,
        schemaRecords: { current: records.length },
      });
    }, failures);
    
    const report = summarizeTraces(source.records, "trace-v2");
    check("report freezes trace schema version", () => assert.equal(report.schemaVersion, 2), failures);
    check("logical tasks are distinct from provider attempts", () => {
      assert.equal(report.tasks.total, 2);
      assert.equal(report.tasks.settled, 2);
      assert.equal(report.tasks.successful, 1);
      assert.equal(report.tasks.failed, 1);
      assert.equal(report.attempts.total, 5);
      assert.equal(report.attempts.retries, 2);
      assert.equal(report.attempts.fallbacks, 1);
      assert.equal(report.tasks.correctness.correct, 1);
      assert.equal(report.tasks.correctness.incorrect, 0);
      assert.equal(report.tasks.correctness.unknown, 1);
      assert.equal(report.tasks.unsettled, 0);
      assert.equal(report.tasks.interrupted, 0);
      assert.equal(report.tasks.cancelled, 0);
      assert.equal(report.tasks.storageError, 0);
    }, failures);
    check("retries, fallback, and summary calls stay linked", () => {
      assert.equal(report.attempts.byTask["task-1"].total, 4);
      assert.equal(report.attempts.byTask["task-1"].main, 3);
      assert.equal(report.attempts.byTask["task-1"].summary, 1);
      assert.equal(report.attempts.byTask["task-1"].retries, 2);
      assert.equal(report.attempts.byTask["task-1"].fallbacks, 1);
      assert.equal(report.attempts.byTask["task-1"].finalAttemptId, "attempt-3");
    }, failures);
    check("unknown usage fields are excluded from known denominators", () => {
      assert.deepEqual(report.usage.main.input, { total: 300, knownSamples: 3, unknownSamples: 1 });
      assert.deepEqual(report.usage.main.cacheRead, { total: 70, knownSamples: 2, unknownSamples: 2 });
      assert.deepEqual(report.usage.main.cacheWrite, { total: 15, knownSamples: 2, unknownSamples: 2 });
      assert.deepEqual(report.usage.main.output, { total: 44, knownSamples: 3, unknownSamples: 1 });
      assert.deepEqual(report.usage.main.reasoning, { total: 13, knownSamples: 2, unknownSamples: 2 });
      assert.equal(report.usage.main.completeSamples, 2);
      assert.equal(report.usage.main.partialSamples, 1);
      assert.equal(report.usage.main.unknownSamples, 1);
      assert.equal(report.usage.main.cachedInputShare, 70 / 285);
      assert.deepEqual(report.usage.cold, {
        turns: 1,
        completeSamples: 0,
        partialSamples: 1,
        unknownSamples: 0,
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalInput: 0,
        cachedInputShare: null,
      });
      assert.equal(report.usage.warm.turns, 3);
      assert.equal(report.usage.warm.cachedInputShare, 70 / 285);
      assert.deepEqual(report.cache.idleGaps, {
        transitions: 3,
        known: 3,
        unknown: 0,
        within5Minutes: 1,
        between5MinutesAnd1Hour: 1,
        over1Hour: 1,
        ttlComparison: {
          fiveMinuteEligibleTransitions: 1,
          oneHourEligibleTransitions: 2,
          oneHourOnlyTransitions: 1,
        },
      });
    }, failures);
    check("unknown cost and price provenance are explicit", () => {
      assert.deepEqual(report.cost.main, {
        totalUsd: 0.005,
        knownSamples: 2,
        unknownSamples: 2,
        byPriceSource: { "models.dev": 2 },
      });
    }, failures);
    
    check("billing uses successful settled tasks as the primary denominator", () => {
      assert.equal(report.billing.successfulSettled.taskCount, 1);
      assert.equal(report.billing.successfulSettled.attempts, 3);
      assert.equal(report.billing.successfulSettled.usage.input.total, 300);
      assert.equal(report.billing.successfulSettled.cost.totalUsd, 0.005);
      assert.equal(report.billing.failedSettled.taskCount, 1);
      assert.equal(report.billing.failedSettled.attempts, 1);
      assert.equal(report.billing.unsettled.taskCount, 0);
      assert.equal(report.billing.retries.attempts, 2);
    }, failures);
    
    check("non-success outcomes never become successful tasks", () => {
      const outcomeRecords = [];
      const outcomes = [
        ["interrupted-task", "interrupted"],
        ["cancelled-task", "cancelled"],
        ["storage-task", "storage-error"],
        ["unknown-task", "unknown"],
      ];
      for (const [taskId, status] of outcomes) {
        const attemptId = `${taskId}-attempt`;
        outcomeRecords.push(attempt({
          taskId,
          attemptId,
          status,
          usage: { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null },
          usd: null,
          price: null,
          effectiveMode: "none",
          effectiveTtlMs: null,
        }));
        outcomeRecords.push({
          schemaVersion: 2,
          recordType: "task-settled",
          runId: "run-v2",
          taskId,
          attemptCount: 1,
          finalAttemptId: attemptId,
          attemptIds: [attemptId],
          summaryAttemptIds: [],
          outcome: { status, correctness: null },
        });
      }
      outcomeRecords.push(attempt({
        taskId: "unsettled-task",
        attemptId: "unsettled-attempt",
        status: "cancelled",
        usage: { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null },
        usd: null,
        price: null,
        effectiveMode: "none",
        effectiveTtlMs: null,
      }));
      const outcomeReport = summarizeTraces(outcomeRecords, "outcomes");
      assert.equal(outcomeReport.tasks.successful, 0);
      assert.equal(outcomeReport.tasks.failed, 0);
      assert.equal(outcomeReport.tasks.interrupted, 1);
      assert.equal(outcomeReport.tasks.cancelled, 1);
      assert.equal(outcomeReport.tasks.storageError, 1);
      assert.equal(outcomeReport.tasks.unknown, 1);
      assert.equal(outcomeReport.tasks.unsettled, 1);
      assert.equal(outcomeReport.billing.successfulSettled.taskCount, 0);
      assert.equal(outcomeReport.billing.unsettled.taskCount, 1);
    }, failures);
    
    check("an explicit unknown cost is not inferred from another field", () => {
      const explicitUnknown = {
        ...records[0],
        attemptId: "explicit-unknown-cost",
        usd: 99,
        cost: { usd: null, source: null, version: null, lookedUpAt: null, knownFields: [] },
      };
      const unknownCostReport = summarizeTraces([explicitUnknown], "unknown-cost");
      assert.equal(unknownCostReport.cost.main.knownSamples, 0);
      assert.equal(unknownCostReport.attempts.byId["explicit-unknown-cost"].cost.usd, null);
    }, failures);
    check("effective cache policy and retry evidence are retained", () => {
      assert.deepEqual(report.attempts.byId["attempt-1"].cache.effective, { mode: "none", ttlMs: null });
      assert.equal(report.attempts.byId["attempt-2"].fallbackReason, "responses-400-stripped-cache-fields");
      assert.equal(report.attempts.byId["attempt-2"].cache.retryPromptIdentical, true);
      assert.deepEqual(report.attempts.byId["attempt-3"].cache.effective, { mode: "explicit", ttlMs: 1_800_000 });
      assert.deepEqual(report.attempts.byId["summary-1"].cache.effective, { mode: "implicit", ttlMs: null });
      assert.equal(report.attempts.byId["summary-1"].cache.namespace.endsWith("/summary"), true);
    }, failures);
    
    check("report exposes stable dimension groups", () => {
      assert.equal(report.groups.byRole.main.attempts, 4);
      assert.equal(report.groups.byRole.summary.attempts, 1);
      assert.equal(report.groups.byModel["model-a"].attempts, 4);
      assert.equal(report.groups.byTaskClass.fixture.attempts, 5);
      assert.equal(report.groups.byEffectivePolicy["explicit/1800000"].attempts, 1);
      assert.equal(report.groups.byRoute["openai/openai-responses"].attempts, 5);
      assert.equal(report.groups.bySessionLengthBucket.short.attempts, 1);
      assert.equal(report.groups.bySessionLengthBucket.long.attempts, 1);
      assert.equal(report.cache.byMissPrimary["working-set"].attempts, 1);
      assert.equal(report.cache.byMissContributor["stable-prefix"].attempts, 1);
    }, failures);
    
    check("tool outcomes and reclaim evidence remain bounded and measurable", () => {
      assert.equal(report.tools.outcomes.total, 2);
      assert.equal(report.tools.outcomes.byStatus.ok, 1);
      assert.equal(report.tools.outcomes.byStatus.truncated, 1);
      assert.equal(report.tools.outcomes.incomplete, 1);
      assert.equal(report.reclaim.samples, 1);
      assert.equal(report.reclaim.reclaimedBytes.total, 120);
      assert.equal(report.reclaim.reclaimedTokens.total, 30);
      assert.equal(report.reclaim.receipts, 1);
    }, failures);
    
    check("serialization is byte-stable for the same ordered fixture", () => {
      assert.equal(JSON.stringify(report), JSON.stringify(summarizeTraces(source.records, "trace-v2")));
    }, failures);
    
    check("malformed, retained, and write-failure counters stay separate", () => {
      assert.equal(report.diagnostics.retainedRecords, records.length);
      assert.equal(report.diagnostics.omittedRecords, 2);
      assert.equal(report.diagnostics.writeFailures, 1);
      assert.equal(report.diagnostics.malformedRecords, 2);
      assert.equal(report.diagnostics.partialRecords, 1);
      assert.equal(report.diagnostics.retentionFailures, 3);
      assert.equal(report.diagnostics.manifestWriteFailures, 4);
    }, failures);
    
    const invalid = join(root, "term-invalid.traces");
    mkdirSync(invalid);
    writeFileSync(join(invalid, "turn-1.json"), JSON.stringify(attempt({
      taskId: "task-invalid",
      attemptId: "duplicate",
      status: "ok",
      usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
      usd: 0,
      price: knownPrice,
      effectiveMode: "none",
      effectiveTtlMs: null,
    })));
    writeFileSync(join(invalid, "turn-2.json"), JSON.stringify(attempt({
      taskId: "task-invalid",
      attemptId: "duplicate",
      status: "ok",
      usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
      usd: 0,
      price: knownPrice,
      effectiveMode: "none",
      effectiveTtlMs: null,
    })));
    writeFileSync(join(invalid, "turn-3.json"), JSON.stringify({
      schemaVersion: 2,
      recordType: "task-settled",
      runId: "run-v2",
      taskId: "task-invalid",
      attemptCount: 1,
      finalAttemptId: "missing",
      attemptIds: ["missing", "missing"],
      summaryAttemptIds: ["missing"],
      outcome: { status: "success", correctness: "correct" },
    }));
    const missingRun = attempt({
      taskId: "task-invalid",
      attemptId: "missing-run",
      status: "ok",
      usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
      usd: 0,
      price: knownPrice,
      effectiveMode: "none",
      effectiveTtlMs: null,
    });
    delete missingRun.runId;
    writeFileSync(join(invalid, "turn-4.json"), JSON.stringify(missingRun));
    const selfLink = attempt({
      taskId: "task-invalid",
      attemptId: "self-link",
      status: "ok",
      usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
      usd: 0,
      price: knownPrice,
      effectiveMode: "none",
      effectiveTtlMs: null,
    });
    selfLink.retryOfAttemptId = "self-link";
    writeFileSync(join(invalid, "turn-5.json"), JSON.stringify(selfLink));
    writeFileSync(join(invalid, "turn-6.json"), JSON.stringify({
      schemaVersion: 2,
      recordType: "task-settled",
      runId: "run-v2",
      taskId: "task-invalid-2",
      attemptCount: 0,
      finalAttemptId: null,
      attemptIds: "not-an-array",
      summaryAttemptIds: [],
      outcome: { status: "failure", correctness: "unknown" },
    }));
    check("reader rejects duplicate and dangling v2 links", () => {
      const invalidSource = readTraceDirectory(invalid);
      assert.equal(invalidSource.records.length, 1);
      assert.equal(invalidSource.diagnostics.malformedRecords, 5);
      assert.equal(invalidSource.diagnostics.readerOmittedRecords, 0);
    }, failures);
    
    const cascade = join(root, "term-cascade.traces");
    mkdirSync(cascade);
    const brokenParent = attempt({
      taskId: "task-cascade",
      attemptId: "broken-parent",
      status: "ok",
      usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
      usd: 0,
      price: knownPrice,
      effectiveMode: "none",
      effectiveTtlMs: null,
    });
    brokenParent.parentAttemptId = "missing-parent";
    writeFileSync(join(cascade, "turn-1.json"), JSON.stringify(brokenParent));
    writeFileSync(join(cascade, "turn-2.json"), JSON.stringify({
      schemaVersion: 2,
      recordType: "task-settled",
      runId: "run-v2",
      taskId: "task-cascade",
      attemptCount: 1,
      finalAttemptId: "broken-parent",
      attemptIds: ["broken-parent"],
      summaryAttemptIds: [],
      outcome: { status: "failure", correctness: "unknown" },
    }));
    check("reader cascades invalid links through dependent settlements", () => {
      const cascadeSource = readTraceDirectory(cascade);
      assert.equal(cascadeSource.records.length, 0);
      assert.equal(cascadeSource.diagnostics.malformedRecords, 2);
    }, failures);
    
    const badManifest = join(root, "term-bad-manifest.traces");
    mkdirSync(badManifest);
    writeFileSync(join(badManifest, "turn-1.json"), JSON.stringify(records[0]));
    writeFileSync(join(badManifest, "trace-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      kind: "trace-manifest",
      retainedRecords: 1.5,
      omittedRecords: -1,
      writeFailures: 0,
    }));
    check("manifest counts require nonnegative integers", () => {
      const badSource = readTraceDirectory(badManifest);
      assert.equal(badSource.diagnostics.retainedRecords, 1);
      assert.equal(badSource.diagnostics.omittedRecords, null);
      assert.equal(badSource.diagnostics.writeFailures, 0);
      assert.equal(badSource.diagnostics.manifestErrors, 2);
    }, failures);
    
    check("summarizer rejects schemaless records", () => {
      assert.throws(
        () => summarizeTraces([...source.records, { role: "main", status: "ok", usage: null, model: "unsupported" }], "strict"),
        /current schema/,
      );
    }, failures);
    
    const invalidShape = join(root, "term-invalid-shape.traces");
    mkdirSync(invalidShape);
    writeFileSync(join(invalidShape, "turn-1.json"), "{}");
    writeFileSync(join(invalidShape, "turn-0.json"), "{}");
    writeFileSync(join(invalidShape, "turn-9007199254740992.json"), "{}");
    writeFileSync(join(invalidShape, "turn-2.json"), JSON.stringify({ role: "main", status: "ok", model: "unsupported", usage: null }));
    check("reader rejects arbitrary schemaless objects", () => {
      const invalidSource = readTraceDirectory(invalidShape);
      assert.equal(invalidSource.records.length, 0);
      assert.equal(invalidSource.matchedFiles, 2);
      assert.equal(invalidSource.diagnostics.malformedRecords, 2);
      assert.equal(invalidSource.diagnostics.partialRecords, 0);
    }, failures);
    
    check("dimension keys use byte-stable ordering for Unicode labels", () => {
      const unicodeRecords = [
        { ...records[0], taskId: "task-z", attemptId: "attempt-z", taskClass: "z", model: "z" },
        { ...records[1], taskId: "task-é", attemptId: "attempt-é", taskClass: "é", model: "é" },
      ];
      const unicodeReport = summarizeTraces(unicodeRecords, "unicode");
      assert.deepEqual(Object.keys(unicodeReport.groups.byTaskClass), ["z", "é"]);
      assert.equal(JSON.stringify(unicodeReport), JSON.stringify(summarizeTraces(unicodeRecords, "unicode")));
    }, failures);
    
    if (failures.length > 0) {
      console.error(`agent-core trace v2 RED (${failures.length} expected contract failures)`);
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    } else {
      console.log("agent-core trace v2 tests passed");
    }
  }, 60_000);
});
