import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

vi.mock("node:child_process");

const mockSpawn = vi.mocked(spawn);

type FakeStdio = EventEmitter & { written: string[]; write(chunk: string): boolean; setEncoding(enc: string): void };
type FakeChild = EventEmitter & {
  stdin: FakeStdio;
  stdout: FakeStdio;
  stderr: FakeStdio;
  killCalls: number;
  writtenLines: () => string[];
};

function makeStdio(): FakeStdio {
  const stdio = new EventEmitter() as FakeStdio;
  stdio.written = [];
  stdio.write = (chunk: string): boolean => {
    stdio.written.push(chunk);
    return true;
  };
  stdio.setEncoding = (): void => undefined;
  return stdio;
}

function makeChild(killImpl?: () => boolean): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = makeStdio();
  child.stdout = makeStdio();
  child.stderr = makeStdio();
  child.killCalls = 0;
  const kill = killImpl ?? (() => true);
  (child as unknown as { kill: () => boolean }).kill = () => {
    child.killCalls += 1;
    return kill();
  };
  child.writtenLines = () => child.stdin.written;
  return child;
}

function requestIdOf(line: string): string {
  return (JSON.parse(line) as { requestId: string }).requestId;
}

describe("CoreClient retiring-child lifecycle (issue #154)", () => {
  let children: FakeChild[];
  // Imported per test so each client binds the current fake-timer clock.
  let CoreClient: typeof import("../../../electron/worldline-git/core-process.ts").CoreClient;

  beforeEach(async () => {
    vi.useFakeTimers();
    children = [];
    mockSpawn.mockImplementation(((() => {
      const child = makeChild();
      children.push(child);
      return child;
    }) as unknown) as typeof spawn);
    ({ CoreClient } = await import("../../../electron/worldline-git/core-process.ts"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("holds the queued request through a delayed exit, then runs it on exactly one replacement", async () => {
    const client = new CoreClient();
    try {
      const first = client.request({ op: "first" });
      const second = client.request({ op: "second" });
      const firstRejection = expect(first).rejects.toThrow(/timed out/);
      // Serial dispatch: only the first request reaches the first child.
      expect(children.length).toBe(1);
      const dying = children[0]!;
      expect(dying.writtenLines().length).toBe(1);

      // Fire the ten-minute deadline with the exit delayed.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await firstRejection;
      expect(dying.killCalls).toBe(1);
      // The queued request must not reach the dying child; no replacement
      // writer may start until the old child has stopped.
      expect(dying.writtenLines().length).toBe(1);
      expect(children.length).toBe(1);

      // Stale output from the dying child cannot settle the queued request.
      dying.stdout.emit("data", `${JSON.stringify({ op: "second-result", requestId: "cap-2", ok: true, state: { poison: true } })}\n`);
      dying.emit("exit", null, null);

      expect(children.length).toBe(2);
      const replacement = children[1]!;
      expect(replacement.writtenLines().length).toBe(1);
      const secondId = requestIdOf(replacement.writtenLines()[0]!);
      // A stale line with the right id from the wrong child is still ignored.
      dying.stdout.emit("data", `${JSON.stringify({ op: "second-result", requestId: secondId, ok: true, state: { poison: true } })}\n`);
      replacement.stdout.emit("data", `${JSON.stringify({ op: "second-result", requestId: secondId, ok: true, state: { value: "second" } })}\n`);
      await expect(second).resolves.toEqual({ value: "second" });

      // Recovery reuses the replacement; accounting drains.
      const third = client.request({ op: "third" });
      expect(children.length).toBe(2);
      const thirdId = requestIdOf(replacement.writtenLines()[1]!);
      replacement.stdout.emit("data", `${JSON.stringify({ op: "third-result", requestId: thirdId, ok: true, state: { value: "third" } })}\n`);
      await expect(third).resolves.toEqual({ value: "third" });
      expect(client.queueStats()).toEqual({ items: 0, bytes: 0, inFlight: 0, inFlightBytes: 0 });
    } finally {
      client.dispose();
    }
  });

  it("dispose during retirement rejects the queue and never spawns a replacement", async () => {
    const client = new CoreClient();
    try {
      const first = client.request({ op: "first" });
      const second = client.request({ op: "second" });
      const firstRejection = expect(first).rejects.toThrow(/timed out/);
      const secondRejection = expect(second).rejects.toThrow(/disposed/);
      expect(children.length).toBe(1);
      const dying = children[0]!;

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await firstRejection;
      client.dispose();
      await secondRejection;
      expect(children.length).toBe(1);

      // The late exit is harmless: no resurrection, no replacement.
      dying.emit("exit", null, null);
      expect(children.length).toBe(1);
      await expect(client.request({ op: "late" })).rejects.toThrow(/disposed/);
      expect(client.queueStats().items).toBe(0);
    } finally {
      client.dispose();
    }
  });

  it("a failed kill signal still retires the child and recovers after its exit", async () => {
    children = [];
    mockSpawn.mockImplementation(((() => {
      const child = makeChild(() => {
        throw new Error("ESRCH: no such process");
      });
      children.push(child);
      return child;
    }) as unknown) as typeof spawn);
    const client = new CoreClient();
    try {
      const first = client.request({ op: "first" });
      const second = client.request({ op: "second" });
      const firstRejection = expect(first).rejects.toThrow(/timed out/);
      expect(children.length).toBe(1);
      const dying = children[0]!;

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await firstRejection;
      expect(dying.killCalls).toBe(1);
      expect(dying.writtenLines().length).toBe(1);
      expect(children.length).toBe(1);

      dying.emit("exit", null, null);
      expect(children.length).toBe(2);
      const replacement = children[1]!;
      const secondId = requestIdOf(replacement.writtenLines()[0]!);
      replacement.stdout.emit("data", `${JSON.stringify({ op: "second-result", requestId: secondId, ok: true, state: { value: "second" } })}\n`);
      await expect(second).resolves.toEqual({ value: "second" });
      expect(client.queueStats()).toEqual({ items: 0, bytes: 0, inFlight: 0, inFlightBytes: 0 });
    } finally {
      client.dispose();
    }
  });

  it("rejects the in-flight request on a malformed protocol line without waiting for the timeout", async () => {
    const client = new CoreClient();
    try {
      const first = client.request({ op: "first" });
      const second = client.request({ op: "second" });
      expect(children.length).toBe(1);
      const child = children[0]!;
      expect(child.writtenLines().length).toBe(1);

      // Inject garbage on the live child's stdout. The ten-minute timer must
      // not be the recovery: fail the in-flight request immediately, then
      // dispatch the queued op on the same child.
      child.stdout.emit("data", "not-json{\n");
      await expect(first).rejects.toThrow(/malformed protocol line/);
      expect(child.killCalls).toBe(0);
      expect(children.length).toBe(1);
      expect(child.writtenLines().length).toBe(2);

      const secondId = requestIdOf(child.writtenLines()[1]!);
      child.stdout.emit("data", `${JSON.stringify({ op: "second-result", requestId: secondId, ok: true, state: { value: "second" } })}\n`);
      await expect(second).resolves.toEqual({ value: "second" });
      expect(client.queueStats()).toEqual({ items: 0, bytes: 0, inFlight: 0, inFlightBytes: 0 });
    } finally {
      client.dispose();
    }
  });
});
