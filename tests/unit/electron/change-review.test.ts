import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as editorFile from "../../../electron/main/editor-file.ts";
import ts from "typescript";
import { reviewBaseline, reviewDiff, reviewFiles } from "../../../electron/main/change-review.ts";
import type { ModifiedFile, ReviewTarget } from "../../../shared/types.ts";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const methods: string[] = [];
const handlers: string[] = [];
const pathMethods: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && ["reviewScope", "projectWorkspace"].includes(node.name.getText(source))) methods.push(node.getText(source));
  if (ts.isMethodDeclaration(node) && ["managedPath", "hasDanglingSymlink", "canonicalPath"].includes(node.name.getText(source))) pathMethods.push(node.getText(source));
  if (ts.isCallExpression(node) && node.expression.getText(source) === "ipcMain.handle"
    && node.arguments[0] && ['"review:files"', '"review:diff"'].includes(node.arguments[0].getText(source))) handlers.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
if (methods.length !== 2 || handlers.length !== 2) throw new Error("review main seams missing");
const compiled = ts.transpile(`class Main { ${methods.join("\n")} register() { ${handlers.join(";\n")}; } } return new Main();`, { target: ts.ScriptTarget.ES2022 });

function fixture(root: string) {
  const workspace = { id: "ws", root, canonicalRoot: root, generation: 3, terminalIds: new Set(["term"]), watcher: null as null | { sourceVersion(): { revision: number; observationEpoch: number; activityRevision: number } | null } };
  const project = { id: "project", workspaces: new Map([[workspace.id, workspace]]) };
  const inst = { id: "term", generation: 7, projectId: project.id, workspaceId: workspace.id, closed: false,
    modified: new Map<string, ModifiedFile>(), baselines: new Map<string, string | null>(), baselineFills: new Map<string, Promise<void>>() };
  const target: ReviewTarget = { projectId: project.id, workspaceId: workspace.id, terminalId: inst.id, generation: inst.generation, root };
  const ipc = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>();
  const main = new Function("ipcMain", "reviewFiles", "reviewDiff", "MAX_OPEN_FILE_SIZE", compiled)(
    { handle: (name: string, fn: (...args: unknown[]) => unknown) => ipc.set(name, fn) }, reviewFiles, reviewDiff, 16,
  );
  Object.assign(main, { projects: new Map([[project.id, project]]), workspaceOwners: new Map([[workspace.id, project.id]]), runtime: new Map([[inst.id, inst]]),
    managedPath: vi.fn(async (path: string) => ({ path, workspace })) });
  main.register();
  const call = (channel: string, ...args: unknown[]) => ipc.get(channel)!(null, ...args);
  const add = (status: ModifiedFile["status"] = "modified", baseline: string | null | undefined = "before") => {
    const file = { path: join(root, "file"), relPath: "file", status };
    inst.modified.set(file.path, file);
    if (baseline !== undefined) inst.baselines.set(file.path, baseline);
    return file;
  };
  return { main, project, workspace, inst, target, call, add };
}

describe("scoped read-only review", () => {
  let root: string;
  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "change-review-"))); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  it("uses actual managed-path authorization for traversal and symlink scope", async () => {
    const f = fixture(root);
    const factory = ts.transpile(`class Paths { ${pathMethods.join("\n")} } return new Paths();`, { target: ts.ScriptTarget.ES2022 });
    const paths = new Function("lstat", "fsRealpath", "resolve", "dirname", "join", "basename", "relative", "isAbsolute", factory)(lstat, realpath, resolve, dirname, join, basename, relative, isAbsolute);
    paths.workspaceById = () => f.workspace;
    f.main.managedPath = paths.managedPath.bind(paths);
    const traversal = join(root, "..", "outside-review-file");
    f.inst.modified.set(traversal, { path: traversal, relPath: "../outside-review-file", status: "modified" });
    expect(await f.call("review:diff", f.target, traversal)).toMatchObject({ ok: false });
    const link = join(root, "link");
    await symlink(dirname(root), link);
    const outside = join(link, "file");
    f.inst.modified.set(outside, { path: outside, relPath: "link/file", status: "modified" });
    expect(await f.call("review:diff", f.target, outside)).toMatchObject({ ok: false });
    const file = f.add();
    await writeFile(file.path, "after");
    expect(await f.call("review:diff", f.target, file.path)).toMatchObject({ ok: true, current: "after" });
  });

  it.each(["generation", "observation", "clear", "baseline", "status"])("fences %s changes during current disk reads", async (change) => {
    const f = fixture(root); const file = f.add();
    let revision = 1;
    f.workspace.watcher = { sourceVersion: () => ({ revision, observationEpoch: 1, activityRevision: revision }) };
    let finish!: (bytes: Buffer<ArrayBuffer>) => void;
    const read = vi.spyOn(editorFile, "readEditorFile").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const request = f.call("review:diff", f.target, file.path);
    for (let i = 0; i < 10 && !read.mock.calls.length; i++) await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    if (change === "generation") f.workspace.generation++;
    if (change === "observation") revision++;
    if (change === "clear") f.inst.modified.clear();
    if (change === "baseline") f.inst.baselines.set(file.path, "other");
    if (change === "status") file.status = "deleted";
    finish(Buffer.from("after"));
    expect(await request).toMatchObject({ ok: false });
  });

  it("validates refs and offsets and returns fixed insertion-order pages", async () => {
    const f = fixture(root);
    for (let i = 0; i < 115; i++) f.inst.modified.set(String(i), { path: String(i), relPath: String(i), status: "modified" });
    for (const bad of [null, [], {}, { ...f.target, generation: "7" }, { ...f.target, generation: 8 }, { ...f.target, root: "/other" }, { ...f.target, projectId: "other" }, { ...f.target, workspaceId: "other" }, { ...f.target, terminalId: "other" }]) {
      expect(await f.call("review:files", bad, 0)).toMatchObject({ ok: false });
    }
    for (const offset of [-1, 0.5, NaN, Infinity, "0", Number.MAX_SAFE_INTEGER + 1]) expect(await f.call("review:files", f.target, offset)).toMatchObject({ ok: false });
    const page = reviewFiles(f.inst.modified, 50);
    expect(page.ok && page.files.map((file) => file.path)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 50)));
    expect(page).toMatchObject({ total: 115 });
    expect(await f.call("review:files", f.target, 115)).toEqual({ ok: true, files: [], total: 115 });
    f.inst.closed = true;
    expect(await f.call("review:files", f.target, 0)).toMatchObject({ ok: false });
  });

  it.each(["created", "modified", "deleted"] as const)("reads truthful %s diffs without activation or editor mutations", async (status) => {
    const f = fixture(root);
    const file = f.add(status, status === "created" ? null : "before");
    if (status !== "deleted") await writeFile(file.path, "after");
    f.main.projectActivate = vi.fn();
    f.main.openFileInEditor = vi.fn();
    const before = [...f.inst.modified];
    expect(await f.call("review:diff", f.target, file.path)).toEqual({ ok: true, ...file, baseline: status === "created" ? null : "before", current: status === "deleted" ? "" : "after", deleted: status === "deleted" });
    expect([...f.inst.modified]).toEqual(before);
    expect(f.main.projectActivate).not.toHaveBeenCalled();
    expect(f.main.openFileInEditor).not.toHaveBeenCalled();
  });

  it("shows identical sides for reverted files and never invents missing baselines", async () => {
    const f = fixture(root);
    const file = f.add();
    await writeFile(file.path, "before");
    expect(await f.call("review:diff", f.target, file.path)).toMatchObject({ ok: true, baseline: "before", current: "before" });
    f.inst.baselines.clear();
    expect(await f.call("review:diff", f.target, file.path)).toMatchObject({ ok: false, error: "baseline is unavailable" });
    expect(await f.call("review:diff", f.target, join(root, "unlisted"))).toMatchObject({ ok: false });
  });

  it.each(["runtime", "closed", "project", "workspace", "root", "generation", "terminal-generation", "clear", "remove", "watcher"])("rejects %s changes during a pending baseline fill", async (change) => {
    const f = fixture(root);
    const file = f.add();
    f.inst.baselines.clear();
    let finish!: () => void;
    f.inst.baselineFills.set(file.path, new Promise<void>((resolve) => { finish = resolve; }));
    const request = f.call("review:diff", f.target, file.path);
    await Promise.resolve(); await Promise.resolve();
    if (change === "runtime") f.main.runtime.set(f.inst.id, { ...f.inst });
    if (change === "closed") f.inst.closed = true;
    if (change === "project") f.main.projects.set(f.project.id, { ...f.project });
    if (change === "workspace") f.project.workspaces.set(f.workspace.id, { ...f.workspace });
    if (change === "root") f.workspace.root = "/other";
    if (change === "generation") f.workspace.generation++;
    if (change === "terminal-generation") f.inst.generation++;
    if (change === "clear") f.inst.modified.clear();
    if (change === "remove") f.inst.modified.delete(file.path);
    if (change === "watcher") f.workspace.watcher = { sourceVersion: () => ({ revision: 1, observationEpoch: 1, activityRevision: 1 }) };
    f.inst.baselines.set(file.path, "before"); finish();
    expect(await request).toMatchObject({ ok: false });
  });

  it("shares baseline fill/null/status semantics with regular review", async () => {
    const f = fixture(root); const file = f.add("deleted");
    f.inst.baselines.clear();
    let finish!: () => void;
    f.inst.baselineFills.set(file.path, new Promise<void>((resolve) => { finish = resolve; }));
    const pending = reviewBaseline(f.inst, file.path, () => true);
    f.inst.baselines.set(file.path, "before"); finish();
    expect(await pending).toEqual({ status: "deleted", baseline: "before" });
    f.inst.baselines.set(file.path, null);
    expect(await reviewBaseline(f.inst, file.path, () => true)).toEqual({ status: "created", baseline: null });
    expect(await reviewBaseline(f.inst, file.path, () => false)).toEqual({ status: "modified", baseline: undefined });
  });

  it.each(["missing", "binary", "large", "baseline-binary", "baseline-large", "directory", "symlink"])("rejects unsupported %s content explicitly", async (kind) => {
    const f = fixture(root); const file = f.add();
    if (kind === "binary") await writeFile(file.path, Buffer.from([0xff, 0]));
    if (kind === "large") await writeFile(file.path, "x".repeat(17));
    if (kind === "baseline-binary") f.inst.baselines.set(file.path, "\0");
    if (kind === "baseline-large") f.inst.baselines.set(file.path, "x".repeat(17));
    if (kind === "directory") file.path = root;
    if (kind === "symlink") { await writeFile(join(root, "target"), "text"); await symlink(join(root, "target"), file.path); }
    expect(await reviewDiff(f.inst, file, () => true, 16)).toMatchObject({ ok: false });
  });

  it("rejects paths canonicalized to another scope or spelling before reading", async () => {
    const f = fixture(root); const file = f.add();
    f.main.managedPath.mockResolvedValueOnce(null);
    expect(await f.call("review:diff", f.target, file.path)).toMatchObject({ ok: false });
    f.main.managedPath.mockResolvedValueOnce({ workspace: f.workspace, path: "/outside" });
    expect(await f.call("review:diff", f.target, file.path)).toMatchObject({ ok: false });
    f.main.managedPath.mockResolvedValueOnce({ workspace: { ...f.workspace }, path: file.path });
    expect(await f.call("review:diff", f.target, file.path)).toMatchObject({ ok: false });
  });
});
