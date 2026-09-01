/**
 * Probe core op latency directly over the stdio protocol.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "core-probe-"));
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

const child = spawn(join(process.cwd(), "core/target/release/termina-core"), []);
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
    try {
      const msg = JSON.parse(line);
      const p = pending.get(msg.requestId);
      if (p) {
        pending.delete(msg.requestId);
        p(msg);
      } else {
        console.error("unmatched reply:", line.slice(0, 120));
      }
    } catch (e) {
      console.error("bad line:", line.slice(0, 120));
    }
  }
});
function request(op, params) {
  const id = `r${++seq}`;
  return new Promise((resolve) => {
    pending.set(id, (msg) => {
      if (!msg.ok) throw new Error(`${op} failed: ${msg.error}`);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ op, requestId: id, ...params }) + "\n");
  });
}
const timeOp = async (label, fn) => {
  // warmup
  await fn();
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  console.log(label.padEnd(28), "median", samples[10].toFixed(2), "min", samples[0].toFixed(2));
};

// store create
const storeDir = join(dir, "store");
const created = await request("store-create", { storeDir, sourceGitDir: join(fixture, ".git"), objectFormat: "sha1" });
const storeRequest = (op, params = {}) => request(op, {
  ...params,
  storeDir,
  sourceRoot: fixture,
  sourceGitDir: join(fixture, ".git"),
  objectFormat: "sha1",
  storeGeneration: created.storeGeneration,
  storeIdentity: created.storeIdentity,
  storeGitIdentity: created.storeGitIdentity,
  storeGitObjectsIdentity: created.storeGitObjectsIdentity,
  storeGitObjectsInfoIdentity: created.storeGitObjectsInfoIdentity,
  storeGitObjectsPackIdentity: created.storeGitObjectsPackIdentity,
  storeGitRefsIdentity: created.storeGitRefsIdentity,
  storeGitRefsHeadsIdentity: created.storeGitRefsHeadsIdentity,
  storeGitRefsTagsIdentity: created.storeGitRefsTagsIdentity,
});
console.log("store created");

// Baseline: a full capture round trip.
await timeOp("full capture first-pass", () =>
  storeRequest("capture", { head }));

// Warm full capture.
await timeOp("full capture (stat-cache)", () =>
  storeRequest("capture", { head }));

// Chain incrementals.
let state = await storeRequest("capture", { head });
let parent = state.state.commit;
const incTime = async () => {
  for (let k = 0; k < 10; k++) writeFileSync(join(fixture, `file-${k}.ts`), `export const v${k} = ${Math.random()};\n`);
  const hints = Array.from({ length: 10 }, (_, k) => `file-${k}.ts`);
  const t0 = performance.now();
  const res = await storeRequest("capture-incremental", { parentCommit: parent, hints });
  const dt = performance.now() - t0;
  parent = res.state.commit;
  return dt;
};
await incTime();
const samples = [];
for (let i = 0; i < 20; i++) samples.push(await incTime());
samples.sort((a, b) => a - b);
console.log("incremental (10 hints)".padEnd(28), "median", samples[10].toFixed(2), "min", samples[0].toFixed(2));

process.exit(0);
