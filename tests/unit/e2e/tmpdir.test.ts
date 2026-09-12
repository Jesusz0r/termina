import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { e2eTempDir, pathIsInside } from "../../e2e/tmpdir.ts";

describe("e2e temp isolation", () => {
  it("treats the repo and its children as inside", () => {
    const repo = "/Users/dev/proyectos/pi-editor";
    expect(pathIsInside(repo, repo)).toBe(true);
    expect(pathIsInside(repo, join(repo, ".e2e-tmp"))).toBe(true);
    expect(pathIsInside(repo, join(repo, ".e2e-tmp", "termina-playwright-x"))).toBe(true);
  });

  it("treats sibling and system temp paths as outside", () => {
    const repo = "/Users/dev/proyectos/pi-editor";
    expect(pathIsInside(repo, "/tmp")).toBe(false);
    expect(pathIsInside(repo, "/Users/dev/proyectos")).toBe(false);
    expect(pathIsInside(repo, "/Users/dev/proyectos/other")).toBe(false);
  });

  it("refuses a TMPDIR that lives in the repo", () => {
    const repo = resolve(".");
    const isolated = e2eTempDir(repo, [join(repo, ".e2e-tmp"), "/tmp"]);
    expect(isolated).toBe(resolve("/tmp"));
    expect(pathIsInside(repo, e2eTempDir(repo))).toBe(false);
  });
});
