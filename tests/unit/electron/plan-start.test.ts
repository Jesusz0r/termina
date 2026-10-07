import { describe, expect, it } from "vitest";
import { planCreationError, planOwnerError, planStartError, samePlanTaskSnapshot } from "../../../electron/plan-board.ts";
import { parsePlanTaskStartRequest } from "../../../electron/main/ipc-validate.ts";
import { projectWorkSummary } from "../../../electron/main/work-summary.ts";
import type { PlanTask, PlanTaskStartRequest } from "../../../shared/types.ts";

const eligible = { available: true, primary: true, persistent: true, agent: true, dispatchWorker: false, busy: false };
const owner = { projectId: "background", workspaceId: "primary", terminalId: "term-1", generation: 2, root: "/actual/root" };
const task: PlanTask = { text: "Fix file.ts", paths: ["file.ts"], state: "pending", model: "provider/model" };
const request: PlanTaskStartRequest = { owner, projectRoot: "/displayed/root", task };

describe("explicit task Start admission and snapshot validation", () => {
  it("copies owner and every task field without retaining mutable renderer input", () => {
    const value = { ...request, task: { ...task, workerId: "term-2", claimed: ["file.ts"],
      dispatchResult: { workerId: "old", outcome: "failed" as const } } };
    const parsed = parsePlanTaskStartRequest(value)!;
    expect(parsed).toEqual(value);
    expect(parsed.owner).not.toBe(value.owner);
    expect(parsed.task).not.toBe(value.task);
    expect(parsed.task.paths).not.toBe(value.task.paths);
    expect(parsed.task.claimed).not.toBe(value.task.claimed);
    expect(parsed.task.dispatchResult).not.toBe(value.task.dispatchResult);
  });

  it.each([null, {}, { ...request, owner: null }, { ...request, projectRoot: "" },
    { ...request, owner: { ...owner, generation: 0 } }, { ...request, task: null },
    { ...request, task: { ...task, text: "" } }, { ...request, task: { ...task, paths: "file.ts" } },
    { ...request, task: { ...task, paths: [false] } }, { ...request, task: { ...task, paths: Array(6).fill("file.ts") } },
    { ...request, task: { ...task, state: "reviewed" } }, { ...request, task: { ...task, model: 3 } },
    { ...request, task: { ...task, workerId: {} } }, { ...request, task: { ...task, claimed: false } },
    { ...request, task: { ...task, dispatchResult: {} } },
    { ...request, task: { ...task, dispatchResult: { workerId: "old", outcome: "accepted" } } },
  ])("rejects malformed snapshot %j", (value) => expect(parsePlanTaskStartRequest(value)).toBeNull());

  it("requires exactly one initial pending row, not a historical attempt or active assignment", () => {
    expect(planStartError(null, [task], task)).toBeNull();
    expect(planStartError(null, [], task)).toEqual(expect.any(String));
    expect(planStartError(null, [task, structuredClone(task)], task)).toEqual(expect.any(String));
    for (const changed of [
      { ...task, state: "active" as const }, { ...task, state: "done" as const },
      { ...task, workerId: "worker" }, { ...task, dispatchResult: { workerId: "old", outcome: "incomplete" as const } },
    ]) expect(planStartError(null, [changed], changed)).toEqual(expect.any(String));
    expect(planStartError("busy", [task], task)).toBe("busy");
  });

  it("does not reuse task creation capacity to deny Start on a full board", () => {
    const plan = [task, ...Array.from({ length: 19 }, (_, i): PlanTask => ({ text: `Task ${i}`, paths: [], state: "pending" }))];
    expect(planCreationError({ ...eligible, taskCount: 20 })).toContain("full");
    expect(planStartError(planOwnerError(eligible), plan, task)).toBeNull();
    for (const changes of [{ available: false }, { primary: false }, { persistent: false }, { agent: false },
      { dispatchWorker: true }, { busy: true }]) {
      expect(planStartError(planOwnerError({ ...eligible, ...changes }), plan, task)).toEqual(expect.any(String));
    }
  });

  it("compares task execution snapshot including model, paths, claims, state, assignment and outcome", () => {
    expect(samePlanTaskSnapshot(task, structuredClone(task))).toBe(true);
    for (const changes of [{ text: "Other" }, { paths: ["other.ts"] }, { model: "provider/other" },
      { state: "active" as const }, { workerId: "term-2" }, { claimed: [] },
      { dispatchResult: { workerId: "old", outcome: "failed" as const } }]) {
      expect(samePlanTaskSnapshot(task, { ...task, ...changes })).toBe(false);
    }
  });

  it("projects the same canonical task Start eligibility, independently of capacity and attention", () => {
    const retry: PlanTask = { ...task, text: "Retry other.ts", dispatchResult: { workerId: "old", outcome: "failed" } };
    const facts = { id: owner.terminalId, generation: owner.generation, type: "agent" as const, model: null,
      activity: { state: "idle" as const, reason: null }, workspace: { id: owner.workspaceId, root: owner.root, primary: true },
      verify: { state: "untested" as const, command: null, summary: null }, trackedChanges: 0, plan: [task, retry],
      planCreationError: "The Plan Board is full (20 tasks).", planStartOwnerError: null };
    const projected = projectWorkSummary({ id: owner.projectId, cwd: request.projectRoot }, [facts]).terminals[0]!;
    expect(projected.tasks[0]!.startError).toBeNull();
    expect(projected.tasks[1]!.startError).toBe(planStartError(null, facts.plan, retry));
    expect(projected.tasks[1]!.nextAction.kind).toBe("plan");
    expect(projected.tasks[1]!.attention).toEqual(["task-failed"]);
    const busy = projectWorkSummary({ id: owner.projectId, cwd: request.projectRoot }, [{ ...facts, planStartOwnerError: "busy" }]);
    expect(busy.terminals[0]!.tasks.every((row) => row.startError === "busy")).toBe(true);
  });
});
