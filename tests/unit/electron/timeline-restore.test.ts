import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { readPromotionEntry } from "../../../electron/worldlines/promotion-recovery/entry-state.ts";
import { revertReviewedFile } from "../../../electron/review-revert.ts";
import type { TimelineEvent } from "../../../shared/types.ts";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let method = "";
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === "restoreTimelineFile") method = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!method) throw new Error("missing timeline restore owner");
const compiled = ts.transpile(`class Main { ${method} } return new Main();`, { target: ts.ScriptTarget.ES2022 });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "termina-timeline-restore-")));
  roots.push(root);
  const path = join(root, "file.txt");
  writeFileSync(path, "current\n");
  const ev: TimelineEvent = { seq: 1, ts: 1, t: "tool", path, relPath: "file.txt", stateId: "a".repeat(40), content: "untrusted preview" };
  const inst = { id: "term-1", generation: 1, workspaceId: "primary", closed: false, timeline: [ev], sessionId: "kept", sessionFile: "kept.jsonl" };
  const workspace = { id: "primary", generation: 1, canonicalRoot: root, primary: true, writerId: null as string | null };
  const store = { symlinkTarget: vi.fn(async (): Promise<string | null> => null), readBlob: vi.fn(async (): Promise<Buffer | null> => Buffer.from("captured\n")) };
  const project = { id: "project-1", storePromise: Promise.resolve(store) };
  const state = {
    disposed: false, runtime: new Map([[inst.id, inst]]),
    workspaceOfTerminal: () => workspace, projectOfTerminal: () => project,
    acquireWriteLease: vi.fn(async (_id: string, requester: string) => {
      if (workspace.writerId) return { ok: false, generation: 1, error: "busy" };
      workspace.writerId = requester;
      return { ok: true, generation: 1 };
    }),
    releaseWriteLease: vi.fn(() => { workspace.writerId = null; }),
    explorerWorkspaceIsLive: () => true,
    sourceAdmissions: { writerAt: vi.fn(() => false) },
    managedPath: vi.fn(async (target: string) => ({ path: await realpath(target).catch(() => target), workspace })),
  };
  const main = Object.assign(new Function("relative", "sep", "randomUUID", "readPromotionEntry", "revertReviewedFile", compiled)(
    relative, sep, randomUUID, readPromotionEntry, revertReviewedFile,
  ), state) as typeof state & { restoreTimelineFile(id: unknown, generation: unknown, seq: unknown): Promise<{ ok: boolean; error?: string }> };
  return { root, path, ev, inst, workspace, store, main };
}

describe("Timeline file restoration (#465)", () => {
  it("writes captured bytes, ignoring the preview, and keeps the session and other files", async () => {
    const f = fixture();
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    f.store.readBlob.mockResolvedValue(bytes);
    writeFileSync(join(f.root, "other.txt"), "keep");
    expect(await f.main.restoreTimelineFile(f.inst.id, 1, 1)).toEqual({ ok: true });
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(readFileSync(join(f.root, "other.txt"), "utf8")).toBe("keep");
    expect(f.inst.sessionId).toBe("kept");
    expect(f.inst.sessionFile).toBe("kept.jsonl");
    expect(f.main.runtime.get(f.inst.id)).toBe(f.inst);
    expect(f.workspace.writerId).toBeNull();
    expect(f.main.acquireWriteLease).toHaveBeenCalledExactlyOnceWith("primary", expect.stringMatching(/^timeline-restore:/), 0);
  });

  it("recreates a missing file and parent without restoring the whole tree", async () => {
    const f = fixture();
    f.ev.path = join(f.root, "missing", "file.txt");
    expect(await f.main.restoreTimelineFile(f.inst.id, 1, 1)).toEqual({ ok: true });
    expect(readFileSync(f.ev.path, "utf8")).toBe("captured\n");
    expect(readFileSync(f.path, "utf8")).toBe("current\n");
  });

  it.skipIf(process.platform === "win32")("refuses unsupported backslash filenames instead of restoring a different nested path", async () => {
    const f = fixture();
    f.ev.path = join(f.root, "literal\\name.txt");
    writeFileSync(f.ev.path, "current\n");
    expect((await f.main.restoreTimelineFile(f.inst.id, 1, 1)).ok).toBe(false);
    expect(readFileSync(f.ev.path, "utf8")).toBe("current\n");
    expect(existsSync(join(f.root, "literal", "name.txt"))).toBe(false);
  });

  it.each(["missing capture", "evicted", "candidate", "writer", "lease", "captured symlink", "missing blob", "directory", "symlink"])("rejects %s without changing file bytes", async cause => {
    const f = fixture();
    if (cause === "missing capture") f.ev.stateId = null;
    else if (cause === "evicted") f.ev.evicted = true;
    else if (cause === "candidate") f.workspace.primary = false;
    else if (cause === "writer") f.main.sourceAdmissions.writerAt.mockReturnValue(true);
    else if (cause === "lease") f.workspace.writerId = "promotion";
    else if (cause === "captured symlink") f.store.symlinkTarget.mockResolvedValue("target");
    else if (cause === "missing blob") f.store.readBlob.mockResolvedValue(null);
    else if (cause === "directory") { f.ev.path = join(f.root, "directory"); mkdirSync(f.ev.path); }
    else { f.ev.path = join(f.root, "alias"); symlinkSync(f.path, f.ev.path); }
    expect((await f.main.restoreTimelineFile(f.inst.id, 1, 1)).ok).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe("current\n");
  });

  it.each(["generation", "event", "path", "source", "disk"])("rejects a changed %s during the captured blob read", async change => {
    const f = fixture();
    f.store.readBlob.mockImplementation(async () => {
      if (change === "generation") f.workspace.generation++;
      else if (change === "event") f.inst.timeline = [];
      else if (change === "path") f.ev.path = join(f.root, "other.txt");
      else if (change === "source") f.main.sourceAdmissions.writerAt.mockReturnValue(true);
      else writeFileSync(f.path, "newer changes\n");
      return Buffer.from("captured\n");
    });
    expect((await f.main.restoreTimelineFile(f.inst.id, 1, 1)).ok).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(change === "disk" ? "newer changes\n" : "current\n");
    expect(f.main.releaseWriteLease).toHaveBeenCalledOnce();
  });

  it("fails closed for malformed requests, stale terminal generations and core read failures", async () => {
    const f = fixture();
    for (const args of [[null, 1, 1], [f.inst.id, "1", 1], [f.inst.id, 1, NaN], [f.inst.id, 2, 1], [f.inst.id, 1, 2]]) {
      expect((await f.main.restoreTimelineFile(args[0], args[1], args[2])).ok).toBe(false);
    }
    f.store.readBlob.mockRejectedValue(new Error("retained capture unavailable"));
    expect(await f.main.restoreTimelineFile(f.inst.id, 1, 1)).toMatchObject({ ok: false, error: "retained capture unavailable" });
    expect(readFileSync(f.path, "utf8")).toBe("current\n");
    expect(f.workspace.writerId).toBeNull();
  });
});
