import { describe, it, expect } from "vitest";
/**
 * Focused runtime regressions for comparison teardown and uncertain-session
 * retention.  This deliberately imports the real WorldlineManager bundle so
 * the tests exercise its private lifecycle boundary without starting Electron.
 * Run with: node scripts/session-fork-retention-test.mjs
 */
import { build } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

describe("Session Fork Teardown and Retention Probes", () => {
  it("passes session fork teardown and retention regressions natively", async () => {
    const work = mkdtempSync(join(tmpdir(), "termina-session-retention-"));
    process.env.TERMINA_CORE_TEST = "1";
    const bundle = join(work, "worldlines.mjs");
    const retentionBundle = join(work, "session-retention.mjs");
    const sessionBundle = join(work, "agent-core-session.mjs");
    const sessionForkBundle = join(work, "session-fork.mjs");
    const sessionWorkerBundle = join(work, "session-worker.mjs");
    const RETAINED_ROOT_MARKER = ".termina-retained-session-root";
    const activeChildren = new Set();
    let sessionForkClient;
    let disposeRetentionCoreClient = null;
    let disposeWorldlineCoreClient = null;
    
    process.on("exit", () => {
      for (const child of activeChildren) {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* best-effort fixture cleanup during a failed assertion */
          }
        }
      }
    });
    
    function check(condition, message) {
      if (!condition) throw new Error(`FAIL ${message}`);
      console.log(`PASS ${message}`);
    }
    
    function deps(worldsRoot, overrides = {}) {
      return {
        worldsRoot,
        primaryRoot: worldsRoot,
        realHome: worldsRoot,
        userData: worldsRoot,
        primaryEventsDir: worldsRoot,
        bridgePath: join(worldsRoot, "bridge.ts"),
        piBin: process.execPath,
        agentCorePath: process.execPath,
        electronExecPath: process.execPath,
        candidateEnv: () => ({}),
        showThinking: () => false,
        getStore: async () => null,
        appReadPaths: () => [],
        forkSession: async () => {
          throw new Error("unexpected Pi fork");
        },
        forkCoreSession: async () => {
          throw new Error("unexpected core fork");
        },
        discardCoreSession: async () => ({ ok: true }),
        discardPiSession: async () => ({ ok: true, removed: true }),
        createCandidate: async () => ({ terminalId: "term-test", pid: 0 }),
        createCandidateWorkspace: () => join(worldsRoot, "candidate-workspace"),
        onUpdate: () => undefined,
        onCandidateState: () => undefined,
        onRemoved: () => undefined,
        preflight: async () => ({ ok: true, reasons: [] }),
        trustHashes: async () => ({}),
        captureHead: async () => ({ commit: "head", tree: "tree" }),
        capturePrimary: async () => null,
        releaseState: async () => undefined,
        terminalBusy: () => false,
        terminalVerifying: () => false,
        workspaceAt: async () => null,
        acquireWriteLease: async () => ({ ok: true }),
        releaseWriteLease: () => undefined,
        flushDirtyModels: async () => ({ ok: true }),
        canonicalPath: async (path) => path,
        mineFiles: () => new Set(),
        drainMineUpdates: async () => undefined,
        runSandboxedEvidence: async () => ({ code: 0, stdout: "", timedOut: false }),
        sourceFilesOf: async () => [],
        createEvidenceHome: async () => worldsRoot,
        removeEvidenceHome: async () => false,
        detectTestFromState: async () => null,
        benchmarkConfigFrom: async () => null,
        onEvidenceUpdate: () => undefined,
        onPromotionApply: () => undefined,
        primarySessionDir: async () => worldsRoot,
        installPromoted: async () => ({ terminalId: "term-test" }),
        ...overrides,
      };
    }
    
    function mark(dir) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, ".termina-world"), "test-marker", { mode: 0o600 });
    }
    
    function candidate(label, dir) {
      return {
        label,
        role: label === "A" ? "reference" : "alternative",
        dir: join(dir, label),
        supportDir: join(dir, `${label}-support`),
        homeDir: join(dir, `${label}-support`, "home"),
        sessionDir: join(dir, `${label}-support`, "sessions"),
        eventsDir: join(dir, `${label}-support`, "events"),
        tmpDir: join(dir, `${label}-support`, "tmp"),
        cacheDir: join(dir, `${label}-support`, "cache"),
        profilePath: join(dir, "profiles", `${label}.sb`),
        sessionFile: null,
        comparisonBaseStateId: "base",
        promotionBaseStateId: "base",
        headStateId: "head",
        headCommit: Promise.resolve(),
        terminalId: null,
        pid: null,
        lstart: null,
        state: "creating",
        version: 1,
        error: null,
      };
    }
    
    function comparison(id, dir) {
      const rootPath = realpathSync(dir);
      const rootInfo = lstatSync(rootPath, { bigint: true });
      const rootIdentity = { dev: String(rootInfo.dev), ino: String(rootInfo.ino) };
      return {
        id,
        dir,
        rootIdentity,
        rootBinding: { path: rootPath, ...rootIdentity },
        templateDir: join(dir, "template"),
        sessionWorkspaceDir: join(dir, "session-workspace"),
        sourceRunId: "run-test",
        sourceGitDir: dir,
        primaryRoot: dir,
        baseCommit: "base-commit",
        baseStateId: "base",
        inheritTrust: false,
        model: null,
        thinkingLevel: null,
        engine: "core",
        expectedCandidates: 2,
        uncertainSessionArtifacts: [],
        manifestWriteFailed: false,
        teardownPromise: null,
        removeUncertainRequested: false,
        createdAt: Date.now(),
        candidates: new Map([
          ["A", candidate("A", dir)],
          ["B", candidate("B", dir)],
        ]),
        phase: "creating",
        error: null,
        readyTimer: null,
      };
    }
    
    function seedUncertainComparison(root, id, bytes = null) {
      const dir = join(root, id);
      mark(dir);
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
          id,
          sourceRunId: "run-test",
          createdAt: Date.now(),
          status: "uncertain",
          expectedCandidates: 1,
          candidates: {},
          uncertainSessionArtifacts: [{ path: join(dir, "A-support", "sessions", "session"), error: "worker ended after commit" }],
        }),
        { mode: 0o600 },
      );
      if (bytes !== null) {
        const sparse = join(dir, "unclassified-retained-bytes.bin");
        const fd = openSync(sparse, "w", 0o600);
        try {
          ftruncateSync(fd, bytes);
        } finally {
          closeSync(fd);
        }
      }
      return dir;
    }
    
    function publishRetainedBundle(destinationSessionFile, bytes = 0) {
      mkdirSync(dirname(destinationSessionFile), { recursive: true, mode: 0o700 });
      const fd = openSync(destinationSessionFile, "w", 0o600);
      try {
        ftruncateSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    }
    
    function seedRetainedBundle(root, id, bytes = 0) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      publishRetainedBundle(join(root, id, "current", "session.jsonl"), bytes);
    }
    
    function seedRetainedLayout(root, id, { active = "{}\n", archive = null, imageBytes = null, unknownBytes = null } = {}) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const bundle = join(root, id);
      const current = join(bundle, "current");
      mkdirSync(current, { recursive: true, mode: 0o700 });
      if (active !== null) writeFileSync(join(current, "session.jsonl"), active, { mode: 0o600 });
      if (archive !== null) {
        const archived = join(bundle, "archive-test");
        mkdirSync(archived, { recursive: true, mode: 0o700 });
        writeFileSync(join(archived, "session.jsonl"), archive, { mode: 0o600 });
      }
      if (imageBytes !== null) publishRetainedBundle(join(current, "run-img-1.png"), imageBytes);
      if (unknownBytes !== null) publishRetainedBundle(join(current, "unknown.partial"), unknownBytes);
    }
    
    function seedRetainedStaging(root, id, { active = null, unknownBytes = null } = {}) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const current = join(root, id, "current");
      mkdirSync(current, { recursive: true, mode: 0o700 });
      if (active !== null) writeFileSync(join(current, "session.jsonl"), active, { mode: 0o600 });
      if (unknownBytes !== null) publishRetainedBundle(join(current, "unknown.partial"), unknownBytes);
    }
    
    function publishValidRetainedBundle(destinationSessionFile) {
      mkdirSync(dirname(destinationSessionFile), { recursive: true, mode: 0o700 });
      writeFileSync(destinationSessionFile, "{}\n", { mode: 0o600 });
    }
    
    function publishValidRetainedBundleWithImage(destinationSessionFile, imageBytes) {
      publishValidRetainedBundle(destinationSessionFile);
      publishRetainedBundle(join(dirname(destinationSessionFile), "run-img-1.png"), imageBytes);
    }
    
    async function waitForFile(path, message) {
      const deadline = Date.now() + 5_000;
      while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    
    function retentionChildCode() {
      return `
        import { existsSync, mkdirSync, writeFileSync } from "node:fs";
        import { dirname } from "node:path";
        const root = process.env.TERMINA_RETENTION_ROOT;
        const mode = process.env.TERMINA_RETENTION_MODE || "normal";
        if (mode === "pause-stale-recovery") {
          const realKill = process.kill.bind(process);
          let paused = false;
          process.kill = (pid, signal) => {
            if (!paused && signal === 0) {
              paused = true;
              writeFileSync(process.env.TERMINA_RETENTION_INSPECTED, "inspected");
              while (!existsSync(process.env.TERMINA_RETENTION_RESUME)) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
              }
            }
            return realKill(pid, signal);
          };
        }
        const { disposeSessionRetentionCoreClient, SessionRetentionOwner } = await import(process.env.TERMINA_RETENTION_BUNDLE);
        const owner = new SessionRetentionOwner(root);
        try {
          const tx = await owner.transact(process.env.TERMINA_RETENTION_RUN, async (destination) => {
            mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
            writeFileSync(destination, "{}\\n", { mode: 0o600 });
            if (mode === "hold") {
              writeFileSync(process.env.TERMINA_RETENTION_ENTERED, "entered");
              while (!existsSync(process.env.TERMINA_RETENTION_RELEASE)) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
              }
            }
            return "ok";
          });
          console.log(JSON.stringify({ ok: true, path: tx.destinationSessionFile }));
        } catch (error) {
          console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        } finally {
          disposeSessionRetentionCoreClient();
        }
      `;
    }
    
    function startRetentionChild(options) {
      const child = spawn(process.execPath, ["--no-warnings", "-e", retentionChildCode()], {
        cwd: process.cwd(),
        env: { ...process.env, TERMINA_RETENTION_BUNDLE: pathToFileURL(retentionBundle).href, ...options },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      activeChildren.add(child);
      const done = once(child, "close");
      return {
        async result() {
          const [code] = await done;
          activeChildren.delete(child);
          if (code !== 0) throw new Error(`retention child exited ${code}: ${stderr}`);
          return JSON.parse(stdout.trim());
        },
      };
    }
    
    function seedDirectoryLock(root, lockName, { pid, token, startedAt = 1 }) {
      const lock = join(root, lockName);
      mkdirSync(lock, { mode: 0o700 });
      const directory = lstatSync(lock);
      const entry = `.record-${token}-${directory.dev}-${directory.ino}`;
      writeFileSync(join(lock, entry), `${JSON.stringify({ pid, token, startedAt, dev: directory.dev, ino: directory.ino })}\n`, { mode: 0o600 });
      mkdirSync(join(lock, `.owner-${token}-${directory.dev}-${directory.ino}`), { mode: 0o700 });
    }
    
    try {
      await build({
        entryPoints: ["electron/worldlines.ts"],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: bundle,
        logLevel: "silent",
      });
      await build({
        entryPoints: ["electron/session-retention.ts"],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: retentionBundle,
        logLevel: "silent",
      });
      await build({
        entryPoints: ["agent-core/session.ts"],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: sessionBundle,
        logLevel: "silent",
      });
      const workerBundleBanner = {
        js: 'import { createRequire as __sessionForkRequire } from "node:module"; const require = __sessionForkRequire(import.meta.url);',
      };
      await Promise.all([
        build({
          entryPoints: ["electron/session-fork.ts"],
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node22",
          outfile: sessionForkBundle,
          logLevel: "silent",
        }),
        build({
          entryPoints: ["electron/session-worker.ts"],
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node22",
          outfile: sessionWorkerBundle,
          banner: workerBundleBanner,
          logLevel: "silent",
        }),
      ]);
      const { UNCERTAIN_COMPARISON_USAGE_LEDGER, WorldlineManager, disposeWorldlineCoreClient: disposeWorldlineCore } = await import(pathToFileURL(bundle).href);
      disposeWorldlineCoreClient = disposeWorldlineCore;
      const {
        disposeSessionRetentionCoreClient,
        MAX_RETAINED_SESSION_BUNDLE_BYTES,
        MAX_RETAINED_SESSION_BYTES,
        MAX_RETAINED_SESSION_BUNDLES,
        RETAINED_SESSION_ADMISSION_LOCK,
        RETAINED_SESSION_USAGE_LEDGER,
        SessionRetentionOwner,
      } = await import(pathToFileURL(retentionBundle).href);
      disposeRetentionCoreClient = disposeSessionRetentionCoreClient;
      const { writeForkedSession } = await import(pathToFileURL(sessionBundle).href);
      const { SessionForkClient } = await import(pathToFileURL(sessionForkBundle).href);
      const bootstrapWorldlineRoot = async (root) => {
        const manager = new WorldlineManager(deps(root));
        await manager.ready;
        await manager.dispose();
      };
    
      // Startup must retain every marked directory whose manifest is missing,
      // empty, partial, or still in creation. None can prove safe deletion.
      const startupRoot = join(work, "startup-worlds");
      // Let the real manager establish its durable root provenance before the
      // crash-recovery fixtures are installed below it.
      const startupBootstrap = new WorldlineManager(deps(startupRoot));
      await startupBootstrap.ready;
      await startupBootstrap.dispose();
      const startupCases = [
        ["missing", null],
        ["empty", ""],
        ["partial", "{"],
        [
          "creating",
          JSON.stringify({ id: "creating", sourceRunId: "run", createdAt: Date.now(), status: "creating", expectedCandidates: 2, candidates: {}, uncertainSessionArtifacts: [] }),
        ],
        [
          "uncertain",
          JSON.stringify({
            id: "uncertain",
            sourceRunId: "run",
            createdAt: Date.now(),
            status: "uncertain",
            expectedCandidates: 1,
            candidates: {},
            uncertainSessionArtifacts: [{ path: join(startupRoot, "uncertain", "A-support", "sessions", "session"), error: "worker ended" }],
          }),
        ],
      ];
      for (const [name, manifest] of startupCases) {
        const dir = join(startupRoot, name);
        mark(dir);
        if (manifest !== null) writeFileSync(join(dir, "manifest.json"), manifest, { mode: 0o600 });
      }
      const completeDir = join(startupRoot, "complete");
      mark(completeDir);
      writeFileSync(
        join(completeDir, "manifest.json"),
        JSON.stringify({
          id: "complete",
          sourceRunId: "run",
          createdAt: Date.now(),
          status: "complete",
          expectedCandidates: 1,
          candidates: { A: { pid: null, lstart: null, paths: [join(completeDir, "A"), join(completeDir, "A-support")] } },
          uncertainSessionArtifacts: [],
        }),
        { mode: 0o600 },
      );
      const startupManager = new WorldlineManager(deps(startupRoot));
      await startupManager.ready;
      for (const [name] of startupCases) check(existsSync(join(startupRoot, name)), `startup retains ${name} manifest evidence`);
      check(!existsSync(completeDir), "startup removes only a complete, uncertainty-free comparison");
      await startupManager.dispose();
    
      // Startup recovery must fail closed before walking an oversized adjacent
      // root. The valid stale comparison remains available instead of being
      // deleted after an unbounded enumeration.
      const sweepCapRoot = join(work, "startup-sweep-cap");
      const sweepCapBootstrap = new WorldlineManager(deps(sweepCapRoot));
      await sweepCapBootstrap.ready;
      await sweepCapBootstrap.dispose();
      const sweepCapComparison = join(sweepCapRoot, "complete-retained");
      mark(sweepCapComparison);
      writeFileSync(
        join(sweepCapComparison, "manifest.json"),
        JSON.stringify({
          id: "complete-retained",
          sourceRunId: "run",
          createdAt: Date.now(),
          status: "complete",
          expectedCandidates: 1,
          candidates: { A: { pid: null, lstart: null, paths: [join(sweepCapComparison, "A")] } },
          uncertainSessionArtifacts: [],
        }),
        { mode: 0o600 },
      );
      for (let index = 0; index < 513; index++) {
        writeFileSync(join(sweepCapRoot, `adjacent-${String(index).padStart(4, "0")}`), "adjacent", { mode: 0o600 });
      }
      const sweepCapManager = new WorldlineManager(deps(sweepCapRoot));
      await sweepCapManager.ready;
      check(existsSync(sweepCapComparison), "oversized adjacent worldline roots retain stale evidence and fail closed");
      await sweepCapManager.dispose();
    
      // A post-commit uncertain result must be persisted as an explicit durable
      // manifest, with no observable temporary manifest left behind.
      const manifestRoot = join(work, "manifest-worlds");
      const manifestManager = new WorldlineManager(deps(manifestRoot));
      await manifestManager.ready;
      const manifestDir = join(manifestRoot, "cmp-manifest");
      mark(manifestDir);
      writeFileSync(
        join(manifestDir, "manifest.json"),
        JSON.stringify({ id: "cmp-manifest", sourceRunId: "run-test", createdAt: Date.now(), status: "creating", expectedCandidates: 2, candidates: {}, uncertainSessionArtifacts: [] }),
        { mode: 0o600 },
      );
      const manifestCmp = comparison("cmp-manifest", manifestDir);
      manifestManager.comparisons.set(manifestCmp.id, manifestCmp);
      const uncertainPath = join(manifestDir, "A-support", "sessions", "session");
      const message = await manifestManager.recordUncertainSession(manifestCmp, uncertainPath, "post-commit durability was not proven");
      check(/commit uncertain/.test(message), "uncertain result remains explicit to the caller");
      const persistedManifest = JSON.parse(readFileSync(join(manifestDir, "manifest.json"), "utf8"));
      check(persistedManifest.status === "uncertain", "uncertain evidence is durably marked in the manifest");
      check(persistedManifest.uncertainSessionArtifacts?.[0]?.path === uncertainPath, "uncertain destination is persisted with the manifest");
      check(!readdirSync(manifestDir).some((name) => name.includes("manifest.json.") && name.endsWith(".tmp")), "atomic manifest replacement leaves no temporary file");
      await manifestManager.dispose();
      const restartedManifestManager = new WorldlineManager(deps(manifestRoot));
      await restartedManifestManager.ready;
      check(existsSync(manifestDir), "startup retains a durably recorded uncertain comparison after restart");
      check(restartedManifestManager.comparisons.has("cmp-manifest"), "startup rehydrates an uncertain comparison for explicit discard");
      const restartedDiscard = await restartedManifestManager.discard("cmp-manifest");
      check(restartedDiscard.ok === true && !existsSync(manifestDir), "rehydrated uncertain comparison is removable only through explicit discard");
      await restartedManifestManager.dispose();
    
      // Restarted phase:error comparisons still consume the same uncertainty
      // budget. Admission is one queue, not three independent async scans: hold
      // the first lease, materialize a fourth-to-128th uncertain comparison, and
      // prove the waiting creator observes the committed count before entering.
      const uncertaintyCountRoot = join(work, "uncertainty-count-cap");
      await bootstrapWorldlineRoot(uncertaintyCountRoot);
      for (let index = 0; index < 127; index++) {
        seedUncertainComparison(uncertaintyCountRoot, `cmp-uncertain-${String(index).padStart(3, "0")}`);
      }
      const uncertaintyCountManager = new WorldlineManager(deps(uncertaintyCountRoot));
      await uncertaintyCountManager.ready;
      check(uncertaintyCountManager.comparisons.size === 127, "restart rehydrates every uncertain comparison for admission accounting");
      const firstUncertaintyAdmission = await uncertaintyCountManager.acquireUncertainComparisonAdmission();
      check(firstUncertaintyAdmission.ok === true, "uncertain count admission reserves before materialization");
      check(existsSync(join(uncertaintyCountRoot, UNCERTAIN_COMPARISON_USAGE_LEDGER)), "uncertain admission persists its root usage ledger");
      let secondUncertaintySettled = false;
      const secondUncertaintyAdmission = uncertaintyCountManager.acquireUncertainComparisonAdmission().then((value) => {
        secondUncertaintySettled = true;
        return value;
      });
      await new Promise((resolve) => setImmediate(resolve));
      check(!secondUncertaintySettled, "a concurrent uncertain creator waits behind the canonical admission lease");
      const countClaimDir = seedUncertainComparison(uncertaintyCountRoot, "cmp-uncertain-127");
      const countClaim = comparison("cmp-uncertain-127", countClaimDir);
      countClaim.phase = "error";
      countClaim.uncertainSessionArtifacts.push({ path: join(countClaimDir, "A-support", "sessions", "session"), error: "worker ended after commit" });
      uncertaintyCountManager.comparisons.set(countClaim.id, countClaim);
      firstUncertaintyAdmission.lease.release();
      const secondUncertaintyResult = await secondUncertaintyAdmission;
      check(secondUncertaintyResult.ok === false && /128/.test(secondUncertaintyResult.error), "queued uncertain admission rejects at the restart-rehydrated count cap");
      await uncertaintyCountManager.dispose();
    
      // A cleanly released durable ledger can be damaged or truncated between
      // processes. The next owner rebuilds from the marked orphan tree instead of
      // treating corruption as an empty root.
      const corruptLedgerRoot = join(work, "uncertainty-corrupt-ledger");
      await bootstrapWorldlineRoot(corruptLedgerRoot);
      seedUncertainComparison(corruptLedgerRoot, "cmp-corrupt-ledger");
      const corruptLedgerManager = new WorldlineManager(deps(corruptLedgerRoot));
      await corruptLedgerManager.ready;
      const corruptLedgerAdmission = await corruptLedgerManager.acquireUncertainComparisonAdmission();
      check(corruptLedgerAdmission.ok === true, "corrupt-ledger fixture acquires before release");
      corruptLedgerAdmission.lease.release();
      await corruptLedgerManager.dispose();
      writeFileSync(join(corruptLedgerRoot, UNCERTAIN_COMPARISON_USAGE_LEDGER), "{", { mode: 0o600 });
      const rebuiltLedgerManager = new WorldlineManager(deps(corruptLedgerRoot));
      await rebuiltLedgerManager.ready;
      const rebuiltLedgerAdmission = await rebuiltLedgerManager.acquireUncertainComparisonAdmission();
      check(rebuiltLedgerAdmission.ok === true, "corrupt uncertain ledger rebuilds from orphan evidence");
      rebuiltLedgerAdmission.lease.release();
      await rebuiltLedgerManager.dispose();
    
      // The uncertainty budget belongs to the worlds root, not to one manager
      // instance. Two managers sharing that root must serialize the same 128th
      // admission, even when both have already rehydrated the first 127 entries.
      const sharedAdmissionRoot = join(work, "uncertainty-shared-managers");
      await bootstrapWorldlineRoot(sharedAdmissionRoot);
      for (let index = 0; index < 127; index++) {
        seedUncertainComparison(sharedAdmissionRoot, `cmp-shared-${String(index).padStart(3, "0")}`);
      }
      const sharedManagerA = new WorldlineManager(deps(sharedAdmissionRoot));
      const sharedManagerB = new WorldlineManager(deps(sharedAdmissionRoot));
      await Promise.all([sharedManagerA.ready, sharedManagerB.ready]);
      const sharedFirstPromise = sharedManagerA.acquireUncertainComparisonAdmission();
      await new Promise((resolve) => setImmediate(resolve));
      const sharedSecondPromise = sharedManagerB.acquireUncertainComparisonAdmission();
      const sharedFirst = await sharedFirstPromise;
      if (sharedFirst.ok) {
        seedUncertainComparison(sharedAdmissionRoot, "cmp-shared-materialized");
        sharedFirst.lease.release();
      }
      const sharedSecond = await sharedSecondPromise;
      const sharedAdmissions = [sharedFirst, sharedSecond];
      check(sharedAdmissions.filter((outcome) => outcome.ok).length === 1 && sharedAdmissions.some((outcome) => !outcome.ok), "uncertain admission is serialized across managers sharing one worlds root");
      if (sharedSecond.ok) sharedSecond.lease.release();
      await Promise.all([sharedManagerA.dispose(), sharedManagerB.dispose()]);
    
      // A marked directory left behind by manifest/cleanup failure is unproven
      // evidence. It is not in either manager map after startup, but it must still
      // consume both count and bytes until an identity-bound explicit discard.
      const orphanAdmissionRoot = join(work, "uncertainty-orphan-cap");
      await bootstrapWorldlineRoot(orphanAdmissionRoot);
      for (let index = 0; index < 127; index++) {
        seedUncertainComparison(orphanAdmissionRoot, `cmp-orphan-${String(index).padStart(3, "0")}`);
      }
      const orphanDir = join(orphanAdmissionRoot, "cmp-orphan-marker");
      mark(orphanDir);
      writeFileSync(join(orphanDir, "manifest.json"), "{", { mode: 0o600 });
      const orphanManager = new WorldlineManager(deps(orphanAdmissionRoot));
      await orphanManager.ready;
      const orphanAdmission = await orphanManager.acquireUncertainComparisonAdmission();
      check(orphanAdmission.ok === false && /128/.test(orphanAdmission.error), "marked orphan evidence remains in the uncertainty count cap after restart");
      await orphanManager.dispose();
    
      // A sparse unknown file is part of the full comparison tree, even when the
      // uncertainty manifest points at a session path that is not materialized.
      // The first lease is held while the tree crosses the cap; the queued second
      // admission must fail closed after it re-scans committed evidence.
      const uncertaintyByteRoot = join(work, "uncertainty-byte-cap");
      await bootstrapWorldlineRoot(uncertaintyByteRoot);
      const uncertaintyMaxBytes = 4 * 1024 * 1024 * 1024;
      const uncertaintyReserveBytes = 64 * 1024 * 1024;
      const nearByteDir = seedUncertainComparison(uncertaintyByteRoot, "cmp-uncertain-byte", uncertaintyMaxBytes - uncertaintyReserveBytes - 8192);
      const uncertaintyByteManager = new WorldlineManager(deps(uncertaintyByteRoot));
      await uncertaintyByteManager.ready;
      const firstByteAdmission = await uncertaintyByteManager.acquireUncertainComparisonAdmission();
      check(firstByteAdmission.ok === true, "uncertain byte admission reserves the durable session envelope");
      let secondByteSettled = false;
      const secondByteAdmission = uncertaintyByteManager.acquireUncertainComparisonAdmission().then((value) => {
        secondByteSettled = true;
        return value;
      });
      await new Promise((resolve) => setImmediate(resolve));
      check(!secondByteSettled, "byte-capped uncertain creators share the same admission queue");
      const nearByteFile = join(nearByteDir, "unclassified-retained-bytes.bin");
      const nearByteFd = openSync(nearByteFile, "w", 0o600);
      try {
        ftruncateSync(nearByteFd, uncertaintyMaxBytes);
      } finally {
        closeSync(nearByteFd);
      }
      firstByteAdmission.lease.release();
      const secondByteOutcome = await Promise.allSettled([secondByteAdmission]);
      const secondByteValue = secondByteOutcome[0].status === "fulfilled" ? secondByteOutcome[0].value : null;
      check(
        (secondByteOutcome[0].status === "rejected" && /4 GB/.test(String(secondByteOutcome[0].reason)))
          || (secondByteValue?.ok === false && /4 GB/.test(secondByteValue.error)),
        "queued uncertain admission rejects a sparse full-tree byte overshoot",
      );
      await uncertaintyByteManager.dispose();
    
      const shutdownAdmissionRoot = join(work, "uncertainty-shutdown");
      const shutdownAdmissionManager = new WorldlineManager(deps(shutdownAdmissionRoot));
      await shutdownAdmissionManager.ready;
      const shutdownAdmission = await shutdownAdmissionManager.acquireUncertainComparisonAdmission();
      check(shutdownAdmission.ok === true, "shutdown fixture acquires an uncertain admission lease");
      const shutdown = shutdownAdmissionManager.dispose();
      await new Promise((resolve) => setImmediate(resolve));
      shutdownAdmission.lease.release();
      await shutdown;
      check(true, "shutdown waits for and releases an in-flight uncertain admission lease");
    
      // Teardown must synchronously close admission, abort the in-flight request,
      // wait for its explicit result, and retain a late uncertain artifact.
      const teardownRoot = join(work, "teardown-worlds");
      let resolveFork;
      let forkSignal;
      const teardownManager = new WorldlineManager(
        deps(teardownRoot, {
          forkCoreSession: (_opts, callOptions) => {
            forkSignal = callOptions?.signal;
            return new Promise((resolve) => {
              resolveFork = resolve;
            });
          },
        }),
      );
      await teardownManager.ready;
      const teardownDir = join(teardownRoot, "cmp-teardown");
      mark(teardownDir);
      writeFileSync(
        join(teardownDir, "manifest.json"),
        JSON.stringify({ id: "cmp-teardown", sourceRunId: "run-test", createdAt: Date.now(), status: "creating", expectedCandidates: 2, candidates: {}, uncertainSessionArtifacts: [] }),
        { mode: 0o600 },
      );
      const teardownCmp = comparison("cmp-teardown", teardownDir);
      teardownManager.comparisons.set(teardownCmp.id, teardownCmp);
      const forkPromise = teardownManager.forkCoreSession(teardownCmp, {
        sourceSessionFile: join(work, "source", "session"),
        destinationSessionFile: join(teardownDir, "A-support", "sessions", "session"),
      });
      await new Promise((resolve) => setImmediate(resolve));
      const teardownPromise = teardownManager.teardown(teardownCmp.id, "cancelled", null);
      await new Promise((resolve) => setTimeout(resolve, 20));
      check(forkSignal?.aborted === true, "comparison teardown cooperatively cancels the in-flight fork");
      check(existsSync(teardownDir), "comparison teardown waits before deleting the owned directory");
      resolveFork({ ok: false, sessionFile: join(teardownDir, "A-support", "sessions", "session"), commit: "uncertain", error: "worker ended after commit" });
      const forkResult = await forkPromise;
      if (!forkResult.ok) await teardownManager.recordUncertainSession(teardownCmp, forkResult.sessionFile, forkResult.error);
      await teardownPromise;
      check(existsSync(teardownDir), "cancel teardown retains an explicit uncertain destination");
      check(teardownManager.comparisons.has(teardownCmp.id), "uncertain comparison remains available for explicit discard");
      await teardownManager.discard(teardownCmp.id);
      check(!existsSync(teardownDir), "explicit discard removes retained uncertainty only after the fork drains");
    
      // A successful late result must not publish a candidate after teardown has
      // closed the comparison or start a second pair leg.
      const lateRoot = join(work, "late-worlds");
      let resolveLate;
      let lateCalls = 0;
      const lateManager = new WorldlineManager(
        deps(lateRoot, {
          forkCoreSession: () => {
            lateCalls += 1;
            return new Promise((resolve) => {
              resolveLate = resolve;
            });
          },
        }),
      );
      await lateManager.ready;
      const lateDir = join(lateRoot, "cmp-late");
      mark(lateDir);
      writeFileSync(
        join(lateDir, "manifest.json"),
        JSON.stringify({ id: "cmp-late", sourceRunId: "run-test", createdAt: Date.now(), status: "creating", expectedCandidates: 2, candidates: {}, uncertainSessionArtifacts: [] }),
        { mode: 0o600 },
      );
      const lateCmp = comparison("cmp-late", lateDir);
      lateManager.comparisons.set(lateCmp.id, lateCmp);
      const pairPromise = lateManager.forkCoreSessions(lateCmp, {
        sessionBranchFile: join(work, "source", "session"),
        settledEntryId: "2",
        promptParentEntryId: "1",
      }).catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      const lateTeardown = lateManager.discard(lateCmp.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      resolveLate({ ok: true, sessionFile: join(lateDir, "A-support", "sessions", "session"), kept: 1 });
      await pairPromise;
      await lateTeardown;
      check(lateCalls === 1, "teardown prevents a late successful first leg from starting its sibling");
      check(lateCmp.candidates.get("A").sessionFile === null && lateCmp.candidates.get("B").sessionFile === null, "late success cannot publish candidate session paths");
      check(!existsSync(lateDir), "discard removes the late-success comparison only after its fork settles");
    
      await lateManager.dispose();
    
      // Admission must serialize the accounting check through publication. These
      // barriers keep both races deterministic without starting Electron.
      const countRoot = join(work, "retained-count-cap");
      const countOwner = new SessionRetentionOwner(countRoot);
      await countOwner.list();
      for (let index = 0; index < MAX_RETAINED_SESSION_BUNDLES - 1; index++) {
        seedRetainedBundle(countRoot, `existing-${String(index).padStart(3, "0")}`);
      }
      let releaseCount;
      let countEnteredResolve;
      const countEntered = new Promise((resolve) => {
        countEnteredResolve = resolve;
      });
      const firstCount = countOwner.transact("run-count-first", async (destination) => {
        countEnteredResolve();
        await new Promise((resolve) => {
          releaseCount = resolve;
        });
        publishValidRetainedBundle(destination);
        return "first";
      });
      await countEntered;
      const secondCount = countOwner.transact("run-count-second", async (destination) => {
        publishValidRetainedBundle(destination);
        return "second";
      });
      releaseCount();
      const countOutcomes = await Promise.allSettled([firstCount, secondCount]);
      check(countOutcomes[0].status === "fulfilled", "count-cap first admission publishes under the bound");
      check(countOutcomes[1].status === "rejected" && /128/.test(String(countOutcomes[1].reason)), "count-cap concurrent admission is serialized and rejects the second bundle");
      check(readdirSync(countRoot).filter((name) => name !== ".termina-retained-session-root" && name !== RETAINED_SESSION_ADMISSION_LOCK && name !== RETAINED_SESSION_USAGE_LEDGER).length === MAX_RETAINED_SESSION_BUNDLES, "count-cap transaction never exceeds 128 retained bundles");
    
      // A successful durable bundle is owned by SessionRetentionOwner after the
      // claim is removed. Worldline run eviction must be able to prove and remove
      // that bundle after a restart, otherwise count/byte capacity is permanently
      // consumed by successful finalizations.
      const discardRoot = join(work, "retained-discard-restart");
      const discardOwner = new SessionRetentionOwner(discardRoot);
      const discardTransaction = await discardOwner.transact("run-discard-restart", async (destination) => {
        publishValidRetainedBundle(destination);
        return "published";
      });
      check(discardTransaction.result === "published" && existsSync(join(discardRoot, "run-discard-restart")), "successful finalization leaves a proven retained bundle");
      const restartedDiscardOwner = new SessionRetentionOwner(discardRoot);
      const discardedBundle = await restartedDiscardOwner.discard("run-discard-restart");
      check(discardedBundle.ok === true && !existsSync(join(discardRoot, "run-discard-restart")), "restart discard removes a proven bundle through the retention owner");
    
      // Proven-bundle discard must preserve both sides of a leaf replacement
      // discovered after native validation; it may not pathname-remove the new
      // object at the same run id.
      const bundleLeafAbaRoot = join(work, "retained-bundle-leaf-aba");
      const bundleLeafReady = join(work, "retained-bundle-leaf-ready");
      const bundleLeafRelease = join(work, "retained-bundle-leaf-release");
      const bundleLeafOwner = new SessionRetentionOwner(bundleLeafAbaRoot);
      await bundleLeafOwner.transact("run-bundle-leaf-aba", async (destination) => {
        publishValidRetainedBundle(destination);
        return "published";
      });
      const bundleLeafDiscardOwner = new SessionRetentionOwner(bundleLeafAbaRoot, {
        testHooks: {
          beforeBundleRemoval: {
            stage: "promotion-cleanup-root-validated",
            readyPath: bundleLeafReady,
            releasePath: bundleLeafRelease,
          },
        },
      });
      const bundleLeafDiscard = bundleLeafDiscardOwner.discard("run-bundle-leaf-aba");
      await waitForFile(bundleLeafReady, "proven bundle leaf discard did not reach native validation");
      const bundleLeafOriginal = join(bundleLeafAbaRoot, "run-bundle-leaf-aba.original");
      renameSync(join(bundleLeafAbaRoot, "run-bundle-leaf-aba"), bundleLeafOriginal);
      seedRetainedBundle(bundleLeafAbaRoot, "run-bundle-leaf-aba");
      writeFileSync(bundleLeafRelease, "release");
      const bundleLeafDiscardResult = await bundleLeafDiscard;
      check(
        bundleLeafDiscardResult.ok === false
          && existsSync(bundleLeafOriginal)
          && existsSync(join(bundleLeafAbaRoot, "run-bundle-leaf-aba")),
        "proven bundle discard fails closed across a leaf ABA replacement",
      );
    
      // The same proof must reject an ancestor/root swap and leave the original
      // durable bundle under its original parent.
      const bundleAncestorBase = join(work, "retained-bundle-ancestor-base");
      const bundleAncestorRoot = join(bundleAncestorBase, "retained");
      const bundleAncestorReady = join(work, "retained-bundle-ancestor-ready");
      const bundleAncestorRelease = join(work, "retained-bundle-ancestor-release");
      const bundleAncestorOwner = new SessionRetentionOwner(bundleAncestorRoot);
      await bundleAncestorOwner.transact("run-bundle-ancestor-aba", async (destination) => {
        publishValidRetainedBundle(destination);
        return "published";
      });
      const bundleAncestorDiscardOwner = new SessionRetentionOwner(bundleAncestorRoot, {
        testHooks: {
          beforeBundleRemoval: {
            stage: "promotion-cleanup-root-validated",
            readyPath: bundleAncestorReady,
            releasePath: bundleAncestorRelease,
          },
        },
      });
      const bundleAncestorDiscard = bundleAncestorDiscardOwner.discard("run-bundle-ancestor-aba");
      await waitForFile(bundleAncestorReady, "proven bundle ancestor discard did not reach native validation");
      const bundleAncestorOriginalBase = `${bundleAncestorBase}.original`;
      renameSync(bundleAncestorBase, bundleAncestorOriginalBase);
      mkdirSync(bundleAncestorRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(bundleAncestorRoot, "run-bundle-ancestor-aba"), "replacement", { mode: 0o600 });
      writeFileSync(bundleAncestorRelease, "release");
      const bundleAncestorDiscardResult = await bundleAncestorDiscard;
      check(
        bundleAncestorDiscardResult.ok === false
          && existsSync(join(bundleAncestorOriginalBase, "retained", "run-bundle-ancestor-aba"))
          && existsSync(bundleAncestorRoot),
        "proven bundle discard fails closed across an ancestor/root ABA replacement",
      );
    
      // Repeated finalize/discard cycles must reclaim both count and bytes. This
      // crosses the 128-bundle bound to catch implementations that only discard
      // unresolved claims and leave successful bundles behind.
      const repeatedDiscardRoot = join(work, "retained-repeated-discard");
      const repeatedDiscardOwner = new SessionRetentionOwner(repeatedDiscardRoot);
      for (let index = 0; index < MAX_RETAINED_SESSION_BUNDLES + 2; index++) {
        const runId = `run-reclaim-${String(index).padStart(3, "0")}`;
        await repeatedDiscardOwner.transact(runId, async (destination) => {
          publishValidRetainedBundle(destination);
          return "published";
        });
        const outcome = await repeatedDiscardOwner.discard(runId);
        if (!outcome.ok) throw new Error(`FAIL repeated finalize/discard ${runId}: ${outcome.error}`);
      }
      check(
        readdirSync(repeatedDiscardRoot).filter((name) => name !== ".termina-retained-session-root" && name !== RETAINED_SESSION_ADMISSION_LOCK && name !== RETAINED_SESSION_USAGE_LEDGER).length === 0,
        "repeated finalize/discard reclaims retained count capacity beyond 128 cycles",
      );
    
      // Admission must reserve the full recursive source/output envelope before
      // publication. A 128 MiB referenced image cannot fit when the root is just
      // below 4 GiB, even though the old fixed 64 MiB projection would admit it.
      const exactImageRoot = join(work, "retained-exact-image-cap");
      const imageCurrent = Buffer.byteLength("{}\n");
      const exactImageOwner = new SessionRetentionOwner(exactImageRoot);
      await exactImageOwner.list();
      seedRetainedLayout(exactImageRoot, "existing-image-near-cap", {
        imageBytes: MAX_RETAINED_SESSION_BYTES - MAX_RETAINED_SESSION_BUNDLE_BYTES - imageCurrent - 8192,
      });
      let imagePublished = false;
      const exactImageOutcome = await Promise.allSettled([
        exactImageOwner.transact("run-exact-image", async (destination) => {
          imagePublished = true;
          publishValidRetainedBundleWithImage(destination, 128 * 1024 * 1024);
          return "unexpected";
        }, { reserveBytes: 128 * 1024 * 1024 + imageCurrent }),
      ]);
      check(exactImageOutcome[0].status === "rejected" && /4 GB/.test(String(exactImageOutcome[0].reason)), "exact recursive image bytes are reserved before retained publication");
      check(!imagePublished, "an over-cap referenced image never reaches durable publication");
    
      // A stale contender must preserve a replacement lock generation. Pausing
      // after ESRCH makes the ABA window deterministic: another process recovers
      // generation S, acquires generation N, and keeps publishing under its lock.
      const staleRoot = join(work, "retained-stale-lock");
      const staleBootstrapOwner = new SessionRetentionOwner(staleRoot);
      await staleBootstrapOwner.list();
      const stalePid = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
      if (stalePid.status !== 0) throw new Error(`could not create stale PID fixture: ${stalePid.stderr}`);
      seedDirectoryLock(staleRoot, RETAINED_SESSION_ADMISSION_LOCK, {
        pid: Number(stalePid.stdout),
        token: "stale-generation",
      });
      const staleInspected = join(work, "stale-inspected");
      const staleResume = join(work, "stale-resume");
      const replacementEntered = join(work, "replacement-entered");
      const replacementRelease = join(work, "replacement-release");
      const delayedStale = startRetentionChild({
        TERMINA_RETENTION_ROOT: staleRoot,
        TERMINA_RETENTION_RUN: "run-stale-delayed",
        TERMINA_RETENTION_MODE: "pause-stale-recovery",
        TERMINA_RETENTION_INSPECTED: staleInspected,
        TERMINA_RETENTION_RESUME: staleResume,
      });
      await waitForFile(staleInspected, "stale contender did not pause after ESRCH");
      const replacement = startRetentionChild({
        TERMINA_RETENTION_ROOT: staleRoot,
        TERMINA_RETENTION_RUN: "run-stale-replacement",
        TERMINA_RETENTION_MODE: "hold",
        TERMINA_RETENTION_ENTERED: replacementEntered,
        TERMINA_RETENTION_RELEASE: replacementRelease,
      });
      await waitForFile(replacementEntered, "replacement owner did not acquire the next lock generation");
      writeFileSync(staleResume, "resume");
      const delayedStaleResult = await delayedStale.result();
      check(!delayedStaleResult.ok && /busy|generation|changed/i.test(delayedStaleResult.error), "stale recovery rejects after the lock generation changes");
      check(existsSync(join(staleRoot, RETAINED_SESSION_ADMISSION_LOCK)), "stale recovery cannot unlink the replacement live lock");
      writeFileSync(replacementRelease, "release");
      const replacementResult = await replacement.result();
      check(replacementResult.ok, `replacement generation completes after delayed stale recovery${replacementResult.error ? `: ${replacementResult.error}` : ""}`);
    
      const byteRoot = join(work, "retained-byte-cap");
      const byteCurrent = Buffer.byteLength("{}\n");
      const byteArchive = Buffer.byteLength("{}\n");
      const byteOwner = new SessionRetentionOwner(byteRoot);
      await byteOwner.list();
      seedRetainedLayout(byteRoot, "existing-near-byte-cap", {
        archive: "{}\n",
        imageBytes: MAX_RETAINED_SESSION_BYTES - MAX_RETAINED_SESSION_BUNDLE_BYTES - byteCurrent - byteArchive,
      });
      let releaseBytes;
      let byteEnteredResolve;
      const byteEntered = new Promise((resolve) => {
        byteEnteredResolve = resolve;
      });
      const firstBytes = byteOwner.transact("run-byte-first", async (destination) => {
        byteEnteredResolve();
        await new Promise((resolve) => {
          releaseBytes = resolve;
        });
        publishValidRetainedBundle(destination);
        return "first";
      });
      await byteEntered;
      const secondBytes = byteOwner.transact("run-byte-second", async (destination) => {
        publishValidRetainedBundle(destination);
        return "second";
      });
      releaseBytes();
      const byteOutcomes = await Promise.allSettled([firstBytes, secondBytes]);
      check(byteOutcomes[0].status === "fulfilled", "byte-cap first admission publishes under the bound");
      check(byteOutcomes[1].status === "rejected" && /4 GB/.test(String(byteOutcomes[1].reason)), "byte-cap concurrent admission is serialized and rejects the second bundle");
    
      // Admission must retain and account every byte in a complete logical bundle,
      // not just the active JSONL path. Unknown and malformed state is unproven and
      // must fail closed rather than being treated as an empty bundle.
      const malformedRoot = join(work, "retained-malformed");
      const malformedOwner = new SessionRetentionOwner(malformedRoot);
      await malformedOwner.list();
      seedRetainedLayout(malformedRoot, "malformed-active", { active: "{" });
      let malformedPublished = false;
      const malformedOutcome = await Promise.allSettled([
        malformedOwner.transact("run-malformed", async (destination) => {
          malformedPublished = true;
          publishValidRetainedBundle(destination);
          return "unexpected";
        }),
      ]);
      check(malformedOutcome[0].status === "rejected" && /malformed|partial|canonical|unreadable/i.test(String(malformedOutcome[0].reason)), "malformed active session fails closed");
      check(!malformedPublished, "malformed active session never reaches publication");
    
      const missingActiveRoot = join(work, "retained-missing-active");
      const missingActiveOwner = new SessionRetentionOwner(missingActiveRoot);
      await missingActiveOwner.list();
      seedRetainedLayout(missingActiveRoot, "missing-active", { active: null });
      const missingActiveOutcome = await Promise.allSettled([
        missingActiveOwner.transact("run-missing-active", async (destination) => {
          publishValidRetainedBundle(destination);
          return "unexpected";
        }),
      ]);
      check(missingActiveOutcome[0].status === "rejected" && /missing|partial|canonical|unreadable/i.test(String(missingActiveOutcome[0].reason)), "missing active session fails closed");
    
      const unknownRoot = join(work, "retained-unknown");
      const unknownOwner = new SessionRetentionOwner(unknownRoot);
      await unknownOwner.list();
      seedRetainedLayout(unknownRoot, "unknown-entry", { unknownBytes: MAX_RETAINED_SESSION_BYTES });
      const unknownOutcome = await Promise.allSettled([
        unknownOwner.transact("run-unknown-entry", async (destination) => {
          publishValidRetainedBundle(destination);
          return "unexpected";
        }),
      ]);
      check(unknownOutcome[0].status === "rejected" && /unexpected|unknown|bound|4 GB|partial|unreadable/i.test(String(unknownOutcome[0].reason)), "unknown retained bytes fail closed instead of being ignored");
    
      const fullTreeRoot = join(work, "retained-full-tree");
      const fullTreeCurrent = Buffer.byteLength("{}\n");
      const fullTreeArchive = Buffer.byteLength("{}\n");
      const fullTreeOwner = new SessionRetentionOwner(fullTreeRoot);
      await fullTreeOwner.list();
      seedRetainedLayout(fullTreeRoot, "full-tree-near-cap", {
        archive: "{}\n",
        imageBytes: MAX_RETAINED_SESSION_BYTES - MAX_RETAINED_SESSION_BUNDLE_BYTES - fullTreeCurrent - fullTreeArchive,
      });
      const fullTreeFirst = fullTreeOwner.transact("run-full-tree-first", async (destination) => {
        publishValidRetainedBundle(destination);
        return "first";
      });
      const fullTreeSecond = fullTreeOwner.transact("run-full-tree-second", async (destination) => {
        publishValidRetainedBundle(destination);
        return "second";
      });
      const fullTreeOutcomes = await Promise.allSettled([fullTreeFirst, fullTreeSecond]);
      check(fullTreeOutcomes[0].status === "fulfilled", "full-bundle accounting admits a complete tree under the byte cap");
      check(fullTreeOutcomes[1].status === "rejected" && /4 GB/.test(String(fullTreeOutcomes[1].reason)), "full-bundle accounting includes archives and copied images at the byte cap");
    
      // The canonical session owner may retain an app-owned t-* staging sibling
      // after a successful rename when descriptor-bound cleanup is unavailable.
      // The next admission must recognize that staging shape, account its bytes,
      // and continue without treating it as a durable retained bundle.
      const stagingRoot = join(work, "retained-staging");
      const stagingOwner = new SessionRetentionOwner(stagingRoot);
      const stagingId = `t-${"a".repeat(32)}`;
      const stagingFirst = stagingOwner.transact("run-staging-first", async (destination) => {
        publishValidRetainedBundle(destination);
        seedRetainedStaging(stagingRoot, stagingId);
        return "first";
      });
      const stagingSecond = stagingOwner.transact("run-staging-second", async (destination) => {
        publishValidRetainedBundle(destination);
        return "second";
      });
      const stagingOutcomes = await Promise.allSettled([stagingFirst, stagingSecond]);
      check(stagingOutcomes[0].status === "fulfilled" && stagingOutcomes[1].status === "fulfilled", "successful fork staging does not poison the next admission");
      check(existsSync(join(stagingRoot, stagingId, "current")), "app-owned staging sibling remains retained for owner cleanup");
    
      const stagingUnknownRoot = join(work, "retained-staging-unknown");
      const stagingUnknownOwner = new SessionRetentionOwner(stagingUnknownRoot);
      await stagingUnknownOwner.list();
      seedRetainedStaging(stagingUnknownRoot, `t-${"b".repeat(32)}`, { unknownBytes: 1 });
      const stagingUnknownOutcome = await Promise.allSettled([
        stagingUnknownOwner.transact("run-staging-unknown", async (destination) => {
          publishValidRetainedBundle(destination);
          return "unexpected";
        }),
      ]);
      check(stagingUnknownOutcome[0].status === "rejected" && /unknown|unexpected|partial|unreadable/i.test(String(stagingUnknownOutcome[0].reason)), "unknown app-owned staging state fails closed");
    
      // A real core owner runs in the session worker while SessionRetentionOwner
      // holds the outer admission lease. The explicit lease token must cross that
      // boundary so the worker can compose the same generation without allowing
      // an unrelated same-process owner to bypass the lock.
      const realSourceRoot = join(work, "retained-real-source");
      const realSource = join(realSourceRoot, "source", "current", "session.jsonl");
      mkdirSync(dirname(realSource), { recursive: true, mode: 0o700 });
      writeFileSync(realSource, `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "hello" } })}\n`, { mode: 0o600 });
      const realRoot = join(work, "retained-real");
      const realOwner = new SessionRetentionOwner(realRoot);
      const realFirst = realOwner.transact("run-real-first", (destination, retentionLease) => writeForkedSession(realSource, destination, 1, { retentionLease }));
      const realSecond = realOwner.transact("run-real-second", (destination, retentionLease) => writeForkedSession(realSource, destination, 1, { retentionLease }));
      const realOutcomes = await Promise.allSettled([realFirst, realSecond]);
      check(
        realOutcomes[0].status === "fulfilled" && realOutcomes[0].value.result.ok === true
          && realOutcomes[1].status === "fulfilled" && realOutcomes[1].value.result.ok === true,
        "real retained core finalization succeeds twice with the explicit shared lease",
      );
      check(!existsSync(join(realRoot, RETAINED_SESSION_ADMISSION_LOCK)), "direct retained finalization releases the shared admission lock");
      check(readdirSync(realRoot).filter((name) => name !== ".termina-retained-session-root" && name !== ".termina-retained-session-admission.lock").filter((name) => /^t-[0-9a-f]{32}$/.test(name)).length >= 1, "real finalization staging evidence remains bounded and owned");
    
      // Exercise the actual Electron worker boundary as well as direct owner
      // coverage. The retention owner must pass its exact generation lease through
      // structured clone; the worker must not reacquire or release the outer lock.
      const workerRoot = join(work, "retained-worker");
      const workerOwner = new SessionRetentionOwner(workerRoot);
      sessionForkClient = new SessionForkClient();
      const workerFirst = workerOwner.transact("run-worker-first", (destination, retentionLease) => sessionForkClient.forkCore({
        sourceSessionFile: realSource,
        destinationSessionFile: destination,
        throughSeq: 1,
        retentionLease,
      }));
      const workerSecond = workerOwner.transact("run-worker-second", (destination, retentionLease) => sessionForkClient.forkCore({
        sourceSessionFile: realSource,
        destinationSessionFile: destination,
        throughSeq: 1,
        retentionLease,
      }));
      const workerOutcomes = await Promise.allSettled([workerFirst, workerSecond]);
      check(
        workerOutcomes[0].status === "fulfilled" && workerOutcomes[0].value.result.ok === true
          && workerOutcomes[1].status === "fulfilled" && workerOutcomes[1].value.result.ok === true,
        "real worker retained core finalization succeeds twice with the shared generation lease",
      );
      await sessionForkClient.dispose();
      sessionForkClient = null;
      check(!existsSync(join(workerRoot, RETAINED_SESSION_ADMISSION_LOCK)), "worker retained finalization releases the shared admission lock");
    
      // Exercise the complete production lifecycle repeatedly. Every successful
      // worker finalize is followed by the canonical proven-bundle discard; the
      // owner marker must let discard reclaim any app-owned t-* staging sibling,
      // so 130 cycles cannot consume the 128-entry staging admission budget.
      const workerCycleRoot = join(work, "retained-worker-cycles");
      const workerCycleOwner = new SessionRetentionOwner(workerCycleRoot);
      sessionForkClient = new SessionForkClient();
      for (let index = 0; index < 130; index++) {
        const runId = `run-worker-cycle-${String(index).padStart(3, "0")}`;
        const finalized = await workerCycleOwner.transact(runId, (destination, retentionLease) => sessionForkClient.forkCore({
          sourceSessionFile: realSource,
          destinationSessionFile: destination,
          throughSeq: 1,
          retentionLease,
        }));
        if (finalized.result.ok !== true) throw new Error(`FAIL real worker finalize cycle ${index + 1}: ${finalized.result.error ?? "unknown error"}`);
        const cycleStaging = readdirSync(workerCycleRoot).filter((name) => /^t-[0-9a-f]{32}$/.test(name));
        if (!cycleStaging.every((name) => existsSync(join(workerCycleRoot, name, ".termina-retained-staging-owner.json")))) {
          throw new Error(`FAIL real worker finalize cycle ${index + 1}: staging ownership evidence is missing`);
        }
        const discarded = await workerCycleOwner.discard(runId);
        if (!discarded.ok) throw new Error(`FAIL real worker discard cycle ${index + 1}: ${discarded.error ?? "unknown error"}`);
      }
      await sessionForkClient.dispose();
      sessionForkClient = null;
      check(
        readdirSync(workerCycleRoot).filter((name) => name !== ".termina-retained-session-root" && name !== RETAINED_SESSION_ADMISSION_LOCK && !name.startsWith(".termina-promotion-cleanup-")).filter((name) => /^t-[0-9a-f]{32}$/.test(name)).length === 0,
        "130 real worker finalize/discard cycles leave no retained staging siblings",
      );
      check(!existsSync(join(workerCycleRoot, RETAINED_SESSION_ADMISSION_LOCK)), "130 real worker cycles release the shared admission lock");
    
      // Comparison ids are allocated below the bound physical worlds root with an
      // exclusive native create. A restarted manager and a second manager must
      // skip persisted cmp-1 rather than reopening it or replacing its manifest.
      const comparisonAllocationRoot = join(work, "comparison-allocation");
      const comparisonManagerA = new WorldlineManager(deps(comparisonAllocationRoot));
      await comparisonManagerA.ready;
      const persistedComparison = seedUncertainComparison(comparisonAllocationRoot, "cmp-1");
      const admissionA = await comparisonManagerA.acquireUncertainComparisonAdmission();
      check(admissionA.ok, "comparison allocation acquires the root-scoped admission lease");
      const allocatedA = await comparisonManagerA.allocateComparisonDirectory();
      admissionA.lease.release();
      check(allocatedA.id !== "cmp-1" && existsSync(persistedComparison), "comparison allocation skips persisted cmp-1 without overwriting it");
      const persistedCmpManifest = JSON.parse(readFileSync(join(persistedComparison, "manifest.json"), "utf8"));
      check(persistedCmpManifest.id === "cmp-1" && persistedCmpManifest.status === "uncertain", "persisted cmp-1 uncertainty manifest remains unchanged");
      writeFileSync(join(persistedComparison, "nested-proof.bin"), "nested mutation", { mode: 0o600 });
      const nestedAdmission = await comparisonManagerA.acquireUncertainComparisonAdmission();
      check(nestedAdmission.ok, "nested uncertain-tree mutation rebuilds exact usage before admission");
      if (nestedAdmission.ok) nestedAdmission.lease.release();
    
      const comparisonManagerB = new WorldlineManager(deps(comparisonAllocationRoot));
      await comparisonManagerB.ready;
      const allocateConcurrently = async (manager) => {
        const admission = await manager.acquireUncertainComparisonAdmission();
        if (!admission.ok) throw new Error(admission.error);
        try {
          return await manager.allocateComparisonDirectory();
        } finally {
          admission.lease.release();
        }
      };
      const allocatedConcurrent = await Promise.all([
        allocateConcurrently(comparisonManagerA),
        allocateConcurrently(comparisonManagerB),
      ]);
      check(
        new Set(allocatedConcurrent.map((allocation) => allocation.id)).size === 2
          && allocatedConcurrent.every((allocation) => allocation.id !== "cmp-1"),
        "concurrent comparison creators receive distinct no-replace ids",
      );
      await Promise.all([comparisonManagerA.dispose(), comparisonManagerB.dispose()]);
      const comparisonManagerRestart = new WorldlineManager(deps(comparisonAllocationRoot));
      await comparisonManagerRestart.ready;
      const restartAdmission = await comparisonManagerRestart.acquireUncertainComparisonAdmission();
      check(restartAdmission.ok, "restarted manager acquires the comparison allocation lease");
      const allocatedRestart = await comparisonManagerRestart.allocateComparisonDirectory();
      restartAdmission.lease.release();
      check(allocatedRestart.id !== "cmp-1" && existsSync(persistedComparison), "restart allocation remains collision-proof against cmp-1");
      await comparisonManagerRestart.dispose();
    
      // If the configured worlds-root pathname is replaced after binding, native
      // allocation must reject the replacement rather than writing cmp-1 there.
      const rootAbaBase = join(work, "comparison-root-aba");
      const rootAbaRoot = join(rootAbaBase, "worlds");
      mkdirSync(rootAbaBase, { recursive: true, mode: 0o700 });
      const rootAbaManager = new WorldlineManager(deps(rootAbaRoot));
      await rootAbaManager.ready;
      const rootAbaOriginal = `${rootAbaRoot}.original`;
      renameSync(rootAbaRoot, rootAbaOriginal);
      mkdirSync(rootAbaRoot, { recursive: true, mode: 0o700 });
      const rootAbaAdmission = await rootAbaManager.acquireUncertainComparisonAdmission();
      check(!rootAbaAdmission.ok && /identity|root|promotion/i.test(rootAbaAdmission.error), "worldline-root ABA fails before acquiring an admission lease");
      check(!existsSync(join(rootAbaRoot, UNCERTAIN_COMPARISON_USAGE_LEDGER)), "worldline-root ABA does not publish an admission ledger in the replacement");
      await rootAbaManager.dispose();
    
      // Root provenance must survive a process boundary while a replacement that
      // copies only the mutable marker is rejected by the next owner process.
      const provenanceRestartRoot = join(work, "retained-provenance-restart");
      const provenanceOwner = new SessionRetentionOwner(provenanceRestartRoot);
      await provenanceOwner.list();
      const restartedRetention = startRetentionChild({
        TERMINA_RETENTION_ROOT: provenanceRestartRoot,
        TERMINA_RETENTION_RUN: "run-provenance-restart",
      });
      const restartedRetentionResult = await restartedRetention.result();
      check(restartedRetentionResult.ok, "retained root provenance permits a legitimate owner restart");
      const copiedMarkerRoot = join(work, "retained-provenance-copied");
      mkdirSync(copiedMarkerRoot, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(copiedMarkerRoot, RETAINED_ROOT_MARKER),
        readFileSync(join(provenanceRestartRoot, RETAINED_ROOT_MARKER)),
        { mode: 0o600 },
      );
      const copiedMarkerRetention = startRetentionChild({
        TERMINA_RETENTION_ROOT: copiedMarkerRoot,
        TERMINA_RETENTION_RUN: "run-copied-marker",
      });
      const copiedMarkerRetentionResult = await copiedMarkerRetention.result();
      check(!copiedMarkerRetentionResult.ok && /provenance|marker|identity|root/i.test(copiedMarkerRetentionResult.error), "copied-marker retained root is rejected after restart");
    
      // A second owner instance cannot bypass the durable lock while the first
      // owner is publishing. Electron normally prevents this with its
      // single-instance lock; this remains a fail-closed defense for shared roots.
      const processRoot = join(work, "retained-process-lock");
      const processOwnerA = new SessionRetentionOwner(processRoot);
      const processOwnerB = new SessionRetentionOwner(processRoot);
      let releaseProcess;
      let processEnteredResolve;
      const processEntered = new Promise((resolve) => {
        processEnteredResolve = resolve;
      });
      const processFirst = processOwnerA.transact("run-process-first", async (destination) => {
        processEnteredResolve();
        await new Promise((resolve) => {
          releaseProcess = resolve;
        });
        publishRetainedBundle(destination, 1);
        return "first";
      });
      await processEntered;
      const processSecond = processOwnerB.transact("run-process-second", async () => "second");
      const processSecondOutcome = await Promise.allSettled([processSecond]);
      check(processSecondOutcome[0].status === "rejected" && /busy/.test(String(processSecondOutcome[0].reason)), "independent retained-session owner cannot bypass the admission lock");
      releaseProcess();
      await processFirst;
    
      console.log("PASS session-fork teardown/retention regressions");
    } finally {
      await sessionForkClient?.dispose();
      disposeRetentionCoreClient?.();
      disposeWorldlineCoreClient?.();
      rmSync(work, { recursive: true, force: true });
    }
  }, 180_000);
});
