/**
 * Spike: .gitignore filtering in the project watcher.
 *
 * Table-driven checks prove the pattern compiler against Git semantics:
 * wildcards, directory-only patterns, anchoring, negation, globstars,
 * nested-file precedence, last-match-wins ordering, and directory
 * pruning. A live ProjectWatcher run then proves end to end that ignored
 * paths never reach change discovery, that a rewritten .gitignore
 * reloads its rules, and that a deleted .gitignore drops them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { matchGitignore, parseGitignore, ProjectWatcher, type GitignoreRules } from "../../electron/watcher.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function run(log: (msg: string) => void) {
  const results: Array<{ name: string; ok: boolean }> = [];
  const check = (name: string, ok: boolean) => {
    results.push({ name, ok });
    log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  };

  const rulesOf = (source: string): GitignoreRules => new Map([["", parseGitignore(source)]]);
  const matches = (source: string, path: string): boolean =>
    matchGitignore(rulesOf(source), path.split(sep).join("/"));

  // ---- pattern table ----

  check("literal name matches at any depth", matches("dist", "dist/x.js"));
  check("literal does not match similar names", !matches("dist", "distribution.js"));

  // A wildcard never crosses a slash in the matched name. A name like
  // "c.log" still matches as a directory, so its contents drop too.
  check("wildcard stays inside one segment", matches("*.log", "a/b/c.log") && !matches("*.log", "a/b/c.logx"));

  check("directory-only pattern ignores contents", matches("logs/", "logs/o.txt"));
  check("directory-only pattern skips a file of the same name", !matches("logs/", "logs"));

  check("leading slash anchors to the root", matches("/root-only.txt", "root-only.txt") && !matches("/root-only.txt", "sub/root-only.txt"));
  check("inner slash anchors the whole pattern", !matches("a/b.txt", "x/a/b.txt") && matches("a/b.txt", "a/b.txt"));

  check("negation re-includes one path", (() => {
    const src = "*.tmp\n!important.tmp\n";
    return matches(src, "note.tmp") && !matches(src, "important.tmp");
  })());
  check("last matching pattern wins", (() => {
    const src = "keep*\n!keep-all\n";
    return !matches(src, "keep-all") && matches(src, "keep-1") && !matches(src, "keep-all/sub");
  })());

  check("**/name matches any depth", matches("**/logs", "a/logs/a.txt") && matches("**/logs", "logs/a.txt"));
  check("lone ** matches everything", matches("**", "any/thing.txt"));
  check("trailing ** matches contents only", matches("cache/**", "cache/x.js") && !matches("cache/**", "cache"));

  check("an excluded directory cannot be re-included into", matches("dist/\n!dist/keep.js\n", "dist/keep.js"));
  check("the keep-idiom re-includes inside a matched glob", (() => {
    const src = "logs/*\n!logs/.gitkeep\n";
    return !matches(src, "logs/.gitkeep") && matches(src, "logs/o.txt");
 })());

  check("comments and blank lines drop out", !matches("# comment\n\n!kept\n", "kept"));
  check("an invalid pattern drops alone", (() => {
    const src = "[\nvalid-name\n";
    return matches(src, "valid-name");
  })());

  // ---- nested precedence ----

  const nested: GitignoreRules = new Map([
    ["", parseGitignore("*.gen\n")],
    ["pkg", parseGitignore("!keep.gen\ngenerated/\n")],
  ]);
  check("root pattern ignores across the tree", matchGitignore(nested, "other/x.gen"));
  check("deeper negation overrides the root file", !matchGitignore(nested, "pkg/keep.gen"));
  check("nested directory pattern applies", matchGitignore(nested, "pkg/generated/g.ts") && !matchGitignore(nested, "generated/g.ts"));

  // ---- watcher lifecycle ----

  const stoppedWork = mkdtempSync(join(tmpdir(), "termina-gitignore-stop-"));
  writeFileSync(join(stoppedWork, "seed.txt"), "seed");
  const stoppedWatcher = new ProjectWatcher(stoppedWork);
  stoppedWatcher.start();
  stoppedWatcher.stop();
  await sleep(100);
  check("stopped seed does not refill the cache", stoppedWatcher.lastContents.size === 0);
  rmSync(stoppedWork, { recursive: true, force: true });

  // ---- live watcher ----

  const work = mkdtempSync(join(tmpdir(), "termina-gitignore-"));
  const watcher = new ProjectWatcher(work);
  const seen = new Set<string>();
  watcher.onChange = (change) => seen.add(change.relPath);
  // Poll for the positive events first. The negatives below are only
  // meaningful once the pipeline has proven itself alive in this run.
  const waitFor = async (pred: () => boolean): Promise<boolean> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !pred()) await sleep(50);
    return pred();
  };
  try {
    writeFileSync(join(work, ".gitignore"), "secret*\nlogs/\n*.tmp\n!important.tmp\n");
    mkdirSync(join(work, "pkg"));
    writeFileSync(join(work, join("pkg", ".gitignore")), "generated/\n");
    watcher.start();
    // Give the seed walk time to load every rule set before the writes.
    await sleep(500);
    writeFileSync(join(work, "app.ts"), "x");
    writeFileSync(join(work, "secret.txt"), "x");
    mkdirSync(join(work, "logs"));
    writeFileSync(join(work, "logs", "o.txt"), "x");
    writeFileSync(join(work, "note.tmp"), "x");
    writeFileSync(join(work, "important.tmp"), "x");
    // Poll for the positive events first. The negatives below are only
    // meaningful once the pipeline has proven itself alive in this run.
    if (!(await waitFor(() => seen.has("app.ts") && seen.has("important.tmp")))) {
      throw new Error("live watcher delivered no events at all");
    }
    await sleep(300); // one debounce window before judging the negatives

    check("live: tracked file reported", seen.has("app.ts"));
    check("live: secret* dropped", !seen.has("secret.txt"));
    check("live: logs/ dropped", !seen.has(join("logs", "o.txt")));
    check("live: *.tmp dropped", !seen.has("note.tmp"));
    check("live: negation keeps important.tmp", seen.has("important.tmp"));

    // A rewritten .gitignore reloads its rules for later events. Wait out
    // one debounce so the new rules land before the next write.
    writeFileSync(join(work, ".gitignore"), "*.tmp\n");
    await sleep(400);
    writeFileSync(join(work, "secret.txt"), "y");
    if (!(await waitFor(() => seen.has("secret.txt")))) {
      throw new Error("rule reload did not surface secret.txt");
    }
    check("live: rewrite reloads rules", seen.has("secret.txt"));

    // A deleted .gitignore drops its rules; nested files keep theirs.
    // Wait out the deletion event first: a probe written earlier would be
    // filtered by the rules that are about to disappear.
    rmSync(join(work, ".gitignore"));
    await sleep(400);
    writeFileSync(join(work, "other.tmp"), "y");
    mkdirSync(join(work, "pkg", "generated"), { recursive: true });
    writeFileSync(join(work, "pkg", "generated", "g.ts"), "y");
    if (!(await waitFor(() => seen.has("other.tmp")))) {
      throw new Error("deleted .gitignore did not drop its rules");
    }
    await sleep(300);
    check("live: deleted file drops its rules", seen.has("other.tmp"));
    check("live: nested rules survive", !seen.has(join("pkg", "generated", "g.ts")));
  } finally {
    watcher.stop();
    rmSync(work, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  log(`\ngitignore: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) throw new Error(`${failed.length} gitignore checks failed`);
}
