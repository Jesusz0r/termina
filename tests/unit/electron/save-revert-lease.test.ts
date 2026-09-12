import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { lstat, mkdir, rm, writeFile, realpath as fsRealpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isErrno } from "../../../shared/guards.ts";
import ts from "typescript";

/**
 * Save/revert write-lease, binary-exact revert, and lstat-guard tests.
 *
 * The real TerminaApp methods are extracted from electron/main.ts and
 * transpiled (the moment-capture-lease suite's pattern), then exercised
 * against real temp files with the real lease acquire/release logic:
 * a held promote lease must fail saves and reverts busy, and reverting
 * a binary must restore the start-state blob byte for byte.
 */

const root = process.cwd();
const main = readFileSync(join(root, "electron", "main.ts"), "utf8");
const terminalInstance = readFileSync(join(root, "electron", "terminal-instance.ts"), "utf8");

function methodBody(source: string, signature: string, nextSignature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing ${signature}`);
  const end = source.indexOf(nextSignature, start + signature.length);
  return source.slice(start, end < 0 ? source.length : end);
}

function extractMethod(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing method ${signature}`);
  // The body opens at the first brace past the parameter list and the
  // return-type annotation (annotations like Promise<{...}> hold braces).
  // Parameters here hold no nested parens or braces.
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

type SaveEditorFile = (absPath: unknown, content: unknown, owner: unknown) => Promise<{ ok: boolean; error?: string }>;
type RevertReviewFile = (terminalId: string, path: string) => Promise<{ ok: boolean; error?: string }>;
type AcquireWriteLease = (wsId: string, requesterId: string, timeoutMs?: number) => Promise<{ ok: boolean; generation: number; error?: string }>;
type ReleaseWriteLease = (wsId: string, requesterId: string) => void;
type DeleteBaseline = (inst: FakeInst, path: string) => void;
type SetBaseline = (inst: FakeInst, path: string, value: string | null, stateId?: string | null) => void;
type SetBounded = <K, V>(map: Map<K, V>, key: K, value: V, limit: number) => void;
type RecordModified = (inst: FakeInst, absPath: string, status: "created" | "modified") => Promise<void>;
type PrepareRunBaselines = (inst: FakeInst) => void;

interface FakeWorkspace {
  id: string;
  root: string;
  writerId: string | null;
  leaseDepth: number;
  generation: number;
}

interface FakeInst {
  id: string;
  workspaceId: string;
  baselines: Map<string, string | null>;
  baselineStates: Map<string, string>;
  baselineBytes: number;
  modified: Map<string, { path: string; relPath: string; status: string }>;
  currentRun: { startStateId: string | null } | null;
}

interface FakeStore {
  readBlob: (stateId: string, relPath: string) => Promise<Buffer | null>;
}

const MAX_OPEN_FILE_SIZE = 2 * 1024 * 1024;
const TerminaAppConsts = {
  MAX_MODIFIED_FILES: 2000,
  MAX_BASELINE_FILES: 2000,
  MAX_BASELINE_BYTES: 64 * 1024 * 1024,
};

const saveEditorFile = loadMethod(
  "saveEditorFile",
  "private async saveEditorFile(",
  ["MAX_OPEN_FILE_SIZE", "lstat", "writeFile", "randomUUID", "isErrno"],
  [MAX_OPEN_FILE_SIZE, lstat, writeFile, randomUUID, isErrno],
) as SaveEditorFile;

const revertReviewFile = loadMethod(
  "revertReviewFile",
  "private async revertReviewFile(",
  ["lstat", "mkdir", "rm", "writeFile", "randomUUID", "isErrno", "relative", "isAbsolute", "dirname"],
  [lstat, mkdir, rm, writeFile, randomUUID, isErrno, relative, isAbsolute, dirname],
) as RevertReviewFile;

const realAcquire = loadMethod("acquireWriteLease", "private async acquireWriteLease(", [], []) as AcquireWriteLease;
const realRelease = loadMethod("releaseWriteLease", "private releaseWriteLease(", [], []) as ReleaseWriteLease;
const realDeleteBaseline = loadMethod("deleteBaseline", "private deleteBaseline(", [], []) as DeleteBaseline;
const realSetBaseline = loadMethod(
  "setBaseline",
  "private setBaseline(",
  ["TerminaApp"],
  [TerminaAppConsts],
) as SetBaseline;
const realSetBounded = loadMethod("setBounded", "private setBounded<", [], []) as SetBounded;
const realRecordModified = loadMethod(
  "recordModified",
  "private async recordModified(",
  ["TerminaApp"],
  [TerminaAppConsts],
) as RecordModified;
const realPrepareRunBaselines = loadMethod("prepareRunBaselines", "private prepareRunBaselines(", [], []) as PrepareRunBaselines;

/** Missing-tail-tolerant realpath, mirroring the production canonicalPath. */
async function tolerantCanonical(p: string): Promise<string> {
  let tail = "";
  let cur = p;
  while (true) {
    try {
      const real = await fsRealpath(cur);
      return tail ? join(real, tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail = tail ? join(basename(cur), tail) : basename(cur);
      cur = parent;
    }
  }
}

function makeWorkspace(wsRoot: string): FakeWorkspace {
  return { id: "ws-1", root: wsRoot, writerId: null, leaseDepth: 0, generation: 1 };
}

function makeInst(ws: FakeWorkspace): FakeInst {
  return {
    id: "term-1",
    workspaceId: ws.id,
    baselines: new Map(),
    baselineStates: new Map(),
    baselineBytes: 0,
    modified: new Map(),
    currentRun: null,
  };
}

function makeManagedPath(ws: FakeWorkspace, opts: { swapLeaf?: boolean } = {}) {
  // swapLeaf returns the admitted path without resolving the leaf, simulating
  // a post-admission leaf swap (a regular file replaced by a symlink). The
  // production canonicalPath resolves the leaf at admission; the lstat guard
  // must catch whatever the leaf became by write time.
  return async (absPath: string, workspaceId: string) => {
    if (workspaceId !== ws.id) return null;
    const rootCanon = await tolerantCanonical(ws.root);
    const pathCanon = opts.swapLeaf ? absPath : await tolerantCanonical(absPath);
    const rel = relative(rootCanon, pathCanon);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return { path: pathCanon, workspace: ws };
  };
}

function makeLeaseBroker(ws: FakeWorkspace) {
  const leaseApp = {
    workspaceById: (id: string) => (id === ws.id ? ws : null),
    kickWorkspaceMomentCapture: () => undefined,
  };
  return {
    acquireWriteLease: (wsId: string, requester: string, timeoutMs?: number) => realAcquire.call(leaseApp, wsId, requester, timeoutMs),
    releaseWriteLease: (wsId: string, requester: string) => realRelease.call(leaseApp, wsId, requester),
  };
}

function makeSaveApp(ws: FakeWorkspace, opts: { swapLeaf?: boolean } = {}) {
  return {
    ...makeLeaseBroker(ws),
    projectWorkspace: (owner: unknown) => (owner === "owner" ? { project: { id: "proj-1" }, workspace: ws } : null),
    managedPath: makeManagedPath(ws, opts),
  };
}

function makeRevertApp(ws: FakeWorkspace, inst: FakeInst, store: FakeStore | null, opts: { swapLeaf?: boolean } = {}) {
  return {
    ...makeLeaseBroker(ws),
    terminals: new Map([[inst.id, inst]]),
    managedPath: makeManagedPath(ws, opts),
    projectOfTerminal: (id: string) => (id === inst.id ? { storePromise: Promise.resolve(store) } : null),
    canonicalPath: (p: string) => fsRealpath(p),
    deleteBaseline: (target: FakeInst, path: string) => realDeleteBaseline.call(null, target, path),
  };
}

function makeRecordApp(ws: FakeWorkspace) {
  return {
    canonicalPath: (p: string) => tolerantCanonical(p),
    setBounded: <K, V>(map: Map<K, V>, key: K, value: V, limit: number) => realSetBounded.call(null, map, key, value, limit),
    rel: async (absPath: string, wsRoot: string) => relative(await tolerantCanonical(wsRoot), await tolerantCanonical(absPath)),
    workspaceOfTerminal: (_inst: FakeInst) => ws,
  };
}

function makeBaselineApp() {
  return {
    deleteBaseline: (target: FakeInst, path: string) => realDeleteBaseline.call(null, target, path),
  };
}

function makePrepareApp() {
  const baselineApp = makeBaselineApp();
  return {
    setBaseline: (inst: FakeInst, path: string, value: string | null, stateId?: string | null) =>
      realSetBaseline.call(baselineApp, inst, path, value, stateId),
  };
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "save-revert-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("editor save write lease", () => {
  it("saves under a short lease and releases it", async () => {
    const ws = makeWorkspace(dir);
    const file = join(dir, "note.txt");
    writeFileSync(file, "old");
    const res = await saveEditorFile.call(makeSaveApp(ws), file, "new", "owner");
    expect(res).toEqual({ ok: true });
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(ws.writerId).toBeNull();
    expect(ws.leaseDepth).toBe(0);
  });

  it("fails busy when a promote lease is held and leaves the file alone", async () => {
    const ws = makeWorkspace(dir);
    ws.writerId = "promote:op-1";
    ws.leaseDepth = 1;
    const file = join(dir, "note.txt");
    writeFileSync(file, "old");
    const res = await saveEditorFile.call(makeSaveApp(ws), file, "new", "owner");
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toMatch(/lease|busy/);
    expect(readFileSync(file, "utf8")).toBe("old");
    expect(ws.writerId).toBe("promote:op-1");
    expect(ws.leaseDepth).toBe(1);
  });

  it("releases the lease when the path is outside the workspace", async () => {
    const ws = makeWorkspace(dir);
    const res = await saveEditorFile.call(makeSaveApp(ws), join(dir, "..", "escape.txt"), "new", "owner");
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toContain("outside the project workspace");
    expect(ws.writerId).toBeNull();
  });

  it("refuses a leaf swapped for a symlink and leaves the target alone", async () => {
    const ws = makeWorkspace(dir);
    const target = join(dir, "target.txt");
    writeFileSync(target, "target-content");
    const link = join(dir, "link.txt");
    symlinkSync(target, link);
    const res = await saveEditorFile.call(makeSaveApp(ws, { swapLeaf: true }), link, "evil", "owner");
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toContain("not a regular file");
    expect(readFileSync(target, "utf8")).toBe("target-content");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(ws.writerId).toBeNull();
  });

  it("refuses directories and missing files", async () => {
    const ws = makeWorkspace(dir);
    const app = makeSaveApp(ws);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const dirRes = await saveEditorFile.call(app, sub, "new", "owner");
    expect(dirRes.ok).toBe(false);
    expect(dirRes.error ?? "").toContain("not a regular file");
    const missingRes = await saveEditorFile.call(app, join(dir, "missing.txt"), "new", "owner");
    expect(missingRes.ok).toBe(false);
    expect(ws.writerId).toBeNull();
  });
});

describe("change review revert", () => {
  it("restores byte-exact start-state blob for a binary file", async () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    const file = join(dir, "blob.bin");
    const original = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfd, 0xfb]);
    const mangled = original.toString("utf8");
    // The fixture must be genuinely lossy, or this test would prove nothing.
    expect(Buffer.from(mangled, "utf8").equals(original)).toBe(false);
    writeFileSync(file, Buffer.from("changed-by-agent"));
    inst.baselines.set(file, mangled);
    inst.baselineStates.set(file, "state-1");
    const calls: Array<{ stateId: string; relPath: string }> = [];
    const store: FakeStore = {
      readBlob: async (stateId, relPath) => {
        calls.push({ stateId, relPath });
        return stateId === "state-1" && relPath === "blob.bin" ? original : null;
      },
    };
    const res = await revertReviewFile.call(makeRevertApp(ws, inst, store), inst.id, file);
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual([{ stateId: "state-1", relPath: "blob.bin" }]);
    expect(readFileSync(file)).toEqual(original);
    expect(inst.baselines.has(file)).toBe(false);
    expect(inst.baselineStates.has(file)).toBe(false);
    expect(ws.writerId).toBeNull();
  });

  it("falls back to the stored string when no anchor exists", async () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    const file = join(dir, "note.txt");
    writeFileSync(file, "changed");
    inst.baselines.set(file, "original");
    const res = await revertReviewFile.call(makeRevertApp(ws, inst, null), inst.id, file);
    expect(res).toEqual({ ok: true });
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(inst.baselines.has(file)).toBe(false);
    expect(ws.writerId).toBeNull();
  });

  it("falls back to the stored string when the blob is gone", async () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    const file = join(dir, "note.txt");
    writeFileSync(file, "changed");
    inst.baselines.set(file, "original");
    inst.baselineStates.set(file, "evicted-state");
    const store: FakeStore = { readBlob: async () => null };
    const res = await revertReviewFile.call(makeRevertApp(ws, inst, store), inst.id, file);
    expect(res).toEqual({ ok: true });
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(ws.writerId).toBeNull();
  });

  it("removes a created regular file and consumes the baseline", async () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    const file = join(dir, "created.txt");
    writeFileSync(file, "agent-made");
    inst.baselines.set(file, null);
    const res = await revertReviewFile.call(makeRevertApp(ws, inst, null), inst.id, file);
    expect(res).toEqual({ ok: true });
    expect(() => readFileSync(file)).toThrow();
    expect(inst.baselines.has(file)).toBe(false);
    expect(ws.writerId).toBeNull();
  });

  it("refuses to remove a created non-regular file and keeps the baseline", async () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    const target = join(dir, "target.txt");
    writeFileSync(target, "target-content");
    const link = join(dir, "created-link.txt");
    symlinkSync(target, link);
    inst.baselines.set(link, null);
    const res = await revertReviewFile.call(makeRevertApp(ws, inst, null, { swapLeaf: true }), inst.id, link);
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toContain("not a regular file");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("target-content");
    expect(inst.baselines.get(link)).toBeNull();
    expect(ws.writerId).toBeNull();
  });

  it("fails busy when a promote lease is held and keeps the baseline", async () => {
    const ws = makeWorkspace(dir);
    ws.writerId = "promote:op-1";
    ws.leaseDepth = 1;
    const inst = makeInst(ws);
    const file = join(dir, "note.txt");
    writeFileSync(file, "changed");
    inst.baselines.set(file, "original");
    const res = await revertReviewFile.call(makeRevertApp(ws, inst, null), inst.id, file);
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toMatch(/lease|busy/);
    expect(readFileSync(file, "utf8")).toBe("changed");
    expect(inst.baselines.get(file)).toBe("original");
    expect(ws.writerId).toBe("promote:op-1");
  });

  it("restores a deleted file including its parent directory", async () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    const file = join(dir, "sub", "gone.txt");
    const blob = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x41, 0x42]);
    inst.baselines.set(file, blob.toString("utf8"));
    inst.baselineStates.set(file, "state-1");
    const store: FakeStore = {
      readBlob: async (stateId, relPath) => (stateId === "state-1" && relPath === join("sub", "gone.txt") ? blob : null),
    };
    const res = await revertReviewFile.call(makeRevertApp(ws, inst, store), inst.id, file);
    expect(res).toEqual({ ok: true });
    expect(readFileSync(file)).toEqual(blob);
    expect(ws.writerId).toBeNull();
  });

  it("refuses to write over a non-regular leaf and keeps the baseline", async () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    const target = join(dir, "target.txt");
    writeFileSync(target, "target-content");
    const link = join(dir, "link.txt");
    symlinkSync(target, link);
    inst.baselines.set(link, "original");
    const res = await revertReviewFile.call(makeRevertApp(ws, inst, null, { swapLeaf: true }), inst.id, link);
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toContain("not a regular file");
    expect(readFileSync(target, "utf8")).toBe("target-content");
    expect(inst.baselines.get(link)).toBe("original");
    expect(ws.writerId).toBeNull();
  });
});

describe("baseline anchors", () => {
  it("anchors an unanchored baseline to the live run start", async () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    inst.currentRun = { startStateId: "state-9" };
    const file = join(dir, "note.txt");
    writeFileSync(file, "changed");
    inst.baselines.set(file, "original");
    await realRecordModified.call(makeRecordApp(ws), inst, file, "modified");
    expect(inst.baselineStates.get(file)).toBe("state-9");
    expect(inst.modified.get(file)?.status).toBe("modified");
  });

  it("preserves an existing anchor across later runs", async () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    inst.currentRun = { startStateId: "state-9" };
    const file = join(dir, "note.txt");
    writeFileSync(file, "changed");
    inst.baselines.set(file, "original");
    inst.baselineStates.set(file, "state-1");
    await realRecordModified.call(makeRecordApp(ws), inst, file, "modified");
    expect(inst.baselineStates.get(file)).toBe("state-1");
  });

  it("anchors nothing without a run", async () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    const file = join(dir, "note.txt");
    writeFileSync(file, "changed");
    inst.baselines.set(file, "original");
    await realRecordModified.call(makeRecordApp(ws), inst, file, "modified");
    expect(inst.baselineStates.has(file)).toBe(false);
    expect(inst.modified.has(file)).toBe(true);
  });

  it("stores anchors on set and clears them on replace, null, and delete", () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    const app = makeBaselineApp();
    const file = join(dir, "note.txt");
    realSetBaseline.call(app, inst, file, "v1", "s1");
    expect(inst.baselineStates.get(file)).toBe("s1");
    realSetBaseline.call(app, inst, file, "v2");
    expect(inst.baselineStates.has(file)).toBe(false);
    realSetBaseline.call(app, inst, file, "v3", "s3");
    realSetBaseline.call(app, inst, file, null);
    expect(inst.baselineStates.has(file)).toBe(false);
    realSetBaseline.call(app, inst, file, "v4", "s4");
    realDeleteBaseline.call(null, inst, file);
    expect(inst.baselines.has(file)).toBe(false);
    expect(inst.baselineStates.has(file)).toBe(false);
  });

  it("preserves retained anchors and drops untouched files for first-touch capture", () => {
    const ws = makeWorkspace(dir);
    const inst = makeInst(ws);
    const kept = join(dir, "kept.txt");
    const fresh = join(dir, "fresh.txt");
    inst.modified.set(kept, { path: kept, relPath: "kept.txt", status: "modified" });
    inst.baselines.set(kept, "old");
    inst.baselineStates.set(kept, "run-1");
    inst.baselines.set(fresh, "stale");
    // Issue #60: no wholesale cache copy — untouched files have no baseline until first touch.
    realPrepareRunBaselines.call(makePrepareApp(), inst);
    expect(inst.baselines.get(kept)).toBe("old");
    expect(inst.baselineStates.get(kept)).toBe("run-1");
    expect(inst.baselines.has(fresh)).toBe(false);
    expect(inst.baselineStates.has(fresh)).toBe(false);
    expect(inst.baselineBytes).toBe(Buffer.byteLength("old", "utf8"));
  });
});

describe("save/revert wiring", () => {
  it("pins the injected production constants", () => {
    expect(main).toContain("const MAX_OPEN_FILE_SIZE = 2 * 1024 * 1024;");
    expect(main).toContain("private static readonly MAX_MODIFIED_FILES = 2000;");
    expect(main).toContain("private static readonly MAX_BASELINE_FILES = 2000;");
    expect(main).toContain("private static readonly MAX_BASELINE_BYTES = 64 * 1024 * 1024;");
    expect(terminalInstance).toContain("baselineStates = new Map<string, string>();");
  });

  it("routes file:save through the leased method with no parallel path", () => {
    const handler = methodBody(main, 'ipcMain.handle("file:save"', 'ipcMain.handle("explorer:list-dir"');
    expect(handler).toContain("this.saveEditorFile(");
    expect(handler).not.toContain("assertWorkspaceWritable");
    expect(handler).not.toContain("writeFile(");
    const method = extractMethod(main, "private async saveEditorFile(");
    expect(method).toContain("acquireWriteLease");
    expect(method).toContain("releaseWriteLease");
    expect(method).toContain("lstat(");
  });

  it("routes review:revert through the blob method with no parallel path", () => {
    const handler = methodBody(main, 'ipcMain.handle("review:revert"', 'ipcMain.handle("file:open"');
    expect(handler).toContain("this.revertReviewFile(");
    expect(handler).not.toContain("assertWorkspaceWritable");
    expect(handler).not.toContain("writeFile(");
    expect(handler).not.toContain("readBlob");
    const method = extractMethod(main, "private async revertReviewFile(");
    expect(method).toContain("acquireWriteLease");
    expect(method).toContain("releaseWriteLease");
    expect(method).toContain("readBlob");
    expect(method).toContain("lstat(");
    expect(method).toContain("baselineStates");
  });

  it("guards the preflight flush write with lstat", () => {
    const handler = methodBody(main, 'ipcMain.handle("file:flush-save"', 'ipcMain.handle("verify:detect"');
    expect(handler).toContain("lstat(managed.path)");
    expect(handler).not.toContain("await stat(managed.path)");
  });

  it("anchors baselines at the canonical capture points", () => {
    expect(extractMethod(main, "private async recordModified(")).toContain("baselineStates");
    expect(extractMethod(main, "private setBaseline(")).toContain("baselineStates");
    expect(extractMethod(main, "private deleteBaseline(")).toContain("baselineStates");
    expect(extractMethod(main, "private prepareRunBaselines(")).toContain("retainedStates");
    expect(extractMethod(main, "private async fillBaselineFromState(")).toContain("this.setBaseline(inst, path, content.toString(\"utf8\"), stateId);");
    expect(extractMethod(main, "private collectWorker(")).toContain("worker.baselineStates.get(p)");
  });
});
