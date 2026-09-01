/**
 * Validate hand-written tree objects with the real Git CLI.
 * Builds a store via the core protocol (nested dirs, unicode names,
 * executables, symlinks), then asks `git ls-tree -r` to parse it.
 */
import { execFileSync, spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "tree-validate-"));
const fixture = join(dir, "fixture");
for (const p of ["src/deep/nested", "docs", "bin"]) mkdirSync(join(fixture, p), { recursive: true });
writeFileSync(join(fixture, "src/main.ts"), "export const main = 1;\n");
writeFileSync(join(fixture, "src/deep/nested/leaf.txt"), "leaf\n");
writeFileSync(join(fixture, "docs/readme.md"), "# readme\n");
writeFileSync(join(fixture, "bin/tool.sh"), "#!/bin/sh\necho hi\n");
chmodSync(join(fixture, "bin/tool.sh"), 0o755);
symlinkSync("src/main.ts", join(fixture, "docs/link.ts"));
// Names that stress tree sorting: dir vs file sharing a prefix.
writeFileSync(join(fixture, "src", "main.ts.bak"), "backup\n");
mkdirSync(join(fixture, "src", "main.ts.d"), { recursive: true });
writeFileSync(join(fixture, "src", "main.ts.d", "x"), "x\n");
execFileSync("git", ["init", "-q"], { cwd: fixture });
execFileSync("git", ["config", "user.email", "t@t"], { cwd: fixture });
execFileSync("git", ["config", "user.name", "t"], { cwd: fixture });
execFileSync("git", ["add", "-A"], { cwd: fixture });
execFileSync("git", ["commit", "-qm", "init"], { cwd: fixture });

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

// Capture the initial state.
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();
const s1 = await storeRequest("capture", { head });
console.log("captured:", s1.state.commit, "paths:", s1.state.pathCount);

// Mutate: modify one file, create one file, delete nothing.
writeFileSync(join(fixture, "src/main.ts"), "export const main = 2;\n");
writeFileSync(join(fixture, "docs/new.md"), "new\n");
let parent = s1.state.commit;
const s2 = await storeRequest("capture-incremental", {
  parentCommit: parent,
  hints: ["src/main.ts", "docs/new.md"],
});
parent = s2.state.commit;
console.log("incremental:", parent);

// Materialize the incremental state into a fresh dir via apply-state.
const target = join(dir, "materialized");
mkdirSync(target, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: target });
const targetStat = lstatSync(target, { bigint: true });
await storeRequest("apply-state", {
  stateId: parent,
  targetDir: target,
  boundRootIdentity: { dev: String(targetStat.dev), ino: String(targetStat.ino) },
});

// The independent judge: the real Git CLI.
const gitDir = join(storeDir, "git");
const lsTree = execFileSync("git", ["ls-tree", "-r", parent], { encoding: "utf8", env: { ...process.env, GIT_DIR: gitDir } });
console.log("--- git ls-tree -r of the incremental state ---");
console.log(lsTree);

// fsck validates every object's hash and format.
const fsck = execFileSync("git", ["fsck", "--strict"], { encoding: "utf8", env: { ...process.env, GIT_DIR: gitDir } });
console.log("fsck --strict output (empty is good):", JSON.stringify(fsck));

// Compare materialized bytes against the working tree.
for (const rel of ["src/main.ts", "docs/new.md", "bin/tool.sh", "docs/link.ts"]) {
  const a = execFileSync("cat", [join(target, rel)]);
  const b = execFileSync("cat", [join(fixture, rel)]);
  console.log(`content match ${rel}:`, a.equals(b) ? "OK" : "MISMATCH");
}
console.log("symlink is link:", execFileSync("readlink", [join(target, "docs/link.ts")]).toString().trim());
process.exit(0);
