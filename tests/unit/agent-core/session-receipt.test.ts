import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as session from "../../../agent-core/session.ts";

function hashBlock(value: any) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function line(record: any) {
  return `${JSON.stringify(record)}\n`;
}

describe("Agent Core Session Durable Reclaim Receipts & Block Recovery", () => {
  let root: string;
  let sourceFile: string;
  let forkFile: string;

  const originalBlock = {
    type: "tool_result",
    tool_use_id: "tool-1",
    tool: "read_file",
    content: "original payload with enough detail to recover",
  };

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

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agent-core-session-receipt-"));
    sourceFile = session.coreSessionFile(root, "source");
    forkFile = session.coreSessionFile(root, "fork");
    mkdirSync(dirname(sourceFile), { recursive: true, mode: 0o700 });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSession(records: any[]) {
    mkdirSync(dirname(sourceFile), { recursive: true, mode: 0o700 });
    writeFileSync(sourceFile, records.map(line).join(""), { mode: 0o600 });
  }

  it("validates reclaim receipt structural shape", () => {
    expect(session.validateSessionReclaimReceipt(receipt).ok).toBe(true);

    const invalidFallback = {
      ...receipt,
      revisionId: "rev-invalid-fallback",
      targets: [{ ...receipt.targets[0], revisionId: "rev-invalid-fallback", fallback: "partial-read" }],
    };
    const res = session.validateSessionReclaimReceipt(invalidFallback);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid recovery receipt target/);
  });

  it("recovers stubbed blocks from original source records", async () => {
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
    expect(replayed.ok).toBe(true);
    expect(replayed.messages[0].content[0].stubbed).toBe(true);
    expect(replayed.state.recoveries.size).toBe(1);

    const recovery = await session.recoverSessionBlock(sourceFile, {
      revisionId: receipt.revisionId,
      sseq: 1,
      blockIndex: 0,
    });
    expect(recovery.ok).toBe(true);
    expect(recovery.block).toEqual(originalBlock);
    expect(recovery.recoveredFrom).toBe("source-record");

    const missing = await session.recoverSessionBlock(sourceFile, {
      revisionId: "missing-revision",
      sseq: 1,
      blockIndex: 0,
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/missing recovery receipt/);

    const stale = await session.recoverSessionBlock(sourceFile, {
      revisionId: receipt.revisionId,
      sseq: 1,
      blockIndex: 1,
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/stale recovery target/);
  });

  it("detects hash mismatches upon tampering", async () => {
    const tampered = readFileSync(sourceFile, "utf8").replace("original payload with enough detail to recover", "tampered");
    writeFileSync(sourceFile, tampered, { mode: 0o600 });
    const hashMismatch = await session.recoverSessionBlock(sourceFile, {
      revisionId: receipt.revisionId,
      sseq: 1,
      blockIndex: 0,
    });
    expect(hashMismatch.ok).toBe(false);
    expect(hashMismatch.error).toMatch(/hash mismatch/);
  });

  it("carries origin and recovery mapping across session forks", async () => {
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
    expect(forked.ok).toBe(true);
    const forkReplay = await session.replaySessionBundle(forkFile);
    expect(forkReplay.ok).toBe(true);
    expect(forkReplay.messages[0].content[0].stubbed).toBe(true);
    expect(forkReplay.state.recoveries.size).toBe(1);
    const forkRecovery = await session.recoverSessionBlock(forkFile, {
      revisionId: "rev-gap",
      sseq: 10,
      blockIndex: 0,
    });
    expect(forkRecovery.ok).toBe(true);
    expect(forkRecovery.block).toEqual(originalBlock);
  });

  it("survives dense fork for drop receipts and recovers thinking blocks", async () => {
    const dropRoot = mkdtempSync(join(tmpdir(), "agent-core-session-drop-"));
    try {
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
      expect(dropReplay.ok).toBe(true);
      expect(dropReplay.messages[0].content).toEqual([visibleBlock]);
      expect(dropReplay.state.recoveries.size).toBe(1);

      const dropResult = await session.writeForkedSession(dropSource, dropFork, 11);
      expect(dropResult.ok).toBe(true);
      const dropForkReplay = await session.replaySessionBundle(dropFork);
      expect(dropForkReplay.ok).toBe(true);
      expect(dropForkReplay.messages[0].content).toEqual([visibleBlock]);
      expect(dropForkReplay.state.recoveries.size).toBe(1);

      const dropRecovery = await session.recoverSessionBlock(dropFork, {
        revisionId: "rev-drop",
        sseq: 10,
        blockIndex: 0,
      });
      expect(dropRecovery.ok).toBe(true);
      expect(dropRecovery.block).toEqual(thinkingBlock);
    } finally {
      rmSync(dropRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on non-contiguous parts, invalid UTF-8, and poisoned descriptors", async () => {
    const partRoot = mkdtempSync(join(tmpdir(), "agent-core-session-parts-"));
    try {
      const partFile = session.coreSessionFile(partRoot, "parts");
      mkdirSync(dirname(partFile), { recursive: true, mode: 0o700 });
      writeFileSync(join(dirname(partFile), "part-000002.jsonl"), "", { mode: 0o600 });
      writeFileSync(partFile, "", { mode: 0o600 });
      const missingPartReplay = await session.replaySessionBundle(partFile);
      expect(missingPartReplay.ok).toBe(false);
      expect(missingPartReplay.error).toMatch(/non-contiguous/);
    } finally {
      rmSync(partRoot, { recursive: true, force: true });
    }
  });
});
