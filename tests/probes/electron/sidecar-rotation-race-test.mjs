import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "termina-sidecar-rotation-race-"));
const eventsDir = join(root, "events");
const bundle = join(root, "sidecar.mjs");
const virtualPath = "termina-delayed-sealed-unlink";
const virtualSource = `
import { link as realLink, open as realOpen, readdir as realReaddir, rename as realRename, stat as realStat, unlink as realUnlink } from "node:fs/promises";
export const link = realLink;
export const open = realOpen;
export const readdir = realReaddir;
export const rename = realRename;
export const stat = realStat;
export async function unlink(path) {
  if (String(path).endsWith(".sealed")) {
    const signal = String(path) + ".unlink-window";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(signal, "ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return realUnlink(path);
}
`;

await build({
  entryPoints: ["electron/sidecar.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundle,
  logLevel: "silent",
  plugins: [{
    name: "delay-sealed-unlink",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^node:fs\/promises$/ }, (args) => {
        if (args.namespace === "delay-fs") return { path: args.path, external: true };
        return { path: virtualPath, namespace: "delay-fs" };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: "delay-fs" }, () => ({ contents: virtualSource, loader: "js" }));
    },
  }],
});

await mkdir(eventsDir);
const active = join(eventsDir, "term-race.jsonl");
const sealed = join(eventsDir, ".term-race.jsonl.manual-1.sealed");
await writeFile(active, "");
const { SidecarTailer } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);
const tailer = new SidecarTailer(eventsDir, () => ({ close() {} }), { maxBacklogBytes: 64 * 1024 * 1024 });
const received = [];
tailer.onEvent = (_id, event) => {
  received.push(event.seq);
  return true;
};
tailer.start();
tailer.watch("term-race");
const descriptor = await open(active, "a");

const waitFor = async (predicate, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(predicate(), true, "timed out waiting for the delayed sealed unlink");
};

try {
  const prefix = "x".repeat(8 * 1024 * 1024 - 1) + "\n";
  await appendFile(active, prefix + [
    { bridgeId: "race", seq: 1, t: "agent_start" },
    { bridgeId: "race", seq: 2, t: "agent_settled" },
  ].map((record) => `${JSON.stringify(record)}\n`).join(""));
  // This is the canonical writer boundary: rename publishes the sealed
  // generation, while the active pathname is a fresh inode.
  await rename(active, sealed);
  await writeFile(active, "");
  await waitFor(() => existsSync(sealed + ".unlink-window"));

  // The descriptor predates the seal and is the legacy compatibility race.
  // The tailer's temporary hard link must keep this append observable.
  await descriptor.write(`${JSON.stringify({ bridgeId: "race", seq: 3, t: "checkpoint_result", ok: true })}\n`);
  await appendFile(active, `${JSON.stringify({ bridgeId: "race", seq: 4, t: "agent_settled" })}\n`);
  await waitFor(() => received.length >= 4);
  assert.deepEqual(received, [1, 2, 3, 4]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cursor = JSON.parse(await readFile(join(eventsDir, ".cursor-term-race.json"), "utf8"));
  assert.equal(cursor.sequence, 4);
} finally {
  await descriptor.close();
  tailer.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rm(root, { recursive: true, force: true });
}

console.log("sidecar sealed rotation race passed");
