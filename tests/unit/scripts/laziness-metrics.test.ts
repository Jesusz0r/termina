/**
 * Laziness-metrics regressions (issue #125).
 *
 * Pins the three settled-success laziness signals, the tuning breakdowns,
 * and the recorded fixture baseline. Measurement only: the script never
 * touches runtime behavior.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LAZINESS_OPTIONS, readLaziness } from "../../../scripts/laziness-metrics.ts";

const repo = resolve(__dirname, "..", "..", "..");
const CORPUS = join(repo, "tests/fixtures/traces/laziness-baseline");

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

function attempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordType: "attempt",
    schemaVersion: 2,
    runId: "run",
    taskId: "task",
    attemptId: "att",
    model: "m",
    effectiveEffort: "high",
    sessionLengthBucket: "short",
    taskClass: "implement",
    toolOutcomes: [],
    ...overrides,
  };
}

function settled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordType: "task-settled",
    schemaVersion: 2,
    runId: "run",
    taskId: "task",
    outcome: { status: "success" },
    taskClass: "implement",
    ...overrides,
  };
}

function writeCorpus(records: Array<Record<string, unknown> | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "termina-laziness-"));
  fixtures.push(dir);
  records.forEach((record, index) => {
    writeFileSync(join(dir, `turn-${index}.json`), typeof record === "string" ? record : JSON.stringify(record));
  });
  return dir;
}

describe("laziness metrics (#125)", () => {
  it("pins the recorded fixture baseline", async () => {
    const report = await readLaziness(CORPUS, DEFAULT_LAZINESS_OPTIONS);
    expect(report.corpus).toEqual({ tasks: 9, settled: 9, settledSuccess: 8 });
    expect(report.signals.editsWithoutCheck).toEqual({ count: 1, total: 8, rate: 0.125 });
    expect(report.signals.zeroToolCalls).toEqual({ count: 2, total: 8, rate: 0.25 });
    expect(report.signals.followupAfterSettle).toEqual({ count: 2, total: 3, rate: 0.666667 });
    expect(report.byTaskClass["implement"]).toEqual({ tasks: 6, zeroToolCalls: 1, editsWithoutCheck: 1 });
    expect(report.byTaskClass["question"]).toEqual({ tasks: 2, zeroToolCalls: 1, editsWithoutCheck: 0 });
    expect(report.turns["success"]).toEqual({ tasks: 8, totalTurns: 9, p50Turns: 1, maxTurns: 2 });
    expect(report.integrity).toMatchObject({ filesScanned: 19, malformedFiles: 0, partialRecords: 0 });
  });

  it("is deterministic over the corpus", async () => {
    const first = await readLaziness(CORPUS, DEFAULT_LAZINESS_OPTIONS);
    const second = await readLaziness(CORPUS, DEFAULT_LAZINESS_OPTIONS);
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("exposes the same report through the repeatable command", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/laziness-metrics.ts", CORPUS], {
      cwd: repo,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
    const cli = JSON.parse(result.stdout) as { signals: unknown; corpus: unknown };
    expect(cli.corpus).toEqual({ tasks: 9, settled: 9, settledSuccess: 8 });
    expect(cli.signals).toEqual({
      editsWithoutCheck: { count: 1, total: 8, rate: 0.125 },
      zeroToolCalls: { count: 2, total: 8, rate: 0.25 },
      followupAfterSettle: { count: 2, total: 3, rate: 0.666667 },
    });
  });

  it("counts only succeeding bash outcomes as checks", async () => {
    const dir = writeCorpus([
      attempt({ taskId: "failed-check", attemptId: "a1", toolOutcomes: [{ toolName: "edit", isError: false }, { toolName: "bash", isError: false, exitCode: 1 }] }),
      settled({ taskId: "failed-check" }),
      attempt({ taskId: "error-check", attemptId: "a2", toolOutcomes: [{ toolName: "write_file", isError: false }, { toolName: "bash", isError: true, exitCode: 0 }] }),
      settled({ taskId: "error-check" }),
      attempt({ taskId: "absent-code", attemptId: "a3", toolOutcomes: [{ toolName: "edit", isError: false }, { toolName: "bash", isError: false }] }),
      settled({ taskId: "absent-code" }),
    ]);
    const report = await readLaziness(dir, DEFAULT_LAZINESS_OPTIONS);
    // Failed and errored bash runs are not checks; an absent exit code is.
    expect(report.signals.editsWithoutCheck).toEqual({ count: 2, total: 3, rate: 0.666667 });
  });

  it("excludes unsettled, failed, and malformed tasks from signals", async () => {
    const dir = writeCorpus([
      attempt({ taskId: "open", attemptId: "a1", toolOutcomes: [] }),
      attempt({ taskId: "failed", attemptId: "a2", toolOutcomes: [] }),
      settled({ taskId: "failed", outcome: { status: "failure" } }),
      attempt({ taskId: "good", attemptId: "a3", toolOutcomes: [{ toolName: "bash", isError: false, exitCode: 0 }] }),
      settled({ taskId: "good" }),
      "{not json",
      { recordType: "attempt", schemaVersion: 999, runId: "run", taskId: "future", attemptId: "a4" },
      { recordType: "attempt", schemaVersion: 2, runId: "run" },
    ]);
    const report = await readLaziness(dir, DEFAULT_LAZINESS_OPTIONS);
    expect(report.corpus).toEqual({ tasks: 3, settled: 2, settledSuccess: 1 });
    expect(report.signals.zeroToolCalls).toEqual({ count: 0, total: 1, rate: 0 });
    expect(report.integrity).toMatchObject({ malformedFiles: 1, partialRecords: 2 });
  });

  it("bounds the follow-up window by turn gap", async () => {
    const dir = writeCorpus([
      attempt({ taskId: "first", attemptId: "a1", toolOutcomes: [{ toolName: "bash", isError: false, exitCode: 0 }] }),
      settled({ taskId: "first" }),
      attempt({ taskId: "gap3", attemptId: "a2", toolOutcomes: [{ toolName: "bash", isError: false, exitCode: 0 }] }),
      settled({ taskId: "gap3" }),
      attempt({ taskId: "gap4", attemptId: "a3", toolOutcomes: [{ toolName: "bash", isError: false, exitCode: 0 }] }),
      settled({ taskId: "gap4" }),
    ]);
    // first settles at turn 1, gap3 starts at 2 (gap 1), gap4 starts at 4 (gap 1).
    const report = await readLaziness(dir, { ...DEFAULT_LAZINESS_OPTIONS, followupTurns: 1 });
    expect(report.signals.followupAfterSettle).toEqual({ count: 2, total: 2, rate: 1 });
    const strict = await readLaziness(dir, { ...DEFAULT_LAZINESS_OPTIONS, followupTurns: 0 });
    expect(strict.signals.followupAfterSettle).toEqual({ count: 0, total: 2, rate: 0 });
  });

  it("reports zero rates over an empty corpus", async () => {
    const report = await readLaziness(writeCorpus([]), DEFAULT_LAZINESS_OPTIONS);
    expect(report.signals.editsWithoutCheck).toEqual({ count: 0, total: 0, rate: 0 });
    expect(report.signals.zeroToolCalls).toEqual({ count: 0, total: 0, rate: 0 });
    expect(report.signals.followupAfterSettle).toEqual({ count: 0, total: 0, rate: 0 });
  });

  it("rejects an unreadable trace directory", async () => {
    await expect(readLaziness(join(tmpdir(), "termina-no-such-trace-dir"), DEFAULT_LAZINESS_OPTIONS)).rejects.toThrow(
      /cannot read trace directory/,
    );
  });
});
