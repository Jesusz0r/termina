/**
 * Handoff-check regressions (issue #240).
 *
 * The checker rejects a note that omits a required field. It does not
 * fill defaults. Policy lives in docs/reference/CALIBRATION.md.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HANDOFF_FIELDS,
  HandoffError,
  assertHandoff,
  checkHandoff,
  checkHandoffFile,
  type HandoffField,
} from "../../../scripts/handoff-check.ts";

const repo = resolve(__dirname, "..", "..", "..");
const POLICY = join(repo, "docs/reference/CALIBRATION.md");
const BASELINE = join(repo, "docs/reference/LAZINESS-BASELINE.md");

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

function writeHandoff(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "termina-handoff-"));
  fixtures.push(dir);
  const file = join(dir, "handoff.md");
  writeFileSync(file, body);
  return file;
}

function conformingMarkdown(overrides: Partial<Record<HandoffField, string>> = {}): string {
  const fields: Record<HandoffField, string> = {
    "as-is": "Handoffs omit evidence.",
    "should-be": "Every handoff states the required fields.",
    "checks-observed": "pnpm run typecheck (pass)",
    "open-risks": "none",
    "evidence": "scripts/handoff-check.ts rejects a missing field.",
    "confidence": "high — the checker fails closed on a missing field.",
    "change-condition": "A checker that fills a default would change this claim.",
    ...overrides,
  };
  return [
    `## As-is`,
    fields["as-is"],
    ``,
    `## Should-be`,
    fields["should-be"],
    ``,
    `## Checks observed`,
    fields["checks-observed"],
    ``,
    `## Open risks`,
    fields["open-risks"],
    ``,
    `## Evidence`,
    fields["evidence"],
    ``,
    `## Confidence`,
    fields["confidence"],
    ``,
    `## Change-condition`,
    fields["change-condition"],
    ``,
  ].join("\n");
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "scripts/handoff-check.ts", ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("handoff check (#240)", () => {
  it("accepts a conforming markdown handoff", () => {
    const result = checkHandoff(conformingMarkdown());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields["as-is"]).toContain("omit evidence");
    expect(result.fields["open-risks"]).toBe("none");
    expect(result.fields["change-condition"]).toContain("fills a default");
  });

  it("accepts labeled lines and heading aliases", () => {
    const result = checkHandoff([
      "as-is: current note has no contract",
      "should-be: required fields are present",
      "observed-checks: vitest run tests/unit/scripts/handoff-check.test.ts",
      "open risks: none",
      "evidence: this file",
      "confidence: medium — aliases must map, not invent values",
      "what would change the claim: an alias that silently drops a field",
    ].join("\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields["checks-observed"]).toContain("vitest");
    expect(result.fields["change-condition"]).toContain("silently drops");
  });

  it("accepts a conforming JSON handoff", () => {
    const result = checkHandoff(JSON.stringify({
      "as-is": "implicit confidence",
      "should-be": "stated confidence",
      "checksObserved": "node --experimental-strip-types scripts/handoff-check.ts note.md",
      "openRisks": "none",
      "evidence": "JSON keys fold to the canonical fields",
      "confidence": "high — every key is present and non-empty",
      "changeCondition": "a missing JSON key would fail this check",
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields["checks-observed"]).toContain("handoff-check.ts");
  });

  it("rejects osmosis prose with no fields", () => {
    const result = checkHandoff("Looks good. Checks should pass. Ready to hand off.\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.missing]).toEqual([...HANDOFF_FIELDS]);
  });

  it("rejects empty text without filling defaults", () => {
    const result = checkHandoff("   \n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toHaveLength(HANDOFF_FIELDS.length);
  });

  it.each([...HANDOFF_FIELDS])("rejects a handoff missing %s", (field) => {
    const body = conformingMarkdown({ [field]: "" });
    const result = checkHandoff(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([field]);
  });

  it("rejects a present but empty field", () => {
    const result = checkHandoff(conformingMarkdown({ evidence: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["evidence"]);
  });

  it("rejects a confidence value that is not a calibrated level", () => {
    const result = checkHandoff(conformingMarkdown({ confidence: "looks good" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["confidence"]);
  });

  it("does not absorb a JSON object that omits a field", () => {
    const result = checkHandoff(JSON.stringify({
      "as-is": "a",
      "should-be": "b",
      "checks-observed": "c",
      "open-risks": "none",
      "confidence": "low",
      "change-condition": "d",
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["evidence"]);
    expect(result).not.toHaveProperty("fields");
  });

  it("throws on assertHandoff when a field is missing", () => {
    expect(() => assertHandoff("looks good")).toThrow(HandoffError);
    expect(() => assertHandoff("looks good")).toThrow(/missing as-is/);
  });

  it("returns fields from assertHandoff when the note conforms", () => {
    const fields = assertHandoff(conformingMarkdown());
    expect(fields["should-be"]).toContain("required fields");
  });

  it("exposes the same reject through the file helper and CLI", () => {
    const file = writeHandoff("Looks good.\n");
    const fromFile = checkHandoffFile(file);
    expect(fromFile.ok).toBe(false);
    const cli = runCli([file]);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/handoff rejected: missing as-is/);
    expect(cli.stdout).toBe("");
  });

  it("exposes a conforming file through the repeatable command", () => {
    const file = writeHandoff(conformingMarkdown());
    const cli = runCli([file]);
    expect(cli.status).toBe(0);
    expect(cli.stdout.trim()).toBe("ok");
  });

  it("prints usage and exits 1 when no file is given", () => {
    const cli = runCli([]);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/usage: handoff-check\.ts <handoff-file>/);
  });

  it("rejects an unreadable handoff file", () => {
    expect(() => checkHandoffFile(join(tmpdir(), "termina-no-such-handoff.md"))).toThrow(/cannot read/);
  });

  it("accepts the conforming example in CALIBRATION.md", () => {
    const doc = readFileSync(POLICY, "utf8");
    const match = doc.match(/### Example \(conforming\)\n\n```markdown\n([\s\S]*?)\n```/);
    expect(match?.[1]).toBeTruthy();
    const result = checkHandoff(match![1]!);
    expect(result.ok).toBe(true);
  });

  it("keeps the policy and #125 pointer in the documented paths", () => {
    const policy = readFileSync(POLICY, "utf8");
    expect(policy).toContain("Done = checkable + proven by facts");
    expect(policy).toContain("f77883c");
    expect(policy).toMatch(/#123 and #124 are gone/i);
    expect(policy).toContain("#125 is measurement-only");
    expect(policy).toContain("#237");
    expect(policy).toContain("No-Quiet-Wins");
    expect(policy).toContain("scripts/handoff-check.ts");
    for (const field of HANDOFF_FIELDS) {
      expect(policy.toLowerCase()).toContain(field);
    }
    const baseline = readFileSync(BASELINE, "utf8");
    expect(baseline).toMatch(/#125 remains measurement-only/);
    expect(baseline).toContain("docs/reference/CALIBRATION.md");
    expect(baseline).toContain("| edits without check | 1 | 8 | 0.125 |");
  });
});
