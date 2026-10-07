import type { ElectronApplication } from "@playwright/test";
import type { ReviewDiffResult, ReviewFilesResult, ReviewTarget } from "../../shared/types.ts";

interface ReviewResponseGate {
  waiting: boolean;
  delivered: boolean;
  target: ReviewTarget | null;
  result: ReviewDiffResult | ReviewFilesResult | null;
  release(): void;
  restore(): void;
}

type GateGlobal = typeof globalThis & { __reviewResponseGate?: ReviewResponseGate };

/** Delay delivery, not execution: the canonical guarded handler still validates and reads the real source. */
export async function holdNextReviewResponse(app: ElectronApplication, channel: "review:files" | "review:diff", terminalId: string): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, terminalId }) => {
    type Invoke = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Invoke> })._invokeHandlers;
    const original = handlers.get(channel);
    if (!original) throw new Error(`Missing canonical handler: ${channel}`);
    if ((globalThis as GateGlobal).__reviewResponseGate) throw new Error("A review response is already held");
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const gate: ReviewResponseGate = {
      waiting: false, delivered: false, target: null, result: null, release,
      restore: () => { release(); handlers.set(channel, original); delete (globalThis as GateGlobal).__reviewResponseGate; },
    };
    handlers.set(channel, async (event, ...args) => {
      const matches = !held && (args[0] as ReviewTarget | undefined)?.terminalId === terminalId;
      if (matches) held = true;
      const result = await original(event, ...args);
      if (matches) {
        gate.target = args[0] as ReviewTarget;
        gate.result = result as ReviewDiffResult | ReviewFilesResult;
        gate.waiting = true;
        await ready;
        gate.delivered = true;
      }
      return result;
    });
    (globalThis as GateGlobal).__reviewResponseGate = gate;
  }, { channel, terminalId });
}

export async function heldReviewResponse(app: ElectronApplication): Promise<Pick<ReviewResponseGate, "waiting" | "delivered" | "target" | "result">> {
  return app.evaluate(() => {
    const gate = (globalThis as GateGlobal).__reviewResponseGate;
    if (!gate) throw new Error("No review response is held");
    return { waiting: gate.waiting, delivered: gate.delivered, target: gate.target, result: gate.result };
  });
}

export async function releaseReviewResponse(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as GateGlobal).__reviewResponseGate?.release());
}

export async function restoreReviewResponse(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as GateGlobal).__reviewResponseGate?.restore());
}
