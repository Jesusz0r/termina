/**
 * Focused contracts for the final main.ts review fixes.
 *
 *   node --experimental-strip-types --no-warnings scripts/agent-core-main-final-review-test.mjs
 */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = await import("../agent-core/main.ts");

assert.deepEqual(
  main.traceWriteDisposition({ ok: false, persisted: false, retryable: true }),
  { persisted: false, retry: true, terminal: false },
);
assert.deepEqual(
  main.traceWriteDisposition({ ok: false, persisted: true, retryable: true }),
  { persisted: true, retry: false, terminal: true },
);
assert.equal(main.isTerminalTraceAttemptStatus("error"), true);
assert.equal(main.isTerminalTraceAttemptStatus("interrupted"), true);
assert.equal(main.isTerminalTraceAttemptStatus("storage-error"), true);
assert.equal(main.isTerminalTraceAttemptStatus("retrying"), false);
assert.equal(main.isTerminalTraceAttemptStatus("fallback"), false);
assert.equal(main.isTerminalTraceAttemptStatus("overflow"), false);
assert.deepEqual(main.storageSeqRange(8, 8), null);
assert.deepEqual(main.storageSeqRange(8, 9), [9, 9]);
assert.deepEqual(main.storageSeqRange(8, 7), null);
assert.equal(typeof main.shutdownAgentCore, "function");
const firstShutdown = main.shutdownAgentCore({ reason: "final-review", timeoutMs: 1 });
assert.equal(firstShutdown, main.shutdownAgentCore({ reason: "final-review-repeat", timeoutMs: 1 }));
await firstShutdown;
const boundedBody = await main.readBoundedHttpBody(
  new Response("x".repeat(1024), { headers: { "content-type": "text/plain" } }),
  64,
);
assert.equal(boundedBody.truncated, true);
assert.ok(Buffer.byteLength(boundedBody.text, "utf8") <= 64);
const root = mkdtempSync(join(tmpdir(), "agent-core-main-final-review-"));

try {
  const unicodePath = join(root, "unicode.txt");
  const unicode = "😀é漢".repeat(20_000);
  writeFileSync(unicodePath, unicode);

  for (const result of [
    main.readTextView(unicodePath, { offset: 0 }),
    main.readTextView(unicodePath, { offset: 0, startLine: 1 }),
    main.readFileResult(unicodePath, 0),
  ]) {
    assert.equal(result.isError, false);
    assert.equal(result.state, "complete");
    assert.equal(result.truncated, true);
    assert.ok(!result.content.includes("\uFFFD"));
    const continuation = result.continuation ?? "";
    const offset = Number(continuation.match(/read_file offset (\d+)/)?.[1]);
    assert.equal(offset, 40 * 1024 - 1, "continuation must end on a complete UTF-8 boundary");
    assert.ok(offset < Buffer.byteLength(unicode));
  }

  const linePath = join(root, "lines.txt");
  writeFileSync(linePath, `${"😀é漢".repeat(20_000)}\nnext line\n`);
  const lineResult = main.readTextView(linePath, { offset: 0, startLine: 1, endLine: 1 });
  assert.equal(lineResult.isError, false);
  assert.equal(lineResult.state, "complete");
  assert.equal(lineResult.truncated, true);
  assert.ok(!lineResult.content.includes("\uFFFD"));
  assert.equal(Number(lineResult.continuation?.match(/read_file offset (\d+)/)?.[1]), 40 * 1024 - 1);

  writeFileSync(join(root, "scan-a.txt"), "a");
  writeFileSync(join(root, "scan-b.txt"), "b");
  const cappedScan = main.collectRelativeFiles(root, 1);
  assert.equal(cappedScan.state, "visit-cap");
  assert.equal(cappedScan.hitCap, true);
  assert.ok(Array.isArray(cappedScan.files));
  assert.deepEqual(cappedScan.files, Array.from(cappedScan));
  const timeoutScan = main.collectRelativeFiles(root, 100, { budgetMs: 0 });
  assert.equal(timeoutScan.state, "timeout");
  assert.equal(timeoutScan.timedOut, true);
  const interruptedScan = main.collectRelativeFiles(root, 100, { shouldStop: () => true });
  assert.equal(interruptedScan.state, "interrupted");
  const failedScan = main.collectRelativeFiles(root, 100, { shouldStop: () => { throw new Error("stop probe"); } });
  assert.equal(failedScan.state, "failed");
  const unreadableScan = main.collectRelativeFiles(join(root, "missing"), 100);
  assert.equal(unreadableScan.state, "unreadable");
  const partialMatches = main.listTaggedFiles(root, "", 50, { visitCap: 1 });
  assert.equal(partialMatches.state, "visit-cap");
  assert.equal(partialMatches.hitCap, true);

  const grepPath = join(root, "many-matches.txt");
  writeFileSync(grepPath, `${Array.from({ length: 60 }, (_, i) => `needle ${i}`).join("\n")}\n`);
  const grepResult = await main.grepFiles(root, { pattern: "needle", path: "many-matches.txt" }, { jsOnly: true });
  assert.equal(grepResult.state, "complete");
  assert.equal(grepResult.isError, false);
  assert.equal(grepResult.truncated, true);
  assert.match(grepResult.content, /grep hit cap/);
  assert.match(grepResult.continuation ?? "", /Grep again/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("agent-core main final-review contracts passed");
