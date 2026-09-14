/**
 * Packaging CLI staging (issue #261 CO/M4).
 *
 * `bin/termina` is source-controlled; a missing launcher is always a bug.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBin } from "../../../scripts/prepare-resources.ts";

const roots: string[] = [];
const cwd = process.cwd();
afterEach(() => {
  process.chdir(cwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prepareBin (#261 CO/M4)", () => {
  it("throws when bin/termina is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "termina-prepare-bin-"));
    roots.push(root);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(() => prepareBin(join(root, "resources"))).toThrow(/missing CLI launcher/);
    } finally {
      process.chdir(cwd);
    }
  });

  it("stages a present launcher into resources/bin/termina", () => {
    const root = mkdtempSync(join(tmpdir(), "termina-prepare-bin-"));
    roots.push(root);
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "termina"), "#!/bin/sh\necho staged\n", { mode: 0o644 });
    const resources = join(root, "resources");
    const cwd = process.cwd();
    process.chdir(root);
    try {
      prepareBin(resources);
    } finally {
      process.chdir(cwd);
    }
    const dest = join(resources, "bin", "termina");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain("echo staged");
    expect(statSync(dest).mode & 0o111).not.toBe(0);
    chmodSync(dest, 0o755);
  });
});
