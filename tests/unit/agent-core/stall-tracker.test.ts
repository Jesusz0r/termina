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
  emptyToolLoopTracker,
  trackToolLoopTurn,
  toolRunLimitReason,
  MAX_RUN_MODEL_TURNS,
  MAX_RUN_TOOL_CALLS,
} from "../../../agent-core/stall.ts";

function bashCall(command: string, output: string) {
  return { name: "bash", input: { command }, result: { type: "tool_result", content: output } };
}

describe("run fuses", () => {
  it("allows work within the budget and refuses the next continuation at the bound", () => {
    expect(toolRunLimitReason(MAX_RUN_MODEL_TURNS - 1, MAX_RUN_TOOL_CALLS)).toBeNull();
    expect(toolRunLimitReason(MAX_RUN_MODEL_TURNS, 0)).toContain("model turns");
    expect(toolRunLimitReason(1, MAX_RUN_TOOL_CALLS + 1)).toContain("tool calls");
  });
});

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

  it("ignores fresh result-envelope IDs without ignoring actual output IDs or errors", () => {
    const call = (id: string, content: unknown = "same") => ({
      ...bashCall("pwd", "same"),
      result: { type: "tool_result", tool_use_id: id, content },
    });
    const first = call("call-1");
    const second = call("call-2");
    expect(stallTurnFingerprint([first])).toBe(stallTurnFingerprint([second]));
    expect(stallTurnFingerprint([first])).not.toBe(stallTurnFingerprint([{ ...second, isError: true }]));
    expect(stallTurnFingerprint([call("call-1", { tool_use_id: "data-1" })])).not.toBe(
      stallTurnFingerprint([call("call-2", { tool_use_id: "data-2" })]),
    );
    expect(first.result.tool_use_id).toBe("call-1");
  });

  it("is stable across paraphrased prose but sensitive to args", () => {
    const a = stallTurnFingerprint([bashCall("git status -sb", "same")])!;
    const b = stallTurnFingerprint([bashCall("git status -sb", "same")])!;
    expect(a).toBe(b);
    expect(stallTurnFingerprint([bashCall("git diff", "same")])).not.toBe(a);
  });
});

describe("tool-loop recovery policy", () => {
  const miss = (turn: number, oldText = "missing") => ({
    name: "edit",
    input: { path: "file.ts", old_text: oldText, new_text: "fixed" },
    result: {
      type: "tool_result",
      tool_use_id: `call-${turn}`,
      content: "error: old_text not found (0 occurrences)",
      is_error: true,
    },
    isError: true,
  });

  it.each([false, true])("offers recovery before stopping; changed snippets=%s", (changeSnippets) => {
    let tracker = emptyToolLoopTracker();
    for (let turn = 1; turn <= 6; turn++) {
      const step = trackToolLoopTurn(tracker, [miss(turn, changeSnippets ? `missing-${turn}` : "missing")]);
      tracker = step.tracker;
      expect(step.stalled).toBe(turn === 6);
      if (turn === 3) {
        expect(step.recovery).toContain("Recover autonomously");
        expect(step.recovery).toContain("read_file");
        expect(step.recovery).toContain("N|");
        expect(step.recovery).toContain("Do not guess");
      } else {
        expect(step.recovery).toBeNull();
      }
    }
  });

  it("clears escalation after a fresh read and permits a corrected edit", () => {
    let tracker = emptyToolLoopTracker();
    for (let i = 0; i < 3; i++) tracker = trackToolLoopTurn(tracker, [miss(i)]).tracker;
    const read = trackToolLoopTurn(tracker, [{ name: "read_file", input: { path: "file.ts" }, result: "1|actual" }]);
    expect(read.tracker.recoveryOffered).toBe(false);
    const corrected = trackToolLoopTurn(read.tracker, [{
      name: "edit", input: { path: "file.ts", old_text: "actual", new_text: "fixed" },
      result: { type: "tool_result", tool_use_id: "fixed", content: "ok: edited file.ts" },
      isError: false,
    }]);
    expect(corrected.stalled).toBe(false);
    expect(corrected.recovery).toBeNull();
    expect(corrected.tracker.recoveryOffered).toBe(false);
    // A later loop must get its own recovery opportunity, not an immediate stop.
    tracker = corrected.tracker;
    for (let i = 0; i < 2; i++) tracker = trackToolLoopTurn(tracker, [miss(i)]).tracker;
    const nextLoop = trackToolLoopTurn(tracker, [miss(3)]);
    expect(nextLoop.recovery).not.toBeNull();
    expect(nextLoop.stalled).toBe(false);
  });

  it("clears escalation when the failure target changes or a text-only turn intervenes", () => {
    let tracker = emptyToolLoopTracker();
    for (let i = 0; i < 3; i++) tracker = trackToolLoopTurn(tracker, [miss(i)]).tracker;
    const other = miss(4);
    other.input.path = "other.ts";
    expect(trackToolLoopTurn(tracker, [other]).tracker.recoveryOffered).toBe(false);
    expect(trackToolLoopTurn(tracker, []).tracker).toEqual(emptyToolLoopTracker());
  });

  it("gives even an oversized parallel failure batch a recovery opportunity", () => {
    const first = trackToolLoopTurn(emptyToolLoopTracker(), Array.from({ length: 8 }, (_, i) => miss(i)));
    expect(first.stalled).toBe(false);
    expect(first.recovery).not.toBeNull();
    const retry = trackToolLoopTurn(first.tracker, [miss(9)]);
    expect(retry.stalled).toBe(false);
    expect(retry.tracker.failure.repeats).toBe(1);
    expect(retry.recovery).toBeNull();
  });

  it("offers search recovery for repeated empty results", () => {
    let tracker = emptyToolLoopTracker();
    const call = { name: "grep", input: { path: "file.ts", pattern: "absent" }, result: "(no matches)" };
    for (let i = 0; i < 2; i++) tracker = trackToolLoopTurn(tracker, [call]).tracker;
    const step = trackToolLoopTurn(tracker, [call]);
    expect(step.recovery).toContain("broaden the pattern or scope");
    expect(step.stalled).toBe(false);
  });

  it("detects alternating failed edits and unchanged reads even when snippets change", () => {
    let tracker = emptyToolLoopTracker();
    const recoveries: number[] = [];
    for (let turn = 1; turn <= 12; turn++) {
      const call = turn % 2 === 1 ? miss(turn, `guess-${turn}`) : {
        name: "read_file", input: { path: "file.ts" }, result: "1|unchanged",
      };
      const step = trackToolLoopTurn(tracker, [call]);
      tracker = step.tracker;
      if (step.recovery) recoveries.push(turn);
      expect(step.stalled).toBe(turn === 12);
    }
    expect(recoveries).toEqual([6]);
  });

  it("detects successful edits that keep undoing each other", () => {
    let tracker = emptyToolLoopTracker();
    for (let turn = 1; turn <= 12; turn++) {
      const call = {
        name: "edit", input: { path: "file.ts", old_text: turn % 2 ? "a" : "b", new_text: turn % 2 ? "b" : "a" },
        result: "ok: edited file.ts", isError: false,
      };
      const step = trackToolLoopTurn(tracker, [call]);
      tracker = step.tracker;
      expect(step.recovery !== null).toBe(turn === 6);
      expect(step.stalled).toBe(turn === 12);
    }
  });

  it("detects mixed-target failure batches despite ordering and snippet changes", () => {
    let tracker = emptyToolLoopTracker();
    for (let turn = 1; turn <= 6; turn++) {
      const a = miss(turn, `a-${turn}`);
      const b = miss(turn, `b-${turn}`);
      b.input.path = "other.ts";
      const step = trackToolLoopTurn(tracker, turn % 2 ? [a, b] : [b, a]);
      tracker = step.tracker;
      expect(step.recovery !== null).toBe(turn === 3);
      expect(step.stalled).toBe(turn === 6);
    }
  });

  it("does not count changed search scope or changed observations as repetition", () => {
    expect(stallFailureKey({ name: "grep", input: { pattern: "x", glob: "*.ts" }, result: "(no matches)" })).not.toBe(
      stallFailureKey({ name: "grep", input: { pattern: "x", glob: "*.js" }, result: "(no matches)" }),
    );
    expect(stallFailureKey({ name: "mcp_lookup", input: { id: "a" }, result: "missing", isError: true })).not.toBe(
      stallFailureKey({ name: "mcp_lookup", input: { id: "b" }, result: "missing", isError: true }),
    );
    let tracker = emptyToolLoopTracker();
    for (let turn = 0; turn < 100; turn++) {
      const call = turn % 2 ? miss(turn) : {
        name: "read_file", input: { path: "file.ts" }, result: `1|new evidence ${turn}`,
      };
      const step = trackToolLoopTurn(tracker, [call]);
      tracker = step.tracker;
      expect(step.stalled).toBe(false);
      expect(step.recovery).toBeNull();
      expect(tracker.recentTurns.length).toBeLessThanOrEqual(24);
    }
  });

  it("offers recovery for identical successful but unproductive tool turns", () => {
    let tracker = emptyToolLoopTracker();
    for (let turn = 1; turn <= 6; turn++) {
      const step = trackToolLoopTurn(tracker, [bashCall("pwd", "/project")]);
      tracker = step.tracker;
      expect(step.stalled).toBe(turn === 6);
      expect(step.recovery !== null).toBe(turn === 3);
    }
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
