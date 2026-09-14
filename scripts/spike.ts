// @ts-nocheck
/**
 * Phase 0 spike runner.
 *
 * Bundles a disposable spike (scripts/spikes/<name>.ts) together with the
 * durable modules it imports, then runs it under plain Node. Spikes prove
 * the risky Worldlines primitives before any UI work starts (WORLDLINES §7
 * Phase 0). Results print to stdout; pass `--save <file>` to record them.
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeSpikeResources } from "./spikes/owned-fixtures.ts";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const name = args[0];
const saveTo = args[1] === "--save" ? args[2] : null;
if (!name || !/^[a-z0-9-]+$/.test(name)) {
  console.error("usage: node --experimental-strip-types scripts/spike.ts <spike-name> [--save <file>]");
  process.exit(2);
}

const outfile = join(mkdtempSync(join(tmpdir(), "termina-spike-")), `${name}.mjs`);
const lines = [];
const log = (msg) => {
  lines.push(String(msg));
  console.log(msg);
};

// Spikes register fixture roots and raw children in the shared teardown
// registry; the runner owns disposal on every exit path, including
// interruption, so a failed spike leaks neither.
let teardownDone = false;
const teardownOwnedSpikeResources = async () => {
  if (teardownDone) return;
  teardownDone = true;
  try {
    await disposeSpikeResources();
  } catch (error) {
    console.error(`spike teardown failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void teardownOwnedSpikeResources().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  await build({
    entryPoints: [`scripts/spikes/${name}.ts`],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "silent",
    // Some bundled packages use `require` at runtime. Give the ESM bundle a
    // working createRequire so those dynamic requires resolve.
    banner: { js: 'import { createRequire as __piSpikeRequire } from "node:module"; const require = __piSpikeRequire(import.meta.url);' },
  });
  const mod = await import(outfile);
  const run = mod.default ?? mod.run;
  if (typeof run !== "function") throw new Error(`spike ${name} must export a default or run function`);
  await run(log);
} catch (err) {
  log(`SPIKE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (saveTo) writeFileSync(saveTo, lines.join("\n") + "\n", "utf8");
  await teardownOwnedSpikeResources();
  rmSync(join(outfile, ".."), { recursive: true, force: true });
}
// Exit explicitly: the snapshot core child would keep the loop alive.
process.exit(process.exitCode ?? 0);