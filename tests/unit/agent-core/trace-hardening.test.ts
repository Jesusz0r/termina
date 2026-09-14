import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAttemptRecord,
  createTaskSettledRecord,
  createTraceRuntime,
  sanitizeProviderError,
  validTraceLinkIndex,
} from "../../../agent-core/trace.ts";
import type { TraceAttemptInput } from "../../../agent-core/trace.ts";

function attemptInput(overrides: Partial<TraceAttemptInput> = {}): TraceAttemptInput {
  return {
    runId: "run-harden",
    taskId: "task-harden",
    attemptId: "attempt-1",
    role: "main",
    provider: "openai",
    protocol: "openai-responses",
    model: "gpt-5.6",
    status: "ok",
    ...overrides,
  };
}

function settledInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-harden",
    taskId: "task-harden",
    attemptIds: ["attempt-1"],
    outcome: { status: "success", correctness: null, criteriaHash: null },
    ...overrides,
  };
}

describe("trace validation hardening (#227)", () => {
  it("nulls malformed optional fields instead of rejecting the record", () => {
    const record = createAttemptRecord(
      attemptInput({ taskClass: "with\nnewline", route: 42 as unknown as string }),
    );
    expect(record.taskClass).toBeNull();
    expect(record.route).toBeNull();
    expect(record.recordType).toBe("attempt");
    const settled = createTaskSettledRecord(
      settledInput({ taskClass: "bad\nclass", outcome: { status: 7, correctness: null, criteriaHash: null } }),
    );
    expect(settled.taskClass).toBeNull();
    expect(settled.outcome.status).toBeNull();
  });

  it("still rejects malformed identities and links", () => {
    expect(() => createAttemptRecord(attemptInput({ attemptId: "bad\0id" }))).toThrow(/control character/);
    expect(() => createAttemptRecord(attemptInput({ role: "reviewer" as "main" }))).toThrow(/role must be/);
    expect(() => createTaskSettledRecord(settledInput({ runId: "" }))).toThrow();
  });

  it("rejects unlinkable settlements at the factory", () => {
    expect(() => createTaskSettledRecord(settledInput({ summaryAttemptIds: ["ghost"] }))).toThrow(
      /summary does not resolve/,
    );
    expect(() => createTaskSettledRecord(settledInput({ finalAttemptId: "ghost" }))).toThrow(
      /final attempt does not resolve/,
    );
    expect(() => createTaskSettledRecord(settledInput({ attemptCount: 0 }))).toThrow(
      /smaller than attemptIds/,
    );
    expect(() =>
      createTaskSettledRecord(
        settledInput({ attemptIds: ["a", "b"], summaryAttemptIds: ["b"], finalAttemptId: "b", attemptCount: 2 }),
      ),
    ).not.toThrow();
  });

  it("emits a null bounded block for metadata-less tool outcomes", () => {
    const record = createAttemptRecord(
      attemptInput({ toolOutcomes: [{ toolName: "bash", isError: false }] }),
    );
    expect(record.toolOutcomes).toHaveLength(1);
    expect(record.toolOutcomes[0]!.bounded).toBeNull();
    const nested = createAttemptRecord(
      attemptInput({ toolOutcomes: [{ toolName: "bash", bounded: { state: "complete" } }] }),
    );
    expect(nested.toolOutcomes[0]!.bounded).not.toBeNull();
    expect(nested.toolOutcomes[0]!.bounded!.state).toBe("complete");
  });

  it("parses miss-attribution lists independently", () => {
    const record = createAttemptRecord(
      attemptInput({
        cache: { missAttribution: { contributing: [42], missingFields: ["kept"] } } as never,
      }),
    );
    expect(record.cache.missAttribution.contributing).toEqual([]);
    expect(record.cache.missAttribution.missingFields).toEqual(["kept"]);
    const flipped = createAttemptRecord(
      attemptInput({
        cache: { missAttribution: { contributing: ["kept"], missingFields: [7] } } as never,
      }),
    );
    expect(flipped.cache.missAttribution.contributing).toEqual(["kept"]);
    expect(flipped.cache.missAttribution.missingFields).toEqual([]);
  });

  it("counts string caps in code points and marker lists by name", () => {
    const astral = "😀".repeat(16_384);
    expect(createAttemptRecord(attemptInput({ taskClass: astral })).taskClass).toBe(astral);
    expect(createAttemptRecord(attemptInput({ taskClass: `${astral}😀` })).taskClass).toBeNull();
    const positions = Array.from({ length: 256 }, (_, i) => i);
    const capped = createAttemptRecord(attemptInput({ cache: { markerPositions: positions } }));
    expect(capped.cache.markerPositions).toHaveLength(256);
    const over = createAttemptRecord(attemptInput({ cache: { markerPositions: [...positions, 256] } }));
    expect(over.cache.markerPositions).toBeNull();
  });

  it("rejects link indexes with duplicate retained turns", () => {
    const attempt = (attemptId: string, traceTurn: number | null) => ({
      runId: "run-harden",
      taskId: "task-harden",
      attemptId,
      role: "main",
      retained: true,
      traceTurn,
      unknown: false,
    });
    const base = {
      schemaVersion: 2,
      kind: "trace-link-index",
      complete: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
      settlements: [],
    } as const;
    expect(validTraceLinkIndex({ ...base, attempts: [attempt("a1", 1), attempt("a2", 2)] })).toBe(true);
    expect(validTraceLinkIndex({ ...base, attempts: [attempt("a1", 1), attempt("a2", 1)] })).toBe(false);
    // Unretained entries share no turn file, so nulls never collide.
    expect(
      validTraceLinkIndex({
        ...base,
        attempts: [
          { ...attempt("a1", null), retained: false },
          { ...attempt("a2", null), retained: false },
        ],
      }),
    ).toBe(true);
  });

  it("keeps provider error messages off surrogate-pair cuts", () => {
    expect(sanitizeProviderError(`x`.repeat(499))).toHaveLength(499);
    const cut = sanitizeProviderError(`${"x".repeat(499)}😀tail`);
    expect(cut).toBe("x".repeat(499));
    expect(sanitizeProviderError("short")).toBe("short");
    expect(sanitizeProviderError("ab\uD800")).toBe("ab\uD800");
  });
});

describe("trace runtime hardening (#227)", () => {
  it("labels role-mismatched settlement links instead of duplicates", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-trace-mislabel-"));
    try {
      const directory = join(root, "traces");
      // Two preexisting files under a scan cap of one leave the link index
      // incomplete, so forward (settlement-first) references are allowed.
        mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "turn-1.json"), JSON.stringify({ schemaVersion: 99 }));
      writeFileSync(join(directory, "turn-2.json"), JSON.stringify({ schemaVersion: 99 }));
      const runtime = createTraceRuntime({ directory, namespace: "mislabel", maxScanFiles: 1 });
      await runtime.ready;
      const settled = await runtime.writeTaskSettled(
        createTaskSettledRecord({
          runId: "run-mislabel",
          taskId: "task-mislabel",
          attemptIds: ["late"],
          summaryAttemptIds: ["late"],
          outcome: { status: "success", correctness: null, criteriaHash: null },
        }),
      );
      expect(settled.ok).toBe(true);
      const late = await runtime.writeAttempt(
        createAttemptRecord({
          runId: "run-mislabel",
          taskId: "task-mislabel",
          attemptId: "late",
          role: "main",
          provider: "openai",
          protocol: "openai-responses",
          model: "gpt-5.6",
          status: "ok",
        }),
      );
      expect(late.ok).toBe(false);
      if (late.ok) throw new Error("expected link failure");
      expect(late.kind).toBe("invalid-link");
      expect(late.error).toMatch(/role does not match/);
      await runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accounts queue-full outcomes in the manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-trace-queue-"));
    try {
      const runtime = createTraceRuntime({
        directory: join(root, "traces"),
        namespace: "queue-acct",
        maxQueueDepth: 1,
      });
      await runtime.ready;
      const first = runtime.writeAttempt(attemptInput({ runId: "run-q", taskId: "task-q", attemptId: "q1" }));
      const overflow = await runtime.writeAttempt(attemptInput({ runId: "run-q", taskId: "task-q", attemptId: "q2" }));
      expect(overflow.kind).toBe("queue-full");
      expect(overflow.manifest.writeFailures).toBeGreaterThanOrEqual(1);
      expect((await first).ok).toBe(true);
      await runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accounts index-full outcomes in the manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-trace-indexfull-"));
    try {
      const directory = join(root, "traces");
        mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "turn-1.json"), JSON.stringify({ schemaVersion: 99 }));
      writeFileSync(join(directory, "turn-2.json"), JSON.stringify({ schemaVersion: 99 }));
      const runtime = createTraceRuntime({
        directory,
        namespace: "indexfull-acct",
        maxScanFiles: 1,
        maxRecordBytes: 8 * 1024 * 1024,
      });
      await runtime.ready;
      const ids = Array.from({ length: 4000 }, (_, i) => `a${String(i).padStart(4, "0")}${"x".repeat(290)}`);
      const outcome = await runtime.writeTaskSettled(
        createTaskSettledRecord({
          runId: "run-indexfull",
          taskId: "task-indexfull",
          attemptIds: ids,
          summaryAttemptIds: [],
          finalAttemptId: ids[0],
          outcome: { status: "success", correctness: null, criteriaHash: null },
        }),
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected index-full");
      expect(outcome.kind).toBe("index-full");
      expect(outcome.manifest.writeFailures).toBeGreaterThanOrEqual(1);
      expect(outcome.manifest.indexWriteFailures).toBeGreaterThanOrEqual(1);
      await runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays writable when startup only partially resets", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-trace-degraded-"));
    try {
      // A directory shaped like a turn file cannot be unlinked, so reset
      // reports failure for it on every platform including as root.
      const directory = join(root, "traces");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "turn-1.json"), JSON.stringify({ schemaVersion: 99 }));
      mkdirSync(join(directory, "turn-2.json"));
      const runtime = createTraceRuntime({ directory, namespace: "degraded", reset: true });
      const startup = await runtime.ready;
      expect(startup.ok).toBe(false);
      expect(startup.error).toMatch(/reset failed/);
      const written = await runtime.writeAttempt(
        attemptInput({ runId: "run-degraded", taskId: "task-degraded", attemptId: "d1" }),
      );
      expect(written.ok, JSON.stringify(written)).toBe(true);
      await runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reaps crashed atomic-write temps on startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-trace-tmpreap-"));
    try {
      const directory = join(root, "traces");
        mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "turn-3.json.tmp-123-456-7"), "partial");
      writeFileSync(join(directory, "trace-manifest.json.tmp-123"), "partial");
      writeFileSync(join(directory, "foreign.tmp-1"), "untouched");
      const runtime = createTraceRuntime({ directory, namespace: "tmpreap" });
      await runtime.ready;
        const names = readdirSync(directory);
      expect(names.some((n) => n.includes(".tmp-") && n !== "foreign.tmp-1")).toBe(false);
      expect(names).toContain("foreign.tmp-1");
      await runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
