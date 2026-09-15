import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const projectState = readFileSync(new URL("../../../src/worldline-project-state.ts", import.meta.url), "utf8");

describe("renderer test-command cache (issue #359)", () => {
  it("does not keep a module-global test command cache", () => {
    expect(renderer).not.toMatch(/^let testCommand:/m);
    expect(renderer).not.toContain("let testCommandRequestToken");
    expect(renderer).not.toContain("pane.testCommand ?? testCommand");
  });

  it("resolves verify from the pane field plus project detect", () => {
    expect(renderer).toContain("resolvePaneTestCommand(pane, projectTestCommandFromPanes(pane.projectId, panes.values()))");
    expect(renderer).toContain("applyProjectTestDetect(");
    expect(renderer).toContain("projectTestDetectPane(");
    expect(projectState).toContain("export function resolvePaneTestCommand");
    expect(projectState).toContain("return pane.testCommand ?? projectCommand");
  });

  it("points e2e seams at the pane cache, not a module global", () => {
    expect(renderer).toContain("(window as unknown as Record<string, unknown>).__refreshTestCommand = refreshTestCommand");
    expect(renderer).toContain("(window as unknown as Record<string, unknown>).__getTestCommand = () => {");
    expect(renderer).toContain("return resolvePaneTestCommand(pane, projectTestCommandFromPanes(pane.projectId, panes.values()))");
    expect(renderer).not.toContain("__getTestCommand = () => testCommand");
  });
});
