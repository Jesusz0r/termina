import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as session from "../../../agent-core/session.ts";

function hashBlock(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function line(record: unknown) {
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

  function writeSession(records: unknown[]) {
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
    if (!res.ok) {
      expect(res.error).toMatch(/invalid recovery receipt target/);
    }
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
    if (replayed.ok) {
      const firstBlock = replayed.messages[0].content[0];
      expect(typeof firstBlock !== "string" && firstBlock.stubbed).toBe(true);
      expect(replayed.state.recoveries.size).toBe(1);
    }

    const recovery = await session.recoverSessionBlock(sourceFile, {
      revisionId: receipt.revisionId,
      sseq: 1,
      blockIndex: 0,
    });
    expect(recovery.ok).toBe(true);
    if (recovery.ok) {
      expect(recovery.block).toEqual(originalBlock);
      expect(recovery.recoveredFrom).toBe("source-record");
    }

    const missing = await session.recoverSessionBlock(sourceFile, {
      revisionId: "missing-revision",
      sseq: 1,
      blockIndex: 0,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toMatch(/missing recovery receipt/);
    }

    const stale = await session.recoverSessionBlock(sourceFile, {
      revisionId: receipt.revisionId,
      sseq: 1,
      blockIndex: 1,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error).toMatch(/stale recovery target/);
    }
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
    if (!hashMismatch.ok) {
      expect(hashMismatch.error).toMatch(/hash mismatch/);
    }
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
    if (forkReplay.ok) {
      const forkFirstBlock = forkReplay.messages[0].content[0];
      expect(typeof forkFirstBlock !== "string" && forkFirstBlock.stubbed).toBe(true);
      expect(forkReplay.state.recoveries.size).toBe(1);
    }
    const forkRecovery = await session.recoverSessionBlock(forkFile, {
      revisionId: "rev-gap",
      sseq: 10,
      blockIndex: 0,
    });
    expect(forkRecovery.ok).toBe(true);
    if (forkRecovery.ok) {
      expect(forkRecovery.block).toEqual(originalBlock);
    }
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
      if (dropReplay.ok) {
        expect(dropReplay.messages[0].content).toEqual([visibleBlock]);
        expect(dropReplay.state.recoveries.size).toBe(1);
      }

      const dropResult = await session.writeForkedSession(dropSource, dropFork, 11);
      expect(dropResult.ok).toBe(true);
      const dropForkReplay = await session.replaySessionBundle(dropFork);
      expect(dropForkReplay.ok).toBe(true);
      if (dropForkReplay.ok) {
        expect(dropForkReplay.messages[0].content).toEqual([visibleBlock]);
        expect(dropForkReplay.state.recoveries.size).toBe(1);
      }

      const dropRecovery = await session.recoverSessionBlock(dropFork, {
        revisionId: "rev-drop",
        sseq: 10,
        blockIndex: 0,
      });
      expect(dropRecovery.ok).toBe(true);
      if (dropRecovery.ok) {
        expect(dropRecovery.block).toEqual(thinkingBlock);
      }
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
      if (!missingPartReplay.ok) {
        expect(missingPartReplay.error).toMatch(/non-contiguous/);
      }
    } finally {
      rmSync(partRoot, { recursive: true, force: true });
    }
  });
});

describe("Agent Core Session Settings Records", () => {
  const text = (records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

  it("round-trips the last settings effort and rejects malformed values", () => {
    const good = session.replaySessionRecords(text([
      { storageSeq: 1, type: "message", message: { role: "user", content: "hi" } },
      { storageSeq: 2, type: "settings", effort: "low" },
      { storageSeq: 3, type: "settings", effort: "high" },
    ]));
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.effort).toBe("high");
      expect(good.messages).toHaveLength(1);
    }
    expect(session.replaySessionRecords(text([
      { storageSeq: 1, type: "settings" },
    ])).ok).toBe(false);
    expect(session.replaySessionRecords(text([
      { storageSeq: 1, type: "settings", effort: "" },
    ])).ok).toBe(false);
    expect(session.replaySessionRecords(text([
      { storageSeq: 1, type: "settings", effort: "x".repeat(65) },
    ])).ok).toBe(false);
    expect(session.replaySessionRecords(text([
      { storageSeq: 1, type: "settings", effort: 42 },
    ])).ok).toBe(false);
    expect(session.replaySessionRecords(text([
      { storageSeq: 1, type: "frobnicate" },
    ])).ok).toBe(false);
  });

  it("reports null effort when no settings record exists", () => {
    const replayed = session.replaySessionRecords(text([
      { storageSeq: 1, type: "message", message: { role: "user", content: "hi" } },
    ]));
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.effort).toBeNull();
  });

  it("survives a bundle round-trip with messages around it", async () => {
    const roundRoot = mkdtempSync(join(tmpdir(), "agent-core-session-settings-"));
    try {
      const roundFile = session.coreSessionFile(roundRoot, "round");
      mkdirSync(dirname(roundFile), { recursive: true, mode: 0o700 });
      writeFileSync(roundFile, text([
        { storageSeq: 1, type: "message", message: { role: "user", content: "hi" } },
        { storageSeq: 2, type: "settings", effort: "low" },
        { storageSeq: 3, type: "message", message: { role: "assistant", content: "hello" } },
      ]), { mode: 0o600 });
      const replayed = await session.replaySessionBundle(roundFile);
      expect(replayed.ok).toBe(true);
      if (replayed.ok) {
        expect(replayed.state.effort).toBe("low");
        expect(replayed.messages).toHaveLength(2);
      }
    } finally {
      rmSync(roundRoot, { recursive: true, force: true });
    }
  });

  it("rejects settings records that smuggle a message", () => {
    expect(session.replaySessionRecords(text([
      { storageSeq: 1, type: "settings", effort: "low", message: { role: "user", content: "x" } },
    ])).ok).toBe(false);
  });

  it("round-trips the last settings model and rejects a malformed pin", () => {
    const good = session.replaySessionRecords(text([
      { storageSeq: 1, type: "settings", effort: "low", model: "anthropic/claude-opus-4-6" },
      { storageSeq: 2, type: "settings", effort: "high", model: "openai/gpt-5.4" },
    ]));
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.effort).toBe("high");
      expect(good.model).toBe("openai/gpt-5.4");
    }
    const effortOnly = session.replaySessionRecords(text([
      { storageSeq: 1, type: "settings", effort: "low" },
    ]));
    expect(effortOnly.ok).toBe(true);
    if (effortOnly.ok) expect(effortOnly.model).toBeNull();
    expect(session.replaySessionRecords(text([
      { storageSeq: 1, type: "settings", effort: "low", model: "bare" },
    ])).ok).toBe(false);
    expect(session.replaySessionRecords(text([
      { storageSeq: 1, type: "settings", effort: "low", model: "trailing/" },
    ])).ok).toBe(false);
  });

  it("keeps the last model when a later settings record omits it", () => {
    const replayed = session.replaySessionRecords(text([
      { storageSeq: 1, type: "settings", effort: "low", model: "anthropic/claude-opus-4-6" },
      { storageSeq: 2, type: "settings", effort: "high" },
    ]));
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.effort).toBe("high");
      expect(replayed.model).toBe("anthropic/claude-opus-4-6");
    }
  });

  it("resume applies the replayed model and does not persist the startup route first", () => {
    const main = readFileSync(new URL("../../../agent-core/main.ts", import.meta.url), "utf8");
    const start = main.indexOf("async function resumeSessionBody");
    const end = main.indexOf("export type ResumeTestOverrides");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const resume = main.slice(start, end);
    expect(resume.includes("const savedModel = replayed.state.model;")).toBe(true);
    expect(resume.includes("persistRouteSettings")).toBe(false);
    expect(main.includes("...(isSessionModel(model) ? { model } : {})")).toBe(true);
  });
});
