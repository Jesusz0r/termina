// @ts-nocheck
/**
 * Perf compare: the Rust snapshot core against the Git CLI on equal work.
 *
 * Measures three operations on one synthetic fixture and prints medians
 * plus samples as JSON. The website Speed section cites these numbers;
 * re-run this script to reproduce them.
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "perf-compare-"));
const FILE_COUNT = Number(process.env.PERF_FILES ?? 1000);
const SAMPLES_PER_BLOCK = Number(process.env.PERF_SAMPLES ?? 12);
const MERGE_BLOCKS = Number(process.env.PERF_BLOCKS ?? 2);
const MATERIALIZE_BLOCKS = Number(process.env.PERF_BLOCKS ?? 2);

const entry = join(dir, "perf-entry.mjs");
writeFileSync(
  entry,
  `
import { SnapshotStore, boundPromotionOpenDirectory } from "${join(import.meta.dirname, "..", "electron", "worldline-git.ts")}";
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
const timed = async (fn) => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
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
/**
 * Measure one tool per pure block and swap the block order on every
 * repetition, so neither tool always pays the cache-warmth or process-
 * spawn cost of the other.
 */
const phased = async (blocks, runTerm, runGit) => {
  const term = [];
  const gitTimes = [];
  for (let pass = 0; pass < blocks; pass++) {
    const firstIsTerm = pass % 2 === 0;
    for (const [first, second] of firstIsTerm ? [[runTerm, term], [runGit, gitTimes]] : [[runGit, gitTimes], [runTerm, term]]) {
      for (let i = 0; i < SAMPLES_PER_BLOCK; i++) second.push(await timed(first));
    }
  }
  return { term, gitTimes };
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
    async () => {
      const changed = nextDirtyTree();
      const ms = await timed(async () => { parent = (await store.captureIncremental(parent, changed, [], {}, {})).commit; });
      return ms;
    },
    async () => {
      const changed = nextDirtyTree();
      return timed(() => { git(["add", ...changed]); git(["write-tree"]); });
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
    () => store.capture(baseOid, null),
    async () => timed(() => { git(["add", "-A"]); git(["write-tree"]); }),
  );
  termFull.push(...term);
  gitFullScan.push(...gitTimes);
}

// ---- three-way merge --------------------------------------------------------
// Sibling states off the shared base: ours content for files 0..49,
// theirs content for files 50..99. Same workload as the git branches.
const tOurs = await store.captureIncremental(coldState.commit, Array.from({ length: 50 }, (_, i) => \`file-\${i}.ts\`), []);
const tTheirs = await store.captureIncremental(coldState.commit, Array.from({ length: 50 }, (_, i) => \`file-\${50 + i}.ts\`), []);
// Warm-up plus result validation for both tools.
{
  const m = await store.merge3(tOurs.commit, tTheirs.commit);
  if (!m.ok || m.conflicts.length !== 0) throw new Error(\`termina merge not clean: \${JSON.stringify(m.conflicts)}\`);
  git(["merge-tree", "--write-tree", "ours", "theirs"]);
}
const mergeRow = await phased(
  MERGE_BLOCKS + 1,
  () => store.merge3(tOurs.commit, tTheirs.commit),
  async () => timed(() => git(["merge-tree", "--write-tree", "ours", "theirs"])),
);
// Drop the first block entirely: it absorbs the coldest caches.
mergeRow.term.splice(0, SAMPLES_PER_BLOCK);
mergeRow.gitTimes.splice(0, SAMPLES_PER_BLOCK);

// ---- candidate materialize ----------------------------------------------------
const matA = ${JSON.stringify(join(dir, "mat-a"))};
const matB = ${JSON.stringify(join(dir, "mat-b"))};
const extractArchive = () => {
  // tar -C needs the target to exist; creating the empty dir is setup,
  // not part of the measured extraction.
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
  async () => {
    rmSync(matA, { recursive: true, force: true });
    return timed(() => materializeState(coldState.commit, matA));
  },
  async () => {
    rmSync(matB, { recursive: true, force: true });
    return timed(extractArchive);
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
