import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { TerminalRuntime, type TerminalRuntimeHost } from "../../../electron/terminal-runtime.ts";
import type { AgentTerminalInstance } from "../../../electron/terminal-instance.ts";
import type { SidecarEvent } from "../../../electron/sidecar.ts";

interface ChunkSend {
  id: string;
  terminalGeneration: number;
  windowGeneration: number;
  rendererGeneration: number;
  sequence: number;
  data: string;
}

function waitFor(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(message));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function fakeTailer() {
  const watched: string[] = [];
  const stopped: string[] = [];
  const producers: Array<{ id: string; pid: number }> = [];
  let started = 0;
  let fullyStopped = 0;
  return {
    watched,
    stopped,
    producers,
    get started() { return started; },
    get fullyStopped() { return fullyStopped; },
    watch(id: string) { watched.push(id); },
    stopWatching(id: string) { stopped.push(id); },
    setExpectedProducer(id: string, pid: number) { producers.push({ id, pid }); },
    start() { started += 1; },
    stop() { fullyStopped += 1; },
    async watchReady(id: string) { this.watch(id); return true; },
  };
}

function fakeTerminal(id: string, generation: number): {
  inst: AgentTerminalInstance;
  noted: string[];
} {
  const noted: string[] = [];
  const inst = {
    id,
    generation,
    closed: false,
    exitHandled: false,
    type: "shell" as const,
    pty: {
      onData: (_data: string) => {},
      onExit: (_code: number) => {},
      paused: false,
      pause() { this.paused = true; },
      resume() { this.paused = false; },
      pid: 42,
    },
    notePtyOutput(data: string) { noted.push(data); },
  } as unknown as AgentTerminalInstance;
  return { inst, noted };
}

function hostWithSends(sends: ChunkSend[]): TerminalRuntimeHost {
  return {
    sendChunk(id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data) {
      sends.push({ id, terminalGeneration, windowGeneration, rendererGeneration, sequence, data });
      return true;
    },
    sendExit() { return true; },
    isDisposed() { return false; },
    shouldAdmitSidecar() { return true; },
    onSidecarEvent() {},
    onSidecarError() {},
    onPtyExitBeforeRelease() {},
    onPtyExitAfterRelease() {},
  };
}

describe("TerminalRuntime", () => {
  it("owns the configured events dir", () => {
    const runtime = new TerminalRuntime(hostWithSends([]), { eventsDir: "/tmp/termina-phase-b-events" });
    assert.equal(runtime.eventsDir, "/tmp/termina-phase-b-events");
    assert.ok(runtime.tailer);
    runtime.disposeEgress();
  });

  it("allocates and notes term-N ids without colliding", () => {
    const runtime = new TerminalRuntime(hostWithSends([]), { flushIntervalMs: 0 });
    assert.equal(runtime.allocateId(), "term-1");
    assert.equal(runtime.allocateId(), "term-2");
    runtime.noteId("term-9");
    assert.equal(runtime.allocateId(), "term-10");
    runtime.noteId("shell-3");
    assert.equal(runtime.allocateId(), "term-11");
    runtime.disposeEgress();
  });

  it("fences acceptOutput on generation and closed", () => {
    const runtime = new TerminalRuntime(hostWithSends([]), { flushIntervalMs: 0 });
    const { inst, noted } = fakeTerminal("term-1", 4);
    runtime.adopt(inst, { tailer: fakeTailer(), rendererTarget: null });
    assert.equal(runtime.acceptOutput("term-1", 3, "stale"), false);
    assert.deepEqual(noted, []);
    assert.equal(runtime.acceptOutput("term-missing", 4, "gone"), false);
    assert.equal(runtime.acceptOutput("term-1", 4, "live"), true);
    assert.deepEqual(noted, ["live"]);
    runtime.markClosed("term-1");
    assert.equal(runtime.acceptOutput("term-1", 4, "after-close"), false);
    assert.deepEqual(noted, ["live"]);
    runtime.disposeEgress();
  });

  it("replays the egress ledger through hydrate after a renderer generation bump", async () => {
    const sends: ChunkSend[] = [];
    const runtime = new TerminalRuntime(hostWithSends(sends), { flushIntervalMs: 0 });
    const { inst, noted } = fakeTerminal("term-1", 2);
    const tailer = fakeTailer();
    runtime.adopt(inst, { tailer, skipSidecarWatch: true, rendererTarget: null });
    assert.deepEqual(tailer.watched, []);
    assert.equal(runtime.attachViewer(1, 1), true);
    assert.equal(runtime.attach("term-1", 2, 1, 1), true);
    assert.equal(runtime.acceptOutput("term-1", 2, "hello"), true);
    assert.deepEqual(noted, ["hello"]);
    await waitFor(() => sends.length === 1, "initial PTY quantum was not delivered");
    assert.equal(sends[0]?.data, "hello");
    const sequence = sends[0]!.sequence;

    assert.equal(runtime.detachViewer(1, 1), true);
    assert.equal(runtime.attachViewer(1, 2), true);
    assert.equal(runtime.attach("term-1", 2, 1, 2), true);
    await waitFor(() => sends.length === 2, "ledger was not replayed on rehydrate");
    assert.equal(sends[1]?.data, "hello");
    assert.equal(sends[1]?.sequence, sequence);
    assert.equal(sends[1]?.rendererGeneration, 2);
    assert.equal(runtime.acknowledge("term-1", 2, 1, 2, sequence), true);
    runtime.disposeEgress();
  });

  it("rejects PTY output after the host is disposed", () => {
    let disposed = false;
    const runtime = new TerminalRuntime({
      ...hostWithSends([]),
      isDisposed: () => disposed,
    }, { flushIntervalMs: 0 });
    const { inst, noted } = fakeTerminal("term-1", 1);
    runtime.adopt(inst, { tailer: fakeTailer(), rendererTarget: null });
    disposed = true;
    assert.equal(runtime.acceptOutput("term-1", 1, "late"), false);
    assert.deepEqual(noted, []);
    runtime.disposeEgress();
  });

  it("releases the instance when the before-exit host hook throws", async () => {
    const tailer = fakeTailer();
    const after: string[] = [];
    const runtime = new TerminalRuntime({
      ...hostWithSends([]),
      onPtyExitBeforeRelease() { throw new Error("before-release failed"); },
      onPtyExitAfterRelease(released) { after.push(released.id); },
    }, { flushIntervalMs: 0 });
    const { inst } = fakeTerminal("term-1", 1);
    runtime.adopt(inst, { tailer, rendererTarget: null });
    assert.equal(runtime.subscribe("term-1", "renderer"), true);
    await assert.rejects(Promise.resolve(inst.pty.onExit(0)), /before-release failed/);
    assert.equal(runtime.has("term-1"), false);
    assert.deepEqual(tailer.stopped, ["term-1"]);
    assert.deepEqual(after, ["term-1"]);
    assert.equal(runtime.subscribe("term-1", "renderer"), false);
    runtime.disposeEgress();
  });

  it("stops leftover sidecar watches on clear", () => {
    const tailer = fakeTailer();
    const runtime = new TerminalRuntime(hostWithSends([]), { flushIntervalMs: 0 });
    const { inst } = fakeTerminal("term-1", 1);
    runtime.adopt(inst, { tailer, rendererTarget: null });
    runtime.clear();
    assert.equal(runtime.has("term-1"), false);
    assert.deepEqual(tailer.stopped, ["term-1"]);
    runtime.disposeEgress();
  });

  it("accepts PTY output before the first viewer attaches", () => {
    const runtime = new TerminalRuntime(hostWithSends([]), { flushIntervalMs: 0 });
    const { inst, noted } = fakeTerminal("term-1", 1);
    runtime.adopt(inst, { tailer: fakeTailer(), rendererTarget: null });
    assert.equal((inst.pty as unknown as { paused: boolean }).paused, false);
    assert.equal(runtime.acceptOutput("term-1", 1, "before-attach"), true);
    assert.deepEqual(noted, ["before-attach"]);
    assert.equal(runtime.attach("term-1", 1, 1, 1), false, "hydrate needs a bound viewer");
    runtime.disposeEgress();
  });

  it("keeps the PTY and sidecar live across viewer detach", () => {
    const tailer = fakeTailer();
    const runtime = new TerminalRuntime(hostWithSends([]), { flushIntervalMs: 0 });
    const { inst } = fakeTerminal("term-1", 1);
    runtime.adopt(inst, { tailer, rendererTarget: null });
    assert.equal(runtime.attachViewer(1, 1), true);
    assert.equal(runtime.attach("term-1", 1, 1, 1), true);
    assert.deepEqual(tailer.watched, ["term-1"]);
    assert.equal(runtime.detachViewer(1, 1), true);
    assert.equal(runtime.unsubscribe("term-1", "renderer"), false);
    assert.equal((inst.pty as unknown as { paused: boolean }).paused, false);
    assert.deepEqual(tailer.stopped, []);
    assert.equal(runtime.acceptOutput("term-1", 1, "while-gone"), true);
    assert.equal(runtime.attachViewer(1, 2), true);
    assert.equal(runtime.attach("term-1", 1, 1, 2), true);
    assert.deepEqual(tailer.watched, ["term-1"]);
    runtime.disposeEgress();
  });

  it("refuses subscribe on unknown or closed terminals", () => {
    const runtime = new TerminalRuntime(hostWithSends([]), { flushIntervalMs: 0 });
    const { inst } = fakeTerminal("term-1", 1);
    runtime.adopt(inst, { tailer: fakeTailer(), rendererTarget: null });
    assert.equal(runtime.subscribe("term-missing", "renderer"), false);
    assert.equal(runtime.subscribe("term-1", ""), false);
    runtime.markClosed("term-1");
    assert.equal(runtime.subscribe("term-1", "renderer"), false);
    runtime.disposeEgress();
  });

  it("keeps sidecar seq and timeline after every viewer detaches", async () => {
    const received: SidecarEvent[] = [];
    const runtime = new TerminalRuntime({
      ...hostWithSends([]),
      onSidecarEvent(_id, event) { received.push(event); },
    }, { flushIntervalMs: 0 });
    const { inst } = fakeTerminal("term-1", 1);
    Object.assign(inst, {
      timeline: [],
      plan: [{ text: "one", paths: [], state: "pending" }],
      sessionFile: "/tmp/core-session.json",
    });
    const tailer = fakeTailer();
    runtime.adopt(inst, { tailer, rendererTarget: null });
    assert.equal(runtime.subscribe("term-1", "renderer"), true);
    assert.equal(runtime.subscribe("term-1", "worldline:c:A"), true);
    assert.equal(runtime.subscribe("term-1", "subagent:bg-1"), true);
    assert.equal(runtime.enqueueSidecar("term-1", { t: "session_ready", bridgeId: "b", seq: 1 }).accepted, true);
    inst.timeline.push({ seq: 1, t: "agent_start", ts: 1 });
    assert.equal(runtime.unsubscribe("term-1", "renderer"), true);
    assert.equal(runtime.unsubscribe("term-1", "worldline:c:A"), true);
    assert.equal(runtime.unsubscribe("term-1", "subagent:bg-1"), true);
    assert.equal(runtime.unsubscribe("term-1", "renderer"), false);
    assert.equal(runtime.enqueueSidecar("term-1", { t: "agent_settled", bridgeId: "b", seq: 2 }).accepted, true);
    inst.timeline.push({ seq: 2, t: "agent_settled", ts: 2 });
    await runtime.drainSidecarQueues(["term-1"]);
    assert.equal(received.length, 2);
    assert.equal(received[1]?.seq, 2);
    assert.deepEqual(tailer.stopped, []);
    assert.equal(runtime.subscribe("term-1", "renderer"), true);
    assert.equal(runtime.get("term-1")?.timeline.length, 2);
    assert.equal(runtime.get("term-1")?.timeline[1]?.t, "agent_settled");
    assert.equal(runtime.get("term-1")?.sessionFile, "/tmp/core-session.json");
    assert.equal(runtime.get("term-1")?.plan.length, 1);
    runtime.disposeEgress();
  });

  it("stopSidecar then release does not stopWatching twice", async () => {
    const tailer = fakeTailer();
    const runtime = new TerminalRuntime(hostWithSends([]), { flushIntervalMs: 0 });
    const { inst } = fakeTerminal("term-1", 1);
    runtime.adopt(inst, { tailer, rendererTarget: null });
    runtime.stopSidecar("term-1");
    await Promise.resolve(inst.pty.onExit(0));
    assert.deepEqual(tailer.stopped, ["term-1"]);
    assert.equal(runtime.has("term-1"), false);
    runtime.disposeEgress();
  });

  it("owns candidate start/stop and does not stopWatching the primary", async () => {
    const primaryStopped: string[] = [];
    const runtime = new TerminalRuntime(hostWithSends([]), {
      eventsDir: "/tmp/termina-candidate-sidecar-owner",
      flushIntervalMs: 0,
    });
    const primary = runtime.tailer;
    assert.ok(primary);
    const orig = primary.stopWatching.bind(primary);
    primary.stopWatching = (id: string) => {
      primaryStopped.push(id);
      orig(id);
    };
    const candidate = fakeTailer();
    runtime.ownCandidateSidecar("term-1", candidate);
    assert.equal(candidate.started, 1);
    assert.equal(runtime.hasCandidateSidecar("term-1"), true);
    assert.equal(await runtime.watchCandidateReady("term-1"), true);
    assert.deepEqual(candidate.watched, ["term-1"]);
    const { inst } = fakeTerminal("term-1", 1);
    runtime.adopt(inst, { tailer: candidate, skipSidecarWatch: true, rendererTarget: null });
    assert.deepEqual(candidate.watched, ["term-1"]);
    await Promise.resolve(inst.pty.onExit(0));
    assert.deepEqual(candidate.stopped, ["term-1"]);
    assert.equal(candidate.fullyStopped, 1);
    assert.equal(runtime.hasCandidateSidecar("term-1"), false);
    assert.deepEqual(primaryStopped, []);
    runtime.disposeEgress();
  });

  it("recycled term-N cannot cancel another worldline candidate watch", async () => {
    const primaryStopped: string[] = [];
    const runtime = new TerminalRuntime(hostWithSends([]), {
      eventsDir: "/tmp/termina-recycled-term-sidecar",
      flushIntervalMs: 0,
    });
    const primary = runtime.tailer;
    assert.ok(primary);
    const orig = primary.stopWatching.bind(primary);
    primary.stopWatching = (id: string) => {
      primaryStopped.push(id);
      orig(id);
    };
    const first = fakeTailer();
    const second = fakeTailer();
    runtime.ownCandidateSidecar("term-1", first);
    const { inst: instA } = fakeTerminal("term-1", 1);
    runtime.adopt(instA, { tailer: first, skipSidecarWatch: true, rendererTarget: null });
    await Promise.resolve(instA.pty.onExit(0));
    assert.deepEqual(first.stopped, ["term-1"]);
    assert.equal(first.fullyStopped, 1);

    runtime.ownCandidateSidecar("term-1", second);
    assert.equal(await runtime.watchCandidateReady("term-1"), true);
    const { inst: instB } = fakeTerminal("term-1", 2);
    runtime.adopt(instB, { tailer: second, skipSidecarWatch: true, rendererTarget: null });
    instA.exitHandled = false;
    await Promise.resolve(instA.pty.onExit(0));
    assert.equal(runtime.get("term-1"), instB);
    assert.deepEqual(second.stopped, []);
    assert.equal(second.fullyStopped, 0);
    assert.equal(runtime.hasCandidateSidecar("term-1"), true);
    assert.deepEqual(primaryStopped, []);
    await Promise.resolve(instB.pty.onExit(0));
    assert.deepEqual(second.stopped, ["term-1"]);
    assert.equal(second.fullyStopped, 1);
    runtime.disposeEgress();
  });

  it("stale stopSidecar generation cannot cancel a recycled term-N watch", async () => {
    const runtime = new TerminalRuntime(hostWithSends([]), {
      eventsDir: "/tmp/termina-stale-stop-sidecar",
      flushIntervalMs: 0,
    });
    const first = fakeTailer();
    const second = fakeTailer();
    runtime.ownCandidateSidecar("term-1", first);
    const staleGeneration = runtime.sidecarWatchGeneration("term-1");
    assert.equal(typeof staleGeneration, "number");
    const { inst: instA } = fakeTerminal("term-1", 1);
    runtime.adopt(instA, { tailer: first, skipSidecarWatch: true, rendererTarget: null });
    await Promise.resolve(instA.pty.onExit(0));

    runtime.ownCandidateSidecar("term-1", second);
    assert.equal(await runtime.watchCandidateReady("term-1"), true);
    const liveGeneration = runtime.sidecarWatchGeneration("term-1");
    assert.notEqual(liveGeneration, staleGeneration);
    const { inst: instB } = fakeTerminal("term-1", 2);
    runtime.adopt(instB, { tailer: second, skipSidecarWatch: true, rendererTarget: null });
    runtime.stopSidecar("term-1", staleGeneration);
    assert.deepEqual(second.stopped, []);
    assert.equal(runtime.hasCandidateSidecar("term-1"), true);
    assert.equal(runtime.get("term-1"), instB);
    runtime.stopSidecar("term-1");
    assert.deepEqual(second.stopped, ["term-1"]);
    assert.equal(second.fullyStopped, 1);
    runtime.disposeEgress();
  });

  it("keeps candidate events dirs off the primary tailer", () => {
    const runtime = new TerminalRuntime(hostWithSends([]), {
      eventsDir: "/tmp/termina-primary-events-dir",
      flushIntervalMs: 0,
    });
    const candidate = runtime.startCandidateSidecar("term-9", "/tmp/termina-candidate-events-dir");
    assert.ok(candidate);
    assert.notEqual(candidate, runtime.tailer);
    assert.equal(runtime.hasCandidateSidecar("term-9"), true);
    runtime.stopSidecar("term-9");
    assert.equal(runtime.hasCandidateSidecar("term-9"), false);
    runtime.disposeEgress();
  });

  it("owns child stream watch and release without a second stopWatching", () => {
    const stream = fakeTailer();
    const runtime = new TerminalRuntime(hostWithSends([]), { flushIntervalMs: 0 });
    runtime.watchSidecar("sub-term-1-bg-1", stream);
    assert.deepEqual(stream.watched, ["sub-term-1-bg-1"]);
    runtime.stopSidecar("sub-term-1-bg-1");
    runtime.stopSidecar("sub-term-1-bg-1");
    assert.deepEqual(stream.stopped, ["sub-term-1-bg-1"]);
    assert.equal(stream.fullyStopped, 0);
    runtime.disposeEgress();
  });

  it("rejects sidecar events the host does not admit", () => {
    const received: SidecarEvent[] = [];
    const runtime = new TerminalRuntime({
      ...hostWithSends([]),
      shouldAdmitSidecar: (id) => id === "term-live",
      onSidecarEvent(_id, event) { received.push(event); },
    }, { flushIntervalMs: 0 });
    const event: SidecarEvent = { t: "session_ready", bridgeId: "b", seq: 1 };
    assert.equal(runtime.enqueueSidecar("term-unknown", event).accepted, false);
    assert.equal(runtime.enqueueSidecar("term-live", event).accepted, true);
    runtime.disposeEgress();
  });
});
