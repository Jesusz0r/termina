import { describe, it, expect } from "vitest";
import {
  STALL_TURNS,
  emptyStallTracker,
  stallTurnFingerprint,
  trackStallTurn,
} from "../../../agent-core/main.ts";

function bashCall(command: string, output: string) {
  return { name: "bash", input: { command }, result: { type: "tool_result", content: output } };
}

describe("stall detector", () => {
  it("ignores text-only turns", () => {
    expect(stallTurnFingerprint([])).toBe(null);
    expect(trackStallTurn(emptyStallTracker(), null)).toEqual({ fingerprint: null, repeats: 0 });
  });

  it("trips after STALL_TURNS identical tool turns", () => {
    let tracker = emptyStallTracker();
    const print = stallTurnFingerprint([bashCall("git status -sb", "M migrate.ts")])!;
    for (let i = 1; i < STALL_TURNS; i++) {
      tracker = trackStallTurn(tracker, print);
      expect(tracker.repeats).toBe(i);
    }
    tracker = trackStallTurn(tracker, print);
    expect(tracker.repeats).toBe(STALL_TURNS);
  });

  it("resets when results change", () => {
    let tracker = trackStallTurn(emptyStallTracker(), stallTurnFingerprint([bashCall("git status -sb", "M migrate.ts")]));
    tracker = trackStallTurn(tracker, stallTurnFingerprint([bashCall("git status -sb", "M migrate.ts")]));
    expect(tracker.repeats).toBe(2);
    tracker = trackStallTurn(tracker, stallTurnFingerprint([bashCall("git status -sb", "clean")]));
    expect(tracker.repeats).toBe(1);
  });

  it("resets on different tools or a text-only turn", () => {
    let tracker = trackStallTurn(emptyStallTracker(), stallTurnFingerprint([bashCall("git status -sb", "M migrate.ts")]));
    tracker = trackStallTurn(tracker, stallTurnFingerprint([{ name: "read_file", input: { path: "x" }, result: "y" }]));
    expect(tracker.repeats).toBe(1);
    tracker = trackStallTurn(tracker, null);
    expect(tracker).toEqual({ fingerprint: null, repeats: 0 });
  });

  it("is stable across paraphrased prose but sensitive to args", () => {
    const a = stallTurnFingerprint([bashCall("git status -sb", "same")])!;
    const b = stallTurnFingerprint([bashCall("git status -sb", "same")])!;
    expect(a).toBe(b);
    expect(stallTurnFingerprint([bashCall("git diff", "same")])).not.toBe(a);
  });
});
