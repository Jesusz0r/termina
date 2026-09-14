/**
 * Icon-pipeline entry check (issue #131).
 *
 * scripts/make-icon.sh must invoke the existing TypeScript render entry
 * with the project-supported Node command. No .mjs compatibility shim.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("icon generation entry (#131)", () => {
  it("invokes the TypeScript render entry with type stripping", () => {
    const script = read("scripts/make-icon.sh");
    expect(script).toContain("node --experimental-strip-types scripts/render-icon.ts");
    expect(script).not.toMatch(/render-icon\.mjs/);
  });

  it("resolves every script entry it invokes, with no .mjs shim", () => {
    const script = read("scripts/make-icon.sh");
    const entries = [...script.matchAll(/node --experimental-strip-types (scripts\/[^\s"']+)/g)].map((m) => m[1]);
    expect(entries).toContain("scripts/render-icon.ts");
    for (const entry of entries) {
      expect(existsSync(join(repoRoot, entry)), `${entry} must exist`).toBe(true);
    }
    expect(existsSync(join(repoRoot, "scripts/render-icon.mjs"))).toBe(false);
  });

  it("keeps the maintainer entry point stable", () => {
    expect(read("RELEASING.md")).toContain("scripts/make-icon.sh");
  });
});
