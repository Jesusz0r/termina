import { describe, expect, it } from "vitest";
import { pickDispatchTasks, reattachDispatchAssignments, settleDispatchTask } from "../../../electron/plan-board.ts";
import type { PlanTask } from "../../../shared/types.ts";
import { parseTerminalRoster } from "../../../electron/terminal-roster.ts";

function assigned(): PlanTask {
  return { text: "Edit a.ts and b.ts", paths: ["a.ts", "b.ts"], state: "active", workerId: "term-2", claimed: ["a.ts", "b.ts"] };
}

const worker = (paths: string[], errors: string[] = []) => ({
  id: "term-2",
  touched: new Set(paths),
  toolOutcomes: new Map<string, "ok" | "error">(paths.map((path) => [path, errors.includes(path) ? "error" : "ok"])),
});

describe("dispatch attempt settlement", () => {
  it.each([
    { paths: ["a.ts", "b.ts"], errors: [], end: "settled" as const, outcome: "completed", state: "done" },
    { paths: ["a.ts"], errors: [], end: "settled" as const, outcome: "incomplete", state: "pending" },
    { paths: ["a.ts", "b.ts"], errors: ["b.ts"], end: "settled" as const, outcome: "failed", state: "pending" },
    { paths: ["a.ts", "b.ts"], errors: [], end: "failed" as const, outcome: "failed", state: "pending" },
    { paths: ["a.ts"], errors: [], end: "interrupted" as const, outcome: "interrupted", state: "pending" },
  ])("records $outcome and releases the assignment", ({ paths, errors, end, outcome, state }) => {
    const task = assigned();
    const attempt = worker(paths, errors);
    expect(settleDispatchTask(task, attempt, end)).toBe(outcome);
    expect(task.state).toBe(state);
    expect(task.workerId).toBeUndefined();
    expect(task.claimed).toBeUndefined();
    expect(task.dispatchResult).toEqual({ workerId: attempt.id, outcome });
    expect([...attempt.touched]).toEqual(paths);
  });

  it("makes an incomplete task explicitly dispatchable again", async () => {
    const task = assigned();
    settleDispatchTask(task, worker(["a.ts"]), "settled");
    const picked = await pickDispatchTasks({ plan: [task], remainingSlots: 1, inFlightPathKeys: new Set(), pathKey: (path) => path, taskText: task.text });
    expect(picked.tasks).toEqual([task]);
    expect(picked.error).toBeUndefined();
  });

  it("keeps a pathless task incomplete rather than inventing completion", () => {
    const task = { ...assigned(), paths: [] };
    expect(settleDispatchTask(task, worker([]), "settled")).toBe("incomplete");
  });

  it("retains a validated last attempt in the durable roster without restoring its assignment", () => {
    const task = assigned();
    settleDispatchTask(task, worker(["a.ts"]), "settled");
    const entries = parseTerminalRoster({ terminals: [{ id: "term-1", type: "agent", plan: [task] }] });
    expect(entries[0]?.plan?.[0]?.dispatchResult).toEqual({ workerId: "term-2", outcome: "incomplete" });
    expect(entries[0]?.plan?.[0]).not.toHaveProperty("workerId");
    expect(parseTerminalRoster({ terminals: [{ id: "term-1", type: "agent", plan: [{ ...task, dispatchResult: { workerId: "bad", outcome: "incomplete" } }] }] })[0]?.plan?.[0]?.dispatchResult).toBeUndefined();
  });

  it("preserves the last attempt when a new plan reattaches running assignments", () => {
    const previous = assigned();
    settleDispatchTask(previous, worker(["a.ts"]), "settled");
    const next: PlanTask = { text: previous.text, paths: previous.paths, state: "pending" };
    reattachDispatchAssignments([next], [{ workerId: "term-3", taskText: next.text }], [previous]);
    expect(next.dispatchResult).toEqual(previous.dispatchResult);
    expect(next.workerId).toBe("term-3");
    expect(next.state).toBe("active");
  });
});
