import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

describe("Wave 1 sidecar anchor chaining regressions", () => {
  const line = (bridgeId: string, seq: number, t: string): string =>
    `${JSON.stringify({ bridgeId, seq, t })}\n`;
  const sealedName = (id: string, tag: string): string =>
    `.${id}.jsonl.${Date.now().toString(36)}-${process.pid}-${tag}.sealed`;

  it("stays quiet while idle after a rotation settles (refs #183)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-idle-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-idle";
    const active = join(eventsDir, `${id}.jsonl`);
    try {
      await writeFile(active, "");
      const tailer = new SidecarTailer(eventsDir, inertWatch);
      const received: number[] = [];
      tailer.onEvent = (_terminalId, event) => {
        received.push(event.seq);
        return true;
      };
      tailer.start();
      tailer.watch(id);
      try {
        await appendFile(active, line("w1", 1, "session_ready") + line("w1", 2, "agent_settled"));
        await waitFor(() => received.length === 2, 5000, "initial records were not delivered");
        await rename(active, join(eventsDir, sealedName(id, "idle1")));
        await writeFile(active, line("w1", 3, "agent_settled"));
        await waitFor(() => received.length === 3, 10000, "rotated records were not delivered");
        const settled = async (): Promise<boolean> => {
          const names = await readdir(eventsDir);
          return !names.some((name) => name.endsWith(".sealed"))
            && names.some((name) => name.includes(".retained-"));
        };
        const deadline = Date.now() + 10000;
        while (!(await settled()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await settled(), "rotation never settled to a retained anchor").toBe(true);
        // Let any in-flight pass finish, then measure a 1.5 s idle window.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const wakesBefore = tailer.tailWakeCounts();
        const cursorBefore = (await stat(join(eventsDir, `.cursor-${id}.json`))).mtimeMs;
        await new Promise((resolve) => setTimeout(resolve, 1600));
        expect(tailer.tailWakeCounts()).toEqual(wakesBefore);
        expect((await stat(join(eventsDir, `.cursor-${id}.json`))).mtimeMs).toBe(cursorBefore);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("survives two successive rotations with one settled anchor (refs #183)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-chain-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-chain";
    const active = join(eventsDir, `${id}.jsonl`);
    const settledAnchor = async (): Promise<string | null> => {
      const names = await readdir(eventsDir);
      if (names.some((name) => name.endsWith(".sealed"))) return null;
      const anchors = names.filter((name) => name.includes(".retained-"));
      return anchors.length === 1 ? anchors[0] : null;
    };
    try {
      await writeFile(active, "");
      const tailer = new SidecarTailer(eventsDir, inertWatch);
      const received: number[] = [];
      tailer.onEvent = (_terminalId, event) => {
        received.push(event.seq);
        return true;
      };
      tailer.start();
      tailer.watch(id);
      try {
        await appendFile(active, line("w1", 1, "session_ready") + line("w1", 2, "agent_start"));
        await waitFor(() => received.length === 2, 5000, "initial records were not delivered");

        // First rotation: seal [1,2], continue with [3,4] on the new active.
        await rename(active, join(eventsDir, sealedName(id, "chain1")));
        await writeFile(active, line("w1", 3, "agent_start") + line("w1", 4, "agent_settled"));
        await waitFor(() => received.length === 4, 10000, "first rotation did not drain");
        const firstDeadline = Date.now() + 10000;
        while ((await settledAnchor()) === null && Date.now() < firstDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const firstAnchor = await settledAnchor();
        expect(firstAnchor, "first rotation never settled to one anchor").not.toBeNull();

        // Second rotation beside the settled anchor: seal [3,4], continue [5,6].
        await rename(active, join(eventsDir, sealedName(id, "chain2")));
        await writeFile(active, line("w1", 5, "agent_start") + line("w1", 6, "agent_settled"));
        await waitFor(() => received.length === 6, 15000, "second rotation did not drain");
        expect(received).toEqual([1, 2, 3, 4, 5, 6]);
        const secondDeadline = Date.now() + 10000;
        while ((await settledAnchor()) === null && Date.now() < secondDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const secondAnchor = await settledAnchor();
        expect(secondAnchor, "second rotation never settled to one anchor").not.toBeNull();
        expect(secondAnchor).not.toBe(firstAnchor);
        const names = await readdir(eventsDir);
        expect(names.filter((name) => name.startsWith(`.quarantine-${id}`))).toEqual([]);
        const cursor = JSON.parse(await readFile(join(eventsDir, `.cursor-${id}.json`), "utf8"));
        expect(cursor.sequence).toBe(6);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);

  it("writer rotates beside a settled retained anchor (refs #183)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-writerchain-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-wchain";
    const active = join(eventsDir, `${id}.jsonl`);
    try {
      await writeFile(active, "\n".repeat(8 * 1024 * 1024 + 64));
      const writer = createSidecarWriter({ eventsDir, terminalId: id, bridgeId: "writer-1" });
      writer.logEvent({ t: "session_ready", ok: true });
      const firstSeals = (await readdir(eventsDir)).filter((name) => name.endsWith(".sealed"));
      expect(firstSeals).toHaveLength(1);
      // Simulate a settled tailer reclaim: the sealed name becomes a lone
      // retained anchor (writer only observes names, never inode state).
      await rename(join(eventsDir, firstSeals[0]), join(eventsDir, `${firstSeals[0]}.retained-simulated`));
      await appendFile(active, "\n".repeat(8 * 1024 * 1024 + 64));
      writer.logEvent({ t: "agent_settled" });
      expect(writer.isWriteStopped()).toBe(false);
      const names = await readdir(eventsDir);
      expect(names.filter((name) => name.endsWith(".sealed"))).toHaveLength(1);
      expect(names.filter((name) => name.includes(".retained-"))).toHaveLength(1);
      expect(names.filter((name) => name.startsWith(`.quarantine-${id}`))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});

describe("Wave 1 quarantine launch-scope regressions", () => {
  const line = (bridgeId: string, seq: number, t: string): string =>
    `${JSON.stringify({ bridgeId, seq, t })}\n`;
  /** A pid above every platform's pid_max: deterministically dead. */
  const DEAD_PID = 99999999;

  async function writeStaleLaunch(id: string, eventsDir: string, marker: Record<string, unknown>): Promise<void> {
    const active = join(eventsDir, `${id}.jsonl`);
    const sealedName = `.${id}.jsonl.${Date.now().toString(36)}-${DEAD_PID}-stale.sealed`;
    await writeFile(join(eventsDir, sealedName), line("old-bridge", 1, "agent_start") + line("old-bridge", 2, "agent_settled"));
    await writeFile(active, "");
    await writeFile(
      join(eventsDir, `.cursor-${id}.json`),
      JSON.stringify({ version: 1, offset: 0, bridgeId: "old-bridge", sequence: 2 }),
    );
    await writeFile(join(eventsDir, `.quarantine-${id}`), `${JSON.stringify({ version: 1, state: "quarantined", terminalId: id, ...marker })}\n`);
  }

  it("ignores an unbound stale quarantine marker on id recycle (refs #184)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-recycle-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-recycle";
    try {
      await writeStaleLaunch(id, eventsDir, { reason: "stale previous-launch marker" });
      const tailer = new SidecarTailer(eventsDir, inertWatch);
      const received: Array<{ bridgeId: string; seq: number }> = [];
      tailer.onEvent = (_terminalId, event) => {
        received.push({ bridgeId: event.bridgeId, seq: event.seq });
        return true;
      };
      tailer.start();
      tailer.watch(id);
      try {
        // A stale marker must not stop a brand-new terminal: watch-time
        // quarantine inheritance is synchronous, so this is deterministic.
        expect(tailer.isPaused(id)).toBe(false);
        await appendFile(join(eventsDir, `${id}.jsonl`), line("new-bridge", 1, "session_ready") + line("new-bridge", 2, "agent_start"));
        await waitFor(() => received.length === 2, 10000, "recycled terminal did not go live");
        expect(received).toEqual([
          { bridgeId: "new-bridge", seq: 1 },
          { bridgeId: "new-bridge", seq: 2 },
        ]);
        // Stale markers are ignored, not swept: the file remains but gates nothing.
        const names = await readdir(eventsDir);
        expect(names.filter((name) => name === `.quarantine-${id}`)).toHaveLength(1);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("ignores a dead-producer quarantine marker on id recycle (refs #184)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-recyclepid-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-recyclepid";
    try {
      await writeStaleLaunch(id, eventsDir, { reason: "dead producer", producerPid: DEAD_PID });
      const tailer = new SidecarTailer(eventsDir, inertWatch);
      const received: number[] = [];
      tailer.onEvent = (_terminalId, event) => {
        received.push(event.seq);
        return true;
      };
      tailer.start();
      tailer.watch(id);
      try {
        expect(tailer.isPaused(id)).toBe(false);
        await appendFile(join(eventsDir, `${id}.jsonl`), line("new-bridge", 1, "session_ready"));
        await waitFor(() => received.length === 1, 10000, "recycled terminal did not go live");
        expect(tailer.isPaused(id)).toBe(false);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("honors a live quarantine marker across re-watch (refs #184)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-liveq-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-liveq";
    try {
      // Two retained anchors with different identities: a genuine structural
      // race the tailer must quarantine (and keep quarantined on re-watch).
      await writeFile(join(eventsDir, `.${id}.jsonl.a1.sealed.retained-aaa`), line("b1", 1, "agent_start"));
      await writeFile(join(eventsDir, `.${id}.jsonl.a2.sealed.retained-bbb`), line("b1", 1, "agent_start"));
      await writeFile(join(eventsDir, `${id}.jsonl`), "");
      const tailer = new SidecarTailer(eventsDir, inertWatch);
      tailer.onEvent = () => true;
      tailer.start();
      tailer.watch(id);
      try {
        const markerPath = join(eventsDir, `.quarantine-${id}`);
        const quarantined = async (): Promise<boolean> => {
          try {
            await readFile(markerPath, "utf8");
            return tailer.isPaused(id);
          } catch {
            return false;
          }
        };
        const deadline = Date.now() + 8000;
        while (!(await quarantined()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
        expect(await quarantined(), "genuine multi-identity race did not quarantine").toBe(true);
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        expect(marker.state).toBe("quarantined");
        expect(marker.producerPid).toBe(process.pid);
        expect("bootId" in marker).toBe(true);
        // A re-watch in the same launch must inherit the live quarantine.
        tailer.stopWatching(id);
        expect(tailer.isPaused(id)).toBe(false);
        tailer.watch(id);
        expect(tailer.isPaused(id)).toBe(true);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("writer quarantine markers carry producer binding (refs #184)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-writerq-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-writerq";
    try {
      // A mid-flight reclaim link blocks rotation, forcing the writer down
      // its quarantine path synchronously.
      await writeFile(join(eventsDir, `${id}.jsonl`), "\n".repeat(8 * 1024 * 1024 + 64));
      await writeFile(join(eventsDir, `.${id}.jsonl.blocker.draining-zzz`), "mid-flight");
      const writer = createSidecarWriter({ eventsDir, terminalId: id, bridgeId: "writer-1" });
      writer.logEvent({ t: "session_ready", ok: true });
      const marker = JSON.parse(await readFile(join(eventsDir, `.quarantine-${id}`), "utf8"));
      expect(marker.state).toBe("quarantined");
      expect(marker.producerPid).toBe(process.pid);
      expect("bootId" in marker).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
