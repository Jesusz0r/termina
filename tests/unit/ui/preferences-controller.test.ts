import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { defaultAppPreferences } from "../../../shared/types.ts";
import { installFakeDom } from "./fake-dom.ts";

const owner = readFileSync(new URL("../../../src/main/preferences.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");

describe("preferences owner (issue #358)", () => {
  let fake: ReturnType<typeof installFakeDom>;
  let userPatch: typeof import("../../../src/main/preferences.ts").userPatch;

  beforeAll(async () => {
    fake = installFakeDom();
    ({ userPatch } = await import("../../../src/main/preferences.ts"));
  });

  afterAll(() => {
    fake.cleanup();
  });

  it("diffs only user-facing fields into a persist patch", () => {
    const prev = defaultAppPreferences();
    expect(userPatch(prev, prev)).toEqual({});
    expect(userPatch(prev, { ...prev, theme: "light", showThinking: false })).toEqual({
      theme: "light",
      showThinking: false,
    });
  });

  it("owns boot, paint, persist, and the load banner", () => {
    expect(owner).toContain("export async function createPreferences");
    expect(owner).toContain("preferenceGeneration");
    expect(owner).toContain("showPrefsLoadBanner");
    expect(owner).toContain("loadPreferencesWithRetry");
    expect(owner).toContain("from \"../../shared/preferences\"");
    expect(renderer).toContain("createPreferences");
    expect(renderer).not.toContain("function paintPreferences");
    expect(renderer).not.toContain("function applyPreferences");
  });
});
