import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";

function methodBody(source: string, signature: string, nextSignature?: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing method ${signature}`);
  const end = nextSignature ? source.indexOf(nextSignature, start + signature.length) : source.length;
  return source.slice(start, end < 0 ? source.length : end);
}

function extractMethod(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing method ${signature}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed method ${signature}`);
}

const root = process.cwd();
const main = readFileSync(join(root, "electron", "main.ts"), "utf8");
const worldlines = readdirSync(join(root, "electron", "worldlines"))
  .filter((name) => name.endsWith(".ts"))
  .sort()
  .map((name) => readFileSync(join(root, "electron", "worldlines", name), "utf8"))
  .join("\n");

const captureSource = extractMethod(main, "private async captureMomentNow(").replace(/^private /, "");
const captureFactory = ts.transpileModule(`return ({ ${captureSource} }).captureMomentNow;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const runSource = extractMethod(main, "private runMomentCapture(").replace(/^private /, "");
const runFactory = ts.transpileModule(`return ({ ${runSource} }).runMomentCapture;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadCaptureMomentNow(): (
  inst: Record<string, unknown>,
  ws: Record<string, unknown>,
  expected?: unknown,
) => Promise<void> {
  return new Function("relative", "isAbsolute", "gitCommonDir", "gitHead", captureFactory)(
    relative,
    isAbsolute,
    async () => "/unused-git",
    async () => "head",
  );
}

function loadRunMomentCapture(): (
  inst: Record<string, unknown>,
  ws: Record<string, unknown>,
  expected?: unknown,
) => Promise<void> {
  return new Function(runFactory)();
}

function makeInst(id: string, hints: string[], path: string) {
  return {
    id,
    closed: false,
    momentDots: [{ t: "tool", seq: 1, path }],
    pendingHints: new Set(hints),
    timeline: [],
  };
}

function makeHarness(opts: {
  writerId: string | null;
  acquireOk?: boolean;
  lastStateCommit?: string | null;
  lastReseedMs?: number;
  incrementalError?: string;
  reseedError?: string;
  members?: ReturnType<typeof makeInst>[];
}) {
  const captures: Array<{ kind: "incremental" | "full"; parent: string | null; hints: string[] }> = [];
  const attached: Array<{ id: string; stateId: string; paths: string[] }> = [];
  const members = opts.members ?? [makeInst("term-1", ["a.ts"], "/proj/a.ts")];
  const inst = members[0]!;
  const ws = {
    id: "ws-primary",
    root: "/proj",
    primary: true,
    writerId: opts.writerId,
    leaseDepth: opts.writerId ? 1 : 0,
    lastStateCommit: opts.lastStateCommit === undefined ? "state-before" : opts.lastStateCommit,
    lastReseedMs: opts.lastReseedMs ?? 0,
    momentCapturePromise: null as Promise<void> | null,
    retainedBlobBytes: 0,
    watcher: null,
    generation: 1,
    terminalIds: new Set(members.map((member) => member.id)),
  };
  const store = {
    objectFormat: "sha1",
    captureIncremental: async (parent: string, hints: string[]) => {
      if (opts.incrementalError) throw new Error(opts.incrementalError);
      captures.push({ kind: "incremental", parent, hints: [...hints].sort() });
      return { commit: "state-after", newBlobBytes: 4 };
    },
    capture: async (_head: string | null, parent: string | null) => {
      if (opts.reseedError) throw new Error(opts.reseedError);
      captures.push({ kind: "full", parent, hints: [] });
      return { commit: "state-reseed", newBlobBytes: 0 };
    },
  };
  const released: string[] = [];
  const acquired: string[] = [];
  const recorder: Array<{ id: string; state: string }> = [];
  const app = {
    projectOfTerminal: () => ({ storePromise: Promise.resolve(store) }),
    projectOfWorkspace: () => ({ storePromise: Promise.resolve(store) }),
    terminalsOnWorkspace: () => members,
    setRecorderState: (member: { id: string }, state: string) => { recorder.push({ id: member.id, state }); },
    acquireWriteLease: async (_wsId: string, requester: string) => {
      acquired.push(requester);
      if (opts.acquireOk === false) return { ok: false, generation: ws.generation, error: `another writer holds the lease: ${ws.writerId}` };
      if (ws.writerId !== null && ws.writerId !== requester) {
        return { ok: false, generation: ws.generation, error: `another writer holds the lease: ${ws.writerId}` };
      }
      ws.writerId = requester;
      ws.leaseDepth += 1;
      return { ok: true, generation: ws.generation };
    },
    releaseWriteLease: (_wsId: string, requester: string) => {
      released.push(requester);
      if (ws.writerId !== requester) return;
      ws.leaseDepth = Math.max(0, ws.leaseDepth - 1);
      if (ws.leaseDepth === 0) ws.writerId = null;
    },
    canonicalPath: async (path: string) => path,
    ignoredSegmentIn: () => false,
    setWorkspaceState: (workspace: { lastStateCommit: string | null }, stateId: string | null) => {
      workspace.lastStateCommit = stateId;
    },
    attachMomentState: (member: { id: string }, stateId: string, batch: Array<{ path?: string }>) => {
      attached.push({ id: member.id, stateId, paths: batch.map((event) => event.path ?? "") });
    },
    addPendingHint: (member: { pendingHints: Set<string> }, relPath: string) => {
      member.pendingHints.add(relPath);
    },
  };
  return { ws, inst, members, captures, attached, acquired, released, recorder, app };
}

describe("moment capture write lease", () => {
  it("does not snapshot when another writer holds the lease", async () => {
    const captureMomentNow = loadCaptureMomentNow();
    const { ws, inst, captures, acquired, released, app } = makeHarness({
      writerId: "promote:busy-apply",
    });
    const lastState = ws.lastStateCommit;
    await captureMomentNow.call(app, inst, ws);
    expect(captures).toEqual([]);
    expect(ws.lastStateCommit).toBe(lastState);
    expect(inst.momentDots).toHaveLength(1);
    expect([...inst.pendingHints]).toEqual(["a.ts"]);
    expect(released).toEqual([]);
    expect(acquired.length === 0 || captures.length === 0).toBe(true);
  });

  it("does not snapshot when acquireWriteLease fails", async () => {
    const captureMomentNow = loadCaptureMomentNow();
    const { ws, inst, captures, released, app } = makeHarness({
      writerId: null,
      acquireOk: false,
    });
    await captureMomentNow.call(app, inst, ws);
    expect(captures).toEqual([]);
    expect(ws.lastStateCommit).toBe("state-before");
    expect(inst.momentDots).toHaveLength(1);
    expect([...inst.pendingHints]).toEqual(["a.ts"]);
    expect(released).toEqual([]);
  });

  it("acquires the workspace lease for a free tree and releases it after capture", async () => {
    const captureMomentNow = loadCaptureMomentNow();
    const { ws, inst, captures, acquired, released, recorder, app } = makeHarness({
      writerId: null,
    });
    await captureMomentNow.call(app, inst, ws);
    expect(acquired).toEqual(["moment:ws-primary"]);
    expect(captures).toEqual([{ kind: "incremental", parent: "state-before", hints: ["a.ts"] }]);
    expect(ws.lastStateCommit).toBe("state-after");
    expect(ws.writerId).toBeNull();
    expect(released).toEqual(["moment:ws-primary"]);
    expect(recorder.at(-1)).toEqual({ id: "term-1", state: "ready" });
  });

  it("drains a closed terminal that still has dots or hints", async () => {
    const captureMomentNow = loadCaptureMomentNow();
    const closed = makeInst("term-closed", ["gone.ts"], "/proj/gone.ts");
    closed.closed = true;
    const { ws, captures, attached, app } = makeHarness({
      writerId: null,
      members: [closed],
    });
    await captureMomentNow.call(app, closed, ws);
    expect(captures).toEqual([{ kind: "incremental", parent: "state-before", hints: ["gone.ts"] }]);
    expect(attached).toEqual([{ id: "term-closed", stateId: "state-after", paths: ["/proj/gone.ts"] }]);
    expect(closed.momentDots).toHaveLength(0);
    expect(closed.pendingHints.size).toBe(0);
  });

  it("full-captures a primary workspace after the parent is invalidated", async () => {
    const captureMomentNow = loadCaptureMomentNow();
    const { ws, inst, captures, attached, app } = makeHarness({
      writerId: null,
      lastStateCommit: null,
    });
    await captureMomentNow.call(app, inst, ws);
    expect(captures).toEqual([{ kind: "full", parent: null, hints: [] }]);
    expect(ws.lastStateCommit).toBe("state-reseed");
    expect(ws.lastReseedMs).toBeGreaterThan(0);
    expect(attached).toEqual([{ id: "term-1", stateId: "state-reseed", paths: ["/proj/a.ts"] }]);
  });

  it("restores drained batches when incremental capture fails", async () => {
    const captureMomentNow = loadCaptureMomentNow();
    const { ws, inst, captures, attached, recorder, app } = makeHarness({
      writerId: null,
      lastReseedMs: Date.now(),
      incrementalError: "core busy",
    });
    await captureMomentNow.call(app, inst, ws);
    expect(captures).toEqual([]);
    expect(attached).toEqual([]);
    expect(ws.lastStateCommit).toBe("state-before");
    expect(inst.momentDots).toHaveLength(1);
    expect([...inst.pendingHints]).toEqual(["a.ts"]);
    expect(recorder.at(-1)).toEqual({ id: "term-1", state: "degraded" });
  });

  it("stamps lastReseedMs only after a successful reseed", async () => {
    const captureMomentNow = loadCaptureMomentNow();
    const failed = makeHarness({
      writerId: null,
      incrementalError: "dangling base",
      reseedError: "store down",
    });
    await captureMomentNow.call(failed.app, failed.inst, failed.ws);
    expect(failed.ws.lastReseedMs).toBe(0);
    expect(failed.inst.momentDots).toHaveLength(1);
    expect([...failed.inst.pendingHints]).toEqual(["a.ts"]);

    const recovered = makeHarness({
      writerId: null,
      incrementalError: "dangling base",
    });
    await captureMomentNow.call(recovered.app, recovered.inst, recovered.ws);
    expect(recovered.captures).toEqual([{ kind: "full", parent: null, hints: [] }]);
    expect(recovered.ws.lastReseedMs).toBeGreaterThan(0);
    expect(recovered.attached).toEqual([{ id: "term-1", stateId: "state-reseed", paths: ["/proj/a.ts"] }]);
  });
});

describe("workspace moment capture queue", () => {
  it("queues on the workspace, not the triggering terminal", () => {
    const run = methodBody(main, "private runMomentCapture(", "private async captureMomentNow(");
    expect(run).toContain("ws.momentCapturePromise");
    expect(run).not.toContain("inst.momentCapturePromise");
  });

  it("merges sibling hint sets into one incremental from the current parent", async () => {
    const captureMomentNow = loadCaptureMomentNow();
    const { ws, inst, members, captures, attached, app } = makeHarness({
      writerId: null,
      members: [
        makeInst("term-1", ["worker-a.ts"], "/proj/worker-a.ts"),
        makeInst("term-2", ["worker-b.ts"], "/proj/worker-b.ts"),
      ],
    });
    await captureMomentNow.call(app, inst, ws);
    expect(captures).toEqual([{
      kind: "incremental",
      parent: "state-before",
      hints: ["worker-a.ts", "worker-b.ts"],
    }]);
    expect(ws.lastStateCommit).toBe("state-after");
    expect(attached).toEqual([
      { id: "term-1", stateId: "state-after", paths: ["/proj/worker-a.ts"] },
      { id: "term-2", stateId: "state-after", paths: ["/proj/worker-b.ts"] },
    ]);
    expect(members[0]!.pendingHints.size).toBe(0);
    expect(members[1]!.pendingHints.size).toBe(0);
  });

  it("does not start two incrementals from the same parent when siblings queue", async () => {
    const runMomentCapture = loadRunMomentCapture();
    const parents: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let entered = 0;
    let notifyEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { notifyEntered = resolve; });
    const ws = {
      id: "ws-primary",
      lastStateCommit: "state-before",
      momentCapturePromise: null as Promise<void> | null,
    };
    const app = {
      async captureMomentNow(_inst: { id: string }, workspace: { lastStateCommit: string }) {
        parents.push(workspace.lastStateCommit);
        entered += 1;
        if (entered === 1) notifyEntered();
        if (entered === 1) await firstGate;
        workspace.lastStateCommit = `after-${entered}`;
      },
    };
    const first = runMomentCapture.call(app, { id: "term-1" }, ws);
    await firstEntered;
    const second = runMomentCapture.call(app, { id: "term-2" }, ws);
    expect(parents).toEqual(["state-before"]);
    expect(ws.momentCapturePromise).not.toBeNull();
    releaseFirst();
    await Promise.all([first, second]);
    expect(parents).toEqual(["state-before", "after-1"]);
    expect(ws.lastStateCommit).toBe("after-2");
    expect(ws.momentCapturePromise).toBeNull();
  });

  it("retries after a non-moment writer drops the lease", () => {
    const release = extractMethod(main, "private releaseWriteLease(");
    expect(release).toContain("kickWorkspaceMomentCapture");
    expect(release).toContain('!requesterId.startsWith("moment:")');
    const list = extractMethod(main, "private terminalsOnWorkspace(");
    expect(list).toContain("inst.closed && inst.momentDots.length === 0");
    const close = extractMethod(main, "private closeTerminal(");
    expect(close).toContain("runMomentCapture(inst, captureWs)");
    expect(close).not.toContain("scheduleMomentCapture(");
  });
});

describe("promote refreshes workspace state after apply", () => {
  it("full-captures the merged tree and updates workspace state before releasing leases", () => {
    const promotion = methodBody(
      worldlines,
      "private async promoteUnderTransaction(",
      "  // ------------------------------------------------------- fork any moment",
    );
    expect(promotion).toContain("const refreshMergedPrimary = async");
    expect(promotion).toMatch(/store\.capture\(await gitHead\(this\.deps\.primaryRoot\), mergedParent\)/);
    expect(promotion).toContain("onCandidateState(this.deps.primaryRoot, mergedState.commit)");

    const afterDone = promotion.slice(promotion.indexOf('journal.phase = "done"'));
    const success = afterDone.slice(0, afterDone.indexOf("return { ok: true, terminalId: opened.terminalId }"));
    expect(success.indexOf("await refreshMergedPrimary()")).toBeGreaterThan(-1);
    expect(success.indexOf("await refreshMergedPrimary()")).toBeLessThan(success.indexOf("releaseLeases()"));
    expect(success).toContain("workspace snapshot was not refreshed");
    expect(promotion).toContain("onCandidateState(this.deps.primaryRoot, null)");
    expect(promotion).not.toContain("post-promote capture failed");

    const doneCatch = afterDone.slice(afterDone.indexOf('if (String(journal.phase) === "done")'));
    const doneRelease = doneCatch.indexOf("releaseLeases()");
    expect(doneCatch.indexOf("await refreshMergedPrimary()")).toBeGreaterThan(-1);
    expect(doneCatch.indexOf("await refreshMergedPrimary()")).toBeLessThan(doneRelease);
    expect(doneCatch).toContain("releaseLeases()");
    expect(success.indexOf("store.captureIncremental")).toBe(-1);
  });

  it("forks fail when a new trust-sensitive path appears after the run", () => {
    const fork = methodBody(worldlines, "async forkRun(", "const uncertaintyAdmission");
    expect(fork).toContain("[...new Set([...Object.keys(run.trustHashes), ...Object.keys(now)])]");
  });
});
