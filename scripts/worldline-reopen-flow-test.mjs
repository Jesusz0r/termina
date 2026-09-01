import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";

// This is a deterministic unit-level exercise of the canonical reopen
// boundary. The real main-process candidate creator invokes beforeSpawn after
// its durable sidecar cursor is ready; this probe supplies the same callback
// and emits session_ready at controlled points.
const root = await mkdtemp(join(tmpdir(), "termina-worldline-reopen-"));
const bundle = join(root, "worldlines.mjs");
await build({
  entryPoints: ["electron/worldlines.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: bundle,
  logLevel: "silent",
});
const { WorldlineManager, disposeWorldlineCoreClient } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);

let manager;
let mode = "immediate";
let sequence = 0;
const controls = [];
const terminated = [];
const created = [];
let mappingObservedBeforeReady = false;
let staleKeptPending = false;

const deps = {
  worldsRoot: join(root, "worlds"),
  primaryRoot: join(root, "worlds"),
  realHome: root,
  userData: root,
  primaryEventsDir: root,
  bridgePath: join(root, "bridge.js"),
  piBin: process.execPath,
  agentCorePath: join(root, "agent-core.mjs"),
  electronExecPath: process.execPath,
  candidateEnv: () => ({}),
  showThinking: () => false,
  getStore: async () => null,
  appReadPaths: () => [],
  forkSession: async () => ({ ok: false, error: "unused" }),
  forkCoreSession: async () => ({ ok: false, error: "unused" }),
  discardCoreSession: async () => ({ ok: false, error: "unused" }),
  discardPiSession: async () => ({ ok: false, error: "unused" }),
  createCandidate: async (opts) => {
    const terminalId = `candidate-${++sequence}`;
    const useRouting = mode !== "mapping-failure";
    created.push({ terminalId, beforeSpawn: useRouting });
    if (useRouting) {
      opts.beforeSpawn?.(terminalId);
      mappingObservedBeforeReady = manager.terminalToComparison.get(terminalId)?.label === "A" && manager.list().at(-1)?.state === "creating";
    }
    if (mode === "mapping-failure") return { terminalId, pid: 0 };
    const opId = controls.at(-1)?.opId;
    if (mode === "immediate" || mode === "restart") {
      manager.onSessionReady(terminalId, true, null, {
        bridgeId: `bridge-${terminalId}`,
        generation: `generation-${terminalId}`,
        seq: 1,
        opId,
      });
    } else if (mode === "stale-delayed") {
      manager.onSessionReady(terminalId, true, null, {
        bridgeId: `old-bridge-${terminalId}`,
        generation: `old-generation-${terminalId}`,
        seq: 1,
        opId: "stale-operation",
      });
      staleKeptPending = manager.list().at(-1)?.state === "creating";
      setTimeout(() => manager.onSessionReady(terminalId, true, null, {
        bridgeId: `bridge-${terminalId}`,
        generation: `generation-${terminalId}`,
        seq: 1,
        opId,
      }), 0);
    } else if (mode === "crash") {
      manager.terminalExited(terminalId);
    }
    return { terminalId, pid: 0 };
  },
  terminateCandidate: (terminalId) => terminated.push(terminalId),
  createCandidateWorkspace: () => root,
  onUpdate: () => {},
  onCandidateState: () => {},
  onRemoved: () => {},
  preflight: async () => ({ ok: false, reasons: ["unused"] }),
  trustHashes: async () => ({}),
  captureHead: async () => ({ commit: "", tree: "" }),
  capturePrimary: async () => null,
  releaseState: async () => {},
  terminalBusy: () => false,
  terminalVerifying: () => false,
  workspaceAt: async () => null,
  acquireWriteLease: async () => ({ ok: false, error: "unused" }),
  releaseWriteLease: () => {},
  flushDirtyModels: async () => ({ ok: false }),
  canonicalPath: async (path) => path,
  mineFiles: () => new Set(),
  drainMineUpdates: async () => {},
  runSandboxedEvidence: async () => ({ code: 0, stdout: "", timedOut: false }),
  sourceFilesOf: async () => [],
  createEvidenceHome: async () => root,
  removeEvidenceHome: async () => false,
  detectTestFromState: async () => null,
  benchmarkConfigFrom: async () => null,
  onEvidenceUpdate: () => {},
  onPromotionApply: () => {},
  primarySessionDir: async () => root,
  installPromoted: async () => ({ terminalId: "unused" }),
};

const candidate = {
  label: "A",
  role: "moment",
  dir: join(root, "candidate"),
  supportDir: join(root, "candidate-support"),
  homeDir: join(root, "candidate-support", "home"),
  sessionDir: join(root, "candidate-support", "sessions"),
  eventsDir: join(root, "candidate-support", "events"),
  tmpDir: join(root, "candidate-support", "tmp"),
  cacheDir: join(root, "candidate-support", "cache"),
  profilePath: join(root, "candidate.sb"),
  sessionFile: join(root, "session.json"),
  comparisonBaseStateId: null,
  promotionBaseStateId: null,
  headStateId: null,
  headCommit: Promise.resolve(),
  terminalId: null,
  pid: null,
  lstart: null,
  state: "settled",
  version: 1,
  error: null,
};
const comparison = {
  id: "comparison-reopen",
  dir: join(root, "comparison"),
  templateDir: join(root, "template"),
  sessionWorkspaceDir: join(root, "session-workspace"),
  sourceRunId: "run-reopen",
  sourceGitDir: join(root, "worlds"),
  primaryRoot: join(root, "worlds"),
  baseCommit: null,
  baseStateId: null,
  inheritTrust: false,
  model: null,
  thinkingLevel: null,
  engine: "core",
  expectedCandidates: 1,
  uncertainSessionArtifacts: [],
  manifestWriteFailed: false,
  teardownPromise: null,
  uncertainAdmissionLease: null,
  removeUncertainRequested: false,
  createdAt: Date.now(),
  candidates: new Map([["A", candidate]]),
  phase: "running",
  error: null,
  readyTimer: null,
};

try {
  manager = new WorldlineManager(deps);
  await manager.ready;
  manager.comparisons.set(comparison.id, comparison);
  manager.candidateLaunch = async () => ({ cmd: process.execPath, args: [], env: {} });
  manager.writeControl = async (_candidate, control) => { controls.push(control); };
  manager.updateManifest = async () => {};

  // Immediate session_ready: routing is already present, but ready remains
  // unpublished until openTerminal resumes after the exact handshake.
  mode = "immediate";
  let result = await manager.openTerminal(comparison.id, "A");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(candidate.state, "ready");
  assert.equal(created[0].beforeSpawn, true);
  assert.equal(mappingObservedBeforeReady, true);

  // A stale/replayed operation is ignored; the delayed line with the fresh
  // control opId completes the reopen.
  candidate.state = "settled";
  candidate.error = null;
  mode = "stale-delayed";
  result = await manager.openTerminal(comparison.id, "A");
  assert.equal(result.ok, true);
  assert.equal(candidate.state, "ready");
  assert.equal(staleKeptPending, true);

  // Mapping installation failure never creates a ready candidate and closes
  // the exact terminal identity that had been allocated for the attempt.
  candidate.state = "settled";
  candidate.error = null;
  mode = "mapping-failure";
  result = await manager.openTerminal(comparison.id, "A");
  assert.equal(result.ok, false);
  assert.equal(candidate.state, "error");
  assert.equal(candidate.terminalId, null);
  assert.equal(terminated.at(-1), "candidate-3");

  // A crash before session_ready rejects the pending handshake. A subsequent
  // restart gets a new terminal identity and cannot be satisfied by the old
  // process's ready line.
  candidate.state = "settled";
  candidate.error = null;
  mode = "crash";
  result = await manager.openTerminal(comparison.id, "A");
  assert.equal(result.ok, false);
  assert.equal(candidate.state, "error");
  assert.equal(terminated.at(-1), "candidate-4");
  const failedTerminal = "candidate-4";
  candidate.state = "settled";
  candidate.error = null;
  mode = "restart";
  result = await manager.openTerminal(comparison.id, "A");
  assert.equal(result.ok, true);
  manager.onSessionReady(failedTerminal, true, null, {
    bridgeId: "old-bridge",
    generation: "old-generation",
    seq: 1,
    opId: "old-operation",
  });
  assert.equal(candidate.state, "ready");

  // Comparison cancellation rejects a still-pending reopen immediately and
  // clears its timer/route instead of waiting for the startup deadline.
  candidate.state = "settled";
  candidate.error = null;
  mode = "cancel";
  const pendingOpen = manager.openTerminal(comparison.id, "A");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.pendingCandidateReadies.size, 1);
  await manager.cancel(comparison.id);
  const cancelled = await pendingOpen;
  assert.equal(cancelled.ok, false);
  assert.equal(manager.pendingCandidateReadies.size, 0);
  assert.equal(manager.terminalToComparison.has("candidate-6"), false);
  assert.notEqual(candidate.state, "ready");

  console.log(JSON.stringify({ immediate: "ready", staleDelayed: "ready", mappingFailure: "error", crashRestart: "isolated", cancellation: "cleared", terminated }));
} finally {
  // The manager owns no real process or comparison tree in this unit probe;
  // avoid invoking its full application shutdown drain here.
  await rm(root, { recursive: true, force: true });
  disposeWorldlineCoreClient();
  await stop();
}
