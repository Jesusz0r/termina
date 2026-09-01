/**
 * Watcher idle barrier spike.
 *
 * Exercises the real debounce scheduler without opening an OS watcher, so it
 * remains deterministic when the host has exhausted watch descriptors.
 */
import { mkdtempSync, rmSync, writeFileSync, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWatcher } from "../../electron/watcher.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export default async function run(log: (message: string) => void): Promise<void> {
  const results: boolean[] = [];
  const check = (name: string, ok: boolean): void => {
    results.push(ok);
    log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  };
  const root = mkdtempSync(join(tmpdir(), "termina-watcher-idle-"));
  const rawCallbacks: ((event: string, filename?: string | Buffer | null) => void)[] = [];
  const fakeWatch = (...args: unknown[]): FSWatcher => {
    const onRaw = args[2];
    if (typeof onRaw === "function") {
      rawCallbacks.push(onRaw as (event: string, filename?: string | Buffer | null) => void);
    }
    const fake = Object.assign(new EventEmitter(), { close: () => {} });
    return fake as unknown as FSWatcher;
  };
  const watcher = new ProjectWatcher(root, undefined, fakeWatch);
  const internals = watcher as unknown as { schedule(relPath: string, generation: number): void; generation: number };
  const changes: string[] = [];
  watcher.onChange = (change) => { changes.push(change.relPath); };
  const unstarted = new ProjectWatcher(root, undefined, fakeWatch);
  const missingRoot = join(root, "missing-root");
  const startupFailure = new ProjectWatcher(missingRoot, undefined, () => { throw new Error("simulated startup watcher failure"); });
  const runtimeFailure = new ProjectWatcher(root, undefined, fakeWatch);
  const callbackFailure = new ProjectWatcher(root, undefined, fakeWatch);
  try {
    check("unstarted watcher rejects an idle boundary", (await unstarted.waitForIdle(250)) === null);
    watcher.start();
    const idleApi = watcher as unknown as { waitForIdle?: (timeoutMs: number) => Promise<number | null> };
    const idle = idleApi.waitForIdle?.(1000) ?? Promise.resolve(null);
    setTimeout(() => {
      writeFileSync(join(root, "late-quiet-window.txt"), "late\n");
      internals.schedule("late-quiet-window.txt", internals.generation);
    }, 100);
    await sleep(180);
    const early = await Promise.race([idle.then(() => true), sleep(1).then(() => false)]);
    check("idle barrier remains pending while late raw write debounces", early === false);
    const revision = await idle;
    check("idle barrier resolves after the debounced callback", revision !== null && changes.includes("late-quiet-window.txt"));

    const beforeUnnamed = await watcher.waitForIdle(1000);
    const unnamedBarrier = watcher.waitForIdle(1000);
    setTimeout(() => rawCallbacks.at(-1)?.("change", null), 100);
    await sleep(180);
    const unnamedEarly = await Promise.race([
      unnamedBarrier.then((value) => (value === null ? "invalid" : "stable")),
      sleep(1).then(() => "pending"),
    ]);
    check(
      "unnamed native notification invalidates an active idle barrier",
      beforeUnnamed !== null && unnamedEarly !== "stable" && !watcher.isIdleAt(beforeUnnamed),
    );
    await unnamedBarrier;
    check("unnamed native notification delivers no fabricated file callback", changes.length === 1);

    watcher.stop();
    watcher.start();
    const afterRestart = await watcher.waitForIdle(1000);
    const restartUnnamedBarrier = watcher.waitForIdle(1000);
    setTimeout(() => rawCallbacks.at(-1)?.("rename", undefined), 100);
    await sleep(180);
    const restartUnnamedEarly = await Promise.race([
      restartUnnamedBarrier.then((value) => (value === null ? "invalid" : "stable")),
      sleep(1).then(() => "pending"),
    ]);
    check(
      "unnamed notification after restart invalidates the idle barrier",
      afterRestart !== null && restartUnnamedEarly !== "stable" && !watcher.isIdleAt(afterRestart),
    );
    await restartUnnamedBarrier;
    check("restarted watcher does not fabricate an unnamed file callback", changes.length === 1);

    startupFailure.start();
    check(
      "watcher startup failure rejects an idle boundary",
      (await startupFailure.waitForIdle(250)) === null,
    );

    runtimeFailure.start();
    const runtimeInternals = runtimeFailure as unknown as { watcher: { emit(event: string, error: Error): boolean } | null };
    runtimeInternals.watcher?.emit("error", new Error("simulated runtime watcher failure"));
    check(
      "watcher runtime error rejects an idle boundary",
      (await runtimeFailure.waitForIdle(250)) === null,
    );

    runtimeFailure.start();
    const restartInternals = runtimeFailure as unknown as { schedule(relPath: string, generation: number): void; generation: number };
    const restarted = join(root, "healthy-restart.txt");
    writeFileSync(restarted, "healthy\n");
    restartInternals.schedule("healthy-restart.txt", restartInternals.generation);
    check(
      "healthy restart reschedules and restores the idle boundary",
      (await runtimeFailure.waitForIdle(1000)) !== null,
    );

    callbackFailure.start();
    callbackFailure.onChange = async () => { throw new Error("simulated callback rejection"); };
    const callbackInternals = callbackFailure as unknown as { schedule(relPath: string, generation: number): void; generation: number };
    writeFileSync(join(root, "rejected-callback.txt"), "rejected\n");
    callbackInternals.schedule("rejected-callback.txt", callbackInternals.generation);
    await sleep(180);
    check(
      "watcher callback rejection rejects an idle boundary",
      (await callbackFailure.waitForIdle(250)) === null,
    );
  } finally {
    watcher.stop();
    unstarted.stop();
    startupFailure.stop();
    runtimeFailure.stop();
    callbackFailure.stop();
    rmSync(root, { recursive: true, force: true });
  }
  const failed = results.filter((result) => !result).length;
  log(`\nwatcher idle: ${results.length - failed}/${results.length} passed`);
  if (failed > 0) throw new Error(`${failed} watcher idle checks failed`);
}
