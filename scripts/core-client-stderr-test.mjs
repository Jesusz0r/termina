/**
 * Regression test for core stderr flow control.
 *
 * Run with: node --experimental-strip-types --no-warnings scripts/core-client-stderr-test.mjs
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.TERMINA_CORE_BIN = resolve("scripts/core-client-stderr-shim.mjs");
const { coreClient } = await import(pathToFileURL(resolve("electron/core-client.ts")).href);

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not complete within 1,500ms`)), 1_500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  const flood = await within(coreClient.request({ op: "stderr-flood", marker: "success-tail" }), "stderr-flood request");
  assert.deepEqual(flood, { value: "drained" });
  console.log("PASS stderr larger than pipe capacity does not block a valid result");

  assert.deepEqual(
    await within(coreClient.request({ op: "success-late-stderr", marker: "same-child-late-warning" }), "success before late stderr"),
    { value: "late warning completed" },
  );
  await assert.rejects(
    within(coreClient.request({ op: "delayed-fail" }), "structured failure after same-child late stderr"),
    (error) => error instanceof Error && error.message.includes("fixture delayed rejected") && !error.message.includes("same-child-late-warning"),
  );
  console.log("PASS same-child late stderr is not attributed to a later structured failure");

  for (let i = 0; i < 4; i += 1) {
    const marker = `failure-tail-${i}`;
    await assert.rejects(
      within(coreClient.request({ op: "stderr-fail", marker }), `stderr-fail request ${i}`),
      (error) => error instanceof Error && error.message.includes("fixture rejected") && !error.message.includes(marker),
    );
  }
  assert.deepEqual(await within(coreClient.request({ op: "ok" }), "request after repeated failures"), { value: "later request completed" });
  console.log("PASS bounded stderr diagnostics preserve a later request after repeated failures");

  assert.deepEqual(
    await within(coreClient.request({ op: "stderr-warn-success", marker: "successful-warning" }), "warning request"),
    { value: "warning completed" },
  );
  await assert.rejects(
    within(coreClient.request({ op: "plain-fail" }), "plain failure after warning"),
    (error) => error instanceof Error && error.message.includes("fixture plain rejected") && !error.message.includes("successful-warning"),
  );
  console.log("PASS successful-request stderr is not reported by a later request");

  await assert.rejects(
    within(coreClient.request({ op: "stderr-exit", marker: "old-process-tail" }), "stderr-exit request"),
    (error) => error instanceof Error && error.message.includes("snapshot core exited") && error.message.includes("old-process-tail") && error.message.length <= 9 * 1024,
  );
  await assert.rejects(
    within(coreClient.request({ op: "stderr-fail", marker: "new-process-tail" }), "replacement stderr-fail request"),
    (error) => error instanceof Error && error.message.includes("fixture rejected") && !error.message.includes("new-process-tail") && !error.message.includes("old-process-tail"),
  );
  assert.deepEqual(await within(coreClient.request({ op: "ok" }), "request after process replacement"), { value: "later request completed" });
  console.log("PASS stderr tail resets when the core process is replaced");

  await assert.rejects(
    within(coreClient.request({ op: "protocol-fail", marker: "protocol-process-tail" }), "protocol failure"),
    (error) => error instanceof Error && error.message.includes("fixture protocol rejected") && error.message.includes("protocol-process-tail"),
  );
  assert.deepEqual(await within(coreClient.request({ op: "ok" }), "request after protocol failure"), { value: "later request completed" });
  console.log("PASS protocol failure includes bounded stderr and leaves the core usable");

  await assert.rejects(
    within(coreClient.request({ op: "late-inherited-stderr", marker: "old-inherited-tail" }), "late inherited stderr parent request"),
    (error) => error instanceof Error && error.message.includes("snapshot core exited"),
  );
  await assert.rejects(
    within(coreClient.request({ op: "delayed-exit" }), "replacement process failure with old inherited stderr"),
    (error) => error instanceof Error && error.message.includes("snapshot core exited") && !error.message.includes("old-inherited-tail"),
  );
  assert.deepEqual(await within(coreClient.request({ op: "ok" }), "request after old inherited stderr"), { value: "later request completed" });
  console.log("PASS old inherited stderr cannot corrupt a replacement core request");
} finally {
  coreClient.dispose();
}
