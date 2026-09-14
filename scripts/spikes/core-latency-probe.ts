/**
 * Spike: probe core op latency through the canonical SnapshotStore client.
 *
 * Runs through the spike runner (`pnpm run spike -- core-latency-probe`).
 * The fixture root is tracked for runner-owned teardown and removed in a
 * finally after the store is destroyed and the shared core is disposed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore, disposeWorldlineGitCore } from "../../electron/worldline-git.js";
import { trackSpikeFixtureRoot } from "./owned-fixtures.ts";

export default async function run(log: (msg: string) => void) {
  const dir = trackSpikeFixtureRoot(mkdtempSync(join(tmpdir(), "core-probe-")));
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
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();

    const timeOp = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      // warmup
      await fn();
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        await fn();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      log(`${label.padEnd(28)} median ${samples[10].toFixed(2)} min ${samples[0].toFixed(2)}`);
    };

    const store = await SnapshotStore.create(join(dir, "store"), fixture, join(fixture, ".git"), "sha1");
    try {
      log("store created");

      // Baseline: a full capture round trip.
      await timeOp("full capture first-pass", () => store.capture(head, null));

      // Warm full capture.
      await timeOp("full capture (stat-cache)", () => store.capture(head, null));

      // Chain incrementals.
      let parent = (await store.capture(head, null)).commit;
      const incTime = async (): Promise<number> => {
        for (let k = 0; k < 10; k++) writeFileSync(join(fixture, `file-${k}.ts`), `export const v${k} = ${Math.random()};\n`);
        const hints = Array.from({ length: 10 }, (_, k) => `file-${k}.ts`);
        const t0 = performance.now();
        parent = (await store.captureIncremental(parent, hints, [])).commit;
        return performance.now() - t0;
      };
      await incTime();
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) samples.push(await incTime());
      samples.sort((a, b) => a - b);
      log(`${"incremental (10 hints)".padEnd(28)} median ${samples[10].toFixed(2)} min ${samples[0].toFixed(2)}`);
    } finally {
      await store.destroy();
    }
  } finally {
    disposeWorldlineGitCore();
    rmSync(dir, { recursive: true, force: true });
  }
}
