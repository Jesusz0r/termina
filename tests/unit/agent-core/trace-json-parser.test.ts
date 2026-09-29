import { describe, expect, it } from "vitest";
import { createAttemptRecord, createTaskSettledRecord, parseTraceLinkIndex, parseTraceManifest, parseTraceRecord } from "../../../agent-core/trace.ts";
import { toolOutcomes } from "../../../agent-core/trace/normalize.ts";
import { MAX_TOOL_OUTCOMES } from "../../../agent-core/trace/schema.ts";

const attempt = createAttemptRecord({
  runId: "run-1", taskId: "task-1", attemptId: "attempt-1", role: "main",
  provider: "fixture", protocol: "fixture", model: "fixture", status: "ok",
});

describe("canonical trace JSON parser", () => {
  it.each([null, 42, "trace", []].map((value) => ({ value })))("rejects non-object trace $value", ({ value }) => {
    expect(parseTraceRecord(value)).toBeNull();
    expect(parseTraceManifest(value)).toBeNull();
    expect(parseTraceLinkIndex(value)).toBeNull();
  });

  it("rejects missing required identities inside the parser", () => {
    expect(parseTraceRecord({ ...attempt, runId: undefined })).toBeNull();
    expect(parseTraceRecord({ ...attempt, taskId: undefined })).toBeNull();
    expect(parseTraceRecord({ ...attempt, attemptId: undefined })).toBeNull();
    expect(parseTraceRecord({ ...attempt, schemaVersion: 999 })).toBeNull();
  });

  it("returns immutable typed records with schema-normalized nested metadata", () => {
    const parsed = parseTraceRecord(attempt);
    expect(parsed?.recordType).toBe("attempt");
    if (parsed?.recordType !== "attempt") throw new Error("fixture must parse as an attempt");
    expect(parsed.usage.input).toBeNull();
    expect(parsed.cache.requested.mode).toBeNull();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.cache.requested)).toBe(true);
    const settled = createTaskSettledRecord({ runId: "run-1", taskId: "task-1", attemptIds: ["attempt-1"], outcome: { status: "success" } });
    expect(parseTraceRecord(settled)).toEqual(settled);
  });

  it("rejects corrupt counters instead of making them unknown evidence", () => {
    expect(parseTraceRecord({ ...attempt, usage: { input: -1 } })).toBeNull();
    expect(parseTraceRecord({ ...attempt, cost: { usd: Infinity } })).toBeNull();
  });

  it("retains the retired critic role only when reading existing traces", () => {
    const parsed = parseTraceRecord({ ...attempt, role: "critic" });
    expect(parsed?.recordType === "attempt" && parsed.role).toBe("critic");
  });

  it("does not turn malformed or negative exit codes into passing checks", () => {
    expect(() => toolOutcomes([{ toolName: "bash", exitCode: "bad" }])).toThrow(/exitCode/);
    expect(toolOutcomes([{ toolName: "bash", exitCode: -1 }])[0]?.exitCode).toBe(-1);
  });

  it("rejects oversized stored outcome arrays instead of truncating evidence", () => {
    const prefix = Array.from({ length: MAX_TOOL_OUTCOMES }, () => ({ toolName: "read_file", isError: false }));
    const bounded = parseTraceRecord({ ...attempt, toolOutcomes: prefix });
    expect(bounded?.recordType === "attempt" && bounded.toolOutcomes.length).toBe(MAX_TOOL_OUTCOMES);
    for (const tail of [
      { toolName: "edit", isError: false },
      { toolName: "bash", isError: false, exitCode: 0 },
      { toolName: "edit", isError: false, exitCode: "bad" },
    ]) {
      expect(parseTraceRecord({ ...attempt, toolOutcomes: [...prefix, tail] })).toBeNull();
    }
  });

  it("rejects malformed edit metadata instead of erasing the edit outcome", () => {
    const toolOutcomes = [{ toolName: "edit", isError: false, exitCode: "bad" }];
    expect(parseTraceRecord({ ...attempt, toolOutcomes })).toBeNull();
    expect(() => createAttemptRecord({ ...attempt, toolOutcomes })).toThrow(/exitCode/);
  });
});
