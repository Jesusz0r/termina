/**
 * Spike: bisect capture-incremental latency by hint count.
 *
 * Runs through the spike runner (`pnpm run spike -- core-inc-bisect`) and
 * uses the canonical SnapshotStore client. The fixture root is tracked for
 * runner-owned teardown and removed in a finally after the store is
 * destroyed and the shared core is disposed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore, disposeWorldlineGitCore } from "../../electron/worldline-git.js";
import { trackSpikeFixtureRoot } from "./owned-fixtures.ts";

export default async function run(log: (msg: string) => void) {
  const dir = trackSpikeFixtureRoot(mkdtempSync(join(tmpdir(), "core-bisect-")));
  try {
    const fixture = join(dir, "fixture");
    const FILE_COUNT = Number(process.env.PERF_FILES ?? 200);
    mkdirSync(fixture, { recursive: true });
    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(join(fixture, `file-${i}.ts`), `export const v${i} = ${i};\n`);
    }
    execFileSync("git", ["init", "-q"], { cwd: fixture });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: fixture });
    execFileSync("git", ["config", "user.name", "t"], { cwd: fixture });
    execFileSync("git", ["add", "-A"], { cwd: fixture });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: fixture });

    const store = await SnapshotStore.create(join(dir, "store"), fixture, join(fixture, ".git"), "sha1");
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();
      let parent = (await store.capture(head, null)).commit;

      async function timedInc(hintCount: number): Promise<number> {
        const t0 = performance.now();
        const hints: string[] = [];
        if (hintCount > 0) {
          for (let k = 0; k < hintCount; k++) {
            writeFileSync(join(fixture, `file-${k}.ts`), `export const v${k} = ${Math.random()};\n`);
            hints.push(`file-${k}.ts`);
          }
        }
        parent = (await store.captureIncremental(parent, hints, [])).commit;
        return performance.now() - t0;
      }

      for (const n of [0, 1, 2, 5, 10]) {
        // warm caches at this hint count
        await timedInc(n);
        const samples: number[] = [];
        for (let i = 0; i < 15; i++) samples.push(await timedInc(n));
        samples.sort((a, b) => a - b);
        log(`hints=${String(n).padEnd(3)} median ${samples[7].toFixed(2)}ms  min ${samples[0].toFixed(2)}ms`);
      }
    } finally {
      await store.destroy();
    }
  } finally {
    disposeWorldlineGitCore();
    rmSync(dir, { recursive: true, force: true });
  }
}
