import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as fs from "node:fs";
import type { FSWatcher } from "node:fs";
import { SidecarEventQueue, SidecarTailer } from "../../../electron/sidecar.ts";
import type { SidecarEvent } from "../../../electron/sidecar.ts";
import { createSidecarWriter } from "../../../agent-core/main/sidecar.ts";

/** fs.watch-shaped fake that never fires; the recovery poll drives tails. */
const inertWatch: typeof fs.watch = (..._args: unknown[]) =>
  Object.assign(new EventEmitter(), { close() {} }) as FSWatcher;

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(predicate(), message).toBe(true);
}

describe("Wave 1 sidecar rotation regressions", () => {
  it("drains a real writer seal: dotted name, delivery, reclaim (refs #180)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-seal-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-seal";
    const active = join(eventsDir, `${id}.jsonl`);
    try {
      // Fill the active file past the 8 MiB rotation boundary with blank
      // lines (skipped by every consumer), then seal with the real writer.
      await writeFile(active, "\n".repeat(8 * 1024 * 1024 + 64));
      const writer = createSidecarWriter({ eventsDir, terminalId: id, bridgeId: "writer-1" });
      writer.logEvent({ t: "session_ready", ok: true });
      expect(writer.isWriteStopped()).toBe(false);

      const names = await readdir(eventsDir);
      const sealed = names.filter((name) => name.endsWith(".sealed"));
      expect(sealed).toHaveLength(1);
      expect(sealed[0].startsWith(`.${id}.jsonl.`)).toBe(true);
      expect(names.filter((name) => name.startsWith(`${id}.jsonl.`))).toEqual([]);

      // Fresh watch must drain the sealed tail and reclaim the seal.
      const tailer = new SidecarTailer(eventsDir, inertWatch);
      const received: number[] = [];
      tailer.onEvent = (_terminalId, event) => {
        received.push(event.seq);
        return true;
      };
      tailer.start();
      tailer.watch(id);
      try {
        await waitFor(() => received.length === 1, 15000, "sealed rotation did not deliver the post-rotation event");
        expect(received).toEqual([1]);
        const sealedGone = async (): Promise<boolean> =>
          (await readdir(eventsDir)).filter((name) => name.endsWith(".sealed")).length === 0;
        const deadline = Date.now() + 15000;
        while (!(await sealedGone()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await sealedGone(), "sealed generation was never reclaimed").toBe(true);
        const after = await readdir(eventsDir);
        expect(after.filter((name) => name.startsWith(`.quarantine-${id}`))).toEqual([]);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("drains a rotation beside a stale active partial (refs #181)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-stale-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-stale";
    const active = join(eventsDir, `${id}.jsonl`);
    const line = (bridgeId: string, seq: number, t: string): string =>
      `${JSON.stringify({ bridgeId, seq, t })}\n`;
    try {
      const tailer = new SidecarTailer(eventsDir, inertWatch);
      const received: number[] = [];
      let rejectedOnce = false;
      tailer.onEvent = (_terminalId, event) => {
        // Reject seq 3 once so the record sticks at the active cursor as a
        // stale partial; accept everything on redelivery.
        if (event.seq === 3 && !rejectedOnce) {
          rejectedOnce = true;
          return false;
        }
        received.push(event.seq);
        return true;
      };
      tailer.start();
      tailer.watch(id);
      await appendFile(active, line("w1", 1, "session_ready") + line("w1", 2, "agent_start"));
      try {
        await waitFor(() => received.length === 2, 5000, "initial active records were not delivered");
        await appendFile(active, line("w1", 3, "agent_settled"));
        await waitFor(() => tailer.isPaused(id), 5000, "rejected record did not pause the tailer");

        // External rotation beside the stale partial: the pre-rotation bytes
        // (including the rejected seq 3) move to a dotted sealed segment.
        const sealedName = `.${id}.jsonl.${Date.now().toString(36)}-${process.pid}-wave1a2b.sealed`;
        await rename(active, join(eventsDir, sealedName));
        await writeFile(active, line("w1", 4, "agent_start") + line("w1", 5, "agent_settled"));
        tailer.resume(id);

        await waitFor(() => received.length === 5, 15000, "rotation beside a stale partial stalled the drain");
        expect(received).toEqual([1, 2, 3, 4, 5]);
        const names = await readdir(eventsDir);
        expect(names.filter((name) => name.startsWith(`.quarantine-${id}`))).toEqual([]);
        const cursor = JSON.parse(await readFile(join(eventsDir, `.cursor-${id}.json`), "utf8"));
        expect(cursor.sequence).toBe(5);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});

describe("Wave 1 sidecar queue dead-letter regressions", () => {
  const boundary = (seq: number): SidecarEvent => ({ bridgeId: "bridge", seq, t: "agent_start", sessionId: String(seq) });

  it("dead-letters a poison event so drain() resolves (refs #182)", async () => {
    let handlerCalls = 0;
    const deadLetters: Array<{ event: SidecarEvent; attempts: number }> = [];
    const queue = new SidecarEventQueue(
      async () => {
        handlerCalls++;
        throw new Error("poison handler always fails");
      },
      {
        maxHandlerAttempts: 3,
        onDeadLetter: (event, _error, attempts) => {
          deadLetters.push({ event, attempts });
        },
      },
    );
    const first = queue.enqueueTracked(boundary(1));
    const second = queue.enqueueTracked(boundary(2));
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);

    // Pre-fix this never resolved: the failing handler was retried forever.
    await queue.drain();

    expect(handlerCalls).toBe(6);
    expect(deadLetters.map((entry) => [entry.event.seq, entry.attempts])).toEqual([[1, 3], [2, 3]]);
    expect(queue.stats().deadLettered).toBe(2);
    // A dead-lettered event is skipped, not replayed: its acknowledgement
    // resolves so the tailer advances past the poison record.
    await expect(first.completed).resolves.toBeUndefined();
    await expect(second.completed).resolves.toBeUndefined();
    queue.dispose();
  }, 10000);

  it("recovers transient handler failures without dead-lettering (refs #182)", async () => {
    let handlerCalls = 0;
    const delivered: number[] = [];
    const queue = new SidecarEventQueue(
      async (event) => {
        handlerCalls++;
        if (handlerCalls <= 2) throw new Error("transient failure");
        delivered.push(event.seq);
      },
      { maxHandlerAttempts: 3, onDeadLetter: () => { throw new Error("must not dead-letter a transient"); } },
    );
    const delivery = queue.enqueueTracked(boundary(7));
    expect(delivery.accepted).toBe(true);
    await queue.drain();
    await expect(delivery.completed).resolves.toBeUndefined();
    expect(delivered).toEqual([7]);
    expect(handlerCalls).toBe(3);
    expect(queue.stats().deadLettered).toBe(0);
    queue.dispose();
  }, 10000);
});
