import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the actual main-owned cleanup method without launching Electron.
// A source capture can finish after its terminal ID has been reused.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let method = "";
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === "releaseVerifyAdmission") method = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!method) throw new Error("main Verify admission owner is missing");
const compiled = ts.transpile(`class Harness { verifyRuns = new Map(); ${method} }\nreturn new Harness();`, { target: ts.ScriptTarget.ES2022 });
function harness(): { verifyRuns: Map<string, object>; releaseVerifyAdmission(id: string, owner: object): void } {
  return new Function(compiled)();
}

describe("Verify admission incarnation fence", () => {
  it("does not let late cleanup clear a replacement terminal's reservation", () => {
    const main = harness();
    const oldOwner = { id: "term-1" };
    const newOwner = { id: "term-1" };
    main.verifyRuns.set("term-1", newOwner);
    main.releaseVerifyAdmission("term-1", oldOwner);
    expect(main.verifyRuns.get("term-1")).toBe(newOwner);
    main.releaseVerifyAdmission("term-1", newOwner);
    expect(main.verifyRuns.has("term-1")).toBe(false);
  });

  it("releases its own reservation even when runtime teardown already removed the terminal", () => {
    const main = harness();
    const owner = { id: "term-1" };
    main.verifyRuns.set("term-1", owner);
    main.releaseVerifyAdmission("term-1", owner);
    expect(main.verifyRuns.size).toBe(0);
    main.releaseVerifyAdmission("term-1", owner);
    expect(main.verifyRuns.size).toBe(0);
  });
});
