import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let method: ts.MethodDeclaration | undefined;
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === "overlapInWorkspace") method = node;
  ts.forEachChild(node, visit);
}
visit(source);
if (!method) throw new Error("Missing canonical workspace overlap check");
const compiled = ts.transpile(`class TerminaApp { ${method.getText(source)} } return new TerminaApp();`, { target: ts.ScriptTarget.ES2022 });

function fixture() {
  return Object.assign(new Function(compiled)(), {
    verifyRuns: new Map(), dispatchRuns: new Map(),
    runtime: new Map([["term-owner", { id: "term-owner", workspaceId: "ws-1" }]]),
  });
}

describe("recorded run overlap", () => {
  it("does not treat a dispatch worker's own ledger entry as another writer", () => {
    const main = fixture();
    main.dispatchRuns.set("term-worker", { ownerId: "term-owner" });
    expect(main.overlapInWorkspace("ws-1", "term-worker")).toBe(false);
  });
  it("still detects another dispatched worker on the same workspace", () => {
    const main = fixture();
    main.dispatchRuns.set("term-other", { ownerId: "term-owner" });
    expect(main.overlapInWorkspace("ws-1", "term-worker")).toBe(true);
    expect(main.overlapInWorkspace("ws-2", "term-worker")).toBe(false);
  });
  it("preserves every active Verify overlap, even when the same terminal owns its separate command", () => {
    const main = fixture();
    main.verifyRuns.set("term-worker", { id: "term-worker", workspaceId: "ws-1" });
    expect(main.overlapInWorkspace("ws-1", "term-worker")).toBe(true);
    expect(main.overlapInWorkspace("ws-2", "term-worker")).toBe(false);
  });
});
