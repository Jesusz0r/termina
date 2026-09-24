import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as reclaim from "../../../agent-core/reclaim.ts";
import * as session from "../../../agent-core/session.ts";

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

function hashBlock(block: unknown): string {
  return createHash("sha256").update(JSON.stringify(block), "utf8").digest("hex");
}

function dropTarget(
  sseq: number,
  blockIndex: number,
  block: Record<string, unknown>,
  revisionId: string,
): Record<string, unknown> {
  const thinking = typeof block.thinking === "string" ? block.thinking : "";
  return {
    sseq,
    blockIndex,
    action: "drop",
    original: {
      type: "thinking",
      chars: thinking.length,
      bytes: Buffer.byteLength(JSON.stringify(block), "utf8"),
      sha256: hashBlock(block),
    },
    reclaimedTokens: 8,
    revisionId,
    recovery: { source: "session-record", tool: "reasoning", repro: null },
  };
}

function seedBundle(records: unknown[]): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-core-reclaim-recovery-"));
  const sessionFile = session.coreSessionFile(root, "reclaim-recovery");
  mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile, records.map(line).join(""), { mode: 0o600 });
  return { root, sessionFile };
}

describe("successive reclaim recovery (#162)", () => {
  const payload = "é🙂".repeat(1500);
  for (const block of [
    { type: "tool_result", content: payload, tool: "read_file" },
    { type: "tool_result", content: [{ type: "text", text: payload }], chars: 5000, tool: "read_file" },
    { type: "thinking", thinking: payload },
    { type: "thinking", thinking: null, data: payload },
    { type: "redacted_thinking", data: payload },
  ]) {
    it(`round-trips receipt measurement for ${block.type} (${Object.keys(block).join(", ")})`, async () => {
      const messages = [
        { role: "assistant", sseq: 1, content: [block, { type: "text", text: "visible" }] },
        { role: "user", sseq: 2, content: "recent one" },
        { role: "user", sseq: 3, content: "recent two" },
      ];
      const picks = reclaim.planPruneStubs(messages, { systemTokens: 8192, usable: 1024, protectTokens: 0 });
      expect(picks).toHaveLength(1);
      const revision = reclaim.makePruneRevision("rev-measure", picks);
      const { root, sessionFile } = seedBundle([
        ...messages.map(({ sseq, ...message }) => ({ storageSeq: sseq, type: "message", message })),
        { storageSeq: 4, ...revision },
      ]);
      try {
        const replayed = await session.replaySessionBundle(sessionFile);
        expect(replayed.ok).toBe(true);
        const recovered = await session.recoverSessionBlock(sessionFile, {
          revisionId: "rev-measure", sseq: 1, blockIndex: 0,
        });
        expect(recovered.ok).toBe(true);
        if (recovered.ok) expect(recovered.block).toEqual(block);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("recovers planner-generated drops that reuse a shifted index", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-core-reclaim-planner-"));
    try {
      const thinkingA = { type: "thinking", thinking: `A${"a".repeat(4095)}` };
      const thinkingB = { type: "thinking", thinking: `B${"b".repeat(4095)}` };
      const visible = { type: "text", text: "visible" };
      const sessionFile = session.coreSessionFile(root, "planner");
      mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
      const records: unknown[] = [
        { storageSeq: 1, type: "message", message: { role: "assistant", content: [thinkingA, thinkingB, visible] } },
        { storageSeq: 2, type: "message", message: { role: "user", content: "one" } },
        { storageSeq: 3, type: "message", message: { role: "user", content: "two" } },
        { storageSeq: 4, type: "message", message: { role: "user", content: "three" } },
        { storageSeq: 5, type: "message", message: { role: "user", content: "four" } },
      ];
      writeFileSync(sessionFile, records.map(line).join(""), { mode: 0o600 });

      // Two planner rounds against the evolving view, exactly like the agent.
      const firstReplay = await session.replaySessionBundle(sessionFile);
      expect(firstReplay.ok).toBe(true);
      if (!firstReplay.ok) throw new Error(firstReplay.error);
      const firstView = firstReplay.messages.map((m) => ({ role: m.role, sseq: m.sseq, content: m.content }));
      const firstPicks = reclaim.planPruneStubs(firstView as never, { systemTokens: 8192, usable: 1024, protectTokens: 0 });
      expect(firstPicks.map((p) => [p.sseq, p.blockIndex, p.action])).toContainEqual([1, 0, "drop"]);
      const firstRevision = reclaim.makePruneRevision("rev-first", firstPicks.filter((p) => p.sseq === 1 && p.blockIndex === 0));
      records.push({ storageSeq: 6, type: "revision", kind: "prune", revisionId: "rev-first", targets: firstRevision.targets });
      writeFileSync(sessionFile, records.map(line).join(""), { mode: 0o600 });

      const secondReplay = await session.replaySessionBundle(sessionFile);
      expect(secondReplay.ok).toBe(true);
      if (!secondReplay.ok) throw new Error(secondReplay.error);
      const secondView = secondReplay.messages.map((m) => ({ role: m.role, sseq: m.sseq, content: m.content }));
      const secondPicks = reclaim.planPruneStubs(secondView as never, { systemTokens: 8192, usable: 1024, protectTokens: 0 });
      expect(secondPicks.map((p) => [p.sseq, p.blockIndex, p.action])).toContainEqual([1, 0, "drop"]);
      const secondRevision = reclaim.makePruneRevision("rev-second", secondPicks.filter((p) => p.sseq === 1 && p.blockIndex === 0));
      records.push({ storageSeq: 7, type: "revision", kind: "prune", revisionId: "rev-second", targets: secondRevision.targets });
      writeFileSync(sessionFile, records.map(line).join(""), { mode: 0o600 });

      const replayed = await session.replaySessionBundle(sessionFile);
      expect(replayed.ok).toBe(true);
      if (!replayed.ok) throw new Error(replayed.error);
      expect(replayed.messages[0]!.content).toEqual([visible]);

      const firstRecovery = await session.recoverSessionBlock(sessionFile, { revisionId: "rev-first", sseq: 1, blockIndex: 0 });
      expect(firstRecovery.ok).toBe(true);
      if (firstRecovery.ok) expect(firstRecovery.block).toEqual(thinkingA);
      const secondRecovery = await session.recoverSessionBlock(sessionFile, { revisionId: "rev-second", sseq: 1, blockIndex: 0 });
      expect(secondRecovery.ok).toBe(true);
      if (secondRecovery.ok) expect(secondRecovery.block).toEqual(thinkingB);

      const forkFile = session.coreSessionFile(root, "planner-fork");
      const forked = await session.writeForkedSession(sessionFile, forkFile, 7);
      expect(forked.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves nonzero shifted indexes across three drops", async () => {
    const text = { type: "text", text: "visible" };
    const thinkingA = { type: "thinking", thinking: "aaa" };
    const thinkingB = { type: "thinking", thinking: "bbb" };
    const thinkingC = { type: "thinking", thinking: "ccc" };
    const { root, sessionFile } = seedBundle([
      { storageSeq: 1, type: "message", message: { role: "assistant", content: [text, thinkingA, thinkingB, thinkingC] } },
      { storageSeq: 2, type: "revision", kind: "prune", revisionId: "rev-1", targets: [dropTarget(1, 1, thinkingA, "rev-1")] },
      { storageSeq: 3, type: "revision", kind: "prune", revisionId: "rev-2", targets: [dropTarget(1, 1, thinkingB, "rev-2")] },
      { storageSeq: 4, type: "revision", kind: "prune", revisionId: "rev-3", targets: [dropTarget(1, 1, thinkingC, "rev-3")] },
    ]);
    try {
      const replayed = await session.replaySessionBundle(sessionFile);
      expect(replayed.ok).toBe(true);
      for (const [revisionId, expected] of [["rev-1", thinkingA], ["rev-2", thinkingB], ["rev-3", thinkingC]] as const) {
        const recovered = await session.recoverSessionBlock(sessionFile, { revisionId, sseq: 1, blockIndex: 1 });
        expect(recovered.ok).toBe(true);
        if (recovered.ok) expect(recovered.block).toEqual(expected);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers across an intervening stub revision", async () => {
    const thinkingA = { type: "thinking", thinking: "aaa" };
    const thinkingB = { type: "thinking", thinking: "bbb" };
    const visible = { type: "text", text: "visible" };
    const toolBlock = { type: "tool_result", tool_use_id: "call-1", content: "tool output here" };
    const toolText = toolBlock.content as string;
    const stubTarget = {
      sseq: 2,
      blockIndex: 0,
      action: "stub",
      original: {
        type: "tool_result",
        chars: toolText.length,
        bytes: Buffer.byteLength(JSON.stringify(toolBlock), "utf8"),
        sha256: hashBlock(toolBlock),
      },
      reclaimedTokens: 4,
      revisionId: "rev-stub",
      recovery: { source: "session-record", tool: "bash", repro: "bash 'make check'" },
    };
    const { root, sessionFile } = seedBundle([
      { storageSeq: 1, type: "message", message: { role: "assistant", content: [thinkingA, thinkingB, visible] } },
      { storageSeq: 2, type: "message", message: { role: "user", content: [toolBlock] } },
      { storageSeq: 3, type: "revision", kind: "prune", revisionId: "rev-drop-a", targets: [dropTarget(1, 0, thinkingA, "rev-drop-a")] },
      { storageSeq: 4, type: "revision", kind: "prune", revisionId: "rev-stub", targets: [stubTarget] },
      { storageSeq: 5, type: "revision", kind: "prune", revisionId: "rev-drop-b", targets: [dropTarget(1, 0, thinkingB, "rev-drop-b")] },
    ]);
    try {
      const replayed = await session.replaySessionBundle(sessionFile);
      expect(replayed.ok).toBe(true);
      const first = await session.recoverSessionBlock(sessionFile, { revisionId: "rev-drop-a", sseq: 1, blockIndex: 0 });
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.block).toEqual(thinkingA);
      const second = await session.recoverSessionBlock(sessionFile, { revisionId: "rev-drop-b", sseq: 1, blockIndex: 0 });
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.block).toEqual(thinkingB);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers dense child and grandchild receipts after forks", async () => {
    const thinkingA = { type: "thinking", thinking: "aaa" };
    const thinkingB = { type: "thinking", thinking: "bbb" };
    const visible = { type: "text", text: "visible" };
    const root = mkdtempSync(join(tmpdir(), "agent-core-reclaim-fork-"));
    try {
      const source = session.coreSessionFile(root, "fork-source");
      mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
      writeFileSync(
        source,
        [
          line({ storageSeq: 1, type: "message", message: { role: "assistant", content: [thinkingA, thinkingB, visible] } }),
          line({ storageSeq: 2, type: "revision", kind: "prune", revisionId: "rev-a", targets: [dropTarget(1, 0, thinkingA, "rev-a")] }),
          line({ storageSeq: 3, type: "revision", kind: "prune", revisionId: "rev-b", targets: [dropTarget(1, 0, thinkingB, "rev-b")] }),
        ].join(""),
        { mode: 0o600 },
      );
      const child = session.coreSessionFile(root, "fork-child");
      expect((await session.writeForkedSession(source, child, 3)).ok).toBe(true);
      // Child receipts address dense child sequences; recovery maps them back.
      const childReplay = await session.replaySessionBundle(child);
      expect(childReplay.ok).toBe(true);
      for (const [revisionId, expected] of [["rev-a", thinkingA], ["rev-b", thinkingB]] as const) {
        const recovered = await session.recoverSessionBlock(child, { revisionId, sseq: 1, blockIndex: 0 });
        expect(recovered.ok).toBe(true);
        if (recovered.ok) expect(recovered.block).toEqual(expected);
      }
      const grandchild = session.coreSessionFile(root, "fork-grandchild");
      expect((await session.writeForkedSession(child, grandchild, 3)).ok).toBe(true);
      for (const [revisionId, expected] of [["rev-a", thinkingA], ["rev-b", thinkingB]] as const) {
        const recovered = await session.recoverSessionBlock(grandchild, { revisionId, sseq: 1, blockIndex: 0 });
        expect(recovered.ok).toBe(true);
        if (recovered.ok) expect(recovered.block).toEqual(expected);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still rejects tampered receipts with a hash mismatch", async () => {
    const thinkingA = { type: "thinking", thinking: "aaa" };
    const visible = { type: "text", text: "visible" };
    const tampered = dropTarget(1, 0, thinkingA, "rev-tampered") as { original: { sha256: string } };
    tampered.original.sha256 = hashBlock({ type: "thinking", thinking: "zzz" });
    const { root, sessionFile } = seedBundle([
      { storageSeq: 1, type: "message", message: { role: "assistant", content: [thinkingA, visible] } },
      { storageSeq: 2, type: "revision", kind: "prune", revisionId: "rev-tampered", targets: [tampered] },
    ]);
    try {
      // Replay itself refuses the tampered receipt before recovery runs.
      const replayed = await session.replaySessionBundle(sessionFile);
      expect(replayed.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
