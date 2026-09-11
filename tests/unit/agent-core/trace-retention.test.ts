import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttemptRecord, createTaskSettledRecord, createTraceRuntime } from "../../../agent-core/trace.ts";
import { readTraceDirectory, summarizeTraces } from "./trace-report.ts";
import { validateV2Relationships } from "./trace-links.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "termina-retention-reader-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const attempt = (attemptId: string, extra = {}) => ({
  schemaVersion: 2, recordType: "attempt", runId: "run", taskId: "task", attemptId,
  role: "main" as const, provider: "fixture", protocol: "fixture", model: "fixture", status: "ok",
  usage: { input: 10, output: 1, cacheRead: 20 }, ...extra,
});
const settlement = {
  schemaVersion: 2, recordType: "task-settled", runId: "run", taskId: "task",
  attemptCount: 2, attemptIds: ["parent", "child"], summaryAttemptIds: [], finalAttemptId: "child",
  outcome: { status: "success", correctness: "unknown" },
};
function put(root: string, turn: number, record: unknown) {
  writeFileSync(join(root, `turn-${turn}.json`), JSON.stringify(record));
}
function index(root: string, extra = {}, complete = true) {
  writeFileSync(join(root, "trace-index.json"), JSON.stringify({
    schemaVersion: 2, kind: "trace-link-index", complete, updatedAt: "2026-09-10T00:00:00Z",
    attempts: [{ runId: "run", taskId: "task", attemptId: "parent", role: "main",
      retained: false, traceTurn: 1, unknown: false, ...extra }], settlements: [],
  }));
}

describe("retention-aware trace relationships", () => {
  it("uses the runtime's index after real eviction, without inventing usage", async () => {
    const root = fixture();
    const runtime = createTraceRuntime({ directory: root, namespace: "retention-test", retentionCap: 2 });
    try {
      await runtime.ready;
      expect((await runtime.writeAttempt(createAttemptRecord(attempt("parent")))).ok).toBe(true);
      expect((await runtime.writeAttempt(createAttemptRecord(attempt("child", { retryOfAttemptId: "parent" })))).ok).toBe(true);
      expect((await runtime.writeTaskSettled(createTaskSettledRecord(settlement))).ok).toBe(true);
    } finally { await runtime.close(); }
    const source = readTraceDirectory(root);
    expect(source.errors).toEqual([]);
    expect(source.records).toHaveLength(2);
    expect(source.diagnostics.malformedRecords).toBe(0);
    expect(source.diagnostics.linkIndex.prunedAttemptsReferenced).toBe(1);
    const report = summarizeTraces(source.records);
    expect(report.attempts.total).toBe(1);
    expect(report.tasks.total).toBe(1);
    expect(report.usage.main.input.total).toBe(10);
    expect(report.integrity.complete).toBe(false);
    expect(report.integrity.reasons).toContain("linked-attempts-pruned");
  });

  it("accepts individually known tombstones even when the index is incomplete", () => {
    const root = fixture();
    put(root, 2, attempt("child", { parentAttemptId: "parent" }));
    index(root, {}, false);
    const source = readTraceDirectory(root);
    expect(source.errors).toEqual([]);
    expect(source.diagnostics.linkIndex.complete).toBe(false);
  });

  it.each([
    { taskId: "another-task" }, { runId: "another-run" }, { unknown: true },
    { retained: true }, { traceTurn: null },
  ])("does not excuse a dangling link with an unproven index entry: %j", (extra) => {
    const root = fixture();
    put(root, 2, attempt("child", { parentAttemptId: "parent" }));
    index(root, extra);
    expect(readTraceDirectory(root).diagnostics.malformedRecords).toBe(1);
  });

  it("does not resurrect a retained malformed parent through its index", () => {
    const root = fixture();
    put(root, 1, attempt("parent", { parentAttemptId: "parent" }));
    put(root, 2, attempt("child", { parentAttemptId: "parent" }));
    put(root, 3, settlement);
    index(root);
    const source = readTraceDirectory(root);
    expect(source.records).toHaveLength(0);
    expect(source.diagnostics.malformedRecords).toBe(3);
  });

  it("does not excuse an unreadable retained parent using an eviction claim", () => {
    const root = fixture();
    writeFileSync(join(root, "turn-1.json"), '{"schemaVersion":2');
    put(root, 2, attempt("child", { parentAttemptId: "parent" }));
    index(root);
    const source = readTraceDirectory(root);
    expect(source.records).toHaveLength(0);
    expect(source.diagnostics.malformedRecords).toBe(2);
    expect(source.diagnostics.linkIndex.prunedAttemptsReferenced).toBe(0);
  });

  it("checks the role of an evicted summary attempt", () => {
    const root = fixture();
    put(root, 2, attempt("child"));
    put(root, 3, { ...settlement, summaryAttemptIds: ["parent"] });
    index(root);
    expect(readTraceDirectory(root).diagnostics.malformedRecords).toBe(1);
    index(root, { role: "summary" });
    expect(readTraceDirectory(root).errors).toEqual([]);
  });

  it("accepts a retained index entry only when the reader itself omitted that file", () => {
    const root = fixture();
    index(root, { retained: true });
    const records = [{ ...attempt("child", { parentAttemptId: "parent" }), traceTurn: 2 }];
    const result = validateV2Relationships(root, records, new Set([2]), new Set([1]));
    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(1);
  });

  it("reports a corrupt index separately instead of weakening link validation", () => {
    const root = fixture();
    put(root, 2, attempt("child", { parentAttemptId: "parent" }));
    writeFileSync(join(root, "trace-index.json"), '{"schemaVersion":2');
    const source = readTraceDirectory(root);
    expect(source.errors.some((error) => error.file === "trace-index.json")).toBe(true);
    expect(source.diagnostics.linkIndex.errors).toBe(1);
    expect(source.diagnostics.malformedRecords).toBe(1);
  });
});
