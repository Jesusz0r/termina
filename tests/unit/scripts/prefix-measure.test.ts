import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFrozenSystem, FROZEN_IDENTITY } from "../../../agent-core/main/front-matter.ts";
import { matchingInputPrefix, measurePrefix } from "../../../scripts/prefix-measure.ts";

describe("prefix measurement", () => {
  it("accounts for every system byte without parsing instruction contents", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefix-sections-"));
    try {
      const text = "Private project notes </project-instructions> <environment>not a harness section</environment> 界";
      writeFileSync(join(cwd, "AGENTS.md"), text);
      const built = buildFrozenSystem({ cwd, userAgentsPath: null, userSkillDir: null, probes: false });
      expect(built.system).toContain(text);
      expect(built.system.startsWith(`${FROZEN_IDENTITY}\n\n<environment>`)).toBe(true);
      expect(built.sectionBytes.identity).toBe(Buffer.byteLength(FROZEN_IDENTITY));
      expect(built.sectionBytes.projectInstructions).toBe(Buffer.byteLength(`<project-instructions>\n${text}\n</project-instructions>`));
      expect(Object.values(built.sectionBytes).reduce((n, size) => n + size, 0)).toBe(Buffer.byteLength(built.system));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("measures the overlay boundary and keeps provider savings unknown", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefix-report-"));
    try {
      writeFileSync(join(cwd, "AGENTS.md"), "secret-project-text");
      const report = measurePrefix({ cwd, userAgentsPath: null, userSkillDir: null, probes: false });
      expect(JSON.stringify(report)).not.toContain("secret-project-text");
      expect(report.mcpFixture.selectedTools).toBe(32);
      expect(report.mcpFixture.deferredSerializedToolsBytes).toBeLessThan(report.mcpFixture.eagerSerializedToolsBytes);
      expect(report.mcpFixture.firstDiscoveryResultBytes).toBeGreaterThan(0);
      const { unchangedOverlay, changedOverlay } = report.crossPromptFixture;
      expect(unchangedOverlay.matchingInputPrefix.items).toBe(17);
      expect(unchangedOverlay.matchingInputPrefix.serializedItemBytes).toBeGreaterThan(32_000);
      expect(changedOverlay.matchingInputPrefix).toEqual({ items: 0, serializedItemBytes: 0 });
      expect(changedOverlay.instructionsIdentical).toBe(true);
      expect(changedOverlay.toolsIdentical).toBe(true);
      expect(report.providerMeasuredCacheHitRate).toBeNull();
      expect(report.providerMeasuredTokenSavings).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stops at the first changed item and counts UTF-8 bytes", () => {
    const item = { role: "user", content: "界🙂" };
    expect(matchingInputPrefix([item], [item, {}])).toEqual({ items: 1, serializedItemBytes: Buffer.byteLength(JSON.stringify(item)) });
    expect(matchingInputPrefix([item, { changed: false }, item], [item, { changed: true }, item]).items).toBe(1);
    expect(matchingInputPrefix([], [item]).items).toBe(0);
  });
});
