import { describe, expect, it } from "vitest";
import {
  TOOL_ERROR_LOOP_STREAK,
  activityFor,
  activityToolTarget,
  activityView,
  applyActivityEvent,
  emptyActivityInput,
  type ActivitySignal,
  type AgentActivityInput,
} from "../../../electron/agent-activity.ts";

function fold(events: ActivitySignal[], start: AgentActivityInput = emptyActivityInput()) {
  return events.reduce((input, event) => applyActivityEvent(input, event), start);
}

function at(seq: number): { seq: number; at: number } {
  return { seq, at: seq * 1000 };
}

describe("agent activity reducer (issue #291)", () => {
  it("prefers toolCallId over path and ignores blank targets", () => {
    expect(activityToolTarget("call-1", "/tmp/a.ts")).toBe("call-1");
    expect(activityToolTarget("  ", "/tmp/a.ts")).toBe("/tmp/a.ts");
    expect(activityToolTarget(undefined, "  ")).toBe("");
  });

  it("is idle before any run", () => {
    expect(activityView(activityFor(emptyActivityInput()))).toEqual({ state: "idle", reason: null });
  });

  it("is working after agent_start and idle after a clean settle", () => {
    const started = fold([{ t: "agent_start", ...at(1) }]);
    expect(activityView(activityFor(started))).toEqual({ state: "working", reason: null });
    const settled = fold([{ t: "agent_settled", ...at(2), error: null }], started);
    expect(activityView(activityFor(settled))).toEqual({ state: "idle", reason: null });
  });

  it("is working while a prompt or preflight is in flight", () => {
    expect(activityView(activityFor(fold([{ t: "prompt", ...at(1) }])))).toEqual({ state: "working", reason: null });
    expect(activityView(activityFor(fold([{ t: "preflight_request", ...at(1) }])))).toEqual({
      state: "working",
      reason: null,
    });
  });

  it("blocks on a preflight lease timeout", () => {
    const input = fold([
      { t: "preflight_request", ...at(1) },
      { t: "preflight_timeout", ...at(2) },
    ]);
    expect(activityView(activityFor(input))).toEqual({ state: "blocked", reason: "lease-wait" });
  });

  it("does not treat a cancelled preflight as a lease wait", () => {
    const input = fold([
      { t: "preflight_request", ...at(1) },
      { t: "preflight_cancel", ...at(2) },
    ]);
    expect(activityView(activityFor(input))).toEqual({ state: "idle", reason: null });
  });

  it("does not treat a timeout after cancel as a lease wait", () => {
    const input = fold([
      { t: "preflight_request", ...at(1) },
      { t: "preflight_cancel", ...at(2) },
      { t: "preflight_timeout", ...at(3) },
    ]);
    expect(activityView(activityFor(input))).toEqual({ state: "idle", reason: null });
  });

  it("ignores anonymous tool_end errors for the error-loop streak", () => {
    const events: ActivitySignal[] = [{ t: "agent_start", ...at(1) }];
    for (let i = 0; i < TOOL_ERROR_LOOP_STREAK; i++) {
      events.push({ t: "tool_end", ...at(2 + i), target: "_", isError: true });
      events.push({ t: "tool_end", ...at(20 + i), target: "", isError: true });
    }
    expect(activityView(activityFor(fold(events)))).toEqual({ state: "working", reason: null });
  });

  it("blocks on the same-target tool_end error streak during a run", () => {
    const events: ActivitySignal[] = [{ t: "agent_start", ...at(1) }];
    for (let i = 0; i < TOOL_ERROR_LOOP_STREAK; i++) {
      const seq = 2 + i * 2;
      events.push({ t: "tool", ...at(seq), target: "edit:/tmp/a.ts" });
      events.push({ t: "tool_end", ...at(seq + 1), target: "edit:/tmp/a.ts", isError: true });
    }
    expect(activityView(activityFor(fold(events)))).toEqual({ state: "blocked", reason: "tool-error-loop" });
  });

  it("resets the error streak when the target succeeds or changes", () => {
    const almost = fold([
      { t: "agent_start", ...at(1) },
      { t: "tool_end", ...at(2), target: "a", isError: true },
      { t: "tool_end", ...at(3), target: "a", isError: true },
      { t: "tool_end", ...at(4), target: "a", isError: false },
      { t: "tool_end", ...at(5), target: "b", isError: true },
    ]);
    expect(activityView(activityFor(almost))).toEqual({ state: "working", reason: null });
    expect(almost.errorStreak).toBe(1);
    expect(almost.errorStreakTarget).toBe("b");
  });

  it("blocks on stall-tracker stop surfaced via agent_settled.error", () => {
    const input = fold([
      { t: "agent_start", ...at(1) },
      { t: "agent_settled", ...at(2), error: "stalled: tool loop continued after recovery guidance (edit)" },
    ]);
    expect(activityView(activityFor(input))).toEqual({ state: "blocked", reason: "stalled" });
  });

  it("stays idle after a non-stall settle error", () => {
    const input = fold([
      { t: "agent_start", ...at(1) },
      { t: "agent_settled", ...at(2), error: "session storage failed: disk full" },
    ]);
    expect(activityView(activityFor(input))).toEqual({ state: "idle", reason: null });
  });

  it("clears a tool-error loop when the run settles cleanly", () => {
    const events: ActivitySignal[] = [{ t: "agent_start", ...at(1) }];
    for (let i = 0; i < TOOL_ERROR_LOOP_STREAK; i++) {
      events.push({ t: "tool_end", ...at(2 + i), target: "loop", isError: true });
    }
    events.push({ t: "agent_settled", ...at(20), error: null });
    expect(activityView(activityFor(fold(events)))).toEqual({ state: "idle", reason: null });
  });

  it("blocks when the PTY exits mid-run, not after a settled run", () => {
    const midRun = fold([
      { t: "agent_start", ...at(1) },
      { t: "pty_exit", ...at(2) },
    ]);
    expect(activityView(activityFor(midRun))).toEqual({ state: "blocked", reason: "exited-mid-run" });
    const afterSettle = fold([
      { t: "agent_start", ...at(1) },
      { t: "agent_settled", ...at(2), error: null },
      { t: "pty_exit", ...at(3) },
    ]);
    expect(activityView(activityFor(afterSettle))).toEqual({ state: "idle", reason: null });
  });

  it("prefers sidecar hold over an in-flight run", () => {
    const input = fold([
      { t: "agent_start", ...at(1) },
      { t: "sidecar_hold", ...at(2), held: true },
    ]);
    expect(activityView(activityFor(input))).toEqual({ state: "blocked", reason: "sidecar-paused" });
    const released = fold([{ t: "sidecar_hold", ...at(3), held: false }], input);
    expect(activityView(activityFor(released))).toEqual({ state: "working", reason: null });
  });
});
