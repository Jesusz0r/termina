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
    const largeGrowthSignal = join(root, "large-growth.ready");
    const largeGrowthRemainder = join(root, "large-growth.remainder");
    const virtualPath = "termina-deterministic-final-guard-unlink";
    const virtualSource = `
    import { link as realLink, open as realOpen, readdir as realReaddir, rename as realRename, stat as realStat, unlink as realUnlink } from "node:fs/promises";
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
    const retainedOpens = new Map();
    const growthAppends = new Set();
    const largeGrowthAppends = new Set();
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
      if (String(path).includes("term-large-growth") && String(path).includes(".segment.legacy-") && !largeGrowthAppends.has(String(path))) {
        largeGrowthAppends.add(String(path));
        appendFileSync(path, readFileSync(${JSON.stringify(largeGrowthRemainder)}));
        writeFileSync(${JSON.stringify(largeGrowthSignal)}, "grown");
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
        // A structurally valid legacy owner marker must not prove that an
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
    
      // Window 4: a legacy .segment descriptor is opened before its initial
      // drain. A later append through that descriptor must be scanned again, and
      // its cursor must survive a restart without replaying old records.
      const legacyId = "term-legacy-late";
      const legacyActive = join(eventsDir, `${legacyId}.jsonl`);
      const legacySegment = join(eventsDir, `.${legacyId}.jsonl.segment`);
      await writeFile(legacyActive, "");
      await writeFile(legacySegment, record(legacyId, 1, "agent_start") + record(legacyId, 2, "agent_settled"));
      const firstLegacyTailer = makeTailer();
      const firstLegacyReceived = [];
      firstLegacyTailer.onEvent = (_id, event) => {
        firstLegacyReceived.push(event.seq);
        return true;
      };
      firstLegacyTailer.watch(legacyId);
      const legacyDescriptor = await open(legacySegment, "a");
      try {
        await waitFor(() => firstLegacyReceived.length === 2 && firstLegacyTailer.legacySegmentsDrained.has(legacyId), "legacy initial drain did not complete");
        await legacyDescriptor.write(record(legacyId, 3));
        await appendFile(legacyActive, record(legacyId, 4, "agent_settled"));
        await waitFor(() => firstLegacyReceived.length === 4, "legacy delayed descriptor append was lost");
        assert.deepEqual(firstLegacyReceived, [1, 2, 3, 4]);
        await waitFor(() => {
          try {
            return JSON.parse(readFileSync(join(eventsDir, `.cursor-${legacyId}.json`), "utf8")).sequence === 4;
          } catch {
            return false;
          }
        }, "legacy cursor was not persisted through sequence 4");
        const firstCursor = JSON.parse(await readFile(join(eventsDir, `.cursor-${legacyId}.json`), "utf8"));
        assert.equal(firstCursor.sequence, 4);
        assert.equal(firstCursor.sealedSegment.startsWith(`.${legacyId}.jsonl.segment.legacy-`), true);
        assert.equal(typeof firstCursor.segmentIdentity, "string");
      } finally {
        await legacyDescriptor.close();
        firstLegacyTailer.stop();
      }
    
      await wait(50);
      const afterLegacyRestart = [];
      const secondLegacyTailer = makeTailer();
      secondLegacyTailer.onEvent = (_id, event) => {
        afterLegacyRestart.push(event.seq);
        return true;
      };
      secondLegacyTailer.watch(legacyId);
      try {
        await appendFile(legacyActive, record(legacyId, 5, "agent_settled"));
        await waitFor(() => afterLegacyRestart.length === 1, "legacy restart did not deliver the next active record");
        assert.deepEqual(afterLegacyRestart, [5], "legacy restart replayed or skipped records");
        assert.equal(existsSync(legacySegment), true, "legacy segment was destructively retired");
      } finally {
        secondLegacyTailer.stop();
      }
    
      // Equal-size ABA: the fixed compatibility pathname is replaced while an
      // old descriptor remains open. Distinct inode anchors must preserve both
      // generations and restart must resume their per-identity cursors.
      const abaId = "term-legacy-aba";
      const abaActive = join(eventsDir, `${abaId}.jsonl`);
      const abaSegment = join(eventsDir, `.${abaId}.jsonl.segment`);
      const abaReplacement = join(eventsDir, `.${abaId}.jsonl.segment.replacement`);
      await writeFile(abaActive, "");
      await writeFile(abaSegment, record(abaId, 1, "agent_start") + record(abaId, 2, "agent_settled"));
      const firstAbaTailer = makeTailer();
      const firstAbaReceived = [];
      firstAbaTailer.onEvent = (_id, event) => {
        firstAbaReceived.push(event.seq);
        return true;
      };
      firstAbaTailer.watch(abaId);
      const abaDescriptor = await open(abaSegment, "a");
      try {
        await waitFor(() => firstAbaReceived.length === 2 && firstAbaTailer.legacySegmentsDrained.has(abaId), "ABA initial drain did not complete");
        await writeFile(abaReplacement, record(abaId, 4, "checkpoint_result") + record(abaId, 5, "agent_settled"));
        await rm(abaSegment);
        await rename(abaReplacement, abaSegment);
        // Let reconciliation observe the replacement before the old descriptor
        // supplies seq3. The newer identity must remain pending rather than
        // overtaking the unresolved legacy generation.
        await wait(450);
        assert.deepEqual(firstAbaReceived, [1, 2], "equal-size ABA source overtook an unresolved older identity");
        await abaDescriptor.write(record(abaId, 3));
        await appendFile(abaActive, record(abaId, 6, "agent_settled"));
        await waitFor(() => firstAbaReceived.length === 6, "equal-size ABA generations were not delivered in order");
        assert.deepEqual(firstAbaReceived, [1, 2, 3, 4, 5, 6]);
        assert.equal(firstAbaTailer.isPaused(abaId), false);
        await waitFor(() => {
          try {
            const cursor = JSON.parse(readFileSync(join(eventsDir, `.cursor-${abaId}.json`), "utf8"));
            return cursor.segmentSources?.length === 2 && cursor.segmentSources[0].identity !== cursor.segmentSources[1].identity;
          } catch {
            return false;
          }
        }, "equal-size ABA identities were not persisted");
      } finally {
        await abaDescriptor.close();
        firstAbaTailer.stop();
      }
    
      await wait(50);
      const afterAbaRestart = [];
      const secondAbaTailer = makeTailer();
      secondAbaTailer.onEvent = (_id, event) => {
        afterAbaRestart.push(event.seq);
        return true;
      };
      secondAbaTailer.watch(abaId);
      try {
        await appendFile(abaActive, record(abaId, 7, "agent_settled"));
        await waitFor(() => afterAbaRestart.length === 1, "equal-size ABA restart did not deliver the next active record");
        assert.deepEqual(afterAbaRestart, [7], "equal-size ABA restart replayed or skipped records");
      } finally {
        secondAbaTailer.stop();
      }
    
      // A legacy identity and a canonical sealed identity can coexist. Candidate
      // scheduling must choose the source carrying the next expected sequence;
      // pathname/sealed-first ordering would repeatedly defer seq4 and starve
      // the legacy descriptor's late seq3.
      const orderId = "term-legacy-sealed-order";
      const orderActive = join(eventsDir, `${orderId}.jsonl`);
      const orderSegment = join(eventsDir, `.${orderId}.jsonl.segment`);
      const orderSealed = join(eventsDir, `.${orderId}.jsonl.canonical.sealed`);
      await writeFile(orderActive, "");
      await writeFile(orderSegment, record(orderId, 1, "agent_start") + record(orderId, 2, "agent_settled"));
      const orderTailer = makeTailer();
      const orderReceived = [];
      orderTailer.onEvent = (_id, event) => {
        orderReceived.push(event.seq);
        return true;
      };
      orderTailer.watch(orderId);
      const orderDescriptor = await open(orderSegment, "a");
      try {
        await waitFor(() => orderReceived.length === 2 && orderTailer.legacySegmentsDrained.has(orderId), "legacy/sealed ordering setup was not delivered");
        const orderGeneration = randomUUID();
        await writeFile(orderSealed, record(orderId, 4, "agent_settled", orderGeneration));
        await publishOwnerProof(orderSealed, orderId, orderGeneration, 4);
        await wait(450);
        assert.deepEqual(orderReceived, [1, 2], "canonical sealed seq4 overtook the unresolved legacy seq3");
        await orderDescriptor.write(record(orderId, 3));
        await waitFor(() => orderReceived.length === 4, "legacy/canonical sequence scheduler did not drain seq3 before seq4");
        assert.deepEqual(orderReceived, [1, 2, 3, 4]);
        assert.equal(orderTailer.isPaused(orderId), false);
      } finally {
        await orderDescriptor.close();
        orderTailer.stop();
      }
    
      // The inverse coexistence order must also work: a legacy seq4 that is
      // already pending must not prevent a canonical sealed seq3 from being
      // selected, and the retained canonical identity must not shadow the
      // legacy anchor while seq4 is drained.
      const retainedOrderId = "term-retained-legacy-order";
      const retainedOrderActive = join(eventsDir, `${retainedOrderId}.jsonl`);
      const retainedOrderSegment = join(eventsDir, `.${retainedOrderId}.jsonl.segment`);
      const retainedOrderSealed = join(eventsDir, `.${retainedOrderId}.jsonl.canonical.sealed`);
      await writeFile(retainedOrderActive, "");
      await writeFile(retainedOrderSegment, record(retainedOrderId, 1, "agent_start") + record(retainedOrderId, 2, "agent_settled"));
      const retainedOrderTailer = makeTailer();
      const retainedOrderReceived = [];
      retainedOrderTailer.onEvent = (_id, event) => {
        retainedOrderReceived.push(event.seq);
        return true;
      };
      retainedOrderTailer.watch(retainedOrderId);
      const retainedOrderDescriptor = await open(retainedOrderSegment, "a");
      try {
        await waitFor(() => retainedOrderReceived.length === 2 && retainedOrderTailer.legacySegmentsDrained.has(retainedOrderId), "retained-order setup was not delivered");
        await retainedOrderDescriptor.write(record(retainedOrderId, 4));
        await waitFor(() => retainedOrderTailer.isPaused(retainedOrderId), "retained-order legacy seq4 did not remain behind the missing seq3");
        const retainedOrderGeneration = randomUUID();
        await writeFile(retainedOrderSealed, record(retainedOrderId, 3, "checkpoint_result", retainedOrderGeneration));
        await publishOwnerProof(retainedOrderSealed, retainedOrderId, retainedOrderGeneration, 3);
        await waitFor(() => retainedOrderReceived.length === 4, "retained-order scheduler did not drain canonical seq3 then legacy seq4");
        assert.deepEqual(retainedOrderReceived, [1, 2, 3, 4]);
      } finally {
        await retainedOrderDescriptor.close();
        retainedOrderTailer.stop();
      }
    
      // A legacy descriptor may append after a canonical generation has already
      // become a permanent retained anchor. The scheduler must reconcile that
      // later identity before active seq5, then restart from durable per-identity
      // cursors without replaying seq1-5.
      const retainedLateId = "term-retained-legacy-late";
      const retainedLateActive = join(eventsDir, `${retainedLateId}.jsonl`);
      const retainedLateSegment = join(eventsDir, `.${retainedLateId}.jsonl.segment`);
      const retainedLateSealed = join(eventsDir, `.${retainedLateId}.jsonl.manual.sealed`);
      await writeFile(retainedLateActive, "");
      await writeFile(retainedLateSegment, record(retainedLateId, 1, "agent_start") + record(retainedLateId, 2, "agent_settled"));
      const retainedLateTailer = makeTailer();
      const retainedLateReceived = [];
      retainedLateTailer.onEvent = (_id, event) => {
        retainedLateReceived.push(event.seq);
        return true;
      };
      retainedLateTailer.watch(retainedLateId);
      const retainedLateDescriptor = await open(retainedLateSegment, "a");
      try {
        await waitFor(() => retainedLateReceived.length === 2 && retainedLateTailer.legacySegmentsDrained.has(retainedLateId), "retained-late legacy setup was not delivered");
        const retainedLateGeneration = randomUUID();
        await appendFile(retainedLateActive, record(retainedLateId, 3, "checkpoint_result", retainedLateGeneration));
        await rename(retainedLateActive, retainedLateSealed);
        await writeFile(retainedLateActive, "");
        await publishOwnerProof(retainedLateSealed, retainedLateId, retainedLateGeneration, 3);
        await waitFor(() => retainedLateReceived.length === 3 && readdirSync(eventsDir).some((name) => name.startsWith(basename(retainedLateSealed) + ".retained-")), "retained-late canonical source was not retained");
        await retainedLateDescriptor.write(record(retainedLateId, 4));
        await appendFile(retainedLateActive, record(retainedLateId, 5, "agent_settled"));
        await waitFor(() => retainedLateReceived.length === 5, "retained-late legacy identity bypassed by active seq5");
        assert.deepEqual(retainedLateReceived, [1, 2, 3, 4, 5]);
        assert.equal(retainedLateTailer.isPaused(retainedLateId), false);
        await waitFor(() => {
          try {
            return JSON.parse(readFileSync(join(eventsDir, `.cursor-${retainedLateId}.json`), "utf8")).sequence === 5;
          } catch {
            return false;
          }
        }, "retained-late cursor was not persisted through seq5");
      } finally {
        await retainedLateDescriptor.close();
        retainedLateTailer.stop();
      }
    
      await wait(50);
      const retainedLateRestart = makeTailer();
      const retainedLateAfterRestart = [];
      retainedLateRestart.onEvent = (_id, event) => {
        retainedLateAfterRestart.push(event.seq);
        return true;
      };
      retainedLateRestart.watch(retainedLateId);
      try {
        await appendFile(retainedLateActive, record(retainedLateId, 6, "agent_settled"));
        await waitFor(() => retainedLateAfterRestart.length === 1, "retained-late restart did not deliver seq6");
        assert.deepEqual(retainedLateAfterRestart, [6], "retained-late restart replayed or skipped events");
      } finally {
        retainedLateRestart.stop();
      }
    
      // A valid legacy record may exceed one tail read. Candidate peeking must
      // parse incrementally up to the canonical record cap before allowing an
      // active later sequence to win.
      const largeHiddenId = "term-global-large-hidden";
      const largeHiddenActive = join(eventsDir, `${largeHiddenId}.jsonl`);
      const largeHiddenSegment = join(eventsDir, `.${largeHiddenId}.jsonl.segment`);
      await writeFile(largeHiddenActive, record(largeHiddenId, 2, "agent_settled"));
      await writeFile(largeHiddenSegment, largeRecord(largeHiddenId, 1, 2 * 1024 * 1024, "agent_start"));
      const largeHiddenTailer = makeTailer();
      const largeHiddenReceived = [];
      largeHiddenTailer.onEvent = (_id, event) => {
        largeHiddenReceived.push(event.seq);
        return true;
      };
      largeHiddenTailer.watch(largeHiddenId);
      try {
        await waitFor(() => largeHiddenReceived.length === 2, "large hidden legacy record did not precede active seq2");
        assert.deepEqual(largeHiddenReceived, [1, 2]);
        await waitFor(() => {
          try { return JSON.parse(readFileSync(join(eventsDir, `.cursor-${largeHiddenId}.json`), "utf8")).sequence === 2; } catch { return false; }
        }, "large hidden cursor was not persisted through seq2");
      } finally {
        largeHiddenTailer.stop();
      }
    
      await wait(50);
      const largeHiddenRestart = makeTailer();
      const largeHiddenAfterRestart = [];
      largeHiddenRestart.onEvent = (_id, event) => {
        largeHiddenAfterRestart.push(event.seq);
        return true;
      };
      largeHiddenRestart.watch(largeHiddenId);
      try {
        await appendFile(largeHiddenActive, record(largeHiddenId, 3, "agent_settled"));
        await waitFor(() => largeHiddenAfterRestart.length === 1, "large hidden restart did not deliver seq3");
        assert.deepEqual(largeHiddenAfterRestart, [3], "large hidden restart replayed or skipped events");
      } finally {
        largeHiddenRestart.stop();
      }
    
      // An incomplete record under the cap must block active seq2 until its
      // newline arrives. The second half is appended after several retry polls.
      const chunkedId = "term-large-chunked";
      const chunkedActive = join(eventsDir, `${chunkedId}.jsonl`);
      const chunkedSegment = join(eventsDir, `.${chunkedId}.jsonl.segment`);
      const chunkedRecord = largeRecord(chunkedId, 1, 2 * 1024 * 1024, "agent_start");
      const chunkedSplit = Math.floor(chunkedRecord.length / 2);
      await writeFile(chunkedActive, record(chunkedId, 2, "agent_settled"));
      await writeFile(chunkedSegment, chunkedRecord.slice(0, chunkedSplit));
      const chunkedTailer = makeTailer();
      const chunkedReceived = [];
      chunkedTailer.onEvent = (_id, event) => {
        chunkedReceived.push(event.seq);
        return true;
      };
      chunkedTailer.watch(chunkedId);
      try {
        await wait(450);
        assert.deepEqual(chunkedReceived, [], "active seq2 overtook an incomplete legacy record");
        await appendFile(chunkedSegment, chunkedRecord.slice(chunkedSplit));
        await waitFor(() => chunkedReceived.length === 2, "chunked legacy record did not complete before active seq2");
        assert.deepEqual(chunkedReceived, [1, 2]);
      } finally {
        chunkedTailer.stop();
      }
    
      // A complete legacy record larger than the canonical 8 MiB cap is still
      // unsafe: its envelope cannot be admitted and active seq2 must not pass it.
      // Quarantine must preserve the fixed-name source and survive restart.
      const completeOversizedId = "term-large-oversized-complete";
      const completeOversizedActive = join(eventsDir, `${completeOversizedId}.jsonl`);
      const completeOversizedSegment = join(eventsDir, `.${completeOversizedId}.jsonl.segment`);
      await writeFile(completeOversizedActive, record(completeOversizedId, 2, "agent_settled"));
      await writeFile(completeOversizedSegment, largeRecord(completeOversizedId, 1, 8 * 1024 * 1024, "agent_start"));
      const completeOversizedTailer = makeTailer();
      const completeOversizedReceived = [];
      completeOversizedTailer.onEvent = (_id, event) => {
        completeOversizedReceived.push(event.seq);
        return true;
      };
      completeOversizedTailer.watch(completeOversizedId);
      try {
        await waitFor(() => completeOversizedTailer.isPaused(completeOversizedId) && existsSync(join(eventsDir, `.quarantine-${completeOversizedId}`)), "complete oversized legacy record was not quarantined");
        assert.deepEqual(completeOversizedReceived, [], "active seq2 overtook a complete oversized legacy record");
        assert.equal(existsSync(completeOversizedSegment), true, "complete oversized legacy source was deleted");
      } finally {
        completeOversizedTailer.stop();
      }
      await wait(50);
      const completeOversizedRestart = makeTailer();
      const completeOversizedAfterRestart = [];
      completeOversizedRestart.onEvent = (_id, event) => {
        completeOversizedAfterRestart.push(event.seq);
        return true;
      };
      completeOversizedRestart.watch(completeOversizedId);
      try {
        await appendFile(completeOversizedActive, record(completeOversizedId, 3, "agent_settled"));
        await wait(450);
        assert.deepEqual(completeOversizedAfterRestart, [], "complete oversized quarantine admitted active seq3 after restart");
        assert.equal(completeOversizedRestart.isPaused(completeOversizedId), true);
        assert.equal(existsSync(completeOversizedSegment), true, "complete oversized source disappeared after restart");
      } finally {
        completeOversizedRestart.stop();
      }
    
      // A source whose first record exceeds the canonical cap is rejected
      // deterministically. Its bytes and quarantine marker remain restartable;
      // active seq2 is never silently admitted past the unknown record.
      const oversizedId = "term-large-oversized";
      const oversizedActive = join(eventsDir, `${oversizedId}.jsonl`);
      const oversizedSegment = join(eventsDir, `.${oversizedId}.jsonl.segment`);
      await writeFile(oversizedActive, record(oversizedId, 2, "agent_settled"));
      const oversizedRecord = largeRecord(oversizedId, 1, 8 * 1024 * 1024, "agent_start");
      await writeFile(oversizedSegment, oversizedRecord.slice(0, -1));
      const oversizedTailer = makeTailer();
      const oversizedReceived = [];
      oversizedTailer.onEvent = (_id, event) => {
        oversizedReceived.push(event.seq);
        return true;
      };
      oversizedTailer.watch(oversizedId);
      try {
        await waitFor(() => oversizedTailer.isPaused(oversizedId) && existsSync(join(eventsDir, `.quarantine-${oversizedId}`)), "oversized legacy record was not quarantined");
        assert.deepEqual(oversizedReceived, [], "active seq2 overtook an oversized legacy record");
        assert.equal(existsSync(oversizedSegment), true, "oversized legacy source was deleted");
      } finally {
        oversizedTailer.stop();
      }
      await wait(50);
      const oversizedRestart = makeTailer();
      const oversizedAfterRestart = [];
      oversizedRestart.onEvent = (_id, event) => {
        oversizedAfterRestart.push(event.seq);
        return true;
      };
      oversizedRestart.watch(oversizedId);
      try {
        await waitFor(() => oversizedRestart.isPaused(oversizedId) && existsSync(join(eventsDir, `.quarantine-${oversizedId}`)), "oversized quarantine did not survive restart");
        assert.deepEqual(oversizedAfterRestart, []);
      } finally {
        oversizedRestart.stop();
      }
    
      // Growth after the candidate's initial stat must be incorporated within
      // the same bounded peek. The virtual fs hook appends the second half when
      // the legacy anchor is opened, exercising the stat/open/read race.
      const largeGrowthId = "term-large-growth";
      const largeGrowthActive = join(eventsDir, `${largeGrowthId}.jsonl`);
      const largeGrowthSegment = join(eventsDir, `.${largeGrowthId}.jsonl.segment`);
      const largeGrowthRecord = largeRecord(largeGrowthId, 1, 2 * 1024 * 1024, "agent_start");
      const largeGrowthSplit = Math.floor(largeGrowthRecord.length / 2);
      await writeFile(largeGrowthActive, record(largeGrowthId, 2, "agent_settled"));
      await writeFile(largeGrowthSegment, largeGrowthRecord.slice(0, largeGrowthSplit));
      await writeFile(largeGrowthRemainder, largeGrowthRecord.slice(largeGrowthSplit));
      const largeGrowthTailer = makeTailer();
      const largeGrowthReceived = [];
      largeGrowthTailer.onEvent = (_id, event) => {
        largeGrowthReceived.push(event.seq);
        return true;
      };
      largeGrowthTailer.watch(largeGrowthId);
      try {
        await waitFor(() => existsSync(largeGrowthSignal), "large candidate growth hook did not run");
        await waitFor(() => largeGrowthReceived.length === 2, "concurrently grown legacy record did not precede active seq2");
        assert.deepEqual(largeGrowthReceived, [1, 2]);
      } finally {
        largeGrowthTailer.stop();
      }
      await wait(50);
      const largeGrowthRestart = makeTailer();
      const largeGrowthAfterRestart = [];
      largeGrowthRestart.onEvent = (_id, event) => {
        largeGrowthAfterRestart.push(event.seq);
        return true;
      };
      largeGrowthRestart.watch(largeGrowthId);
      try {
        await appendFile(largeGrowthActive, record(largeGrowthId, 3, "agent_settled"));
        await waitFor(() => largeGrowthAfterRestart.length === 1, "large-growth restart did not deliver seq3");
        assert.deepEqual(largeGrowthAfterRestart, [3], "large-growth restart replayed or skipped events");
      } finally {
        largeGrowthRestart.stop();
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
          await waitFor(() => boundedRestart.isPaused(boundedId) && existsSync(join(eventsDir, `.quarantine-${boundedId}`)), "compatibility quarantine did not survive restart");
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
