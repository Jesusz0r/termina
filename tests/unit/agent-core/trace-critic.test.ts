import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttemptRecord,
  createTaskSettledRecord,
  createTraceRuntime,
} from "../../../agent-core/trace.ts";
import type { TraceAttemptInput } from "../../../agent-core/trace.ts";

function attemptInput(overrides: Partial<TraceAttemptInput> = {}): TraceAttemptInput {
  return {
    runId: "run-critic",
    taskId: "task-critic",
    attemptId: "attempt-1",
    role: "main",
    provider: "openai",
    protocol: "openai-responses",
    model: "gpt-5.6",
    status: "ok",
    ...overrides,
  };
}

describe("critic trace records (#124)", () => {
  it("accepts the critic attempt role", () => {
    const record = createAttemptRecord(attemptInput({ attemptId: "attempt-c1", role: "critic" }));
    expect(record.role).toBe("critic");
    expect(record.recordType).toBe("attempt");
  });

  it("rejects unknown roles", () => {
    expect(() => createAttemptRecord(attemptInput({ role: "reviewer" as "main" }))).toThrow(/role must be/);
  });

  it("leaves the settled verdict null when review is skipped", () => {
    const settled = createTaskSettledRecord({
      runId: "run-critic",
      taskId: "task-critic",
      attemptIds: ["attempt-1"],
      outcome: { status: "success", correctness: null, criteriaHash: null },
    });
    expect(settled.critic).toBeNull();
  });

  it("normalizes a recorded critic verdict", () => {
    const settled = createTaskSettledRecord({
      runId: "run-critic",
      taskId: "task-critic",
      attemptIds: ["attempt-1", "attempt-c1"],
      finalAttemptId: "attempt-1",
      outcome: { status: "success", correctness: null, criteriaHash: null },
      critic: { verdict: "fail", rationale: "scope-down", rounds: 1 },
    });
    expect(settled.critic).toEqual({ verdict: "fail", rationale: "scope-down", rounds: 1 });
  });

  it("rejects malformed critic verdicts", () => {
    const base = {
      runId: "run-critic",
      taskId: "task-critic",
      attemptIds: ["attempt-1"],
      outcome: { status: "success", correctness: null, criteriaHash: null },
    };
    expect(() => createTaskSettledRecord({ ...base, critic: { verdict: "maybe", rounds: 1 } })).toThrow(/verdict/);
    expect(() => createTaskSettledRecord({ ...base, critic: { verdict: "pass", rounds: -1 } })).toThrow(/rounds/);
    expect(() => createTaskSettledRecord({ ...base, critic: "pass" as unknown as null })).toThrow(/critic/);
  });

  it("links critic attempts through write and settlement", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-trace-critic-"));
    try {
      const runtime = createTraceRuntime({ directory: join(root, "traces"), namespace: "critic-links" });
      await runtime.ready;
      const main = await runtime.writeAttempt(
        createAttemptRecord(attemptInput({ attemptId: "attempt-1" })),
      );
      assert.equal(main.ok, true);
      const critic = await runtime.writeAttempt(
        createAttemptRecord(
          attemptInput({ attemptId: "attempt-c1", role: "critic", parentAttemptId: "attempt-1" }),
        ),
      );
      assert.equal(critic.ok, true);
      const settled = await runtime.writeTaskSettled(
        createTaskSettledRecord({
          runId: "run-critic",
          taskId: "task-critic",
          attemptIds: ["attempt-1", "attempt-c1"],
          finalAttemptId: "attempt-1",
          outcome: { status: "success", correctness: null, criteriaHash: null },
          critic: { verdict: "pass", rationale: null, rounds: 1 },
        }),
      );
      assert.equal(settled.ok, true);
      await runtime.close();

      const reopened = createTraceRuntime({ directory: join(root, "traces"), namespace: "critic-links" });
      const startup = await reopened.ready;
      assert.equal(startup.ok, true);
      assert.equal(startup.malformedRecords, 0);
      await reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
