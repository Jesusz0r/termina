import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { isErrno } from "../../../shared/guards.ts";
import { previewKind } from "../../../shared/preview-media.ts";
import { decodeEditorText, readEditorFile } from "../../../electron/main/editor-file.ts";
import type { EditorFileResult, ProjectWorkspaceRef } from "../../../shared/types.ts";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const methods: string[] = [];
let flushHandler = "";
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && ["saveEditorFile", "writeLeasedEditorFile", "openFileInEditor", "projectWorkspace", "explorerWorkspace", "writableProjectWorkspace", "flushDirtyModels"].includes(node.name.getText(source))) {
    methods.push(node.getText(source));
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === "ipcMain.handle" && node.arguments[0]?.getText(source) === '"file:flush-save"') {
    flushHandler = node.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!flushHandler) throw new Error("production flush-save handler is missing");
const factory = ts.transpile(`class Main { ${methods.join("\n")} register() { ${flushHandler}; } } return new Main();`, { target: ts.ScriptTarget.ES2022 });

type WriteResult = { ok: boolean; error?: string };
interface Workspace { id: string; root: string; primary: boolean; changeLines: Map<string, number[]> }
interface Harness {
  saveEditorFile(path: string, content: string, owner: ProjectWorkspaceRef, restore?: boolean): Promise<WriteResult>;
  openFileInEditor(path: string, owner: ProjectWorkspaceRef, purpose?: "editor"): Promise<EditorFileResult>;
  acquireWriteLease: ReturnType<typeof vi.fn>;
  joinWriteLease: ReturnType<typeof vi.fn>;
  releaseWriteLease: ReturnType<typeof vi.fn>;
  durableReplaceFile: ReturnType<typeof vi.fn>;
  projectIsSwitching: ReturnType<typeof vi.fn>;
  flushDirtyModels(writerId: string, workspaceId: string): Promise<{ ok: boolean; failed: string[] }>;
  flushWaiters: Map<string, unknown>;
  send: ReturnType<typeof vi.fn>;
  editorDrafts: { get: ReturnType<typeof vi.fn> };
}

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "editor-workspace-access-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fixture(primary: boolean) {
  const workspace: Workspace = { id: primary ? "primary" : "candidate", root, primary, changeLines: new Map() };
  const project = { id: "project", workspaces: new Map([[workspace.id, workspace]]) };
  const owner = { projectId: project.id, workspaceId: workspace.id };
  let flush!: (event: unknown, path: string, content: string, writer: string, owner: ProjectWorkspaceRef, restore?: boolean) => Promise<WriteResult>;
  const context = {
    ipcMain: { handle: (_name: string, fn: typeof flush) => { flush = fn; } },
    MAX_OPEN_FILE_SIZE: 2 * 1024 * 1024, MAX_PREVIEW_FILE_SIZE: 32 * 1024 * 1024,
    randomUUID, lstat, mkdir, dirname, isErrno, stat, previewKind, decodeEditorText, readEditorFile,
  };
  const main = new Function(...Object.keys(context), factory)(...Object.values(context)) as Harness & { register(): void };
  Object.assign(main, {
    projects: new Map([[project.id, project]]), workspaceOwners: new Map([[workspace.id, project.id]]),
    projectIsSwitching: vi.fn(() => false), rendererGeneration: 1,
    managedPath: vi.fn(async (path: string) => ({ path, workspace })), canonicalPath: async (path: string) => path,
    editorDrafts: { get: vi.fn(async () => null) },
    projectOfWorkspace: (id: string) => id === workspace.id ? project : null,
    flushWaiters: new Map(), send: vi.fn(() => false),
    acquireWriteLease: vi.fn(async () => ({ ok: true })), joinWriteLease: vi.fn(() => true), releaseWriteLease: vi.fn(),
    durableReplaceFile: vi.fn(async (path: string, content: string) => { await writeFile(path, content); }),
  });
  main.register();
  return { main, workspace, owner, flush: (path: string, content: string, restore = false) => flush(null, path, content, "preflight:holder", owner, restore) };
}

describe("main owns editor workspace access", () => {
  it.each([false, true])("returns authoritative read-only metadata for primary=%s text and media", async (primary) => {
    const { main, owner } = fixture(primary);
    const text = join(root, "file.txt");
    const image = join(root, "image.png");
    await writeFile(text, "disk text");
    await writeFile(image, "fixture image");
    expect(await main.openFileInEditor(text, owner, "editor")).toMatchObject({ ok: true, readOnly: !primary, content: "disk text" });
    expect(await main.openFileInEditor(image, owner, "editor")).toMatchObject({ ok: true, readOnly: !primary, preview: "image" });
  });

  it("rejects ordinary candidate saves before acquiring a lease or replacing bytes", async () => {
    const { main, owner } = fixture(false);
    const path = join(root, "file.txt");
    await writeFile(path, "candidate bytes");
    expect(await main.saveEditorFile(path, "renderer bytes", owner)).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    expect(await readFile(path, "utf8")).toBe("candidate bytes");
    expect(main.acquireWriteLease).not.toHaveBeenCalled();
    expect(main.durableReplaceFile).not.toHaveBeenCalled();
  });

  it.each(["save", "flush"] as const)("rejects candidate restore through %s without recreating a file", async (operation) => {
    const { main, owner, flush } = fixture(false);
    const path = join(root, "gone.txt");
    const result = operation === "save" ? await main.saveEditorFile(path, "restored", owner, true) : await flush(path, "restored", true);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(main.durableReplaceFile).not.toHaveBeenCalled();
  });

  it("rejects candidate flush-save even when the renderer supplies the genuine holder", async () => {
    const { main, flush } = fixture(false);
    const path = join(root, "file.txt");
    await writeFile(path, "candidate bytes");
    expect(await flush(path, "renderer bytes")).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    expect(await readFile(path, "utf8")).toBe("candidate bytes");
    expect(main.joinWriteLease).not.toHaveBeenCalled();
    expect(main.durableReplaceFile).not.toHaveBeenCalled();
  });

  it("does not request candidate editor saves during preparation or consume recovered drafts", async () => {
    const { main, workspace } = fixture(false);
    expect(await main.flushDirtyModels("candidate:holder", workspace.id)).toEqual({ ok: true, failed: [] });
    expect(main.send).not.toHaveBeenCalled();
    expect(main.editorDrafts.get).not.toHaveBeenCalled();
    expect(main.flushWaiters.size).toBe(0);
    expect(main.durableReplaceFile).not.toHaveBeenCalled();
  });

  it("still requests primary editor saves and reports an unavailable renderer", async () => {
    const { main, workspace, owner } = fixture(true);
    expect(await main.flushDirtyModels("source:holder", workspace.id)).toEqual({ ok: false, failed: ["renderer is unavailable"] });
    expect(main.send).toHaveBeenCalledExactlyOnceWith("editor:flush-request", {
      requestId: expect.stringMatching(/^flush-/), writerId: "source:holder", projectId: owner.projectId, workspaceId: workspace.id,
    }, undefined);
    expect(main.flushWaiters.size).toBe(0);
  });

  it("keeps ordinary and genuine-holder flush saves working for the primary workspace", async () => {
    const { main, owner, flush } = fixture(true);
    const path = join(root, "file.txt");
    await writeFile(path, "original");
    expect(await main.saveEditorFile(path, "saved", owner)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("saved");
    expect(await flush(path, "flushed")).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("flushed");
    expect(main.acquireWriteLease).toHaveBeenCalledOnce();
    expect(main.joinWriteLease).toHaveBeenCalledOnce();
    expect(main.releaseWriteLease).toHaveBeenCalledTimes(2);
  });
});
