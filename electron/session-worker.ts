/**
 * Session worker entry (worker_threads).
 *
 * Performs all SessionManager work off the Electron main thread
 * (WORLDLINES §6.7). Forking a candidate session runs here: copy the
 * source session to an app-private workspace, open the copy, verify the
 * entry chain, extract the path, and fork it into the candidate session
 * directory.
 */
import { parentPort } from "node:worker_threads";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

interface ForkRequest {
  op: "fork";
  requestId: string;
  /** The complete source session file. */
  sourceSessionFile: string;
  /** The entry to branch at (the leaf of the forked path). */
  entryId: string;
  /** The app-private session workspace for intermediate copies. */
  sessionWorkspaceDir: string;
  candidateRoot: string;
  candidateSessionDir: string;
  /** A hidden relocation note appended to the session (display: false). */
  relocationNote?: string;
  /** A hidden one-shot context message appended before the prompt. */
  contextText?: string;
}

function post(msg: Record<string, unknown>): void {
  parentPort?.postMessage(msg);
}

parentPort?.on("message", (msg: ForkRequest) => {
  if (msg.op !== "fork") return;
  void (async () => {
    try {
      // Copy the source file first; the branch and fork never touch it.
      mkdirSync(msg.sessionWorkspaceDir, { recursive: true });
      const copyPath = join(msg.sessionWorkspaceDir, `fork-${msg.requestId}.jsonl`);
      copyFileSync(msg.sourceSessionFile, copyPath);
      const opened = SessionManager.open(copyPath);
      const entry = opened.getEntry(msg.entryId);
      if (!entry) throw new Error(`entry ${msg.entryId} not found in the session branch`);
      // Extract the path root → entry. pi writes the branched file only
      // when the path contains an assistant message; otherwise the file is
      // deferred to the first append. The doc's root-prompt case uses an
      // empty candidate session, so check the file really exists.
      const branchPath = opened.createBranchedSession(msg.entryId);
      let forked: SessionManager;
      if (branchPath && existsSync(branchPath)) {
        forked = SessionManager.forkFrom(branchPath, msg.candidateRoot, msg.candidateSessionDir);
      } else {
        forked = SessionManager.create(msg.candidateRoot, msg.candidateSessionDir);
      }
      if (msg.relocationNote) {
        forked.appendCustomMessageEntry("pi-ditor-relocation", msg.relocationNote, false);
      }
      if (msg.contextText) {
        forked.appendCustomMessageEntry("pi-ditor-context", msg.contextText, false);
      }
      post({
        op: "fork-result",
        requestId: msg.requestId,
        ok: true,
        sessionFile: forked.getSessionFile() ?? null,
        entryCount: forked.getEntries().length,
        leafId: forked.getLeafId(),
      });
    } catch (err) {
      post({ op: "fork-result", requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});
