import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "termina-sidecar-backpressure-"));
const eventsDir = join(root, "events");
const bundle = join(root, "sidecar.mjs");
await build({ entryPoints: ["electron/sidecar.ts"], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });
await mkdir(eventsDir);
const file = join(eventsDir, "term-1.jsonl");
await writeFile(file, "");

const {
  SidecarEventQueue,
  SidecarTailer,
} = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);

const fakeWatch = () => ({ close() {} });

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

try {
  const first = deferred();
  const delivered = [];
  const queue = new SidecarEventQueue(
    async (event) => {
      if (event.seq === 1) await first.promise;
      delivered.push(event);
    },
    { maxItems: 3, maxBytes: 16 * 1024 },
  );
  const boundary = (seq) => ({ bridgeId: "bridge", seq, t: "agent_start", sessionId: String(seq) });
  const plan = (seq, text) => ({ bridgeId: "bridge", seq, t: "plan", text });

  assert.equal(queue.enqueue(boundary(1)), true);
  assert.equal(queue.enqueue(plan(2, "old")), true);
  assert.equal(queue.enqueue(plan(3, "latest")), true, "adjacent progress coalesces");
  assert.equal(queue.enqueue(boundary(4)), true);
  assert.equal(queue.enqueue(boundary(5)), false, "state boundaries apply item high-water backpressure");
  assert.equal(queue.stats().items, 3);
  assert.equal(queue.stats().bytes > 0, true);

  first.resolve();
  await queue.drain();
  assert.deepEqual(delivered.map((event) => [event.t, event.seq, event.text]), [
    ["agent_start", 1, undefined],
    ["plan", 3, "latest"],
    ["agent_start", 4, undefined],
  ]);

  const adjacentKinds = [];
  const kindQueue = new SidecarEventQueue(async (event) => adjacentKinds.push(event.t), { maxItems: 4, maxBytes: 16 * 1024 });
  assert.equal(kindQueue.enqueue(plan(9, "plan")), true);
  assert.equal(kindQueue.enqueue({ bridgeId: "bridge", seq: 10, t: "agent_settings", model: "model" }), true, "different replaceable kinds retain their own state");
  await kindQueue.drain();
  assert.deepEqual(adjacentKinds, ["plan", "agent_settings"]);

  const byteQueue = new SidecarEventQueue(async () => {}, { maxItems: 4, maxBytes: 64 });
  assert.equal(byteQueue.enqueue(plan(6, "x".repeat(512))), false, "oversized progress is rejected instead of retained");

  const checkpointGate = deferred();
  const checkpoints = [];
  const checkpointQueue = new SidecarEventQueue(async (event) => {
    if (event.seq === 20) await checkpointGate.promise;
    checkpoints.push(event);
  }, { maxItems: 4, maxBytes: 16 * 1024 });
  checkpointQueue.enqueue(boundary(20));
  checkpointQueue.enqueue({ bridgeId: "bridge", seq: 21, t: "checkpoint_result", requestId: "r1", ok: true });
  checkpointQueue.enqueue({ bridgeId: "bridge", seq: 22, t: "checkpoint_result", requestId: "r2", ok: false });
  assert.equal(checkpointQueue.stats().items, 3, "checkpoint results are durable boundaries, not coalesced snapshots");
  checkpointGate.resolve();
  await checkpointQueue.drain();
  assert.deepEqual(checkpoints.map((event) => event.seq), [20, 21, 22]);

  let throwAttempts = 0;
  const retried = [];
  const retryQueue = new SidecarEventQueue(async (event) => {
    if (event.seq === 30 && throwAttempts++ === 0) throw new Error("transient handler failure");
    retried.push(event.seq);
  }, { maxItems: 4, maxBytes: 16 * 1024 });
  retryQueue.enqueue(boundary(30));
  retryQueue.enqueue(boundary(31));
  await retryQueue.drain();
  assert.equal(throwAttempts, 2, "a failed delivery is retried before later boundaries run");
  assert.deepEqual(retried, [30, 31], "handler failure does not lose or reorder durable boundaries");

  const shutdownGate = deferred();
  const shutdownDelivered = [];
  const shutdownQueue = new SidecarEventQueue(async (event) => {
    if (event.seq === 7) await shutdownGate.promise;
    shutdownDelivered.push(event.seq);
  }, { maxItems: 4, maxBytes: 16 * 1024 });
  shutdownQueue.enqueue(boundary(7));
  shutdownQueue.enqueue(boundary(8));
  const shutdownDrain = shutdownQueue.drain();
  shutdownQueue.dispose();
  shutdownGate.resolve();
  await shutdownDrain;
  assert.deepEqual(shutdownDelivered, [7], "shutdown drops only not-yet-started durable delivery work");

  const tailer = new SidecarTailer(eventsDir, fakeWatch);
  const received = [];
  let blocked = true;
  tailer.onEvent = (_id, event) => {
    if (blocked) return false;
    received.push(event);
    return true;
  };
  tailer.start();
  tailer.watch("term-1");
  await appendFile(file, [
    { bridgeId: "bridge", seq: 10, t: "agent_start" },
    { bridgeId: "bridge", seq: 11, t: "agent_settled" },
  ].map((event) => `${JSON.stringify(event)}\n`).join(""));
  await new Promise((resolve) => setTimeout(resolve, 380));
  assert.equal(received.length, 0, "tailing pauses when the consumer rejects admission");
  assert.equal(tailer.isPaused("term-1"), true, "paused tailing is observable while admission is blocked");
  blocked = false;
  tailer.resume("term-1");
  const deadline = Date.now() + 2000;
  while (received.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(received.map((event) => event.seq), [10, 11], "resume drains the durable backlog in order");
  
  const restartFile = join(eventsDir, "term-restart.jsonl");
  await writeFile(restartFile, "");
  const firstTailer = new SidecarTailer(eventsDir, fakeWatch);
  firstTailer.onEvent = () => false;
  firstTailer.start();
  firstTailer.watch("term-restart");
  await appendFile(restartFile, `${JSON.stringify({ bridgeId: "restart", seq: 1, t: "agent_start" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 380));
  assert.equal(firstTailer.isPaused("term-restart"), true, "the restart probe leaves its boundary uncommitted");
  firstTailer.stop();
  const afterRestart = [];
  const secondTailer = new SidecarTailer(eventsDir, fakeWatch);
  secondTailer.onEvent = (_id, event) => { afterRestart.push(event); return true; };
  secondTailer.start();
  secondTailer.watch("term-restart");
  const restartDeadline = Date.now() + 1500;
  while (afterRestart.length < 1 && Date.now() < restartDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(afterRestart.map((event) => event.seq), [1], "restart resumes the uncommitted durable cursor exactly once");
  secondTailer.stop();

  const ackFile = join(eventsDir, "term-ack.jsonl");
  await writeFile(ackFile, "");
  const ackGate = deferred();
  const ackReceived = [];
  const ackQueue = new SidecarEventQueue(async (event) => {
    await ackGate.promise;
    ackReceived.push(event.seq);
  });
  const ackTailer = new SidecarTailer(eventsDir, fakeWatch);
  ackTailer.onEvent = (_id, event) => ackQueue.enqueueTracked(event);
  ackTailer.start();
  ackTailer.watch("term-ack");
  await appendFile(ackFile, `${JSON.stringify({ bridgeId: "ack", seq: 1, t: "agent_start" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 380));
  assert.equal(JSON.parse(await readFile(join(eventsDir, ".cursor-term-ack.json"), "utf8")).offset, 0, "pending handler work cannot advance the durable cursor");
  ackGate.resolve();
  const ackDeadline = Date.now() + 1500;
  while (ackReceived.length < 1 && Date.now() < ackDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(ackReceived, [1]);
  assert.equal(JSON.parse(await readFile(join(eventsDir, ".cursor-term-ack.json"), "utf8")).offset > 0, true, "cursor advances after handler success");
  ackTailer.stop();

  const largeFile = join(eventsDir, "term-large.jsonl");
  await writeFile(largeFile, "");
  const largeTailer = new SidecarTailer(eventsDir, fakeWatch, { maxBacklogBytes: 8 * 1024 * 1024 });
  const largeReceived = [];
  largeTailer.onEvent = (_id, event) => {
    largeReceived.push(event);
    return true;
  };
  largeTailer.start();
  largeTailer.watch("term-large");
  const hugeModel = "m".repeat(2 * 1024 * 1024);
  await appendFile(largeFile, `${JSON.stringify({ bridgeId: "large", seq: 1, t: "agent_start", model: hugeModel })}\n`);
  await appendFile(largeFile, `${JSON.stringify({ bridgeId: "large", seq: 2, t: "agent_settled" })}\n`);
  const largeDeadline = Date.now() + 2500;
  while (largeReceived.length < 2 && Date.now() < largeDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(largeReceived.map((event) => event.seq), [1, 2], "valid records spanning multiple tail chunks are completed and delivered");
  largeTailer.stop();

  const rotationFile = join(eventsDir, "term-rotation.jsonl");
  await writeFile(rotationFile, "");
  const rotationDescriptor = await open(rotationFile, "a");
  const rotationTailer = new SidecarTailer(eventsDir, fakeWatch, { maxBacklogBytes: 64 * 1024 * 1024 });
  const rotationReceived = [];
  rotationTailer.onEvent = (_id, event) => { rotationReceived.push(event); return true; };
  rotationTailer.start();
  rotationTailer.watch("term-rotation");
  await appendFile(rotationFile, `${"x".repeat(8 * 1024 * 1024 - 1)}\n${JSON.stringify({ bridgeId: "rotation", seq: 1, t: "agent_start" })}\n${JSON.stringify({ bridgeId: "rotation", seq: 2, t: "agent_settled" })}\n`);
  const rotationSegment = join(eventsDir, ".term-rotation.jsonl.manual sealed.sealed");
  await rename(rotationFile, rotationSegment);
  await writeFile(rotationFile, "");
  const rotationRace = (async () => {
    assert.equal(existsSync(rotationSegment), true, "caught-up rotation publishes a retained segment before reclaim");
    await rotationDescriptor.write(`${JSON.stringify({ bridgeId: "rotation", seq: 3, t: "agent_settled" })}\n`);
    await appendFile(rotationFile, `${JSON.stringify({ bridgeId: "rotation", seq: 4, t: "agent_settled" })}\n`);
  })();
  const rotationDeadline = Date.now() + 7000;
  while (rotationReceived.length < 4 && Date.now() < rotationDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await rotationRace;
  await rotationDescriptor.close();
  assert.deepEqual(rotationReceived.map((event) => event.seq), [1, 2, 3, 4], "an append through the pre-rotation descriptor is drained before reclaim");
  rotationTailer.stop();

  const crashFile = join(eventsDir, "term-rotation-restart.jsonl");
  await writeFile(crashFile, "");
  const crashDescriptor = await open(crashFile, "a");
  const crashTailer = new SidecarTailer(eventsDir, fakeWatch, { maxBacklogBytes: 64 * 1024 * 1024 });
  const beforeCrash = [];
  crashTailer.onEvent = (_id, event) => {
    beforeCrash.push(event.seq);
    return event.seq === 3 ? false : true;
  };
  crashTailer.start();
  crashTailer.watch("term-rotation-restart");
  await appendFile(crashFile, `${"x".repeat(8 * 1024 * 1024 - 1)}\n${JSON.stringify({ bridgeId: "restart-rotation", seq: 1, t: "agent_start" })}\n${JSON.stringify({ bridgeId: "restart-rotation", seq: 2, t: "agent_settled" })}\n`);
  const crashSegment = join(eventsDir, ".term-rotation-restart.jsonl.manual sealed.sealed");
  await rename(crashFile, crashSegment);
  await writeFile(crashFile, "");
  assert.equal(existsSync(crashSegment), true, "restart probe reaches the retained segment");
  await crashDescriptor.write(`${JSON.stringify({ bridgeId: "restart-rotation", seq: 3, t: "checkpoint_result", ok: true })}\n`);
  await appendFile(crashFile, `${JSON.stringify({ bridgeId: "restart-rotation", seq: 4, t: "agent_settled" })}\n`);
  const blockedDeadline = Date.now() + 3000;
  while (!crashTailer.isPaused("term-rotation-restart") && Date.now() < blockedDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(beforeCrash, [1, 2, 3], "a rejected boundary remains pending in the retained segment");
  crashTailer.stop();
  await crashDescriptor.close();
  const afterCrash = [];
  const recoveredTailer = new SidecarTailer(eventsDir, fakeWatch, { maxBacklogBytes: 64 * 1024 * 1024 });
  recoveredTailer.onEvent = (_id, event) => { afterCrash.push(event.seq); return true; };
  recoveredTailer.start();
  recoveredTailer.watch("term-rotation-restart");
  const recoveryDeadline = Date.now() + 5000;
  while (afterCrash.length < 2 && Date.now() < recoveryDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(afterCrash, [3, 4], "restart drains the uncommitted segment boundary before the active file");
  recoveredTailer.stop();

  const oversizedFile = join(eventsDir, "term-oversized.jsonl");
  await writeFile(oversizedFile, "");
  const oversizedTailer = new SidecarTailer(eventsDir, fakeWatch, { maxRecordBytes: 1024 });
  const oversizedReceived = [];
  oversizedTailer.onEvent = (_id, event) => { oversizedReceived.push(event); return true; };
  oversizedTailer.start();
  oversizedTailer.watch("term-oversized");
  await appendFile(oversizedFile, `${"not-json-".repeat(300)}\n${JSON.stringify({ bridgeId: "oversized", seq: 1, t: "agent_settled" })}\n`);
  const oversizedDeadline = Date.now() + 1500;
  while (oversizedReceived.length < 1 && Date.now() < oversizedDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(oversizedReceived.map((event) => event.seq), [1], "over-cap records fail closed at a newline and do not stall later boundaries");
  oversizedTailer.stop();

  const backlogFile = join(eventsDir, "term-backlog.jsonl");
  await writeFile(backlogFile, "");
  let backlogOverflow;
  const backlogTailer = new SidecarTailer(eventsDir, fakeWatch, {
    maxBacklogBytes: 1024,
    onBacklogOverflow: (id, bytes) => { backlogOverflow = { id, bytes }; },
  });
  backlogTailer.onEvent = () => false;
  backlogTailer.start();
  backlogTailer.watch("term-backlog");
  await appendFile(backlogFile, "x".repeat(2 * 1024 * 1024));
  const backlogDeadline = Date.now() + 1500;
  while (!backlogOverflow && Date.now() < backlogDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(backlogOverflow?.id, "term-backlog", "paused growth reports bounded-spool overflow explicitly");
  assert.equal(backlogOverflow?.bytes >= 2 * 1024 * 1024, true, "overflow reports the retained file size");
  const markerPath = join(eventsDir, ".backpressure-term-backlog");
  const markerDeadline = Date.now() + 1000;
  while (!existsSync(markerPath) && Date.now() < markerDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(markerPath), true, "paused growth raises the producer flow-control marker");
  backlogTailer.stop();
  const clearDeadline = Date.now() + 1000;
  while (existsSync(markerPath) && Date.now() < clearDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(markerPath), false, "shutdown clears stale producer flow-control markers");

  tailer.stop();
  console.log("sidecar bounded-admission checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
