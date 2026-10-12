import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import type { RunRecord } from "../../../electron/worldlines/types.ts";

// Execute main's real producer without importing Electron or starting a PTY.
const source = ts.createSourceFile("main.ts", readFileSync(join(process.cwd(), "electron/main.ts"), "utf8"), ts.ScriptTarget.ES2022, true);
const members = source.statements.filter(ts.isClassDeclaration).flatMap((node) => [...node.members]);
const member = members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "coupleRunStart");
if (!member) throw new Error("missing main coupleRunStart");
const body = ts.transpileModule(`return new (class { ${member.getText(source)} })();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

interface Actor {
  id: string;
  workspaceId: string;
  pendingPrompt: null;
  currentRun: RunRecord | null;
  persist: boolean;
}
interface Producer {
  coupleRunStart(actor: Actor, event: { preflightToken?: string; entryId: string; parentEntryId?: string | null; sessionFile: string }): Promise<void>;
  pendingPreflights: Map<string, unknown>;
  workspaceOfTerminal: () => { generation: number };
  projectOfTerminal: () => { worldlines: object };
  initWorldlines: () => Promise<void>;
  releaseWriteLease: () => void;
  overlapInWorkspace: () => boolean;
  markOverlappingAgents: () => void;
  pushRun: (actor: Actor, record: RunRecord) => void;
}

for (const preflight of [true, false]) {
  describe(`recorded prompt parents ${preflight ? "with" : "without"} preflight`, () => {
    it.each([
      { parent: null, expected: "0" },
      { parent: undefined, expected: null },
      { parent: "12", expected: "12" },
      { parent: "invalid", expected: "invalid" },
    ])("preserves the declared parent $parent as $expected", async ({ parent, expected }) => {
      const producer = new Function("randomUUID", body)(() => "recording-test") as Producer;
      producer.pendingPreflights = new Map(preflight ? [["token", {
        terminalId: "term-1", workspaceId: "workspace-1", startState: { commit: "base" },
        generation: 1, leaseRequester: "preflight", trustHashes: {},
      }]] : []);
      producer.workspaceOfTerminal = () => ({ generation: 1, primary: true });
      producer.projectOfTerminal = () => ({ worldlines: {} });
      producer.initWorldlines = async () => {};
      producer.releaseWriteLease = vi.fn();
      producer.overlapInWorkspace = () => false;
      producer.markOverlappingAgents = vi.fn();
      producer.pushRun = (actor, record) => { actor.currentRun = record; };
      const actor: Actor = { id: "term-1", workspaceId: "workspace-1", pendingPrompt: null, currentRun: null, persist: false };
      await producer.coupleRunStart(actor, {
        ...(preflight ? { preflightToken: "token" } : {}),
        entryId: "13", parentEntryId: parent, sessionFile: "/sessions/source/current/active.jsonl",
      });
      expect(actor.currentRun?.promptParentEntryId).toBe(expected);
      expect(actor.currentRun?.replayable).toBe(preflight);
    });
  });
}

const baselineMethods = ["handlePreflightRequest", "coupleRunStart", "fillBaseline", "fillBaselineFromState", "setBaseline"];
const baselineBody = ts.transpileModule(`return new (class {
  ${baselineMethods.map((name) => {
    const method = members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
    if (!method) throw new Error(`missing main ${name}`);
    return method.getText(source);
  }).join("\n")}
})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

interface BaselineActor extends Actor {
  busy: boolean;
  generation: number;
  baselines: Map<string, string | null>;
  baselineStates: Map<string, string>;
  baselineFills: Map<string, Promise<void>>;
  baselineBytes: number;
}

function baselineHarness(primary = false) {
  const workspace = {
    id: "workspace-1", primary, root: primary ? "/primary" : "/candidate/actual-tree",
    generation: 1, lastStateCommit: "candidate-seed", retainedBlobBytes: 0,
    indexReady: Promise.resolve(),
  };
  let diskContent = primary ? "primary before" : "candidate before";
  const blobs = new Map<string, string>();
  const capture = vi.fn(async () => {
    blobs.set("immutable-start", diskContent);
    return { commit: "immutable-start", tree: "start-tree", newBlobBytes: 10 };
  });
  const store = { capture, readBlob: vi.fn(async (state: string) => Buffer.from(blobs.get(state)!)) };
  const project = { workspaces: new Map([[workspace.id, workspace]]), storePromise: Promise.resolve(store), worldlines: {} };
  const gitHead = vi.fn(async () => "source-head");
  const gitCommonDir = vi.fn(async () => "/candidate/actual-tree/.git");
  const producer = new Function("randomUUID", "gitHead", "gitCommonDir", "relative", "isAbsolute", "MAX_OPEN_FILE_SIZE", "TerminaApp", baselineBody)(
    () => "preflight-token", gitHead, gitCommonDir, relative, isAbsolute, 1024,
    { MAX_BASELINE_FILES: 100, MAX_BASELINE_BYTES: 1024 },
  ) as Producer & {
    handlePreflightRequest(actor: BaselineActor, request: string, deadline: number): Promise<void>;
    fillBaseline(actor: BaselineActor, path: string, status: "created" | "modified"): Promise<void>;
  };
  const host = Object.assign(producer, {
    pendingPreflights: new Map<string, unknown>(),
    workspaceOfTerminal: () => workspace,
    projectOfTerminal: () => project,
    initWorldlines: async () => {},
    releaseWriteLease: vi.fn(),
    acquireWriteLease: vi.fn(async () => ({ ok: true })),
    admitSource: vi.fn(async () => ({ ok: true })),
    sourceAdmissions: { finish: vi.fn() },
    rejectDispatchStart: vi.fn(),
    flushDirtyModels: vi.fn(async () => ({ ok: true })),
    invalidateWorkspaceVerify: vi.fn(),
    setWorkspaceState: vi.fn((_ws, state: string) => { workspace.lastStateCommit = state; }),
    computeTrustHashes: vi.fn(async () => ({ trust: "hash" })),
    writeAck: vi.fn(),
    setRecorderState: vi.fn(),
    expirePreflight: vi.fn(),
    trackRecordingTask: vi.fn(),
    overlapInWorkspace: () => false,
    markOverlappingAgents: vi.fn(),
    pushRun: (actor: Actor, record: RunRecord) => { actor.currentRun = record; },
    canonicalPath: vi.fn(async (path: string) => path),
  });
  const actor: BaselineActor = {
    id: "term-1", workspaceId: workspace.id, generation: 1, pendingPrompt: null,
    currentRun: null, persist: false, busy: false, baselines: new Map(),
    baselineStates: new Map(), baselineFills: new Map(), baselineBytes: 0,
  };
  return { host, actor, workspace, store, gitHead, gitCommonDir, mutate: () => { diskContent = "after edit"; } };
}

afterEach(() => { vi.useRealTimers(); });

describe("candidate run-start baseline producer", () => {
  it.each([false, true])("captures before acknowledgement and retrieves a cold-cache baseline (primary=%s)", async (primary) => {
    vi.useFakeTimers();
    const { host, actor, workspace, store, gitHead, gitCommonDir, mutate } = baselineHarness(primary);
    const capture = store.capture.getMockImplementation()!;
    let finishCapture!: () => void;
    const capturing = new Promise<void>((resolve) => { finishCapture = resolve; });
    store.capture.mockImplementationOnce(async () => { await capturing; return capture(); });
    const preflight = host.handlePreflightRequest(actor, "request", Date.now() + 15000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.capture).toHaveBeenCalledOnce();
    expect(host.writeAck).not.toHaveBeenCalled();
    expect(host.releaseWriteLease).not.toHaveBeenCalled();
    expect(host.acquireWriteLease).toHaveBeenCalledWith(workspace.id, "preflight:term-1:request", 10750);
    expect(host.flushDirtyModels).toHaveBeenCalledWith("preflight:term-1:request", workspace.id, 5000, undefined);
    expect(gitHead).toHaveBeenCalledWith(workspace.root);
    expect(store.capture).toHaveBeenCalledWith("source-head", "candidate-seed", {}, {}, primary ? undefined : {
      root: workspace.root, gitDir: "/candidate/actual-tree/.git",
    });
    expect(gitCommonDir).toHaveBeenCalledTimes(primary ? 0 : 1);
    finishCapture();
    await preflight;
    expect(host.writeAck).toHaveBeenCalledWith(actor.id, "request", { ok: true, token: "preflight-token" });
    expect(workspace.lastStateCommit).toBe("immutable-start");
    expect(workspace.retainedBlobBytes).toBe(10);
    await host.coupleRunStart(actor, {
      preflightToken: "preflight-token", entryId: "13", parentEntryId: null,
      sessionFile: "/sessions/source/current/active.jsonl",
    });
    expect(actor.currentRun?.startStateId).toBe("immutable-start");
    expect(actor.currentRun?.replayable).toBe(primary);
    expect(actor.currentRun?.reason).toBe(primary ? null : "candidate runs cannot be replayed");
    expect(host.pendingPreflights.size).toBe(0);
    expect(host.releaseWriteLease).toHaveBeenCalledExactlyOnceWith(workspace.id, "preflight:term-1:request");
    // No watcher cache or previous bytes exist; the live file has already changed.
    expect(actor.baselines.size).toBe(0);
    mutate();
    const path = join(workspace.root, "existing.txt");
    await host.fillBaseline(actor, path, "modified");
    expect(store.readBlob).toHaveBeenCalledWith("immutable-start", "existing.txt");
    expect(actor.baselines.get(path)).toBe(primary ? "primary before" : "candidate before");
    expect(actor.baselineStates.get(path)).toBe("immutable-start");
    expect(actor.baselineFills.size).toBe(0);
  });

  it("rejects failed admission without capturing or acquiring a lease", async () => {
    vi.useFakeTimers();
    const { host, actor, store } = baselineHarness();
    host.admitSource.mockResolvedValueOnce({ ok: false });
    await host.handlePreflightRequest(actor, "request", Date.now() + 15000);
    expect(store.capture).not.toHaveBeenCalled();
    expect(host.acquireWriteLease).not.toHaveBeenCalled();
    expect(host.writeAck).toHaveBeenCalledWith(actor.id, "request", { ok: false, error: "source admission failed" });
  });

  it("releases the candidate lease and admission if capture fails", async () => {
    vi.useFakeTimers();
    const { host, actor, store } = baselineHarness();
    store.capture.mockRejectedValueOnce(new Error("capture failed"));
    await host.handlePreflightRequest(actor, "request", Date.now() + 15000);
    expect(host.pendingPreflights.size).toBe(0);
    expect(host.releaseWriteLease).toHaveBeenCalledExactlyOnceWith("workspace-1", "preflight:term-1:request");
    expect(host.sourceAdmissions.finish).toHaveBeenCalledWith(actor.id, actor.generation);
    expect(host.writeAck).toHaveBeenCalledWith(actor.id, "request", { ok: false, error: "capture failed" });
  });

  it("answers an expired deadline but keeps the candidate lease until an in-flight capture finishes", async () => {
    vi.useFakeTimers();
    const { host, actor, store } = baselineHarness();
    const capture = store.capture.getMockImplementation()!;
    let finishCapture!: () => void;
    const capturing = new Promise<void>((resolve) => { finishCapture = resolve; });
    store.capture.mockImplementationOnce(async () => { await capturing; return capture(); });
    const preflight = host.handlePreflightRequest(actor, "request", Date.now() + 15000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.capture).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15000);
    await preflight;
    expect(host.writeAck).toHaveBeenCalledWith(actor.id, "request", {
      ok: false, error: "preflight deadline exceeded while capturing the workspace",
    });
    expect(host.pendingPreflights.size).toBe(0);
    expect(host.releaseWriteLease).not.toHaveBeenCalled();
    expect(host.trackRecordingTask).toHaveBeenCalledOnce();
    finishCapture();
    await host.trackRecordingTask.mock.calls[0][0];
    expect(host.releaseWriteLease).toHaveBeenCalledExactlyOnceWith("workspace-1", "preflight:term-1:request");
    expect(host.writeAck).toHaveBeenCalledTimes(1);
  });
});
