import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Worker } from "node:worker_threads";

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWorker extends EventEmitter {
    static created: FakeWorker[] = [];
    posted: unknown[] = [];
    constructor() {
      super();
      FakeWorker.created.push(this);
    }
    postMessage(message: unknown): void {
      this.posted.push(message);
    }
    terminate(): Promise<number> {
      return Promise.resolve(0);
    }
  }
  return { Worker: FakeWorker };
});

type FakeWorker = InstanceType<typeof Worker> & { posted: unknown[] };

function createdWorkers(): FakeWorker[] {
  return (Worker as unknown as { created: FakeWorker[] }).created;
}

describe("session-fork export-patch timeout (issue #193)", () => {
  let SessionForkClient: typeof import("../../../electron/session-fork.ts").SessionForkClient;

  beforeEach(async () => {
    vi.useFakeTimers();
    createdWorkers().length = 0;
    ({ SessionForkClient } = await import("../../../electron/session-fork.ts"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function requestIdOf(posted: unknown): string {
    return (posted as { requestId: string }).requestId;
  }

  async function dispose(client: { dispose(): Promise<void> }): Promise<void> {
    // Dispose on the real clock: the shutdown race uses timers.
    vi.useRealTimers();
    await client.dispose();
  }

  it("rejects a wedged export and drops its late reply", async () => {
    const client = new SessionForkClient();
    try {
      const pending = client.exportPatch({ files: [{ relPath: "f.ts", before: "a\n", after: "b\n" }] });
      const rejection = expect(pending).rejects.toThrow(/timed out/);
      expect(createdWorkers().length).toBe(1);
      const fake = createdWorkers()[0]!;
      expect(fake.posted.length).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;
      // The late worker reply finds no pending entry and is dropped.
      fake.emit("message", { op: "export-patch-result", requestId: requestIdOf(fake.posted[0]), ok: true, patch: "late" });
      await vi.advanceTimersByTimeAsync(60_000);
      // The client stays healthy for the next export.
      const next = client.exportPatch({ files: [] });
      fake.emit("message", { op: "export-patch-result", requestId: requestIdOf(fake.posted[1]), ok: true, patch: "" });
      await expect(next).resolves.toMatchObject({ ok: true, patch: "" });
    } finally {
      await dispose(client);
    }
  });

  it("clears the timeout when the worker replies in time", async () => {
    const client = new SessionForkClient();
    try {
      const pending = client.exportPatch({ files: [] });
      const fake = createdWorkers()[0]!;
      fake.emit("message", { op: "export-patch-result", requestId: requestIdOf(fake.posted[0]), ok: true, patch: "p" });
      await expect(pending).resolves.toMatchObject({ ok: true, patch: "p" });
      // No lingering timer settles anything after success.
      await vi.advanceTimersByTimeAsync(120_000);
    } finally {
      await dispose(client);
    }
  });
});
