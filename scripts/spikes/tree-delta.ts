/**
 * Phase 0 spike: differential test for incremental tree writes.
 *
 * Fuzzes random create / modify / delete / chmod / symlink operations
 * over a nested fixture, then proves after every batch that the hinted
 * incremental capture produces exactly the same tree as a fresh full
 * capture. Also proves the reconcile path: precomputed watcher blob oids
 * must flag every drifted file, and a malformed oid must fail loudly.
 * This guards the delta tree writer against missed deletions,
 * empty-directory cascades, and file/dir type changes.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore, gitHead } from "../../electron/worldline-git.js";
import { blobOid } from "../../electron/watcher.js";

/** Deterministic RNG so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default async function run(log: (msg: string) => void) {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  };

  const work = mkdtempSync(join(tmpdir(), "wline-tree-delta-"));
  const repo = join(work, "repo");
  // Spread files over nested directories of varying depth so deletions
  // cascade through several tree levels.
  const rel = (i: number): string => `dir${i % 7}/sub${(i * 3) % 5}/deep${i % 3}/file-${i}.txt`;

  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });

  const store = await SnapshotStore.create(join(work, "store"), repo, join(repo, ".git"), "sha1");

  /** Every existing relative file path of the fixture. */
  const listFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      let entries: Array<import("node:fs").Dirent> = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (ent.name === ".git") continue;
        const full = join(dir, ent.name);
        if (ent.isDirectory()) walk(full, `${prefix}${ent.name}/`);
        else out.push(`${prefix}${ent.name}`);
      }
    };
    walk(repo, "");
    return out;
  };

  const rand = mulberry32(0x7e5);
  let failures = 0;
  const ROUNDS = 40;
  let base = (await store.capture(await gitHead(repo), null)).commit;
  for (let round = 0; round < ROUNDS; round++) {
    const touched: string[] = [];
    const known = listFiles();
    const opCount = 1 + Math.floor(rand() * 6);
    for (let op = 0; op < opCount; op++) {
      const kind = rand();
      if (kind < 0.3 || known.length === 0) {
        // Create a new file, sometimes inside fresh deep directories.
        const p = rel(Math.floor(rand() * 100000));
        mkdirSync(join(repo, p, ".."), { recursive: true });
        writeFileSync(join(repo, p), `r${round}-${op}-${"x".repeat(Math.floor(rand() * 64))}\n`);
        touched.push(p);
      } else if (kind < 0.55) {
        // Modify an existing regular file.
        const p = known[Math.floor(rand() * known.length)];
        try {
          const abs = join(repo, p);
          if (lstatSync(abs).isFile()) {
            writeFileSync(abs, `m${round}-${op}-${rand()}\n`);
            touched.push(p);
          }
        } catch { /* vanished */ }
      } else if (kind < 0.75) {
        // Delete an existing entry.
        const p = known[Math.floor(rand() * known.length)];
        rmSync(join(repo, p), { force: true });
        touched.push(p);
      } else if (kind < 0.85) {
        // Flip the executable bit on a regular file.
        const p = known[Math.floor(rand() * known.length)];
        try {
          const abs = join(repo, p);
          const st = lstatSync(abs);
          if (st.isFile()) {
            chmodSync(abs, st.mode & 0o111 ? 0o644 : 0o755);
            touched.push(p);
          }
        } catch { /* vanished */ }
      } else if (kind < 0.95) {
        // Symlink round-trip on fresh names.
        const p = `link-${round}-${op}.lnk`;
        try {
          symlinkSync(`dir${Math.floor(rand() * 7)}`, join(repo, p));
          touched.push(p);
        } catch { /* exists */ }
      } else {
        // Empty out one top-level subtree entirely (deletion cascade).
        const prefix = `${known[Math.floor(rand() * known.length)].split("/")[0]}/`;
        for (const p of known.filter((k) => k.startsWith(prefix))) {
          rmSync(join(repo, p), { force: true });
          touched.push(p);
        }
      }
    }

    const hints = [...new Set(touched)];
    const fullState = await store.capture(await gitHead(repo), null);
    // The incremental capture sees the same disk the full capture just
    // hashed, so both trees must agree byte-for-byte.
    const incState = await store.captureIncremental(base, hints, [], {}, {});
    const diffs = await store.diffTree(incState.commit, fullState.commit);
    if (diffs.length !== 0) {
      failures++;
      log(`  round ${round}: ${diffs.length} divergent paths, e.g. ${JSON.stringify(diffs.slice(0, 3))}`);
    }
    base = incState.commit;
  }
  check(
    `incremental tree equals full-capture tree across ${ROUNDS} fuzzed rounds`,
    failures === 0,
    failures === 0 ? "" : `${failures} divergent rounds`,
  );

  // Reconcile drift detection: rewrite two cached files behind the
  // parent state's back, then ship precomputed oids for every file. The
  // result must equal a fresh full capture exactly.
  const files = listFiles().filter((p) => p.endsWith(".txt")).slice(0, 8);
  const before = await store.capture(null, null);
  for (const p of files.slice(0, 2)) writeFileSync(join(repo, p), `drifted-${rand()}\n`);
  const reconcile = files.map((p) => ({
    relPath: p,
    oid: blobOid(readFileSync(join(repo, p), "utf8"), "sha1"),
  }));
  const recState = await store.captureIncremental(before.commit, [], reconcile, {}, {});
  const recDiffs = await store.diffTree(recState.commit, (await store.capture(null, null)).commit);
  check("reconcile flags exactly the drifted files", recDiffs.length === 0, JSON.stringify(recDiffs.slice(0, 3)));
  // Advance the chain to the post-drift state so later sections compare
  // against current disk contents.
  base = recState.commit;

  // Malformed reconcile oid must fail loudly, never silently skip.
  let rejected = false;
  try {
    await store.captureIncremental(recState.commit, [], [{ relPath: "nope.txt", oid: "zz-not-hex" }], {}, {});
  } catch {
    rejected = true;
  }
  check("malformed reconcile oid fails loudly", rejected);

  // ------------------------------------------------- type-flip edge cases
  // Each case reuses the fuzz fixture and compares the hinted incremental
  // tree against a fresh full capture, like every round above.
  const assertSameTree = async (name: string, hints: string[]): Promise<void> => {
    const inc = await store.captureIncremental(base, hints, [], {}, {});
    const full = await store.capture(await gitHead(repo), null);
    const d = await store.diffTree(inc.commit, full.commit);
    check(name, d.length === 0, JSON.stringify(d.slice(0, 3)));
    base = inc.commit;
  };

  // Directory becomes a file: "rm -rf dir0" then create a file dir0.
  {
    const victims = listFiles().filter((p) => p.startsWith("dir0/"));
    for (const p of victims) rmSync(join(repo, p), { force: true });
    rmSync(join(repo, "dir0"), { recursive: true });
    writeFileSync(join(repo, "dir0"), "now a file\n");
    await assertSameTree("dir-to-file flip matches full capture", [...victims, "dir0"]);
  }

  // File becomes a directory, with and without the directory path hinted.
  rmSync(join(repo, "dir0"), { force: true });
  await assertSameTree("cleanup of the flip file matches", ["dir0"]);
  mkdirSync(join(repo, "dir0/nested"), { recursive: true });
  writeFileSync(join(repo, "dir0/nested/new.txt"), "inside\n");
  await assertSameTree("file-to-dir flip, dir path unhinted", ["dir0/nested/new.txt"]);
  mkdirSync(join(repo, "dir1/nested2"), { recursive: true });
  writeFileSync(join(repo, "dir1/nested2/deep.txt"), "inside2\n");
  await assertSameTree("file-to-dir flip, dir path hinted", ["dir1", "dir1/nested2/deep.txt"]);

  // Total wipe down to the empty tree, then rebuild from the empty state.
  {
    const everything = listFiles();
    for (const p of everything) rmSync(join(repo, p), { force: true });
    await assertSameTree("total wipe reaches the empty tree", everything);
    mkdirSync(join(repo, "again/deep"), { recursive: true });
    writeFileSync(join(repo, "again/deep/back.txt"), "back\n");
    await assertSameTree("rebuild from the empty tree", ["again/deep/back.txt"]);
  }

  // Reconcile parity in the sha256 object format.
  try {
    const repo256 = join(work, "repo-sha256");
    mkdirSync(repo256, { recursive: true });
    execFileSync("git", ["init", "-q", "--object-format=sha256"], { cwd: repo256 });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo256 });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo256 });
    writeFileSync(join(repo256, "s.txt"), "one\n");
    const store256 = await SnapshotStore.create(join(work, "store-sha256"), repo256, join(repo256, ".git"), "sha256");
    const before256 = await store256.capture(null, null);
    writeFileSync(join(repo256, "s.txt"), "two\n");
    const rec256 = await store256.captureIncremental(before256.commit, [], [{ relPath: "s.txt", oid: blobOid("two\n", "sha256") }], {}, {});
    const d256 = await store256.diffTree(rec256.commit, (await store256.capture(null, null)).commit);
    check("sha256 reconcile flags the drifted file", d256.length === 0, JSON.stringify(d256.slice(0, 3)));
    await store256.destroy();
  } catch (err) {
    check("sha256 reconcile flags the drifted file", false, String(err));
  }

  // ------------------------------------------------------------ summary
  const failed = results.filter((r) => !r.ok).length;
  log(`\ntree-delta spike: ${results.length - failed}/${results.length} passed`);
  await store.destroy();
  rmSync(work, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}
