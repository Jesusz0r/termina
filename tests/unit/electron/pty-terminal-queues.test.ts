import { describe, expect, it, vi } from "vitest";
import { MAX_PENDING_INPUT_BYTES, PtyTerminal } from "../../../electron/pty-terminal.ts";
import { splitPtyData } from "../../../electron/pty-egress.ts";
import { TerminalRuntime } from "../../../electron/terminal-runtime.ts";
import type { AgentTerminalInstance } from "../../../electron/terminal-instance.ts";

interface HollowView {
  pendingInput: Array<{ data: string; offset: number }>;
  pendingInputBytes: number;
  pendingOutput: Array<{ data: string; offset: number }>;
  flushingOutput: boolean;
  exited: boolean;
  exitDelivered: boolean;
  pendingExitCode: number | null;
  inputScheduled: boolean;
  pty: { write(data: string): void; pause(): void; resume(): void };
  flushOutput(): void;
}

/**
 * A PtyTerminal without a real pty child: the queue logic (input depth,
 * output slicing, pause/resume) runs against a fake IPty surface, so no
 * unit test spawns a process.
 */
function hollow(): { term: PtyTerminal; view: HollowView; written: string[]; pauses: number; resumes: number } {
  const term = Object.create(PtyTerminal.prototype) as PtyTerminal;
  const view = term as unknown as HollowView;
  const written: string[] = [];
  let pauses = 0;
  let resumes = 0;
  view.pendingInput = [];
  view.pendingInputBytes = 0;
  view.pendingOutput = [];
  view.flushingOutput = false;
  view.exited = false;
  view.exitDelivered = false;
  view.pendingExitCode = null;
  view.inputScheduled = false;
  view.pty = {
    write: (data: string) => {
      written.push(data);
    },
    pause: () => {
      pauses += 1;
    },
    resume: () => {
      resumes += 1;
    },
  };
  term.onData = () => {};
  term.onExit = () => {};
  return {
    term,
    view,
    written,
    get pauses() {
      return pauses;
    },
    get resumes() {
      return resumes;
    },
  };
}

describe("pty-terminal queues (refs #195)", () => {
  it.each([false, true])("bounds source-tail and renderer drain together (late renderer: %s)", async (lateRenderer) => {
    const { term, view } = hollow();
    const exits: boolean[] = [];
    const sent: number[] = [];
    const runtime = new TerminalRuntime({
      sendChunk: (_id, _generation, _window, _renderer, seq) => { sent.push(seq); return true; },
      sendExit: () => true,
      isDisposed: () => false, shouldAdmitSidecar: () => true,
      onSidecarEvent() {}, onSidecarError() {}, onPtyExitBeforeRelease() {},
      onPtyExitAfterRelease: (_inst, _target, details) => { exits.push(details.drained); },
    }, { maxQueueChunks: 2, flushIntervalMs: 0 });
    const inst = { id: "term-1", generation: 1, pty: term, closed: false, exitHandled: false, notePtyOutput() {} } as unknown as AgentTerminalInstance;
    vi.useFakeTimers();
    try {
      runtime.adopt(inst, { tailer: { watch() {}, stopWatching() {}, setExpectedProducer() {} }, skipSidecarWatch: true, rendererTarget: null });
      view.pendingOutput.push({ data: "x".repeat(192 * 1024), offset: 0 });
      view.flushOutput();
      expect(view.pendingOutput).toHaveLength(1);
      view.exited = true;
      view.pendingExitCode = 0;
      term.onNativeExit();
      view.flushOutput();
      await vi.advanceTimersByTimeAsync(9000);
      expect(runtime.get(inst.id)).toBe(inst);
      if (lateRenderer) {
        runtime.attachViewer(1, 1);
        runtime.attach(inst.id, 1, 1, 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(sent.length).toBeGreaterThan(0);
        runtime.acknowledge(inst.id, 1, 1, 1, sent[0]!);
        await vi.advanceTimersByTimeAsync(1);
        expect(view.pendingOutput).toHaveLength(0);
      }
      await vi.advanceTimersByTimeAsync(1001);
      expect(runtime.get(inst.id)).toBeUndefined();
      expect(view.pendingOutput).toHaveLength(0);
      expect(exits).toEqual([false]);
    } finally { runtime.disposeEgress(); vi.useRealTimers(); }
  });
  it("caps queued input depth and drops the excess", () => {
    const { term, view } = hollow();
    // Block the chunked drain so the queue accumulates like an IPC burst.
    view.inputScheduled = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const payload = "x".repeat(4 * 1024 * 1024);
      for (let i = 0; i < 4; i++) term.write(payload);
      expect(view.pendingInput).toHaveLength(4);
      expect(view.pendingInputBytes).toBe(MAX_PENDING_INPUT_BYTES);
      term.write("overflow");
      expect(view.pendingInput).toHaveLength(4);
      expect(view.pendingInputBytes).toBe(MAX_PENDING_INPUT_BYTES);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("accounts input bytes as the chunked writer drains", async () => {
    const { term, view, written } = hollow();
    term.write("hello");
    expect(view.pendingInputBytes).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(written.join("")).toBe("hello");
    expect(view.pendingInputBytes).toBe(0);
    expect(view.pendingInput).toHaveLength(0);
  });

  it("clears input accounting on interrupt", () => {
    const { term, view, written } = hollow();
    view.inputScheduled = true;
    term.write("queued-paste");
    expect(view.pendingInputBytes).toBe("queued-paste".length);
    term.interrupt();
    expect(view.pendingInputBytes).toBe(0);
    expect(view.pendingInput).toHaveLength(0);
    expect(written).toEqual(["\x03"]);
  });

  it("feeds each quantum once, in split order", () => {
    const { term, view } = hollow();
    const quantum = `start-${"é日😀".repeat(20000)}-end`;
    const collected: string[] = [];
    term.onData = (data) => {
      collected.push(data);
    };
    view.pendingOutput.push({ data: quantum, offset: 0 });
    view.flushOutput();
    expect(collected).toEqual([...splitPtyData(quantum)]);
    expect(collected.join("")).toBe(quantum);
    expect(view.pendingOutput).toHaveLength(0);
  });

  it("retains the unadmitted tail at high-water and resumes it", () => {
    const { term, view } = hollow();
    const collected: string[] = [];
    let admissions = 0;
    term.onData = (data) => {
      admissions += 1;
      if (admissions === 2) return false;
      collected.push(data);
      return true;
    };
    const quantum = "a".repeat(200 * 1024);
    view.pendingOutput.push({ data: quantum, offset: 0 });
    view.flushOutput();
    // The rejected chunk was not consumed; the source paused for backpressure.
    expect(view.pendingOutput).toHaveLength(1);
    expect(view.pendingOutput[0]!.offset).toBe(collected.join("").length);
    term.onData = (data) => {
      collected.push(data);
    };
    term.resume();
    expect(collected.join("")).toBe(quantum);
    expect(view.pendingOutput).toHaveLength(0);
  });
});
