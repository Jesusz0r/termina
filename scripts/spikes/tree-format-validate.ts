/**
 * Spike: validate hand-written tree objects with the real Git CLI.
 * Builds a store through the canonical SnapshotStore client (nested dirs,
 * unicode names, executables, symlinks), then asks `git ls-tree -r` to
 * parse it. Runs through the spike runner
 * (`pnpm run spike -- tree-format-validate`). The fixture root is tracked
 * for runner-owned teardown and removed in a finally after the store is
 * destroyed and the shared core is disposed.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore, boundPromotionOpenDirectory, disposeWorldlineGitCore } from "../../electron/worldline-git.js";
import { trackSpikeFixtureRoot } from "./owned-fixtures.ts";

export default async function run(log: (msg: string) => void) {
  const dir = trackSpikeFixtureRoot(mkdtempSync(join(tmpdir(), "tree-validate-")));
  try {
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

    const store = await SnapshotStore.create(join(dir, "store"), fixture, join(fixture, ".git"), "sha1");
    try {
      // Capture the initial state.
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();
      const s1 = await store.capture(head, null);
      log(`captured: ${s1.commit} paths: ${s1.pathCount}`);

      // Mutate: modify one file, create one file, delete nothing.
      writeFileSync(join(fixture, "src/main.ts"), "export const main = 2;\n");
      writeFileSync(join(fixture, "docs/new.md"), "new\n");
      const s2 = await store.captureIncremental(s1.commit, ["src/main.ts", "docs/new.md"], []);
      const parent = s2.commit;
      log(`incremental: ${parent}`);

      // Materialize the incremental state into a fresh dir via apply-state.
      const target = join(dir, "materialized");
      mkdirSync(target, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: target });
      await store.applyState({
        stateId: parent,
        targetDir: target,
        boundRootIdentity: await boundPromotionOpenDirectory({ path: target }),
      });

      // The independent judge: the real Git CLI.
      const lsTree = execFileSync("git", ["ls-tree", "-r", parent], { encoding: "utf8", env: { ...process.env, GIT_DIR: store.gitDir } });
      log("--- git ls-tree -r of the incremental state ---");
      log(lsTree);

      // fsck validates every object's hash and format.
      const fsck = execFileSync("git", ["fsck", "--strict"], { encoding: "utf8", env: { ...process.env, GIT_DIR: store.gitDir } });
      log(`fsck --strict output (empty is good): ${JSON.stringify(fsck)}`);

      // Compare materialized bytes against the working tree.
      for (const rel of ["src/main.ts", "docs/new.md", "bin/tool.sh", "docs/link.ts"]) {
        const a = execFileSync("cat", [join(target, rel)]);
        const b = execFileSync("cat", [join(fixture, rel)]);
        log(`content match ${rel}: ${a.equals(b) ? "OK" : "MISMATCH"}`);
      }
      log(`symlink is link: ${execFileSync("readlink", [join(target, "docs/link.ts")]).toString().trim()}`);
    } finally {
      await store.destroy();
    }
  } finally {
    disposeWorldlineGitCore();
    rmSync(dir, { recursive: true, force: true });
  }
}
