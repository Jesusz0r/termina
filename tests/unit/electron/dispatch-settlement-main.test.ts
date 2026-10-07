import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { findTaskByText, settleDispatchTask } from "../../../electron/plan-board.ts";
import type { DispatchOutcome, PlanTask } from "../../../shared/types.ts";

// Execute the actual sidecar settlement branch, not a second outcome mapper.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let settlement: ts.CaseClause | undefined;
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === "handleSidecarEvent") {
    const find = (child: ts.Node): void => {
      if (ts.isCaseClause(child) && child.expression.getText(source) === '"agent_settled"') settlement = child;
      ts.forEachChild(child, find);
    };
    find(node);
  } else ts.forEachChild(node, visit);
}
visit(source);
if (!settlement) throw new Error("Missing canonical sidecar settlement");
const compiled = ts.transpile(`return function (inst, event, rendererTarget) {
  switch (event.t) { ${settlement.getText(source)} }
};`, { target: ts.ScriptTarget.ES2022 });
const settle = new Function("findTaskByText", "settleDispatchTask", compiled)(findTaskByText, settleDispatchTask) as (
  this: Record<string, unknown>, inst: Record<string, unknown>, event: { t: string; error: string | null }, target: null,
) => void;

function fixture(interrupted: boolean, touched: boolean) {
  const task: PlanTask = { text: "Edit hello.txt", paths: ["hello.txt"], state: "active", workerId: "term-2", claimed: ["hello.txt"] };
  const owner = { id: "term-1", plan: [task] };
  const worker = {
    id: "term-2", generation: 2, busy: true, type: "agent", currentRun: null,
    interruptedAt: interrupted ? 42 : undefined, modified: new Map(),
    touched: new Set(touched ? ["hello.txt"] : []),
    toolOutcomes: new Map(touched ? [["hello.txt", "ok"]] : []),
  };
  const main = {
    runtime: new Map([[owner.id, owner]]), busyAgents: new Set([worker.id]),
    sourceAdmissions: { finish: vi.fn() },
    dispatchRuns: new Map([[worker.id, { ownerId: owner.id, taskText: task.text }]]),
    finalizePlan: vi.fn(), writeDispatchSettleNote: vi.fn(), savePlanRoster: vi.fn(),
    sendPlan: vi.fn(), collectWorker: vi.fn(), maybeAutoVerify: vi.fn(), send: vi.fn(), sendInstances: vi.fn(),
  };
  return { task, owner, worker, main };
}

describe("main dispatch settlement classification", () => {
  it.each([
    { error: "invalid API key", reason: "run failed: invalid API key" },
    { error: "disk full", reason: "run failed: disk full" },
    { error: "interrupted", reason: "run interrupted" },
  ])("attributes $error to the run instead of inventing a session storage failure", ({ error, reason }) => {
    const { worker, main } = fixture(false, false);
    const run = { replayable: true, reason: null, settledAt: null };
    const active = { ...worker, currentRun: run };
    settle.call(main, active, { t: "agent_settled", error }, null);
    expect(run.reason).toBe(reason);
    expect(run.replayable).toBe(false);
    expect(run.settledAt).toEqual(expect.any(Number));
    expect(active.currentRun).toBeNull();
  });

  it.each<{ error: string | null; interrupted: boolean; touched: boolean; expected: DispatchOutcome }>([
    { error: "interrupted", interrupted: true, touched: false, expected: "interrupted" },
    { error: "interrupted", interrupted: false, touched: true, expected: "interrupted" },
    { error: null, interrupted: true, touched: true, expected: "interrupted" },
    { error: "invalid API key", interrupted: false, touched: false, expected: "failed" },
    { error: "disk full", interrupted: true, touched: true, expected: "failed" },
    { error: null, interrupted: false, touched: false, expected: "incomplete" },
    { error: null, interrupted: false, touched: true, expected: "completed" },
  ])("retains $expected for error=$error, explicit interruption=$interrupted", ({ error, interrupted, touched, expected }) => {
    const { task, worker, main } = fixture(interrupted, touched);
    settle.call(main, worker, { t: "agent_settled", error }, null);
    expect(task.dispatchResult).toEqual({ workerId: worker.id, outcome: expected });
    expect(task.state).toBe(expected === "completed" ? "done" : "pending");
    expect(task.workerId).toBeUndefined();
    expect(task.claimed).toBeUndefined();
    expect(main.dispatchRuns.has(worker.id)).toBe(false);
    expect(main.sourceAdmissions.finish).toHaveBeenCalledWith(worker.id, worker.generation);
    expect(main.maybeAutoVerify).toHaveBeenCalledWith(expect.anything(), expected === "completed" ? task.text : null);
  });
});
