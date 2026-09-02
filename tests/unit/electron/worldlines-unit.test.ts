import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WorldlineManager, disposeWorldlineCoreClient } from "../../../electron/worldlines.ts";

const execFileAsync = promisify(execFile);

describe("Worldline Manager, Core Client & Retention Performance Unit Suite", () => {
  async function runScript(scriptName: string, timeout = 90_000) {
    const scriptPath = resolve("scripts", scriptName);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINA_CORE_TEST: "1",
          TERMINA_CORE_BIN: resolve("core", "target", "release", "termina-core"),
        },
        timeout,
      },
    );
    return { stdout, stderr };
  }

  it("passes worldline ready failure checks natively", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-worldline-ready-"));
    const worldsRoot = join(root, "worlds");
    const primaryRoot = join(root, "primary");
    await mkdir(worldsRoot);
    await mkdir(primaryRoot);

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
      getStore: async () => null,
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
      canonicalPath: async (path: string) => path,
      mineFiles: () => new Set<string>(),
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

    let unhandled: any = null;
    const onUnhandled = (reason: any) => { unhandled = reason; };
    process.on("unhandledRejection", onUnhandled);
    try {
      const manager = new WorldlineManager(deps as any);
      const listed = await manager.list();
      expect(listed).toEqual([]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toBeNull();
      await manager.dispose().catch(() => {});
    } finally {
      process.off("unhandledRejection", onUnhandled);
      disposeWorldlineCoreClient();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes worldline reopen flow contracts", async () => {
    const { stdout } = await runScript("worldline-reopen-flow-test.mjs");
    expect(stdout).toContain("cancellation");
  });

  it("passes ipc/project flow probes", async () => {
    const { stdout } = await runScript("ipc-project-flow-test.mjs");
    expect(stdout).toContain("22/22 passed");
  });

  it("passes core client read budget gate", async () => {
    const { stdout } = await runScript("core-client-read-budget-test.mjs");
    expect(stdout).toContain("PASS");
  });

  it("passes retention ledger focused performance regressions", async () => {
    const { stdout } = await runScript("session-retention-performance-test.mjs", 120_000);
    expect(stdout).toContain("PASS retention-ledger focused regressions");
  }, 120_000);

  it("passes worldline runtime teardown & candidate flow", async () => {
    const { stdout } = await runScript("worldline-runtime-flow-test.mjs", 120_000);
    expect(stdout).toContain("freshCancel");
  }, 120_000);
});
