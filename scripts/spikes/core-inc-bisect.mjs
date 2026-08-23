/**
 * Bisect capture-incremental latency by hint count.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "core-bisect-"));
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

const child = spawn(join(process.cwd(), "core/target/release/termina-core"), []);
child.stderr.on("data", (d) => process.stderr.write(d));
child.stdout.setEncoding("utf8");
let buffer = "";
const pending = new Map();
let seq = 0;
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (!msg.ok) throw new Error(msg.error);
    const p = pending.get(msg.requestId);
    if (p) { pending.delete(msg.requestId); p(msg); }
  }
});
const request = (op, params) => {
  const id = `r${++seq}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ op, requestId: id, ...params }) + "\n");
  });
};
const storeDir = join(dir, "store");
await request("store-create", { storeDir, sourceGitDir: join(fixture, ".git"), objectFormat: "sha1" });
let parent = (await request("capture", { storeDir, sourceRoot: fixture, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim(), objectFormat: "sha1" })).state.commit;

async function timedInc(hintCount) {
  const t0 = performance.now();
  const hints = [];
  if (hintCount > 0) {
    for (let k = 0; k < hintCount; k++) {
      writeFileSync(join(fixture, `file-${k}.ts`), `export const v${k} = ${Math.random()};\n`);
      hints.push(`file-${k}.ts`);
    }
  }
  const res = await request("capture-incremental", { storeDir, sourceRoot: fixture, parentCommit: parent, hints, objectFormat: "sha1" });
  parent = res.state.commit;
  return performance.now() - t0;
}

for (const n of [0, 1, 2, 5, 10]) {
  // warm caches at this hint count
  await timedInc(n);
  const samples = [];
  for (let i = 0; i < 15; i++) samples.push(await timedInc(n));
  samples.sort((a, b) => a - b);
  console.log(`hints=${String(n).padEnd(3)} median ${samples[7].toFixed(2)}ms  min ${samples[0].toFixed(2)}ms`);
}
process.exit(0);
