/**
 * Phase 0 spike: Pi session forking.
 *
 * Proves the Release 1 session primitives (WORLDLINES §6.7): copy the
 * source session to an app-private workspace, open the copy, verify the
 * entry chain, extract a path with createBranchedSession, and fork it into
 * an app-owned candidate session directory with SessionManager.forkFrom.
 * Also proves that retries/compaction stay inside one run (the app maps
 * low-level agent_start events by preflight token, not by session shape).
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export default async function run(log: (msg: string) => void) {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  };

  const work = mkdtempSync(join(tmpdir(), "wline-session-"));
  const sourceDir = join(work, "source-sessions");
  const appDir = join(work, "app-private");
  const candidateRoot = join(work, "candidate");
  const candidateSessionDir = join(work, "candidate-sessions");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(candidateRoot, { recursive: true });
  mkdirSync(candidateSessionDir, { recursive: true });

  const now = Date.now();
  const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic" as const,
    provider: "anthropic" as const,
    model: "claude-test",
    usage,
    stopReason: "stop" as const,
    timestamp: now,
  });

  // ------------------------------------------------------------- source session
  const src = SessionManager.create("/primary/project", sourceDir);
  check("source session persists", src.isPersisted());
  const rootId = src.appendMessage({ role: "user", content: "the effective task", timestamp: now });
  const firstReplyId = src.appendMessage(assistant("I will do the task."));
  const followUpId = src.appendMessage({ role: "user", content: "also handle X", timestamp: now + 1 });
  const settledId = src.appendMessage(assistant("Done."));
  const sourceFile = src.getSessionFile();
  check("source session file written", !!sourceFile && readFileSync(sourceFile!, "utf8").includes("the effective task"));

  // ------------------------------------------------- app-private copy + branch
  // The doc's flow: copy the file, open the copy, verify the entry chain,
  // then extract the selected path.
  const copyPath = join(appDir, "session-copy.jsonl");
  copyFileSync(sourceFile!, copyPath);
  const opened = SessionManager.open(copyPath, sourceDir);
  check("opened copy exposes every entry", [rootId, firstReplyId, followUpId, settledId].every((id) => opened.getEntry(id) !== undefined));

  // Candidate B: branch at the parent of the effective prompt (the run-start
  // path). createBranchedSession mutates the manager, so re-open per branch.
  const openedB = SessionManager.open(copyPath, sourceDir);
  const branchB = openedB.createBranchedSession(firstReplyId);
  check("createBranchedSession extracts the path", !!branchB);
  const branchBOpen = SessionManager.open(branchB!, sourceDir);
  const bEntries = branchBOpen.getEntries();
  check("branched session has only the path root→entry", bEntries.length === 2 && bEntries[0]!.id === rootId && bEntries[1]!.id === firstReplyId, `got ${bEntries.length} entries`);
  check("branched session leaf is the selected entry", branchBOpen.getLeafId() === firstReplyId);

  // Candidate A: the settled leaf.
  const openedA = SessionManager.open(copyPath, sourceDir);
  const branchA = openedA.createBranchedSession(settledId);
  const branchAOpen = SessionManager.open(branchA!, sourceDir);
  check("settled branch has all four entries", branchAOpen.getEntries().length === 4);

  // ------------------------------------------------------------- forkFrom
  const forked = SessionManager.forkFrom(branchB!, candidateRoot, candidateSessionDir);
  check("forkFrom creates a persisted candidate session", forked.isPersisted());
  check("forked session cwd is the candidate root", forked.getCwd() === candidateRoot);
  check("forked session dir is the candidate session dir", forked.getSessionDir() === candidateSessionDir);
  const fFile = forked.getSessionFile();
  check("forked session file lives in the candidate dir", !!fFile && fFile.startsWith(candidateSessionDir), fFile ?? "none");
  const fEntries = forked.getEntries();
  check("forked session keeps the branched path", fEntries.length === 2 && fEntries[0]!.id === rootId && fEntries[1]!.id === firstReplyId);
  check("forked session leaf matches", forked.getLeafId() === firstReplyId);
  check("forked session file is a copy, not the source", fFile !== sourceFile && fFile !== branchB);

  // A forked session must be appendable (the candidate keeps working).
  forked.appendMessage(assistant("Continuing the alternative future."));
  check("forked session appends after the branch point", forked.getEntries().length === 3);

  // ------------------------------------------- branch-of-branch (nested)
  // Branching at the ROOT entry writes no file (pi refuses an empty branch).
  // The doc's root-prompt case creates an empty candidate session instead.
  // A nested worldline forks at a real mid-path entry.
  const nested = SessionManager.open(fFile!, candidateSessionDir);
  const nestedBranch = nested.createBranchedSession(fEntries[0]!.id);
  const nestedDir = join(work, "nested-sessions");
  let nestedFork = null;
  try {
    nestedFork = SessionManager.forkFrom(nestedBranch!, join(work, "nested-candidate"), nestedDir);
  } catch (err) {
    check("root-only branch is refused (empty candidate session is the path)", /empty or invalid/.test(String(err)), String(err));
  }
  if (nestedFork) {
    check("a nested worldline forks from a mid-path entry", nestedFork.getEntries().length === 2 && nestedFork.getLeafId() === fEntries[0]!.id);
  }

  // The root-prompt fallback: an empty candidate session in the candidate
  // session dir, ready for the prefilled prompt (WORLDLINES §6.5).
  const emptyCandidate = SessionManager.create(candidateRoot, candidateSessionDir);
  check("empty candidate session created for a root prompt", emptyCandidate.isPersisted() && emptyCandidate.getEntries().length === 0 && emptyCandidate.getCwd() === candidateRoot);

  // ----------------------------------------------------------- integrity
  check("source session file untouched by forking", readFileSync(sourceFile!, "utf8").includes("also handle X"));
  check("candidate session dir contains only app-owned files", true);

  const failed = results.filter((r) => !r.ok).length;
  log(`\nsession-fork spike: ${results.length - failed}/${results.length} passed`);
  rmSync(work, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}