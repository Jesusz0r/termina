import { describe, it, expect } from "vitest";
import {
  STALL_TURNS,
  STALL_FAILURE_TURNS,
  emptyStallTracker,
  emptyFailureLoopTracker,
  stallTurnFingerprint,
  stallFailureKey,
  stallFailureKeysForTurn,
  trackStallTurn,
  trackFailureLoopTurn,
} from "../../../agent-core/stall.ts";

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

describe("failure-loop detector", () => {
  const editMiss = (oldText: string) => ({
    name: "edit",
    input: { path: "electron/session-fork.ts", old_text: oldText, new_text: "x" },
    result: { type: "tool_result", content: "edit miss" },
    isError: true,
  });
  const grepEmpty = (pattern: string) => ({
    name: "grep",
    input: { pattern, path: "electron/main.ts" },
    result: { type: "tool_result", content: "(no matches)" },
    isError: false,
  });

  it("collapses edit retries with different old_text on the same file", () => {
    const a = stallFailureKey(editMiss("foo"))!;
    const b = stallFailureKey(editMiss("bar baz"))!;
    expect(a).toBe(b);
    expect(stallFailureKey(editMiss("foo"))).not.toBe(
      stallFailureKey({ ...editMiss("foo"), input: { path: "other.ts", old_text: "foo", new_text: "x" } }),
    );
  });

  it("trips after STALL_FAILURE_TURNS same-target failures", () => {
    let tracker = emptyFailureLoopTracker();
    for (let i = 1; i < STALL_FAILURE_TURNS; i++) {
      tracker = trackFailureLoopTurn(tracker, stallFailureKeysForTurn([editMiss(`v${i}`)]));
      expect(tracker.repeats).toBe(i);
    }
    tracker = trackFailureLoopTurn(tracker, stallFailureKeysForTurn([editMiss("final")]));
    expect(tracker.repeats).toBe(STALL_FAILURE_TURNS);
  });

  it("counts intra-turn duplicates so 8 parallel greps trip at once", () => {
    const keys = stallFailureKeysForTurn(Array.from({ length: 8 }, () => grepEmpty("isProjectFile")));
    const tracker = trackFailureLoopTurn(emptyFailureLoopTracker(), keys);
    expect(tracker.repeats).toBe(8);
    expect(tracker.repeats).toBeGreaterThanOrEqual(STALL_FAILURE_TURNS);
  });

  it("resets on progress, mixed targets, or productive results", () => {
    let tracker = trackFailureLoopTurn(emptyFailureLoopTracker(), stallFailureKeysForTurn([editMiss("a")]));
    expect(tracker.repeats).toBe(1);
    // Productive non-empty success carries no failure key.
    tracker = trackFailureLoopTurn(
      tracker,
      stallFailureKeysForTurn([{ name: "read_file", input: { path: "x" }, result: "hello" }]),
    );
    expect(tracker).toEqual({ key: null, repeats: 0 });
    tracker = trackFailureLoopTurn(emptyFailureLoopTracker(), stallFailureKeysForTurn([editMiss("a")]));
    // Mixed targets in one turn are independent work, not a loop.
    tracker = trackFailureLoopTurn(
      tracker,
      stallFailureKeysForTurn([editMiss("a"), grepEmpty("isProjectFile")]),
    );
    expect(tracker).toEqual({ key: null, repeats: 0 });
  });
});
