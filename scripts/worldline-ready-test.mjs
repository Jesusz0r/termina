import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// This composes the production WorldlineManager bundle with a deliberately
// unbound existing root. Its readiness rejection must be observed and all
// public reads must fail closed instead of creating an unhandled rejection.
const root = await mkdtemp(join(tmpdir(), "termina-worldline-ready-"));
const worldsRoot = join(root, "worlds");
const primaryRoot = join(root, "primary");
const bundle = join(root, "worldlines.mjs");
await mkdir(worldsRoot);
await mkdir(primaryRoot);
await build({ entryPoints: ["electron/worldlines.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: bundle, logLevel: "silent" });
const { WorldlineManager } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);

const noopStore = null;
const deps = {
  worldsRoot,
  primaryRoot,
  realHome: root,
  userData: root,
  primaryEventsDir: root,
  bridgePath: join(root, "bridge.js"),
  piBin: process.execPath,
  agentCorePath: join(root, "agent-core.mjs"),
  electronExecPath: process.execPath,
  candidateEnv: () => ({}),
  showThinking: () => false,
  getStore: async () => noopStore,
  appReadPaths: () => [],
  forkSession: async () => ({ ok: false, error: "unused" }),
  forkCoreSession: async () => ({ ok: false, error: "unused" }),
  discardCoreSession: async () => ({ ok: false, error: "unused" }),
  createCandidate: async () => ({ terminalId: "unused", pid: 0 }),
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

let unhandled = null;
const onUnhandled = (reason) => { unhandled = reason; };
process.on("unhandledRejection", onUnhandled);
try {
  const manager = new WorldlineManager(deps);
  const listed = await manager.list();
  assert.deepEqual(listed, [], "readiness failure must produce an empty listing");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unhandled, null, `readiness failure was unhandled: ${String(unhandled)}`);
  await manager.dispose().catch(() => {});
  console.log("worldline ready failure checks passed");
} finally {
  process.off("unhandledRejection", onUnhandled);
  await rm(root, { recursive: true, force: true });
}
