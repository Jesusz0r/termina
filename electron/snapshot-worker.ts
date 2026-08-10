/**
 * Snapshot worker entry (worker_threads).
 *
 * Runs captures, comparison-template creation, and candidate state
 * application off the Electron main thread: no synchronous Git, repository
 * walk, or hashing on the main thread (WORLDLINES §9).
 */
import { parentPort } from "node:worker_threads";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SnapshotStore, runGitIn, type CaptureBudget, type SourceState } from "./worldline-git.js";

interface CaptureRequest {
  op: "capture";
  requestId: string;
  storeDir: string;
  sourceRoot: string;
  sourceGitDir: string;
  objectFormat: "sha1" | "sha256";
  head: string | null;
  parentCommit: string | null;
  budget?: CaptureBudget;
  /** A capture from another tree (a worldline candidate head). */
  captureRoot?: string;
  captureGitDir?: string;
}

interface TemplateRequest {
  op: "template";
  requestId: string;
  storeDir: string;
  sourceRoot: string;
  sourceGitDir: string;
  objectFormat: "sha1" | "sha256";
  /** The base state commit to materialize. */
  stateId: string;
  /** The template directory (empty). */
  targetDir: string;
  /** The read-only source object directory for the final alternate. */
  sourceObjectsDir: string;
}

interface ApplyRequest {
  op: "apply-state";
  requestId: string;
  storeDir: string;
  sourceRoot: string;
  sourceGitDir: string;
  objectFormat: "sha1" | "sha256";
  stateId: string;
  targetDir: string;
}

interface CaptureIncrementalRequest {
  op: "capture-incremental";  requestId: string;
  storeDir: string;
  sourceRoot: string;
  sourceGitDir: string;
  objectFormat: "sha1" | "sha256";
  parentCommit: string;
  hints: string[];
  reconcile: Array<{ relPath: string; content: string }>;
  /** A capture from another tree (a worldline candidate head). */
  captureRoot?: string;
  captureGitDir?: string;
}

interface TrustHashesRequest {
  op: "trust-hashes";
  requestId: string;
  agentDir: string;
  projectRoot: string | null;
}

type WorkerRequest = CaptureRequest | CaptureIncrementalRequest | TemplateRequest | ApplyRequest | TrustHashesRequest;

function post(msg: Record<string, unknown>): void {
  parentPort?.postMessage(msg);
}

/** The alternate list: store objects plus source objects. */
function alternateLines(sourceGitDir: string, storeGitDir: string): string {
  return `${storeGitDir}/objects\n${sourceGitDir}/objects\n`;
}

/** Materialize a state into a repo directory and commit the disk state. */
async function applyState(req: ApplyRequest): Promise<void> {
  const store = SnapshotStore.open(req.storeDir, req.sourceRoot, req.sourceGitDir, req.objectFormat);
  // Overwrite the candidate bytes with the state; git add -A also stages
  // deletions, so the commit tree equals the disk state.
  await store.materialize(req.stateId, req.targetDir);
  const add = await runGitIn(req.targetDir, ["add", "-A"]);
  if (add.code !== 0) throw new Error(`apply git add failed: ${add.stderr}`);
  const commit = await runGitIn(req.targetDir, ["commit", "-q", "-m", "pi-ditor state"]);
  if (commit.code !== 0) throw new Error(`apply git commit failed: ${commit.stderr}`);
}

parentPort?.on("message", (msg: WorkerRequest) => {
  void (async () => {
    try {
      if (msg.op === "trust-hashes") {
        const out = trustHashes(msg.agentDir, msg.projectRoot);
        post({ op: "trust-hashes-result", requestId: msg.requestId, ok: true, state: out });
        return;
      }
      if (msg.op === "capture") {
        const store = SnapshotStore.open(msg.storeDir, msg.sourceRoot, msg.sourceGitDir, msg.objectFormat);
        const source = msg.captureRoot
          ? { root: msg.captureRoot, gitDir: msg.captureGitDir ?? msg.captureRoot }
          : undefined;
        const state: SourceState = await store.capture(msg.head, msg.parentCommit, msg.budget ?? {}, {}, source);
        post({ op: "capture-result", requestId: msg.requestId, ok: true, state });
        return;
      }
      if (msg.op === "capture-incremental") {
        const store = SnapshotStore.open(msg.storeDir, msg.sourceRoot, msg.sourceGitDir, msg.objectFormat);
        const source = msg.captureRoot ? { root: msg.captureRoot, gitDir: msg.captureGitDir ?? msg.captureRoot } : undefined;
        const state: SourceState = await store.captureIncremental(msg.parentCommit, msg.hints, msg.reconcile, {}, {}, source);
        post({ op: "capture-incremental-result", requestId: msg.requestId, ok: true, state });
        return;
      }
      if (msg.op === "template") {
        const store = SnapshotStore.open(msg.storeDir, msg.sourceRoot, msg.sourceGitDir, msg.objectFormat);
        // An independent local repository with read-only object access.
        const init = await runGitIn(msg.targetDir, ["init", "-q"]);
        if (init.code !== 0) throw new Error(`template git init failed: ${init.stderr}`);
        const altDir = join(msg.targetDir, ".git", "objects", "info");
        mkdirSync(altDir, { recursive: true });
        writeFileSync(join(altDir, "alternates"), alternateLines(msg.sourceGitDir, store.gitDir), "utf8");
        // Materialize the base bytes with filters disabled, then commit.
        await store.materialize(msg.stateId, msg.targetDir);
        const add = await runGitIn(msg.targetDir, ["add", "-A"]);
        if (add.code !== 0) throw new Error(`template git add failed: ${add.stderr}`);
        const commit = await runGitIn(msg.targetDir, ["commit", "-q", "-m", "pi-ditor base"]);
        if (commit.code !== 0) throw new Error(`template git commit failed: ${commit.stderr}`);
        // Pull the store objects into a local pack, then drop the store.
        const repack = await runGitIn(msg.targetDir, ["repack", "-a", "-d"]);
        if (repack.code !== 0) throw new Error(`template repack failed: ${repack.stderr}`);
        writeFileSync(join(altDir, "alternates"), `${msg.sourceObjectsDir}\n`, "utf8");
        post({ op: "template-result", requestId: msg.requestId, ok: true });
        return;
      }
      if (msg.op === "apply-state") {
        await applyState(msg);
        post({ op: "apply-state-result", requestId: msg.requestId, ok: true });
        return;
      }
    } catch (err) {
      post({ op: `${msg.op}-result`, requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

/**
 * The trust-sensitive resource hashes (WORLDLINES §6.7): project
 * settings, extensions, skills, prompts, themes, and the pi agent dir.
 * Bounded walk: at most 10k files and 64 MB of content.
 */
function trustHashes(agentDir: string, projectRoot: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  let files = 0;
  let bytes = 0;
  const walk = (absRoot: string, prefix: string): void => {
    let names: string[] = [];
    try {
      names = readdirSync(absRoot);
    } catch {
      return;
    }
    for (const name of names) {
      if (files > 10000 || bytes > 64 * 1024 * 1024) return;
      const full = join(absRoot, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full, `${prefix}/${name}`);
        else if (st.isFile()) {
          if (st.size > 4 * 1024 * 1024) continue;
          const content = readFileSync(full);
          files++;
          bytes += content.length;
          out[`${prefix}/${name}`] = createHash("sha256").update(content).digest("hex");
        }
      } catch {
        /* a transient file — skip */
      }
    }
  };
  for (const name of ["settings.json", "models-store.json", "prompts", "skills", "themes", "extensions"]) {
    const full = join(agentDir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walk(full, `agent/${name}`);
      else if (st.isFile()) {
        const content = readFileSync(full);
        files++;
        bytes += content.length;
        out[`agent/${name}`] = createHash("sha256").update(content).digest("hex");
      }
    } catch {
      /* absent */
    }
  }
  if (projectRoot) {
    for (const rel of [".pi", ".agents/skills"]) {
      walk(join(projectRoot, rel), `project/${rel}`);
    }
  }
  return out;
}
