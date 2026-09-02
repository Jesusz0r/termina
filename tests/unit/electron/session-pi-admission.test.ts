import { describe, it, expect } from "vitest";
/**
 * Focused Pi-session copy admission and cleanup probes.
 *
 * Run with:
 *   TERMINA_CORE_TEST=1 node --experimental-strip-types --no-warnings scripts/session-pi-admission-test.mjs
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

describe("Pi Session Admission and Cleanup Probes", () => {
  it("passes Pi session admission and cleanup regressions natively", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    const work = mkdtempSync(join(tmpdir(), "termina-pi-admission-"));
    const sessionBundle = join(work, "session.mjs");
    const forkBundle = join(work, "session-fork.mjs");
    const workerBundle = join(work, "session-worker.mjs");
    const children = new Set();
    
    function check(condition, message) {
      if (!condition) throw new Error(`FAIL ${message}`);
      console.log(`PASS ${message}`);
    }
    
    function writeSized(path, bytes) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, "w", 0o600);
      try {
        ftruncateSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    }
    
    function childCode() {
      return `
        const { copyPiSessionFile } = await import(process.env.TERMINA_SESSION_BUNDLE);
        const source = process.env.TERMINA_PI_SOURCE;
        const destination = process.env.TERMINA_PI_DEST;
        const workspaceDir = process.env.TERMINA_PI_WORKSPACE;
        const maxBytes = Number(process.env.TERMINA_PI_MAX_BYTES);
        const mode = process.env.TERMINA_PI_MODE || "normal";
        const options = { workspaceDir, testOnlyMaxBytes: maxBytes };
        if (mode === "crash") {
          options.testHooks = { afterDestinationReservation: () => process.kill(process.pid, "SIGKILL") };
        }
        const result = await copyPiSessionFile(source, destination, options);
        process.stdout.write(JSON.stringify(result));
      `;
    }
    
    function startChild(options) {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", childCode()], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINA_SESSION_BUNDLE: pathToFileURL(sessionBundle).href,
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
          return JSON.parse(stdout);
        },
      };
    }
    
    try {
      await Promise.all([
        build({ entryPoints: ["agent-core/session.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: sessionBundle, logLevel: "silent" }),
        build({ entryPoints: ["electron/session-fork.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: forkBundle, logLevel: "silent" }),
        build({
          entryPoints: ["electron/session-worker.ts"],
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node22",
          outfile: workerBundle,
          banner: { js: 'import { createRequire as __sessionForkRequire } from "node:module"; const require = __sessionForkRequire(import.meta.url);' },
          logLevel: "silent",
        }),
      ]);
      const session = await import(pathToFileURL(sessionBundle).href);
      const { SessionForkClient } = await import(pathToFileURL(forkBundle).href);
      const {
        MAX_PI_SESSION_BYTES,
        copyPiSessionFile,
        removePiSessionCopy,
      } = session;
      check(Number.isSafeInteger(MAX_PI_SESSION_BYTES), "Pi admission API exposes a finite source bound");
    
      const source = join(work, "source", "session.jsonl");
      mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
      writeFileSync(source, "{\"type\":\"session\"}\n", { mode: 0o600 });
      const workspace = join(work, "workspace");
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
    
      // A direct first use must establish the workspace through its parent
      // transaction, then return provenance for the later identity-bound remove.
      const firstCreateWorkspace = join(work, "first-create-workspace");
      const firstCreate = await copyPiSessionFile(source, join(firstCreateWorkspace, "first.jsonl"), {
        workspaceDir: firstCreateWorkspace,
      });
      check(firstCreate.ok && existsSync(firstCreate.sessionFile), "Pi first-use workspace creation publishes one bound copy");
      if (firstCreate.ok) {
        const firstRemoved = await removePiSessionCopy(firstCreate.sessionFile, firstCreateWorkspace, firstCreate.identity);
        check(
          process.platform === "linux"
            ? firstRemoved.ok && !existsSync(firstCreate.sessionFile)
            : !firstRemoved.ok && existsSync(firstCreate.sessionFile),
          "Pi first-use workspace returns an identity for exact consume or bounded retention",
        );
      }
    
      const missingParentWorkspace = join(work, "missing-parent", "workspace");
      const missingParent = await copyPiSessionFile(source, join(missingParentWorkspace, "copy.jsonl"), {
        workspaceDir: missingParentWorkspace,
      });
      check(!missingParent.ok && !existsSync(missingParentWorkspace), "Pi workspace creation fails closed instead of recursively creating a missing ancestor");
    
      const swappedParent = join(work, "swapped-parent");
      mkdirSync(swappedParent, { recursive: true, mode: 0o700 });
      const swappedWorkspace = join(swappedParent, "workspace");
      const parkedParent = join(work, "swapped-parent-parked");
      const swappedCreate = await copyPiSessionFile(source, join(swappedWorkspace, "copy.jsonl"), {
        workspaceDir: swappedWorkspace,
        testHooks: {
          beforePiWorkspaceCreate: () => {
            renameSync(swappedParent, parkedParent);
            mkdirSync(swappedParent, { mode: 0o700 });
          },
        },
      });
      check(
        !swappedCreate.ok
          && !existsSync(swappedWorkspace)
          && !existsSync(join(swappedParent, "workspace"))
          && !existsSync(join(parkedParent, "workspace", "copy.jsonl")),
        "Pi first-use creation rejects an ancestor replacement before populating either pathname",
      );
    
      const populationParent = join(work, "population-parent");
      const populationWorkspace = join(populationParent, "workspace");
      mkdirSync(populationWorkspace, { recursive: true, mode: 0o700 });
      const parkedPopulation = join(work, "population-parent-parked");
      const populationResult = await copyPiSessionFile(source, join(populationWorkspace, "copy.jsonl"), {
        workspaceDir: populationWorkspace,
        testHooks: {
          beforePiCopyDestinationOpen: () => {
            renameSync(populationWorkspace, parkedPopulation);
            mkdirSync(populationWorkspace, { mode: 0o700 });
          },
        },
      });
      check(
        !populationResult.ok
          && !existsSync(join(populationWorkspace, "copy.jsonl"))
          && !existsSync(join(parkedPopulation, "copy.jsonl")),
        "Pi population rejects a workspace ancestor replacement before destination creation",
      );
    
      const oversized = join(work, "oversized.jsonl");
      writeSized(oversized, MAX_PI_SESSION_BYTES + 1);
      const oversizedDestination = join(workspace, "oversized-copy.jsonl");
      const oversizedResult = await copyPiSessionFile(oversized, oversizedDestination, { workspaceDir: workspace });
      check(!oversizedResult.ok && !existsSync(oversizedDestination), "oversized Pi source is rejected before destination reservation");
    
      writeSized(join(workspace, "reference-img-1.png"), 8);
      writeSized(join(workspace, "unknown.partial"), 8);
      const boundedDestination = join(workspace, "bounded-copy.jsonl");
      const boundedResult = await copyPiSessionFile(source, boundedDestination, { workspaceDir: workspace, testOnlyMaxBytes: 32 });
      check(!boundedResult.ok && /bound|bytes/i.test(boundedResult.error), "Pi admission counts image and unknown scratch files");
    
      const workLimited = await copyPiSessionFile(source, join(workspace, "work-limited.jsonl"), { workspaceDir: workspace, testOnlyMaxBytes: 1024, testOnlyMaxWorkBytes: 150 });
      check(!workLimited.ok && /work|bound/i.test(workLimited.error), "Pi admission applies a pre-copy work bound");
    
      const countWorkspace = join(work, "count-workspace");
      mkdirSync(countWorkspace, { recursive: true, mode: 0o700 });
      writeSized(join(countWorkspace, "one.jsonl"), 1);
      writeSized(join(countWorkspace, "two.jsonl"), 1);
      const countLimited = await copyPiSessionFile(source, join(countWorkspace, "three.jsonl"), {
        workspaceDir: countWorkspace,
        testOnlyMaxBytes: 1024,
        testOnlyMaxCount: 2,
        testOnlyMaxWorkBytes: 1024,
      });
      check(!countLimited.ok && /count|bound/i.test(countLimited.error), "Pi admission applies a pre-copy file-count bound");
    
      const client = new SessionForkClient();
      let workerOversizedError = null;
      try {
        await client.copyPi({ sourceSessionFile: oversized, sessionWorkspaceDir: join(work, "worker-oversized") });
      } catch (error) {
        workerOversizedError = error;
      }
      check(workerOversizedError instanceof Error && /bound|bytes/i.test(workerOversizedError.message) && !existsSync(join(work, "worker-oversized", "pi-copy-copy-pi-1.jsonl")), "worker Pi copy rejects an oversized source before I/O");
      await client.dispose();
    
      const forkClient = new SessionForkClient();
      const forkOversizedWorkspace = join(work, "worker-fork-oversized");
      let workerForkOversizedError = null;
      try {
        await forkClient.fork({
          sourceSessionFile: oversized,
          entryId: null,
          sessionWorkspaceDir: forkOversizedWorkspace,
          candidateRoot: join(work, "worker-fork-oversized-candidate"),
          candidateSessionDir: join(work, "worker-fork-oversized-sessions"),
        });
      } catch (error) {
        workerForkOversizedError = error;
      }
      check(
        workerForkOversizedError instanceof Error
          && /bound|bytes/i.test(workerForkOversizedError.message)
          && (!existsSync(forkOversizedWorkspace) || readdirSync(forkOversizedWorkspace).every((name) => !name.startsWith("fork-"))),
        "worker Pi fork rejects an oversized source before I/O",
      );
      await forkClient.dispose();
    
      const concurrentWorkspace = join(work, "concurrent-workspace");
      mkdirSync(concurrentWorkspace, { recursive: true, mode: 0o700 });
      const concurrentSource = join(work, "concurrent-source.jsonl");
      writeSized(concurrentSource, 32);
      const concurrentA = startChild({
        TERMINA_PI_SOURCE: concurrentSource,
        TERMINA_PI_DEST: join(concurrentWorkspace, "a.jsonl"),
        TERMINA_PI_WORKSPACE: concurrentWorkspace,
        TERMINA_PI_MAX_BYTES: "32",
      });
      const concurrentB = startChild({
        TERMINA_PI_SOURCE: concurrentSource,
        TERMINA_PI_DEST: join(concurrentWorkspace, "b.jsonl"),
        TERMINA_PI_WORKSPACE: concurrentWorkspace,
        TERMINA_PI_MAX_BYTES: "32",
      });
      const concurrentResults = await Promise.all([concurrentA.result(), concurrentB.result()]);
      check(concurrentResults.filter((result) => result.ok).length === 1, "concurrent Pi admissions reserve exactly one bounded workspace");
    
      const crashWorkspace = join(work, "crash-workspace");
      mkdirSync(crashWorkspace, { recursive: true, mode: 0o700 });
      const crashSource = join(work, "crash-source.jsonl");
      writeSized(crashSource, 32);
      const crashed = startChild({
        TERMINA_PI_SOURCE: crashSource,
        TERMINA_PI_DEST: join(crashWorkspace, "crashed.jsonl"),
        TERMINA_PI_WORKSPACE: crashWorkspace,
        TERMINA_PI_MAX_BYTES: "32",
        TERMINA_PI_MODE: "crash",
      });
      const crashResult = await crashed.result();
      check(crashResult.crashed === "SIGKILL", "crash probe exits after durable Pi reservation");
      const restarted = await copyPiSessionFile(crashSource, join(crashWorkspace, "restart.jsonl"), { workspaceDir: crashWorkspace, testOnlyMaxBytes: 32 });
      check(!restarted.ok && /bound|bytes|busy/i.test(restarted.error), "restart accounts crashed Pi reservation before another copy");
    
      const cancelWorkspace = join(work, "cancel-workspace");
      mkdirSync(cancelWorkspace, { recursive: true, mode: 0o700 });
      const cancelDestination = join(cancelWorkspace, "cancelled.jsonl");
      const cancelController = new AbortController();
      const cancelled = await copyPiSessionFile(source, cancelDestination, {
        workspaceDir: cancelWorkspace,
        signal: cancelController.signal,
        testOnlyMaxBytes: 1024,
        testHooks: { afterDestinationReservation: () => cancelController.abort() },
      });
      check(
        !cancelled.ok
          && /cancel|retained/i.test(cancelled.error)
          && (process.platform === "linux" ? !existsSync(cancelDestination) : existsSync(cancelDestination)),
        "cancelled Pi copy releases or retains its durable reservation exactly",
      );
    
      const cleanupWorkspace = join(work, "cleanup-workspace");
      mkdirSync(cleanupWorkspace, { recursive: true, mode: 0o700 });
      const copied = await copyPiSessionFile(source, join(cleanupWorkspace, "copy.jsonl"), { workspaceDir: cleanupWorkspace });
      if (!copied.ok) throw new Error(copied.error);
      const held = join(cleanupWorkspace, "copy-held.jsonl");
      let cleanupHookRan = false;
      const cleanupAba = await removePiSessionCopy(copied.sessionFile, cleanupWorkspace, copied.identity, {
        testHooks: { beforePiCopyCleanup: (path) => {
          cleanupHookRan = true;
          renameSync(path, held);
          writeFileSync(path, "replacement\n", { mode: 0o600 });
        } },
      });
      check(
        !cleanupAba.ok
          && existsSync(copied.sessionFile)
          && (process.platform === "linux"
            ? cleanupHookRan && existsSync(held)
            : !cleanupHookRan),
        "Pi cleanup retains both sides of a leaf ABA replacement",
      );
    
      const { linkSync } = await import("node:fs");
      const leafHardlinkWorkspace = join(work, "leaf-hardlink-workspace");
      mkdirSync(leafHardlinkWorkspace, { recursive: true, mode: 0o700 });
      const leafHardlinkCopy = await copyPiSessionFile(source, join(leafHardlinkWorkspace, "copy.jsonl"), { workspaceDir: leafHardlinkWorkspace });
      if (!leafHardlinkCopy.ok) throw new Error(leafHardlinkCopy.error);
      const leafHardlinkHeld = join(leafHardlinkWorkspace, "copy-held.jsonl");
      let leafHardlinkHookRan = false;
      const leafHardlinkCleanup = await removePiSessionCopy(leafHardlinkCopy.sessionFile, leafHardlinkWorkspace, leafHardlinkCopy.identity, {
        testHooks: { beforePiCopyCleanup: (path) => {
          leafHardlinkHookRan = true;
          renameSync(path, leafHardlinkHeld);
          linkSync(leafHardlinkHeld, path);
        } },
      });
      check(
        !leafHardlinkCleanup.ok
          && existsSync(leafHardlinkCopy.sessionFile)
          && (process.platform === "linux"
            ? leafHardlinkHookRan && existsSync(leafHardlinkHeld)
            : !leafHardlinkHookRan),
        "Pi cleanup rejects a same-inode hardlink replacement",
      );
    
      const ancestorWorkspace = join(work, "ancestor-workspace");
      mkdirSync(ancestorWorkspace, { recursive: true, mode: 0o700 });
      const ancestorCopy = await copyPiSessionFile(source, join(ancestorWorkspace, "copy.jsonl"), { workspaceDir: ancestorWorkspace });
      if (!ancestorCopy.ok) throw new Error(ancestorCopy.error);
      const parked = join(work, "ancestor-workspace-parked");
      renameSync(ancestorWorkspace, parked);
      mkdirSync(ancestorWorkspace, { recursive: true, mode: 0o700 });
      const ancestorCleanup = await removePiSessionCopy(ancestorCopy.sessionFile, ancestorWorkspace, ancestorCopy.identity);
      check(!ancestorCleanup.ok && existsSync(join(parked, "copy.jsonl")), "Pi cleanup fails closed across an ancestor replacement");
    
      const hardlinkAncestorWorkspace = join(work, "hardlink-ancestor-workspace");
      mkdirSync(hardlinkAncestorWorkspace, { recursive: true, mode: 0o700 });
      const hardlinkAncestorCopy = await copyPiSessionFile(source, join(hardlinkAncestorWorkspace, "copy.jsonl"), { workspaceDir: hardlinkAncestorWorkspace });
      if (!hardlinkAncestorCopy.ok) throw new Error(hardlinkAncestorCopy.error);
      const hardlinkAncestorParked = join(work, "hardlink-ancestor-parked");
      renameSync(hardlinkAncestorWorkspace, hardlinkAncestorParked);
      mkdirSync(hardlinkAncestorWorkspace, { recursive: true, mode: 0o700 });
      linkSync(join(hardlinkAncestorParked, "copy.jsonl"), join(hardlinkAncestorWorkspace, "copy.jsonl"));
      const hardlinkAncestorCleanup = await removePiSessionCopy(
        join(hardlinkAncestorWorkspace, "copy.jsonl"),
        hardlinkAncestorWorkspace,
        hardlinkAncestorCopy.identity,
      );
      check(
        !hardlinkAncestorCleanup.ok
          && existsSync(join(hardlinkAncestorParked, "copy.jsonl"))
          && existsSync(join(hardlinkAncestorWorkspace, "copy.jsonl")),
        "Pi cleanup rejects a hardlink below an ancestor replacement",
      );
    
      const symlinkWorkspace = join(work, "symlink-workspace");
      mkdirSync(symlinkWorkspace, { recursive: true, mode: 0o700 });
      const outside = join(work, "outside.txt");
      writeFileSync(outside, "outside\n", { mode: 0o600 });
      symlinkSync(outside, join(symlinkWorkspace, "copy.jsonl"));
      const symlinkCleanup = await removePiSessionCopy(join(symlinkWorkspace, "copy.jsonl"), symlinkWorkspace, { dev: "0", ino: "0" });
      check(!symlinkCleanup.ok && readFileSync(outside, "utf8") === "outside\n", "Pi cleanup never follows a symlink leaf");
    
      const hardlinkWorkspace = join(work, "hardlink-workspace");
      mkdirSync(hardlinkWorkspace, { recursive: true, mode: 0o700 });
      const hardlinkOutside = join(work, "hardlink-outside.txt");
      writeFileSync(hardlinkOutside, "hardlink-outside\n", { mode: 0o600 });
      // A replacement hard link is deliberately not trusted by the expected copy identity.
      linkSync(hardlinkOutside, join(hardlinkWorkspace, "copy.jsonl"));
      const hardlinkCleanup = await removePiSessionCopy(join(hardlinkWorkspace, "copy.jsonl"), hardlinkWorkspace, { dev: "0", ino: "0" });
      check(!hardlinkCleanup.ok && existsSync(hardlinkOutside), "Pi cleanup preserves a hardlink replacement");
    
      console.log("PASS Pi session admission/cleanup regressions");
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
