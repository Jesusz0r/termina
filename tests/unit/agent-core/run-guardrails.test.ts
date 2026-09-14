import { describe, expect, it } from "vitest";

import { RUN_IMAGE_CAP, droppedRunImageCount, isLiveSubagentRun } from "../../../agent-core/main.ts";

describe("run guardrails (#222)", () => {
  it("counts images dropped by the run cap", () => {
    expect(RUN_IMAGE_CAP).toBe(4);
    expect(droppedRunImageCount(0, 0)).toBe(0);
    expect(droppedRunImageCount(2, 1)).toBe(0);
    expect(droppedRunImageCount(4, 0)).toBe(0);
    expect(droppedRunImageCount(4, 2)).toBe(2);
    expect(droppedRunImageCount(6, 3)).toBe(5);
  });

  it("prompts pickers only for live runs", () => {
    expect(isLiveSubagentRun({ state: "active" })).toBe(true);
    expect(isLiveSubagentRun({ state: "settled" })).toBe(false);
    expect(isLiveSubagentRun({ state: "failed" })).toBe(false);
    expect(isLiveSubagentRun({ state: "killed" })).toBe(false);
    expect(isLiveSubagentRun(undefined)).toBe(false);
  });
});
