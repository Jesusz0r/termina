// @ts-nocheck
/**
 * Perf baseline (WORLDLINES §9): full and incremental capture latency.
 *
 * Bundles itself with esbuild (like the spikes) and measures the store
 * captures on a synthetic fixture. Reports cold and warm full captures
 * plus incremental captures with 10-file hints.
 *
 * PERF_FILES overrides the fixture size (default 200 files).
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "perf-baseline-"));
const FILE_COUNT = Number(process.env.PERF_FILES ?? 200);
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
const p95 = full[Math.ceil(full.length * 0.95) - 1];

// Incremental captures: change 10 files, capture with hints.
const inc = [];
let parent = coldState.commit;
for (let i = 0; i < 30; i++) {
  for (let k = 0; k < 10; k++) writeFileSync(join(fixture, \`file-\${k}.ts\`), \`export const v\${k} = \${k + i + 1};\\n\`);
  const hints = Array.from({ length: 10 }, (_, k) => \`file-\${k}.ts\`);
  const t0 = performance.now();
  const state = await store.captureIncremental(parent, hints, []);
  inc.push(performance.now() - t0);
  parent = state.commit;
}
inc.sort((a, b) => a - b);
const incP95 = inc[Math.ceil(inc.length * 0.95) - 1];

const median = (arr) => arr[Math.floor(arr.length / 2)];
console.log(JSON.stringify({
  fixture: { files: FILE_COUNT },
  fullCaptureMs: {
    cold: +coldFullMs.toFixed(1),
    median: +median(full).toFixed(1),
    p95: +p95.toFixed(1),
    samples: full.map((v) => +v.toFixed(1)),
  },
  incrementalCaptureMs: {
    median: +median(inc).toFixed(1),
    p95: +incP95.toFixed(1),
    samples: inc.map((v) => +v.toFixed(1)),
  },
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
