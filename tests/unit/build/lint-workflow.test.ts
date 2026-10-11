import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/lint.yml", "utf8");

describe("PR validation coverage", () => {
  it("validates PRs and main pushes without duplicate branch or tag runs", () => {
    expect(workflow).toMatch(/push:\s*\n\s+branches:\s*\[main\]/);
    expect(workflow).toMatch(/^  pull_request:\s*$/m);
    expect(workflow).not.toMatch(/paths(?:-ignore)?:|tags:/);
    expect(workflow).toContain("github.workflow");
    expect(workflow).toContain("github.event.pull_request.number || github.ref");
    expect(workflow).toMatch(/cancel-in-progress:\s*true/);
  });

  it("keeps checks explicit when the quick prerequisite fails", () => {
    const checks = workflow.slice(workflow.indexOf("  checks:"));
    expect(checks).toMatch(/needs:\s*no-git-cli/);
    expect(checks).toContain("!cancelled()");
    expect(checks).toContain("needs.no-git-cli.result");
    expect(checks).toContain('test "$PREREQUISITE" = success');
    expect(checks.indexOf('test "$PREREQUISITE" = success')).toBeLessThan(checks.indexOf("actions/setup-node"));
  });

  it("typechecks every scope and compiles before the full unit suite", () => {
    expect(workflow).toContain("run: pnpm run typecheck\n");
    expect(workflow).toContain("run: pnpm run typecheck:tests\n");
    expect(workflow).toContain("pnpm run test:content");
    expect(workflow).toContain("pnpm run test:unit");
    expect(workflow.indexOf("scripts/build.ts")).toBeLessThan(workflow.lastIndexOf("pnpm run test:unit"));
    expect(workflow).not.toContain("TERMINA_SKIP_CORE_BUILD");
  });
});
