/**
 * Perf-compare measurement regressions (issue #138).
 *
 * One timing boundary per sample: workload callbacks perform fixture work
 * first, then return the milliseconds of exactly one measured operation.
 * Merge inputs are byte-identical trees on both sides and both merges must
 * produce the same tree, or the run fails instead of publishing a
 * non-equivalent comparison. Published website ratios stay untouched until
 * a re-measurement run.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { measure, phased } from "../../../scripts/perf-measure.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("perf measurement boundaries (#138)", () => {
  it("times exactly the operation, excluding surrounding fixture work", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(105);
    try {
      // Fixture work performs no timing calls of its own.
      const fixture: number[] = [1, 2, 3];
      const ms = await measure(async () => {
        fixture.push(4);
      });
      expect(ms).toBe(5);
      expect(now).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("collects returned durations unchanged, with no second timer", async () => {
    const termSamples = [1.5, 2.5];
    const gitSamples = [10.5, 20.5];
    let termCalls = 0;
    let gitCalls = 0;
    const { term, gitTimes } = await phased(
      1,
      2,
      async () => termSamples[termCalls++]!,
      async () => gitSamples[gitCalls++]!,
    );
    expect(term).toEqual(termSamples);
    expect(gitTimes).toEqual(gitSamples);
  });

  it("swaps the block order on every repetition", async () => {
    const order: string[] = [];
    const { term, gitTimes } = await phased(
      2,
      2,
      async () => {
        order.push("term");
        return 1;
      },
      async () => {
        order.push("git");
        return 2;
      },
    );
    expect(term).toHaveLength(4);
    expect(gitTimes).toHaveLength(4);
    expect(order).toEqual(["term", "term", "git", "git", "git", "git", "term", "term"]);
  });

  it("uses one shared boundary in the benchmark template", () => {
    const script = read("scripts/perf-compare.ts");
    expect(script).toContain('from "${join(import.meta.dirname, "perf-measure.ts")}"');
    expect(script).toContain("return measure(");
    expect(script).not.toContain("timed(");
    // The template performs no timing of its own; performance.now lives
    // only in the shared measurement module.
    expect(script).not.toContain("performance.now");
    expect(read("scripts/perf-measure.ts")).toContain("performance.now");
  });

  it("keeps capture fixture work outside the measured operation", () => {
    const script = read("scripts/perf-compare.ts");
    const capture = script.slice(script.indexOf("---- snapshot capture"), script.indexOf("---- three-way merge"));
    expect(capture).toContain("nextDirtyTree()");
    const dirtyThenMeasure = capture.match(/const changed = nextDirtyTree\(\);\s*\n\s*return measure\(/g) ?? [];
    expect(dirtyThenMeasure).toHaveLength(2);
    expect(capture).not.toMatch(/measure\([^)]*nextDirtyTree/s);
  });

  it("keeps materialize cleanup outside the measured operation", () => {
    const script = read("scripts/perf-compare.ts");
    const materialize = script.slice(script.indexOf("---- candidate materialize"));
    const cleanThenMeasure = materialize.match(/rmSync\(mat[AB], \{ recursive: true, force: true \}\);\s*\n\s*return measure\(/g) ?? [];
    expect(cleanThenMeasure).toHaveLength(2);
  });

  it("merges byte-identical trees and rejects divergence", () => {
    const script = read("scripts/perf-compare.ts");
    const merge = script.slice(script.indexOf("---- three-way merge"), script.indexOf("---- candidate materialize"));
    // Branch contents are reinstalled before capturing each sibling state.
    expect(merge).toContain('reinstall("ours", 0, 50)');
    expect(merge).toContain('reinstall("theirs", 50, 100)');
    expect(merge.indexOf('reinstall("ours", 0, 50)')).toBeLessThan(merge.indexOf("const tOurs"));
    expect(merge.indexOf('reinstall("theirs", 50, 100)')).toBeLessThan(merge.indexOf("const tTheirs"));
    // Input equivalence is asserted per branch; the base is restored after.
    expect(merge).toContain('expectChanged("ours", 0, 50)');
    expect(merge).toContain('expectChanged("theirs", 50, 100)');
    expect(merge).toContain("base worktree not restored after merge setup");
    // Both merges must produce the same tree on warmup and per sample.
    expect(merge).toContain("const expectedTree = ");
    expect(merge).toContain("m.tree !== expectedTree");
    expect(merge).toContain("tree !== expectedTree");
  });

  it("leaves published ratios untouched pending re-measurement", () => {
    const html = read("website/index.html");
    const chart = html.slice(html.indexOf('id="bench-chart"'), html.indexOf("bench-note\">") + 400);
    const widths = [...chart.matchAll(/data-w="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([13, 100, 20, 100, 100, 99, 100, 60]);
    for (const label of ["7×", "5×", "on par", "0.6×"]) expect(chart).toContain(label);
    expect(chart).toContain("re-measurement pending");
  });
});
