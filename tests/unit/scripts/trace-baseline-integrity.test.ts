/**
 * Trace-baseline integrity regressions (issue #137).
 *
 * Unsupported schemas and invalid/negative counters are integrity failures,
 * never valid evidence: they land in `integrity` and stay out of the
 * denominators. Reads are bounded during consumption and reject
 * non-regular files. Unknown stays unknown — never coerced to zero.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BASELINE_OPTIONS,
  readBaseline,
  readBoundedJsonFile,
  type BaselineFs,
} from "../../../scripts/trace-baseline.ts";

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

function attempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    recordType: "attempt",
    runId: "run-1",
    taskId: "task-1",
    attemptId: "att-1",
    role: "main",
    provider: "anthropic",
    protocol: "messages",
    model: "claude-test",
    status: "ok",
    usage: { input: 100, cacheRead: 80, cacheWrite: 10, output: 20, reasoning: null },
    cost: { usd: 0.5 },
    cache: { requested: { mode: "default" }, effective: { mode: "default" } },
    ...overrides,
  };
}

function writeCorpus(files: Array<{ name: string; content: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "termina-trace-integrity-"));
  fixtures.push(dir);
  for (const file of files) writeFileSync(join(dir, file.name), file.content);
  return dir;
}

const json = (value: unknown): string => JSON.stringify(value);

describe("trace-baseline integrity (#137)", () => {
  it("rejects unsupported schemas as partial records", async () => {
    const dir = writeCorpus([{ name: "turn-0.json", content: json(attempt({ schemaVersion: 999 })) }]);
    const report = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    expect(report.records).toEqual({ attempts: 0, settlements: 0 });
    expect(report.integrity.partialRecords).toBe(1);
    expect(report.usage.input.sum).toBe(0);
    expect(report.cost.knownUsd).toBe(0);
  });

  it("rejects negative usage and cost instead of totaling them", async () => {
    const dir = writeCorpus([
      { name: "turn-0.json", content: json(attempt({ usage: { input: -100 }, cost: { usd: -5 } })) },
    ]);
    const report = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    expect(report.records.attempts).toBe(0);
    expect(report.integrity.partialRecords).toBe(1);
    expect(report.usage.input.sum).toBe(0);
    expect(report.usage.input.unknown).toBe(0);
    expect(report.cost).toEqual({ knownCount: 0, knownUsd: 0, unknownCount: 0 });
  });

  it("rejects non-finite counters from overflow literals", async () => {
    const dir = writeCorpus([{ name: "turn-0.json", content: `{"schemaVersion":2,"recordType":"attempt","runId":"r","taskId":"t","attemptId":"a","usage":{"input":1e999}}` }]);
    expect(JSON.parse("1e999")).toBe(Number.POSITIVE_INFINITY);
    const report = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    expect(report.records.attempts).toBe(0);
    expect(report.integrity.partialRecords).toBe(1);
    expect(report.usage.input.sum).toBe(0);
  });

  it("fails the whole record on one negative counter", async () => {
    const dir = writeCorpus([{ name: "turn-0.json", content: json(attempt({ usage: { input: 100, cacheRead: -5 } })) }]);
    const report = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    expect(report.records.attempts).toBe(0);
    expect(report.integrity.partialRecords).toBe(1);
    expect(report.usage.input).toMatchObject({ known: 0, sum: 0 });
  });

  it("preserves missing counters as unknown, never zero", async () => {
    const dir = writeCorpus([{ name: "turn-0.json", content: json(attempt({ usage: {}, cost: {} })) }]);
    const report = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    expect(report.records.attempts).toBe(1);
    expect(report.usage.input).toMatchObject({ known: 0, explicitZero: 0, unknown: 1, sum: 0 });
    expect(report.cost).toMatchObject({ knownCount: 0, knownUsd: 0, unknownCount: 1 });
  });

  it("distinguishes explicit zeros from unknowns", async () => {
    const dir = writeCorpus([{ name: "turn-0.json", content: json(attempt({ usage: { input: 0 }, cost: { usd: 0 } })) }]);
    const report = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    expect(report.usage.input).toMatchObject({ known: 0, explicitZero: 1, unknown: 0, sum: 0 });
    expect(report.cost).toMatchObject({ knownCount: 1, knownUsd: 0, unknownCount: 0 });
  });

  it("keeps valid aggregation deterministic and correct", async () => {
    const dir = writeCorpus([
      { name: "turn-0.json", content: json(attempt({ attemptId: "a1" })) },
      { name: "turn-1.json", content: json(attempt({ attemptId: "a2", usage: { input: 50, cacheRead: 0 } })) },
    ]);
    const first = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    const second = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    expect(second).toEqual(first);
    expect(first.records.attempts).toBe(2);
    expect(first.usage.input).toMatchObject({ known: 2, sum: 150 });
    expect(first.cache.hits).toBe(1);
    expect(first.cache.explicitZeroRead).toBe(1);
    expect(first.cost).toMatchObject({ knownCount: 2, knownUsd: 1, unknownCount: 0 });
  });

  it("counts an oversized manifest as malformed input", async () => {
    const dir = writeCorpus([{ name: "trace-manifest.json", content: json({ retainedRecords: 5, padding: "x".repeat(1000) }) }]);
    const report = await readBaseline(dir, { ...DEFAULT_BASELINE_OPTIONS, maxFileBytes: 64 });
    expect(report.integrity.malformedFiles).toBe(1);
    expect(report.integrity.writerRetainedRecords).toBeNull();
  });

  it("rejects non-regular turn files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "termina-trace-integrity-"));
    fixtures.push(dir);
    mkdirSync(join(dir, "turn-5.json"));
    writeFileSync(join(dir, "real.json"), json(attempt({})));
    symlinkSync(join(dir, "real.json"), join(dir, "turn-6.json"));
    const report = await readBaseline(dir, DEFAULT_BASELINE_OPTIONS);
    expect(report.integrity.malformedFiles).toBe(2);
    expect(report.records.attempts).toBe(0);
  });

  it("enforces the byte bound on consumed bytes, not the earlier stat", () => {
    const fake: BaselineFs = {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0 },
      openSync: () => 7,
      fstatSync: () => ({ isFile: () => true, size: 10 }),
      readFileSync: () => Buffer.from(`{"grown": "${"x".repeat(200)}"}`),
      closeSync: () => {},
    };
    // stat claims 10 bytes but consumption yields 200: oversized, not parsed.
    expect(readBoundedJsonFile(fake, "turn-0.json", 100)).toEqual({ ok: false, reason: "oversized" });

    const directory: BaselineFs = { ...fake, fstatSync: () => ({ isFile: () => false, size: 10 }) };
    expect(readBoundedJsonFile(directory, "turn-0.json", 100)).toEqual({ ok: false, reason: "malformed" });

    const valid: BaselineFs = { ...fake, readFileSync: () => Buffer.from('{"a":1}') };
    expect(readBoundedJsonFile(valid, "turn-0.json", 100)).toEqual({ ok: true, value: { a: 1 } });

    const missing: BaselineFs = {
      ...fake,
      openSync: () => {
        throw new Error("ENOENT");
      },
    };
    expect(readBoundedJsonFile(missing, "turn-0.json", 100)).toEqual({ ok: false, reason: "malformed" });
  });
});
