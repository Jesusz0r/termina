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
    expect(body).toContain("acquireSharedFileModel(key, owner)");
    // Original path: main realpaths it; a rewritten /private/tmp key is not required.
    expect(body).toContain("window.termina.openFile(path, owner)");
  });

  it("retargets to res.path above the version check so a lost-race tab still hears watcher pushes (refs #209)", () => {
    const body = openFile();
    const retarget = body.indexOf("this.retargetTab(");
    const versionCheck = body.indexOf("model.getAlternativeVersionId() === initialVersionId");
    expect(retarget).toBeGreaterThanOrEqual(0);
    expect(versionCheck).toBeGreaterThanOrEqual(0);
    expect(retarget).toBeLessThan(versionCheck);
    expect(body).toContain("typeof res.path === \"string\" && res.path");
    expect(body).toContain("canonicalizePath(res.path)");
    expect(body).toContain("if (resolved !== key) key = this.retargetTab(key, resolved)");
    expect(body).toContain("lost a race with a user edit");
  });

  it("has no alias table", () => {
    expect(editor).not.toContain("canonicalKeys");
    expect(methodBody(editor, "private retargetTab(from: string, to: string): string")).toContain("this.tabs.set(to, tab)");
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
