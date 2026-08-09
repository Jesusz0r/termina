/**
 * Phase 0 spike: platform capabilities.
 *
 * Proves the operating-system primitives Worldlines depends on (WORLDLINES
 * §4 preflight): sandbox-exec write boundaries with inherited children,
 * copy-on-write directory clones, the recursive watcher, and disk space
 * reporting. These determine whether Worldlines can enable at all.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { watch } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitVersion, platformHasRecursiveWatcher, platformHasSandboxExec, platformHasCopyOnWrite, freeDiskBytes, MIN_GIT_VERSION } from "../../electron/worldline-git.js";

export default async function run(log: (msg: string) => void) {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  };

  const work = mkdtempSync(join(tmpdir(), "wline-platform-"));
  const candidate = join(work, "candidate");
  const forbidden = join(work, "forbidden");
  mkdirSync(candidate, { recursive: true });
  mkdirSync(forbidden, { recursive: true });

  // -------------------------------------------------------------- git version
  const v = await gitVersion();
  check("git version parses", !!v, v?.join(".") ?? "null");
  check("git meets the merge-tree minimum", !!v && v[0]! > MIN_GIT_VERSION[0]! || (!!v && v[0] === MIN_GIT_VERSION[0] && v[1]! >= MIN_GIT_VERSION[1]!), v?.join(".") ?? "null");

  // ------------------------------------------------------------- sandbox-exec
  const sb = platformHasSandboxExec();
  check("sandbox-exec exists", sb, "required: macOS");
  let sandboxWrites = "not-run";
  if (sb) {
    // Deny-list profile: allow everything, deny writes to the forbidden dir.
    // The sandbox matches canonical paths, so resolve them (/var → /private/var).
    const profile = join(work, "deny.sb");
    const forbiddenCanon = realpathSync(forbidden);
    writeFileSync(
      profile,
      [
        "(version 1)",
        "(allow default)",
        `(deny file-write* (subpath "${forbiddenCanon}"))`,
        "(import \"system.sb\")",
        "",
      ].join("\n"),
    );
    const script =
      `echo allowed > "${join(candidate, "ok.txt")}"; echo candidate=$?; ` +
      `touch "${join(forbidden, "no.txt")}"; echo forbidden=$?; ` +
      // A grandchild process inherits the sandbox.
      `sh -c 'touch "${join(forbidden, "no2.txt")}"'; echo child=$?; ` +
      `sh -c 'echo via-child > "${join(candidate, "child.txt")}"'; echo child-ok=$?`;
    const res = spawnSync("sandbox-exec", ["-f", profile, "/bin/sh", "-c", script], { encoding: "utf8" });
    const out = res.stdout ?? "";
    const candidateOk = out.includes("candidate=0");
    const forbiddenBlocked = out.includes("forbidden=1");
    const childBlocked = out.includes("child=1");
    const childOk = out.includes("child-ok=0");
    sandboxWrites = `${out.trim()}`;
    check("sandbox allows candidate writes", candidateOk, sandboxWrites);
    check("sandbox blocks forbidden writes", forbiddenBlocked, sandboxWrites);
    check("sandbox children inherit the write boundary", childBlocked && childOk, sandboxWrites);
    check("sandbox denied file absent", !existsSync(join(forbidden, "no.txt")) && !existsSync(join(forbidden, "no2.txt")));
  }

  // --------------------------------------------------------- copy-on-write
  const coW = platformHasCopyOnWrite();
  check("copy-on-write clone reported available", coW, "required: macOS APFS");
  if (coW) {
    const src = join(work, "clone-src");
    mkdirSync(src);
    writeFileSync(join(src, "a.txt"), "hello clone\n");
    writeFileSync(join(src, "b.txt"), Buffer.from([0x01, 0x02]));
    const dst = join(work, "clone-dst");
    const cp = spawnSync("cp", ["-c", "-R", src, dst], { encoding: "utf8" });
    check("cp -c clones a directory tree", cp.status === 0 && existsSync(join(dst, "a.txt")) && existsSync(join(dst, "b.txt")), cp.stderr ?? "");
    if (cp.status === 0) {
      // CoW: the copy is independent — mutating the copy leaves the source.
      writeFileSync(join(dst, "a.txt"), "mutated\n");
      const srcInode = statSync(join(src, "a.txt")).ino;
      const dstInode = statSync(join(dst, "a.txt")).ino;
      check("clone is a separate inode (copy, not hardlink)", srcInode !== dstInode);
      check("mutating the clone leaves the source intact", readFileSync(join(src, "a.txt"), "utf8") === "hello clone\n");
    }
  }

  // --------------------------------------------------------- recursive watcher
  const rw = platformHasRecursiveWatcher();
  check("recursive watcher reported available", rw);
  const watched = join(work, "watched");
  mkdirSync(watched);
  const sub = join(watched, "sub");
  mkdirSync(sub);
  const events: string[] = [];
  const watcher = watch(watched, { recursive: true }, (_ev, name) => {
    if (name) events.push(String(name));
  });
  // macOS needs a moment to arm the recursive watch before it reports.
  await new Promise((r) => setTimeout(r, 300));
  writeFileSync(join(sub, "deep.txt"), "deep\n");
  await new Promise((r) => setTimeout(r, 500));
  watcher.close();
  check("recursive watcher sees nested writes", events.some((e) => e.includes("deep.txt")), JSON.stringify(events));

  // ------------------------------------------------------------------ disk
  const free = await freeDiskBytes(work);
  check("free disk space reports a number", typeof free === "number" && free !== null && free > 0, free === null ? "null" : `${Math.round(free / 1024 / 1024)} MB`);
  check("free space meets the pair-creation reserve (4 GB)", free !== null && free >= 4 * 1024 * 1024 * 1024, free === null ? "null" : `${Math.round(free / 1024 / 1024 / 1024)} GB`);

  const failed = results.filter((r) => !r.ok).length;
  log(`\nplatform spike: ${results.length - failed}/${results.length} passed`);
  rmSync(work, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}