/**
 * Measurement primitives for scripts/perf-compare.ts (issue #138).
 *
 * One timing boundary per sample: each workload callback performs its
 * fixture work first, then returns the milliseconds of exactly one
 * `measure()` call over the operation. `phased` collects the returned
 * durations unchanged — it never wraps callbacks in a second timer — and
 * keeps the alternating-block order so neither tool always pays the
 * cache-warmth cost of the other. Imported by the perf-compare bundle and
 * by unit tests.
 */

/** Time exactly one operation; fixture setup and asserts stay outside. */
export async function measure(operation: () => unknown): Promise<number> {
  const start = performance.now();
  await operation();
  return performance.now() - start;
}

/**
 * Measure one tool per pure block, swapping the block order on every
 * repetition. Callbacks return their own single-boundary durations; the
 * values are collected unchanged.
 */
export async function phased(
  blocks: number,
  samplesPerBlock: number,
  runTerm: () => Promise<number>,
  runGit: () => Promise<number>,
): Promise<{ term: number[]; gitTimes: number[] }> {
  const term: number[] = [];
  const gitTimes: number[] = [];
  for (let pass = 0; pass < blocks; pass++) {
    const firstIsTerm = pass % 2 === 0;
    const order: Array<[() => Promise<number>, number[]]> =
      firstIsTerm ? [[runTerm, term], [runGit, gitTimes]] : [[runGit, gitTimes], [runTerm, term]];
    for (const [first, out] of order) {
      for (let i = 0; i < samplesPerBlock; i++) out.push(await first());
    }
  }
  return { term, gitTimes };
}
