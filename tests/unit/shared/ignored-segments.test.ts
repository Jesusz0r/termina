import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { IGNORED_SEGMENTS } from "../../../shared/gitignore.ts";

describe("ignored segments", () => {
  it("skips e2e run roots so Chromium user-data cannot enter captures", () => {
    expect(IGNORED_SEGMENTS.has(".e2e-tmp")).toBe(true);
    const gitignore = readFileSync(new URL("../../../.gitignore", import.meta.url), "utf8");
    expect(gitignore.includes(".e2e-tmp/")).toBe(true);
  });
});
