import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "termina-sidecar-shutdown-race-"));
const eventsDir = join(root, "events");
const bundle = join(root, "sidecar.mjs");
const ready = join(root, "marker-rename.ready");
const release = join(root, "marker-rename.release");
process.env.TERMINA_MARKER_RENAME_READY = ready;
process.env.TERMINA_MARKER_RENAME_RELEASE = release;
const virtualPath = "termina-delayed-marker-rename";
const virtualSource = `
import { link, open, readdir, stat, unlink } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { rename as realRename } from "node:fs/promises";
export { link, open, readdir, stat, unlink };
export async function rename(from, to) {
  if (String(to).includes(".backpressure-")) {
    writeFileSync(process.env.TERMINA_MARKER_RENAME_READY, "ready");
    while (!existsSync(process.env.TERMINA_MARKER_RENAME_RELEASE)) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return realRename(from, to);
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
    name: "delay-marker-rename",
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
const file = join(eventsDir, "term-stop.jsonl");
await writeFile(file, "");
const { SidecarTailer } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);
const tailer = new SidecarTailer(eventsDir, () => ({ close() {} }));
tailer.onEvent = () => false;
tailer.start();
tailer.watch("term-stop");
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(predicate(), true, "timed out waiting for marker write");
};

try {
  await appendFile(file, `${JSON.stringify({ bridgeId: "stop", seq: 1, t: "agent_start" })}\n`);
  await waitFor(() => existsSync(ready));
  tailer.stop();
  await rm(eventsDir, { recursive: true, force: true });
  writeFileSync(release, "release");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(existsSync(join(eventsDir, ".backpressure-term-stop")), false);
  assert.deepEqual(warnings, [], "shutdown does not warn or retry after the marker operation fails");
} finally {
  console.warn = originalWarn;
  await rm(root, { recursive: true, force: true });
}

console.log("sidecar shutdown marker race passed");
