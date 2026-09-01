import { describe, it, expect } from "vitest";
import * as reclaim from "../../../agent-core/reclaim.ts";
import * as session from "../../../agent-core/session.ts";

const {
  estimateReclaimTokens,
  makePruneRevision,
  planPruneStubs,
  recoveryPlan,
} = reclaim;
const { sessionBlockBytes, sessionBlockHash, validateSessionReclaimReceipt } = session;

describe("Agent Core Reclaim Contract", () => {
  const largeUnicode = `${"x".repeat(2_200)}${"é".repeat(48)}\nline two\n`;
  const sourceBlock = {
    type: "tool_result",
    tool_use_id: "tool-41",
    tool: "read_file",
    content: largeUnicode,
    chars: largeUnicode.length,
    repro: "read_file src/a.ts",
  };
  const sourceBytes = sessionBlockBytes(sourceBlock);
  const sourceHash = sessionBlockHash(sourceBlock);

  const messages = [
    { role: "assistant", sseq: 41, tokens: 3_500, content: [sourceBlock] },
    {
      role: "assistant",
      sseq: 42,
      tokens: 3_500,
      content: [{ type: "tool_result", tool: "grep", content: "y".repeat(2_400), repro: "grep 'needle' src" }],
    },
    { role: "user", sseq: 50, tokens: 100, content: "recent one" },
    { role: "user", sseq: 51, tokens: 100, content: "recent two" },
  ];

  const plannerOptions = {
    systemTokens: 100,
    toolSchemaTokens: 200,
    usable: 10_000,
    protectTokens: 0,
    fillTokens: 10_000,
  };

  it("exports frozen planner and computes deterministic estimates", () => {
    expect(typeof planPruneStubs).toBe("function");
    const first = estimateReclaimTokens(largeUnicode);
    expect(typeof first).toBe("number");
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(first).toBeGreaterThan(0);
    expect(first).toBe(estimateReclaimTokens(largeUnicode));
  });

  it("plans prune stubs with source-addressed oldest-first picks", () => {
    const plan = planPruneStubs(messages as any, plannerOptions);
    expect(plan.map((pick) => [pick.sseq, pick.blockIndex, pick.action])).toEqual([
      [41, 0, "stub"],
      [42, 0, "stub"],
    ]);

    const first = plan[0];
    expect(first?.original).toEqual({
      type: "tool_result",
      chars: sourceBlock.chars,
      bytes: sourceBytes,
      sha256: sourceHash,
    });
    expect(first?.fallback?.source).toBe("session-record");
    expect(first?.fallback?.tool).toBe("read_file");
    expect(first?.fallback?.repro).toBe("read_file src/a.ts");
    expect(first?.reclaimedTokens).toBeGreaterThan(0);
    expect(plan.every((pick) => pick.sseq < 50)).toBe(true);
    expect(planPruneStubs([...messages].reverse() as any, plannerOptions)).toEqual(plan);
  });

  it("includes tool-schema tokens in high-water decision", () => {
    const context = [
      { role: "assistant", sseq: 1, tokens: 7_100, content: [{ type: "tool_result", tool: "read_file", content: largeUnicode }] },
      { role: "user", sseq: 2, tokens: 100, content: "recent one" },
      { role: "user", sseq: 3, tokens: 100, content: "recent two" },
    ];
    const withSchema = planPruneStubs(context as any, { systemTokens: 100, toolSchemaTokens: 1_000, usable: 10_000, protectTokens: 0 });
    const withoutSchema = planPruneStubs(context as any, { systemTokens: 100, toolSchemaTokens: 0, usable: 10_000, protectTokens: 0 });
    expect(withSchema.length).toBeGreaterThan(0);
    expect(withoutSchema.length).toBe(0);
  });

  it("preserves original source block index", () => {
    const target = planPruneStubs([
      {
        role: "assistant",
        sseq: 60,
        tokens: 8_500,
        content: [{ type: "text", text: "keep" }, null, { ...sourceBlock }],
      },
      { role: "user", sseq: 61, tokens: 100, content: "recent one" },
      { role: "user", sseq: 62, tokens: 100, content: "recent two" },
    ] as any, { systemTokens: 0, usable: 10_000, protectTokens: 0 });
    expect(target[0]?.sseq).toBe(60);
    expect(target[0]?.blockIndex).toBe(2);
  });

  it("handles redacted_thinking as a droppable block", () => {
    const redacted = {
      type: "redacted_thinking",
      data: "opaque-".repeat(500),
      signature: "sig",
    };
    const redactedPlan = planPruneStubs([
      { role: "assistant", sseq: 70, tokens: 9_000, content: [redacted, { type: "text", text: "visible" }] },
      { role: "user", sseq: 71, tokens: 100, content: "recent one" },
      { role: "user", sseq: 72, tokens: 100, content: "recent two" },
    ] as any, { systemTokens: 0, usable: 10_000, protectTokens: 0 });
    expect(redactedPlan[0]?.action).toBe("drop");
    expect(redactedPlan[0]?.original).toEqual({
      type: "redacted_thinking",
      chars: JSON.stringify(redacted).length,
      bytes: sessionBlockBytes(redacted as any),
      sha256: sessionBlockHash(redacted as any),
    });
    expect(redactedPlan[0]?.fallback).toEqual({
      source: "session-record",
      tool: "redacted_thinking",
      repro: null,
    });
  });

  it("keeps multiple drop targets session-safe within one message", () => {
    const got = planPruneStubs([
      {
        role: "assistant",
        sseq: 73,
        tokens: 20_000,
        content: [
          { type: "thinking", thinking: "a".repeat(3_000) },
          { type: "thinking", thinking: "b".repeat(3_000) },
          { type: "text", text: "visible" },
        ],
      },
      { role: "user", sseq: 74, tokens: 100, content: "recent one" },
      { role: "user", sseq: 75, tokens: 100, content: "recent two" },
    ] as any, { systemTokens: 0, usable: 10_000, protectTokens: 0, fillTokens: 20_000 });
    expect(got.filter((pick) => pick.sseq === 73 && pick.action === "drop").length).toBe(1);
  });

  it("validates prune revision and applies durable revision to session replay", () => {
    const plan = planPruneStubs(messages as any, plannerOptions);
    const pick = plan[0]!;
    const revision = makePruneRevision("rev-7", [pick]);
    const receipt = revision.targets[0]!;

    expect(revision.type).toBe("revision");
    expect(revision.kind).toBe("prune");
    expect(revision.revisionId).toBe("rev-7");
    expect(revision.targets.length).toBe(1);

    const normalized = validateSessionReclaimReceipt(revision as any);
    expect(normalized.ok).toBe(true);
    expect(receipt.sseq).toBe(41);
    expect(receipt.blockIndex).toBe(0);
    expect(receipt.action).toBe("stub");
    expect(receipt.revisionId).toBe("rev-7");

    const state = session.createReplayState();
    expect(session.applySessionRecord(state, {
      storageSeq: 41,
      type: "message",
      message: { role: "assistant", content: [sourceBlock] },
    } as any)).toEqual({ ok: true });
    expect(session.applySessionRecord(state, { storageSeq: 42, ...revision } as any)).toEqual({ ok: true });
    expect(state.messages[0]?.content[0]?.stubbed).toBe(true);

    expect(recoveryPlan(receipt as any)).toEqual({
      source: "session-record",
      revisionId: "rev-7",
      sseq: 41,
      blockIndex: 0,
      expectedHash: sourceHash,
      expectedBytes: sourceBytes,
      tool: "read_file",
      repro: "read_file src/a.ts",
    });

    const forked = { ...receipt, sseq: 99, sourceSseq: 41 };
    expect(recoveryPlan(forked as any)?.sseq).toBe(41);
  });

  it("fails closed on malformed receipts, overflow, and invalid inputs", () => {
    expect(() => planPruneStubs(messages as any, null as any)).not.toThrow();
    expect(planPruneStubs(messages as any, null as any)).toEqual([]);
    expect(planPruneStubs([
      messages[0],
      { ...messages[1], sseq: messages[0]!.sseq },
      ...messages.slice(2),
    ] as any, plannerOptions)).toEqual([]);

    expect(planPruneStubs(messages as any, {
      systemTokens: Number.MAX_VALUE,
      usable: 10_000,
      protectTokens: 0,
      fillTokens: Number.MAX_VALUE,
    })).toEqual([]);

    const plan = planPruneStubs(messages as any, plannerOptions);
    const pick = plan[0]!;
    const revision = makePruneRevision("rev-7", [pick]);
    const receipt = revision.targets[0]!;

    expect(validateSessionReclaimReceipt({ ...revision, targets: [{ ...receipt, original: { ...receipt.original, sha256: "not-a-sha256" } }] } as any).ok).toBe(false);
    expect(validateSessionReclaimReceipt({ ...revision, targets: [{ ...receipt, sseq: 0 }] } as any).ok).toBe(false);
    expect(validateSessionReclaimReceipt({ ...revision, targets: [{ ...receipt, blockIndex: -1 }] } as any).ok).toBe(false);
    expect(validateSessionReclaimReceipt({ ...revision, targets: [{ ...receipt, action: "replace" }] } as any).ok).toBe(false);

    expect(() => makePruneRevision("rev-empty", [])).toThrow();
    expect(() => makePruneRevision("rev\n", [pick])).toThrow();
    expect(() => makePruneRevision("rev/bad", [pick])).toThrow();
    expect(() => makePruneRevision("rev-dup", [pick, pick])).toThrow();
    expect(() => makePruneRevision("rev-too-many", Array.from({ length: 257 }, (_, index) => ({ ...pick, sseq: index + 1 })))).toThrow();
  });
});
