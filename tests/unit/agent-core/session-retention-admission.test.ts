import { describe, it, expect } from "vitest";
/**
 * Focused cross-process admission probes for agent-core retained staging.
 *
 * This is intentionally separate from the broad session harness: it starts
 * real child processes against one project root so count/byte admission and
 * stale-lock recovery cannot accidentally become an in-process-only test.
 * Run with: node scripts/agent-core-session-retention-test.mjs
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

describe("Agent Core Session Retention Admission Invariants", () => {
  it("passes session retention admission regressions", async () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "termina-agent-core-retention-")));
    process.env.TERMINA_CORE_TEST = "1";
    const sessionBundle = join(work, "session.mjs");
    const retentionBundle = join(work, "retention.mjs");
    const forkBundle = join(work, "session-fork.mjs");
    const workerBundle = join(work, "session-worker.mjs");
    const children = new Set();
    let client = null;
    let disposeRetentionCoreClient = null;
    
    process.on("exit", () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* best effort only during failed fixture cleanup */
          }
        }
      }
    });
    
    function check(condition, message) {
      if (!condition) throw new Error(`FAIL ${message}`);
      console.log(`PASS ${message}`);
    }
    
    function seedSource(root, session) {
      const sourceFile = session.coreSessionFile(root, "source");
      const opened = session.SessionWriter.open(sourceFile, 0);
      if (!opened.ok) throw new Error(opened.error);
      const appended = opened.writer.appendRecord({
        storageSeq: 1,
        type: "message",
        message: { role: "user", content: "retention admission probe" },
      });
      opened.writer.close();
      if (!appended.ok) throw new Error(appended.error);
      return sourceFile;
    }
    
    function stageNames(root) {
      if (!existsSync(root)) return [];
      return readdirSync(root).filter((name) => /^t-[0-9a-f]{32}$/.test(name));
    }
    
    function stageBytes(root) {
      let bytes = 0;
      const pending = stageNames(root).map((name) => join(root, name));
      while (pending.length > 0) {
        const path = pending.pop();
        const info = lstatSync(path);
        if (info.isDirectory()) {
          for (const name of readdirSync(path)) pending.push(join(path, name));
        } else if (!info.isSymbolicLink()) {
          bytes += info.size;
        }
      }
      return bytes;
    }
    
    function childCode() {
      return `
        import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        const { writeForkedSession } = await import(process.env.TERMINA_SESSION_BUNDLE);
        const source = process.env.TERMINA_SOURCE;
        const destination = process.env.TERMINA_DEST;
        const mode = process.env.TERMINA_RETENTION_MODE || "normal";
        const sparseBytes = Number(process.env.TERMINA_SPARSE_BYTES || 0);
        let afterTempCreated;
        let beforeDestinationCurrentInstall;
        if (mode === "crash") {
          afterTempCreated = (path) => {
            writeFileSync(process.env.TERMINA_ENTERED, "entered");
            process.kill(process.pid, "SIGKILL");
          };
        } else if (sparseBytes > 0) {
          afterTempCreated = (path) => {
            const fd = openSync(join(path, "retained-sparse.bin"), "w", 0o600);
            try { ftruncateSync(fd, sparseBytes); } finally { closeSync(fd); }
          };
          beforeDestinationCurrentInstall = () => { throw new Error("sparse admission probe"); };
        }
        const options = (afterTempCreated || beforeDestinationCurrentInstall)
          ? { testHooks: { ...(afterTempCreated ? { afterTempCreated } : {}), ...(beforeDestinationCurrentInstall ? { beforeDestinationCurrentInstall } : {}) } }
          : undefined;
        let result;
        for (let attempt = 0; ; attempt++) {
          result = await writeForkedSession(source, destination, 1, options);
          if (result.ok || !/busy|admission lock is unreadable/i.test(result.error || "") || attempt >= 400) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        process.stdout.write(JSON.stringify(result));
      `;
    }
    
    function firstSessionChildCode() {
      return `
        import { existsSync, writeFileSync } from "node:fs";
        const { SessionWriter } = await import(process.env.TERMINA_SESSION_BUNDLE);
        const sessionFile = process.env.TERMINA_FIRST_DEST;
        const mode = process.env.TERMINA_FIRST_MODE || "normal";
        const testHooks = {};
        if (mode === "project-crash") {
          testHooks.afterSessionProjectCreated = () => {
            writeFileSync(process.env.TERMINA_ENTERED, "project");
            process.kill(process.pid, "SIGKILL");
          };
        } else if (mode === "bundle-crash") {
          testHooks.afterEmptySessionReservation = () => {
            writeFileSync(process.env.TERMINA_ENTERED, "bundle");
            process.kill(process.pid, "SIGKILL");
          };
        }
        let result;
        for (let attempt = 0; ; attempt++) {
          result = SessionWriter.open(sessionFile, 0, Object.keys(testHooks).length > 0 ? { testHooks } : undefined);
          if (result.ok || !/busy|admission lock is unreadable/i.test(result.error || "") || attempt >= 400) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        if (result.ok) result.writer.close();
        process.stdout.write(JSON.stringify(result));
      `;
    }
    
    function startChild(source, destination, options = {}) {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", childCode()], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINA_CORE_TEST: "1",
          TERMINA_SESSION_BUNDLE: pathToFileURL(sessionBundle).href,
          TERMINA_SOURCE: source,
          TERMINA_DEST: destination,
          ...options,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      children.add(child);
      const done = once(child, "close");
      return {
        child,
        async result() {
          const [code, signal] = await done;
          children.delete(child);
          if (code !== 0) throw new Error(`agent-core child exited ${code ?? "null"} (${signal ?? "no signal"}): ${stderr}`);
          try {
            return JSON.parse(stdout);
          } catch {
            throw new Error(`agent-core child returned invalid JSON: ${stdout} ${stderr}`);
          }
        },
      };
    }
    
    function startFirstChild(destination, options = {}) {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", firstSessionChildCode()], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINA_CORE_TEST: "1",
          TERMINA_SESSION_BUNDLE: pathToFileURL(sessionBundle).href,
          TERMINA_FIRST_DEST: destination,
          ...options,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      children.add(child);
      const done = once(child, "close");
      return {
        child,
        async result() {
          const [code, signal] = await done;
          children.delete(child);
          if (code !== 0) return { crashed: signal ?? `exit-${code}`, stderr };
          try {
            return JSON.parse(stdout);
          } catch {
            throw new Error(`first-session child returned invalid JSON: ${stdout} ${stderr}`);
          }
        },
      };
    }
    
    function waitForFile(path) {
      const deadline = Date.now() + 5_000;
      while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    
    async function waitForFileAsync(path, failurePath = null) {
      const deadline = Date.now() + 5_000;
      while (!existsSync(path)) {
        if (failurePath && existsSync(failurePath)) throw new Error(`wait failed: ${readFileSync(failurePath, "utf8")}`);
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    
    try {
      await build({
        entryPoints: ["agent-core/session.ts"],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: sessionBundle,
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
      await Promise.all([
        build({
          entryPoints: ["electron/session-fork.ts"],
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node22",
          outfile: forkBundle,
          logLevel: "silent",
        }),
        build({
          entryPoints: ["electron/session-worker.ts"],
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node22",
          outfile: workerBundle,
          logLevel: "silent",
          banner: { js: 'import { createRequire as __sessionForkRequire } from "node:module"; const require = __sessionForkRequire(import.meta.url);' },
        }),
      ]);
    
      const session = await import(pathToFileURL(sessionBundle).href);
      const {
        disposeSessionRetentionCoreClient,
        MAX_RETAINED_SESSION_BUNDLES,
        SessionRetentionOwner,
      } = await import(pathToFileURL(retentionBundle).href);
      disposeRetentionCoreClient = disposeSessionRetentionCoreClient;
      const { SessionForkClient } = await import(pathToFileURL(forkBundle).href);
      client = new SessionForkClient();
      const source = seedSource(join(work, "source"), session);
    
      // Darwin/Windows unbound cleanup retains empty bundles as evidence. New
      // bundle admission is bounded per project until the native owner can
      // reclaim those deterministic paths; it must not accumulate forever.
      const emptyAdmissionRoot = join(work, "empty-admission");
      mkdirSync(emptyAdmissionRoot, { recursive: true, mode: 0o700 });
      for (let index = 0; index < session.MAX_RETAINED_EMPTY_SESSION_BUNDLES; index++) {
        const empty = session.coreSessionFile(emptyAdmissionRoot, `empty-${String(index).padStart(3, "0")}`);
        mkdirSync(dirname(empty), { recursive: true, mode: 0o700 });
        writeFileSync(empty, "", { mode: 0o600 });
      }
      const emptyAdmissionResult = session.SessionWriter.open(
        session.coreSessionFile(emptyAdmissionRoot, "empty-next"),
        0,
      );
      check(
        emptyAdmissionResult.ok === false && /capacity|native bound|retained empty/i.test(emptyAdmissionResult.error),
        "unbound empty core-session admission stops at its deterministic bound",
      );
    
      // First callers must take the stable session-root lock before creating a
      // project. Retrying only lock contention makes the cap deterministic: 132
      // independent first callers can publish no more than 128 empty bundles.
      const firstAdmissionRoot = join(work, "first-project-admission");
      mkdirSync(firstAdmissionRoot, { recursive: true, mode: 0o700 });
      const firstProject = join(firstAdmissionRoot, "first-project");
      const firstChildren = Array.from({ length: session.MAX_RETAINED_EMPTY_SESSION_BUNDLES + 4 }, (_, index) => startFirstChild(
        session.coreSessionFile(firstProject, `first-${String(index).padStart(3, "0")}`),
      ));
      const firstResults = await Promise.all(firstChildren.map((child) => child.result()));
      const firstPublished = existsSync(firstProject)
        ? readdirSync(firstProject).filter((name) => /^first-[0-9]{3}$/.test(name) && existsSync(session.coreSessionFile(firstProject, name))).length
        : 0;
      check(firstPublished <= session.MAX_RETAINED_EMPTY_SESSION_BUNDLES, "first-project admission never exceeds the 128-bundle cap");
      check(firstResults.filter((result) => result.ok).length === firstPublished, "first-project callers publish only admitted empty bundles");
      check(firstResults.some((result) => result.ok === false && /capacity|busy|retained empty/i.test(result.error || "")), "first-project overflow callers fail closed at admission");
    
      // A crash after project publication leaves only the project directory; the
      // next process recovers the dead lock and publishes its first bundle.
      const firstCrashRoot = join(work, "first-project-crash");
      mkdirSync(firstCrashRoot, { recursive: true, mode: 0o700 });
      const projectEntered = join(work, "first-project-entered");
      const projectCrash = startFirstChild(
        session.coreSessionFile(join(firstCrashRoot, "first-project"), "project-crash"),
        { TERMINA_FIRST_MODE: "project-crash", TERMINA_ENTERED: projectEntered },
      );
      await waitForFileAsync(projectEntered);
      const projectCrashResult = await projectCrash.result();
      check(projectCrashResult.crashed === "SIGKILL", "first-project crash probe stops after project publication");
      const projectRecovered = await startFirstChild(
        session.coreSessionFile(join(firstCrashRoot, "first-project"), "project-recovered"),
      ).result();
      check(projectRecovered.ok, "first-project restart rehydrates a dead admission generation");
    
      // A crash after the active empty segment is durable must count on restart;
      // the next distinct first caller is admitted only after that exact count is
      // rehydrated from disk.
      const bundleCrashRoot = join(work, "first-bundle-crash");
      mkdirSync(bundleCrashRoot, { recursive: true, mode: 0o700 });
      const bundleEntered = join(work, "first-bundle-entered");
      const bundleCrash = startFirstChild(
        session.coreSessionFile(join(bundleCrashRoot, "first-project"), "bundle-crash"),
        { TERMINA_FIRST_MODE: "bundle-crash", TERMINA_ENTERED: bundleEntered },
      );
      await waitForFileAsync(bundleEntered);
      const bundleCrashResult = await bundleCrash.result();
      check(bundleCrashResult.crashed === "SIGKILL", "first-bundle crash probe stops after empty reservation");
      const bundleRecovered = await startFirstChild(
        session.coreSessionFile(join(bundleCrashRoot, "first-project"), "bundle-recovered"),
      ).result();
      check(bundleRecovered.ok, "first-bundle restart rehydrates the durable empty count");
      const bundleProject = join(bundleCrashRoot, "first-project");
      const bundleCount = readdirSync(bundleProject).filter((name) => /^bundle-(?:crash|recovered)$/.test(name) && existsSync(session.coreSessionFile(bundleProject, name))).length;
      check(bundleCount === 2, "first-bundle restart preserves both durable empty bundles");
    
      // Retained-temp admission must reject an oversized flat project directory
      // before allocating an unbounded root names array.
      const flatRoot = join(work, "flat-root-cap");
      mkdirSync(flatRoot, { recursive: true, mode: 0o700 });
      for (let index = 0; index < 513; index++) {
        writeFileSync(join(flatRoot, `orphan-${String(index).padStart(4, "0")}`), "orphan", { mode: 0o600 });
      }
      const flatResult = await startChild(source, session.coreSessionFile(flatRoot, "flat-cap")).result();
      check(flatResult.ok === false && /entry|root|bound/i.test(flatResult.error), "core retained-temp root entry cap fails closed before publication");
    
      // Recursive retained-temp scans must also reject excessive depth rather
      // than growing a work stack without a depth/work bound.
      const deepRoot = join(work, "deep-temp-cap");
      const deepTemp = join(deepRoot, `t-${"c".repeat(32)}`);
      let deepPath = deepTemp;
      for (let depth = 0; depth < 80; depth++) {
        deepPath = join(deepPath, `level-${String(depth).padStart(3, "0")}`);
        mkdirSync(deepPath, { recursive: true, mode: 0o700 });
      }
      const deepResult = await startChild(source, session.coreSessionFile(deepRoot, "deep-cap")).result();
      check(deepResult.ok === false && /depth|bound|retained temporary/i.test(deepResult.error), "core retained-temp depth cap fails closed before publication");
    
      // Sixteen independent processes retry through the one shared admission
      // generation. Starting from 120 retained trees must stop at exactly 128,
      // never at the 129 observed without cross-process serialization.
      const countRoot = join(work, "count");
      mkdirSync(countRoot, { recursive: true, mode: 0o700 });
      for (let index = 0; index < 120; index++) {
        mkdirSync(join(countRoot, `t-${String(index).padStart(32, "0")}`), { mode: 0o700 });
      }
      const countChildren = Array.from({ length: 16 }, (_, index) => startChild(
        source,
        session.coreSessionFile(countRoot, `count-${index}`),
      ));
      const countResults = await Promise.all(countChildren.map((child) => child.result()));
      const count = stageNames(countRoot).length;
      check(count === MAX_RETAINED_SESSION_BUNDLES, "16-process staging admission stops at exactly 128 trees");
      check(countResults.filter((result) => result.ok).length === 8, "16-process staging admission admits only the eight available slots");
    
      // Each failed process retains a sparse 2.2 GB tree. A second admission must
      // observe the first tree under the lock and reject its half-bound reserve;
      // sequential stale scans would otherwise retain >4 GB.
      const sparseRoot = join(work, "sparse");
      mkdirSync(sparseRoot, { recursive: true, mode: 0o700 });
      const sparseBytes = 2_200_000_000;
      const sparseChildren = [0, 1].map((index) => startChild(
        source,
        session.coreSessionFile(sparseRoot, `sparse-${index}`),
        { TERMINA_SPARSE_BYTES: String(sparseBytes) },
      ));
      const sparseResults = await Promise.all(sparseChildren.map((child) => child.result()));
      const sparseTotal = stageBytes(sparseRoot);
      check(sparseResults.filter((result) => result.ok === false).length === 2, "2-process sparse-byte admission retains failures without publishing");
      check(sparseTotal <= 4 * 1024 * 1024 * 1024, "2-process sparse-byte admission never exceeds 4 GB");
      check(stageNames(sparseRoot).length === 1, "2-process sparse-byte admission retains only one large staging tree");
    
      // A process killed while holding the lock leaves a recoverable generation;
      // the next process may reclaim only that dead generation and then publish.
      const crashRoot = join(work, "crash");
      mkdirSync(crashRoot, { recursive: true, mode: 0o700 });
      const entered = join(work, "crash-entered");
      const crashing = startChild(source, session.coreSessionFile(crashRoot, "crash-first"), {
        TERMINA_RETENTION_MODE: "crash",
        TERMINA_ENTERED: entered,
      });
      waitForFile(entered);
      const [, crashSignal] = await once(crashing.child, "close");
      children.delete(crashing.child);
      check(crashSignal === "SIGKILL", "crash probe terminates while admission lock is held");
      const recovered = await startChild(source, session.coreSessionFile(crashRoot, "crash-second")).result();
      check(recovered.ok, "restart rehydrates and recovers a dead admission generation");
    
      // The durable owner holds the same lock while its callback runs. Passing the
      // explicit lease through the canonical callback prevents same-PID worker
      // reentrancy from being mistaken for a competing owner.
      const integrationRoot = join(work, "integration");
      const owner = new SessionRetentionOwner(integrationRoot);
      const first = await owner.transact("owner-first", (destination, lease) => client.forkCore({
        sourceSessionFile: source,
        destinationSessionFile: destination,
        throughSeq: 1,
        retentionLease: lease,
      }));
      check(first.result.ok, "first durable owner transaction succeeds with its explicit lease");
      const second = await owner.transact("owner-second", (destination, lease) => client.forkCore({
        sourceSessionFile: source,
        destinationSessionFile: destination,
        throughSeq: 1,
        retentionLease: lease,
      }));
      check(second.result.ok, "second durable owner transaction admits after an empty staging sibling");
      const restartedOwner = new SessionRetentionOwner(integrationRoot);
      const third = await restartedOwner.transact("owner-third", (destination, lease) => client.forkCore({
        sourceSessionFile: source,
        destinationSessionFile: destination,
        throughSeq: 1,
        retentionLease: lease,
      }));
      check(third.result.ok, "restarted durable owner rehydrates empty staging siblings before worker admission");
      check(stageNames(integrationRoot).length >= 3, "successful owner transactions retain only bounded empty staging siblings");
    
      // A destination claim left at the pre-commit boundary is app-owned staging,
      // not an invalid durable bundle. It must be listed after restart, consume a
      // bounded admission slot without poisoning the next transaction, and be
      // explicitly discardable through the same native bound-removal primitive.
      const claimRoot = join(work, "claims");
      const claimOwner = new SessionRetentionOwner(claimRoot);
      const claimFirst = await claimOwner.transact("claim-empty", (destination, lease) => session.writeForkedSession(
        source,
        destination,
        1,
        {
          retentionLease: lease,
          testHooks: {
            beforeDestinationCurrentInstall() {
              throw new Error("pre-commit claim probe");
            },
          },
        },
      ));
      check(claimFirst.result.ok === false && claimFirst.result.commit === "uncertain", "pre-commit claim remains durable after an empty destination boundary");
      const listedClaim = (await claimOwner.list()).find((claim) => claim.runId === "claim-empty");
      check(listedClaim?.kind === "staging" && listedClaim?.bytes !== null, "empty pre-commit claim is classified as retained staging");
      const restartedClaimOwner = new SessionRetentionOwner(claimRoot);
      const rehydratedClaim = (await restartedClaimOwner.list()).find((claim) => claim.runId === "claim-empty");
      check(rehydratedClaim?.kind === "staging", "restart rehydrates the empty staging claim for recovery");
      const claimFollowup = await restartedClaimOwner.transact("claim-followup", (destination, lease) => session.writeForkedSession(
        source,
        destination,
        1,
        { retentionLease: lease },
      ));
      check(claimFollowup.result.ok, "an empty retained claim does not block the next durable admission");
      const claimDiscard = await restartedClaimOwner.discard("claim-empty");
      check(claimDiscard.ok && !(await restartedClaimOwner.list()).some((claim) => claim.runId === "claim-empty"), "explicit discard removes an empty retained claim after restart");
    
      // Hold the native claim removal immediately after it opens the leaf, then
      // replace that leaf and release it. The original and replacement must both
      // survive; a fresh owner can subsequently recover the replacement claim.
      const claimAba = await restartedClaimOwner.transact("claim-aba", (destination, lease) => session.writeForkedSession(
        source,
        destination,
        1,
        {
          retentionLease: lease,
          testHooks: {
            beforeDestinationCurrentInstall() {
              throw new Error("claim ABA probe");
            },
          },
        },
      ));
      check(claimAba.result.ok === false && claimAba.result.commit === "uncertain", "claim ABA fixture reaches durable uncertain state");
      const claimAbaPath = join(claimRoot, ".termina-retained-claim-claim-aba.json");
      const claimAbaReady = join(work, "claim-aba-ready");
      const claimAbaRelease = join(work, "claim-aba-release");
      const claimAbaFailure = join(work, "claim-aba-failure");
      const claimAbaOwner = new SessionRetentionOwner(claimRoot, {
        testHooks: {
          beforeClaimRemoval: {
            stage: "promotion-cleanup-root-open",
            readyPath: claimAbaReady,
            releasePath: claimAbaRelease,
          },
        },
      });
      const claimAbaDiscard = claimAbaOwner.discard("claim-aba").catch((error) => {
        writeFileSync(claimAbaFailure, String(error));
        return { ok: false, error: String(error) };
      });
      await waitForFileAsync(claimAbaReady, claimAbaFailure);
      const claimAbaOriginal = `${claimAbaPath}.original`;
      renameSync(claimAbaPath, claimAbaOriginal);
      writeFileSync(claimAbaPath, `${JSON.stringify({ runId: "claim-aba", createdAt: Date.now() })}\n`, { mode: 0o600 });
      writeFileSync(claimAbaRelease, "release");
      const claimAbaResult = await claimAbaDiscard;
      check(
        claimAbaResult.ok === false && existsSync(claimAbaPath) && existsSync(claimAbaOriginal),
        "claim release retains both sides of a leaf ABA replacement",
      );
      const recoveredClaimAba = await new SessionRetentionOwner(claimRoot).discard("claim-aba");
      check(recoveredClaimAba.ok && !existsSync(claimAbaPath), "claim recovery can discard the replacement after the failed ABA release");
    
      // Pause after the retained root descriptor is opened, then swap the root
      // pathname itself. The lease carries the original root identity, so the
      // native removal must reject the replacement rather than treating it as a
      // new app-owned claim namespace.
      const claimAncestorBase = join(work, "claim-ancestor-base");
      const claimAncestorRoot = join(claimAncestorBase, "retained");
      const claimAncestorReady = join(work, "claim-ancestor-ready");
      const claimAncestorRelease = join(work, "claim-ancestor-release");
      const claimAncestorFailure = join(work, "claim-ancestor-failure");
      const claimAncestorOwner = new SessionRetentionOwner(claimAncestorRoot, {
        testHooks: {
          beforeClaimRemoval: {
            stage: "promotion-cleanup-root-open",
            readyPath: claimAncestorReady,
            releasePath: claimAncestorRelease,
          },
        },
      });
      const claimAncestor = await claimAncestorOwner.transact("claim-ancestor", (destination, lease) => session.writeForkedSession(
        source,
        destination,
        1,
        {
          retentionLease: lease,
          testHooks: {
            beforeDestinationCurrentInstall() {
              throw new Error("claim ancestor probe");
            },
          },
        },
      ));
      check(claimAncestor.result.ok === false && claimAncestor.result.commit === "uncertain", "claim ancestor fixture reaches durable uncertain state");
      const claimAncestorRemoval = claimAncestorOwner.discard("claim-ancestor").catch((error) => {
        writeFileSync(claimAncestorFailure, String(error));
        return { ok: false, error: String(error) };
      });
      await waitForFileAsync(claimAncestorReady, claimAncestorFailure);
      const claimAncestorOriginalBase = `${claimAncestorBase}.original`;
      renameSync(claimAncestorBase, claimAncestorOriginalBase);
      mkdirSync(claimAncestorRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(claimAncestorRoot, ".termina-retained-session-root"), ".termina-retained-session-root\n", { mode: 0o600 });
      writeFileSync(claimAncestorRelease, "release");
      const claimAncestorResult = await claimAncestorRemoval;
      check(
        claimAncestorResult.ok === false
          && existsSync(join(claimAncestorOriginalBase, "retained", ".termina-retained-claim-claim-ancestor.json"))
          && existsSync(join(claimAncestorRoot, ".termina-retained-session-root")),
        "claim release fails closed across an ancestor root swap",
      );
    
      console.log("PASS agent-core session retention admission regressions");
    } finally {
      await client?.dispose();
      disposeRetentionCoreClient?.();
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
