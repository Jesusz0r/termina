import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const guide = readFileSync(new URL("../../../docs/reference/USER-GUIDE.md", import.meta.url), "utf8");

/** Body of a function or callback starting at a signature, braces balanced. */
function blockBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf("{", start);
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

describe("review accept marks", () => {
  it("records Accept as a reviewed-at timestamp, not a permanent mark", () => {
    expect(renderer).toContain("accepted: Map<string, number>;");
    expect(renderer).toContain("pane.accepted.set(path, Date.now())");
    expect(renderer).toContain("pane.accepted.set(f.path, reviewedAt)");
    expect(renderer).not.toContain("pane.accepted.add(");
  });

  it("drops the ✓ when the file changes again on disk", () => {
    const changed = blockBody(renderer, "window.termina.onFileChanged((p) => {");
    const deleted = blockBody(renderer, "window.termina.onFileDeleted((p) => {");
    expect(changed).toContain("dropStaleAcceptMarks(p.path)");
    expect(deleted).toContain("dropStaleAcceptMarks(p.path)");
    const drop = blockBody(renderer, "function dropStaleAcceptMarks(");
    expect(drop).toContain("pane.accepted.delete(path)");
    expect(drop).toContain("renderModified(pane)");
  });

  it("prunes review marks to the live list when main replaces it", () => {
    const list = blockBody(renderer, "window.termina.onModifiedList((p) => {");
    expect(list).toContain("pruneReviewMarks(pane)");
    const prune = blockBody(renderer, "function pruneReviewMarks(");
    expect(prune).toContain("pane.accepted.delete(path)");
    expect(prune).toContain("pane.reverted.delete(path)");
  });

  it("documents Clear as forgetting review state, not cleaning the disk", () => {
    expect(guide).toContain("forget review state");
    expect(guide).toContain("files stay");
    expect(guide).not.toContain("reset the list display");
  });
});
