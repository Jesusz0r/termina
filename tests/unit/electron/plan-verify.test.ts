import { describe, expect, it } from "vitest";
import { finalizePlanTasks, parsePlanTasks, reattachDispatchAssignments, settleDispatchTask } from "../../../electron/plan-board.ts";
import { parseTerminalRoster } from "../../../electron/terminal-roster.ts";
import type { PlanTask, VerifyInfo } from "../../../shared/types.ts";

const pass: VerifyInfo = {
  state: "pass", command: "npm run test", summary: "tests green",
  source: { workspaceId: "primary", root: "/project", tree: "a".repeat(40), revision: 1, observationEpoch: 1, generation: 1 },
  result: { state: "pass", exitCode: 0, startedAt: 1, finishedAt: 2 },
};
const task = (paths = ["a.ts"]): PlanTask => ({ text: `Fix ${paths.join(" and ")}`, paths, state: "pending" });
const touched = new Set(["a.ts"]);
const outcomes = new Map<string, "ok" | "error">([["a.ts", "ok"]]);

describe("Plan Board completion from observed Verify (#459)", () => {
  it("marks only paths with observed successful file outcomes after one passing Verify", () => {
    const plan = [task(), task(["b.ts"]), task(["a.ts", "b.ts"]), task([])];
    expect(finalizePlanTasks(plan, touched, outcomes, pass)).toBe(true);
    expect(plan.map(task => task.state)).toEqual(["done", "pending", "pending", "pending"]);
  });

  it.each(["untested", "running", "fail", "timeout", "cancelled", "stale"] as const)("does not use a %s verdict, including a historical pass", state => {
    const plan = [task()];
    expect(finalizePlanTasks(plan, touched, outcomes, { ...pass, state })).toBe(false);
    expect(plan[0]!.state).toBe("pending");
  });

  it("requires execution facts, exit zero and a validated source", () => {
    for (const verify of [
      { ...pass, result: undefined }, { ...pass, source: undefined },
      { ...pass, result: { ...pass.result!, state: "fail" as const } },
      { ...pass, result: { ...pass.result!, exitCode: 1 } },
      { ...pass, result: { ...pass.result!, exitCode: null } },
    ]) expect(finalizePlanTasks([task()], touched, outcomes, verify)).toBe(false);
  });

  it("a command without successful file outcomes completes no tasks", () => {
    const plan = [task(), task(["b.ts"])];
    expect(finalizePlanTasks(plan, new Set(), new Map(), pass)).toBe(false);
    expect(finalizePlanTasks(plan, touched, new Map([["a.ts", "error"]]), pass)).toBe(false);
    expect(finalizePlanTasks(plan, new Set(), outcomes, pass)).toBe(false);
    expect(plan.every(task => task.state === "pending")).toBe(true);
  });

  it("does not accept model checkboxes or a claim that tests passed", async () => {
    const plan = await parsePlanTasks("Plan:\n- [x] Fix a.ts, tests passed\n- [X] Fix b.ts", null, path => path);
    expect(plan.map(task => task.state)).toEqual(["pending", "pending"]);
  });

  it("records completed worker paths, but waits for Verify and retains proof after worker closure", () => {
    const entry = task();
    entry.workerId = "term-2";
    expect(settleDispatchTask(entry, { id: "term-2", touched, toolOutcomes: outcomes }, "settled")).toBe("completed");
    expect(entry.state).toBe("pending");
    const saved = parseTerminalRoster({ terminals: [{ id: "term-1", type: "agent", plan: [entry] }] })[0]!.plan!;
    expect(saved[0]!.dispatchResult?.paths).toEqual(["a.ts"]);
    expect(finalizePlanTasks(saved, new Set(), new Map(), pass)).toBe(true);
    expect(saved[0]!.state).toBe("done");
  });

  it("does not turn missing or malformed recorded paths into completion evidence", () => {
    for (const paths of [undefined, "a.ts", ["a.ts", 1], ["a.ts", ""], ["a.ts\n"], Array(101).fill("a.ts"), ["a".repeat(257)]]) {
      const saved = parseTerminalRoster({ terminals: [{ id: "term-1", type: "agent", plan: [{
        ...task(), dispatchResult: { workerId: "term-2", outcome: "completed", paths },
      }] }] })[0]!.plan!;
      expect(saved[0]!.dispatchResult?.paths).toBeUndefined();
      expect(finalizePlanTasks(saved, new Set(), new Map(), pass)).toBe(false);
    }
  });

  it("does not reuse recorded paths for a changed task or an active worker", () => {
    const entry = task();
    settleDispatchTask(entry, { id: "term-2", touched, toolOutcomes: outcomes }, "settled");
    entry.paths = ["b.ts"];
    expect(finalizePlanTasks([entry], new Set(), new Map(), pass)).toBe(false);
    entry.paths = ["a.ts"];
    entry.workerId = "term-3";
    expect(finalizePlanTasks([entry], touched, outcomes, pass)).toBe(false);
  });

  it("keeps independent candidates out of primary completion and requires the correct worker", () => {
    const entry = { ...task(), candidate: { comparisonId: "cmp-1", label: "A" as const } };
    settleDispatchTask(entry, { id: "term-2", touched, toolOutcomes: outcomes }, "settled");
    expect(finalizePlanTasks([entry], touched, outcomes, pass)).toBe(false);
    expect(finalizePlanTasks([entry], touched, outcomes, pass, "term-3")).toBe(false);
    expect(finalizePlanTasks([entry], touched, outcomes, pass, "term-2")).toBe(true);
  });

  it("preserves an observed completion across plan replies only while its paths stay the same", () => {
    const previous = task();
    finalizePlanTasks([previous], touched, outcomes, pass);
    const same = task();
    const changed = { ...task(["b.ts"]), text: previous.text };
    reattachDispatchAssignments([same, changed], [], [previous]);
    expect(same.state).toBe("done");
    expect(changed.state).toBe("pending");
  });
});
