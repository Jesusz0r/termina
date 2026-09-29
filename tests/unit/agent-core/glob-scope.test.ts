import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globFiles, GREP_VISIT_CAP } from "../../../agent-core/main/files.ts";
import { grepFiles } from "../../../agent-core/main/grep.ts";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "glob-scope-"));
  roots.push(root);
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib/target.ts"), "export {};");
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it("resolves literal paths and narrow subtrees without spending the budget on unrelated files", async () => {
  const root = fixture();
  mkdirSync(join(root, "unrelated"));
  for (let i = 0; i <= GREP_VISIT_CAP; i++) writeFileSync(join(root, `unrelated/${i}.txt`), "noise");
  for (const pattern of ["lib/target.ts", "lib/*.ts", "lib/**/*.ts"]) {
    const result = await globFiles(root, pattern);
    expect(result).toMatchObject({ content: "lib/target.ts", state: "complete", isError: false, truncated: false });
  }
  expect(await globFiles(root, "lib/missing.ts")).toMatchObject({ content: "(no matches)", isError: false });
  expect(await globFiles(root, "missing/*.ts")).toMatchObject({ content: "(no matches)", isError: false });
});

it("does not treat a visit cap that already returned hits as an error", async () => {
  const root = fixture();
  for (let i = 0; i <= GREP_VISIT_CAP; i++) writeFileSync(join(root, `hit-${i}.txt`), "x");
  const result = await globFiles(root, "*.txt");
  expect(result.state).toBe("visit-cap");
  expect(result.isError).toBe(false);
  expect(result.content).toContain("hit-");
  expect(result.content).toContain("Glob again");
});

it("does not treat a capped grep that already returned hits as an error", async () => {
  const root = fixture();
  for (let i = 0; i <= GREP_VISIT_CAP; i++) writeFileSync(join(root, `g-${i}.txt`), "needle\n");
  const result = await grepFiles(root, { pattern: "needle" }, { jsOnly: true, budgetMs: 30_000 });
  expect(result.state).toBe("visit-cap");
  expect(result.isError).toBe(false);
  expect(result.content).toContain("needle");
  expect(result.content).toContain("Grep again");
});

it("keeps a capped search with no hits as an error", async () => {
  const root = fixture();
  const result = await globFiles(root, "*.txt", { budgetMs: 0 });
  expect(result.state).toBe("timeout");
  expect(result.isError).toBe(true);
  expect(result.content).not.toContain("hit-");
});

it("honors cancellation and deadlines before missing or ignored prefix fast paths", async () => {
  const root = fixture();
  for (const pattern of ["missing/**", "node_modules/**", "lib/target.ts"]) {
    expect((await globFiles(root, pattern, { shouldStop: () => true })).state).toBe("interrupted");
    expect((await globFiles(root, pattern, { budgetMs: 0 })).state).toBe("timeout");
    expect((await globFiles(root, pattern, { shouldStop: () => { throw new Error("stop callback"); } })).state).toBe("failed");
  }
});

it("keeps ancestor ignore rules and confinement when narrowing traversal", async () => {
  const root = fixture();
  writeFileSync(join(root, ".gitignore"), "lib/\n");
  expect((await globFiles(root, "lib/*.ts")).content).toBe("(no matches)");
  expect((await globFiles(root, "lib/target.ts")).content).toBe("(no matches)");
  writeFileSync(join(root, ".gitignore"), "target.ts/\n");
  expect((await globFiles(root, "lib/target.ts")).content).toBe("lib/target.ts");
  const outside = fixture();
  symlinkSync(join(outside, "lib"), join(root, "escape"));
  expect((await globFiles(root, "escape/*.ts")).isError).toBe(true);
  expect((await globFiles(root, "../*.ts")).isError).toBe(true);
});
