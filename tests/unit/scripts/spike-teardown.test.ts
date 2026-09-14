/**
 * Spike/probe teardown regressions (issue #135).
 *
 * Owned children are stopped and awaited before their fixture roots are
 * removed; allocation is covered by the runner-owned teardown registry;
 * benchmark/probe roots are removed after their processes exit; and
 * diagnostics go through the canonical core client. No broad pkill.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { disposeSpikeResources, settleSpikeChild, trackSpikeChild, trackSpikeFixtureRoot } from "../../../scripts/spikes/owned-fixtures.ts";

const repo = resolve(__dirname, "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repo, rel), "utf8");

afterEach(async () => {
  await disposeSpikeResources();
});

describe("spike teardown helper (#135)", () => {
  it("settles tracked children before removing tracked roots", async () => {
    const root = trackSpikeFixtureRoot(mkdtempSync(join(tmpdir(), "termina-teardown-test-")));
    mkdirSync(join(root, "nested"), { recursive: true });
    const child = trackSpikeChild(spawn("sleep", ["30"], { stdio: "ignore" }));

    await disposeSpikeResources();

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it("escalates to SIGKILL for children that ignore SIGTERM", async () => {
    const child = spawn("sh", ["-c", 'trap "" TERM; sleep 30'], { stdio: "ignore" });
    const started = Date.now();
    await settleSpikeChild(child, 100);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("tolerates already-exited children and double disposal", async () => {
    const root = trackSpikeFixtureRoot(mkdtempSync(join(tmpdir(), "termina-teardown-test-")));
    const child = trackSpikeChild(spawn("true", [], { stdio: "ignore" }));
    await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
    await disposeSpikeResources();
    await disposeSpikeResources();
    expect(existsSync(root)).toBe(false);
  });

  it("is identity-bound: no broad process kills", () => {
    const helper = read("scripts/spikes/owned-fixtures.ts");
    expect(helper).not.toMatch(/(spawn|execFile)\w*\(\s*["'](pkill|killall|taskkill)/);
    expect(helper).toContain('child.kill("SIGKILL")');
  });
});

describe("spike teardown wiring (#135)", () => {
  it("covers allocation in capture/merge/lifecycle/boundary spikes", () => {
    for (const spike of ["capture", "merge", "store-lifecycle", "promotion-native-boundary"]) {
      const source = read(`scripts/spikes/${spike}.ts`);
      expect(source, `${spike} must track its fixture root`).toContain("trackSpikeFixtureRoot(mkdtempSync");
      expect(source, `${spike} must track raw core children`).toContain("trackSpikeChild(spawn(");
    }
    for (const spike of ["tree-delta", "platform", "gitignore"]) {
      expect(read(`scripts/spikes/${spike}.ts`), `${spike} must track its fixture root`).toContain(
        "trackSpikeFixtureRoot(mkdtempSync",
      );
    }
  });

  it("awaits boundary children before fixture removal", () => {
    const source = read("scripts/spikes/promotion-native-boundary.ts");
    const settle = source.indexOf("settleSpikeChild(child)");
    const remove = source.indexOf("rmSync(root, { recursive: true, force: true })");
    expect(settle).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(settle);
    expect(source).not.toMatch(/for \(const child of freshCoreChildren\) child\.kill\(\);/);
  });

  it("disposes owned resources on every runner exit path", () => {
    const runner = read("scripts/spike.ts");
    expect(runner).toContain("disposeSpikeResources");
    expect(runner).toMatch(/finally \{[\s\S]*teardownOwnedSpikeResources/);
    expect(runner).toContain("SIGINT");
    expect(runner).toContain("SIGTERM");
    expect(runner).not.toMatch(/(spawn|execFile)\w*\(\s*["'](pkill|killall|taskkill)/);
  });

  it("removes benchmark roots after the owned run exits", () => {
    for (const script of ["scripts/perf-baseline.ts", "scripts/perf-compare.ts"]) {
      const source = read(script);
      const childExit = source.indexOf('execFileSync("node", [join(dir,');
      const cleanup = source.indexOf("rmSync(dir, { recursive: true, force: true })");
      expect(childExit, `${script} must run the benchmark child`).toBeGreaterThanOrEqual(0);
      expect(cleanup, `${script} must remove its root`).toBeGreaterThan(childExit);
      expect(source.slice(0, cleanup)).toMatch(/} finally \{\s*$/m);
    }
  });

  it("routes diagnostics through the canonical core client", () => {
    for (const probe of ["core-inc-bisect", "core-latency-probe", "tree-format-validate"]) {
      const source = read(`scripts/spikes/${probe}.ts`);
      expect(source, `${probe} must run through the spike runner`).toContain("export default async function run");
      expect(source, `${probe} must use the canonical client`).toContain("SnapshotStore");
      expect(source, `${probe} must not spawn the core raw`).not.toContain("spawn(join(process.cwd(), \"core/target/release/termina-core\")");
      expect(source, `${probe} must not exit without cleanup`).not.toContain("process.exit(0)");
      expect(source, `${probe} must destroy its store`).toContain("await store.destroy()");
      expect(source, `${probe} must dispose the shared core`).toContain("disposeWorldlineGitCore()");
      expect(source, `${probe} must track its fixture root`).toContain("trackSpikeFixtureRoot(mkdtempSync");
      expect(source, `${probe} must remove its root`).toContain("rmSync(dir, { recursive: true, force: true })");
    }
  });

  it("removes the fixture root when a spike fails without a core binary", () => {
    const before = new Set(readdirSync(tmpdir()));
    const env: NodeJS.ProcessEnv = { ...process.env, TERMINA_CORE_BIN: join(tmpdir(), "termina-no-such-core-binary") };
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/spike.ts", "--", "store-lifecycle"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status, `expected the coreless spike to fail:\n${output}`).not.toBe(0);
    expect(output).toContain("SPIKE FAILED");
    const leaked = readdirSync(tmpdir()).filter((name) => !before.has(name) && name.startsWith("termina-store-lifecycle-"));
    expect(leaked).toEqual([]);
  }, 180_000);

  it("leaves no fixture root behind a passing core-free spike", () => {
    const before = new Set(readdirSync(tmpdir()));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/spike.ts", "--", "gitignore"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env },
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status, `expected the gitignore spike to pass:\n${output}`).toBe(0);
    const leaked = readdirSync(tmpdir()).filter(
      (name) => !before.has(name) && (name.startsWith("termina-gitignore-") || name.startsWith("termina-spike-")),
    );
    expect(leaked).toEqual([]);
  }, 180_000);
});
