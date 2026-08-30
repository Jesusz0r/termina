/**
 * Focused RED/GREEN contract for durable reclaim receipts.
 *
 * This test intentionally owns no production integration.  It exercises the
 * session owner as a durable append/replay/fork boundary and keeps the
 * reclaim receipt shape structural so session.ts does not import reclaim.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as session from "../agent-core/session.ts";

const root = mkdtempSync(join(tmpdir(), "agent-core-session-receipt-"));
const sourceFile = session.coreSessionFile(root, "source");
const forkFile = session.coreSessionFile(root, "fork");
mkdirSync(dirname(sourceFile), { recursive: true, mode: 0o700 });

const originalBlock = {
  type: "tool_result",
  tool_use_id: "tool-1",
  tool: "read_file",
  content: "original payload with enough detail to recover",
};

function hashBlock(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

const receipt = {
  revisionId: "rev-1",
  targets: [
    {
      sseq: 1,
      blockIndex: 0,
      action: "stub",
      original: {
        type: "tool_result",
        chars: originalBlock.content.length,
        bytes: Buffer.byteLength(JSON.stringify(originalBlock), "utf8"),
        sha256: hashBlock(originalBlock),
      },
      reclaimedTokens: 12,
      tool: "read_file",
      repro: "read_file src/a.ts",
      revisionId: "rev-1",
      recovery: { source: "session-record", tool: "read_file", repro: "read_file src/a.ts" },
    },
  ],
};
assert.equal(session.validateSessionReclaimReceipt(receipt).ok, true);
const invalidFallback = {
  ...receipt,
  revisionId: "rev-invalid-fallback",
  targets: [{ ...receipt.targets[0], revisionId: "rev-invalid-fallback", fallback: "partial-read" }],
};
expectFailure(session.validateSessionReclaimReceipt(invalidFallback), "invalid recovery receipt target");

const shiftedThinking = { type: "thinking", thinking: "private block" };
const shiftedTool = { type: "tool_result", tool: "read_file", content: "tool block" };
const shiftedTarget = (block, blockIndex, action) => ({
  sseq: 7,
  blockIndex,
  action,
  original: {
    type: block.type,
    chars: block.type === "thinking" ? block.thinking.length : block.content.length,
    bytes: Buffer.byteLength(JSON.stringify(block), "utf8"),
    sha256: hashBlock(block),
  },
  reclaimedTokens: 1,
  revisionId: "rev-shift",
  recovery: { source: "session-record", tool: "read_file", repro: null },
});
assert.equal(
  session.validateSessionReclaimReceipt({
    revisionId: "rev-shift",
    targets: [shiftedTarget(shiftedThinking, 0, "drop"), shiftedTarget(shiftedTool, 1, "stub")],
  }).ok,
  false,
);
assert.equal(
  session.validateSessionReclaimReceipt({
    revisionId: "rev-duplicate-source",
    targets: [
      { ...receipt.targets[0], revisionId: "rev-duplicate-source", sseq: 7, sourceSseq: 11 },
      { ...receipt.targets[0], revisionId: "rev-duplicate-source", sseq: 8, sourceSseq: 11 },
    ],
  }).ok,
  false,
);

function line(record) {
  return `${JSON.stringify(record)}\n`;
}

function writeSession(records) {
  mkdirSync(dirname(sourceFile), { recursive: true, mode: 0o700 });
  writeFileSync(sourceFile, records.map(line).join(""), { mode: 0o600 });
}

function expectFailure(result, phrase) {
  assert.equal(result.ok, false);
  assert.match(result.error, new RegExp(phrase));
}

writeSession([
  {
    storageSeq: 1,
    type: "message",
    message: { role: "user", content: [originalBlock] },
  },
  {
    storageSeq: 2,
    type: "revision",
    kind: "prune",
    revisionId: receipt.revisionId,
    targets: receipt.targets,
  },
]);

const replayed = await session.replaySessionBundle(sourceFile);
assert.equal(replayed.ok, true);
assert.equal(typeof replayed.sourceFingerprint, "string");
assert.equal(replayed.messages[0].content[0].stubbed, true);
assert.equal(replayed.state.recoveries.size, 1);

const recovery = await session.recoverSessionBlock(sourceFile, {
  revisionId: receipt.revisionId,
  sseq: 1,
  blockIndex: 0,
});
assert.equal(recovery.ok, true);
assert.deepEqual(recovery.block, originalBlock);
assert.equal(recovery.recoveredFrom, "source-record");

const missing = await session.recoverSessionBlock(sourceFile, {
  revisionId: "missing-revision",
  sseq: 1,
  blockIndex: 0,
});
expectFailure(missing, "missing recovery receipt");

const stale = await session.recoverSessionBlock(sourceFile, {
  revisionId: receipt.revisionId,
  sseq: 1,
  blockIndex: 1,
});
expectFailure(stale, "stale recovery target");

const tampered = readFileSync(sourceFile, "utf8").replace("original payload with enough detail to recover", "tampered");
writeFileSync(sourceFile, tampered, { mode: 0o600 });
const hashMismatch = await session.recoverSessionBlock(sourceFile, {
  revisionId: receipt.revisionId,
  sseq: 1,
  blockIndex: 0,
});
expectFailure(hashMismatch, "hash mismatch");

// A fork must carry an origin/recovery mapping that remains usable after the
// visible messages are densely renumbered.  Parent sseq alone is insufficient.
writeSession([
  {
    storageSeq: 10,
    type: "message",
    message: { role: "user", content: [originalBlock] },
  },
  {
    storageSeq: 11,
    type: "revision",
    kind: "prune",
    revisionId: "rev-gap",
    targets: [{
      ...receipt.targets[0],
      sseq: 10,
      revisionId: "rev-gap",
      recovery: { ...receipt.targets[0].recovery, repro: "read_file src/a.ts" },
    }],
  },
]);
const forked = await session.writeForkedSession(sourceFile, forkFile, 11);
assert.equal(forked.ok, true, JSON.stringify(forked));
const forkReplay = await session.replaySessionBundle(forkFile);
assert.equal(forkReplay.ok, true);
assert.equal(forkReplay.messages[0].content[0].stubbed, true);
assert.equal(forkReplay.state.recoveries.size, 1);
const forkRecovery = await session.recoverSessionBlock(forkFile, {
  revisionId: "rev-gap",
  sseq: 10,
  blockIndex: 0,
});
assert.equal(forkRecovery.ok, true);
assert.deepEqual(forkRecovery.block, originalBlock);

// Drop receipts must survive a dense fork as well.  The child writes the
// original block, maps the receipt to its local sseq, and replays the drop;
// recovery still addresses the parent/source sequence without guessing from
// the child sequence alone.
const dropRoot = mkdtempSync(join(tmpdir(), "agent-core-session-drop-"));
const dropSource = session.coreSessionFile(dropRoot, "drop-source");
const dropFork = session.coreSessionFile(dropRoot, "drop-fork");
mkdirSync(dirname(dropSource), { recursive: true, mode: 0o700 });
const thinkingBlock = { type: "thinking", thinking: "private reasoning to recover" };
const visibleBlock = { type: "text", text: "visible" };
const dropTarget = {
  sseq: 10,
  blockIndex: 0,
  action: "drop",
  original: {
    type: "thinking",
    chars: thinkingBlock.thinking.length,
    bytes: Buffer.byteLength(JSON.stringify(thinkingBlock), "utf8"),
    sha256: hashBlock(thinkingBlock),
  },
  reclaimedTokens: 8,
  revisionId: "rev-drop",
  recovery: { source: "session-record", tool: "reasoning", repro: null },
};
writeFileSync(
  dropSource,
  [
    line({
      storageSeq: 10,
      type: "message",
      message: { role: "assistant", content: [thinkingBlock, visibleBlock] },
    }),
    line({ storageSeq: 11, type: "revision", kind: "prune", revisionId: "rev-drop", targets: [dropTarget] }),
  ].join(""),
  { mode: 0o600 },
);
const dropReplay = await session.replaySessionBundle(dropSource);
assert.equal(dropReplay.ok, true);
assert.deepEqual(dropReplay.messages[0].content, [visibleBlock]);
assert.equal(dropReplay.state.recoveries.size, 1);
const dropResult = await session.writeForkedSession(dropSource, dropFork, 11);
assert.equal(dropResult.ok, true, JSON.stringify(dropResult));
const dropForkReplay = await session.replaySessionBundle(dropFork);
assert.equal(dropForkReplay.ok, true);
assert.deepEqual(dropForkReplay.messages[0].content, [visibleBlock]);
assert.equal(dropForkReplay.state.recoveries.size, 1);
assert.equal(dropForkReplay.state.recoveries.values().next().value.fallback, "full-read");
const dropRecovery = await session.recoverSessionBlock(dropFork, {
  revisionId: "rev-drop",
  sseq: 10,
  blockIndex: 0,
});
assert.equal(dropRecovery.ok, true);
assert.deepEqual(dropRecovery.block, thinkingBlock);

// Segment numbering is part of the durable layout; a missing immutable part
// must not be silently skipped.
const partRoot = mkdtempSync(join(tmpdir(), "agent-core-session-parts-"));
const partFile = session.coreSessionFile(partRoot, "parts");
mkdirSync(dirname(partFile), { recursive: true, mode: 0o700 });
writeFileSync(join(dirname(partFile), "part-000002.jsonl"), "", { mode: 0o600 });
writeFileSync(partFile, "", { mode: 0o600 });
expectFailure(session.listCurrentSegments(dirname(partFile)), "non-contiguous");
const missingPartReplay = await session.replaySessionBundle(partFile);
expectFailure(missingPartReplay, "non-contiguous");

// JSONL framing must reject malformed UTF-8 instead of replacing it with U+FFFD.
const utfRoot = mkdtempSync(join(tmpdir(), "agent-core-session-utf8-"));
const utfFile = session.coreSessionFile(utfRoot, "utf8");
mkdirSync(dirname(utfFile), { recursive: true, mode: 0o700 });
writeFileSync(
  utfFile,
  Buffer.concat([Buffer.from('{"storageSeq":1,"type":"message","message":{"role":"user","content":"'), Buffer.from([0xff]), Buffer.from('"}}\n')]),
  { mode: 0o600 },
);
const invalidUtf8 = await session.replaySessionBundle(utfFile);
expectFailure(invalidUtf8, "UTF-8");
const utfTailFile = session.coreSessionFile(utfRoot, "utf8-tail");
mkdirSync(dirname(utfTailFile), { recursive: true, mode: 0o700 });
writeFileSync(utfTailFile, Buffer.from([0xff]), { mode: 0o600 });
const invalidUtf8Tail = await session.replaySessionBundle(utfTailFile);
expectFailure(invalidUtf8Tail, "UTF-8");

// Failure injection at the descriptor boundary must poison the writer and
// leave no sequence available for a second append on that handle.
const poisonRoot = mkdtempSync(join(tmpdir(), "agent-core-session-poison-"));
const poisonFile = session.coreSessionFile(poisonRoot, "poison");
mkdirSync(dirname(poisonFile), { recursive: true, mode: 0o700 });
const poisonOpened = session.SessionWriter.open(poisonFile, 0);
assert.equal(poisonOpened.ok, true);
const poisonWriter = poisonOpened.writer;
assert.equal(poisonWriter.appendRecord({ storageSeq: 1, type: "checkpoint" }).ok, true);
poisonWriter.fd = -1;
const appendFailure = poisonWriter.appendRecord({ storageSeq: 2, type: "checkpoint" });
expectFailure(appendFailure, "poisoned|bad file descriptor");
const reusedSequence = poisonWriter.appendRecord({ storageSeq: 2, type: "checkpoint" });
expectFailure(reusedSequence, "poisoned");
const poisonReplay = await session.replaySessionBundle(poisonFile);
assert.equal(poisonReplay.ok, true);
assert.equal(poisonReplay.maxSeq, 1);

// Destination validation rejects symlinked parents before creating a temp
// bundle, so an attacker cannot redirect a fork through a path component.
const symlinkDestinationRoot = mkdtempSync(join(tmpdir(), "agent-core-session-dest-link-"));
const realDestinationRoot = mkdtempSync(join(tmpdir(), "agent-core-session-dest-real-"));
const linkedProject = join(symlinkDestinationRoot, "linked-project");
symlinkSync(realDestinationRoot, linkedProject, "dir");
const linkedDestination = session.coreSessionFile(linkedProject, "linked");
const linkedFork = await session.writeForkedSession(sourceFile, linkedDestination, 2);
expectFailure(linkedFork, "symlink");

// Invalid receipts fail before the visible state is mutated.
const invalid = session.replaySessionRecords(
  [
    line({ storageSeq: 1, type: "message", message: { role: "user", content: [originalBlock] } }),
    line({
      storageSeq: 2,
      type: "revision",
      kind: "prune",
      revisionId: "rev-bad",
      targets: [{
        ...receipt.targets[0],
        revisionId: "rev-bad",
        original: { ...receipt.targets[0].original, sha256: "0" },
        recovery: { ...receipt.targets[0].recovery, repro: null },
      }],
    }),
  ].join(""),
);
expectFailure(invalid, "invalid recovery receipt");

const atomicState = session.createReplayState();
assert.equal(session.applySessionRecord(atomicState, {
  storageSeq: 1,
  type: "message",
  message: { role: "user", content: [originalBlock] },
}).ok, true);
const beforeInvalid = JSON.stringify(atomicState.messages);
const invalidApply = session.applySessionRecord(atomicState, {
  storageSeq: 2,
  type: "revision",
  kind: "prune",
  revisionId: "rev-bad-apply",
  targets: [{
    ...receipt.targets[0],
    revisionId: "rev-bad-apply",
    original: { ...receipt.targets[0].original, sha256: "0" },
    recovery: { ...receipt.targets[0].recovery, repro: null },
  }],
});
expectFailure(invalidApply, "invalid recovery receipt");
assert.equal(JSON.stringify(atomicState.messages), beforeInvalid);
assert.equal(atomicState.lastSeq, 1);

const legacyState = session.createReplayState();
assert.equal(session.applySessionRecord(legacyState, {
  storageSeq: 1,
  type: "message",
  message: { role: "user", content: [originalBlock] },
}).ok, true);
const beforeLegacy = JSON.stringify(legacyState.messages);
const legacyPrune = session.applySessionRecord(legacyState, {
  storageSeq: 2,
  type: "revision",
  kind: "prune",
  targets: [{ sseq: 1, blockIndex: 0, action: "stub" }],
});
expectFailure(legacyPrune, "receipt|prune");
assert.equal(JSON.stringify(legacyState.messages), beforeLegacy);
assert.equal(legacyState.lastSeq, 1);

console.log("all focused session receipt tests passed");
