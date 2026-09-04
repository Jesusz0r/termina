import { describe, it, expect } from "vitest";
/**
 * Focused retention-ledger performance regressions.
 *
 * Run with: TERMINA_CORE_TEST=1 node --experimental-strip-types --no-warnings
 * scripts/session-retention-performance-test.mjs
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

describe("Session Retention Performance Probes", () => {
  it("passes retention ledger focused performance regressions natively", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    const work = mkdtempSync(join(tmpdir(), "termina-retention-ledger-test-"));
    const retentionBundle = join(work, "session-retention.mjs");
    const worldlineBundle = join(work, "worldlines.mjs");
    
    function writeBundle(path, records = 8) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, "w", 0o600);
      try {
        for (let index = 1; index <= records; index++) {
          writeFileSync(fd, `${JSON.stringify({ storageSeq: index, type: "message", message: { role: "user", content: `record-${index}` } })}\n`);
        }
      } finally {
        closeSync(fd);
      }
    }
    
    try {
      await Promise.all([
        build({ entryPoints: ["electron/session-retention.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: retentionBundle, logLevel: "silent" }),
        build({ entryPoints: ["electron/worldlines.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: worldlineBundle, logLevel: "silent" }),
      ]);
      const { SessionRetentionOwner, RETAINED_SESSION_USAGE_LEDGER, disposeSessionRetentionCoreClient } = await import(pathToFileURL(retentionBundle).href);
      assert.equal(typeof RETAINED_SESSION_USAGE_LEDGER, "string");
    
      const source = join(work, "source", "source", "current", "session.jsonl");
      writeBundle(source, 2048);
      const root = join(work, "retained");
      const owner = new SessionRetentionOwner(root);
      let heartbeatTicks = 0;
      let heartbeat;
      const pulse = () => {
        heartbeatTicks++;
        heartbeat = setImmediate(pulse);
      };
      heartbeat = setImmediate(pulse);
      const estimate = owner.estimateForkedSessionBytes(source);
      assert.equal(typeof estimate?.then, "function", "source estimation is asynchronous");
      const estimatedBytes = await estimate;
      clearImmediate(heartbeat);
      assert.ok(estimatedBytes > 0);
      assert.ok(heartbeatTicks > 0, "large source accounting yields to the event loop");
    
      await owner.transact("ledger-first", async (destination) => {
        writeBundle(destination, 2);
        writeFileSync(join(dirname(destination), "ledger-first-img-1.png"), "image", { mode: 0o600 });
        return "ok";
      });
      assert.ok(existsSync(join(root, RETAINED_SESSION_USAGE_LEDGER)), "retention transaction persists its usage ledger");
      const initialLedger = JSON.parse(readFileSync(join(root, RETAINED_SESSION_USAGE_LEDGER), "utf8"));
      assert.equal(initialLedger.version, 1);
      assert.equal(initialLedger.accounting.bundleCount, 1);
      assert.equal(initialLedger.accounting.stagingCount, 0);
      assert.equal(initialLedger.accounting.images, 1);
      assert.equal(initialLedger.accounting.unknowns, 0);
    
      // A forged but internally consistent under-count must not survive proof
      // verification. The unchanged tree proof is intentionally retained so this
      // catches accounting-field validation rather than only mutation detection.
      const forgedLedger = JSON.parse(JSON.stringify(initialLedger));
      const forgedEntry = forgedLedger.entries.find((entry) => entry.name === "ledger-first");
      forgedEntry.usage = { bytes: 0, entries: 0, images: 0, unknowns: 0 };
      forgedLedger.accounting = { bytes: 0, entries: 0, images: 0, unknowns: 0, bundleCount: 1, stagingCount: 0 };
      writeFileSync(join(root, RETAINED_SESSION_USAGE_LEDGER), JSON.stringify(forgedLedger), { mode: 0o600 });
      await owner.transact("forged-usage-rebuild", async (destination) => {
        writeBundle(destination, 1);
        return "rebuilt";
      });
      const rebuiltAfterForgery = JSON.parse(readFileSync(join(root, RETAINED_SESSION_USAGE_LEDGER), "utf8"));
      const rebuiltEntry = rebuiltAfterForgery.entries.find((entry) => entry.name === "ledger-first");
      assert.ok(rebuiltEntry.usage.bytes > 0 && rebuiltEntry.usage.entries > 0, "forged retained usage fields rebuild from measured bytes and entries");
      assert.equal(rebuiltEntry.usage.images, 1, "forged retained image count rebuilds from the measured tree");
    
      // A nested mutation must invalidate the durable proof even when the
      // retained bundle directory itself keeps the same identity.
      const nestedSession = join(root, "ledger-first", "current", "session.jsonl");
      writeBundle(nestedSession, 3);
      let nestedPublished = false;
      await assert.doesNotReject(
        owner.transact("nested-mutation", async (destination) => {
          nestedPublished = true;
          writeBundle(destination, 1);
          return "rebuilt";
        }),
      );
      assert.equal(nestedPublished, true, "nested mutation rebuilds before the next admission");
      const rebuiltAfterNestedMutation = JSON.parse(readFileSync(join(root, RETAINED_SESSION_USAGE_LEDGER), "utf8"));
      assert.ok(rebuiltAfterNestedMutation.accounting.entries > initialLedger.accounting.entries, "nested mutation changes rebuilt exact accounting");
    
      // A corrupted ledger is rebuilt safely rather than trusted or silently
      // treated as empty.
      writeFileSync(join(root, RETAINED_SESSION_USAGE_LEDGER), "{", { mode: 0o600 });
      const rebuilt = await owner.list();
      assert.deepEqual(rebuilt, [], "a corrupt ledger rebuilds from durable evidence");
    
      // Two independent owners share the durable root lock and ledger. The
      // second transaction must wait for and account after the first one without
      // a second recursive scan of the retained bundle.
      const concurrentRoot = join(work, "concurrent-retained");
      const concurrentA = new SessionRetentionOwner(concurrentRoot);
      const concurrentB = new SessionRetentionOwner(concurrentRoot);
      let concurrentEntered = 0;
      const concurrentResults = await Promise.allSettled([
        concurrentA.transact("concurrent-a", async (destination) => {
          concurrentEntered++;
          writeBundle(destination, 1);
          return "a";
        }),
        concurrentB.transact("concurrent-b", async (destination) => {
          concurrentEntered++;
          writeBundle(destination, 1);
          return "b";
        }),
      ]);
      assert.equal(concurrentResults.length, 2);
      assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1, "the shared lock rejects a concurrent second owner");
      assert.equal(concurrentEntered, 1);
      assert.ok(existsSync(join(concurrentRoot, "concurrent-a")) || existsSync(join(concurrentRoot, "concurrent-b")));
      const followupRun = existsSync(join(concurrentRoot, "concurrent-a")) ? "concurrent-b" : "concurrent-a";
      await concurrentB.transact(followupRun, async (destination) => {
        writeBundle(destination, 1);
        return "followup";
      });
      assert.equal(concurrentEntered, 1, "the rejected owner never entered the first callback");
      const reclaimed = await concurrentA.discard("concurrent-a");
      assert.equal(reclaimed.ok, true, "ledger-backed explicit reclaim removes a proven bundle");
      assert.equal(existsSync(join(concurrentRoot, "concurrent-a")), false);
    
      // Root enumeration is bounded before a large names array can be allocated;
      // the evidence remains untouched and admission fails closed.
      const capRoot = join(work, "retained-root-cap");
      const capOwner = new SessionRetentionOwner(capRoot);
      await capOwner.list();
      for (let index = 0; index < 513; index++) {
        writeFileSync(join(capRoot, `orphan-${String(index).padStart(4, "0")}`), "orphan", { mode: 0o600 });
      }
      let capPublished = false;
      await assert.rejects(
        capOwner.transact("cap-run", async (destination) => {
          capPublished = true;
          writeBundle(destination, 1);
          return "unexpected";
        }),
        /too many entries|root/i,
      );
      assert.equal(capPublished, false, "root-entry cap rejects before publication");
    
      // A deep claimed tree must fail closed at the explicit scanner depth bound;
      // it may not grow an unbounded pending stack while proving a claim.
      const deepRoot = join(work, "retained-deep-scan");
      const deepOwner = new SessionRetentionOwner(deepRoot);
      await deepOwner.list();
      const deepClaim = join(deepRoot, ".termina-retained-claim-deep-scan.json");
      const deepDestination = join(deepRoot, "deep-scan");
      let deepPath = deepDestination;
      for (let depth = 0; depth < 80; depth++) {
        deepPath = join(deepPath, `level-${String(depth).padStart(3, "0")}`);
        mkdirSync(deepPath, { recursive: true, mode: 0o700 });
      }
      writeFileSync(join(deepPath, "unknown.bin"), "deep", { mode: 0o600 });
      writeFileSync(deepClaim, JSON.stringify({ runId: "deep-scan", createdAt: Date.now() }), { mode: 0o600 });
      await assert.rejects(deepOwner.list(), /depth|too many|unreadable|evidence/i, "deep retained claim scan fails closed");
    
      // Normal runtime rejects an existing unproven retained root. The explicit
      // durable-format migration binds its captured identity and publishes
      // outside-root provenance that remains valid after a native-core restart.
      const legacyRoot = join(work, "retained-migration");
      mkdirSync(legacyRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(legacyRoot, ".termina-retained-session-root"), ".termina-retained-session-root\n", { mode: 0o600 });
      writeBundle(join(legacyRoot, "migration-session", "current", "session.jsonl"), 2);
      const legacyAbsolute = realpathSync(legacyRoot);
      const strictOwner = new SessionRetentionOwner(legacyRoot);
      await assert.rejects(strictOwner.list(), /previously trusted expectedIdentity/, "normal runtime rejects an unproven retained root");
      const legacyOwner = new SessionRetentionOwner(legacyRoot);
      await legacyOwner.migrateRoot();
      await assert.doesNotReject(legacyOwner.list(), "the format migration binds the captured retained-root identity");
      const legacyProvenance = readdirSync(dirname(legacyRoot)).find((name) => {
        if (!name.startsWith(".termina-promotion-root-") || !name.endsWith(".json")) return false;
        try {
          return JSON.parse(readFileSync(join(dirname(legacyRoot), name), "utf8")).path === legacyAbsolute;
        } catch {
          return false;
        }
      });
      assert.ok(legacyProvenance, "format migration persists provenance outside the retained root");
      const legacyProvenanceRecord = JSON.parse(readFileSync(join(dirname(legacyRoot), legacyProvenance), "utf8"));
      assert.equal(legacyProvenanceRecord.version, 1, "migrated provenance uses the canonical durable version");
      assert.equal(legacyProvenanceRecord.path, legacyAbsolute, "migrated provenance binds the exact retained root path");
      assert.equal(legacyProvenanceRecord.root.dev, String(lstatSync(legacyRoot, { bigint: true }).dev), "migrated provenance binds the root device");
      assert.equal(legacyProvenanceRecord.root.ino, String(lstatSync(legacyRoot, { bigint: true }).ino), "migrated provenance binds the root inode");
      const legacyState = join(dirname(legacyRoot), `${legacyProvenance}.state`);
      assert.equal(existsSync(legacyState), true, "format migration leaves a durable outside-root state tombstone");
      const legacyRestart = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
        const { SessionRetentionOwner, disposeSessionRetentionCoreClient } = await import(process.env.TERMINA_RETENTION_BUNDLE);
        const owner = new SessionRetentionOwner(process.env.TERMINA_RETENTION_ROOT);
        await owner.list();
        disposeSessionRetentionCoreClient();
      `], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINA_CORE_TEST: "1",
          TERMINA_RETENTION_BUNDLE: pathToFileURL(retentionBundle).href,
          TERMINA_RETENTION_ROOT: legacyRoot,
        },
        encoding: "utf8",
      });
      assert.equal(legacyRestart.status, 0, `adopted legacy root survives native core restart: ${legacyRestart.stderr}`);
    
      function freshRetentionList(rootPath) {
        return spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
          const { SessionRetentionOwner, disposeSessionRetentionCoreClient } = await import(process.env.TERMINA_RETENTION_BUNDLE);
          try {
            await new SessionRetentionOwner(process.env.TERMINA_RETENTION_ROOT).list();
            process.exitCode = 0;
          } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 17;
          } finally {
            disposeSessionRetentionCoreClient();
          }
        `], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERMINA_CORE_TEST: "1",
            TERMINA_RETENTION_BUNDLE: pathToFileURL(retentionBundle).href,
            TERMINA_RETENTION_ROOT: rootPath,
          },
          encoding: "utf8",
        });
      }
    
      // Final retained metadata and the mutable marker must never be hardlinks:
      // one same-user alias would let an unrelated pathname mutate the bytes
      // after the descriptor-bound read. The native readers reject the alias
      // before the root is admitted.
      const legacyMarkerHardlink = join(dirname(legacyRoot), `${legacyProvenance}.marker-hardlink`);
      linkSync(join(legacyRoot, ".termina-retained-session-root"), legacyMarkerHardlink);
      const hardlinkedMarkerRestart = freshRetentionList(legacyRoot);
      const hardlinkedMarkerOutput = `${hardlinkedMarkerRestart.stdout}\n${hardlinkedMarkerRestart.stderr}`;
      assert.equal(hardlinkedMarkerRestart.error, undefined, `hardlinked retained marker restart failed to spawn: ${hardlinkedMarkerOutput}`);
      assert.notEqual(hardlinkedMarkerRestart.status, 0, `hardlinked retained marker fails closed: ${hardlinkedMarkerOutput}`);
      assert.match(hardlinkedMarkerOutput, /private|regular|link|marker|root/i, "hardlinked marker rejection identifies the untrusted metadata");
      rmSync(legacyMarkerHardlink, { force: true });
      const legacyProvenanceHardlink = join(dirname(legacyRoot), `${legacyProvenance}.hardlink`);
      linkSync(join(dirname(legacyRoot), legacyProvenance), legacyProvenanceHardlink);
      const hardlinkedProvenanceRestart = freshRetentionList(legacyRoot);
      const hardlinkedProvenanceOutput = `${hardlinkedProvenanceRestart.stdout}\n${hardlinkedProvenanceRestart.stderr}`;
      assert.equal(hardlinkedProvenanceRestart.error, undefined, `hardlinked retained provenance restart failed to spawn: ${hardlinkedProvenanceOutput}`);
      assert.notEqual(hardlinkedProvenanceRestart.status, 0, `hardlinked retained provenance fails closed: ${hardlinkedProvenanceOutput}`);
      assert.match(hardlinkedProvenanceOutput, /private|regular|link|provenance|root/i, "hardlinked provenance rejection identifies the untrusted metadata");
      rmSync(legacyProvenanceHardlink, { force: true });
    
      // A deterministic pending-state temporary is still untrusted metadata: a
      // same-user hardlink must not be adopted as the transaction's recovery
      // record. This exercises the initial state publisher before a final state
      // exists, not only the already-bound provenance path above.
      const hardlinkedTempRoot = join(work, "retained-hardlinked-temp");
      mkdirSync(hardlinkedTempRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(hardlinkedTempRoot, ".termina-retained-session-root"), ".termina-retained-session-root\n", { mode: 0o600 });
      writeBundle(join(hardlinkedTempRoot, "hardlinked-session", "current", "session.jsonl"), 1);
      const hardlinkedTempAbsolute = realpathSync(hardlinkedTempRoot);
      const hardlinkedTempDigest = createHash("sha256").update(hardlinkedTempAbsolute).digest("hex");
      const hardlinkedTempProvenance = join(dirname(hardlinkedTempRoot), `.termina-promotion-root-${hardlinkedTempDigest}.json`);
      const hardlinkedStateTemp = `${hardlinkedTempProvenance}.state.tmp`;
      const hardlinkedSeed = join(work, "retained-hardlinked-state-seed");
      writeFileSync(hardlinkedSeed, "not-a-state", { mode: 0o600 });
      linkSync(hardlinkedSeed, hardlinkedStateTemp);
      const hardlinkedTempRestart = freshRetentionList(hardlinkedTempRoot);
      const hardlinkedTempOutput = `${hardlinkedTempRestart.stdout}\n${hardlinkedTempRestart.stderr}`;
      assert.equal(hardlinkedTempRestart.error, undefined, `hardlinked pending-state temporary restart failed to spawn: ${hardlinkedTempOutput}`);
      assert.notEqual(hardlinkedTempRestart.status, 0, `hardlinked pending-state temporary fails closed: ${hardlinkedTempOutput}`);
      assert.match(hardlinkedTempOutput, /private|regular|link|state|temporary|root/i, "hardlinked state rejection identifies the untrusted metadata");
      rmSync(hardlinkedStateTemp, { force: true });
      rmSync(hardlinkedSeed, { force: true });
    
      // Losing the final provenance sidecar must not reopen the one-time legacy
      // adoption path. A fresh owner process must fail closed even though the
      // mutable marker and app-owned evidence are still present.
      rmSync(join(dirname(legacyRoot), legacyProvenance), { force: true });
      assert.equal(existsSync(legacyState), true, "provenance deletion does not remove the durable state tombstone");
      const legacyAfterProvenanceLoss = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
        const { SessionRetentionOwner, disposeSessionRetentionCoreClient } = await import(process.env.TERMINA_RETENTION_BUNDLE);
        try {
          await new SessionRetentionOwner(process.env.TERMINA_RETENTION_ROOT).list();
          process.exitCode = 0;
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 17;
        } finally {
          disposeSessionRetentionCoreClient();
        }
      `], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINA_CORE_TEST: "1",
          TERMINA_RETENTION_BUNDLE: pathToFileURL(retentionBundle).href,
          TERMINA_RETENTION_ROOT: legacyRoot,
        },
        encoding: "utf8",
      });
      assert.notEqual(legacyAfterProvenanceLoss.status, 0, `provenance loss never re-enters legacy adoption: ${legacyAfterProvenanceLoss.stdout} ${legacyAfterProvenanceLoss.stderr}`);
    
      // Killing a native binder at each durable transaction seam must leave a
      // restartable pending state, never a marker-only root that strands the
      // retained root permanently. The pre-state create seam is deliberately
      // deterministic rejection: it leaves only an empty, marker-less leaf, not
      // a valid root whose identity could be guessed on the next startup.
      async function runKilledRootBind(stage, root, expectRestartable = true) {
        const ready = join(work, `retained-root-crash-${stage}.ready`);
        const release = join(work, `retained-root-crash-${stage}.release`);
        const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
          const { SessionRetentionOwner, disposeSessionRetentionCoreClient } = await import(process.env.TERMINA_RETENTION_BUNDLE);
          const owner = new SessionRetentionOwner(process.env.TERMINA_RETENTION_ROOT, {
            testHooks: { beforeRootBinding: {
              stage: process.env.TERMINA_RETENTION_STAGE,
              readyPath: process.env.TERMINA_RETENTION_READY,
              releasePath: process.env.TERMINA_RETENTION_RELEASE,
            } },
          });
          await owner.list();
          disposeSessionRetentionCoreClient();
        `], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERMINA_CORE_TEST: "1",
            TERMINA_RETENTION_BUNDLE: pathToFileURL(retentionBundle).href,
            TERMINA_RETENTION_ROOT: root,
            TERMINA_RETENTION_STAGE: stage,
            TERMINA_RETENTION_READY: ready,
            TERMINA_RETENTION_RELEASE: release,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        await waitForFile(ready, `root crash probe did not reach ${stage}`);
        child.kill("SIGKILL");
        const exitCode = await new Promise((resolvePromise) => child.once("close", (code, signal) => resolvePromise({ code, signal })));
        assert.equal(exitCode.signal, "SIGKILL", `${stage} probe was killed at the native seam (${stderr})`);
        rmSync(release, { force: true });
        const restart = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
          const { SessionRetentionOwner, disposeSessionRetentionCoreClient } = await import(process.env.TERMINA_RETENTION_BUNDLE);
          try {
            await new SessionRetentionOwner(process.env.TERMINA_RETENTION_ROOT).list();
            process.exitCode = 0;
          } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 19;
          } finally {
            disposeSessionRetentionCoreClient();
          }
        `], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERMINA_CORE_TEST: "1",
            TERMINA_RETENTION_BUNDLE: pathToFileURL(retentionBundle).href,
            TERMINA_RETENTION_ROOT: root,
          },
          encoding: "utf8",
        });
        if (expectRestartable) {
          assert.equal(restart.status, 0, `${stage} crash leaves a restartable retained root: ${restart.stderr}`);
        } else {
          assert.notEqual(restart.status, 0, `${stage} crash deterministically rejects an uncommitted empty root`);
          assert.match(`${restart.stdout}\n${restart.stderr}`, /root|marker|provenance/i);
        }
        const metadataTemps = readdirSync(dirname(root)).filter((name) => name.startsWith(".termina-promotion-root-") && name.endsWith(".tmp"));
        assert.equal(metadataTemps.length, 0, `${stage} crash recovery leaves no provenance/state temporary records`);
        assert.equal(existsSync(join(root, ".termina-retained-session-root.tmp")), false, `${stage} crash recovery leaves no marker temporary record`);
      }
      for (const stage of [
        "retained-root-created",
        "retained-root-parent-open",
        "retained-root-child-open",
        "retained-root-before-state-rename",
        "retained-root-state-persisted",
        "retained-root-before-marker-rename",
        "retained-root-marker-persisted",
        "retained-root-marker-validated",
        "retained-root-before-provenance",
        "retained-root-before-provenance-rename",
        "retained-root-provenance-persisted",
        "retained-root-before-bound-state-rename",
        "retained-root-durable",
      ]) {
        await runKilledRootBind(
          stage,
          join(work, `retained-root-crash-${stage}`),
          stage !== "retained-root-created",
        );
      }
    
      // A copied marker is not root provenance. An existing replacement with only
      // the mutable marker must be rejected before any ledger is published.
      const provenanceRoot = join(work, "retained-provenance");
      const provenanceOwner = new SessionRetentionOwner(provenanceRoot);
      await provenanceOwner.list();
      const copiedMarkerRoot = join(work, "retained-provenance-copied");
      mkdirSync(copiedMarkerRoot, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(copiedMarkerRoot, ".termina-retained-session-root"),
        readFileSync(join(provenanceRoot, ".termina-retained-session-root")),
        { mode: 0o600 },
      );
      const copiedMarkerOwner = new SessionRetentionOwner(copiedMarkerRoot);
      await assert.rejects(copiedMarkerOwner.list(), /provenance|marker|identity|root/i, "copied-marker retained root fails closed without external provenance");
      await provenanceOwner.list();
    
      // The native create/adopt transaction must not publish into a pathname
      // replaced at any phase. The test hook pauses with the exact descriptors
      // held, then swaps both the leaf and its ancestor before the next native
      // step. Every phase must fail closed and leave the replacement untrusted.
      async function waitForFile(path, message) {
        const deadline = Date.now() + 5_000;
        while (!existsSync(path)) {
          if (Date.now() >= deadline) throw new Error(message);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const rootBindingStages = [
        "retained-root-parent-open",
        "retained-root-child-open",
        "retained-root-marker-validated",
        "retained-root-before-provenance",
        "retained-root-durable",
      ];
      for (const mode of ["leaf", "ancestor"]) {
        for (const stage of rootBindingStages) {
        const raceBase = join(work, `retained-bind-race-${mode}-${stage}`);
        const raceRoot = join(raceBase, "retained");
        mkdirSync(raceBase, { recursive: true, mode: 0o700 });
        const ready = join(work, `retained-bind-race-${mode}-${stage}.ready`);
        const release = join(work, `retained-bind-race-${mode}-${stage}.release`);
        const raceOwner = new SessionRetentionOwner(raceRoot, {
          testHooks: {
            beforeRootBinding: { stage, readyPath: ready, releasePath: release },
          },
        });
        const pending = raceOwner.list();
        await waitForFile(ready, `${mode} root bind did not reach descriptor phase`);
        if (mode === "leaf") {
          if (existsSync(raceRoot)) renameSync(raceRoot, `${raceRoot}.original`);
          mkdirSync(raceRoot, { recursive: true, mode: 0o700 });
          writeFileSync(join(raceRoot, ".termina-retained-session-root"), ".termina-retained-session-root\n", { mode: 0o600 });
        } else {
          renameSync(raceBase, `${raceBase}.original`);
          mkdirSync(raceRoot, { recursive: true, mode: 0o700 });
          writeFileSync(join(raceRoot, ".termina-retained-session-root"), ".termina-retained-session-root\n", { mode: 0o600 });
        }
        writeFileSync(release, "release", { mode: 0o600 });
        await assert.rejects(pending, /identity|root|marker|bound|provenance/i, `${mode} replacement during native root bind fails closed`);
        assert.equal(existsSync(join(raceRoot, RETAINED_SESSION_USAGE_LEDGER)), false, `${mode} replacement receives no retained ledger`);
        if (mode === "ancestor") {
          assert.equal(readdirSync(raceBase).some((name) => name.startsWith(".termina-promotion-root-") && name.endsWith(".json")), false, `${mode} replacement receives no retained provenance`);
        }
        }
      }
    
      // The state replacement slot is descriptor-bound as well. Replacing its
      // pathname while the original fd is held must reject without cleaning the
      // unbound replacement; swapping the ancestor must reject the public path
      // while preserving the parked original transaction.
      async function runBoundStateReplacementSwap(mode) {
        const base = join(work, `retained-bound-state-${mode}`);
        const root = join(base, "retained");
        mkdirSync(base, { recursive: true, mode: 0o700 });
        const ready = join(work, `retained-bound-state-${mode}.ready`);
        const release = join(work, `retained-bound-state-${mode}.release`);
        const swapOwner = new SessionRetentionOwner(root, {
          testHooks: {
            beforeRootBinding: {
              stage: "retained-root-before-bound-state-rename",
              readyPath: ready,
              releasePath: release,
            },
          },
        });
        const pending = swapOwner.list();
        await waitForFile(ready, `${mode} bound-state swap did not reach the rename seam`);
        const stateName = readdirSync(base).find((name) => name.startsWith(".termina-promotion-root-") && name.endsWith(".json"));
        assert.ok(stateName, "bound-state swap exposes its provenance name");
        if (mode === "temp") {
          const stateTemp = join(base, `${stateName}.tmp`);
          assert.equal(existsSync(stateTemp), true, "bound-state swap exposes its deterministic state temp");
          const held = `${stateTemp}.held`;
          renameSync(stateTemp, held);
          writeFileSync(stateTemp, JSON.stringify({ version: 1, state: "bound", path: root, parent: { dev: "0", ino: "0" }, root: { dev: "0", ino: "0" } }), { mode: 0o600 });
          writeFileSync(release, "release", { mode: 0o600 });
          await assert.rejects(pending, /changed|identity|state|root|provenance/i, "state temporary ABA fails closed");
          assert.equal(existsSync(held), true, "state temporary ABA retains the original descriptor-owned temp");
          assert.equal(existsSync(stateTemp), true, "state temporary ABA retains the replacement evidence");
          return;
        }
        if (mode === "final") {
          const statePath = join(base, `${stateName}.state`);
          const held = `${statePath}.held`;
          renameSync(statePath, held);
          writeFileSync(statePath, JSON.stringify({ version: 1, state: "pending", path: root, parent: { dev: "0", ino: "0" }, root: { dev: "0", ino: "0" } }), { mode: 0o600 });
          writeFileSync(release, "release", { mode: 0o600 });
          await assert.rejects(pending, /changed|identity|state|root|provenance/i, "state final ABA fails closed");
          assert.equal(existsSync(held), true, "state final ABA retains the original descriptor-owned state");
          assert.equal(existsSync(statePath), true, "state final ABA retains the replacement evidence");
          return;
        }
        const parked = `${base}.parked`;
        renameSync(base, parked);
        mkdirSync(base, { recursive: true, mode: 0o700 });
        writeFileSync(release, "release", { mode: 0o600 });
        await assert.rejects(pending, /changed|identity|state|root|provenance/i, "state ancestor ABA fails closed");
        assert.equal(readdirSync(base).some((name) => name.startsWith(".termina-promotion-root-") && name.endsWith(".json")), false, "state ancestor replacement receives no metadata");
        assert.ok(readdirSync(parked).some((name) => name.startsWith(".termina-promotion-root-") && name.endsWith(".json")), "state ancestor ABA retains parked metadata");
      }
      await runBoundStateReplacementSwap("temp");
      await runBoundStateReplacementSwap("final");
      await runBoundStateReplacementSwap("ancestor");
    
      // A bound owner must reject a pathname replacement before creating a
      // marker, claim, or usage ledger in the replacement root.
      const rootAbaBase = join(work, "retained-root-aba");
      const rootAba = join(rootAbaBase, "retained");
      mkdirSync(rootAbaBase, { recursive: true, mode: 0o700 });
      const rootAbaOwner = new SessionRetentionOwner(rootAba);
      await rootAbaOwner.transact("root-aba-first", async (destination) => {
        writeBundle(destination, 1);
        return "first";
      });
      const originalRoot = `${rootAba}.original`;
      renameSync(rootAba, originalRoot);
      mkdirSync(rootAba, { recursive: true, mode: 0o700 });
      let rootAbaPublished = false;
      await assert.rejects(
        rootAbaOwner.transact("root-aba-second", async (destination) => {
          rootAbaPublished = true;
          writeBundle(destination, 1);
          return "unexpected";
        }),
        /identity|root|marker|bound/i,
      );
      assert.equal(rootAbaPublished, false, "root ABA fails before replacement publication");
      assert.equal(existsSync(join(rootAba, RETAINED_SESSION_USAGE_LEDGER)), false, "root ABA does not publish a replacement usage ledger");
    
      disposeSessionRetentionCoreClient();
      rmSync(work, { recursive: true, force: true });
      console.log("PASS retention-ledger focused regressions");
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      throw error;
    }
  }, 120_000);
});
