import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { CoreClient, CORE_REQUEST_QUEUE_HIGH_WATER_ITEMS } from "../../../electron/core-client.ts";

describe("Electron CoreClient Bounded Queue & Stderr Isolation", () => {
  let client: CoreClient | null = null;

  function createClient(shimPath: string) {
    process.env.TERMINA_CORE_BIN = resolve(shimPath);
    client = new CoreClient();
    return client;
  }

  afterEach(() => {
    if (client) {
      client.dispose();
      client = null;
    }
  });

  async function within(promise: Promise<any>, label: string) {
    let timer: any;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} did not complete within 2,500ms`)), 2_500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  it("enforces high water marks, rejects overflow, and preserves FIFO ordering", async () => {
    const core = createClient("scripts/core-client-admission-shim.mjs");
    const requests: Promise<any>[] = [];
    const total = CORE_REQUEST_QUEUE_HIGH_WATER_ITEMS + 1;
    for (let i = 0; i < total; i += 1) {
      requests.push(core.request({ op: "delayed", value: i }));
    }
    const settled = await Promise.allSettled(requests);
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/queue|backpressure|high.?water/i);

    const values = settled
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<any>).value.value);
    expect(values).toEqual(Array.from({ length: total - 1 }, (_, i) => i));
    expect(core.queueStats().items).toBe(0);
    expect(core.queueStats().bytes).toBe(0);

    const shuttingDown = [
      core.request({ op: "delayed", value: "shutdown-in-flight" }),
      core.request({ op: "delayed", value: "shutdown-queued" }),
    ];
    setImmediate(() => core.dispose());
    const shutdownResults = await Promise.allSettled(shuttingDown);
    expect(shutdownResults.every((r) => r.status === "rejected")).toBe(true);
    expect(core.queueStats().items).toBe(0);
    expect(core.queueStats().bytes).toBe(0);
  });

  it("handles stderr larger than pipe capacity and isolates stderr across requests", async () => {
    const core = createClient("scripts/core-client-stderr-shim.mjs");

    const flood = await within(core.request({ op: "stderr-flood", marker: "success-tail" }), "stderr-flood request");
    expect(flood).toEqual({ value: "drained" });

    expect(
      await within(core.request({ op: "success-late-stderr", marker: "same-child-late-warning" }), "success before late stderr"),
    ).toEqual({ value: "late warning completed" });

    await expect(
      within(core.request({ op: "delayed-fail" }), "structured failure after same-child late stderr"),
    ).rejects.toThrow(/fixture delayed rejected/);

    for (let i = 0; i < 4; i += 1) {
      const marker = `failure-tail-${i}`;
      await expect(
        within(core.request({ op: "stderr-fail", marker }), `stderr-fail request ${i}`),
      ).rejects.toThrow(/fixture rejected/);
    }
    expect(await within(core.request({ op: "ok" }), "request after repeated failures")).toEqual({ value: "later request completed" });

    expect(
      await within(core.request({ op: "stderr-warn-success", marker: "successful-warning" }), "warning request"),
    ).toEqual({ value: "warning completed" });

    await expect(
      within(core.request({ op: "plain-fail" }), "plain failure after warning"),
    ).rejects.toThrow(/fixture plain rejected/);

    await expect(
      within(core.request({ op: "stderr-exit", marker: "old-process-tail" }), "stderr-exit request"),
    ).rejects.toThrow(/snapshot core exited/);

    await expect(
      within(core.request({ op: "stderr-fail", marker: "new-process-tail" }), "replacement stderr-fail request"),
    ).rejects.toThrow(/fixture rejected/);

    expect(await within(core.request({ op: "ok" }), "request after process replacement")).toEqual({ value: "later request completed" });

    await expect(
      within(core.request({ op: "protocol-fail", marker: "protocol-process-tail" }), "protocol failure"),
    ).rejects.toThrow(/fixture protocol rejected/);

    expect(await within(core.request({ op: "ok" }), "request after protocol failure")).toEqual({ value: "later request completed" });
  });
});
