import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  asKnownState,
  KNOWN_CANDIDATE_STATES,
  KNOWN_EVIDENCE_STATUSES,
  KNOWN_FILE_STATUSES,
  KNOWN_PLAN_STATES,
  KNOWN_PROFILE_WINNERS,
  KNOWN_ACTIVITY_REASONS,
  KNOWN_ACTIVITY_STATES,
  KNOWN_RECORDER_STATES,
  KNOWN_VERIFY_BADGE_STATES,
  UNKNOWN_STATE,
  presentBlockedLabel,
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
    expect(asKnownState("blocked", KNOWN_ACTIVITY_STATES)).toBe("blocked");
    expect(asKnownState("tool-error-loop", KNOWN_ACTIVITY_REASONS)).toBe("tool-error-loop");
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

describe("presentBlockedLabel (issue #348)", () => {
  it("maps protocol reasons to user phrases and keeps the blocked state", () => {
    expect(presentBlockedLabel("lease-wait")).toBe("blocked: waiting to write");
    expect(presentBlockedLabel("sidecar-paused")).toBe("blocked: paused");
    expect(presentBlockedLabel("lease-wait")).not.toMatch(/lease/i);
    expect(presentBlockedLabel("sidecar-paused")).not.toMatch(/sidecar/i);
  });

  it("keeps user-facing known reasons and omits unknown or empty ones", () => {
    expect(presentBlockedLabel("tool-error-loop")).toBe("blocked: tool-error-loop");
    expect(presentBlockedLabel("stalled")).toBe("blocked: stalled");
    expect(presentBlockedLabel("exited-mid-run")).toBe("blocked: exited-mid-run");
    expect(presentBlockedLabel("evil-reason")).toBe("blocked");
    expect(presentBlockedLabel(null)).toBe("blocked");
    expect(presentBlockedLabel(undefined)).toBe("blocked");
    expect(presentBlockedLabel("")).toBe("blocked");
  });

  it("never prints writerId or protocol tokens for any known reason", () => {
    for (const reason of KNOWN_ACTIVITY_REASONS) {
      const label = presentBlockedLabel(reason);
      expect(label.startsWith("blocked")).toBe(true);
      expect(label).not.toMatch(/lease-wait|sidecar-paused|writerId|sidecar|lease/i);
    }
  });

  it("is the only blocked-reason presenter for status and timeline", () => {
    const mainSrc = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
    const timelineSrc = readFileSync(new URL("../../../src/timeline.ts", import.meta.url), "utf8");
    expect(mainSrc).toContain("presentBlockedLabel(pane.activity?.reason)");
    expect(timelineSrc).toContain("presentBlockedLabel(p?.activity?.reason)");
    expect(timelineSrc).toContain("presentBlockedLabel(this.activity?.reason)");
    expect(mainSrc).not.toContain("`blocked: ${reason}`");
    expect(timelineSrc).not.toContain("`blocked: ${activityReason}`");
    expect(timelineSrc).not.toContain("` — blocked: ${activityReason}`");
  });
});
