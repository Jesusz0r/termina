import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const view = readFileSync(new URL("../../../src/worldlines.ts", import.meta.url), "utf8");

describe("worldline action placement", () => {
  it("keeps Open, Compare, and Promote as the only card primaries", () => {
    expect(view).toContain("actions.append(openBtn, compareBtn, promoteBtn, moreBtn)");
    expect(view).toContain('actionButton("cmp-ab", "A ⇄ B"');
    expect(view).not.toContain("actions.append(promoteBtn, verifyBtn, compareBtn, openBtn, exportBtn)");
  });

  it("puts Challenge, Evidence, Export, and Discard behind the ⋯ disclosure", () => {
    expect(view).toContain("moreBody.append(...challengeButtons, evidenceBtn, discardBtn)");
    expect(view).toContain("moreBody.append(verifyBtn, exportBtn)");
    expect(view).toContain('return actionButton("cand-details", "⋯"');
    expect(view).toContain("body.hidden = !body.hidden");
  });

  it("explains that A is the result and B is a retry", () => {
    expect(view).toContain('export const WORLDLINE_FIRST_PAIR_LINE = "A is the result · B is a retry"');
    expect(view).toContain("rolesEl.textContent = WORLDLINE_FIRST_PAIR_LINE");
  });
});
