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
  return {
    watched,
    stopped,
    producers,
    watch(id: string) { watched.push(id); },
    stopWatching(id: string) { stopped.push(id); },
    setExpectedProducer(id: string, pid: number) { producers.push({ id, pid }); },
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
      pause() {},
      resume() {},
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
    assert.equal(runtime.setRendererReady(1, 1, true), true);
    assert.equal(runtime.hydrateTerminal("term-1", 2, 1, 1), true);
    assert.equal(runtime.acceptOutput("term-1", 2, "hello"), true);
    assert.deepEqual(noted, ["hello"]);
    await waitFor(() => sends.length === 1, "initial PTY quantum was not delivered");
    assert.equal(sends[0]?.data, "hello");
    const sequence = sends[0]!.sequence;

    assert.equal(runtime.setRendererReady(1, 1, false), true);
    assert.equal(runtime.setRendererReady(1, 2, true), true);
    assert.equal(runtime.hydrateTerminal("term-1", 2, 1, 2), true);
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
    await assert.rejects(Promise.resolve(inst.pty.onExit(0)), /before-release failed/);
    assert.equal(runtime.has("term-1"), false);
    assert.deepEqual(tailer.stopped, ["term-1"]);
    assert.deepEqual(after, ["term-1"]);
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
