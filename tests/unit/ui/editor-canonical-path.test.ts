import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

const editor = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");

/** Body of a class method, including nested blocks. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0);
  const parsed = ts.createSourceFile("editor.ts", source, ts.ScriptTarget.ESNext, true);
  let body: ts.Block | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.getStart(parsed) === start) body = node.body;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!body) throw new Error(`unopened ${signature}`);
  return body.getText(parsed);
}

describe("editor keys tabs by canonicalizePath (refs #273)", () => {
  const openFile = () =>
    methodBody(
      editor,
      "async openFile(path: string, opts: { preview?: boolean; owner?: ProjectWorkspaceRef; line?: number; column?: number } = {}): Promise<void>",
    );

  it("canonicalizes the opened path before the tab exists, not after the read", () => {
    const body = openFile();
    expect(body).toContain("let key = canonicalizePath(path)");
    expect(body.indexOf("let key = canonicalizePath(path)")).toBeLessThan(body.indexOf("this.tabs.get(key)"));
    const loaded = methodBody(editor, "private async openFileNow(");
    expect(loaded.indexOf("canonicalizePath(res.path)")).toBeLessThan(loaded.indexOf("this.createFileTab("));
    expect(loaded).toContain('window.termina.openFile(path, owner, "editor")');
    expect(loaded).not.toContain("claimEditorDraft");
    const created = methodBody(editor, "private async createFileTab(");
    expect(created).toContain("acquireSharedFileModel(key, owner)");
    expect(created).toContain("window.termina.claimEditorDraft(");
    expect(created.indexOf("claimEditorDraft")).toBeLessThan(created.indexOf("acquireSharedFileModel(key, owner)"));
  });

  it("keys the new tab by main's real path before the text model is filled", () => {
    const loaded = methodBody(editor, "private async openFileNow(");
    const resolved = loaded.indexOf("canonicalizePath(res.path)");
    expect(resolved).toBeGreaterThanOrEqual(0);
    expect(loaded.indexOf("this.createFileTab(")).toBeGreaterThan(resolved);
    expect(loaded).toContain("if (this.tabs.has(key))");
    expect(loaded.indexOf("this.tabs.has(key)")).toBeLessThan(loaded.indexOf("this.createFileTab("));
    expect(loaded.indexOf("this.creating.get(key)")).toBeLessThan(loaded.indexOf("this.createFileTab("));
    const created = methodBody(editor, "private async createFileTab(");
    expect(created.indexOf("model.setValue(res.content)")).toBeGreaterThan(created.indexOf("acquireSharedFileModel(key, owner)"));
  });

  it("returns the real close completion so a subsequent reopen cannot race it", async () => {
    const close = new Function(`return function() ${methodBody(editor, "closeAllTabs(): Promise<boolean>")};`)() as
      (this: { order: string[]; requestCloseKeys(keys: string[]): Promise<boolean> }) => Promise<boolean>;
    let finish!: (accepted: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    let requested: string[] = [];
    const manager = { order: ["greeting.ts"], requestCloseKeys: (keys: string[]) => { requested = keys; return pending; } };
    const completion = close.call(manager);
    expect(completion).toBe(pending);
    expect(requested).toEqual(["greeting.ts"]);
    expect(requested).not.toBe(manager.order);
    finish(true);
    await expect(completion).resolves.toBe(true);
  });

  it("has no alias table", () => {
    expect(editor).not.toContain("canonicalKeys");
    expect(methodBody(editor, "private resolveKey(path: string): string | null")).toContain("canonicalizePath(path)");
  });

  it("routes watcher and deletion pushes through canonicalizePath", () => {
    expect(methodBody(editor, "private resolveKey(path: string): string | null")).toContain("canonicalizePath(path)");
    expect(methodBody(editor, "private resolveKey(path: string): string | null")).toContain("this.tabs.has(key)");
    for (const signature of [
      "updateContent(path: string, content: string, changedLines?: number[]): void",
      "closeIfOpen(path: string): void",
    ]) {
      expect(methodBody(editor, signature)).toContain("resolveKey(");
    }
  });
});
