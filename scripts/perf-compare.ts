// @ts-nocheck
/**
 * Perf compare: the Rust snapshot core against the Git CLI on equal work.
 *
 * Measures three operations on one synthetic fixture and prints medians
 * plus samples as JSON. Public website ratios stay withdrawn until a
 * documented re-run of this harness; do not paste chart literals from a
 * machine that is not the published hardware.
 *
 * Methodology: one timing boundary per sample. Each workload callback
 * performs its fixture work first (dirtying files, cleaning destinations,
 * reinstalling branch contents), then returns the milliseconds of exactly
 * one measured operation. Equivalence is asserted, not assumed: the merge
 * inputs are byte-identical trees on both sides and both merges must
 * produce the same tree oid, or the run fails instead of publishing a
 * non-equivalent comparison.
 *
 * Rows:
 * - capture: change 10 files per round, then termina's hint-based
 *   incremental capture versus `git add <paths>` + `git write-tree`.
 *   A second row times full-tree scans on both sides: `store.capture`
 *   versus `git add -A` + `git write-tree`.
 * - merge: conflict-free three-way merge of two disjoint 50-file
 *   branches, `store.merge3` versus `git merge-tree --write-tree`.
 * - materialize: write the full 1,000-file state into a fresh directory,
 *   `store.materialize` versus `git archive HEAD | tar -x`.
 *
 * Tools run in alternating pure blocks instead of per-sample interleave:
 * spawning git processes around a core sample poisons its timing. Block
 * order swaps on every repetition so filesystem cache warmth treats both
 * tools equally across the pooled medians. TERMINA_CORE_BIN selects the
 * core binary; PERF_FILES overrides the fixture size (default 1000).
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { perfInt } from "./perf-env.ts";

const dir = mkdtempSync(join(tmpdir(), "perf-compare-"));
try {
  const FILE_COUNT = perfInt(process.env, "PERF_FILES", 1000);
  const SAMPLES_PER_BLOCK = perfInt(process.env, "PERF_SAMPLES", 12);
  const MERGE_BLOCKS = perfInt(process.env, "PERF_BLOCKS", 2);
  const MATERIALIZE_BLOCKS = perfInt(process.env, "PERF_BLOCKS", 2);

  const entry = join(dir, "perf-entry.mjs");
  writeFileSync(
    entry,
    `
  import { SnapshotStore, boundPromotionOpenDirectory } from "${join(import.meta.dirname, "..", "electron", "worldline-git.ts")}";
  import { measure, phased } from "${join(import.meta.dirname, "perf-measure.ts")}";
  import { MERGE_OURS, MERGE_THEIRS, mergeFileName, mergeChangedNames, assertSameNames, assertSameTree } from "${join(import.meta.dirname, "perf-workload.ts")}";
  import { spawnSync, execFileSync } from "node:child_process";
  import { lstatSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
  import { join } from "node:path";

  const fixture = ${JSON.stringify(join(dir, "fixture"))};
  const FILE_COUNT = ${FILE_COUNT};
  const SAMPLES_PER_BLOCK = ${SAMPLES_PER_BLOCK};
  const MERGE_BLOCKS = ${MERGE_BLOCKS};
  const MATERIALIZE_BLOCKS = ${MATERIALIZE_BLOCKS};

  mkdirSync(fixture, { recursive: true });
  for (let i = 0; i < FILE_COUNT; i++) writeFileSync(join(fixture, \`file-\${i}.ts\`), \`export const v\${i} = \${i};\\n\`);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fixture });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: fixture });
  execFileSync("git", ["config", "user.name", "t"], { cwd: fixture });
  execFileSync("git", ["add", "-A"], { cwd: fixture });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: fixture });
  const baseOid = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();

  // Build the merge workload as real git branches: ours touches files 0..49,
  // theirs touches files 50..99, both branching from the base commit.
  execFileSync("git", ["checkout", "-q", "-b", "ours"], { cwd: fixture });
  for (let i = 0; i < 50; i++) writeFileSync(join(fixture, \`file-\${i}.ts\`), \`export const v\${i} = "ours";\\n\`);
  execFileSync("git", ["commit", "-qam", "ours"], { cwd: fixture });
  execFileSync("git", ["checkout", "-q", "-b", "theirs", baseOid], { cwd: fixture });
  for (let i = 50; i < 100; i++) writeFileSync(join(fixture, \`file-\${i}.ts\`), \`export const v\${i} = "theirs";\\n\`);
  execFileSync("git", ["commit", "-qam", "theirs"], { cwd: fixture });
  // Detach back to the base so the worktree matches the captured baseline.
  execFileSync("git", ["checkout", "-q", "-f", "--detach", baseOid], { cwd: fixture });

  const git = (args) => {
    const res = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    if (res.status !== 0) throw new Error(\`git \${args.join(" ")} failed: \${res.stderr}\`);
    return res.stdout.trim();
  };
  const stats = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      median: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
      p95: +sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(1),
      samples: arr.map((v) => +v.toFixed(1)),
    };
  };
  const materializeState = async (state, target) => {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const targetInfo = lstatSync(target, { bigint: true });
    const binding = await boundPromotionOpenDirectory({ path: target, expectedIdentity: { dev: String(targetInfo.dev), ino: String(targetInfo.ino) } });
    return store.materialize(state, target, { boundRootIdentity: binding });
  };

  // ---- snapshot capture -----------------------------------------------------
  const storeDir = ${JSON.stringify(join(dir, "store"))};
  const store = await SnapshotStore.create(storeDir, fixture, join(fixture, ".git"), "sha1");
  const coldState = await store.capture(baseOid, null);

  const CAPTURE_BLOCKS = ${SAMPLES_PER_BLOCK >= 12 ? 2 : 4};
  const termCapture = [];
  const gitTargeted = [];
  {
    let parent = coldState.commit;
    let round = 0;
    const nextDirtyTree = () => {
      round++;
      const changed = [];
      for (let k = 0; k < 10; k++) {
        const name = \`file-\${((round * 10 + k) % FILE_COUNT)}.ts\`;
        writeFileSync(join(fixture, name), \`export const v = "\${name}-r\${round}";\\n\`);
        changed.push(name);
      }
      return changed;
    };
    // Warm-up sample for both tools outside the timed blocks.
    const warm = nextDirtyTree();
    parent = (await store.captureIncremental(parent, warm, [], {}, {})).commit;
    git(["add", ...warm]);
    git(["write-tree"]);
    const { term, gitTimes } = await phased(
      CAPTURE_BLOCKS,
      SAMPLES_PER_BLOCK,
      async () => {
        const changed = nextDirtyTree();
        return measure(async () => { parent = (await store.captureIncremental(parent, changed, [], {}, {})).commit; });
      },
      async () => {
        const changed = nextDirtyTree();
        return measure(() => { git(["add", ...changed]); git(["write-tree"]); });
      },
    );
    termCapture.push(...term);
    gitTargeted.push(...gitTimes);
  }

  // Full-scan capture versus the full "add -A" scan, same phased blocks.
  const termFull = [];
  const gitFullScan = [];
  {
    await store.capture(baseOid, null);
    git(["add", "-A"]);
    git(["write-tree"]);
    const { term, gitTimes } = await phased(
      CAPTURE_BLOCKS,
      SAMPLES_PER_BLOCK,
      () => measure(() => store.capture(baseOid, null)),
      () => measure(() => { git(["add", "-A"]); git(["write-tree"]); }),
    );
    termFull.push(...term);
    gitFullScan.push(...gitTimes);
  }

  // ---- three-way merge --------------------------------------------------------
  // Sibling states off the shared base with the SAME contents as the git
  // branches: reset the capture-phase dirt, reinstall each branch's 50
  // files before capturing, then restore the base worktree. Both
  // implementations merge identical trees or the run is rejected.
  execFileSync("git", ["reset", "-q", "--hard", baseOid], { cwd: fixture });
  const reinstall = (ref, lo, hi) => {
    for (let i = lo; i < hi; i++) {
      const content = execFileSync("git", ["show", \`\${ref}:\${mergeFileName(i)}\`], { cwd: fixture });
      writeFileSync(join(fixture, mergeFileName(i)), content);
    }
  };
  const dirtyNames = () => git(["diff", "--name-only", baseOid]).split("\\n").filter(Boolean);
  const expectChanged = (label, lo, hi) => {
    assertSameNames(label, dirtyNames(), mergeChangedNames(lo, hi));
  };
  reinstall("ours", MERGE_OURS.lo, MERGE_OURS.hi);
  expectChanged("ours", MERGE_OURS.lo, MERGE_OURS.hi);
  const tOurs = await store.captureIncremental(coldState.commit, mergeChangedNames(MERGE_OURS.lo, MERGE_OURS.hi), []);
  assertSameTree(tOurs.tree, git(["rev-parse", "ours^{tree}"]), "termina ours tree is not equivalent to git ours");
  reinstall(baseOid, MERGE_OURS.lo, MERGE_OURS.hi);
  reinstall("theirs", MERGE_THEIRS.lo, MERGE_THEIRS.hi);
  expectChanged("theirs", MERGE_THEIRS.lo, MERGE_THEIRS.hi);
  const tTheirs = await store.captureIncremental(coldState.commit, mergeChangedNames(MERGE_THEIRS.lo, MERGE_THEIRS.hi), []);
  assertSameTree(tTheirs.tree, git(["rev-parse", "theirs^{tree}"]), "termina theirs tree is not equivalent to git theirs");
  reinstall(baseOid, MERGE_OURS.lo, MERGE_THEIRS.hi);
  if (dirtyNames().length !== 0) throw new Error("base worktree not restored after merge setup");
  // Warm-up plus output equivalence: both merges must produce the same tree.
  const expectedTree = git(["merge-tree", "--write-tree", "ours", "theirs"]);
  {
    const m = await store.merge3(tOurs.commit, tTheirs.commit);
    if (!m.ok || m.conflicts.length !== 0) throw new Error(\`termina merge not clean: \${JSON.stringify(m.conflicts)}\`);
    assertSameTree(m.tree, expectedTree, "termina merge tree differs from git merge-tree");
  }
  const mergeRow = await phased(
    MERGE_BLOCKS + 1,
    SAMPLES_PER_BLOCK,
    async () => {
      let merged = null;
      const ms = await measure(async () => { merged = await store.merge3(tOurs.commit, tTheirs.commit); });
      if (!merged.ok) throw new Error("termina merge diverged from the git merge-tree result");
      assertSameTree(merged.tree, expectedTree, "termina merge diverged from the git merge-tree result");
      return ms;
    },
    async () => {
      let tree = "";
      const ms = await measure(() => { tree = git(["merge-tree", "--write-tree", "ours", "theirs"]); });
      assertSameTree(tree, expectedTree, "git merge-tree result changed mid-benchmark");
      return ms;
    },
  );
  // Drop the first block entirely: it absorbs the coldest caches.
  mergeRow.term.splice(0, SAMPLES_PER_BLOCK);
  mergeRow.gitTimes.splice(0, SAMPLES_PER_BLOCK);

  // ---- candidate materialize ----------------------------------------------------
  const matA = ${JSON.stringify(join(dir, "mat-a"))};
  const matB = ${JSON.stringify(join(dir, "mat-b"))};
  const extractArchive = () => {
    // Both sides create their target dir inside the measured op (symmetric,
    // microsecond noise); destination cleanup stays outside the boundary.
    mkdirSync(matB, { recursive: true });
    const res = spawnSync("sh", ["-c", \`git archive HEAD | tar -x -C \${matB}\`], { cwd: fixture });
    if (res.status !== 0) throw new Error("archive extraction failed");
  };
  // Warm-up plus output validation.
  rmSync(matA, { recursive: true, force: true });
  await materializeState(coldState.commit, matA);
  if (!existsSync(join(matA, \`file-\${FILE_COUNT - 1}.ts\`))) throw new Error("termina materialize incomplete");
  rmSync(matB, { recursive: true, force: true });
  extractArchive();
  if (!existsSync(join(matB, \`file-\${FILE_COUNT - 1}.ts\`))) throw new Error("archive extraction incomplete");
  const matRow = await phased(
    MATERIALIZE_BLOCKS,
    SAMPLES_PER_BLOCK,
    async () => {
      rmSync(matA, { recursive: true, force: true });
      return measure(() => materializeState(coldState.commit, matA));
    },
    async () => {
      rmSync(matB, { recursive: true, force: true });
      return measure(extractArchive);
    },
  );

  console.log(JSON.stringify({
    fixture: { files: FILE_COUNT },
    capture: {
      terminaHintedMs: stats(termCapture),
      gitTargetedAddMs: stats(gitTargeted),
      terminaFullScanMs: stats(termFull),
      gitFullAddMs: stats(gitFullScan),
    },
    merge: { terminaMs: stats(mergeRow.term), gitMs: stats(mergeRow.gitTimes) },
    materialize: { terminaMs: stats(matRow.term), gitMs: stats(matRow.gitTimes) },
  }, null, 2));
  process.exit(0);
  `,
    "utf8",
  );

  await build({
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    entryPoints: [entry],
    outfile: join(dir, "perf.mjs"),
    external: [],
    logLevel: "silent",
  });

  const { execFileSync } = await import("node:child_process");
  execFileSync("node", [join(dir, "perf.mjs")], { stdio: "inherit", cwd: process.cwd() });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
