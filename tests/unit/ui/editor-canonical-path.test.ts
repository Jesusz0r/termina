import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const editor = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");

/** Body of a class method, including nested blocks. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf("{", start + signature.length);
  expect(brace, `unopened ${signature}`).toBeGreaterThan(start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(brace, i + 1);
    }
  }
  throw new Error(`unclosed ${signature}`);
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
    expect(loaded.indexOf("canonicalizePath(res.path)")).toBeLessThan(loaded.indexOf("this.makeTab("));
    expect(loaded).toContain("acquireSharedFileModel(key, owner)");
    expect(loaded).toContain("window.termina.openFile(path, owner)");
  });

  it("keys the new tab by main's real path before the text model is filled", () => {
    const loaded = methodBody(editor, "private async openFileNow(");
    const resolved = loaded.indexOf("canonicalizePath(res.path)");
    const filled = loaded.indexOf("model.setValue(res.content)");
    expect(resolved).toBeGreaterThanOrEqual(0);
    expect(filled).toBeGreaterThan(resolved);
    expect(loaded).toContain("if (this.tabs.has(resolvedPath))");
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
