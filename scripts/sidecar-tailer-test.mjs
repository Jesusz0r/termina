import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "termina-sidecar-test-"));
const eventsDir = join(root, "events");
const bundle = join(root, "sidecar.mjs");
await build({ entryPoints: ["electron/sidecar.ts"], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });
const { mkdir, writeFile } = await import("node:fs/promises");
await mkdir(eventsDir);
await writeFile(join(eventsDir, "term-1.jsonl"), "");

const { SidecarTailer } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);
const tailer = new SidecarTailer(eventsDir, () => Object.assign(new EventEmitter(), { close() {} }));
const received = [];
tailer.onEvent = (_id, event) => received.push(event);
tailer.start();
tailer.watch("term-1");

const append = (...records) => appendFile(join(eventsDir, "term-1.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
const waitFor = async (count) => {
  const deadline = Date.now() + 3000;
  while (received.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.length, count);
};

try {
  await append(
    { bridgeId: "active", seq: 1, t: "session_ready", ok: true },
    { bridgeId: "active", seq: 2, t: "preflight_request", requestId: "first" },
    { bridgeId: "foreign", seq: 1, t: "trace_startup" },
    { bridgeId: "active", seq: 3, t: "checkpoint_request", requestId: "checkpoint" },
    { bridgeId: "foreign", seq: 2, t: "shutdown_result" },
    { bridgeId: "active", seq: 4, t: "preflight_request", requestId: "after-foreign" },
  );
  await waitFor(4);
  assert.deepEqual(received.map((event) => event.bridgeId), ["active", "active", "active", "active"]);
  assert.equal(received.at(-1).requestId, "after-foreign");

  await append(
    { bridgeId: "replacement", seq: 1, t: "session_ready", ok: true },
    { bridgeId: "active", seq: 5, t: "preflight_request", requestId: "stale" },
    { bridgeId: "replacement", seq: 2, t: "preflight_request", requestId: "replacement" },
  );
  await waitFor(6);
  assert.deepEqual(received.slice(-2).map((event) => [event.bridgeId, event.t]), [
    ["replacement", "session_ready"],
    ["replacement", "preflight_request"],
  ]);
  assert.equal(received.at(-1).requestId, "replacement");
  console.log("sidecar tailer stream ownership contract passed");
} finally {
  tailer.stop();
  await rm(root, { recursive: true, force: true });
}
