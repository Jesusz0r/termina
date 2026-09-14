import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, utimesSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type * as fs from "node:fs";
import type { FSWatcher } from "node:fs";
import { SidecarEventQueue, SidecarTailer, sidecarEventFromRecord } from "../../../electron/sidecar.ts";
import type { SidecarEvent } from "../../../electron/sidecar.ts";
import { boundedSidecarEdits, createSidecarWriter } from "../../../agent-core/main/sidecar.ts";

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

describe("Wave 1 cursor throughput regressions", () => {
  it("drains a 2000-event backlog above the throughput floor (refs #185)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-throughput-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-throughput";
    const active = join(eventsDir, `${id}.jsonl`);
    const COUNT = 2000;
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
        const lines: string[] = [];
        for (let seq = 1; seq <= COUNT; seq++) {
          lines.push(JSON.stringify({ bridgeId: "flood", seq, t: "checkpoint_result", ok: true }));
        }
        const startedAt = Date.now();
        await appendFile(active, `${lines.join("\n")}\n`);
        // Floor: 2000 events in 12 s. Post-fix this takes ~1 s (poll cadence
        // plus syscall-cost persists); per-event fsync drains fail it on
        // sync-slow filesystems (APFS: ~22 s). Fast tmpfs passes either way,
        // so the no-sync syscall test below pins the design deterministically.
        await waitFor(() => received.length === COUNT, 12000, `backlog did not drain above the floor (got ${received.length}/${COUNT})`);
        expect(Date.now() - startedAt).toBeLessThan(12000);
        expect(received).toEqual(Array.from({ length: COUNT }, (_unused, index) => index + 1));
        // Every event still persists before the stream advances: the cursor
        // must cover the full backlog, not a group-committed prefix.
        const cursorPath = join(eventsDir, `.cursor-${id}.json`);
        const deadline = Date.now() + 5000;
        let sequence = 0;
        while (Date.now() < deadline) {
          try {
            sequence = JSON.parse(await readFile(cursorPath, "utf8")).sequence;
            if (sequence === COUNT) break;
          } catch {
            /* Cursor not published yet. */
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(sequence).toBe(COUNT);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("issues no fsync syscalls on the cursor path (refs #185)", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-wave1-nosync-"));
    const eventsDir = join(root, "events");
    const bundle = join(root, "sidecar.mjs");
    const signal = join(root, "cursor-sync.signal");
    process.env.TERMINA_CURSOR_SYNC_SIGNAL = signal;
    const virtualPath = "termina-cursor-sync-counter";
    const virtualSource = `
    import { link as realLink, open as realOpen, readdir as realReaddir, rename as realRename, stat as realStat, unlink as realUnlink } from "node:fs/promises";
    import { appendFileSync } from "node:fs";
    export const link = realLink;
    export const readdir = realReaddir;
    export const rename = realRename;
    export const stat = realStat;
    export const unlink = realUnlink;
    export async function open(path, ...args) {
      const handle = await realOpen(path, ...args);
      if (String(path).includes(".cursor-")) {
        const realSync = handle.sync.bind(handle);
        handle.sync = async (...syncArgs) => {
          appendFileSync(process.env.TERMINA_CURSOR_SYNC_SIGNAL, String(path) + "\\n");
          return realSync(...syncArgs);
        };
      }
      return handle;
    }
    `;
    try {
      await build({
        entryPoints: ["electron/sidecar.ts"],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: bundle,
        logLevel: "silent",
        plugins: [{
          name: "count-cursor-sync",
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^node:fs\/promises$/ }, (args) => {
              if (args.namespace === "count-fs") return { path: args.path, external: true };
              return { path: virtualPath, namespace: "count-fs" };
            });
            pluginBuild.onLoad({ filter: /.*/, namespace: "count-fs" }, () => ({ contents: virtualSource, loader: "js" }));
          },
        }],
      });
      await mkdir(eventsDir, { recursive: true });
      const id = "term-nosync";
      const active = join(eventsDir, `${id}.jsonl`);
      await writeFile(active, "");
      const { SidecarTailer: BundledTailer } = await import(pathToFileURL(bundle).href);
      const tailer = new BundledTailer(eventsDir, () => ({ close() {} }));
      const received: number[] = [];
      tailer.onEvent = (_terminalId: string, event: { seq: number }) => {
        received.push(event.seq);
        return true;
      };
      tailer.start();
      tailer.watch(id);
      try {
        const lines: string[] = [];
        for (let seq = 1; seq <= 50; seq++) {
          lines.push(JSON.stringify({ bridgeId: "sync", seq, t: "checkpoint_result", ok: true }));
        }
        await appendFile(active, `${lines.join("\n")}\n`);
        await waitFor(() => received.length === 50, 8000, "counting drain did not deliver");
        expect(existsSync(signal), "cursor persists issued fsync syscalls").toBe(false);
      } finally {
        tailer.stop();
      }
    } finally {
      delete process.env.TERMINA_CURSOR_SYNC_SIGNAL;
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});

describe("Wave 1 sidecar hardening regressions (refs #186)", () => {
  const line = (bridgeId: string, seq: number, t: string): string =>
    `${JSON.stringify({ bridgeId, seq, t })}\n`;

  it("(a) unproven sealed publications warn instead of staying silent", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-186a-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-verifywarn";
    const active = join(eventsDir, `${id}.jsonl`);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      await writeFile(active, "");
      const tailer = new SidecarTailer(eventsDir, inertWatch);
      tailer.onEvent = () => true;
      tailer.start();
      tailer.watch(id);
      try {
        await appendFile(active, line("w1", 1, "session_ready"));
        // Rotate WITHOUT a writer proof: verification must fail loudly.
        const sealedName = `.${id}.jsonl.${Date.now().toString(36)}-${process.pid}-noproof.sealed`;
        await rename(active, join(eventsDir, sealedName));
        await writeFile(active, "");
        const cursorPath = join(eventsDir, `.cursor-${id}.json`);
        const deadline = Date.now() + 10000;
        for (;;) {
          try {
            const cursor = JSON.parse(await readFile(cursorPath, "utf8"));
            if (typeof cursor.sealedSegment === "string" && cursor.sealedSegment.includes(".retained-")) break;
          } catch {
            /* Cursor not adopted yet. */
          }
          expect(Date.now() < deadline, "rotation was never reclaimed").toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(warnings.some((warning) => warning.includes("failed publication verification"))).toBe(true);
      } finally {
        tailer.stop();
      }
    } finally {
      console.warn = originalWarn;
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("(b) watcher wakes on sealed segment files", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-186b-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-segwake";
    try {
      await writeFile(join(eventsDir, `${id}.jsonl`), "");
      let listener: ((...args: unknown[]) => void) | null = null;
      const capturingWatch = (...args: unknown[]) => {
        listener = args[1] as (...inner: unknown[]) => void;
        return { close() {} };
      };
      const tailer = new SidecarTailer(eventsDir, capturingWatch as never);
      tailer.onEvent = () => true;
      tailer.start();
      tailer.watch(id);
      try {
        const captured = listener as ((...args: unknown[]) => void) | null;
        if (!captured) throw new Error("watch listener was not captured");
        captured("rename", `.${id}.jsonl.mu0qwzke-99-uuid.sealed`);
        await waitFor(() => tailer.tailWakeCounts().watch === 1, 3000, "sealed segment did not wake the watcher path");
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("(f) over-cap active lines warn once and keep draining", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-186f-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-overcap";
    const active = join(eventsDir, `${id}.jsonl`);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      await writeFile(active, "");
      const tailer = new SidecarTailer(eventsDir, inertWatch, { maxRecordBytes: 64 });
      const received: number[] = [];
      tailer.onEvent = (_terminalId, event) => {
        received.push(event.seq);
        return true;
      };
      tailer.start();
      tailer.watch(id);
      try {
        // Exactly 65 bytes per line (64 content + newline): each completes in
        // a single bounded read and skips via the shared diagnostic.
        const big = (seq: number): string => {
          const prefix = `{"bridgeId":"w1","seq":${seq},"t":"c","p":"`;
          return prefix + "x".repeat(64 - prefix.length - 2) + '"}\n';
        };
        const first = big(1);
        expect(first.length).toBe(65);
        await appendFile(active, big(1) + big(2) + big(3) + line("w1", 4, "agent_settled"));
        await waitFor(() => received.length === 1, 8000, "valid event behind over-cap lines was not delivered");
        expect(received).toEqual([4]);
        expect(warnings.filter((warning) => warning.includes("exceeds"))).toHaveLength(1);
      } finally {
        tailer.stop();
      }
    } finally {
      console.warn = originalWarn;
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("(g) fresh watch over a large sealed segment does not warn", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-186g-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-bigseal";
    const active = join(eventsDir, `${id}.jsonl`);
    try {
      await writeFile(active, "");
      let overflowCalls = 0;
      const tailer = new SidecarTailer(eventsDir, inertWatch, {
        maxBacklogBytes: 1024,
        onBacklogOverflow: () => {
          overflowCalls++;
        },
      });
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
        await appendFile(active, "\n".repeat(2048));
        await rename(active, join(eventsDir, `.${id}.jsonl.${Date.now().toString(36)}-${process.pid}-big.sealed`));
        await writeFile(active, line("w1", 3, "agent_settled"));
        await waitFor(() => received.length === 3, 10000, "post-rotation event was not delivered");
        // Let several poll ticks run: an unpaused draining terminal must stay quiet.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(overflowCalls).toBe(0);
        expect(tailer.isPaused(id)).toBe(false);
        expect((await readdir(eventsDir)).filter((name) => name.startsWith(`.quarantine-${id}`))).toEqual([]);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("(g) settled anchor growth is observed after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-186gr-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-regrow";
    const active = join(eventsDir, `${id}.jsonl`);
    try {
      await writeFile(active, "");
      const first = new SidecarTailer(eventsDir, inertWatch, { maxBacklogBytes: 1024 });
      const received: number[] = [];
      first.onEvent = (_terminalId, event) => {
        received.push(event.seq);
        return true;
      };
      first.start();
      first.watch(id);
      await appendFile(active, line("w1", 1, "session_ready"));
      await waitFor(() => received.length === 1, 5000, "setup record was not delivered");
      await rename(active, join(eventsDir, `.${id}.jsonl.${Date.now().toString(36)}-${process.pid}-grow.sealed`));
      await writeFile(active, "");
      const settled = async (): Promise<string | null> => {
        const names = await readdir(eventsDir);
        if (names.some((name) => name.endsWith(".sealed"))) return null;
        const anchors = names.filter((name) => name.includes(".retained-"));
        return anchors.length === 1 ? anchors[0]! : null;
      };
      const firstDeadline = Date.now() + 10000;
      while ((await settled()) === null && Date.now() < firstDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const anchor = await settled();
      expect(anchor, "rotation never settled").not.toBeNull();
      first.stop();

      // Restart over the settled anchor: quiet while drained, loud on growth.
      const second = new SidecarTailer(eventsDir, inertWatch, { maxBacklogBytes: 1024 });
      second.onEvent = () => true;
      second.start();
      second.watch(id);
      try {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const quiet = second.tailWakeCounts();
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(second.tailWakeCounts()).toEqual(quiet);
        // An escaped descriptor growing the anchor behind the drain.
        await appendFile(join(eventsDir, anchor!), "x".repeat(2048));
        const deadline = Date.now() + 8000;
        const quarantined = async (): Promise<boolean> => {
          try {
            await readFile(join(eventsDir, `.quarantine-${id}`), "utf8");
            return second.isPaused(id);
          } catch {
            return false;
          }
        };
        while (!(await quarantined()) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        expect(await quarantined(), "anchor growth after restart was not observed").toBe(true);
      } finally {
        second.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("(h) watch rejects malformed terminal ids without side effects", async () => {    const root = await mkdtemp(join(tmpdir(), "termina-186h-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    try {
      const tailer = new SidecarTailer(eventsDir, inertWatch);
      tailer.onEvent = () => true;
      tailer.start();
      const evil = `../../evil-186h-${Date.now().toString(36)}`;
      try {
        tailer.watch(evil);
        tailer.watch("has space");
        tailer.watch("dot.in.name");
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(tailer.tailWakeCounts()).toEqual({ poll: 0, watch: 0 });
        expect(await readdir(eventsDir)).toEqual([]);
        expect(existsSync(resolve(eventsDir, `.cursor-${evil}.json`))).toBe(false);
        expect((await readdir(root)).filter((name) => name !== "events")).toEqual([]);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("(j) startup sweeps stale tmps and keeps live ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-186j-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-tmp";
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const deadPid = `.cursor-${id}.json.99999999.${uuid}.tmp`;
    const oldWriter = `.quarantine-${id}.${uuid}.tmp`;
    const freshWriter = `.quarantine-${id}.bbbbbbbb-cccc-dddd-eeee-ffffffffffff.tmp`;
    const livePid = `.cursor-${id}.json.${process.pid}.cccccccc-dddd-eeee-ffff-000000000000.tmp`;
    const foreign = `unrelated.99999999.${uuid}.tmp`;
    try {
      await writeFile(join(eventsDir, deadPid), "stale tailer tmp");
      await writeFile(join(eventsDir, oldWriter), "stale writer tmp");
      const old = new Date(Date.now() - 120_000);
      utimesSync(join(eventsDir, oldWriter), old, old);
      await writeFile(join(eventsDir, freshWriter), "live writer tmp");
      await writeFile(join(eventsDir, livePid), "live tailer tmp");
      await writeFile(join(eventsDir, foreign), "foreign tmp");
      const tailer = new SidecarTailer(eventsDir, inertWatch);
      tailer.start();
      try {
        const names = await readdir(eventsDir);
        expect(names.includes(deadPid)).toBe(false);
        expect(names.includes(oldWriter)).toBe(false);
        expect(names.includes(freshWriter)).toBe(true);
        expect(names.includes(livePid)).toBe(true);
        expect(names.includes(foreign)).toBe(true);
      } finally {
        tailer.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("(k) truncation digests stay exact when small and bounded when huge", async () => {
    // Small truncated input: the digest must equal a full-content hash.
    const small = [{ oldText: "a", newText: "b" }, 12345];
    const smallBounded = boundedSidecarEdits(small) ?? {};
    expect(smallBounded.editsTruncated).toBe(true);
    const smallSerialized = JSON.stringify(small);
    expect(smallBounded.editsBytes).toBe(Buffer.byteLength(smallSerialized, "utf8"));
    expect(smallBounded.editsCount).toBe(2);
    expect(smallBounded.editsSha256).toBe(createHash("sha256").update(smallSerialized, "utf8").digest("hex"));
    // Huge input: exact bytes/count, bounded preview, capped (prefix) digest.
    const huge = [{ oldText: "y".repeat(10 * 1024 * 1024), newText: "z" }];
    const hugeBounded = boundedSidecarEdits(huge) ?? {};
    expect(hugeBounded.editsTruncated).toBe(true);
    expect(hugeBounded.editsBytes).toBe(Buffer.byteLength(JSON.stringify(huge), "utf8"));
    expect(hugeBounded.editsCount).toBe(1);
    expect(typeof hugeBounded.editsSha256).toBe("string");
    expect(hugeBounded.editsSha256).not.toBe(
      createHash("sha256").update(JSON.stringify(huge), "utf8").digest("hex"),
    );
    expect(Buffer.byteLength(JSON.stringify(hugeBounded.edits), "utf8")).toBeLessThanOrEqual(512 * 1024);
  }, 30000);

  it("(l) large appends stay exact at scale", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-186l-"));
    const eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
    const id = "term-bigappend";
    const active = join(eventsDir, `${id}.jsonl`);
    try {
      await writeFile(active, "");
      const writer = createSidecarWriter({ eventsDir, terminalId: id, bridgeId: "writer-1" });
      const startedAt = Date.now();
      for (let index = 0; index < 50; index++) {
        writer.logEvent({ t: "tool", toolName: "edit", path: `file-${index}.txt`, bulk: "a".repeat(64 * 1024) });
      }
      expect(Date.now() - startedAt).toBeLessThan(15000);
      expect(writer.isWriteStopped()).toBe(false);
      const lines = (await readFile(active, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(50);
      const seqs = lines.map((entry, position) => {
        const rec = JSON.parse(entry) as { seq: number; generation: string };
        expect(rec.seq).toBe(position + 1);
        return rec.seq;
      });
      expect(seqs).toHaveLength(50);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("(m) hostile edit previews are capped and flagged", async () => {
    const tool = (edits: unknown): Record<string, unknown> | null =>
      sidecarEventFromRecord({ bridgeId: "b", seq: 1, t: "tool", toolName: "edit", path: "f", edits }) as unknown as Record<string, unknown> | null;
    // Control: a fitting preview passes through untouched.
    const fitting = tool([{ oldText: "aaa", newText: "bbb" }]);
    expect(fitting?.edits).toEqual([{ oldText: "aaa", newText: "bbb" }]);
    expect(fitting?.editsTruncated).toBeUndefined();
    // Hostile element flood: bounded count, flagged truncation.
    const flood = Array.from({ length: 100_000 }, () => ({ oldText: "o", newText: "n" }));
    const flooded = tool(flood);
    expect((flooded?.edits as unknown[]).length).toBeLessThanOrEqual(65536);
    expect(flooded?.editsTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(flooded?.edits), "utf8")).toBeLessThan(600 * 1024);
    // Hostile field flood: clipped fields, flagged truncation.
    const wide = tool([{ oldText: "x".repeat(2 * 1024 * 1024), newText: "y" }]);
    const admitted = (wide?.edits as Array<{ oldText?: string }>) ?? [];
    expect(admitted).toHaveLength(1);
    expect(Buffer.byteLength(admitted[0]?.oldText ?? "", "utf8")).toBeLessThanOrEqual(128 * 1024);
    expect(wide?.editsTruncated).toBe(true);
    // Junk elements are dropped and flagged.
    const junk = tool([0, null, "x", { oldText: "a" }]);
    expect(junk?.edits).toEqual([{ oldText: "a" }]);
    expect(junk?.editsTruncated).toBe(true);
  }, 30000);

  it("(p) event byte sizes are cached across enqueue attempts", async () => {
    const event: SidecarEvent = { bridgeId: "b", seq: 1, t: "agent_start" };
    const realStringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((...args: [unknown, ...unknown[]]) => {
      if (args[0] === event) calls++;
      return (realStringify as (...inner: unknown[]) => string)(...args);
    }) as typeof JSON.stringify;
    try {
      const queue = new SidecarEventQueue(async () => {}, { maxItems: 8, maxBytes: 1_000_000 });
      expect(queue.enqueue(event)).toBe(true);
      expect(queue.enqueue(event)).toBe(true);
      await queue.drain();
      expect(calls).toBe(1);
      queue.dispose();
    } finally {
      JSON.stringify = realStringify;
    }
  }, 30000);
});
