/**
 * Focused contract tests for the pure reclamation seam.
 *
 * `reclaim.ts` owns estimation, deterministic planning, and receipt/recovery
 * descriptions. `session.ts` remains the only owner of durable append,
 * replay, revision application, and fork materialization.
 *
 *   node --experimental-strip-types --no-warnings scripts/agent-core-reclaim-test.mjs
 */
import assert from "node:assert/strict";

const reclaim = await import("../agent-core/reclaim.ts");
const session = await import("../agent-core/session.ts");

const {
  estimateReclaimTokens,
  makePruneRevision,
  planPruneStubs,
  recoveryPlan,
} = reclaim;
const { sessionBlockBytes, sessionBlockHash, validateSessionReclaimReceipt } = session;

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
assert.equal(typeof sourceBytes, "number");
assert.equal(typeof sourceHash, "string");

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

check("pure reclamation exports the frozen planner", () => {
  assert.equal(typeof planPruneStubs, "function");
});

check("estimator is deterministic for UTF-8 content", () => {
  const first = estimateReclaimTokens(largeUnicode);
  assert.equal(typeof first, "number");
  assert.ok(Number.isSafeInteger(first));
  assert.ok(first > 0);
  assert.equal(first, estimateReclaimTokens(largeUnicode));
});

const plannerOptions = {
  systemTokens: 100,
  toolSchemaTokens: 200,
  usable: 10_000,
  protectTokens: 0,
  fillTokens: 10_000,
};
const plan = planPruneStubs(messages, plannerOptions);

check("planner returns source-addressed oldest-first picks", () => {
  assert.deepEqual(plan.map((pick) => [pick.sseq, pick.blockIndex, pick.action]), [
    [41, 0, "stub"],
    [42, 0, "stub"],
  ]);
});

check("planner hashes the exact stored block including metadata", () => {
  const first = plan[0];
  assert.deepEqual(first?.original, {
    type: "tool_result",
    chars: sourceBlock.chars,
    bytes: sourceBytes,
    sha256: sourceHash,
  });
  assert.equal(first?.fallback?.source, "session-record");
  assert.equal(first?.fallback?.tool, "read_file");
  assert.equal(first?.fallback?.repro, "read_file src/a.ts");
  assert.ok(first?.reclaimedTokens > 0);
});

check("planner protects the newest two user turns", () => {
  assert.ok(plan.every((pick) => pick.sseq < 50));
});

check("planner is independent of input discovery order", () => {
  assert.deepEqual(planPruneStubs([...messages].reverse(), plannerOptions), plan);
});

check("planner includes tool-schema tokens in the high-water decision", () => {
  const context = [
    { role: "assistant", sseq: 1, tokens: 7_100, content: [{ type: "tool_result", tool: "read_file", content: largeUnicode }] },
    { role: "user", sseq: 2, tokens: 100, content: "recent one" },
    { role: "user", sseq: 3, tokens: 100, content: "recent two" },
  ];
  const withSchema = planPruneStubs(context, { systemTokens: 100, toolSchemaTokens: 1_000, usable: 10_000, protectTokens: 0 });
  const withoutSchema = planPruneStubs(context, { systemTokens: 100, toolSchemaTokens: 0, usable: 10_000, protectTokens: 0 });
  assert.ok(withSchema.length > 0);
  assert.equal(withoutSchema.length, 0);
});

check("planner preserves the original source block index", () => {
  const target = planPruneStubs([
    {
      role: "assistant",
      sseq: 60,
      tokens: 8_500,
      content: [{ type: "text", text: "keep" }, null, { ...sourceBlock }],
    },
    { role: "user", sseq: 61, tokens: 100, content: "recent one" },
    { role: "user", sseq: 62, tokens: 100, content: "recent two" },
  ], { systemTokens: 0, usable: 10_000, protectTokens: 0 });
  assert.equal(target[0]?.sseq, 60);
  assert.equal(target[0]?.blockIndex, 2);
});

check("planner handles redacted_thinking data as a droppable block", () => {
  const redacted = {
    type: "redacted_thinking",
    data: "opaque-".repeat(500),
    signature: "sig",
  };
  const redactedPlan = planPruneStubs([
    { role: "assistant", sseq: 70, tokens: 9_000, content: [redacted, { type: "text", text: "visible" }] },
    { role: "user", sseq: 71, tokens: 100, content: "recent one" },
    { role: "user", sseq: 72, tokens: 100, content: "recent two" },
  ], { systemTokens: 0, usable: 10_000, protectTokens: 0 });
  assert.equal(redactedPlan[0]?.action, "drop");
  assert.deepEqual(redactedPlan[0]?.original, {
    type: "redacted_thinking",
    chars: JSON.stringify(redacted).length,
    bytes: sessionBlockBytes(redacted),
    sha256: sessionBlockHash(redacted),
  });
  assert.deepEqual(redactedPlan[0]?.fallback, {
    source: "session-record",
    tool: "redacted_thinking",
    repro: null,
  });
});

check("planner keeps multiple drop targets in one message session-safe", () => {
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
  ], { systemTokens: 0, usable: 10_000, protectTokens: 0, fillTokens: 20_000 });
  assert.equal(got.filter((pick) => pick.sseq === 73 && pick.action === "drop").length, 1);
});

check("receipt validation rejects block-index shifts within one message", () => {
  const first = { type: "thinking", thinking: "a".repeat(3_000) };
  const second = { type: "thinking", thinking: "b".repeat(3_000) };
  const makePick = (block, blockIndex) => ({
    sseq: 76,
    blockIndex,
    action: "drop",
    original: {
      type: "thinking",
      chars: block.thinking.length,
      bytes: sessionBlockBytes(block),
      sha256: sessionBlockHash(block),
    },
    reclaimedTokens: 1,
    fallback: { source: "session-record", tool: "thinking", repro: null },
  });
  const firstPick = makePick(first, 0);
  const secondPick = makePick(second, 1);
  const raw = makePruneRevision("rev-shift", [firstPick]);
  assert.equal(validateSessionReclaimReceipt({ revisionId: "rev-shift", targets: [
    raw.targets[0],
    { ...raw.targets[0], blockIndex: 1, original: secondPick.original },
  ] }).ok, false);
  const shiftedStub = {
    ...raw.targets[0],
    blockIndex: 2,
    action: "stub",
    original: {
      type: sourceBlock.type,
      chars: sourceBlock.chars,
      bytes: sourceBytes,
      sha256: sourceHash,
    },
    tool: sourceBlock.tool,
    repro: sourceBlock.repro,
    recovery: { source: "session-record", tool: sourceBlock.tool, repro: sourceBlock.repro },
  };
  const shiftedDrop = { ...raw.targets[0], blockIndex: 1, original: secondPick.original };
  assert.equal(validateSessionReclaimReceipt({ revisionId: "rev-shift", targets: [shiftedStub, shiftedDrop] }).ok, false);
  assert.throws(() => makePruneRevision("rev-shift", [firstPick, secondPick]));
});

check("planner and validation fail closed for null options and duplicate source sequences", () => {
  assert.doesNotThrow(() => planPruneStubs(messages, null));
  assert.deepEqual(planPruneStubs(messages, null), []);
  assert.deepEqual(planPruneStubs([
    messages[0],
    { ...messages[1], sseq: messages[0].sseq },
    ...messages.slice(2),
  ], plannerOptions), []);
});

check("planner fails closed when token totals overflow", () => {
  assert.deepEqual(planPruneStubs(messages, {
    systemTokens: Number.MAX_VALUE,
    usable: 10_000,
    protectTokens: 0,
    fillTokens: Number.MAX_VALUE,
  }), []);
});

const pick = plan[0];
const revision = makePruneRevision("rev-7", [pick]);
const receipt = revision.targets[0];

check("revision emits the session-compatible prune target envelope", () => {
  assert.equal(revision.type, "revision");
  assert.equal(revision.kind, "prune");
  assert.equal(revision.revisionId, "rev-7");
  assert.equal(revision.targets.length, 1);
  const normalized = validateSessionReclaimReceipt(revision);
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.receipt, {
    revisionId: revision.revisionId,
    targets: revision.targets,
  });
  assert.equal(receipt?.sseq, 41);
  assert.equal(receipt?.blockIndex, 0);
  assert.equal(receipt?.action, "stub");
  assert.equal(receipt?.revisionId, "rev-7");
});

check("session replay accepts and applies the durable revision envelope", () => {
  const state = session.createReplayState();
  assert.deepEqual(session.applySessionRecord(state, {
    storageSeq: 41,
    type: "message",
    message: { role: "assistant", content: [sourceBlock] },
  }), { ok: true });
  assert.deepEqual(session.applySessionRecord(state, { storageSeq: 42, ...revision }), { ok: true });
  assert.equal(state.messages[0]?.content[0]?.stubbed, true);
});

check("session receipt validation accepts the session-compatible envelope", () => {
  assert.equal(validateSessionReclaimReceipt(revision).ok, true);
});

check("recoveryPlan maps a valid receipt target to a source-record request", () => {
  assert.deepEqual(recoveryPlan(receipt), {
    source: "session-record",
    revisionId: "rev-7",
    sseq: 41,
    blockIndex: 0,
    expectedHash: sourceHash,
    expectedBytes: sourceBytes,
    tool: "read_file",
    repro: "read_file src/a.ts",
  });
});

check("recoveryPlan follows the source sequence after fork remapping", () => {
  const forked = { ...receipt, sseq: 99, sourceSseq: 41 };
  assert.equal(recoveryPlan(forked)?.sseq, 41);
});

check("receipt validation fails closed for malformed hashes and addresses", () => {
  assert.equal(validateSessionReclaimReceipt({ ...revision, targets: [{ ...receipt, original: { ...receipt.original, sha256: "not-a-sha256" } }] }).ok, false);
  assert.equal(validateSessionReclaimReceipt({ ...revision, targets: [{ ...receipt, sseq: 0 }] }).ok, false);
  assert.equal(validateSessionReclaimReceipt({ ...revision, targets: [{ ...receipt, blockIndex: -1 }] }).ok, false);
  assert.equal(validateSessionReclaimReceipt({ ...revision, targets: [{ ...receipt, action: "replace" }] }).ok, false);
  assert.equal(validateSessionReclaimReceipt({
    ...revision,
    targets: [
      { ...receipt, sourceSseq: 41 },
      { ...receipt, sseq: 99, sourceSseq: 41 },
    ],
  }).ok, false);
});

check("planner rejects overlong or unsafe recovery text instead of creating a mismatched stub", () => {
  const oversizedRepro = { ...sourceBlock, repro: "x".repeat(4_097) };
  const unsafeRepro = { ...sourceBlock, repro: "read_file src/a.ts\nleak" };
  for (const block of [oversizedRepro, unsafeRepro]) {
    const got = planPruneStubs([
      { role: "assistant", sseq: 80, tokens: 9_000, content: [block] },
      { role: "user", sseq: 81, tokens: 100, content: "recent one" },
      { role: "user", sseq: 82, tokens: 100, content: "recent two" },
    ], { systemTokens: 0, usable: 10_000, protectTokens: 0 });
    assert.deepEqual(got, []);
  }
});

check("revision rejects empty, duplicate, overlong, and invalid-id inputs", () => {
  assert.throws(() => makePruneRevision("rev-empty", []));
  assert.throws(() => makePruneRevision("rev\n", [pick]));
  assert.throws(() => makePruneRevision("rev/bad", [pick]));
  assert.throws(() => makePruneRevision("rev-dup", [pick, pick]));
  assert.throws(() => makePruneRevision("rev-too-many", Array.from({ length: 257 }, (_, index) => ({ ...pick, sseq: index + 1 }))));
});

check("revision target metadata is deterministic", () => {
  const second = plan[1];
  const got = makePruneRevision("rev-order", [second, pick]);
  assert.deepEqual(got.targets.map((target) => target.sseq), [41, 42]);
  const normalized = validateSessionReclaimReceipt(got);
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.receipt, {
    revisionId: got.revisionId,
    targets: got.targets,
  });
});

if (failures.length > 0) {
  console.error(`\n${failures.length} reclaim contract test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nagent-core reclaim contract tests passed");
}
