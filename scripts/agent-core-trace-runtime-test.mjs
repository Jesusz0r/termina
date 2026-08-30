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
} from "../agent-core/trace.ts";
import { readTraceDirectory, summarizeTraces } from "./agent-core-trace-report.mjs";

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
