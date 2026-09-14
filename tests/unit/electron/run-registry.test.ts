import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RunRegistry } from "../../../electron/worldlines/run-registry.ts";
import type { RunRecord } from "../../../electron/worldlines/types.ts";

function run(id: number, opts: { settled: boolean; branch?: boolean; promptText?: string | null }): RunRecord {
  return {
    id: `run-${id}`,
    terminalId: `term-${id}`,
    startedAt: id,
    settledAt: opts.settled ? id : null,
    promptText: opts.promptText ?? `prompt-${id}`,
    startStateId: `start-${id}`,
    settledStateId: `settled-${id}`,
    sessionBranchFile: opts.branch ? `branch-${id}` : null,
    engine: "core",
  } as RunRecord;
}

describe("run registry hardening (issue #193)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("swallows releaseState rejections while evicting", async () => {
    const releaseState = vi.fn(async (_stateId: string): Promise<void> => {
      throw new Error("store unavailable");
    });
    const registry = new RunRegistry({
      releaseState,
      discardCoreSession: async () => ({ ok: true }),
      isCoreRun: () => false,
    });
    for (let i = 0; i < 201; i++) registry.record(run(i, { settled: true }), new Set());
    expect(registry.of("run-0")).toBeNull();
    expect(registry.of("run-200")).not.toBeNull();
    expect(releaseState).toHaveBeenCalled();
  });

  it("bounds the discard drain instead of hanging shutdown", async () => {
    const registry = new RunRegistry({
      releaseState: async () => {},
      discardCoreSession: async () => ({ ok: true }),
      isCoreRun: () => true,
    });
    // A settled drain completes without touching the bound.
    registry.record(run(0, { settled: true, branch: true }), new Set());
    for (let i = 1; i <= 200; i++) registry.record(run(i, { settled: true }), new Set());
    expect(registry.of("run-0")).toBeNull();
    await registry.drainDiscards();

    let releaseHung!: () => void;
    const hung = new RunRegistry({
      releaseState: async () => {},
      discardCoreSession: () => new Promise<{ ok: boolean }>((resolve) => {
        releaseHung = () => resolve({ ok: true });
      }),
      isCoreRun: () => true,
    });
    hung.record(run(0, { settled: true, branch: true }), new Set());
    for (let i = 1; i <= 200; i++) hung.record(run(i, { settled: true }), new Set());
    const drained = hung.drainDiscards();
    await vi.advanceTimersByTimeAsync(10_000);
    await drained;
    releaseHung();
  });

  it("sheds over-cap unsettled prompt text without dropping records", () => {
    const registry = new RunRegistry({
      releaseState: async () => {},
      discardCoreSession: async () => ({ ok: true }),
      isCoreRun: () => false,
    });
    for (let i = 0; i < 201; i++) registry.record(run(i, { settled: false }), new Set());
    // Nothing is disposable, so every record stays addressable...
    expect(registry.of("run-0")).not.toBeNull();
    expect(registry.of("run-200")).not.toBeNull();
    // ...but the over-cap oldest run shed its bulk while the newest kept its text.
    expect(registry.of("run-0")!.promptText).toBeNull();
    expect(registry.of("run-200")!.promptText).toBe("prompt-200");
  });
});
