import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  asKnownState,
  KNOWN_CANDIDATE_STATES,
  KNOWN_EVIDENCE_STATUSES,
  KNOWN_FILE_STATUSES,
  KNOWN_PLAN_STATES,
  KNOWN_PROFILE_WINNERS,
  KNOWN_RECORDER_STATES,
  KNOWN_VERIFY_BADGE_STATES,
  UNKNOWN_STATE,
} from "../../../src/known-state.ts";

describe("asKnownState (issue #272)", () => {
  it("returns the value when it is in the allowlist", () => {
    expect(asKnownState("ready", KNOWN_CANDIDATE_STATES)).toBe("ready");
    expect(asKnownState("unavailable", KNOWN_PROFILE_WINNERS)).toBe("unavailable");
    expect(asKnownState("modified", KNOWN_FILE_STATUSES)).toBe("modified");
    expect(asKnownState("pending", KNOWN_PLAN_STATES)).toBe("pending");
    expect(asKnownState("cancelled", KNOWN_VERIFY_BADGE_STATES)).toBe("cancelled");
    expect(asKnownState("paused", KNOWN_RECORDER_STATES)).toBe("paused");
    expect(asKnownState("fail", KNOWN_EVIDENCE_STATUSES)).toBe("fail");
  });

  it("returns unknown for missing, hostile, or neighboring-but-wrong values", () => {
    expect(asKnownState("creating", KNOWN_RECORDER_STATES)).toBe(UNKNOWN_STATE);
    expect(asKnownState("evil-state", KNOWN_CANDIDATE_STATES)).toBe(UNKNOWN_STATE);
    expect(asKnownState(null, KNOWN_FILE_STATUSES)).toBe(UNKNOWN_STATE);
    expect(asKnownState(undefined, KNOWN_PLAN_STATES)).toBe(UNKNOWN_STATE);
    expect(asKnownState(1, KNOWN_VERIFY_BADGE_STATES)).toBe(UNKNOWN_STATE);
  });

  it("is the only renderer fallback for the nine IPC class-name sites", () => {
    const files = [
      "src/worldlines.ts",
      "src/main/activity-pane.ts",
      "src/components/modals.ts",
      "src/main.ts",
      "src/timeline.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
      expect(src).toContain("asKnownState(");
      expect(src).not.toMatch(/falls back to (creating|unavailable|modified|pending|cancelled|paused)/);
    }
  });
});
