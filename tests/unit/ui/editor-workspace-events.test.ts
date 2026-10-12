import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { evictOldest } from "../../../shared/evict-oldest.ts";
import type { ProjectWorkspaceRef } from "../../../shared/types.ts";

const editorSource = ts.createSourceFile("editor.ts", readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const rendererSource = ts.createSourceFile("main.ts", readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let hasFileMethod = "";
function findEditorMethod(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(editorSource) === "hasFile") hasFileMethod = node.getText(editorSource);
  ts.forEachChild(node, findEditorMethod);
}
findEditorMethod(editorSource);
if (!hasFileMethod) throw new Error("production EditorManager.hasFile method is missing");
const callbacks = new Map<string, string>();
function findCallbacks(node: ts.Node): void {
  if (ts.isCallExpression(node) && ["window.termina.onFileChanged", "window.termina.onFileDeleted"].includes(node.expression.getText(rendererSource))) {
    callbacks.set(node.expression.getText(rendererSource), node.arguments[0]!.getText(rendererSource));
  }
  ts.forEachChild(node, findCallbacks);
}
findCallbacks(rendererSource);
if (callbacks.size !== 2) throw new Error("production file event callbacks are missing");

const sourceOwner: ProjectWorkspaceRef = { projectId: "project", workspaceId: "primary" };
const candidateOwner: ProjectWorkspaceRef = { projectId: "project", workspaceId: "candidate" };
const sourcePath = "/source/hello.txt";
const candidatePath = "/worlds/cmp-1/A/hello.txt";
interface FileEvent { projectId: string; workspaceId: string; path: string; content?: string }
interface EditorHarness {
  tabs: Map<string, { owner: ProjectWorkspaceRef | null }>;
  hasFile(path: string, owner?: ProjectWorkspaceRef): boolean;
  updateContent: ReturnType<typeof vi.fn>;
  closeIfOpen: ReturnType<typeof vi.fn>;
}
function fixture() {
  const compiled = ts.transpile(`class Editor { ${hasFileMethod} } return new Editor();`, { target: ts.ScriptTarget.ES2022 });
  const editor = new Function(compiled)() as EditorHarness;
  editor.tabs = new Map([[sourcePath, { owner: sourceOwner }], [candidatePath, { owner: candidateOwner }]]);
  Object.assign(editor, { resolveKey: (path: string) => editor.tabs.has(path) ? path : null, updateContent: vi.fn(), closeIfOpen: vi.fn() });
  const explorer = { handleDiskChange: vi.fn() };
  const fetchLargeChange = vi.fn();
  const context = {
    projectViews: new Map([["project", { editorMgr: editor, workspace: { id: "candidate", root: "/worlds/cmp-1/A" } }]]),
    activeProjectId: "project", lastChangePush: new Map(), largeChangeEpoch: new Map(), MAX_LAST_CHANGE_PUSH: 500,
    changeKey: (owner: ProjectWorkspaceRef, path: string) => `${owner.projectId}\u0000${owner.workspaceId}\u0000${path}`,
    evictOldest, activityPane: { dropStaleAcceptMarks: vi.fn() }, previewKind: () => null,
    fetchLargeChange, explorer, reviewView: null,
  };
  const load = (name: string) => new Function(...Object.keys(context), ts.transpile(`return ${callbacks.get(name)!};`, { target: ts.ScriptTarget.ES2022 }))(...Object.values(context)) as (event: FileEvent) => void;
  return { editor, explorer, fetchLargeChange, change: load("window.termina.onFileChanged"), deleted: load("window.termina.onFileDeleted") };
}

describe("cached editor models keep explicit workspace ownership", () => {
  it("checks both project and workspace ownership, including unowned and closed tabs", () => {
    const { editor } = fixture();
    expect(editor.hasFile(sourcePath)).toBe(true);
    expect(editor.hasFile(sourcePath, sourceOwner)).toBe(true);
    expect(editor.hasFile(candidatePath, candidateOwner)).toBe(true);
    expect(editor.hasFile(sourcePath, candidateOwner)).toBe(false);
    expect(editor.hasFile(candidatePath, sourceOwner)).toBe(false);
    expect(editor.hasFile(sourcePath, { projectId: "other", workspaceId: "primary" })).toBe(false);
    editor.tabs.set(sourcePath, { owner: null });
    expect(editor.hasFile(sourcePath, sourceOwner)).toBe(false);
    editor.tabs.delete(sourcePath);
    expect(editor.hasFile(sourcePath)).toBe(false);
  });

  it("continues updating cached source models while only refreshing the displayed candidate explorer", () => {
    const { editor, explorer, change } = fixture();
    change({ ...sourceOwner, path: sourcePath, content: "source update" });
    expect(editor.updateContent).toHaveBeenCalledWith(sourcePath, "source update", undefined);
    expect(explorer.handleDiskChange).not.toHaveBeenCalled();
    change({ ...candidateOwner, path: candidatePath, content: "candidate update" });
    expect(editor.updateContent).toHaveBeenCalledWith(candidatePath, "candidate update", undefined);
    expect(explorer.handleDiskChange).toHaveBeenCalledExactlyOnceWith(candidatePath);
  });

  it("routes source deletions to their cached model without changing candidate explorer rows", () => {
    const { editor, explorer, deleted } = fixture();
    deleted({ ...sourceOwner, path: sourcePath });
    expect(editor.closeIfOpen).toHaveBeenCalledExactlyOnceWith(sourcePath);
    expect(explorer.handleDiskChange).not.toHaveBeenCalled();
    deleted({ ...candidateOwner, path: candidatePath });
    expect(editor.closeIfOpen).toHaveBeenCalledWith(candidatePath);
    expect(explorer.handleDiskChange).toHaveBeenCalledExactlyOnceWith(candidatePath);
  });

  it("never applies candidate bytes or deletion to a source-owned model at the same supplied path", () => {
    const { editor, change, deleted } = fixture();
    change({ ...candidateOwner, path: sourcePath, content: "wrong owner" });
    deleted({ ...candidateOwner, path: sourcePath });
    expect(editor.updateContent).not.toHaveBeenCalled();
    expect(editor.closeIfOpen).not.toHaveBeenCalled();
  });

  it("retains the explicit source owner for an asynchronous content refresh", () => {
    const { editor, explorer, fetchLargeChange, change } = fixture();
    change({ ...sourceOwner, path: sourcePath });
    expect(fetchLargeChange).toHaveBeenCalledExactlyOnceWith(sourcePath, sourceOwner, editor);
    expect(explorer.handleDiskChange).not.toHaveBeenCalled();
  });
});
