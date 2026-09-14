import { describe, expect, it, vi } from "vitest";
import { MAX_PENDING_INPUT_BYTES, PtyTerminal } from "../../../electron/pty-terminal.ts";
import { splitPtyData } from "../../../electron/pty-egress.ts";

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
