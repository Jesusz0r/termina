import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.TERMINA_CORE_BIN = resolve("scripts/core-client-admission-shim.mjs");
const {
  coreClient,
  CORE_REQUEST_QUEUE_HIGH_WATER_ITEMS,
} = await import(pathToFileURL(resolve("electron/core-client.ts")).href);

try {
  const requests = [];
  const total = CORE_REQUEST_QUEUE_HIGH_WATER_ITEMS + 1;
  for (let i = 0; i < total; i += 1) {
    requests.push(coreClient.request({ op: "delayed", value: i }));
  }
  const settled = await Promise.allSettled(requests);
  const rejected = settled.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 1, "only the request beyond the bounded queue is rejected");
  assert.match(rejected[0].reason.message, /queue|backpressure|high.?water/i);
  const values = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value.value);
  assert.deepEqual(values, Array.from({ length: total - 1 }, (_, i) => i), "accepted request responses retain FIFO matching");
  assert.equal(coreClient.queueStats().items, 0);
  assert.equal(coreClient.queueStats().bytes, 0);

  const shuttingDown = [
    coreClient.request({ op: "delayed", value: "shutdown-in-flight" }),
    coreClient.request({ op: "delayed", value: "shutdown-queued" }),
  ];
  setImmediate(() => coreClient.dispose());
  const shutdownResults = await Promise.allSettled(shuttingDown);
  assert.ok(shutdownResults.every((result) => result.status === "rejected"), "shutdown rejects both in-flight and queued work");
  assert.equal(coreClient.queueStats().items, 0);
  assert.equal(coreClient.queueStats().bytes, 0);
  console.log("core bounded-admission checks passed");
} finally {
  coreClient.dispose();
}
