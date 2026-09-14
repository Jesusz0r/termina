import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const review = readFileSync(new URL("../../../src/review.ts", import.meta.url), "utf8");

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

describe("review identity staging (refs #207)", () => {
  const show = () => methodBody(review, "async show(terminalId: string, path: string, relPath: string, owner: ProjectWorkspaceRef): Promise<void>");

  it("stages terminal, path, owner, name, and baseline only after both loads succeed", () => {
    const body = show();
    const baselineLoad = body.indexOf("res = await window.termina.reviewBaseline(terminalId, path)");
    const fileLoad = body.indexOf("current = await window.termina.openFile(path, owner)");
    const failureReturn = body.indexOf("if (!current.ok && !deleted)");
    expect(baselineLoad).toBeGreaterThanOrEqual(0);
    expect(fileLoad).toBeGreaterThan(baselineLoad);
    expect(failureReturn).toBeGreaterThan(fileLoad);
    for (const staged of [
      "this.terminalId = terminalId",
      "this.path = path",
      "this.owner = owner",
      "this.nameEl.textContent = relPath",
      "this.baseline = res.baseline",
    ]) {
      expect(body.indexOf(staged), staged).toBeGreaterThan(failureReturn);
    }
  });

  it("restores nothing on the failure paths because nothing was staged", () => {
    const body = show();
    const failureReturn = body.indexOf("if (!current.ok && !deleted)");
    const beforeFailure = body.slice(0, failureReturn);
    for (const staged of ["this.terminalId =", "this.path =", "this.owner =", "this.nameEl.textContent =", "this.baseline ="]) {
      expect(beforeFailure, staged).not.toContain(staged);
    }
    expect(body).toContain('toast(`could not load ${relPath}: ${current.error}`, "error")');
  });

  it("keeps the loadSeq guard over interleaved shows", () => {
    const body = show();
    expect(body.match(/if \(seq !== this\.loadSeq\) return;/g)?.length).toBe(3);
  });

  it("stages preRevertContent and provides an undoable stickyToast on successful revert", () => {
    const revertBody = methodBody(review, "async revert(): Promise<void>");
    expect(revertBody).toContain("const preRevertContent = this.modifiedModel?.getValue()");
    expect(revertBody).toContain("await window.termina.reviewRevert(this.terminalId, targetPath)");
    expect(revertBody).toContain("stickyToast(");
    expect(revertBody).toContain('label: "Undo"');
    expect(revertBody).toContain("await window.termina.saveFile(targetPath, preRevertContent, targetOwner)");
  });
});
