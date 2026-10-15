import { describe, expect, it } from "vitest";
import { projectWorkSummary, workOverview, type WorkSummaryTerminalFacts } from "../../../electron/main/work-summary.ts";
import type { DispatchOutcome, PlanTask, VerifyInfo, WorldlineSummary } from "../../../shared/types.ts";

const project = { id: "proj-1", cwd: "/projects/same-name" };
function terminal(overrides: Partial<WorkSummaryTerminalFacts> = {}): WorkSummaryTerminalFacts {
  return {
    id: "term-1", generation: 3, type: "agent", model: "provider/model",
    activity: overrides.type === "shell" ? null : { state: "idle", reason: null, intervention: null },
    workspace: { id: "ws-1", root: project.cwd, primary: true },
    verify: { state: "untested", command: null, summary: null },
    trackedChanges: 0, plan: [], dispatchAssignment: null, ...overrides,
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
        activity: { state: "blocked", reason: "lease-wait", intervention: null }, trackedChanges: 2 })]),
      projectWorkSummary({ id: "empty", cwd: "/empty" }, []),
    ];
    const overview = workOverview(summaries);
    expect(overview.projects).toEqual([
      { ...summaries[0], working: 0, attentionCount: 3 },
      { ...summaries[1], working: 0, attentionCount: 1 },
      { ...summaries[2], working: 0, attentionCount: 0 },
    ]);
    expect(overview.items.map((item) => item.reason)).toEqual(["worker-unavailable", "blocked", "task-incomplete", "verify-failed"]);
    expect(overview.items[0]).toMatchObject({ projectId: project.id, terminalId: "term-1", generation: 3,
      model: "provider/model", taskText: "Missing worker", detail: "Assigned worker gone is unavailable.",
      action: { kind: "plan", terminalId: "term-1", generation: 3, taskText: "Missing worker" } });
    expect(overview.items[1]).toMatchObject({ projectId: "proj-2", detail: "lease-wait", taskText: null });
    expect(overview.items[3]!.detail).toBe("test: 2 failures");
    expect(workOverview(summaries)).toEqual(overview);
    expect(summaries[0]!.terminals[0]!.tasks[0]!.task.dispatchResult?.outcome).toBe("incomplete");
  });

  it("uses only canonical attention and working truth, not tracked paths, shell state or notification flags", () => {
    const summaries = [projectWorkSummary(project, [
      terminal({ trackedChanges: 5 }),
      terminal({ id: "worker", activity: { state: "working", reason: null, intervention: null } }),
      terminal({ id: "shell", type: "shell", verify: { state: "fail", command: "test", summary: "bad" } }),
    ])];
    expect(workOverview(summaries)).toEqual({ projects: [{ ...summaries[0], working: 1, attentionCount: 0 }], items: [] });
  });

  it("retains observed external CLI activity without granting core-only capabilities", () => {
    const activity = { state: "working", reason: null, intervention: null } as const;
    const shell = terminal({ type: "shell", activity });
    const summary = projectWorkSummary(project, [shell]);
    expect(summary.terminals[0]).toMatchObject({ activity, verify: null, model: null });
    expect(workOverview([summary]).projects[0]!.working).toBe(1);

    const intervention = { requestId: "claude:Bash", kind: "permission", since: 123 } as const;
    shell.activity = { state: "blocked", reason: "permission-required", intervention };
    const waiting = workOverview([projectWorkSummary(project, [shell])]);
    expect(waiting.projects[0]).toMatchObject({ working: 0, attentionCount: 1 });
    expect(waiting.items[0]).toMatchObject({ terminalId: shell.id, reason: "blocked",
      detail: "permission-required", action: { kind: "terminal", terminalId: shell.id, generation: shell.generation } });
    expect(waiting.projects[0]!.terminals[0]!.activity?.intervention).toEqual(intervention);

    shell.activity = { state: "idle", reason: "outcome-unknown", intervention: null };
    const stopped = workOverview([projectWorkSummary(project, [shell])]);
    expect(stopped.projects[0]).toMatchObject({ working: 0, attentionCount: 0 });
    expect(stopped.items).toEqual([]);
    expect(stopped.projects[0]!.terminals[0]!.activity?.reason).toBe("outcome-unknown");
  });

  it("retains pending tasks and completed results with canonical shell and candidate attribution", () => {
    const pending = task();
    const done = { ...task("completed"), text: "Finished task", state: "done" as const };
    const summary = projectWorkSummary(project, [
      terminal({ plan: [pending, done] }),
      terminal({ id: "candidate", workspace: { id: "ws-candidate", root: "/worlds/candidate", primary: false, comparisonId: "cmp-1" } }),
      terminal({ id: "shell", type: "shell" }),
    ]);
    const before = structuredClone(summary);
    const overview = workOverview([summary]);
    expect(overview.projects).toEqual([{ ...summary, working: 0, attentionCount: 1 }]);
    expect(overview.items).toEqual([expect.objectContaining({ reason: "pending-review", taskText: done.text,
      action: { kind: "plan", terminalId: "term-1", generation: 3, taskText: done.text } })]);
    expect(overview.projects[0]!.terminals).toBe(summary.terminals);
    expect(overview.projects[0]!.terminals[0]!.tasks.map(({ task }) => task)).toEqual([pending, done]);
    expect(overview.projects[0]!.terminals[1]!.workArea).toEqual({ workspaceId: "ws-candidate", root: "/worlds/candidate", kind: "candidate", comparisonId: "cmp-1" });
    expect(overview.projects[0]!.terminals[2]).toMatchObject({ type: "shell", activity: null, verify: null, model: null });
    expect(workOverview([summary])).toEqual(overview);
    expect(summary).toEqual(before);
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
    const worker = terminal({ id: "worker", generation: 9, activity: { state: "blocked", reason: "stalled", intervention: null },
      verify: { state: "fail", command: "test", summary: "failed" },
      dispatchAssignment: { ownerId: "term-1", taskText: task().text } });
    const assigned = { ...task(), workerId: worker.id, state: "active" as const };
    const owner = terminal({ plan: [assigned] });
    const single = workOverview([projectWorkSummary(project, [owner, worker])]);
    expect(single.items.map((item) => item.taskText)).toEqual([assigned.text, assigned.text]);
    const ambiguous = workOverview([projectWorkSummary(project, [{ ...owner, plan: [assigned, { ...assigned }] }, worker])]);
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
  function candidate(overrides: Partial<WorldlineSummary> = {}): WorldlineSummary {
    return { id: "cmp-1-A", comparisonId: "cmp-1", label: "A", role: "session", root: "/worlds/cmp-1/A",
      comparisonBaseStateId: null, promotionBaseStateId: null, headStateId: null, sourceRunId: null,
      terminalId: "term-2", version: 2, state: "running", error: null, sessionFile: null,
      model: "provider/model", thinkingLevel: null, createdAt: 1, ...overrides };
  }

  it("certifies an independent worker using dispatch provenance and the canonical candidate root", () => {
    const area = candidate();
    const assigned: PlanTask = { ...task(), state: "active", workerId: "term-2", candidate: { comparisonId: area.comparisonId, label: area.label } };
    const owner = terminal({ plan: [assigned] });
    const worker = terminal({ id: "term-2", generation: 9, activity: { state: "blocked", reason: "stalled", intervention: null },
      workspace: { id: "ws-candidate", root: area.root, primary: false, comparisonId: area.comparisonId },
      dispatchAssignment: { ownerId: owner.id, taskText: assigned.text } });
    const summary = projectWorkSummary(project, [owner, worker], [], [area]);
    expect(summary.terminals[0]!.tasks[0]).toMatchObject({ worker: { terminalId: worker.id, generation: 9 },
      candidate: { comparisonId: area.comparisonId, label: "A", root: area.root, version: 2, state: "running" },
      attention: [], nextAction: { kind: "terminal", terminalId: worker.id, generation: 9 } });
    expect(workOverview([summary]).items[0]).toMatchObject({ taskText: assigned.text, workArea: { root: area.root, kind: "candidate" } });
    for (const changed of [
      { ...worker, dispatchAssignment: null },
      { ...worker, dispatchAssignment: { ownerId: "other", taskText: assigned.text } },
      { ...worker, dispatchAssignment: { ownerId: owner.id, taskText: "Different task" } },
      { ...worker, workspace: { ...worker.workspace!, root: "/worlds/other" } },
      { ...worker, workspace: { ...worker.workspace!, comparisonId: "cmp-2" } },
    ]) expect(projectWorkSummary(project, [owner, changed], [], [area]).terminals[0]!.tasks[0])
      .toMatchObject({ worker: null, attention: ["worker-unavailable"] });
    expect(projectWorkSummary(project, [owner, worker], [], []).terminals[0]!.tasks[0])
      .toMatchObject({ worker: null, candidate: null, attention: ["worker-unavailable"] });
  });

  it("retains the canonical independent result area after closing the worker without borrowing source evidence", () => {
    const area = candidate({ terminalId: null, state: "settled", headStateId: "captured-result" });
    const result: PlanTask = { ...task("completed"), state: "done", candidate: { comparisonId: area.comparisonId, label: area.label } };
    const owner = terminal({ plan: [result], verify: { state: "pass", command: "source check", summary: "source passed" } });
    const row = projectWorkSummary(project, [owner], [], [area]).terminals[0]!.tasks[0]!;
    expect(row).toMatchObject({ task: result, worker: null,
      candidate: { comparisonId: "cmp-1", label: "A", root: area.root, version: 2, state: "settled", error: null },
      nextAction: { kind: "plan", terminalId: owner.id }, attention: ["pending-review"] });
    expect(row.candidate).not.toHaveProperty("sessionFile");
    expect(row.candidate).not.toHaveProperty("evidence");
    expect(row).not.toHaveProperty("verify");
    expect(projectWorkSummary(project, [owner], [], []).terminals[0]!.tasks[0])
      .toMatchObject({ task: result, worker: null, candidate: null });
  });

  it("refuses same-source worker ids without matching dispatcher ownership", () => {
    const assigned = { ...task(), workerId: "term-2", state: "active" as const };
    const owner = terminal({ plan: [assigned] });
    const worker = terminal({ id: "term-2", dispatchAssignment: { ownerId: "someone-else", taskText: assigned.text } });
    expect(projectWorkSummary(project, [owner, worker]).terminals[0]!.tasks[0])
      .toMatchObject({ worker: null, candidate: null, attention: ["worker-unavailable"] });
  });

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
      worker: null, attention: [`task-${outcome}`], nextAction: { kind: "plan", terminalId: "term-1", generation: 3, taskText: "Fix hello.txt" } });
    expect(summary.tasks[0]!.nextAction.kind).toBe("plan");
  });

  it("separates a live retry from the previous incomplete attempt", () => {
    const retry = { ...task("incomplete"), state: "active" as const, workerId: "term-3" };
    const summary = projectWorkSummary(project, [terminal({ plan: [retry] }), terminal({ id: "term-3", generation: 6, activity: { state: "working", reason: null, intervention: null },
      dispatchAssignment: { ownerId: "term-1", taskText: retry.text } })]);
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
    expect(summary.tasks[0]!.attention).toEqual(["pending-review"]);
    expect(summary.tasks[0]!.nextAction.kind).toBe("plan");
    expect(summary).not.toHaveProperty("reviewed");
    expect(summary).not.toHaveProperty("accepted");
  });

  it("preserves stale historical passing evidence without a fresh readiness signal", () => {
    const verify: VerifyInfo = { state: "stale", command: "npm run test", summary: "outdated", staleReason: "Source changed",
      source: { workspaceId: "ws-1", root: project.cwd, tree: "a".repeat(40), generation: 1, revision: 2, observationEpoch: 3 },
      result: { state: "pass", exitCode: 0, startedAt: 10, finishedAt: 20 } };
    const summary = projectWorkSummary(project, [terminal({ verify })]);
    const owner = summary.terminals[0]!;
    expect(owner.verify).toEqual(verify);
    expect(owner.attention).toEqual(["verify-stale"]);
    expect(workOverview([summary]).items[0]?.action)
      .toEqual({ kind: "evidence", terminalId: owner.terminalId, generation: owner.generation });
  });

  it.each(["fail", "timeout", "cancelled"] as const)("keeps %s attention independent of unseen notifications", (state) => {
    const input = { ...terminal({ verify: { state, command: "test", summary: state } }), verifyAttention: false };
    const summary = projectWorkSummary(project, [input]).terminals[0]!;
    expect(summary.attention).toEqual([state === "fail" ? "verify-failed" : `verify-${state}`]);
    expect(summary).not.toHaveProperty("verifyAttention");
  });

  it("does not conflate blocked execution, evidence and tracked review paths", () => {
    const summary = projectWorkSummary(project, [terminal({ activity: { state: "blocked", reason: "lease-wait", intervention: null }, trackedChanges: 4,
      verify: { state: "pass", command: "test", summary: "green" } })]);
    const owner = summary.terminals[0]!;
    expect(owner.attention).toEqual(["blocked"]);
    expect(owner.activity?.reason).toBe("lease-wait");
    expect(owner.verify?.state).toBe("pass");
    expect(workOverview([summary]).items[0]?.action)
      .toEqual({ kind: "terminal", terminalId: owner.terminalId, generation: owner.generation });
  });

  it("describes the assigned candidate root and unknown shell execution truthfully", () => {
    const summary = projectWorkSummary(project, [terminal({ type: "shell", workspace: { id: "ws-2", root: "/worlds/reference", primary: false, comparisonId: "cmp-1" } })]).terminals[0]!;
    expect(summary.workArea).toEqual({ workspaceId: "ws-2", root: "/worlds/reference", kind: "candidate", comparisonId: "cmp-1" });
    expect(summary.activity).toBeNull();
    expect(summary.verify).toBeNull();
    expect(summary.model).toBeNull();
  });

  it.each(["ready", "settled", "verifying", "conflict"] as const)("keeps a captured %s result pending review independently of the source's checks", (state) => {
    const area = candidate({ terminalId: state === "ready" ? "term-2" : null, state, headStateId: "captured-result" });
    const result: PlanTask = { ...task("completed"), state: "done", model: "result/model",
      candidate: { comparisonId: area.comparisonId, label: area.label } };
    const owner = terminal({ plan: [result], verify: { state: "fail", command: "source check", summary: "source failed" } });
    const before = structuredClone({ owner, area });
    const summaries = [projectWorkSummary(project, [owner], [], [area])];
    const overview = workOverview(summaries);
    expect(overview.items.map(({ reason }) => reason)).toEqual(["verify-failed", "pending-review"]);
    expect(overview.projects[0]!.attentionCount).toBe(2);
    expect(overview.items[1]).toMatchObject({ projectId: project.id, terminalId: owner.id, generation: 3,
      taskText: result.text, model: "result/model", workArea: { root: project.cwd, kind: "project" },
      candidate: { ...result.candidate, root: area.root, version: 2, headStateId: area.headStateId, state },
      action: { kind: "plan", terminalId: owner.id, generation: 3 } });
    expect(overview.items[1]!.detail).toContain("Human review is not recorded");
    expect(overview.items[1]!.detail).toContain("not applied");
    expect(JSON.stringify(overview.items[1])).not.toContain("source failed");
    expect(workOverview(summaries)).toEqual(overview);
    expect({ owner, area }).toEqual(before);
  });

  it.each(["creating", "running", "promoting", "cancelled", "error", "discarding", "discarded", "promoted"] as const)("does not call a %s candidate pending review", (state) => {
    const area = candidate({ state, headStateId: "captured-result" });
    const result: PlanTask = { ...task("completed"), state: "done", candidate: { comparisonId: area.comparisonId, label: area.label } };
    expect(workOverview([projectWorkSummary(project, [terminal({ plan: [result] })], [], [area])]).items).toEqual([]);
  });

  it("does not infer completion from a ready candidate's initial capture", () => {
    const area = candidate({ state: "ready", headStateId: "initial-capture" });
    for (const planTask of [task(), task("incomplete"), task("failed"), { ...task("completed"), state: "active" as const }]) {
      const result = { ...planTask, candidate: { comparisonId: area.comparisonId, label: area.label } };
      expect(workOverview([projectWorkSummary(project, [terminal({ plan: [result] })], [], [area])]).items
        .some(({ reason }) => reason === "pending-review")).toBe(false);
    }
  });

  it("requires an available captured candidate result instead of falling back to source evidence", () => {
    const area = candidate({ state: "settled", headStateId: null });
    const result: PlanTask = { ...task("completed"), state: "done", candidate: { comparisonId: area.comparisonId, label: area.label } };
    const owner = terminal({ plan: [result], trackedChanges: 4, verify: { state: "pass", command: "source check", summary: "source passed" } });
    for (const areas of [[], [area], [{ ...area, comparisonId: "different" }], [{ ...area, label: "B" as const }]]) {
      expect(workOverview([projectWorkSummary(project, [owner], [], areas)]).items).toEqual([]);
    }
  });

  it("does not infer review from idle, task marks, passing checks, tracked paths or an active attempt", () => {
    const inputs = [
      terminal({ plan: [{ ...task(), state: "done" }], trackedChanges: 4, verify: { state: "pass", command: "test", summary: "green" } }),
      terminal({ plan: [{ ...task("completed"), state: "active", workerId: "missing" }] }),
      terminal({ plan: [{ ...task("completed"), state: "active" }] }),
      terminal({ type: "shell", plan: [{ ...task("completed"), state: "done" }] }),
      terminal({ workspace: null, plan: [{ ...task("completed"), state: "done" }] }),
      terminal({ workspace: { id: "candidate", root: "/candidate", primary: false }, plan: [{ ...task("completed"), state: "done" }] }),
    ];
    for (const input of inputs) {
      expect(workOverview([projectWorkSummary(project, [input])]).items.some(({ reason }) => reason === "pending-review")).toBe(false);
    }
  });

  it("keeps historical shared-file completion separate from acceptance or an unapplied candidate claim", () => {
    const input = terminal({ plan: [{ ...task("completed"), state: "done" }] });
    const overview = workOverview([projectWorkSummary(project, [input])]);
    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]).toMatchObject({ reason: "pending-review", taskText: task().text });
    expect(overview.items[0]!.detail).toContain("shared project files");
    expect(overview.items[0]!.detail).not.toContain("not applied");
    expect(overview.items[0]).not.toHaveProperty("candidate");
    expect(input.plan[0]!.state).toBe("done");
  });

  it("scopes review attention to the exact captured result and removes it when the attempt is replaced", () => {
    const area = candidate({ state: "settled", headStateId: "captured-result" });
    const result: PlanTask = { ...task("completed"), state: "done", candidate: { comparisonId: area.comparisonId, label: area.label } };
    const items = (candidateArea = area, plan = [result]) => workOverview([projectWorkSummary(project, [terminal({ plan })], [], [candidateArea])]).items;
    const original = items()[0]!;
    for (const changed of [{ ...area, root: "/different/result" }, { ...area, version: 3 }, { ...area, headStateId: "new-result" }]) {
      expect(items(changed)[0]!.id).not.toBe(original.id);
    }
    expect(items(area, [{ ...result, state: "active", workerId: "new-worker", dispatchResult: undefined }])
      .some(({ reason }) => reason === "pending-review")).toBe(false);
    expect(items(area, [])).toEqual([]);
  });

  it("projects no heavy terminal buffers, diffs or per-file review lists", () => {
    const input = { ...terminal(), buffer: "huge", modified: [{ path: "/secret" }], verifyOutput: "output" };
    const summary = projectWorkSummary(project, [input]).terminals[0]!;
    expect(summary).not.toHaveProperty("buffer");
    expect(summary).not.toHaveProperty("modified");
    expect(summary).not.toHaveProperty("verifyOutput");
  });
});
