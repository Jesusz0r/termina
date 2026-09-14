import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const refresh = readFileSync(new URL("../../../src/components/explorer-refresh.ts", import.meta.url), "utf8");
const explorer = readFileSync(new URL("../../../src/components/explorer.ts", import.meta.url), "utf8");
const keyboard = readFileSync(new URL("../../../src/components/explorer-keyboard.ts", import.meta.url), "utf8");

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

describe("explorer refresh keys by canonicalizePath (refs #273)", () => {
  it("imports the shared owner and keys the root and dir maps by it", () => {
    expect(refresh).toContain('from "../../shared/canonical-path"');
    expect(methodBody(refresh, "private projectRoot(): string | null")).toContain("canonicalizePath(cwd)");
    expect(methodBody(refresh, "async renderRoot(forceReload = false): Promise<void>")).toContain("this.projectRoot()");
    expect(methodBody(refresh, "dirState(absPath: string): DirState")).toContain("canonicalizePath(absPath)");
    expect(methodBody(refresh, "handleDiskChange(path?: string): void")).toContain("canonicalizePath(path)");
  });

  it("prunes collapsed descendants by prefix, not a DOM walk", () => {
    const forget = methodBody(refresh, "forgetMountedDescendants(children: HTMLElement): void");
    expect(forget).toContain("this.pruneCollapsedDescendants(parent)");
    expect(forget).not.toContain("querySelectorAll");
    expect(refresh).not.toContain("/var vs");
    expect(refresh).not.toContain("/private/var");
    expect(methodBody(refresh, "pruneCollapsedDescendants(absPath: string): void")).toContain("canonicalizePath(absPath)");
  });

  it("keys explorer dirViews by canonicalizePath at set/get", () => {
    expect(explorer).toContain('from "../../shared/canonical-path"');
    expect(explorer).toContain("this.dirViews.set(canonicalizePath(entry.path)");
    expect(explorer).toContain("this.dirViews.get(canonicalizePath(absPath))");
    expect(explorer).toContain("this.dirViews.get(canonicalizePath(child.path))");
    expect(explorer).not.toContain("this.dirViews.set(entry.path");
    expect(keyboard).toContain("this.host.dirViews.get(canonicalizePath(entry.path))");
    expect(keyboard).not.toContain("this.host.dirViews.get(entry.path)");
  });
});
