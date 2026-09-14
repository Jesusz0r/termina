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
    expect(body).toContain("const key = canonicalizePath(path)");
    expect(body.indexOf("const key = canonicalizePath(path)")).toBeLessThan(body.indexOf("this.tabs.get(key)"));
    expect(body).toContain("acquireSharedFileModel(key, owner)");
    expect(body).toContain("window.termina.openFile(key, owner)");
  });

  it("has no alias table or learn-after-open path", () => {
    expect(editor).not.toContain("canonicalKeys");
    expect(editor).not.toContain("canonicalKeys.set");
    expect(openFile()).not.toContain("res.path !== key");
  });

  it("routes watcher and deletion pushes through canonicalizePath", () => {
    expect(methodBody(editor, "private resolveKey(path: string): string | null")).toContain("canonicalizePath(path)");
    for (const signature of [
      "updateContent(path: string, content: string, changedLines?: number[]): void",
      "closeIfOpen(path: string): void",
    ]) {
      expect(methodBody(editor, signature)).toContain("resolveKey(");
    }
  });
});
