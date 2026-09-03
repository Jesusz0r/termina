import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Release Workflow & CI Publication Invariants", () => {
  it("enforces single all-platform publication transaction after the test gate", () => {
    const workflowPath = resolve(".github/workflows/release.yml");
    const packageJsonPath = resolve("package.json");

    const workflow = readFileSync(workflowPath, "utf8");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const packageScripts = packageJson.scripts ?? {};

    function jobBlock(name: string): string {
      const startMatch = new RegExp(`^  ${name}:\\s*$`, "m").exec(workflow);
      expect(startMatch, `release workflow needs a ${name} job`).toBeTruthy();
      const start = startMatch!.index;
      const rest = workflow.slice(start + startMatch![0].length);
      const nextJob = /^  [a-zA-Z0-9_-]+:\s*$/m.exec(rest);
      return workflow.slice(start, nextJob ? start + startMatch![0].length + nextJob.index : undefined);
    }

    function countCommand(script: string, command: string): number {
      return (String(script ?? "").match(new RegExp(`(?:^|&&|\\s)${command.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?=\\s|$)`, "g")) ?? []).length;
    }

    const testJob = jobBlock("test");
    const buildJob = jobBlock("build");
    const publishJob = jobBlock("publish");

    expect(workflow).toMatch(/^\s*workflow_dispatch:\s*$/m);
    expect(workflow).toMatch(/push:\s*\n\s+tags:\s*\["v\*"\]/);
    expect(workflow).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
    expect(testJob).toMatch(/permissions:\s*\n\s+contents:\s*read\b/);
    expect(buildJob).toMatch(/permissions:\s*\n\s+contents:\s*read\b/);
    expect(publishJob).toMatch(/permissions:\s*\n\s+contents:\s*write\b/);
    expect(testJob).not.toMatch(/contents:\s*write\b/);
    expect(buildJob).not.toMatch(/contents:\s*write\b/);
    expect(testJob).toMatch(/- run: pnpm run test:release\b/);
    expect(testJob).toMatch(/pnpm install --frozen-lockfile/);
    expect(buildJob).toMatch(/pnpm install --frozen-lockfile/);
    expect(buildJob).toMatch(/needs:\s*(?:test|\[\s*test\s*\])\b/);
    expect(buildJob).toMatch(/strategy:\s*\n\s+fail-fast:\s*false\s*\n\s+matrix:/);
    expect(buildJob).toMatch(/os:\s*macos-15\b/);
    expect(buildJob).toMatch(/os:\s*ubuntu-22\.04\b/);

    expect(buildJob).not.toMatch(/--publish\s+always\b/);
    expect(buildJob).not.toMatch(/\bgh\s+release\s+(?:create|upload|edit)\b/);
    expect(buildJob).not.toMatch(/draft=false/);
    expect(buildJob).not.toMatch(/uses:\s*[^\n]*(?:gh-?release|release-action|publish-release)/i);

    const builderCommands = [...buildJob.matchAll(/^\s*(?:pnpm\s+exec\s+)?electron-builder\b.*$/gm)].map((match) => match[0]);
    expect(builderCommands.length).toBeGreaterThanOrEqual(1);
    for (const command of builderCommands) {
      expect(command).toMatch(/--publish\s+never\b/);
    }
    expect(buildJob).not.toMatch(/\bsleep\b/);
    expect(buildJob).not.toMatch(/GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);

    expect(buildJob).toMatch(/-c\.mac\.notarize=true/);
    for (const secret of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
      expect(buildJob).toMatch(new RegExp(`\\b${secret}:`));
    }

    expect(buildJob).toMatch(/name:\s*termina-release-\$\{\{\s*matrix\.artifact\s*\}\}/);
    expect(buildJob).toMatch(/if-no-files-found:\s*error/);
    for (const pattern of ["release/*.dmg", "release/*.zip", "release/*.AppImage", "release/*.blockmap", "release/latest*.yml", "release/termina-core-*"]) {
      expect(buildJob).toContain(pattern);
    }
    expect(buildJob).toMatch(/cp\s+[^\n]*termina-core[^\n]*release\/\$\{\{\s*matrix\.core-asset\s*\}\}/);

    for (const match of workflow.matchAll(/^\s*- uses:\s*([^@\s]+)@([^\s]+)\s*$/gm)) {
      expect(match[2]).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(workflow).not.toMatch(/dtolnay\/rust-toolchain@stable\b/);
    expect(workflow).toMatch(/dtolnay\/rust-toolchain@[0-9a-f]{40}[\s\S]*?toolchain:\s*1\.97\.1/);
    expect(testJob).toMatch(/node-version:\s*22\.23\.2\b/);
    expect(buildJob).toMatch(/node-version:\s*22\.23\.2\b/);

    expect(publishJob).toMatch(/needs:\s*(?:build|\[\s*build\s*\])\b/);
    const publishHeader = publishJob.slice(0, publishJob.indexOf("steps:"));
    expect(publishHeader).not.toMatch(/if:\s*startsWith\(github\.ref/);
    for (const [name, destination] of [["termina-release-mac-arm64", "release-input/mac-arm64"], ["termina-release-linux-x64", "release-input/linux-x64"]]) {
      expect(publishJob).toMatch(new RegExp(`name:\\s*${name.replaceAll("-", "\\-")}\\s*\\n\\s+path:\\s*${destination.replaceAll("/", "\\/")}`));
    }

    const validationIndex = publishJob.indexOf("name: Validate complete release asset set");
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    const firstMutation = publishJob.search(/\bgh\s+release\s+(?:create|upload|edit)\b/);
    expect(firstMutation).toBeGreaterThan(validationIndex);
    for (const required of ["*.dmg", "*.zip", "latest-mac.yml", "*.AppImage", "latest-linux.yml", "*.blockmap", "termina-core-darwin-arm64", "termina-core-linux-x64"]) {
      expect(publishJob).toContain(required);
    }
    expect(publishJob).toMatch(/-size\s+\+0/);
    expect(publishJob).toMatch(/uniq\s+-d/);

    expect(publishJob).toMatch(/gh\s+release\s+create[^\n]*--draft\b[^\n]*--verify-tag\b/);
    expect(publishJob).toMatch(/isDraft/);
    expect((workflow.match(/\bgh\s+release\s+create\b/g) ?? []).length).toBe(1);
    expect((workflow.match(/\bgh\s+release\s+upload\b/g) ?? []).length).toBe(1);
    expect(publishJob).toMatch(/gh\s+release\s+upload[^\n]*release-assets\/\*/);

    const publicCommands = workflow.match(/\bgh\s+release\s+edit[^\n]*--draft=false\b/g) ?? [];
    expect(publicCommands.length).toBe(1);
    const publicStep = publishJob.indexOf("name: Make release public");
    expect(publicStep).toBeGreaterThanOrEqual(0);
    expect(publishJob.slice(publicStep + "name: Make release public".length)).not.toMatch(/\n\s{6}-\s/);

    const mutatingStepNames = ["Create or reuse draft release", "Upload complete release asset set", "Make release public"];
    for (const stepName of mutatingStepNames) {
      const stepStart = publishJob.indexOf(`name: ${stepName}`);
      expect(stepStart).toBeGreaterThanOrEqual(0);
      const nextStep = publishJob.indexOf("\n      - ", stepStart + 1);
      const step = publishJob.slice(stepStart, nextStep < 0 ? undefined : nextStep);
      expect(step).toMatch(/if:\s*github\.event_name\s*==\s*'push'\s*&&\s*startsWith\(github\.ref,\s*'refs\/tags\/'\)/);
      expect(step).toMatch(/GH_REPO:\s*\$\{\{\s*github\.repository\s*\}\}/);
    }

    expect(countCommand(packageScripts["test:release"], "pnpm run test")).toBe(1);
    expect(typeof packageScripts["test:release-macos"]).toBe("string");
    expect(countCommand(packageScripts["test:release-macos"], "pnpm run test:sandbox-security-live")).toBe(1);
    expect(countCommand(packageScripts["test:release-macos"], "pnpm run test:e2e-release-smoke")).toBe(1);

    const macGateRun = buildJob.indexOf("run: pnpm run test:release-macos");
    const packageStep = buildJob.indexOf("name: Package");
    expect(macGateRun).toBeGreaterThanOrEqual(0);
    expect(packageStep).toBeGreaterThanOrEqual(0);
    expect(macGateRun).toBeLessThan(packageStep);
    const macGateStep = buildJob.slice(buildJob.lastIndexOf("\n      -", macGateRun), packageStep);
    expect(macGateStep).toMatch(/if:\s*matrix\.os\s*==\s*['"]macos-15['"]/);
  });
});
