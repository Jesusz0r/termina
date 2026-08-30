/**
 * Focused integration contracts for Stage 3A main wiring.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings scripts/agent-core-main-stage3-test.mjs
 */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = await import("../agent-core/main.ts");

const root = mkdtempSync(join(tmpdir(), "agent-core-main-stage3-"));
try {
  for (let i = 1; i <= 201; i += 1) writeFileSync(join(root, `match-${String(i).padStart(3, "0")}.txt`), `${i}\n`);
  writeFileSync(join(root, "unicode.txt"), "prefix-é-😀-suffix");

  const underCap = await main.globFiles(root, "match-*.txt");
  assert.equal(underCap.state, "complete");
  assert.equal(underCap.content.split("\n").filter((line) => /^match-/.test(line)).length, 200);
  assert.match(underCap.content, /more matching files/);
  assert.equal(underCap.truncated, true);

  for (const count of [199, 200]) {
    const prefix = `exact-${count}`;
    for (let i = 1; i <= count; i += 1) writeFileSync(join(root, `${prefix}-${String(i).padStart(3, "0")}.txt`), `${i}\n`);
    const exact = await main.globFiles(root, `${prefix}-*.txt`);
    assert.equal(exact.state, "complete");
    assert.equal(exact.content.split("\n").filter((line) => line.startsWith(`${prefix}-`)).length, count);
    assert.equal(exact.truncated, false);
    assert.doesNotMatch(exact.content, /more matching files/);
  }

  const read = main.readTextView(join(root, "unicode.txt"), { offset: 0 });
  assert.equal(read.isError, false);
  assert.equal(read.state, "complete");
  assert.match(read.content, /prefix-é-😀-suffix/);
  assert.ok(!read.content.includes("\uFFFD"));

  const stopped = await main.collectFiles(root, root, 2_000, { shouldStop: () => true });
  assert.equal(stopped.state, "interrupted");
  const visitCapped = await main.collectFiles(root, root, 1);
  assert.equal(visitCapped.state, "visit-cap");
  const timedOut = await main.collectFiles(root, root, 2_000, { budgetMs: 0 });
  assert.equal(timedOut.state, "timeout");
  const failedWalk = await main.collectFiles(root, root, 2_000, {
    shouldStop: () => { throw new Error("stop callback failed"); },
  });
  assert.equal(failedWalk.state, "failed");

  for (let i = 1; i <= 9; i += 1) writeFileSync(join(root, `tag-${i}.txt`), `tag-${i}`);
  const tagged = main.expandFileTags(root, Array.from({ length: 9 }, (_, i) => `@tag-${i + 1}.txt`).join(" "));
  assert.match(tagged, /attachments omitted/);

  writeFileSync(join(root, "long-unicode.txt"), "😀é漢".repeat(30_000));
  const longRead = main.readTextView(join(root, "long-unicode.txt"), { offset: 0 });
  assert.equal(longRead.isError, false);
  assert.ok(longRead.truncated);
  assert.ok(!longRead.content.includes("\uFFFD"));

  writeFileSync(join(root, "long-line.txt"), `${"é😀".repeat(10_000)}\n`);
  const jsGrep = await main.grepFiles(root, { pattern: "😀", path: "long-line.txt" }, { jsOnly: true });
  assert.equal(jsGrep.truncated, true);
  assert.match(jsGrep.content, /truncated|Grep again/);
  assert.ok(!jsGrep.content.includes("\uFFFD"));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("prefix-é-"));
      controller.enqueue(new TextEncoder().encode("😀-suffix"));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/plain" } });
  try {
    const fetched = await main.fetchUrl("https://example.com/data");
    assert.equal(fetched.state, "complete");
    assert.equal(fetched.content, "prefix-é-😀-suffix");
    assert.ok(!fetched.content.includes("\uFFFD"));
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async (_url, init = {}) => {
    const signal = init.signal;
    return await new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  };
  try {
    const failedFetch = await main.fetchUrl("https://example.com/stop-callback", {
      timeoutMs: 200,
      shouldStop: () => { throw new Error("stop callback failed"); },
    });
    assert.equal(failedFetch.state, "failed");
    assert.equal(failedFetch.isError, true);
    assert.match(failedFetch.content, /stop callback failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const processResult = await main.runBash("printf out; printf err >&2; exit 7", { cwd: root });
  assert.equal(processResult.exitCode, 7);
  assert.equal(processResult.isError, true);
  assert.equal(processResult.stdout.text, "out");
  assert.equal(processResult.stderr.text, "err");
  assert.match(processResult.content, /\[exit 7\]/);

  const noisy = await main.runBash(
    `${process.execPath} -e 'process.stdout.write("😀".repeat(30000)); process.stderr.write("é".repeat(30000))'`,
    { cwd: root },
  );
  assert.equal(noisy.isError, false);
  assert.equal(noisy.stdout.truncated, true);
  assert.equal(noisy.stderr.truncated, true);
  assert.ok(!noisy.stdout.text.includes("\uFFFD"));
  assert.ok(!noisy.stderr.text.includes("\uFFFD"));

  const timedBash = await main.runBash("sleep 8", { cwd: root, timeoutMs: 20 });
  assert.equal(timedBash.state, "timeout");
  let stopBash = false;
  const stoppedBash = main.runBash("sleep 8", { cwd: root, timeoutMs: 20_000, shouldStop: () => stopBash });
  setTimeout(() => { stopBash = true; }, 20);
  const stoppedBashResult = await stoppedBash;
  assert.equal(stoppedBashResult.state, "interrupted");

  assert.equal(main.planPruneStubs, undefined);
  assert.equal(main.tokenEstimate, undefined);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("agent-core main Stage 3 integration contracts passed");
