import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { appendFile, link, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

describe("Sidecar Retirement Race & Restart Invariants", () => {
  it("passes sidecar retirement race and restart probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-sidecar-retirement-race-"));
    const eventsDir = join(root, "events");
    const bundle = join(root, "sidecar.mjs");
    const release = join(root, "release-final-guard");
    const finalGuardSignal = join(root, "final-guard.ready");
    const verifyWindowSignal = join(root, "verify-window.ready");
    const verifyGrowthSignal = join(root, "verify-growth.ready");
    const virtualPath = "termina-deterministic-final-guard-unlink";
    const virtualSource = `
    import { link as realLink, open as realOpen, readdir as realReaddir, rename as realRename, stat as realStat, unlink as realUnlink } from "node:fs/promises";
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
    const retainedOpens = new Map();
    const growthAppends = new Set();
    export const link = realLink;
    export async function open(path, ...args) {
      const handle = await realOpen(path, ...args);
      if (String(path).includes("term-after-verify") && String(path).includes(".retained-")) {
        const count = (retainedOpens.get(String(path)) ?? 0) + 1;
        retainedOpens.set(String(path), count);
        if (count === 1) {
          return new Proxy(handle, {
            get(target, property) {
              if (property === "close") {
                return async (...closeArgs) => {
                  return target.close(...closeArgs);
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }
      }
      if (String(path).includes("term-verify-growth") && String(path).includes(".retained-") && !growthAppends.has(String(path))) {
        growthAppends.add(String(path));
        appendFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1, 0x78));
        writeFileSync(${JSON.stringify(verifyGrowthSignal)}, "grown");
      }
      return handle;
    }
    export const readdir = realReaddir;
    export async function rename(from, to, ...args) {
      const result = await realRename(from, to, ...args);
      if (String(to).includes(".cursor-term-after-verify.json")) {
        try {
          const cursor = JSON.parse(readFileSync(to, "utf8"));
          if (cursor.sequence === 2 && typeof cursor.sealedSegment === "string" && cursor.sealedSegment.includes(".retained-")) {
            writeFileSync(${JSON.stringify(verifyWindowSignal)}, "verified");
          }
        } catch {}
      }
      return result;
    }
    export const stat = realStat;
    export async function unlink(path) {
      if (String(path).includes(".final-")) {
        writeFileSync(${JSON.stringify(finalGuardSignal)}, "ready");
        while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return realUnlink(path);
    }
    `;
    
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate, message, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) await wait(5);
      assert.equal(predicate(), true, message);
    };
    const record = (bridgeId, seq, t = "checkpoint_result", generation) => `${JSON.stringify({ bridgeId, seq, t, ...(generation ? { generation } : {}), ok: true })}\n`;
    const largeRecord = (bridgeId, seq, payloadBytes, t = "checkpoint_result", generation) => `${JSON.stringify({ bridgeId, seq, t, ...(generation ? { generation } : {}), ok: true, payload: "x".repeat(payloadBytes) })}\n`;
    const fakeWatch = () => ({ close() {} });
    const publishOwnerProof = async (sealedPath, bridgeId, writerGeneration = randomUUID(), lastSeq = 1) => {
      const stats = statSync(sealedPath);
      const sealedName = sealedPath.split("/").at(-1);
      const identity = `${String(stats.dev)}:${String(stats.ino)}`;
      await writeFile(`${sealedPath}.owner`, `${JSON.stringify({ version: 2, state: "closed", writerId: bridgeId, bridgeId, generation: writerGeneration, sealedName, identity, lastSeq })}\n`);
    };
    
    await build({
      entryPoints: ["electron/sidecar.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      logLevel: "silent",
      plugins: [{
        name: "delay-final-guard-unlink",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^node:fs\/promises$/ }, (args) => {
            if (args.namespace === "delay-fs") return { path: args.path, external: true };
            return { path: virtualPath, namespace: "delay-fs" };
          });
          pluginBuild.onLoad({ filter: /.*/, namespace: "delay-fs" }, () => ({ contents: virtualSource, loader: "js" }));
        },
      }],
    });
    
    await mkdir(eventsDir);
    const { SidecarTailer } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);
    
    const makeTailer = () => {
      const tailer = new SidecarTailer(eventsDir, fakeWatch, { maxBacklogBytes: 64 * 1024 * 1024 });
      tailer.start();
      return tailer;
    };
    
    try {
      // Window 1: an already-open pre-rotation descriptor appends after the
      // final guard stat but before its unlink completes. The retained inode must
      // make that record durable and restartable.
      const finalGuardId = "term-final-guard";
      const finalGuardActive = join(eventsDir, `${finalGuardId}.jsonl`);
      const finalGuardSealed = join(eventsDir, `.${finalGuardId}.jsonl.manual.sealed`);
      await writeFile(finalGuardActive, "");
      const firstFinalGuardTailer = makeTailer();
      const firstFinalGuardReceived = [];
      firstFinalGuardTailer.onEvent = (_id, event) => {
        firstFinalGuardReceived.push(event.seq);
        return true;
      };
      firstFinalGuardTailer.watch(finalGuardId);
      const finalGuardDescriptor = await open(finalGuardActive, "a");
      try {
        await appendFile(finalGuardActive, record(finalGuardId, 1, "agent_start") + record(finalGuardId, 2, "agent_settled"));
        await waitFor(() => firstFinalGuardReceived.length === 2, "final-guard setup records were not delivered");
        await rename(finalGuardActive, finalGuardSealed);
        // A structurally valid owner marker must not prove that an
        // external descriptor opened on the old active inode has closed.
        await publishOwnerProof(finalGuardSealed, finalGuardId, randomUUID(), 2);
        await writeFile(finalGuardActive, "");
        await waitFor(() => existsSync(finalGuardSignal), "final-guard unlink window was not reached");
    
        // This is intentionally between afterGuard's stat and finalGuard's
        // unlink completion. Release only after both descriptors have appended.
        await finalGuardDescriptor.write(record(finalGuardId, 3));
        await appendFile(finalGuardActive, record(finalGuardId, 4, "agent_settled"));
        writeFileSync(release, "release");
        await waitFor(() => firstFinalGuardReceived.length === 4, "final-guard late descriptor append was lost");
        assert.deepEqual(firstFinalGuardReceived, [1, 2, 3, 4]);
        assert.equal(existsSync(finalGuardSealed), false, "published sealed pathname was not retired");
        const retainedNames = readdirSync(eventsDir).filter((name) => name.startsWith(`.${finalGuardId}.jsonl.`) && name.includes(".retained-"));
        assert.equal(retainedNames.length, 1, "unproven generation did not retain one restart anchor");
        await waitFor(() => {
          try {
            return JSON.parse(readFileSync(join(eventsDir, `.cursor-${finalGuardId}.json`), "utf8")).sequence === 4;
          } catch {
            return false;
          }
        }, "final-guard cursor was not persisted through sequence 4");
        const firstCursor = JSON.parse(await readFile(join(eventsDir, `.cursor-${finalGuardId}.json`), "utf8"));
        assert.equal(firstCursor.sequence, 4);
        assert.equal(firstCursor.sealedSegment, retainedNames[0]);
      } finally {
        await finalGuardDescriptor.close();
        firstFinalGuardTailer.stop();
      }
    
      await wait(50);
      const afterFinalGuardRestart = [];
      const secondFinalGuardTailer = makeTailer();
      secondFinalGuardTailer.onEvent = (_id, event) => {
        afterFinalGuardRestart.push(event.seq);
        return true;
      };
      secondFinalGuardTailer.watch(finalGuardId);
      try {
        await appendFile(finalGuardActive, record(finalGuardId, 5, "agent_settled"));
        await waitFor(() => afterFinalGuardRestart.length === 1, "final-guard restart did not deliver the next active record");
        assert.deepEqual(afterFinalGuardRestart, [5], "final-guard restart replayed or skipped records");
      } finally {
        secondFinalGuardTailer.stop();
      }
    
      // Window 2: verification itself is not a close proof. An escaped
      // descriptor appends after verifySealedPublication has finished reading
      // the retained anchor; the anchor must remain reachable and the late event
      // must still be delivered after the active event.
      const verifyWindowId = "term-after-verify";
      const verifyWindowActive = join(eventsDir, `${verifyWindowId}.jsonl`);
      const verifyWindowSealed = join(eventsDir, `.${verifyWindowId}.jsonl.manual.sealed`);
      await writeFile(verifyWindowActive, "");
      const verifyWindowTailer = makeTailer();
      const verifyWindowReceived = [];
      verifyWindowTailer.onEvent = (_id, event) => {
        verifyWindowReceived.push(event.seq);
        return true;
      };
      verifyWindowTailer.watch(verifyWindowId);
      const verifyWindowDescriptor = await open(verifyWindowActive, "a");
      try {
        const verifyGeneration = randomUUID();
        await appendFile(verifyWindowActive, record(verifyWindowId, 1, "agent_start", verifyGeneration) + record(verifyWindowId, 2, "agent_settled", verifyGeneration));
        await waitFor(() => verifyWindowReceived.length === 2, "verification-window setup was not delivered");
        await rename(verifyWindowActive, verifyWindowSealed);
        await publishOwnerProof(verifyWindowSealed, verifyWindowId, verifyGeneration, 2);
        await writeFile(verifyWindowActive, "");
        await waitFor(() => existsSync(verifyWindowSignal), "verification read completion was not observed");
        await verifyWindowDescriptor.write(record(verifyWindowId, 3));
        await appendFile(verifyWindowActive, record(verifyWindowId, 4, "agent_settled"));
        await waitFor(() => verifyWindowReceived.length === 4, "post-verification late descriptor append was lost");
        assert.deepEqual(verifyWindowReceived, [1, 2, 3, 4]);
        assert.equal(existsSync(verifyWindowSealed), false, "verification-window sealed pathname was not retired");
        const retainedNames = readdirSync(eventsDir).filter((name) => name.startsWith(`.${verifyWindowId}.jsonl.`) && name.includes(".retained-"));
        assert.equal(retainedNames.length, 1, "post-verification probe did not retain the identity anchor");
        assert.equal(existsSync(join(eventsDir, retainedNames[0])), true, "post-verification identity anchor disappeared");
      } finally {
        await verifyWindowDescriptor.close();
        verifyWindowTailer.stop();
      }
      await wait(50);
      const verifyWindowRestart = makeTailer();
      const verifyWindowAfterRestart = [];
      verifyWindowRestart.onEvent = (_id, event) => {
        verifyWindowAfterRestart.push(event.seq);
        return true;
      };
      verifyWindowRestart.watch(verifyWindowId);
      try {
        await appendFile(verifyWindowActive, record(verifyWindowId, 5, "agent_settled"));
        await waitFor(() => verifyWindowAfterRestart.length === 1, "post-verification retained anchor did not survive restart");
        assert.deepEqual(verifyWindowAfterRestart, [5]);
      } finally {
        verifyWindowRestart.stop();
      }
    
      // Window 3: verification must stop at its hard byte cap when the retained
      // inode grows after the initial stat and before the read. The source stays
      // anchored; no unbounded proof buffer or alias allocation is permitted.
      const verifyGrowthId = "term-verify-growth";
      const verifyGrowthActive = join(eventsDir, `${verifyGrowthId}.jsonl`);
      const verifyGrowthSealed = join(eventsDir, `.${verifyGrowthId}.jsonl.manual.sealed`);
      await writeFile(verifyGrowthActive, "");
      const verifyGrowthTailer = makeTailer();
      const verifyGrowthReceived = [];
      verifyGrowthTailer.onEvent = (_id, event) => {
        verifyGrowthReceived.push(event.seq);
        return true;
      };
      verifyGrowthTailer.watch(verifyGrowthId);
      try {
        const growthGeneration = randomUUID();
        await appendFile(verifyGrowthActive, record(verifyGrowthId, 1, "agent_start", growthGeneration) + record(verifyGrowthId, 2, "agent_settled", growthGeneration));
        await waitFor(() => verifyGrowthReceived.length === 2, "verification-growth setup was not delivered");
        await rename(verifyGrowthActive, verifyGrowthSealed);
        await publishOwnerProof(verifyGrowthSealed, verifyGrowthId, growthGeneration, 2);
        await writeFile(verifyGrowthActive, "");
        await waitFor(() => existsSync(verifyGrowthSignal), "verification-growth append did not race the bounded read");
        await waitFor(() => readdirSync(eventsDir).some((name) => name.startsWith(basename(verifyGrowthSealed) + ".retained-")), "verification-growth source was not retained after the cap");
        assert.deepEqual(verifyGrowthReceived, [1, 2]);
        const growthRetained = readdirSync(eventsDir).filter((name) => name.startsWith(`.${verifyGrowthId}.jsonl.`) && name.includes(".retained-"));
        assert.equal(growthRetained.length, 1, "verification-growth allocated more than one bounded anchor");
      } finally {
        verifyGrowthTailer.stop();
      }
    
      // Repeated retained generations must hit a bounded fail-closed boundary.
      // Even a complete v2 proof cannot prove that an escaped POSIX descriptor
      // will not append after the verification read, so the last identity anchor
      // remains reachable and a later rotation is refused/quarantined.
      const repeatedId = "term-repeated-retirement";
      const repeatedActive = join(eventsDir, `${repeatedId}.jsonl`);
      await writeFile(repeatedActive, "");
      const repeatedTailer = makeTailer();
      const repeatedReceived = [];
      repeatedTailer.onEvent = (_id, event) => {
        repeatedReceived.push(event.seq);
        return true;
      };
      repeatedTailer.watch(repeatedId);
      try {
        let repeatedGeneration = randomUUID();
        await appendFile(repeatedActive, record(repeatedId, 1, "checkpoint_result", repeatedGeneration) + record(repeatedId, 2, "checkpoint_result", repeatedGeneration));
        await waitFor(() => repeatedReceived.length === 2, "repeated-retention setup was not delivered");
        const firstSealed = join(eventsDir, `.${repeatedId}.jsonl.generation-2.sealed`);
        await rename(repeatedActive, firstSealed);
        await writeFile(repeatedActive, "");
        await publishOwnerProof(firstSealed, repeatedId, repeatedGeneration, 2);
        repeatedGeneration = randomUUID();
        await waitFor(() => readdirSync(eventsDir).some((name) => name.startsWith(basename(firstSealed) + ".retained-")), "first retained generation was not anchored");
        const firstRetained = readdirSync(eventsDir).filter((name) => name.startsWith(`.${repeatedId}.jsonl.`) && name.includes(".retained-"));
        assert.equal(firstRetained.length, 1, "first retained generation allocated more than one anchor");
    
        await appendFile(repeatedActive, record(repeatedId, 3, "checkpoint_result", repeatedGeneration));
        await waitFor(() => repeatedReceived.length === 3, "active delivery behind retained generation was blocked");
        const secondSealed = join(eventsDir, `.${repeatedId}.jsonl.generation-3.sealed`);
        await rename(repeatedActive, secondSealed);
        await writeFile(repeatedActive, "");
        await waitFor(() => repeatedTailer.isPaused(repeatedId) && existsSync(join(eventsDir, `.quarantine-${repeatedId}`)), "repeated retained cap did not fail closed");
        assert.equal(existsSync(secondSealed), true, "quarantine deleted a possible second generation");
        const repeatedRetained = readdirSync(eventsDir).filter((name) => name.startsWith(`.${repeatedId}.jsonl.`) && name.includes(".retained-"));
        assert.equal(repeatedRetained.length, 1, "repeated retained cap allocated unbounded anchors");
        const repeatedCursor = JSON.parse(await readFile(join(eventsDir, `.cursor-${repeatedId}.json`), "utf8"));
        assert.equal(repeatedCursor.sequence, 3);
        assert.equal(repeatedCursor.sealedSegment, repeatedRetained[0]);
      } finally {
        repeatedTailer.stop();
      }
    
      const repeatedRestart = makeTailer();
      repeatedRestart.watch(repeatedId);
      try {
        await waitFor(() => repeatedRestart.isPaused(repeatedId) && existsSync(join(eventsDir, `.quarantine-${repeatedId}`)), "repeated retained quarantine did not survive restart");
      } finally {
        repeatedRestart.stop();
      }
    
      // An unproven generation is retained exactly once. If another sealed
      // generation appears behind that anchor, admission is quarantined instead
      // of allocating another alias or advancing the active cursor.
      const boundedId = "term-retained-bound";
      const boundedActive = join(eventsDir, `${boundedId}.jsonl`);
      const boundedSealed = join(eventsDir, `.${boundedId}.jsonl.first.sealed`);
      const boundedSecondSealed = join(eventsDir, `.${boundedId}.jsonl.second.sealed`);
      await writeFile(boundedActive, "");
      const boundedTailer = new SidecarTailer(eventsDir, fakeWatch, { maxBacklogBytes: 1024 });
      boundedTailer.start();
      const boundedReceived = [];
      boundedTailer.onEvent = (_id, event) => {
        boundedReceived.push(event.seq);
        return true;
      };
      boundedTailer.watch(boundedId);
      try {
        await appendFile(boundedActive, record(boundedId, 1, "agent_start"));
        await waitFor(() => boundedReceived.length === 1, "bounded-retention setup was not delivered");
        await rename(boundedActive, boundedSealed);
        await writeFile(boundedActive, "");
        await waitFor(() => readdirSync(eventsDir).some((name) => name.startsWith(basename(boundedSealed) + ".retained-")), "unproven generation did not produce its single quarantine anchor");
        const boundedRetainedAnchor = readdirSync(eventsDir).find((name) => name.startsWith(basename(boundedSealed) + ".retained-"));
        assert.equal(typeof boundedRetainedAnchor, "string");
        // An escaped descriptor may continue growing the retained inode. The
        // tailer must surface bounded overflow/quarantine without allocating a
        // second identity anchor or deleting the first one.
        const boundedDescriptor = await open(join(eventsDir, boundedRetainedAnchor), "a");
        await boundedDescriptor.write("x".repeat(2048));
        await waitFor(() => boundedTailer.isPaused(boundedId) && existsSync(join(eventsDir, `.quarantine-${boundedId}`)), "concurrent retained growth did not reach the bounded quarantine");
        await boundedDescriptor.close();
        await appendFile(boundedActive, record(boundedId, 2));
        await rename(boundedActive, boundedSecondSealed);
        await writeFile(boundedActive, "");
        await waitFor(() => boundedTailer.isPaused(boundedId) && existsSync(join(eventsDir, `.quarantine-${boundedId}`)), "retained-generation overflow did not enter terminal quarantine");
        const boundedRetained = readdirSync(eventsDir).filter((name) => name.startsWith(`.${boundedId}.jsonl.`) && name.includes(".retained-"));
        assert.equal(boundedRetained.length, 1, "retained-generation overflow allocated unbounded anchors");
        assert.deepEqual(boundedReceived, [1]);
        assert.equal(JSON.parse(await readFile(join(eventsDir, `.cursor-${boundedId}.json`), "utf8")).sequence, 1);
        // A shutdown/restart must preserve the terminal-local quarantine. The
        // unresolved source cannot be admitted again merely because in-memory
        // tailer state was torn down.
        boundedTailer.stop();
        const boundedRestart = makeTailer();
        boundedRestart.watch(boundedId);
        try {
          await waitFor(() => boundedRestart.isPaused(boundedId) && existsSync(join(eventsDir, `.quarantine-${boundedId}`)), "source quarantine did not survive restart");
        } finally {
          boundedRestart.stop();
        }
      } finally {
        boundedTailer.stop();
      }
    
      // Crash probes cover each publication boundary. The first tailer commits
      // seq1/2, then the filesystem is left at one deterministic intermediate
      // state before restart. Every case must deliver only seq3 afterward.
      const runCrashPublicationCase = async (caseName, stage) => {
        const id = `term-crash-${caseName}`;
        const active = join(eventsDir, `${id}.jsonl`);
        const sealed = join(eventsDir, `.${id}.jsonl.crash.sealed`);
        const crashGeneration = randomUUID();
        await writeFile(active, "");
        const first = makeTailer();
        const firstReceived = [];
        first.onEvent = (_id, event) => {
          firstReceived.push(event.seq);
          return true;
        };
        first.watch(id);
        await appendFile(active, record(id, 1, "agent_start", crashGeneration) + record(id, 2, "agent_settled", crashGeneration));
        await waitFor(() => firstReceived.length === 2, `${caseName} setup was not delivered`);
        await waitFor(() => {
          try { return JSON.parse(readFileSync(join(eventsDir, `.cursor-${id}.json`), "utf8")).sequence === 2; } catch { return false; }
        }, `${caseName} setup cursor was not durable`);
        first.stop();
    
        if (stage === "orphan-proof") {
          await writeFile(`${sealed}.owner`, "orphan\n");
        } else {
          await rename(active, sealed);
          if (stage !== "renamed") {
            await writeFile(active, "");
            if (stage === "complete") await publishOwnerProof(sealed, id, crashGeneration, 2);
            if (stage === "after-drain-link") await link(sealed, `${sealed}.draining-crash`);
            if (stage === "after-final-link") {
              const draining = `${sealed}.draining-crash`;
              const finalGuard = `${draining}.final-crash`;
              await link(sealed, draining);
              await link(draining, finalGuard);
              await rm(sealed);
            }
          }
        }
    
        const second = makeTailer();
        const afterRestart = [];
        second.onEvent = (_id, event) => {
          afterRestart.push(event.seq);
          return true;
        };
        second.watch(id);
        try {
          await appendFile(active, record(id, 3, "agent_settled"));
          await waitFor(() => afterRestart.length === 1, `${caseName} restart did not deliver seq3`);
          assert.deepEqual(afterRestart, [3], `${caseName} replayed or skipped events`);
          await waitFor(() => {
            try { return JSON.parse(readFileSync(join(eventsDir, `.cursor-${id}.json`), "utf8")).sequence === 3; } catch { return false; }
          }, `${caseName} restart cursor was not durable`);
          if (stage === "complete") await waitFor(() => !existsSync(sealed), `${caseName} sealed generation was not retired`);
          if (stage === "orphan-proof") await waitFor(() => !existsSync(`${sealed}.owner`), `${caseName} orphan proof was not removed`);
        } finally {
          second.stop();
        }
      };
      await runCrashPublicationCase("before-rename", "orphan-proof");
      await runCrashPublicationCase("after-rename", "renamed");
      await runCrashPublicationCase("after-active", "active");
      await runCrashPublicationCase("after-drain-link", "after-drain-link");
      await runCrashPublicationCase("after-final-link", "after-final-link");
      await runCrashPublicationCase("complete", "complete");
    } finally {
      await wait(100);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
    
    console.log("sidecar retirement race and restart probes passed");
    
  }, 120_000);
});
