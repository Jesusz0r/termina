import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  PtyEgressScheduler,
  PTY_EGRESS_CHUNK_BYTES,
  PTY_EGRESS_FRAME_MS,
  PTY_EGRESS_QUEUE_HIGH_WATER_BYTES,
  PTY_EGRESS_QUEUE_HIGH_WATER_CHUNKS,
  isPtyDocumentCurrent,
  isPtyLifecycleCurrent,
  isPtyFrameEventCurrent,
  isPtyReadyHandshakeCurrent,
  isPtyDocumentNonce,
  isPtyRendererSendTargetCurrent,
  sendPtyRendererMessage,
  splitPtyData,
} from "../../../electron/pty-egress.ts";
import {
  PtySequenceLedger,
  PTY_RENDERER_SEQUENCE_GAP_WINDOW,
} from "../../../src/pty-sequence-ledger.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(0);
  }
};


function source() {
  return {
    paused: false,
    pauseCount: 0,
    resumeCount: 0,
    pause() {
      this.paused = true;
      this.pauseCount += 1;
    },
    resume() {
      this.paused = false;
      this.resumeCount += 1;
    },
  };
}

function ready(scheduler, id, terminalGeneration, windowGeneration = 1, rendererGeneration = 1) {
  assert.equal(scheduler.setRendererReady(windowGeneration, rendererGeneration, true), true);
  assert.equal(
    scheduler.hydrateTerminal(id, terminalGeneration, windowGeneration, rendererGeneration),
    true,
  );
}

function testScheduler(transport, options = {}) {
  return new PtyEgressScheduler(transport, { flushIntervalMs: 0, ...options });
}

function acknowledgeAll(scheduler, payloads) {
  for (const payload of payloads) {
    scheduler.acknowledge(
      payload.id,
      payload.terminalGeneration,
      payload.windowGeneration,
      payload.rendererGeneration,
      payload.sequence,
    );
  }
}


describe("Lossless PTY Egress & Sequence Ledger Invariants", () => {
  it("coalesces output and admits at most one message per terminal per frame", async () => {
    const sends = [];
    const scheduler = new PtyEgressScheduler({
      send: (...args) => {
        const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
        sends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data, at: Date.now() });
        return true;
      },
      sendExit: () => true,
    });
    scheduler.register("framed", 1, source());
    ready(scheduler, "framed", 1);

    for (let i = 0; i < 128; i += 1) assert.equal(scheduler.enqueue("framed", 1, "x".repeat(64)), true);
    await waitFor(() => sends.length === 1, "coalesced frame was not delivered");
    assert.equal(sends[0].data, "x".repeat(128 * 64));
    assert.equal(scheduler.stats("framed").inFlightChunks, 1);
    acknowledgeAll(scheduler, sends);
    await scheduler.drain("framed");

    const firstPacedIndex = sends.length;
    assert.equal(scheduler.enqueue("framed", 1, "a".repeat(PTY_EGRESS_CHUNK_BYTES)), true);
    assert.equal(scheduler.enqueue("framed", 1, "b".repeat(PTY_EGRESS_CHUNK_BYTES)), true);
    await waitFor(() => sends.length === firstPacedIndex + 2, "paced frames were not delivered");
    assert.ok(
      sends[firstPacedIndex + 1].at - sends[firstPacedIndex].at >= PTY_EGRESS_FRAME_MS - 3,
      "one terminal emitted more than one IPC message in a frame",
    );
    acknowledgeAll(scheduler, sends.slice(firstPacedIndex));
    await scheduler.drain("framed");
    scheduler.cancel("framed", 1);
  });

  it("enforces egress queue limits, scheduler lifecycle, and sequence deduplication", async () => {
  // Generic renderer pushes use the exact BrowserWindow/WebContents/document
  // identity and turn both preflight races and synchronous send throws into a
  // harmless false result.
  function sendTarget(window, webContents, windowGeneration, rendererGeneration, nonce) {
    return { window, webContents, windowGeneration, rendererGeneration, nonce };
  }
  const oldWebContents = {
    destroyed: false,
    crashed: false,
    calls: [],
    isDestroyed() { return this.destroyed; },
    isCrashed() { return this.crashed; },
    send(channel, payload) { this.calls.push({ channel, payload }); },
  };
  const oldBrowserWindow = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
  };
  const oldTarget = sendTarget(oldBrowserWindow, oldWebContents, 1, 1, "old-document");
  assert.equal(isPtyRendererSendTargetCurrent(oldTarget, oldTarget), true);
  assert.equal(sendPtyRendererMessage(oldTarget, oldTarget, true, "state", { value: 1 }), true);
  assert.deepEqual(oldWebContents.calls, [{ channel: "state", payload: { value: 1 } }]);
  const replacementWebContents = { ...oldWebContents, calls: [] };
  const replacementWindow = { destroyed: false, isDestroyed() { return this.destroyed; } };
  const replacementTarget = sendTarget(replacementWindow, replacementWebContents, 2, 2, "new-document");
  assert.equal(isPtyRendererSendTargetCurrent(replacementTarget, oldTarget), false);
  assert.equal(sendPtyRendererMessage(replacementTarget, oldTarget, true, "stale", { value: 2 }), false);
  assert.deepEqual(replacementWebContents.calls, [], "a stale callback cannot send into a replacement window");
  assert.equal(sendPtyRendererMessage(oldTarget, oldTarget, false, "not-ready", {}), false);
  oldBrowserWindow.destroyed = true;
  assert.equal(sendPtyRendererMessage(oldTarget, oldTarget, true, "destroyed-window", {}), false);
  oldBrowserWindow.destroyed = false;
  oldWebContents.destroyed = true;
  assert.equal(sendPtyRendererMessage(oldTarget, oldTarget, true, "destroyed-contents", {}), false);
  oldWebContents.destroyed = false;
  oldWebContents.crashed = true;
  assert.equal(sendPtyRendererMessage(oldTarget, oldTarget, true, "crashed-contents", {}), false);
  oldWebContents.crashed = false;
  oldWebContents.send = () => { throw new Error("renderer disappeared during send"); };
  assert.doesNotThrow(() => sendPtyRendererMessage(oldTarget, oldTarget, true, "throwing-send", {}));
  assert.equal(sendPtyRendererMessage(oldTarget, oldTarget, true, "throwing-send", {}), false);

  // A contiguous renderer stream advances one high-water mark forever; the
  // duplicate ledger must not retain one entry per PTY quantum.
  const longRun = new PtySequenceLedger({ maxGap: 8 });
  for (let sequence = 1; sequence <= 10000; sequence += 1) {
    const result = longRun.accept({ kind: "data", sequence, data: String(sequence) });
    assert.equal(result.kind, "accepted");
    assert.deepEqual(result.records.map((record) => record.sequence), [sequence]);
    assert.equal(longRun.stats().contiguousSequence, sequence);
    assert.equal(longRun.stats().gapCount, 0);
  }
  assert.equal(longRun.stats().gapWindow, 8);
  assert.equal(longRun.stats().retainedRecords, 0);

  // A sparse delivery is retained only inside the capped gap window. When
  // the missing sequence arrives, the renderer flushes the records in order.
  const sparse = new PtySequenceLedger({ maxGap: 4 });
  assert.equal(sparse.accept({ kind: "data", sequence: 1, data: "one" }).kind, "accepted");
  assert.equal(sparse.accept({ kind: "data", sequence: 3, data: "three" }).kind, "buffered");
  assert.deepEqual(
    sparse.accept({ kind: "data", sequence: 2, data: "two" }),
    {
      kind: "accepted",
      records: [
        { kind: "data", sequence: 2, data: "two" },
        { kind: "data", sequence: 3, data: "three" },
      ],
    },
  );
  assert.equal(sparse.accept({ kind: "data", sequence: 2, data: "replay-two" }).kind, "duplicate");
  assert.equal(sparse.accept({ kind: "data", sequence: 3, data: "replay-three" }).kind, "duplicate");
  assert.equal(sparse.accept({ kind: "data", sequence: 99, data: "too-far" }).kind, "rejected");
  assert.equal(sparse.stats().gapCount, 0);

  // A malicious/sparse producer cannot turn the gap map into a second
  // unbounded queue: once the fixed distance window is full, forward records
  // are rejected until the hole closes.
  const sparseStorm = new PtySequenceLedger({ maxGap: 8 });
  assert.equal(sparseStorm.accept({ kind: "data", sequence: 1, data: "head" }).kind, "accepted");
  for (let sequence = 3; sequence <= 10000; sequence += 1) {
    sparseStorm.accept({ kind: "data", sequence, data: String(sequence) });
    assert.equal(sparseStorm.stats().gapCount <= 7, true);
  }
  assert.equal(sparseStorm.stats().retainedRecords <= sparseStorm.stats().gapWindow - 1, true);
  const flushedStorm = sparseStorm.accept({ kind: "data", sequence: 2, data: "hole" });
  assert.equal(flushedStorm.kind, "accepted");
  assert.deepEqual(flushedStorm.records.map((record) => record.sequence), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(sparseStorm.stats().retainedRecords, 0);

  // Exit is part of the same ordered ledger: an early marker waits behind
  // data, and no post-exit data can be accepted by the pane.
  const orderedExit = new PtySequenceLedger({ maxGap: 4 });
  assert.equal(orderedExit.accept({ kind: "data", sequence: 1, data: "head" }).kind, "accepted");
  assert.equal(orderedExit.accept({ kind: "exit", sequence: 3, code: 7 }).kind, "buffered");
  assert.equal(orderedExit.accept({ kind: "data", sequence: 4, data: "after-buffered-exit" }).kind, "rejected");
  assert.deepEqual(
    orderedExit.accept({ kind: "data", sequence: 2, data: "tail" }),
    {
      kind: "accepted",
      records: [
        { kind: "data", sequence: 2, data: "tail" },
        { kind: "exit", sequence: 3, code: 7 },
      ],
    },
  );
  assert.equal(orderedExit.accept({ kind: "data", sequence: 4, data: "after-exit" }).kind, "rejected");
  assert.equal(orderedExit.accept({ kind: "exit", sequence: 3, code: 7 }).kind, "duplicate");

  // A replay can begin at a non-one sequence after a reconnect. That first
  // record establishes the contiguous baseline; older records are stale and
  // can never be rendered after it.
  const replayLedger = new PtySequenceLedger({ maxGap: PTY_RENDERER_SEQUENCE_GAP_WINDOW });
  assert.equal(replayLedger.accept({ kind: "data", sequence: 41, data: "replayed" }).kind, "accepted");
  assert.equal(replayLedger.accept({ kind: "data", sequence: 40, data: "old" }).kind, "duplicate");
  assert.equal(replayLedger.accept({ kind: "data", sequence: 42, data: "next" }).kind, "accepted");

  // No PTY bytes may be sent merely because the document loaded. The exact
  // terminal generation handshake is the hydration boundary.
  const hydrationSends = [];
  const hydration = testScheduler({
    send: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
      hydrationSends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      return true;
    },
  });
  const hydrationSource = source();
  hydration.register("hydrated", 1, hydrationSource);
  assert.equal(hydration.setRendererReady(1, 1, true), true);
  assert.equal(hydration.enqueue("hydrated", 1, "before-hydration"), true);
  await sleep(10);
  assert.deepEqual(hydrationSends, [], "document load alone cannot deliver into an unbuilt pane");
  assert.equal(hydrationSource.paused, true);
  assert.equal(hydration.hydrateTerminal("hydrated", 1, 1, 1), true);
  await waitFor(() => hydrationSends.length === 1, "hydrated PTY output was not delivered");
  assert.equal(hydrationSends[0].sequence, 1);
  assert.equal(hydrationSends[0].data, "before-hydration");
  acknowledgeAll(hydration, hydrationSends);
  await hydration.drain("hydrated");
  assert.equal(hydrationSource.paused, false);
  hydration.cancel("hydrated", 1);

  // Unacknowledged bytes survive a renderer failure. Replay starts in order,
  // and a re-entrant readiness change cannot let one batch overrun the fence.
  const replaySends = [];
  const replay = testScheduler({
    send: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
      replaySends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      return true;
    },
  });
  const replaySource = source();
  replay.register("replay", 2, replaySource);
  ready(replay, "replay", 2, 10, 1);
  assert.equal(replay.enqueue("replay", 2, "one"), true);
  assert.equal(replay.enqueue("replay", 2, "two"), true);
  await waitFor(() => replaySends.length === 2, "initial replay sends missing");
  assert.equal(replay.stats("replay").inFlightBytes, 6);
  assert.equal(replay.setRendererReady(10, 1, false), true);
  assert.equal(replay.stats("replay").inFlightChunks, 0);
  assert.equal(replay.stats("replay").queuedChunks, 2);
  assert.equal(replay.acknowledge("replay", 2, 10, 1, 1), false, "old renderer ack is fenced");
  ready(replay, "replay", 2, 10, 2);
  await waitFor(() => replaySends.length === 4, "unacknowledged PTY output was not replayed");
  assert.deepEqual(replaySends.slice(2).map((item) => item.data), ["one", "two"]);
  assert.deepEqual(replaySends.slice(2).map((item) => item.sequence), [1, 2]);
  acknowledgeAll(replay, replaySends.slice(2));
  await replay.drain("replay");
  replay.cancel("replay", 2);

  // A ready handshake from the old document cannot hydrate the replacement
  // document, even when the BrowserWindow identity is unchanged.
  const staleReady = testScheduler({ send: () => true });
  const staleReadySource = source();
  staleReady.register("stale-ready", 12, staleReadySource);
  assert.equal(staleReady.setRendererReady(11, 1, false), true);
  assert.equal(staleReady.setRendererReady(11, 2, true), true);
  assert.equal(staleReady.hydrateTerminal("stale-ready", 12, 11, 1), false);
  assert.equal(staleReady.stats("stale-ready").hydrated, false);
  assert.equal(staleReady.hydrateTerminal("stale-ready", 12, 11, 2), true);
  staleReady.cancel("stale-ready", 12);

  // A watchdog callback captures the exact BrowserWindow/document identity;
  // an old callback cannot act on a replacement window or nonce.
  const oldWindow = {};
  const newWindow = {};
  const oldDocument = { window: oldWindow, windowGeneration: 21, rendererGeneration: 1, nonce: "old-document" };
  const newDocument = { window: newWindow, windowGeneration: 22, rendererGeneration: 2, nonce: "new-document" };
  let watchdogReloads = 0;
  if (isPtyDocumentCurrent(newDocument, oldDocument)) watchdogReloads += 1;
  assert.equal(watchdogReloads, 0, "an old watchdog callback cannot reload a replacement window");
  assert.equal(isPtyDocumentCurrent(newDocument, oldDocument), false);
  assert.equal(isPtyDocumentCurrent(oldDocument, oldDocument), true);
  assert.equal(isPtyDocumentNonce("new-document", "old-document"), false);
  assert.equal(isPtyDocumentNonce("new-document", "new-document"), true);

  // Every same-WebContents lifecycle callback carries the exact document,
  // load, and renderer-process identity. A delayed old callback cannot act
  // on the replacement document, even when the BrowserWindow is unchanged.
  const oldLifecycle = {
    window: oldWindow,
    windowGeneration: 21,
    rendererGeneration: 1,
    nonce: "old-document",
    loadGeneration: 1,
    processId: 101,
    frameRoutingId: 201,
  };
  const newLifecycle = {
    window: oldWindow,
    windowGeneration: 21,
    rendererGeneration: 2,
    nonce: "new-document",
    loadGeneration: 2,
    processId: 102,
    frameRoutingId: 202,
  };
  for (const eventName of ["did-fail-load", "did-frame-finish-load", "render-process-gone"]) {
    assert.equal(
      isPtyFrameEventCurrent(
        newLifecycle,
        oldLifecycle,
        oldLifecycle.processId,
        oldLifecycle.frameRoutingId,
      ),
      false,
      `${eventName} from an old same-WebContents document must be fenced`,
    );
  }
  // A replacement may retain the same BrowserWindow but receive a new
  // Chromium main-frame pair. Event-specific ids cannot be borrowed from the
  // retired document, even when the document fields otherwise look current.
  assert.equal(
    isPtyFrameEventCurrent(
      newLifecycle,
      newLifecycle,
      oldLifecycle.processId,
      oldLifecycle.frameRoutingId,
    ),
    false,
    "stale did-fail/did-frame-finish ids cannot complete a replacement load",
  );
  assert.equal(
    isPtyFrameEventCurrent(
      newLifecycle,
      newLifecycle,
      newLifecycle.processId,
      newLifecycle.frameRoutingId,
    ),
    true,
  );
  assert.equal(
    isPtyLifecycleCurrent(newLifecycle, { ...newLifecycle, processId: oldLifecycle.processId }),
    false,
    "a stale renderer process cannot invalidate the replacement document",
  );
  assert.equal(
    isPtyLifecycleCurrent(newLifecycle, { ...newLifecycle, frameRoutingId: oldLifecycle.frameRoutingId }),
    false,
    "a stale main-frame routing id cannot invalidate the replacement document",
  );
  assert.equal(isPtyLifecycleCurrent(newLifecycle, newLifecycle), true);

  const sameFrameReplacement = {
    ...newLifecycle,
    processId: oldLifecycle.processId,
    frameRoutingId: oldLifecycle.frameRoutingId,
  };
  assert.equal(
    isPtyFrameEventCurrent(sameFrameReplacement, oldLifecycle, oldLifecycle.processId, oldLifecycle.frameRoutingId),
    false,
    "a newer navigation generation rejects an old same-frame failure/finish",
  );

  // Frame ids plus a load generation are still insufficient when the frame
  // is reused: an old finish/failure event can have the same pair as the new
  // current snapshot. The documented callbacks must therefore be
  // fail-closed; only the nonce-bearing ready handshake may mutate readiness.
  assert.equal(
    isPtyFrameEventCurrent(sameFrameReplacement, sameFrameReplacement, oldLifecycle.processId, oldLifecycle.frameRoutingId),
    true,
    "same-pair lifecycle callbacks are inherently ambiguous without a nonce",
  );
  assert.equal(
    isPtyReadyHandshakeCurrent(
      sameFrameReplacement,
      sameFrameReplacement,
      sameFrameReplacement.nonce,
      sameFrameReplacement.processId,
      sameFrameReplacement.frameRoutingId,
    ),
    true,
    "the fresh document nonce and exact sender pair establish readiness",
  );
  assert.equal(
    isPtyReadyHandshakeCurrent(
      sameFrameReplacement,
      sameFrameReplacement,
      oldLifecycle.nonce,
      oldLifecycle.processId,
      oldLifecycle.frameRoutingId,
    ),
    false,
    "an old same-pair document nonce cannot establish replacement readiness",
  );
  const mainSource = await readFile("electron/main.ts", "utf8");
  const preloadSource = await readFile("electron/preload.ts", "utf8");
  const rendererSource = await readFile("src/main.ts", "utf8");
  const finishStart = mainSource.indexOf('win.webContents.on("did-frame-finish-load"');
  const failStart = mainSource.indexOf('win.webContents.on("did-fail-load"');
  const goneStart = mainSource.indexOf('win.webContents.on("render-process-gone"');
  assert.ok(finishStart >= 0 && failStart > finishStart && goneStart > failStart, "lifecycle listeners are present");
  assert.doesNotMatch(mainSource, /win\.webContents\.on\("did-finish-load"/);
  const finishListener = mainSource.slice(finishStart, failStart);
  const failListener = mainSource.slice(failStart, goneStart);
  assert.match(finishListener, /isPtyFrameEventCurrent/);
  assert.match(failListener, /isPtyFrameEventCurrent/);
  assert.doesNotMatch(finishListener, /rendererReady\s*=\s*true|rendererLoadPending\s*=\s*false|rendererPendingLoad\s*=\s*null/);
  assert.doesNotMatch(failListener, /rendererReady\s*=\s*false|rendererLoadPending\s*=\s*false|rendererPendingLoad\s*=\s*null/);

  // Every generic push goes through the exact target guard. The source probe
  // keeps a future direct webContents.send from bypassing crash/destroy and
  // replacement-document fencing, and verifies the preload owns one
  // capability append point for PTY readiness.
  const genericSendStart = mainSource.indexOf("private send(channel: string");
  const genericSendEnd = mainSource.indexOf("/** Deliver one bounded PTY chunk", genericSendStart);
  assert.ok(genericSendStart >= 0 && genericSendEnd > genericSendStart, "generic renderer send helper is present");
  const genericSend = mainSource.slice(genericSendStart, genericSendEnd);
  assert.match(genericSend, /sendPtyRendererMessage/);
  assert.match(genericSend, /captureRendererSendTarget/);
  assert.match(genericSend, /isPtyRendererSendTargetCurrent/);
  assert.match(genericSend, /reloadPtyDocument/);
  assert.doesNotMatch(genericSend, /webContents\.send/);
  assert.match(preloadSource, /const rendererCapability = .*sendSync\("renderer:capability"\)/s);
  assert.match(preloadSource, /readyTerminal: \(id, generation\) => ipcRenderer\.send\("pty:ready", id, generation\)/);
  assert.doesNotMatch(preloadSource, /readyTerminal: \(id, generation\) => ipcRenderer\.send\("pty:ready", id, generation, rendererCapability\)/);
  assert.match(rendererSource, /import \{ PtySequenceLedger \} from "\.\/pty-sequence-ledger"/);
  assert.match(rendererSource, /ptySequenceLedger: PtySequenceLedger/);
  assert.doesNotMatch(rendererSource, /ptySequences\s*:\s*Set/);

  // A crashed document is invalidated before the replacement navigation. The
  // next frame pair and freshly issued nonce are the only valid ready proof;
  // old failure/finish callbacks and the old ready nonce stay fenced.
  const crashedLifecycle = {
    window: oldWindow,
    windowGeneration: 21,
    rendererGeneration: 3,
    nonce: "crash-replacement",
    loadGeneration: 3,
    processId: 103,
    frameRoutingId: 203,
  };
  const replacementLifecycle = {
    ...crashedLifecycle,
    rendererGeneration: 4,
    nonce: "post-crash-document",
    loadGeneration: 4,
    processId: 104,
    frameRoutingId: 204,
  };
  assert.equal(
    isPtyFrameEventCurrent(replacementLifecycle, replacementLifecycle, 103, 203),
    false,
    "old crashed process/frame cannot finish the replacement document",
  );
  assert.equal(
    isPtyFrameEventCurrent(replacementLifecycle, replacementLifecycle, 104, 204),
    true,
    "the next did-start-navigation frame pair can finish the replacement",
  );
  assert.equal(isPtyDocumentNonce(replacementLifecycle.nonce, crashedLifecycle.nonce), false);
  assert.equal(isPtyDocumentNonce(replacementLifecycle.nonce, replacementLifecycle.nonce), true);

  // A synchronous data transport throw may synchronously fence the renderer.
  // The resulting replay must own the record exactly once; the catch path
  // cannot append a second reference to the same sequence.
  const throwingDataSends = [];
  let throwingData;
  let throwingDataAttempts = 0;
  throwingData = testScheduler({
    send: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
      throwingDataSends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      throwingDataAttempts += 1;
      if (throwingDataAttempts === 1) {
        assert.equal(throwingData.setRendererReady(103, 2, false), true);
        throw new Error("data transport failed after renderer crash");
      }
      return true;
    },
    sendExit: () => true,
  });
  const throwingDataSource = source();
  throwingData.register("throw-data", 14, throwingDataSource);
  ready(throwingData, "throw-data", 14, 103, 1);
  assert.equal(throwingData.enqueue("throw-data", 14, "data"), true);
  await waitFor(() => throwingDataSends.length >= 1, "thrown data send did not run");
  assert.deepEqual(
    throwingData.stats("throw-data"),
    {
      queuedBytes: 4,
      queuedChunks: 1,
      inFlightBytes: 0,
      inFlightChunks: 0,
      retainedBytes: 4,
      retainedChunks: 1,
      paused: true,
      closing: false,
      hydrated: false,
      terminalGeneration: 14,
      windowGeneration: 103,
      rendererGeneration: 2,
    },
    "a thrown data send has one queued owner after reentrant crash replay",
  );
  ready(throwingData, "throw-data", 14, 103, 2);
  await waitFor(() => throwingDataSends.length >= 2, "thrown data send was not retried");
  assert.deepEqual(throwingDataSends.map((item) => item.sequence), [1, 1]);
  assert.equal(new Set(throwingDataSends.map((item) => item.sequence)).size, 1);
  assert.equal(throwingData.acknowledge("throw-data", 14, 103, 2, 1), true);
  await throwingData.drain("throw-data");
  assert.equal(throwingData.stats("throw-data").retainedChunks, 0);
  assert.equal(throwingData.stats("throw-data").retainedBytes, 0);
  throwingData.cancel("throw-data", 14);

  // The same ownership rule applies to the ordered exit marker. A crash
  // during its first send must replay one marker, retain the terminal, and
  // resolve finish only after the replacement acknowledges that sequence.
  const throwingExitSends = [];
  let throwingExit;
  let throwingExitAttempts = 0;
  throwingExit = testScheduler({
    send: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
      throwingExitSends.push({ kind: "data", id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      return true;
    },
    sendExit: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, code] = args;
      throwingExitSends.push({ kind: "exit", id, terminalGeneration, windowGeneration, rendererGeneration, sequence, code });
      throwingExitAttempts += 1;
      if (throwingExitAttempts === 1) {
        assert.equal(throwingExit.setRendererReady(104, 2, false), true);
        throw new Error("exit transport failed after renderer crash");
      }
      return true;
    },
  });
  const throwingExitSource = source();
  throwingExit.register("throw-exit", 15, throwingExitSource);
  ready(throwingExit, "throw-exit", 15, 104, 1);
  assert.equal(throwingExit.enqueue("throw-exit", 15, "tail"), true);
  const throwingExitDone = throwingExit.finish("throw-exit", 15, 37);
  let throwingExitSettled = false;
  void throwingExitDone.then(() => { throwingExitSettled = true; });
  await waitFor(() => throwingExitSends.some((item) => item.kind === "data"), "exit data send did not run");
  const throwingExitData = throwingExitSends.find((item) => item.kind === "data");
  assert.equal(throwingExit.acknowledge("throw-exit", 15, 104, 1, throwingExitData.sequence), true);
  await waitFor(() => throwingExitSends.some((item) => item.kind === "exit"), "thrown exit send did not run");
  assert.deepEqual(
    throwingExit.stats("throw-exit"),
    {
      queuedBytes: 0,
      queuedChunks: 1,
      inFlightBytes: 0,
      inFlightChunks: 0,
      retainedBytes: 0,
      retainedChunks: 1,
      paused: true,
      closing: true,
      hydrated: false,
      terminalGeneration: 15,
      windowGeneration: 104,
      rendererGeneration: 2,
    },
    "a thrown exit send has one queued marker after reentrant crash replay",
  );
  await sleep(10);
  assert.equal(throwingExitSettled, false, "exit finish cannot resolve before replay acknowledgement");
  throwingExit.setRendererReady(104, 2, true);
  assert.equal(throwingExit.hydrateTerminal("throw-exit", 15, 104, 2), true);
  await waitFor(() => throwingExitSends.filter((item) => item.kind === "exit").length >= 2, "thrown exit marker was not retried");
  const throwingExitMarkers = throwingExitSends.filter((item) => item.kind === "exit");
  assert.deepEqual(throwingExitMarkers.map((item) => item.sequence), [2, 2]);
  assert.equal(new Set(throwingExitMarkers.map((item) => item.sequence)).size, 1);
  assert.equal(throwingExit.stats("throw-exit").retainedChunks, 1);
  assert.equal(throwingExit.acknowledge("throw-exit", 15, 104, 2, 2), true);
  assert.equal(await throwingExitDone, true);
  assert.equal(throwingExit.stats("throw-exit").retainedChunks, 0);
  assert.equal(throwingExit.stats("throw-exit").retainedBytes, 0);
  assert.equal(throwingExit.stats("throw-exit").terminalGeneration, 0);

  let reentrant;
  const reentrantSends = [];
  reentrant = testScheduler({
    send: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
      reentrantSends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      if (reentrantSends.length === 1) reentrant.setRendererReady(20, 1, false);
      return true;
    },
  });
  const reentrantSource = source();
  reentrant.register("reentrant", 3, reentrantSource);
  ready(reentrant, "reentrant", 3, 20, 1);
  reentrant.enqueue("reentrant", 3, "first");
  reentrant.enqueue("reentrant", 3, "second");
  await waitFor(() => reentrantSends.length === 1, "re-entrant send did not run");
  await sleep(10);
  assert.equal(reentrantSends.length, 1, "a stale batch continued after renderer loss");
  assert.equal(reentrant.stats("reentrant").retainedChunks, 2);
  reentrant.setRendererReady(20, 2, true);
  reentrant.hydrateTerminal("reentrant", 3, 20, 2);
  await waitFor(() => reentrantSends.length === 3, "re-entrant replay missing");
  acknowledgeAll(reentrant, reentrantSends.slice(1));
  await reentrant.drain("reentrant");
  reentrant.cancel("reentrant", 3);

  // IPC admission itself is bounded by queued + in-flight bytes. A sink that
  // accepts every send but never acknowledges cannot accumulate 100 MiB in
  // Chromium behind the scheduler.
  const slowSends = [];
  const slow = testScheduler(
    {
      send: (...args) => {
        const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
        slowSends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
        return true;
      },
    },
    {
      maxQueueBytes: PTY_EGRESS_CHUNK_BYTES * 4,
      maxQueueChunks: 4,
      lowWaterBytes: PTY_EGRESS_CHUNK_BYTES * 2,
      lowWaterChunks: 2,
      batchBytes: PTY_EGRESS_CHUNK_BYTES * 4,
      batchChunks: 4,
    },
  );
  const slowSource = source();
  slow.register("slow", 4, slowSource);
  ready(slow, "slow", 4, 30, 1);
  const slowChunk = "s".repeat(PTY_EGRESS_CHUNK_BYTES);
  for (let i = 0; i < 32; i += 1) {
    if (slowSource.paused) break;
    assert.equal(slow.enqueue("slow", 4, slowChunk), true);
  }
  await waitFor(() => slowSends.length > 0, "slow renderer did not admit any output");
  const slowStats = slow.stats("slow");
  assert.equal(slowStats.retainedBytes <= PTY_EGRESS_CHUNK_BYTES * 4, true);
  assert.equal(slowStats.retainedChunks <= 4, true);
  assert.equal(slowSends.reduce((sum, item) => sum + Buffer.byteLength(item.data), 0) <= PTY_EGRESS_CHUNK_BYTES * 4, true);
  assert.equal(slowSource.paused, true, "unacknowledged IPC bytes pause the PTY source");
  acknowledgeAll(slow, slowSends);
  await slow.drain("slow");
  assert.equal(slowSource.paused, false);
  slow.cancel("slow", 4);

  // Defensive admission rejects an oversized callback instead of bypassing
  // high-water; the source adapter must split it first. The generator is
  // lossless and bounded per yielded quantum.
  const oversized = "z".repeat(PTY_EGRESS_CHUNK_BYTES * 4 + 17);
  const oversizedScheduler = testScheduler({ send: () => true });
  const oversizedSource = source();
  oversizedScheduler.register("oversized", 5, oversizedSource);
  assert.equal(oversizedScheduler.enqueue("oversized", 5, oversized), false);
  assert.equal(oversizedScheduler.stats("oversized").retainedBytes <= PTY_EGRESS_QUEUE_HIGH_WATER_BYTES, true);
  const pieces = [...splitPtyData(oversized)];
  assert.ok(pieces.length > 4);
  assert.equal(pieces.every((piece) => Buffer.byteLength(piece) <= PTY_EGRESS_CHUNK_BYTES), true);
  assert.equal(pieces.join(""), oversized);
  oversizedScheduler.cancel("oversized", 5);

  // Terminal id reuse cannot admit output from an old PTY generation.
  const reuseSends = [];
  const reuse = testScheduler({
    send: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
      reuseSends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      return true;
    },
  });
  reuse.register("same-id", 6, source());
  reuse.setRendererReady(40, 1, false);
  assert.equal(reuse.enqueue("same-id", 6, "old"), true);
  reuse.cancel("same-id", 6);
  reuse.register("same-id", 7, source());
  assert.equal(reuse.enqueue("same-id", 6, "late-old"), false);
  assert.equal(reuse.enqueue("same-id", 7, "new"), true);
  ready(reuse, "same-id", 7, 40, 1);
  await waitFor(() => reuseSends.length === 1, "reused terminal did not deliver new output");
  assert.equal(reuseSends[0].data, "new");
  assert.equal(reuseSends[0].terminalGeneration, 7);
  acknowledgeAll(reuse, reuseSends);
  await reuse.drain("same-id");
  reuse.cancel("same-id", 7);

  // Delayed lifecycle events from an older BrowserWindow cannot disable the
  // current window. A newer document also fences all old acknowledgements.
  const windowSends = [];
  const windows = testScheduler({
    send: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
      windowSends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      return true;
    },
  });
  windows.register("window", 8, source());
  ready(windows, "window", 8, 50, 1);
  windows.enqueue("window", 8, "window-byte");
  await waitFor(() => windowSends.length === 1, "window output missing");
  assert.equal(windows.setRendererReady(49, 99, false), false);
  assert.equal(windows.stats().rendererReady, true);
  assert.equal(windows.stats().windowGeneration, 50);
  assert.equal(windows.acknowledge("window", 8, 49, 99, 1), false);
  assert.equal(windows.acknowledge("window", 8, 50, 1, 1), true);
  await windows.drain("window");
  windows.cancel("window", 8);

  // Natural exit is an acknowledgement barrier: pty:exit may not overtake
  // bytes accepted before the native onExit event.
  const exitOrder = [];
  const orderedSends = [];
  const ordered = testScheduler({
    send: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
      exitOrder.push(data);
      const payload = { id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data };
      orderedSends.push(payload);
      return true;
    },
    sendExit: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, code] = args;
      exitOrder.push(`exit:${code}`);
      orderedSends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, code, kind: "exit" });
      return true;
    },
  });
  const orderedSource = source();
  ordered.register("ordered", 9, orderedSource);
  ready(ordered, "ordered", 9, 60, 1);
  ordered.enqueue("ordered", 9, "one");
  ordered.enqueue("ordered", 9, "two");
  const ended = ordered.finish("ordered", 9);
  let endedSettled = false;
  void ended.then(() => { endedSettled = true; });
  await waitFor(() => orderedSends.length === 2, "natural-exit tail was not sent");
  await sleep(10);
  assert.equal(endedSettled, false, "natural exit overtook unacknowledged output");
  acknowledgeAll(ordered, orderedSends);
  await waitFor(() => orderedSends.length === 3, "natural exit marker was not sent");
  assert.equal(orderedSends[2].kind, "exit");
  acknowledgeAll(ordered, orderedSends);
  assert.equal(await ended, true);
  assert.deepEqual(exitOrder, ["one", "two", "exit:0"]);

  const inactiveSends = [];
  const inactive = testScheduler({
    send: () => true,
    sendExit: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, code] = args;
      inactiveSends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, code });
      return true;
    },
  });
  const inactiveSource = source();
  inactive.register("inactive", 10, inactiveSource);
  inactive.setRendererReady(70, 1, false);
  const inactiveEnded = inactive.finish("inactive", 10);
  let inactiveSettled = false;
  void inactiveEnded.then(() => { inactiveSettled = true; });
  await sleep(10);
  assert.equal(inactiveSettled, false, "exit completed while the pane was inactive");
  inactive.setRendererReady(70, 1, true);
  assert.equal(inactive.hydrateTerminal("inactive", 10, 70, 1), true);
  await waitFor(() => inactiveSends.length === 1, "inactive exit marker was not sent after hydration");
  assert.equal(inactive.acknowledge("inactive", 10, 70, 1, inactiveSends[0].sequence), true);
  assert.equal(await inactiveEnded, true);

  // Natural exit is itself a sequenced ledger record. If the renderer crashes
  // after receiving the marker but before acknowledging it, the marker is
  // replayed and the terminal remains retained until the replacement acks it.
  const exitSends = [];
  const exit = testScheduler({
    send: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
      exitSends.push({ kind: "data", id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      return true;
    },
    sendExit: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, code] = args;
      exitSends.push({ kind: "exit", id, terminalGeneration, windowGeneration, rendererGeneration, sequence, code });
      return true;
    },
  });
  const exitSource = source();
  exit.register("crash-exit", 13, exitSource);
  ready(exit, "crash-exit", 13, 71, 1);
  assert.equal(exit.enqueue("crash-exit", 13, "tail"), true);
  const exitDone = exit.finish("crash-exit", 13, 23);
  await waitFor(() => exitSends.length === 1, "exit data was not sent");
  acknowledgeAll(exit, exitSends.filter((item) => item.kind === "data"));
  await waitFor(() => exitSends.length === 2, "exit marker was not sent after data ack");
  assert.equal(exitSends[1].kind, "exit");
  assert.equal(exitSends[1].sequence, 2);
  assert.equal(exitSends[1].code, 23);
  assert.equal(exit.stats("crash-exit").inFlightChunks, 1);
  assert.equal(exit.setRendererReady(71, 1, false), true);
  assert.equal(exit.stats("crash-exit").queuedChunks, 1);
  assert.equal(exit.stats("crash-exit").inFlightChunks, 0);
  assert.equal(exit.setRendererReady(71, 2, true), true);
  assert.equal(exit.hydrateTerminal("crash-exit", 13, 71, 2), true);
  await waitFor(() => exitSends.length === 3, "exit marker was not replayed");
  assert.equal(exitSends[2].kind, "exit");
  assert.equal(exitSends[2].sequence, 2);
  assert.equal(exitSends[2].rendererGeneration, 2);
  assert.equal(exit.acknowledge("crash-exit", 13, 71, 2, 2), true);
  assert.equal(await exitDone, true);
  assert.equal(exit.stats("crash-exit").terminalGeneration, 0);

  // A deterministic 100 MiB burst proves exact ordering, source high-water,
  // fair yielding, and no unbounded downstream sink acceptance.
  const burstSends = [];
  let burst;
  const burstSource = source();
  const expected = createHash("sha256");
  const actual = createHash("sha256");
  burst = testScheduler({
    send: (id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data) => {
      burstSends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      actual.update(data);
      setTimeout(() => {
        burst.acknowledge(id, terminalGeneration, windowGeneration, rendererGeneration, sequence);
      }, 0);
      return true;
    },
  });
  burst.register("burst", 11, burstSource);
  ready(burst, "burst", 11, 80, 1);
  const burstBytes = 100 * 1024 * 1024;
  const burstChunks = Math.ceil(burstBytes / PTY_EGRESS_CHUNK_BYTES);
  const intervalTicks = { count: 0 };
  const interval = setInterval(() => { intervalTicks.count += 1; }, 1);
  let maxObservedRetainedBytes = 0;
  let maxObservedRetainedChunks = 0;
  const producer = (async () => {
    for (let i = 0; i < burstChunks; i += 1) {
      const body = `${String(i).padStart(8, "0")}:${"x".repeat(PTY_EGRESS_CHUNK_BYTES - 9)}`;
      expected.update(body);
      while (burstSource.paused) await sleep(0);
      while (!burst.enqueue("burst", 11, body)) await sleep(0);
      const stats = burst.stats("burst");
      maxObservedRetainedBytes = Math.max(maxObservedRetainedBytes, stats.retainedBytes);
      maxObservedRetainedChunks = Math.max(maxObservedRetainedChunks, stats.retainedChunks);
      assert.equal(stats.retainedBytes <= PTY_EGRESS_QUEUE_HIGH_WATER_BYTES, true);
      assert.equal(stats.retainedChunks <= PTY_EGRESS_QUEUE_HIGH_WATER_CHUNKS, true);
    }
  })();
  await producer;
  await burst.drain("burst");
  clearInterval(interval);
  assert.equal(actual.digest("hex"), expected.digest("hex"), "100 MiB burst preserves exact byte order");
  assert.ok(intervalTicks.count > 5, "burst drain yields to timers and keeps the event loop responsive");
  assert.ok(maxObservedRetainedBytes <= PTY_EGRESS_QUEUE_HIGH_WATER_BYTES);
  assert.ok(maxObservedRetainedChunks <= PTY_EGRESS_QUEUE_HIGH_WATER_CHUNKS);
  assert.ok(burstSource.pauseCount > 0, "burst reaches source backpressure");
  assert.ok(burstSource.resumeCount > 0, "source resumes after drained low-water crossings");
  burst.cancel("burst", 11);

  // Round-robin dispatch prevents a noisy terminal from monopolizing a
  // bounded batch. The first three sends include every live terminal.
  const fairSends = [];
  const fair = testScheduler(
    {
      send: (...args) => {
        const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
        const payload = { id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data };
        fairSends.push(payload);
        return true;
      },
    },
    { batchChunks: 3, batchBytes: 3 * PTY_EGRESS_CHUNK_BYTES },
  );
  for (const [index, id] of ["a", "b", "c"].entries()) {
    fair.register(id, 20 + index, source());
    fair.enqueue(id, 20 + index, "0");
    fair.enqueue(id, 20 + index, "1");
    fair.enqueue(id, 20 + index, "2");
  }
  ready(fair, "a", 20, 90, 1);
  fair.hydrateTerminal("b", 21, 90, 1);
  fair.hydrateTerminal("c", 22, 90, 1);
  await waitFor(() => fairSends.length === 9, "fair scheduler did not drain all terminals");
  assert.deepEqual(fairSends.slice(0, 3).map((value) => value.id), ["a", "b", "c"]);
  acknowledgeAll(fair, fairSends);
  await fair.drain();
  fair.dispose();

  // Close and shutdown clear retained data; delayed old acknowledgements and
  // later sends cannot leak bytes from a removed terminal.
  const closeSends = [];
  const closing = testScheduler({
    send: (...args) => {
      const [id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data] = args;
      closeSends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      return true;
    },
  });
  const closingSource = source();
  closing.register("closing", 30, closingSource);
  closing.setRendererReady(100, 1, false);
  closing.enqueue("closing", 30, "stale");
  const cancelled = closing.finish("closing", 30);
  closing.cancel("closing", 30);
  assert.equal(await cancelled, false);
  closing.setRendererReady(100, 1, true);
  await sleep(10);
  assert.deepEqual(closeSends, [], "closed terminal output was delivered stale");
  const shutdown = testScheduler({ send: () => true });
  const shutdownSource = source();
  shutdown.register("shutdown", 31, shutdownSource);
  shutdown.setRendererReady(101, 1, true);
  shutdown.hydrateTerminal("shutdown", 31, 101, 1);
  shutdown.enqueue("shutdown", 31, "pending");
  const shutdownDrain = shutdown.drain("shutdown");
  shutdown.dispose();
  await shutdownDrain;

  console.log(JSON.stringify({
    burstBytes,
    burstChunks,
    eventLoopTicks: intervalTicks.count,
    maxObservedRetainedBytes,
    maxObservedRetainedChunks,
    maxQueueBytes: PTY_EGRESS_QUEUE_HIGH_WATER_BYTES,
    maxQueueChunks: PTY_EGRESS_QUEUE_HIGH_WATER_CHUNKS,
    slowAcceptedBytes: slowSends.reduce((sum, item) => sum + Buffer.byteLength(item.data), 0),
  }));
  }, 30_000);
});
