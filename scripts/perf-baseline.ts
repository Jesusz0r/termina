// @ts-nocheck
/**
 * Perf baseline (WORLDLINES §9): full and incremental capture latency.
 *
 * Bundles itself with esbuild (like the spikes) and measures the store
 * captures on a synthetic fixture. Reports cold and warm full captures
 * plus incremental captures with a rotating hint window.
 * Reports p50/p95/p99 plus process RSS.
 *
 * PERF_FILES overrides the fixture size (default 200 files).
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "perf-baseline-"));
const FILE_COUNT_RAW = Number(process.env.PERF_FILES ?? 200);
const FILE_COUNT = Number.isFinite(FILE_COUNT_RAW) && FILE_COUNT_RAW > 0 ? Math.floor(FILE_COUNT_RAW) : 200;
const entry = join(dir, "perf-entry.mjs");
writeFileSync(
  entry,
  `
import { SnapshotStore } from "${join(import.meta.dirname, "..", "electron", "worldline-git.ts")}";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixture = ${JSON.stringify(join(dir, "fixture"))};
const FILE_COUNT = ${FILE_COUNT};
mkdirSync(fixture, { recursive: true });
for (let i = 0; i < FILE_COUNT; i++) writeFileSync(join(fixture, \`file-\${i}.ts\`), \`export const v\${i} = \${i};\\n\`);
execFileSync("git", ["init", "-q"], { cwd: fixture });
execFileSync("git", ["config", "user.email", "t@t"], { cwd: fixture });
execFileSync("git", ["config", "user.name", "t"], { cwd: fixture });
execFileSync("git", ["add", "-A"], { cwd: fixture });
execFileSync("git", ["commit", "-qm", "init"], { cwd: fixture });

const storeDir = ${JSON.stringify(join(dir, "store"))};
const store = await SnapshotStore.create(storeDir, fixture, join(fixture, ".git"), "sha1");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();

// Cold full capture: the first capture pays store warm-up.
const coldStart = performance.now();
const coldState = await store.capture(head, null);
const coldFullMs = performance.now() - coldStart;

// Warm full captures: nothing changed between captures.
const full = [];
for (let i = 0; i < 20; i++) {
  const t0 = performance.now();
  const state = await store.capture(head, null);
  full.push(performance.now() - t0);
  await store.unref(state.commit);
}
full.sort((a, b) => a - b);

// Incremental captures: rotate the hint window across the fixture
// so every round touches a fresh set instead of rewriting files 0..9.
// HINT_N clamps to the fixture size so small PERF_FILES runs can't emit
// duplicate hints or NaN paths from modulo-by-zero.
const inc = [];
let parent = coldState.commit;
const HINT_N = Math.min(10, FILE_COUNT);
for (let i = 0; i < 30; i++) {
  const base = FILE_COUNT > 0 ? (i * HINT_N) % FILE_COUNT : 0;
  const hintIdx = [];
  for (let k = 0; k < HINT_N; k++) hintIdx.push((base + k) % FILE_COUNT);
  for (const idx of hintIdx) writeFileSync(join(fixture, \`file-\${idx}.ts\`), \`export const v\${idx} = \${idx + i + 1};\\n\`);
  const hints = hintIdx.map((idx) => \`file-\${idx}.ts\`);
  const t0 = performance.now();
  const state = await store.captureIncremental(parent, hints, []);
  inc.push(performance.now() - t0);
  const oldParent = parent;
  parent = state.commit;
  if (oldParent !== parent) await store.unref(oldParent);
}
await store.unref(parent);
inc.sort((a, b) => a - b);
const stats = (arr) => {
  const q = (p) => arr[Math.min(arr.length - 1, Math.ceil(arr.length * p) - 1)];
  return { p50: arr[Math.floor(arr.length / 2)], p95: q(0.95), p99: q(0.99) };
};
const fullStats = stats(full);
const incStats = stats(inc);

const median = (arr) => arr[Math.floor(arr.length / 2)];
const rssMB = +((process.memoryUsage?.().rss ?? 0) / 1048576).toFixed(1);
console.log(JSON.stringify({
  fixture: { files: FILE_COUNT },
  fullCaptureMs: {
    cold: +coldFullMs.toFixed(1),
    median: +median(full).toFixed(1),
    p50: +fullStats.p50.toFixed(1),
    p95: +fullStats.p95.toFixed(1),
    p99: +fullStats.p99.toFixed(1),
    samples: full.map((v) => +v.toFixed(1)),
  },
  incrementalCaptureMs: {
    median: +median(inc).toFixed(1),
    p50: +incStats.p50.toFixed(1),
    p95: +incStats.p95.toFixed(1),
    p99: +incStats.p99.toFixed(1),
    samples: inc.map((v) => +v.toFixed(1)),
  },
  rssMB,
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
