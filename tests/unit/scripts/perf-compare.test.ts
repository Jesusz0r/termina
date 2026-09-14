/**
 * Perf-compare measurement regressions (issue #138) and env parsing (issue #261 CO/M5).
 *
 * One timing boundary per sample: workload callbacks perform fixture work
 * first, then return the milliseconds of exactly one measured operation.
 * Merge inputs are byte-identical trees on both sides and both merges must
 * produce the same tree, or the run fails instead of publishing a
 * non-equivalent comparison. Public website ratios stay withdrawn until a
 * documented re-measurement.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { measure, phased } from "../../../scripts/perf-measure.ts";
import { perfInt } from "../../../scripts/perf-env.ts";
import {
  MERGE_OURS,
  MERGE_THEIRS,
  assertSameNames,
  assertSameTree,
  mergeChangedNames,
} from "../../../scripts/perf-workload.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("perf measurement boundaries (#138)", () => {
  it("times exactly the operation, excluding surrounding fixture work", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(105);
    try {
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
});

describe("merge workload equivalence (#138)", () => {
  it("keeps ours and theirs file sets disjoint and covering 100 files", () => {
    const ours = mergeChangedNames(MERGE_OURS.lo, MERGE_OURS.hi);
    const theirs = mergeChangedNames(MERGE_THEIRS.lo, MERGE_THEIRS.hi);
    expect(ours).toHaveLength(50);
    expect(theirs).toHaveLength(50);
    expect(new Set([...ours, ...theirs]).size).toBe(100);
    expect(ours.some((name) => theirs.includes(name))).toBe(false);
  });

  it("compares changed names as sorted sets, not numeric order", () => {
    const expected = mergeChangedNames(0, 50);
    const gitStyle = [...expected].sort();
    expect(gitStyle.indexOf("file-10.ts")).toBeLessThan(gitStyle.indexOf("file-2.ts"));
    expect(() => assertSameNames("ours", gitStyle, expected)).not.toThrow();
    expect(() => assertSameNames("ours", ["file-0.ts"], expected)).toThrow(/ours worktree diverged/);
  });

  it("rejects non-equivalent tree oids", () => {
    expect(() => assertSameTree("aaa", "aaa", "mismatch")).not.toThrow();
    expect(() => assertSameTree("aaa", "bbb", "termina ours tree is not equivalent to git ours")).toThrow(
      /termina ours tree is not equivalent to git ours/,
    );
    expect(() => assertSameTree(null, "aaa", "termina merge tree differs from git merge-tree")).toThrow(
      /termina merge tree differs from git merge-tree/,
    );
  });

  it("asserts input and output tree equivalence in the benchmark template", () => {
    const script = read("scripts/perf-compare.ts");
    const merge = script.slice(script.indexOf("---- three-way merge"), script.indexOf("---- candidate materialize"));
    expect(merge).toContain("reinstall(\"ours\", MERGE_OURS.lo, MERGE_OURS.hi)");
    expect(merge).toContain("reinstall(\"theirs\", MERGE_THEIRS.lo, MERGE_THEIRS.hi)");
    expect(merge.indexOf("reinstall(\"ours\"")).toBeLessThan(merge.indexOf("const tOurs"));
    expect(merge.indexOf("reinstall(\"theirs\"")).toBeLessThan(merge.indexOf("const tTheirs"));
    expect(merge).toContain('expectChanged("ours"');
    expect(merge).toContain('expectChanged("theirs"');
    expect(merge).toContain("ours^{tree}");
    expect(merge).toContain("theirs^{tree}");
    expect(merge).toContain("termina ours tree is not equivalent to git ours");
    expect(merge).toContain("termina theirs tree is not equivalent to git theirs");
    expect(merge).toContain("base worktree not restored after merge setup");
    expect(merge).toContain("const expectedTree = ");
    expect(merge).toContain("assertSameTree(m.tree, expectedTree");
    expect(merge).toContain("assertSameTree(merged.tree, expectedTree");
    expect(merge).toContain("assertSameTree(tree, expectedTree");
  });

  it("withdraws unpublished public ratios instead of keeping stale chart literals", () => {
    const html = read("website/index.html");
    const chart = html.slice(html.indexOf('id="bench-chart"'), html.indexOf("bench-note") + 800);
    const widths = [...chart.matchAll(/data-w="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.every((w) => w === 0)).toBe(true);
    for (const label of ["7×", "5×", "on par", "0.6×"]) expect(chart).not.toContain(label);
    expect(chart).toContain("unpublished");
    expect(chart).toContain("withdrawn");
  });
});

describe("perf env parsing (#261 CO/M5)", () => {
  it("clamps missing and invalid values in one shared helper", () => {
    expect(perfInt({}, "PERF_FILES", 1000)).toBe(1000);
    expect(perfInt({ PERF_FILES: "abc" }, "PERF_FILES", 1000)).toBe(1000);
    expect(perfInt({ PERF_FILES: "0" }, "PERF_FILES", 1000)).toBe(1000);
    expect(perfInt({ PERF_FILES: "-3" }, "PERF_FILES", 1000)).toBe(1000);
    expect(perfInt({ PERF_FILES: "12.9" }, "PERF_FILES", 1000)).toBe(12);
    expect(perfInt({ PERF_SAMPLES: "4" }, "PERF_SAMPLES", 12)).toBe(4);
  });

  it("uses the shared helper in both perf scripts", () => {
    for (const script of ["scripts/perf-compare.ts", "scripts/perf-baseline.ts"]) {
      const source = read(script);
      expect(source).toContain('from "./perf-env.ts"');
      expect(source).toContain("perfInt(");
      expect(source).not.toMatch(/Number\(process\.env\.PERF_/);
    }
  });
});
