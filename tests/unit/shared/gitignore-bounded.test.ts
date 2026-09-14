import { describe, it, expect } from "vitest";
import { matchGitignore, parseGitignore, type GitignoreRules } from "../../../shared/gitignore.ts";

const rulesOf = (source: string): GitignoreRules => new Map([["", parseGitignore(source)]]);
const matches = (source: string, path: string): boolean => matchGitignore(rulesOf(source), path);

describe("gitignore bounded matching (refs #140)", () => {
  it("finishes adversarial wildcards instead of backtracking forever", () => {
    const rules = rulesOf("*a*a*a*a*a*a*a*a*b");
    const name = "a".repeat(120);
    const started = Date.now();
    expect(matchGitignore(rules, name)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("finishes adversarial wildcards that do match", () => {
    const rules = rulesOf("*a*a*a*a*a*a*a*a*b");
    const name = `${"a".repeat(200)}b`;
    const started = Date.now();
    expect(matchGitignore(rules, name)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("handles long names under star patterns", () => {
    const rules = rulesOf("*.log");
    expect(matchGitignore(rules, `${"x".repeat(5000)}.log`)).toBe(true);
    expect(matchGitignore(rules, `dir/${"y".repeat(5000)}.log`)).toBe(true);
    expect(matchGitignore(rules, `dir/${"y".repeat(5000)}.txt`)).toBe(false);
  });

  it("handles repeated globstars without exponential blowup", () => {
    const rules = rulesOf("a/**/**/b/**/c");
    const started = Date.now();
    expect(matchGitignore(rules, "a/1/2/3/b/4/5/c")).toBe(true);
    expect(matchGitignore(rules, "a/1/2/3/b/4/5/d")).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("drops absurdly long lines instead of compiling them", () => {
    const rules = parseGitignore(`${"a".repeat(5000)}\nvalid-name\n`);
    expect(rules).toHaveLength(1);
    expect(matchGitignore(new Map([["", rules]]), "valid-name")).toBe(true);
  });

  it("keeps ? single-character semantics inside a segment", () => {
    expect(matches("???.txt", "abc.txt")).toBe(true);
    expect(matches("???.txt", "abcd.txt")).toBe(false);
    expect(matches("???.txt", "sub/abc.txt")).toBe(true);
  });
});

describe("gitignore infix globstar (refs #141)", () => {
  it("matches zero directories between literal segments", () => {
    expect(matches("src/**/generated.ts", "src/generated.ts")).toBe(true);
  });

  it("matches one directory between literal segments", () => {
    expect(matches("src/**/generated.ts", "src/a/generated.ts")).toBe(true);
  });

  it("matches multiple directories between literal segments", () => {
    expect(matches("src/**/generated.ts", "src/a/b/generated.ts")).toBe(true);
  });

  it("does not match a similarly prefixed non-directory name", () => {
    expect(matches("src/**/generated.ts", "srcgenerated.ts")).toBe(false);
    expect(matches("src/**/generated.ts", "src2/a/generated.ts")).toBe(false);
  });

  it("keeps leading, lone, and trailing globstar semantics", () => {
    expect(matches("**/logs", "a/logs/x.txt")).toBe(true);
    expect(matches("**/logs", "logs/x.txt")).toBe(true);
    expect(matches("**", "any/thing.txt")).toBe(true);
    expect(matches("cache/**", "cache/x.js")).toBe(true);
    expect(matches("cache/**", "cache")).toBe(false);
  });
});

describe("gitignore preserved semantics", () => {
  it("anchors patterns containing a slash", () => {
    expect(matches("a/b.txt", "a/b.txt")).toBe(true);
    expect(matches("a/b.txt", "x/a/b.txt")).toBe(false);
    expect(matches("/root-only.txt", "root-only.txt")).toBe(true);
    expect(matches("/root-only.txt", "sub/root-only.txt")).toBe(false);
  });

  it("matches slash-free patterns at any depth", () => {
    expect(matches("dist", "dist/x.js")).toBe(true);
    expect(matches("dist", "distribution.js")).toBe(false);
    expect(matches("*.log", "a/b/c.log")).toBe(true);
    expect(matches("*.log", "a/b/c.logx")).toBe(false);
  });

  it("applies directory-only, negation, and last-match-wins rules", () => {
    expect(matches("logs/", "logs/o.txt")).toBe(true);
    expect(matches("logs/", "logs")).toBe(false);
    expect(matches("*.tmp\n!important.tmp\n", "note.tmp")).toBe(true);
    expect(matches("*.tmp\n!important.tmp\n", "important.tmp")).toBe(false);
    expect(matches("keep*\n!keep-all\n", "keep-all")).toBe(false);
    expect(matches("keep*\n!keep-all\n", "keep-all/sub")).toBe(false);
    expect(matches("dist/\n!dist/keep.js\n", "dist/keep.js")).toBe(true);
  });

  it("lets deeper .gitignore files override shallower ones", () => {
    const nested: GitignoreRules = new Map([
      ["", parseGitignore("*.gen\n")],
      ["pkg", parseGitignore("!keep.gen\ngenerated/\n")],
    ]);
    expect(matchGitignore(nested, "other/x.gen")).toBe(true);
    expect(matchGitignore(nested, "pkg/keep.gen")).toBe(false);
    expect(matchGitignore(nested, "pkg/generated/g.ts")).toBe(true);
    expect(matchGitignore(nested, "generated/g.ts")).toBe(false);
  });
});
