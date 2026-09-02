import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRACE_SCHEMA_VERSION,
  createAttemptRecord,
  createTaskSettledRecord,
  createTraceRuntime,
} from "../../../agent-core/trace.ts";
import { readTraceDirectory, summarizeTraces } from "./trace-report.ts";

describe("Agent Core Trace Runtime Invariants", () => {
  it("passes agent-core trace runtime tests", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-trace-runtime-"));
    process.on("exit", () => rmSync(root, { recursive: true, force: true }));
    
    const asyncContractRuntime = createTraceRuntime({
      directory: join(root, "async-contract.traces"),
      namespace: "namespace-async-contract",
    });
    assert.equal(typeof asyncContractRuntime.ready?.then, "function");
    await asyncContractRuntime.ready;
    const asyncContractWrite = asyncContractRuntime.writeAttempt(makeAttempt(1));
    assert.equal(typeof asyncContractWrite?.then, "function");
    assert.equal((await asyncContractWrite).ok, true);
    await asyncContractRuntime.close();
    
    function makeAttempt(index, overrides = {}) {
      return createAttemptRecord({
        runId: "run-runtime",
        taskId: "task-runtime",
        attemptId: `attempt-${index}`,
        role: "main",
        provider: "openai",
        protocol: "openai-responses",
        route: "openai/openai-responses",
        model: "gpt-5.6",
        taskClass: "fixture",
        requestedEffort: "medium",
        effectiveEffort: "medium",
        status: "ok",
        retryCount: index - 1,
        retryOfAttemptId: index > 1 ? `attempt-${index - 1}` : null,
        fallbackReason: null,
        storageSeqRange: [index, index],
        toolNames: index === 1 ? ["read_file"] : [],
        startedAtMs: 1_000 + index,
        endedAtMs: 1_500 + index,
        ttftMs: 100,
        turnMs: 500,
        usage: {
          input: index === 2 ? null : 100,
          cacheRead: index === 1 ? null : 20,
          cacheWrite: 0,
          output: 10,
          reasoning: index === 1 ? null : 3,
        },
        cost: {
          usd: index === 1 ? null : 0.001,
          source: index === 1 ? null : "fixture",
          version: index === 1 ? null : "v1",
          lookedUpAt: index === 1 ? null : "2026-08-30T00:00:00.000Z",
          knownFields: index === 1 ? [] : ["input", "output"],
          scope: {
            provider: "openai",
            protocol: "openai-responses",
            model: "gpt-5.6",
            route: "openai/openai-responses",
            role: "main",
          },
          units: {
            input: "usd_per_million_tokens",
            cacheRead: "usd_per_million_tokens",
            cacheWrite: "usd_per_million_tokens",
            output: "usd_per_million_tokens",
            reasoning: "usd_per_million_tokens",
            storage: "usd_per_gib_second",
          },
          components: {
            input: 0.0001,
            cacheRead: null,
            cacheWrite: 0,
            output: 0.0002,
            reasoning: index === 1 ? null : 0.00001,
            storage: null,
          },
          rates: {
            input: 0.000001,
            cacheRead: null,
            cacheWrite: 0,
            output: 0.000002,
            reasoning: index === 1 ? null : 0.0000001,
            storage: null,
          },
          unknownFields: index === 1 ? ["cacheRead"] : [],
          unknownReasons: index === 1 ? ["provider-omitted-cache-read"] : [],
          cacheWriteTtlClass: "30m",
          reasoningBilling: "separate",
        },
        cache: {
          namespace: "openai/openai-responses/main",
          cacheKeyHash: "key-hash",
          modelSettingsHash: "settings-hash",
          toolsHash: "tools-hash",
          serializedToolsHash: "serialized-tools-hash",
          serializedToolsBytes: 321,
          stablePrefixHash: "stable-hash",
          reusablePrefixHash: "reusable-hash",
          messagePrefixHash: "message-hash",
          workingSetHash: null,
          workingSetChanged: false,
          markerCount: 1,
          markerPositions: [0],
          rejected: false,
          retryPromptIdentical: index > 1,
          codexTurnStateUsed: false,
          requested: { mode: "explicit", ttlMs: 1_800_000 },
          effective: { mode: "explicit", ttlMs: 1_800_000, markerCount: 1, markerPositions: [0] },
          missAttribution: {
            attributed: index > 1,
            primary: index > 1 ? "cache-key-changed" : null,
            contributing: index > 1 ? ["working-set-changed"] : [],
            missedTokens: index > 1 ? 20 : null,
            gapMs: index > 1 ? 100 : null,
            missingFields: index === 1 ? ["cacheReadTokens"] : [],
            noiseFloorTokens: 32,
          },
        },
        toolOutcomes: index === 1 ? [{
          toolName: "read_file",
          toolCallId: "call-1",
          isError: false,
          bounded: {
            state: "complete",
            direction: "head",
            limitBytes: 1_000,
            inputBytes: 200,
            retainedBytes: 200,
            omittedBytes: 0,
            outputBytes: 200,
            truncated: false,
          },
          cancellationScope: "none",
          continuation: null,
          repro: "read_file(\"README.md\")",
          stdout: null,
          stderr: null,
          exitCode: null,
          signal: null,
        }] : [],
        reclaimEvidence: index === 1 ? {
          attempted: true,
          revisionId: "revision-1",
          targetCount: 1,
          reclaimedTokens: 20,
          source: "session-record",
          recovery: "full-read",
          error: null,
          targets: [{
            sseq: 4,
            sourceSseq: null,
            blockIndex: 0,
            action: "stub",
            originalType: "tool_result",
            originalChars: 2_000,
            originalBytes: 2_100,
            originalSha256: "a".repeat(64),
            reclaimedTokens: 20,
            tool: "read_file",
            repro: "read_file(\"README.md\")",
            recovery: "full-read",
            result: "applied",
          }],
        } : null,
        revisions: { count: 0, kinds: [] },
        wasteTokens: null,
        wasteCause: null,
        ...overrides,
      });
    }
    
    function traceIndexAttempt(runId, taskId, attemptId, retained = false, traceTurn = null) {
      return { runId, taskId, attemptId, role: "main", retained, traceTurn, unknown: false };
    }
    
    function traceIndexSettlement(runId, taskId, attemptId, retained = false, traceTurn = null) {
      return {
        runId,
        taskId,
        attemptIds: [attemptId],
        summaryAttemptIds: [],
        finalAttemptId: attemptId,
        retained,
        traceTurn,
        unknown: false,
      };
    }
    
    function writeTraceIndex(directory, attempts, settlements, complete = true, updatedAt = "2026-08-30T00:00:00.000Z") {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "trace-index.json"), JSON.stringify({
        schemaVersion: TRACE_SCHEMA_VERSION,
        kind: "trace-link-index",
        complete,
        updatedAt,
        attempts,
        settlements,
      }));
    }
    
    function longTraceId(prefix, index) {
      return `${prefix}-${index}-${"x".repeat(480)}`;
    }
    
    const settled = createTaskSettledRecord({
      runId: "run-runtime",
      taskId: "task-runtime",
      taskClass: "fixture",
      attemptCount: 1,
      finalAttemptId: "attempt-2",
      attemptIds: ["attempt-2"],
      summaryAttemptIds: [],
      outcome: {
        status: "success",
        correctness: "correct",
        criteriaHash: "criteria-hash",
      },
    });
    
    assert.equal(TRACE_SCHEMA_VERSION, 2);
    assert.equal(Object.isFrozen(settled), true);
    assert.equal(Object.isFrozen(settled.attemptIds), true);
    assert.equal(Object.isFrozen(settled.outcome), true);
    assert.equal(settled.taskClass, "fixture");
    
    const unknown = makeAttempt(1);
    assert.equal(Object.isFrozen(unknown), true);
    assert.equal(Object.isFrozen(unknown.usage), true);
    assert.equal(Object.isFrozen(unknown.cache.effective), true);
    assert.equal(unknown.usage.cacheRead, null);
    assert.equal(unknown.usage.reasoning, null);
    assert.equal(unknown.cost.usd, null);
    assert.equal(unknown.cache.effective.ttlMs, 1_800_000);
    assert.deepEqual(unknown.cache.effective.markerPositions, [0]);
    assert.equal(unknown.cache.missAttribution.primary, null);
    assert.deepEqual(unknown.cache.missAttribution.missingFields, ["cacheReadTokens"]);
    assert.equal(unknown.cost.components.cacheRead, null);
    assert.equal(unknown.cost.units.input, "usd_per_million_tokens");
    assert.deepEqual(unknown.cost.unknownReasons, ["provider-omitted-cache-read"]);
    assert.equal(unknown.cache.serializedToolsHash, "serialized-tools-hash");
    assert.equal(unknown.cache.serializedToolsBytes, 321);
    assert.equal(unknown.toolOutcomes[0].bounded.inputBytes, 200);
    assert.equal(unknown.reclaimEvidence.targets[0].originalSha256.length, 64);
    assert.equal(unknown.startedAtMs, 1_001);
    assert.equal(unknown.endedAtMs, 1_501);
    assert.equal(unknown.turnMs, 500);
    assert.equal(unknown.wasteTokens, null);
    const unknownProviderFields = createAttemptRecord({
      ...unknown,
      cache: {
        ...unknown.cache,
        markerPositions: undefined,
        serializedToolsHash: "bad\u0000hash",
        serializedToolsBytes: "not-reported",
        codexTurnStateUsed: "not-reported",
        requested: { ...unknown.cache.requested, markerPositions: undefined },
        effective: { ...unknown.cache.effective, markerPositions: undefined },
      },
    });
    assert.equal(unknownProviderFields.cache.markerPositions, null);
    assert.equal(unknownProviderFields.cache.serializedToolsHash, null);
    assert.equal(unknownProviderFields.cache.serializedToolsBytes, null);
    assert.equal(unknownProviderFields.cache.codexTurnStateUsed, null);
    assert.equal(unknownProviderFields.cache.effective.markerPositions, null);
    assert.throws(() => createAttemptRecord({ ...makeAttempt(1), attemptId: "bad\u0000id" }), /control character/);
    
    const linksRuntime = createTraceRuntime({
      directory: join(root, "links.traces"),
      namespace: "namespace-links",
      retentionCap: 10,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.equal((await linksRuntime.ready).ok, true);
    const linkBase = { runId: "run-links", taskId: "task-links" };
    const linkFirst = await linksRuntime.writeAttempt(makeAttempt(1, {
      ...linkBase,
      attemptId: "first",
      retryOfAttemptId: null,
    }));
    assert.equal(linkFirst.ok, true);
    const duplicateAttempt = await linksRuntime.writeAttempt(makeAttempt(1, {
      ...linkBase,
      attemptId: "first",
      retryOfAttemptId: null,
    }));
    assert.equal(duplicateAttempt.kind, "duplicate-attempt");
    const danglingAttempt = await linksRuntime.writeAttempt(makeAttempt(2, {
      ...linkBase,
      attemptId: "dangling",
      retryOfAttemptId: "missing",
    }));
    assert.equal(danglingAttempt.kind, "invalid-link");
    const linkSecond = await linksRuntime.writeAttempt(makeAttempt(2, {
      ...linkBase,
      attemptId: "second",
      retryOfAttemptId: "first",
    }));
    assert.equal(linkSecond.ok, true);
    const linkSettled = createTaskSettledRecord({
      ...linkBase,
      attemptCount: 2,
      finalAttemptId: "second",
      attemptIds: ["first", "second"],
      summaryAttemptIds: [],
      outcome: { status: "success" },
    });
    assert.equal((await linksRuntime.writeTaskSettled(linkSettled)).ok, true);
    assert.equal((await linksRuntime.writeTaskSettled(linkSettled)).kind, "duplicate-settlement");
    const danglingSettlement = createTaskSettledRecord({
      runId: linkBase.runId,
      taskId: "other-task",
      attemptCount: 1,
      finalAttemptId: "first",
      attemptIds: ["first"],
      summaryAttemptIds: [],
      outcome: { status: "failure" },
    });
    assert.equal((await linksRuntime.writeTaskSettled(danglingSettlement)).kind, "invalid-link");
    await linksRuntime.close();
    
    const queueRuntime = createTraceRuntime({
      directory: join(root, "queue.traces"),
      namespace: "namespace-queue",
      maxQueueDepth: 1,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    await queueRuntime.ready;
    const queuedWrite = queueRuntime.writeAttempt(makeAttempt(20, {
      runId: "run-queue",
      taskId: "task-queue",
      attemptId: "queue-first",
      retryOfAttemptId: null,
    }));
    const overflowWrite = await queueRuntime.writeAttempt(makeAttempt(21, {
      runId: "run-queue",
      taskId: "task-queue",
      attemptId: "queue-overflow",
      retryOfAttemptId: null,
    }));
    assert.equal(overflowWrite.kind, "queue-full");
    assert.equal(overflowWrite.retryable, true);
    assert.equal((await queuedWrite).ok, true);
    assert.equal((await queueRuntime.writeAttempt(makeAttempt(21, {
      runId: "run-queue",
      taskId: "task-queue",
      attemptId: "queue-overflow",
      retryOfAttemptId: null,
    }))).ok, true);
    await queueRuntime.close();
    
    const lockDirectory = join(root, "lock.traces");
    const lockOwner = createTraceRuntime({ directory: lockDirectory, namespace: "namespace-lock-owner" });
    const lockContender = createTraceRuntime({ directory: lockDirectory, namespace: "namespace-lock-contender" });
    const [lockOwnerStartup, lockContenderStartup] = await Promise.all([lockOwner.ready, lockContender.ready]);
    assert.notEqual(lockOwnerStartup.ok, lockContenderStartup.ok);
    const lockHolder = lockOwnerStartup.ok ? lockOwner : lockContender;
    assert.equal((await lockHolder.writeAttempt(makeAttempt(30, {
      runId: "run-lock",
      taskId: "task-lock",
      attemptId: "lock-holder",
      retryOfAttemptId: null,
    }))).ok, true);
    await Promise.all([lockOwner.close(), lockContender.close()]);
    
    const staleLockDirectory = join(root, "stale-lock.traces");
    mkdirSync(staleLockDirectory);
    writeFileSync(join(staleLockDirectory, "trace.lock"), JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, startedAt: "2026-08-30T00:00:00.000Z" }));
    const staleLockRuntime = createTraceRuntime({ directory: staleLockDirectory, namespace: "namespace-stale-lock" });
    assert.equal((await staleLockRuntime.ready).ok, true);
    await staleLockRuntime.close();
    
    const invalidManifestDirectory = join(root, "invalid-manifest.traces");
    mkdirSync(invalidManifestDirectory);
    writeFileSync(join(invalidManifestDirectory, "trace-manifest.json"), JSON.stringify({
      schemaVersion: TRACE_SCHEMA_VERSION,
      kind: "trace-manifest",
      omittedRecords: "not-a-counter",
    }));
    const invalidManifestRuntime = createTraceRuntime({ directory: invalidManifestDirectory, namespace: "namespace-invalid-manifest" });
    const invalidManifestStartup = await invalidManifestRuntime.ready;
    assert.equal(invalidManifestStartup.ok, true);
    assert.equal(invalidManifestStartup.manifestErrors, 1);
    assert.equal(invalidManifestRuntime.manifest.manifestErrors, 1);
    await invalidManifestRuntime.close();
    const invalidManifestReopened = createTraceRuntime({ directory: invalidManifestDirectory, namespace: "namespace-invalid-manifest-reopened" });
    assert.equal((await invalidManifestReopened.ready).ok, true);
    assert.equal(invalidManifestReopened.manifest.manifestErrors, 1);
    await invalidManifestReopened.close();
    
    const traces = join(root, "term-runtime.traces");
    const runtime = createTraceRuntime({
      directory: traces,
      namespace: "namespace-runtime",
      retentionCap: 2,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    const runtimeStartup = await runtime.ready;
    assert.equal(runtimeStartup.ok, true);
    assert.equal(runtimeStartup.namespace, "namespace-runtime");
    assert.equal(runtimeStartup.reset.requested, false);
    
    const first = await runtime.writeAttempt(makeAttempt(1));
    assert.equal(first.ok, true);
    assert.equal(first.record.schemaVersion, TRACE_SCHEMA_VERSION);
    assert.equal(first.record.recordType, "attempt");
    assert.equal(first.persisted, true);
    const second = await runtime.writeAttempt(makeAttempt(2, {
      retryOfAttemptId: null,
      usage: { input: null, cacheRead: null, cacheWrite: 0, output: 10, reasoning: null },
    }));
    assert.equal(second.ok, true);
    const settlementResult = await runtime.writeTaskSettled(settled);
    assert.equal(settlementResult.ok, true);
    assert.equal(settlementResult.record.recordType, "task-settled");
    
    const filesAfterWrites = readdirSync(traces);
    assert.equal(filesAfterWrites.some((name) => name.endsWith(".tmp")), false);
    assert.equal(filesAfterWrites.filter((name) => /^turn-\d+\.json$/.test(name)).length, 2);
    const manifestAfterWrites = JSON.parse(readFileSync(join(traces, "trace-manifest.json"), "utf8"));
    assert.equal(manifestAfterWrites.schemaVersion, TRACE_SCHEMA_VERSION);
    assert.equal(manifestAfterWrites.kind, "trace-manifest");
    assert.equal(manifestAfterWrites.retainedRecords, 2);
    assert.equal(manifestAfterWrites.omittedRecords, 1);
    assert.equal(manifestAfterWrites.writeFailures, 0);
    assert.equal(manifestAfterWrites.startup.namespace, "namespace-runtime");
    await runtime.close();
    
    const reopened = createTraceRuntime({
      directory: traces,
      namespace: "namespace-reopened",
      retentionCap: 2,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.equal((await reopened.ready).ok, true);
    assert.equal(reopened.manifest.omittedRecords, 1);
    assert.equal(reopened.manifest.startup.preexistingRecords, 2);
    await reopened.close();
    
    const source = readTraceDirectory(traces);
    assert.equal(source.records.length, 2);
    assert.equal(source.errors.length, 0);
    const report = summarizeTraces(source.records, "runtime");
    assert.equal(report.schemaVersion, TRACE_SCHEMA_VERSION);
    assert.equal(report.attempts.total, 1);
    assert.equal(report.tasks.total, 1);
    assert.equal(report.usage.main.cacheRead.unknownSamples, 1);
    
    const malformed = join(root, "term-malformed.traces");
    mkdirSync(malformed);
    writeFileSync(join(malformed, "turn-7.json"), "{\"schemaVersion\":2");
    writeFileSync(join(malformed, "turn-8.json"), JSON.stringify({ schemaVersion: 2, recordType: "not-a-record" }));
    writeFileSync(join(malformed, "turn-9.json"), "{\"schemaVersion\":2}x");
    const malformedRuntime = createTraceRuntime({
      directory: malformed,
      namespace: "namespace-malformed",
      retentionCap: 10,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    const malformedStartup = await malformedRuntime.ready;
    assert.equal(malformedStartup.ok, true);
    assert.equal(malformedStartup.malformedRecords, 3);
    assert.equal(malformedStartup.partialRecords, 1);
    const malformedManifest = JSON.parse(readFileSync(join(malformed, "trace-manifest.json"), "utf8"));
    assert.equal(malformedManifest.malformedRecords, 3);
    assert.equal(malformedManifest.partialRecords, 1);
    await malformedRuntime.close();
    
    const malformedReopened = createTraceRuntime({
      directory: malformed,
      namespace: "namespace-malformed-reopened",
      retentionCap: 10,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    const malformedReopenedStartup = await malformedReopened.ready;
    assert.equal(malformedReopenedStartup.malformedRecords, 3);
    assert.equal(malformedReopenedStartup.partialRecords, 1);
    assert.equal(malformedReopened.manifest.malformedRecords, 3);
    assert.equal(malformedReopened.manifest.partialRecords, 1);
    await malformedReopened.close();
    
    const linkRetention = join(root, "link-retention.traces");
    const linkRetentionRuntime = createTraceRuntime({
      directory: linkRetention,
      namespace: "namespace-link-retention",
      retentionCap: 1,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.equal((await linkRetentionRuntime.ready).ok, true);
    assert.equal((await linkRetentionRuntime.writeAttempt(makeAttempt(1, {
      runId: "run-retention-links",
      taskId: "task-retention-links",
      attemptId: "retained-first",
      retryOfAttemptId: null,
    }))).ok, true);
    assert.equal((await linkRetentionRuntime.writeAttempt(makeAttempt(2, {
      runId: "run-retention-links",
      taskId: "task-retention-links",
      attemptId: "retained-second",
      retryOfAttemptId: "retained-first",
    }))).ok, true);
    assert.equal(linkRetentionRuntime.manifest.omittedRecords, 1);
    await linkRetentionRuntime.close();
    const linkIndexAfterRetention = JSON.parse(readFileSync(join(linkRetention, "trace-index.json"), "utf8"));
    assert.equal(linkIndexAfterRetention.kind, "trace-link-index");
    assert.equal(linkIndexAfterRetention.attempts.find((entry) => entry.attemptId === "retained-first").retained, false);
    
    const linkRetentionReopened = createTraceRuntime({
      directory: linkRetention,
      namespace: "namespace-link-retention-reopened",
      retentionCap: 1,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.equal((await linkRetentionReopened.ready).ok, true);
    const postRetentionSettlement = createTaskSettledRecord({
      runId: "run-retention-links",
      taskId: "task-retention-links",
      attemptCount: 2,
      finalAttemptId: "retained-second",
      attemptIds: ["retained-first", "retained-second"],
      summaryAttemptIds: [],
      outcome: { status: "success" },
    });
    assert.equal((await linkRetentionReopened.writeTaskSettled(postRetentionSettlement)).ok, true);
    await linkRetentionReopened.close();
    const linkRetentionRestarted = createTraceRuntime({
      directory: linkRetention,
      namespace: "namespace-link-retention-restarted",
      retentionCap: 1,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.equal((await linkRetentionRestarted.ready).ok, true);
    assert.equal(linkRetentionRestarted.manifest.linkIndex.complete, true);
    assert.equal((await linkRetentionRestarted.writeTaskSettled(postRetentionSettlement)).kind, "duplicate-settlement");
    await linkRetentionRestarted.close();
    
    const exhaustedTombstones = join(root, "exhausted-tombstones.traces");
    const tombstoneAttempts = [];
    const tombstoneSettlements = [];
    for (let index = 0; index < 2_048; index++) {
      const runId = `run-tombstone-${index}`;
      const taskId = `task-tombstone-${index}`;
      const attemptId = `attempt-tombstone-${index}`;
      tombstoneAttempts.push(traceIndexAttempt(runId, taskId, attemptId, false, index * 2 + 1));
      tombstoneSettlements.push(traceIndexSettlement(runId, taskId, attemptId, false, index * 2 + 2));
    }
    writeTraceIndex(exhaustedTombstones, tombstoneAttempts, tombstoneSettlements);
    const tombstoneRuntime = createTraceRuntime({
      directory: exhaustedTombstones,
      namespace: "namespace-exhausted-tombstones",
      retentionCap: 10,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.equal((await tombstoneRuntime.ready).ok, true);
    assert.equal((await tombstoneRuntime.writeAttempt(makeAttempt(1, {
      runId: "run-after-tombstones",
      taskId: "task-after-tombstones",
      attemptId: "attempt-after-tombstones",
      retryOfAttemptId: null,
    }))).ok, true);
    assert.equal(tombstoneRuntime.manifest.linkIndex.complete, false);
    assert.equal(tombstoneRuntime.manifest.linkIndex.attempts, 2_048);
    assert.equal(tombstoneRuntime.manifest.linkIndex.settlements, 2_047);
    const compactedTombstoneIndex = JSON.parse(readFileSync(join(exhaustedTombstones, "trace-index.json"), "utf8"));
    assert.equal(compactedTombstoneIndex.attempts.some((entry) => entry.attemptId === "attempt-tombstone-0"), false);
    assert.equal(compactedTombstoneIndex.attempts.some((entry) => entry.attemptId === "attempt-after-tombstones"), true);
    assert.equal((await tombstoneRuntime.writeAttempt(makeAttempt(1, {
      runId: "run-tombstone-1",
      taskId: "task-tombstone-1",
      attemptId: "attempt-tombstone-1",
      retryOfAttemptId: null,
    }))).kind, "duplicate-attempt");
    assert.equal((await tombstoneRuntime.writeTaskSettled(createTaskSettledRecord({
      runId: "run-tombstone-1",
      taskId: "task-tombstone-1",
      attemptCount: 1,
      finalAttemptId: "attempt-tombstone-1",
      attemptIds: ["attempt-tombstone-1"],
      summaryAttemptIds: [],
      outcome: { status: "success" },
    }))).kind, "duplicate-settlement");
    assert.equal((await tombstoneRuntime.writeAttempt(makeAttempt(1, {
      runId: "run-tombstone-0",
      taskId: "task-tombstone-0",
      attemptId: "attempt-tombstone-0",
      retryOfAttemptId: null,
    }))).ok, true);
    await tombstoneRuntime.close();
    
    const protectedLinkCapacity = join(root, "protected-link-capacity.traces");
    const protectedLinkAttempts = [];
    const protectedLinkSettlements = [];
    for (let index = 0; index < 2_047; index++) {
      const runId = `run-protected-link-${index}`;
      const taskId = `task-protected-link-${index}`;
      const attemptId = `attempt-protected-link-${index}`;
      protectedLinkAttempts.push(traceIndexAttempt(runId, taskId, attemptId, false, index * 2 + 1));
      protectedLinkSettlements.push(traceIndexSettlement(runId, taskId, attemptId, false, index * 2 + 2));
    }
    protectedLinkAttempts.push(traceIndexAttempt("run-protected-unsettled", "task-protected-unsettled", "attempt-protected-unsettled"));
    writeTraceIndex(protectedLinkCapacity, protectedLinkAttempts, protectedLinkSettlements, false);
    const protectedLinkRuntime = createTraceRuntime({
      directory: protectedLinkCapacity,
      namespace: "namespace-protected-link-capacity",
      retentionCap: 10,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.equal((await protectedLinkRuntime.ready).ok, true);
    assert.equal((await protectedLinkRuntime.writeAttempt(makeAttempt(1, {
      runId: "run-protected-link-0",
      taskId: "task-protected-link-0",
      attemptId: "attempt-after-protected-link",
      parentAttemptId: "unknown-parent-after-protected-link",
      retryOfAttemptId: "attempt-protected-link-0",
    }))).ok, true);
    const protectedLinkIndex = JSON.parse(readFileSync(join(protectedLinkCapacity, "trace-index.json"), "utf8"));
    assert.equal(protectedLinkIndex.attempts.some((entry) => entry.attemptId === "attempt-protected-link-0" && entry.unknown === false), true);
    assert.equal(protectedLinkIndex.settlements.some((entry) => entry.taskId === "task-protected-link-0"), true);
    assert.equal(protectedLinkIndex.attempts.some((entry) => entry.attemptId === "attempt-protected-link-1"), false);
    await protectedLinkRuntime.close();
    
    const protectedHistoryCapacity = join(root, "protected-history-capacity.traces");
    const protectedHistoryAttempts = [];
    const protectedHistorySettlements = [];
    for (let index = 0; index < 2_045; index++) {
      const runId = `run-history-tombstone-${index}`;
      const taskId = `task-history-tombstone-${index}`;
      const attemptId = `attempt-history-tombstone-${index}`;
      protectedHistoryAttempts.push(traceIndexAttempt(runId, taskId, attemptId, false, index * 2 + 10));
      protectedHistorySettlements.push(traceIndexSettlement(runId, taskId, attemptId, false, index * 2 + 11));
    }
    protectedHistoryAttempts.push(
      traceIndexAttempt("run-history-retained", "task-history-retained", "attempt-history-retained", true),
      traceIndexAttempt("run-history-unsettled", "task-history-unsettled", "attempt-history-unsettled"),
      { ...traceIndexAttempt("run-history-unknown", "task-history-unknown", "attempt-history-unknown"), unknown: true },
      traceIndexAttempt("run-history-unsettled-2", "task-history-unsettled-2", "attempt-history-unsettled-2"),
    );
    protectedHistorySettlements.push(traceIndexSettlement(
      "run-history-retained",
      "task-history-retained",
      "attempt-history-retained",
      true,
    ));
    writeTraceIndex(protectedHistoryCapacity, protectedHistoryAttempts, protectedHistorySettlements, false);
    const protectedHistoryRuntime = createTraceRuntime({
      directory: protectedHistoryCapacity,
      namespace: "namespace-protected-history-capacity",
      retentionCap: 10,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.equal((await protectedHistoryRuntime.ready).ok, true);
    assert.equal((await protectedHistoryRuntime.writeAttempt(makeAttempt(1, {
      runId: "run-history-admission",
      taskId: "task-history-admission",
      attemptId: "attempt-history-admission",
      parentAttemptId: "unknown-parent-after-history-admission",
      retryOfAttemptId: null,
    }))).ok, true);
    const protectedHistoryIndex = JSON.parse(readFileSync(join(protectedHistoryCapacity, "trace-index.json"), "utf8"));
    assert.equal(protectedHistoryIndex.attempts.some((entry) => entry.attemptId === "attempt-history-retained" && entry.retained), true);
    assert.equal(protectedHistoryIndex.settlements.some((entry) => entry.taskId === "task-history-retained" && entry.retained), true);
    assert.equal(protectedHistoryIndex.attempts.some((entry) => entry.attemptId === "attempt-history-unsettled"), true);
    assert.equal(protectedHistoryIndex.attempts.some((entry) => entry.attemptId === "attempt-history-unsettled-2"), true);
    assert.equal(protectedHistoryIndex.attempts.some((entry) => entry.attemptId === "attempt-history-unknown" && entry.unknown), true);
    await protectedHistoryRuntime.close();
    
    const byteExhausted = join(root, "byte-exhausted.traces");
    const byteAttempts = [];
    const byteSettlements = [];
    const nextRunId = longTraceId("run-next", 0);
    const nextTaskId = longTraceId("task-next", 0);
    const nextAttemptId = longTraceId("attempt-next", 0);
    const nextIndexAttempt = traceIndexAttempt(nextRunId, nextTaskId, nextAttemptId);
    while (true) {
      const index = byteAttempts.length;
      const runId = longTraceId("run-byte", index);
      const taskId = longTraceId("task-byte", index);
      const attemptId = longTraceId("attempt-byte", index);
      const prospectiveBytes = Buffer.byteLength(JSON.stringify({
        schemaVersion: TRACE_SCHEMA_VERSION,
        kind: "trace-link-index",
        complete: true,
        updatedAt: "2026-08-30T00:00:00.000Z",
        attempts: [...byteAttempts, nextIndexAttempt],
        settlements: byteSettlements,
      }), "utf8");
      if (prospectiveBytes > 1 * 1024 * 1024) break;
      byteAttempts.push(traceIndexAttempt(runId, taskId, attemptId));
      byteSettlements.push(traceIndexSettlement(runId, taskId, attemptId));
    }
    writeTraceIndex(byteExhausted, byteAttempts, byteSettlements);
    const byteRuntime = createTraceRuntime({
      directory: byteExhausted,
      namespace: "namespace-byte-exhausted",
      retentionCap: 10,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.equal((await byteRuntime.ready).ok, true);
    const byteAdmission = await byteRuntime.writeAttempt(makeAttempt(1, {
      runId: nextRunId,
      taskId: nextTaskId,
      attemptId: nextAttemptId,
      retryOfAttemptId: null,
    }));
    assert.equal(byteAdmission.ok, true);
    assert.equal(byteAdmission.persisted, true);
    assert.equal(byteRuntime.manifest.linkIndex.complete, false);
    assert.equal(readdirSync(byteExhausted).filter((name) => /^turn-\d+\.json$/.test(name)).length, 1);
    await byteRuntime.close();
    
    const variableTimestampBoundary = join(root, "variable-timestamp-boundary.traces");
    const shortIndexTimestamp = "s";
    const longIndexTimestamp = "l".repeat(512);
    const timestampBoundaryAttempts = [];
    const timestampBoundarySettlements = [];
    let timestampBoundaryRecord = null;
    for (let index = 0; timestampBoundaryRecord === null; index++) {
      const boundaryRecordFor = (length) => {
        const suffix = "n".repeat(length);
        return {
          runId: `run-timestamp-boundary-${suffix}`,
          taskId: `task-timestamp-boundary-${suffix}`,
          attemptId: `attempt-timestamp-boundary-${suffix}`,
        };
      };
      const boundaryBytes = (record, updatedAt) => Buffer.byteLength(JSON.stringify({
        schemaVersion: TRACE_SCHEMA_VERSION,
        kind: "trace-link-index",
        complete: true,
        updatedAt,
        attempts: [...timestampBoundaryAttempts, traceIndexAttempt(record.runId, record.taskId, record.attemptId)],
        settlements: timestampBoundarySettlements,
      }), "utf8");
      const smallestRecord = boundaryRecordFor(1);
      const largestRecord = boundaryRecordFor(480);
      if (boundaryBytes(smallestRecord, shortIndexTimestamp) <= 1 * 1024 * 1024 &&
        boundaryBytes(largestRecord, longIndexTimestamp) > 1 * 1024 * 1024) {
        for (let length = 1; length <= 480; length++) {
          const record = boundaryRecordFor(length);
          const shortBytes = boundaryBytes(record, shortIndexTimestamp);
          const longBytes = boundaryBytes(record, longIndexTimestamp);
          if (shortBytes <= 1 * 1024 * 1024 && longBytes > 1 * 1024 * 1024) {
            timestampBoundaryRecord = record;
            break;
          }
        }
      }
      if (timestampBoundaryRecord !== null) break;
      const runId = `run-timestamp-seed-${index}-${"x".repeat(120)}`;
      const taskId = `task-timestamp-seed-${index}-${"x".repeat(120)}`;
      const attemptId = `attempt-timestamp-seed-${index}-${"x".repeat(120)}`;
      timestampBoundaryAttempts.push(traceIndexAttempt(runId, taskId, attemptId));
      assert.ok(timestampBoundaryAttempts.length + timestampBoundarySettlements.length < 4_096);
    }
    assert.notEqual(timestampBoundaryRecord, null);
    const timestampBoundaryIndexBase = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      kind: "trace-link-index",
      complete: true,
      attempts: [...timestampBoundaryAttempts, traceIndexAttempt(
        timestampBoundaryRecord.runId,
        timestampBoundaryRecord.taskId,
        timestampBoundaryRecord.attemptId,
      )],
      settlements: timestampBoundarySettlements,
    };
    assert.ok(Buffer.byteLength(JSON.stringify({ ...timestampBoundaryIndexBase, updatedAt: shortIndexTimestamp }), "utf8") <= 1 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...timestampBoundaryIndexBase, updatedAt: longIndexTimestamp }), "utf8") > 1 * 1024 * 1024);
    writeTraceIndex(variableTimestampBoundary, timestampBoundaryAttempts, timestampBoundarySettlements, true, shortIndexTimestamp);
    let timestampBoundaryWrite = false;
    let timestampBoundaryNowCalls = 0;
    const variableTimestampRuntime = createTraceRuntime({
      directory: variableTimestampBoundary,
      namespace: "namespace-variable-timestamp-boundary",
      retentionCap: 10,
      now: () => {
        if (!timestampBoundaryWrite) return shortIndexTimestamp;
        timestampBoundaryNowCalls++;
        return timestampBoundaryNowCalls <= 3 ? shortIndexTimestamp : longIndexTimestamp;
      },
    });
    assert.equal((await variableTimestampRuntime.ready).ok, true);
    timestampBoundaryWrite = true;
    assert.equal((await variableTimestampRuntime.writeAttempt(makeAttempt(1, {
      ...timestampBoundaryRecord,
      retryOfAttemptId: null,
    }))).ok, true);
    const variableTimestampIndex = readFileSync(join(variableTimestampBoundary, "trace-index.json"), "utf8");
    assert.ok(Buffer.byteLength(variableTimestampIndex, "utf8") <= 1 * 1024 * 1024);
    assert.equal(JSON.parse(variableTimestampIndex).updatedAt, shortIndexTimestamp);
    timestampBoundaryWrite = false;
    await variableTimestampRuntime.close();
    
    const resetRuntime = createTraceRuntime({
      directory: traces,
      namespace: "namespace-reset",
      retentionCap: 10,
      reset: true,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    const resetStartup = await resetRuntime.ready;
    assert.equal(resetStartup.ok, true);
    assert.equal(resetStartup.reset.requested, true);
    assert.equal(resetStartup.reset.applied, true);
    assert.equal(resetStartup.reset.omittedRecords, 2);
    const resetManifest = JSON.parse(readFileSync(join(traces, "trace-manifest.json"), "utf8"));
    assert.equal(resetManifest.startup.reset.applied, true);
    assert.equal(resetManifest.omittedRecords, 3);
    await resetRuntime.close();
    
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory");
    const failedRuntime = createTraceRuntime({
      directory: blocked,
      namespace: "namespace-failed",
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.equal((await failedRuntime.ready).ok, false);
    const failedWrite = await failedRuntime.writeAttempt(makeAttempt(1));
    assert.equal(failedWrite.ok, false);
    assert.equal(failedWrite.persisted, false);
    assert.equal(failedWrite.kind, "write-failure");
    assert.equal(failedWrite.retryable, true);
    await failedRuntime.close();
    
    const boundedRuntime = createTraceRuntime({
      directory: join(root, "bounded.traces"),
      namespace: "namespace-bounded",
      maxRecordBytes: 2_048,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    await boundedRuntime.ready;
    const bounded = await boundedRuntime.writeAttempt(makeAttempt(1, {
      toolNames: ["x".repeat(2_000)],
    }));
    assert.equal(bounded.ok, false);
    assert.equal(bounded.persisted, false);
    assert.equal(bounded.kind, "record-too-large");
    assert.equal(bounded.retryable, false);
    assert.equal(bounded.manifest.writeFailures, 1);
    const boundedRecovery = await boundedRuntime.writeAttempt(createAttemptRecord({
      runId: "run-bounded",
      taskId: "task-bounded",
      attemptId: "small-after-too-large",
      role: "main",
      provider: "openai",
      protocol: "openai-responses",
      model: "gpt-5.6",
      status: "ok",
    }));
    assert.equal(boundedRecovery.ok, true);
    assert.equal(boundedRecovery.traceTurn, 1);
    await boundedRuntime.close();
    
    console.log("agent-core trace runtime tests passed");
  }, 60_000);
});
