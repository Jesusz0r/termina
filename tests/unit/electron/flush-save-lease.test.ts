import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { lstat, open, rm, rename as fsRename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { syncParentDir } from "../../../shared/fsync.ts";
import ts from "typescript";

/**
 * Flush-save lease gate (refs #168) and dispatch genuine-holder flush
 * (refs #205).
 *
 * The real file:flush-save handler plus the real lease methods are
 * extracted from electron/main.ts and transpiled (the save-revert-lease
 * suite's pattern: main imports Electron and cannot be imported here),
 * then exercised against real temp files with the real acquire/join/
 * release logic.
 */

const root = process.cwd();
const main = readFileSync(join(root, "electron", "main.ts"), "utf8");

function extractMethod(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing method ${signature}`);
  const paramsEnd = source.indexOf(")", start + signature.length) + 1;
  let angle = 0;
  let brace = -1;
  for (let i = paramsEnd; i < source.length; i++) {
    const ch = source[i];
    if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
    else if (ch === "{" && angle === 0) {
      brace = i;
      break;
    }
  }
  if (brace < 0) throw new Error(`unclosed method ${signature}`);
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

function loadMethod(factoryName: string, signature: string, names: string[], values: unknown[]): unknown {
  const methodSource = extractMethod(main, signature).replace(/^private /, "");
  const factory = ts.transpileModule(`return ({ ${methodSource} }).${factoryName};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const construct = new Function(...names, factory) as unknown as (...args: unknown[]) => unknown;
  return construct(...values);
}

/** Extract the file:flush-save ipcMain callback as a callable function. */
function loadFlushSave(names: string[], values: unknown[]): unknown {
  const handleAt = main.indexOf('ipcMain.handle("file:flush-save"');
  if (handleAt < 0) throw new Error("missing file:flush-save handler");
  const arrow = main.indexOf("=>", handleAt);
  const bodyStart = main.indexOf("{", arrow);
  let depth = 0;
  for (let i = bodyStart; i < main.length; i++) {
    const ch = main[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const body = main.slice(bodyStart, i + 1);
        const factory = ts.transpileModule(
          `return (async function flushSave(_e, absPath, content, writerId, owner) ${body});`,
          { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
        ).outputText;
        const construct = new Function(...names, factory) as unknown as (...args: unknown[]) => unknown;
        return construct(...values);
      }
    }
  }
  throw new Error("unclosed file:flush-save handler");
}

const MAX_OPEN_FILE_SIZE = 2 * 1024 * 1024;

type LeaseResult = { ok: boolean; generation: number; error?: string };
type FlushSave = (
  event: unknown,
  absPath: string,
  content: string,
  writerId: unknown,
  owner: unknown,
) => Promise<{ ok: boolean; error?: string }>;

interface FakeWorkspace {
  id: string;
  root: string;
  writerId: string | null;
  leaseDepth?: number;
  generation: number;
}

interface FakeApp {
  disposed: boolean;
  workspaceById: (id: string) => FakeWorkspace | undefined;
  projectWorkspace: (value: unknown) => { project: { id: string }; workspace: FakeWorkspace } | null;
  managedPath: (absPath: string, workspaceId: string) => Promise<{ path: string; workspace: FakeWorkspace } | null>;
  joinWriteLease: (wsId: string, requesterId: string) => boolean;
  releaseWriteLease: (wsId: string, requesterId: string) => void;
  acquireWriteLease: (wsId: string, requesterId: string, timeoutMs?: number) => Promise<LeaseResult>;
  grantLeaseWaiter: (ws: FakeWorkspace) => void;
  leaseWaiters: Map<string, Array<{ requesterId: string; settled: boolean; timer: ReturnType<typeof setTimeout> }>>;
  durableReplaceFile: (path: string, data: string | Buffer, mode?: number) => Promise<void>;
  sweepReplaceTemps: (path: string) => Promise<void>;
  projectOfWorkspace: (id: string) => null;
  projectIsSwitching: (id: string | undefined) => boolean;
  terminalsOnWorkspace: (ws: FakeWorkspace) => unknown[];
  kickWorkspaceMomentCapture: (ws: FakeWorkspace) => void;
}

const realAcquire = loadMethod("acquireWriteLease", "private async acquireWriteLease(", [], []) as (
  wsId: string,
  requesterId: string,
  timeoutMs?: number,
) => Promise<LeaseResult>;
const realGrant = loadMethod("grantLeaseWaiter", "private grantLeaseWaiter(", [], []) as (
  ws: FakeWorkspace,
) => void;
const realJoin = loadMethod("joinWriteLease", "private joinWriteLease(", [], []) as (
  wsId: string,
  requesterId: string,
) => boolean;
const realRelease = loadMethod("releaseWriteLease", "private releaseWriteLease(", [], []) as (
  wsId: string,
  requesterId: string,
) => void;
const realDurableReplace = loadMethod(
  "durableReplaceFile",
  "private async durableReplaceFile(",
  ["open", "fsRename", "rm", "randomUUID", "syncParentDir"],
  [open, fsRename, rm, randomUUID, syncParentDir],
) as (path: string, data: string | Buffer, mode?: number) => Promise<void>;
const flushSave = loadFlushSave(["MAX_OPEN_FILE_SIZE", "lstat"], [MAX_OPEN_FILE_SIZE, lstat]) as FlushSave;

function makeHarness(opts: { durableReplace?: (path: string, data: string | Buffer, mode?: number) => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "termina-flush-gate-"));
  const ws: FakeWorkspace = { id: "ws-1", root: dir, writerId: null, generation: 1 };
  const owner = { projectId: "proj-1", workspaceId: ws.id };
  const app: FakeApp = {
    disposed: false,
    workspaceById: (id: string) => (id === ws.id ? ws : undefined),
    projectWorkspace: (value: unknown) =>
      value && typeof value === "object" && (value as { workspaceId?: string }).workspaceId === ws.id
        ? { project: { id: "proj-1" }, workspace: ws }
        : null,
    managedPath: async (absPath: string, workspaceId: string) => {
      if (workspaceId !== ws.id) return null;
      const rel = relative(dir, absPath);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
      return { path: absPath, workspace: ws };
    },
    joinWriteLease: (wsId: string, requesterId: string) => realJoin.call(app, wsId, requesterId),
    releaseWriteLease: (wsId: string, requesterId: string) => realRelease.call(app, wsId, requesterId),
    acquireWriteLease: (wsId: string, requesterId: string, timeoutMs?: number) =>
      realAcquire.call(app, wsId, requesterId, timeoutMs),
    grantLeaseWaiter: (target: FakeWorkspace) => realGrant.call(app, target),
    leaseWaiters: new Map(),
    durableReplaceFile: opts.durableReplace ?? ((path: string, data: string | Buffer, mode?: number) =>
      realDurableReplace.call(app, path, data, mode)),
    sweepReplaceTemps: async (_path: string) => undefined,
    projectOfWorkspace: (_id: string): null => null,
    projectIsSwitching: (_id: string | undefined): boolean => false,
    terminalsOnWorkspace: (_ws: FakeWorkspace): unknown[] => [],
    kickWorkspaceMomentCapture: (_ws: FakeWorkspace): void => undefined,
  };
  const call = (absPath: string, content: string, writerId: unknown) =>
    flushSave.call(app, {}, absPath, content, writerId, owner);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, ws, owner, app, call, cleanup };
}

describe("flush-save lease gate (refs #168)", () => {
  it("rejects a null writer on an idle workspace without touching bytes", async () => {
    const h = makeHarness();
    try {
      const file = join(h.dir, "note.txt");
      writeFileSync(file, "original-bytes");
      const result = await h.call(file, "flushed-bytes", null);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("the flush does not hold the write lease");
      expect(readFileSync(file, "utf8")).toBe("original-bytes");
      expect(h.ws.writerId).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("rejects undefined, non-string, and empty writers", async () => {
    const h = makeHarness();
    try {
      const file = join(h.dir, "note.txt");
      writeFileSync(file, "original-bytes");
      for (const writer of [undefined, 42, {}, "", "  ".slice(2)]) {
        const result = await h.call(file, "flushed-bytes", writer);
        expect(result.ok).toBe(false);
        expect(result.error).toBe("the flush does not hold the write lease");
      }
      expect(readFileSync(file, "utf8")).toBe("original-bytes");
    } finally {
      h.cleanup();
    }
  });

  it("rejects a non-holder while the lease is idle or held by another", async () => {
    const h = makeHarness();
    try {
      const file = join(h.dir, "note.txt");
      writeFileSync(file, "original-bytes");
      expect((await h.call(file, "x", "not-a-holder")).ok).toBe(false);
      const lease = await h.app.acquireWriteLease(h.ws.id, "preflight:term-1:req-1", 0);
      expect(lease.ok).toBe(true);
      expect((await h.call(file, "x", "not-a-holder")).ok).toBe(false);
      expect(readFileSync(file, "utf8")).toBe("original-bytes");
      h.app.releaseWriteLease(h.ws.id, "preflight:term-1:req-1");
    } finally {
      h.cleanup();
    }
  });

  it("rejects a stale holder that released before the flush", async () => {
    const h = makeHarness();
    try {
      const file = join(h.dir, "note.txt");
      writeFileSync(file, "original-bytes");
      await h.app.acquireWriteLease(h.ws.id, "preflight:term-1:req-1", 0);
      h.app.releaseWriteLease(h.ws.id, "preflight:term-1:req-1");
      expect(h.ws.writerId).toBeNull();
      const result = await h.call(file, "flushed-bytes", "preflight:term-1:req-1");
      expect(result.ok).toBe(false);
      expect(readFileSync(file, "utf8")).toBe("original-bytes");
    } finally {
      h.cleanup();
    }
  });

  it("saves through the genuine holder and releases the join", async () => {
    const h = makeHarness();
    try {
      const file = join(h.dir, "note.txt");
      writeFileSync(file, "original-bytes");
      await h.app.acquireWriteLease(h.ws.id, "preflight:term-1:req-1", 0);
      const result = await h.call(file, "flushed-bytes", "preflight:term-1:req-1");
      expect(result).toEqual({ ok: true });
      expect(readFileSync(file, "utf8")).toBe("flushed-bytes");
      // The join released: the holder's own depth is untouched (still 1).
      expect(h.ws.writerId).toBe("preflight:term-1:req-1");
      expect(h.ws.leaseDepth).toBe(1);
      h.app.releaseWriteLease(h.ws.id, "preflight:term-1:req-1");
      expect(h.ws.writerId).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("holds the lease across replacement so a competitor cannot interleave", async () => {
    let competitorOk: boolean | null = null;
    const h = makeHarness({
      durableReplace: async (path, data, mode) => {
        // A competing writer arriving mid-replacement must fail fast: the
        // flush joined the holder's lease across the whole write.
        competitorOk = (await h.app.acquireWriteLease(h.ws.id, "owned-competing-writer", 0)).ok;
        await realDurableReplace.call(h.app, path, data, mode);
      },
    });
    try {
      const file = join(h.dir, "note.txt");
      writeFileSync(file, "original-bytes");
      await h.app.acquireWriteLease(h.ws.id, "preflight:term-1:req-1", 0);
      const result = await h.call(file, "flushed-bytes", "preflight:term-1:req-1");
      expect(result).toEqual({ ok: true });
      expect(competitorOk).toBe(false);
      expect(readFileSync(file, "utf8")).toBe("flushed-bytes");
      h.app.releaseWriteLease(h.ws.id, "preflight:term-1:req-1");
    } finally {
      h.cleanup();
    }
  });

  it("still refuses non-regular files for the genuine holder", async () => {
    const h = makeHarness();
    try {
      await h.app.acquireWriteLease(h.ws.id, "preflight:term-1:req-1", 0);
      const result = await h.call(h.dir, "flushed-bytes", "preflight:term-1:req-1");
      expect(result.ok).toBe(false);
      h.app.releaseWriteLease(h.ws.id, "preflight:term-1:req-1");
    } finally {
      h.cleanup();
    }
  });
});

describe("dispatch genuine-holder flush (refs #205)", () => {
  it("acquires a real lease around the dispatch flush in dispatchRun", () => {
    const source = extractMethod(main, "private async dispatchRun(");
    const acquireAt = source.indexOf("acquireWriteLease(ownerWs.id, dispatchWriter");
    const flushAt = source.indexOf("flushDirtyModels(dispatchWriter, ownerWs.id");
    const releaseAt = source.indexOf("releaseWriteLease(ownerWs.id, dispatchWriter");
    expect(source).toContain("const dispatchWriter = `dispatch:${ownerId}`");
    expect(acquireAt).toBeGreaterThanOrEqual(0);
    expect(flushAt).toBeGreaterThan(acquireAt);
    expect(releaseAt).toBeGreaterThan(flushAt);
  });

  it("lets a dispatch writer holding the lease save through the gate", async () => {
    const h = makeHarness();
    try {
      const file = join(h.dir, "dirty.txt");
      writeFileSync(file, "old");
      // Without the lease the dispatch writer fails closed, as before.
      expect((await h.call(file, "new", "dispatch:term-1")).ok).toBe(false);
      // dispatchRun's acquire → flush → release makes it a genuine holder.
      const lease = await h.app.acquireWriteLease(h.ws.id, "dispatch:term-1", 5000);
      expect(lease.ok).toBe(true);
      try {
        expect(await h.call(file, "new", "dispatch:term-1")).toEqual({ ok: true });
      } finally {
        h.app.releaseWriteLease(h.ws.id, "dispatch:term-1");
      }
      expect(readFileSync(file, "utf8")).toBe("new");
    } finally {
      h.cleanup();
    }
  });

  it("fails dispatch with the busy error while a lease is held", async () => {
    const h = makeHarness();
    try {
      await h.app.acquireWriteLease(h.ws.id, "preflight:term-1:req-1", 0);
      // dispatchRun's acquire with the dispatch writer fails fast here.
      const lease = await h.app.acquireWriteLease(h.ws.id, "dispatch:term-1", 0);
      expect(lease.ok).toBe(false);
      expect(lease.error).toMatch(/another writer holds the lease/);
      h.app.releaseWriteLease(h.ws.id, "preflight:term-1:req-1");
    } finally {
      h.cleanup();
    }
  });
});
