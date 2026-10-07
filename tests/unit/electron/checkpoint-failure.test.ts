import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";

// Run the canonical main checkpoint handler, not a second completion reducer.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let handler: ts.MethodDeclaration | undefined;
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === "handleCheckpointRequest") handler = node;
  ts.forEachChild(node, visit);
}
visit(source);
if (!handler) throw new Error("Missing canonical checkpoint handler");
const compiled = ts.transpile(`const CHECKPOINT_CAPTURE_TIMEOUT_MS = 1000;
class TerminaApp { ${handler.getText(source)} }
return new TerminaApp();`, { target: ts.ScriptTarget.ES2022 });

function fixture() {
  vi.useFakeTimers();
  const run = { replayable: true, reason: null, settledAt: null, startStateId: "start-state", model: "fixture-model" };
  const inst = { id: "term-1", currentRun: run, busy: false };
  const ws = { id: "ws-1", root: "/fixture", primary: true, lastStateCommit: "old-state" };
  const main = new Function(compiled)();
  const store = { sourceGitDir: "/fixture/.git" };
  const owner: { storePromise: Promise<typeof store | null> } = { storePromise: Promise.resolve(store) };
  Object.assign(main, {
    workspaceOfTerminal: () => ws, projectOfTerminal: () => owner,
    acquireWriteLease: vi.fn(async () => ({ ok: true })), releaseWriteLease: vi.fn(),
    captureStable: vi.fn(async () => { throw new Error("fixture checkpoint I/O failure"); }),
    writeAck: vi.fn(), setWorkspaceState: vi.fn(), setRecorderState: vi.fn(),
    pushTimeline: vi.fn(), send: vi.fn(), trackRecordingTask: vi.fn(), finalizeRun: vi.fn(),
  });
  return { main, owner, store, run, inst, ws };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("settled checkpoint failure", () => {
  it("finishes a failed capture honestly without certifying a replayable run", async () => {
    const { main, run, inst, ws } = fixture();
    await main.handleCheckpointRequest(inst, "checkpoint-1", "settled", "12", null);
    expect(main.writeAck).toHaveBeenCalledWith(inst.id, "checkpoint-1", { ok: false, error: "fixture checkpoint I/O failure" });
    expect(run.replayable).toBe(false);
    expect(run.settledAt).toEqual(expect.any(Number));
    expect(run.reason).toBe("settled checkpoint failed: fixture checkpoint I/O failure");
    expect(inst.currentRun).toBeNull();
    expect(inst.busy).toBe(false);
    expect(main.setWorkspaceState).not.toHaveBeenCalled();
    expect(main.finalizeRun).not.toHaveBeenCalled();
    expect(main.setRecorderState).toHaveBeenCalledWith(inst, "degraded", null, "fixture checkpoint I/O failure");
    expect(main.pushTimeline).toHaveBeenCalledWith(inst, expect.objectContaining({
      t: "agent_settled", entryId: "12", stateId: null, runStartStateId: run.startStateId, model: run.model,
    }), null);
    expect(main.send).toHaveBeenCalledWith("worldline:runs-changed", { terminalId: inst.id }, null);
    expect(main.releaseWriteLease).toHaveBeenCalledWith(ws.id, "checkpoint:term-1:checkpoint-1");
  });

  it.each(["missing workspace", "missing store", "rejected store", "denied lease"] as const)("closes the settled run after %s without acquiring or releasing an unowned lease", async (failure) => {
    const { main, run, inst, owner } = fixture();
    let error = "recording is not available";
    if (failure === "missing workspace") main.workspaceOfTerminal = () => null;
    if (failure === "missing store") owner.storePromise = Promise.resolve(null);
    if (failure === "rejected store") {
      error = "fixture store bootstrap failed";
      owner.storePromise = Promise.reject(new Error(error));
    }
    if (failure === "denied lease") {
      error = "fixture workspace is busy";
      main.acquireWriteLease.mockResolvedValue({ ok: false, error });
    }
    await main.handleCheckpointRequest(inst, "checkpoint-1", "settled", "12", null);
    expect(main.writeAck).toHaveBeenCalledWith(inst.id, "checkpoint-1", { ok: false, error });
    expect(run.replayable).toBe(false);
    expect(run.settledAt).toEqual(expect.any(Number));
    expect(run.reason).toBe(`settled checkpoint failed: ${error}`);
    expect(inst.currentRun).toBeNull();
    expect(main.captureStable).not.toHaveBeenCalled();
    expect(main.releaseWriteLease).not.toHaveBeenCalled();
  });

  it("retains the lease across a capture timeout until the in-flight capture actually ends", async () => {
    const { main, run, inst, ws } = fixture();
    let resolveCapture!: (state: { commit: string }) => void;
    main.captureStable.mockImplementation(() => new Promise((resolve) => { resolveCapture = resolve; }));
    const request = main.handleCheckpointRequest(inst, "checkpoint-1", "settled", "12", null);
    await vi.advanceTimersByTimeAsync(1000);
    await request;
    expect(main.writeAck).toHaveBeenCalledWith(inst.id, "checkpoint-1", { ok: false, error: "checkpoint capture timed out" });
    expect(run.replayable).toBe(false);
    expect(inst.currentRun).toBeNull();
    expect(main.releaseWriteLease).not.toHaveBeenCalled();
    resolveCapture({ commit: "late-state" });
    await vi.advanceTimersByTimeAsync(0);
    expect(main.releaseWriteLease).toHaveBeenCalledExactlyOnceWith(ws.id, "checkpoint:term-1:checkpoint-1");
    expect(main.setWorkspaceState).not.toHaveBeenCalled();
    expect(main.finalizeRun).not.toHaveBeenCalled();
  });

  it("does not settle an ongoing run when a non-settled checkpoint fails", async () => {
    const { main, inst, run } = fixture();
    await main.handleCheckpointRequest(inst, "checkpoint-1", "point", "12", null);
    expect(inst.currentRun).toBe(run);
    expect(run).toMatchObject({ replayable: true, reason: null, settledAt: null });
    expect(main.pushTimeline).not.toHaveBeenCalled();
    expect(main.send).not.toHaveBeenCalled();
    expect(main.setRecorderState).toHaveBeenCalledWith(inst, "degraded", null, "fixture checkpoint I/O failure");
  });

  it("keeps successful capture publication and normal finalization unchanged", async () => {
    const { main, inst, run } = fixture();
    main.captureStable.mockResolvedValue({ commit: "settled-state" });
    await main.handleCheckpointRequest(inst, "checkpoint-1", "settled", "12", null);
    expect(main.writeAck).toHaveBeenCalledWith(inst.id, "checkpoint-1", { ok: true, stateId: "settled-state" });
    expect(main.finalizeRun).toHaveBeenCalledWith(inst, { commit: "settled-state" }, "12", null);
    expect(run.replayable).toBe(true);
    expect(main.setRecorderState).not.toHaveBeenCalled();
  });
});
