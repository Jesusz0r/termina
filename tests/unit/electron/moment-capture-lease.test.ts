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

function makeHarness(opts: {
  writerId: string | null;
  acquireOk?: boolean;
  lastStateCommit?: string;
}) {
  const captures: Array<{ kind: "incremental" | "full"; parent: string | null }> = [];
  const ws = {
    id: "ws-primary",
    root: "/proj",
    primary: true,
    writerId: opts.writerId,
    leaseDepth: opts.writerId ? 1 : 0,
    lastStateCommit: opts.lastStateCommit ?? "state-before",
    retainedBlobBytes: 0,
    watcher: null,
    generation: 1,
  };
  const inst = {
    id: "term-1",
    momentDots: [{ t: "tool", seq: 1, path: "/proj/a.ts" }],
    pendingHints: new Set(["a.ts"]),
    lastReseedMs: 0,
    timeline: [],
  };
  const store = {
    objectFormat: "sha1",
    captureIncremental: async (parent: string) => {
      captures.push({ kind: "incremental", parent });
      return { commit: "state-after", newBlobBytes: 4 };
    },
    capture: async (_head: string | null, parent: string | null) => {
      captures.push({ kind: "full", parent });
      return { commit: "state-reseed", newBlobBytes: 0 };
    },
  };
  const released: string[] = [];
  const acquired: string[] = [];
  const recorder: string[] = [];
  const app = {
    projectOfTerminal: () => ({ storePromise: Promise.resolve(store) }),
    setRecorderState: (_inst: unknown, state: string) => { recorder.push(state); },
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
    setWorkspaceState: (workspace: { lastStateCommit: string }, stateId: string) => {
      workspace.lastStateCommit = stateId;
    },
    attachMomentState: () => {},
  };
  return { ws, inst, captures, acquired, released, recorder, app };
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
    expect(released).toEqual([]);
  });

  it("acquires the workspace lease for a free tree and releases it after capture", async () => {
    const captureMomentNow = loadCaptureMomentNow();
    const { ws, inst, captures, acquired, released, recorder, app } = makeHarness({
      writerId: null,
    });
    await captureMomentNow.call(app, inst, ws);
    expect(acquired).toEqual(["moment:term-1"]);
    expect(captures).toEqual([{ kind: "incremental", parent: "state-before" }]);
    expect(ws.lastStateCommit).toBe("state-after");
    expect(ws.writerId).toBeNull();
    expect(released).toEqual(["moment:term-1"]);
    expect(recorder.at(-1)).toBe("ready");
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
    expect(promotion).not.toContain("post-promote capture failed");

    const doneCatch = afterDone.slice(afterDone.indexOf('if (String(journal.phase) === "done")'));
    const doneRelease = doneCatch.indexOf("releaseLeases()");
    expect(doneCatch.indexOf("await refreshMergedPrimary()")).toBeGreaterThan(-1);
    expect(doneCatch.indexOf("await refreshMergedPrimary()")).toBeLessThan(doneRelease);
    expect(doneCatch).toContain("releaseLeases()");
    expect(success.indexOf("store.captureIncremental")).toBe(-1);
  });
});
