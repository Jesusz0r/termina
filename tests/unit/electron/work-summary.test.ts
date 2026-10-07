import { describe, expect, it } from "vitest";
import { projectWorkSummary, workOverview, type WorkSummaryTerminalFacts } from "../../../electron/main/work-summary.ts";
import type { DispatchOutcome, PlanTask, VerifyInfo } from "../../../shared/types.ts";

const project = { id: "proj-1", cwd: "/projects/same-name" };
function terminal(overrides: Partial<WorkSummaryTerminalFacts> = {}): WorkSummaryTerminalFacts {
  return {
    id: "term-1", generation: 3, type: "agent", model: "provider/model",
    activity: { state: "idle", reason: null },
    workspace: { id: "ws-1", root: project.cwd, primary: true },
    verify: { state: "untested", command: null, summary: null },
    trackedChanges: 0, plan: [], ...overrides,
  };
}
function task(outcome?: DispatchOutcome): PlanTask {
  return { text: "Fix hello.txt", paths: ["hello.txt"], state: "pending",
    ...(outcome ? { dispatchResult: { workerId: "term-2", outcome } } : {}) };
}

describe("global factual attention", () => {
  it("groups exact project identities and sorts by category without moving peers", () => {
    const summaries = [
      projectWorkSummary(project, [terminal({ verify: { state: "fail", command: "test", summary: "2 failures" },
        plan: [task("incomplete"), { ...task(), text: "Missing worker", workerId: "gone" }] })]),
      projectWorkSummary({ id: "proj-2", cwd: "/other/same-name" }, [terminal({ id: "term-3", generation: 8,
        activity: { state: "blocked", reason: "lease-wait" }, trackedChanges: 2 })]),
      projectWorkSummary({ id: "empty", cwd: "/empty" }, []),
    ];
    const overview = workOverview(summaries);
    expect(overview.projects).toEqual([
      { projectId: "proj-1", name: "same-name", root: project.cwd, working: 0, attentionCount: 3 },
      { projectId: "proj-2", name: "same-name", root: "/other/same-name", working: 0, attentionCount: 1 },
      { projectId: "empty", name: "empty", root: "/empty", working: 0, attentionCount: 0 },
    ]);
    expect(overview.items.map((item) => item.reason)).toEqual(["worker-unavailable", "blocked", "task-incomplete", "verify-failed"]);
    expect(overview.items[0]).toMatchObject({ projectId: project.id, terminalId: "term-1", generation: 3,
      model: "provider/model", taskText: "Missing worker", detail: "Assigned worker gone is unavailable.",
      action: { kind: "plan", terminalId: "term-1", generation: 3 } });
    expect(overview.items[1]).toMatchObject({ projectId: "proj-2", detail: "lease-wait", taskText: null });
    expect(overview.items[3]!.detail).toBe("test: 2 failures");
    expect(workOverview(summaries)).toEqual(overview);
    expect(summaries[0]!.terminals[0]!.tasks[0]!.task.dispatchResult?.outcome).toBe("incomplete");
  });

  it("uses only canonical attention and working truth, not tracked paths, shell state or notification flags", () => {
    const summaries = [projectWorkSummary(project, [
      terminal({ trackedChanges: 5 }),
      terminal({ id: "worker", activity: { state: "working", reason: null } }),
      terminal({ id: "shell", type: "shell", activity: { state: "blocked", reason: "stalled" }, verify: { state: "fail", command: "test", summary: "bad" } }),
    ])];
    expect(workOverview(summaries)).toEqual({ projects: [{ projectId: project.id, name: "same-name", root: project.cwd, working: 1, attentionCount: 0 }], items: [] });
  });

  it("scopes deterministic opaque IDs to project, generation, source, task index/text and reason", () => {
    const input = terminal({ plan: [task("failed"), task("failed")] });
    const items = (p = project, facts = input) => workOverview([projectWorkSummary(p, [facts])]).items;
    const original = items();
    expect(original[0]!.id).toMatch(/^work-[a-f0-9]{64}$/);
    expect(original[0]!.id).not.toBe(original[1]!.id);
    for (const changed of [
      items({ ...project, id: "another" }), items({ ...project, cwd: "/moved" }),
      items(project, { ...input, generation: 4 }),
      items(project, { ...input, workspace: { id: "ws-2", root: project.cwd, primary: true } }),
      items(project, { ...input, workspace: { id: "ws-1", root: "/moved", primary: true } }),
      items(project, { ...input, plan: [{ ...task("failed"), text: "Changed task" }] }),
      items(project, { ...input, plan: [task("interrupted")] }),
    ]) expect(changed[0]!.id).not.toBe(original[0]!.id);
  });

  it("attributes live worker attention to a single canonical task, never guesses among multiple assignments", () => {
    const worker = terminal({ id: "worker", generation: 9, activity: { state: "blocked", reason: "stalled" },
      verify: { state: "fail", command: "test", summary: "failed" } });
    const assigned = { ...task(), workerId: worker.id, state: "active" as const };
    const owner = terminal({ plan: [assigned] });
    const single = workOverview([projectWorkSummary(project, [owner, worker])]);
    expect(single.items.map((item) => item.taskText)).toEqual([assigned.text, assigned.text]);
    const ambiguous = workOverview([projectWorkSummary(project, [{ ...owner, plan: [assigned, { ...assigned, text: "Another task" }] }, worker])]);
    expect(ambiguous.items.map((item) => item.taskText)).toEqual([null, null]);
    const foreignSource = workOverview([projectWorkSummary(project, [owner, { ...worker, workspace: { id: "candidate", root: "/candidate", primary: false } }])]);
    expect(foreignSource.items.filter((item) => item.terminalId === worker.id).every((item) => item.taskText === null)).toBe(true);
    expect(single.items[0]!.id).not.toBe(ambiguous.items[0]!.id);
  });

  it("keeps issues visible on repeated reads and includes recorded stale evidence without output", () => {
    const summary = projectWorkSummary(project, [terminal({ verify: { state: "stale", command: "test", summary: "previous pass", staleReason: "source changed" } })]);
    const first = workOverview([summary]);
    expect(first.items[0]!.detail).toContain("source changed");
    expect(first.items[0]!.action.kind).toBe("evidence");
    expect(workOverview([summary])).toEqual(first);
    expect(first.items[0]).not.toHaveProperty("verifyOutput");
    expect(first.items[0]).not.toHaveProperty("trackedChanges");
  });
});

describe("factual project/task summary", () => {
  it("keeps exact project identity, owner, task text and model without inventing completion from idle", () => {
    const input = terminal({ plan: [task()] });
    const summary = projectWorkSummary(project, [input]);
    expect(summary).toMatchObject({ projectId: "proj-1", name: "same-name", root: project.cwd });
    expect(summary.terminals[0]).toMatchObject({ terminalId: "term-1", generation: 3, model: "provider/model",
      activity: { state: "idle" }, tasks: [{ task: { text: "Fix hello.txt", state: "pending" }, worker: null, attention: [] }] });
    expect(input.plan[0]!.state).toBe("pending");
  });

  it.each(["incomplete", "failed", "interrupted"] as const)("retains %s after the worker is gone and points to the owner's plan", (outcome) => {
    const summary = projectWorkSummary(project, [terminal({ plan: [task(outcome)] })]).terminals[0]!;
    expect(summary.tasks[0]).toMatchObject({ task: { dispatchResult: { workerId: "term-2", outcome } },
      worker: null, attention: [`task-${outcome}`], nextAction: { kind: "plan", terminalId: "term-1", generation: 3 } });
    expect(summary.nextAction.kind).toBe("plan");
  });

  it("separates a live retry from the previous incomplete attempt", () => {
    const retry = { ...task("incomplete"), state: "active" as const, workerId: "term-3" };
    const summary = projectWorkSummary(project, [terminal({ plan: [retry] }), terminal({ id: "term-3", generation: 6, activity: { state: "working", reason: null } })]);
    expect(summary.terminals[0]!.tasks[0]).toMatchObject({ worker: { terminalId: "term-3", generation: 6 },
      attention: [], task: { dispatchResult: { outcome: "incomplete" } }, nextAction: { kind: "terminal", terminalId: "term-3", generation: 6 } });
  });

  it("does not attribute a same-id assignment in a different source area", () => {
    const assigned = { ...task(), workerId: "term-2", state: "active" as const };
    const summary = projectWorkSummary(project, [terminal({ plan: [assigned] }), terminal({ id: "term-2", workspace: { id: "ws-2", root: "/candidate", primary: false } })]);
    expect(summary.terminals[0]!.tasks[0]).toMatchObject({ worker: null, attention: ["worker-unavailable"] });
  });

  it("cannot certify assignment without a workspace", () => {
    const summary = projectWorkSummary(project, [terminal({ workspace: null, plan: [{ ...task(), workerId: "term-2" }] }), terminal({ id: "term-2", workspace: null })]);
    expect(summary.terminals[0]!.tasks[0]!.worker).toBeNull();
    expect(summary.terminals[0]!.workArea).toBeNull();
  });

  it("retains an explicitly completed result separately from checks and review", () => {
    const summary = projectWorkSummary(project, [terminal({ plan: [{ ...task("completed"), state: "done" }], trackedChanges: 2 })]).terminals[0]!;
    expect(summary.tasks[0]!.task.dispatchResult?.outcome).toBe("completed");
    expect(summary.verify?.state).toBe("untested");
    expect(summary.trackedChanges).toBe(2);
    expect(summary.attention).toEqual([]);
    expect(summary.nextAction.kind).toBe("changes");
    expect(summary).not.toHaveProperty("reviewed");
    expect(summary).not.toHaveProperty("accepted");
  });

  it("preserves stale historical passing evidence without a fresh readiness signal", () => {
    const verify: VerifyInfo = { state: "stale", command: "npm run test", summary: "outdated", staleReason: "Source changed",
      source: { workspaceId: "ws-1", root: project.cwd, tree: "a".repeat(40), generation: 1, revision: 2, observationEpoch: 3 },
      result: { state: "pass", exitCode: 0, startedAt: 10, finishedAt: 20 } };
    const summary = projectWorkSummary(project, [terminal({ verify })]).terminals[0]!;
    expect(summary.verify).toEqual(verify);
    expect(summary.attention).toEqual(["verify-stale"]);
    expect(summary.nextAction.kind).toBe("evidence");
  });

  it.each(["fail", "timeout", "cancelled"] as const)("keeps %s attention independent of unseen notifications", (state) => {
    const input = { ...terminal({ verify: { state, command: "test", summary: state } }), verifyAttention: false };
    const summary = projectWorkSummary(project, [input]).terminals[0]!;
    expect(summary.attention).toEqual([state === "fail" ? "verify-failed" : `verify-${state}`]);
    expect(summary).not.toHaveProperty("verifyAttention");
  });

  it("does not conflate blocked execution, evidence and tracked review paths", () => {
    const summary = projectWorkSummary(project, [terminal({ activity: { state: "blocked", reason: "lease-wait" }, trackedChanges: 4,
      verify: { state: "pass", command: "test", summary: "green" } })]).terminals[0]!;
    expect(summary.attention).toEqual(["blocked"]);
    expect(summary.activity?.reason).toBe("lease-wait");
    expect(summary.verify?.state).toBe("pass");
    expect(summary.nextAction.kind).toBe("terminal");
  });

  it("describes the assigned candidate root and unknown shell execution truthfully", () => {
    const summary = projectWorkSummary(project, [terminal({ type: "shell", workspace: { id: "ws-2", root: "/worlds/reference", primary: false, comparisonId: "cmp-1" } })]).terminals[0]!;
    expect(summary.workArea).toEqual({ workspaceId: "ws-2", root: "/worlds/reference", kind: "candidate", comparisonId: "cmp-1" });
    expect(summary.activity).toBeNull();
    expect(summary.verify).toBeNull();
    expect(summary.model).toBeNull();
  });

  it("projects no heavy terminal buffers, diffs or per-file review lists", () => {
    const input = { ...terminal(), buffer: "huge", modified: [{ path: "/secret" }], verifyOutput: "output" };
    const summary = projectWorkSummary(project, [input]).terminals[0]!;
    expect(summary).not.toHaveProperty("buffer");
    expect(summary).not.toHaveProperty("modified");
    expect(summary).not.toHaveProperty("verifyOutput");
  });
});
