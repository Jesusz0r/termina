import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectCiScope } from "../../../scripts/ci-scope.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CI coverage selection", () => {
  it("keeps documentation and website changes in the content suite", () => {
    expect(selectCiScope(["docs/reference/USER-GUIDE.md", "website/app.ts", "README.md"])).toBe("content");
  });

  it.each(["shared/guards.ts", "core/src/main.rs", "src/styles.css", "electron/main.ts", "agent-core/main.ts",
    "scripts/ci-scope.ts", "package.json", "pnpm-lock.yaml", ".github/workflows/lint.yml", "tests/unit/docs/new.test.ts",
    "docs/example.ts", ".agents/skills/review/SKILL.md", "unknown.md"])("runs the full suite for %s", (path) => {
    expect(selectCiScope(["website/index.html", path])).toBe("full");
  });

  it("requires a proven, nonempty content-only diff", () => {
    expect(selectCiScope([])).toBe("full");
    expect(selectCiScope(["docs/../electron/main.ts"])).toBe("full");
  });

  it("checks both sides of renames and writes a safe GitHub output", () => {
    const root = mkdtempSync(join(tmpdir(), "termina-ci-scope-"));
    roots.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.name", "termina");
    git("config", "user.email", "dev@termina.local");
    writeFileSync(join(root, "runtime.ts"), "export const value = 1;\n");
    git("add", ".");
    git("commit", "-qm", "initial");
    const base = git("rev-parse", "HEAD").trim();
    git("mv", "runtime.ts", "README.md");
    git("commit", "-qm", "rename into content");
    const event = join(root, "event.json");
    const output = join(root, "output");
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base } } }));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", resolve("scripts/ci-scope.ts")], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("scope=full\n");
  });

  it("uses full coverage when the base cannot be established", () => {
    const root = mkdtempSync(join(tmpdir(), "termina-ci-scope-"));
    roots.push(root);
    const event = join(root, "event.json");
    const output = join(root, "output");
    writeFileSync(event, JSON.stringify({ before: "0".repeat(40) }));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", resolve("scripts/ci-scope.ts")], {
      encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("scope=full\n");
  });
});
