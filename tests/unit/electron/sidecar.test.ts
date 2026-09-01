import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarEventQueue, SidecarTailer } from "../../../electron/sidecar.ts";
import { boundedSidecarEdits, SIDECAR_TOOL_EDIT_PREVIEW_BYTES } from "../../../agent-core/main.ts";

describe("Electron Sidecar Envelope, Tailer & Queue Flow Control", () => {
  let root: string;
  let eventsDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "termina-sidecar-vitest-"));
    eventsDir = join(root, "events");
    await mkdir(eventsDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("Sidecar Producer Envelope Bounding", () => {
    it("bounds oversized producer edits and retains truncation boundary", () => {
      const oldText = "old-".repeat(2 * 1024 * 1024);
      const newText = "new-".repeat(2 * 1024 * 1024);
      const bounded = boundedSidecarEdits([{ oldText, newText }]);
      const envelope = {
        bridgeId: "producer",
        seq: 1,
        t: "tool",
        toolName: "edit",
        path: "large.txt",
        toolCallId: "call-large",
        ...bounded,
      };

      expect(envelope.editsTruncated).toBe(true);
      expect(envelope.editsBytes).toBeGreaterThan(8 * 1024 * 1024);
      expect(typeof envelope.editsSha256).toBe("string");
      expect(envelope.editsCount).toBe(1);
      expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThan(8 * 1024 * 1024);
      expect(Buffer.byteLength(JSON.stringify(envelope.edits), "utf8")).toBeLessThanOrEqual(SIDECAR_TOOL_EDIT_PREVIEW_BYTES);
    });
  });

  describe("SidecarEventQueue Backpressure & Coalescing", () => {
    const deferred = () => {
      let resolve: any;
      const promise = new Promise((res) => { resolve = res; });
      return { promise, resolve };
    };

    it("coalesces adjacent replaceable progress events and enforces item limits", async () => {
      const first = deferred();
      const delivered: any[] = [];
      const queue = new SidecarEventQueue(
        async (event: any) => {
          if (event.seq === 1) await first.promise;
          delivered.push(event);
        },
        { maxItems: 3, maxBytes: 16 * 1024 },
      );
      const boundary = (seq: number) => ({ bridgeId: "bridge", seq, t: "agent_start", sessionId: String(seq) });
      const plan = (seq: number, text: string) => ({ bridgeId: "bridge", seq, t: "plan", text });

      expect(queue.enqueue(boundary(1))).toBe(true);
      expect(queue.enqueue(plan(2, "old"))).toBe(true);
      expect(queue.enqueue(plan(3, "latest"))).toBe(true); // adjacent progress coalesces
      expect(queue.enqueue(boundary(4))).toBe(true);
      expect(queue.enqueue(boundary(5))).toBe(false); // backpressure!
      expect(queue.stats().items).toBe(3);
      expect(queue.stats().bytes).toBeGreaterThan(0);

      first.resolve();
      await queue.drain();
      expect(delivered.map((event) => [event.t, event.seq, event.text])).toEqual([
        ["agent_start", 1, undefined],
        ["plan", 3, "latest"],
        ["agent_start", 4, undefined],
      ]);
    });

    it("enforces byte limits on incoming events", async () => {
      const plan = (seq: number, text: string) => ({ bridgeId: "bridge", seq, t: "plan", text });
      const byteQueue = new SidecarEventQueue(async () => {}, { maxItems: 4, maxBytes: 64 });
      expect(byteQueue.enqueue(plan(6, "x".repeat(512)))).toBe(false);
    });
  });

  describe("SidecarTailer Stream Ownership & Switching", () => {
    it("follows active streams and honors replacement bridge ownership", async () => {
      const termFile = join(eventsDir, "term-tailer.jsonl");
      await writeFile(termFile, "");

      const tailer = new SidecarTailer(eventsDir, () => Object.assign(new EventEmitter(), { close() {} }));
      const received: any[] = [];
      tailer.onEvent = (_id, event) => received.push(event);
      tailer.start();
      tailer.watch("term-tailer");

      const append = (...records: any[]) =>
        appendFile(termFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

      const waitFor = async (count: number) => {
        const deadline = Date.now() + 3000;
        while (received.length < count && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(received.length).toBe(count);
      };

      try {
        await append(
          { bridgeId: "active", seq: 1, t: "session_ready", ok: true },
          { bridgeId: "active", seq: 2, t: "preflight_request", requestId: "first" },
          { bridgeId: "foreign", seq: 1, t: "trace_startup" },
          { bridgeId: "active", seq: 3, t: "checkpoint_request", requestId: "checkpoint" },
          { bridgeId: "foreign", seq: 2, t: "shutdown_result" },
          { bridgeId: "active", seq: 4, t: "preflight_request", requestId: "after-foreign" },
        );
        await waitFor(4);
        expect(received.map((e) => e.bridgeId)).toEqual(["active", "active", "active", "active"]);
        expect(received.at(-1).requestId).toBe("after-foreign");

        await append(
          { bridgeId: "replacement", seq: 1, t: "session_ready", ok: true },
          { bridgeId: "active", seq: 5, t: "preflight_request", requestId: "stale" },
          { bridgeId: "replacement", seq: 2, t: "preflight_request", requestId: "replacement" },
        );
        await waitFor(6);
        expect(received.slice(-2).map((e) => [e.bridgeId, e.t])).toEqual([
          ["replacement", "session_ready"],
          ["replacement", "preflight_request"],
        ]);
        expect(received.at(-1).requestId).toBe("replacement");
      } finally {
        tailer.stop();
      }
    });
  });
});
