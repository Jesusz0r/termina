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

describe("editor canonical alias on slow initial read (refs #209)", () => {
  const openFile = () =>
    methodBody(
      editor,
      "async openFile(path: string, opts: { preview?: boolean; owner?: ProjectWorkspaceRef; line?: number; column?: number } = {}): Promise<void>",
    );

  it("learns the alias above the version check, so the lost-race branch learns it too", () => {
    const body = openFile();
    const learn = body.indexOf("this.canonicalKeys.set(res.path, key)");
    const versionCheck = body.indexOf("model.getAlternativeVersionId() === initialVersionId");
    expect(learn).toBeGreaterThanOrEqual(0);
    expect(versionCheck).toBeGreaterThanOrEqual(0);
    expect(learn).toBeLessThan(versionCheck);
    // The conflict branch itself is intact: the race still surfaces, minus the deaf tab.
    expect(body).toContain("lost a race with a user edit");
  });

  it("learns only while the tab still owns the model", () => {
    const body = openFile();
    expect(body).toContain("if (current?.model === model && res.path !== key) this.canonicalKeys.set(res.path, key)");
  });

  it("keeps openFile as the single learning site with resolveKey routing", () => {
    expect(editor.match(/canonicalKeys\.set\(/g)?.length).toBe(1);
    expect(methodBody(editor, "private resolveKey(path: string): string | null")).toContain("canonicalKeys.get(path)");
    for (const signature of [
      "updateContent(path: string, content: string, changedLines?: number[]): void",
      "closeIfOpen(path: string): void",
    ]) {
      expect(methodBody(editor, signature)).toContain("resolveKey(");
    }
  });
});
