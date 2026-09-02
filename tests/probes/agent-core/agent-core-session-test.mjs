/**
 * Focused harness for segmented agent-core session bundles.
 * Imported by scripts/agent-core-harness-test.mjs.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runExportedChecks } from "./test-support.mjs";

const session = await import("../../../agent-core/session.ts");
const host = await import("../../../agent-core/host.ts");
const {
  MAX_RETAINED_TEMP_BUNDLES,
  MAX_RETAINED_TEMP_BYTES,
  MAX_SESSION_BUNDLE_BYTES,
  MAX_SESSION_RECORD_BYTES,
  MAX_SESSION_SEGMENT_BYTES,
  SessionWriter,
  clearSessionBundle,
  coreSessionFile,
  isCoreSessionBundleFile,
  listCurrentSegments,
  listLogicalSessions,
  prepareFreshSession,
  quarantineSessionBundle,
  removeEmptySessionBundle,
  replaySessionBundle,
  replaySessionRecords,
  resolveSessionFile,
  sessionBlockBytes,
  sessionBlockHash,
  sessionBundleExists,
  sessionBundleHasContent,
  sessionRotateStamp,
  validateSessionReclaimReceipt,
  writeForkedSession,
} = session;

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function bundlePaths(root, id) {
  const sessionFile = coreSessionFile(root, id);
  return { sessionFile, currentDir: dirname(sessionFile), bundleDir: join(root, id) };
}

function openWriter(sessionFile, lastStorageSeq = 0) {
  const opened = SessionWriter.open(sessionFile, lastStorageSeq);
  if (!opened.ok) throw new Error(opened.error);
  return opened.writer;
}

function appendMsg(writer, sseq, role, content) {
  return writer.appendRecord({ storageSeq: sseq, type: "message", message: { role, content } });
}

function fillRecord(sseq, bytes) {
  const pad = "x".repeat(Math.max(1, bytes));
  return { storageSeq: sseq, type: "message", message: { role: "user", content: pad } };
}

function rollCleanupProbe(root, id, mutate) {
  const paths = bundlePaths(root, id);
  mkdirSync(paths.currentDir, { recursive: true, mode: 0o700 });
  let writer;
  const opened = SessionWriter.open(paths.sessionFile, 0, {
    testHooks: {
      beforeSegmentRollRename(partPath) {
        mutate({ paths, partPath });
      },
    },
  });
  if (!opened.ok) throw new Error(opened.error);
  writer = opened.writer;
  let seq = 0;
  while (writer.activeSize < MAX_SESSION_SEGMENT_BYTES - 64 * 1024) {
    seq += 1;
    const appended = writer.appendRecord(fillRecord(seq, 48 * 1024));
    if (!appended.ok) throw new Error(appended.error);
  }
  seq += 1;
  const failed = writer.appendRecord(fillRecord(seq, 80 * 1024));
  writer.close();
  return { paths, failed };
}

function childDirWithIdentity(parent, identity) {
  if (!identity || !existsSync(parent)) return null;
  for (const name of readdirSync(parent)) {
    const path = join(parent, name);
    try {
      const info = lstatSync(path);
      if (info.isDirectory() && info.dev === identity.dev && info.ino === identity.ino) return path;
    } catch {
      /* the raced child may have been moved again */
    }
  }
  return null;
}

function canonicalStubReceipt(revisionId, sseq, block) {
  const bytes = sessionBlockBytes(block);
  const sha256 = sessionBlockHash(block);
  if (bytes === null || sha256 === null) throw new Error("could not hash test block");
  const chars = typeof block.chars === "number" ? block.chars : String(block.content ?? "").length;
  const tool = typeof block.tool === "string" ? block.tool : block.type;
  const repro = typeof block.repro === "string" ? block.repro : null;
  const checked = validateSessionReclaimReceipt({
    revisionId,
    targets: [{
      sseq,
      blockIndex: 0,
      action: "stub",
      original: { type: block.type, chars, bytes, sha256 },
      reclaimedTokens: 1,
      revisionId,
      recovery: { source: "session-record", tool, repro },
    }],
  });
  if (!checked.ok) throw new Error(checked.error);
  return checked.receipt;
}

function spawnCore(env, args = [], stdinLines = [], opts = {}) {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agent-core", "main.ts");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", src, ...args], {
      env: { ...process.env, TERMINA_CORE_TEST: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    const ackTimer = opts.autoAck
      ? setInterval(() => {
          try {
            const sidecar = readFileSync(join(env.TERMINA_EVENTS_DIR, `${env.TERMINA_TERMINAL_ID}.jsonl`), "utf8");
            const records = sidecar.trim().split("\n").map((line) => JSON.parse(line));
            const request = records.findLast((record) => record.t === "preflight_request");
            if (request?.requestId) {
              writeFileSync(
                host.ackPath(env.TERMINA_EVENTS_DIR, env.TERMINA_TERMINAL_ID, request.requestId),
                JSON.stringify({ ok: true, ...(opts.ackPayload ?? {}) }),
              );
            }
          } catch {
            /* Wait until the preflight request is visible. */
          }
        }, 10)
      : null;
    if (stdinLines.length) child.stdin.write(stdinLines.join("\n") + "\n");
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ out, err, code: -1 });
    }, 12_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (ackTimer) clearInterval(ackTimer);
      resolve({ out, err, code });
    });
  });
}

export async function run({ check, leftovers }) {
  const root = mkdtempSync(join(tmpdir(), "agent-core-session-"));
  leftovers.push(root);

  const firstSession = coreSessionFile(join(root, "first-project"), "first-session");
  const firstPrepared = prepareFreshSession(firstSession);
  check("fresh session creates a missing project session directory", firstPrepared.ok && existsSync(firstSession));

  const roll = bundlePaths(root, "roll-1");
  mkdirSync(roll.currentDir, { recursive: true, mode: 0o700 });
  const rollWriter = openWriter(roll.sessionFile);
  let seq = 0;
  let rolled = false;
  while (rollWriter.activeSize < MAX_SESSION_SEGMENT_BYTES - 64 * 1024) {
    seq += 1;
    const rec = fillRecord(seq, 48 * 1024);
    const got = rollWriter.appendRecord(rec);
    if (!got.ok) throw new Error(got.error);
  }
  const beforeRoll = listCurrentSegments(roll.currentDir);
  check("writer starts with no numbered parts", beforeRoll.ok && beforeRoll.parts.length === 0);
  seq += 1;
  const rollRec = fillRecord(seq, 80 * 1024);
  const encodedRoll = Buffer.byteLength(`${JSON.stringify(rollRec)}\n`);
  check("next record would cross the segment budget", rollWriter.activeSize + encodedRoll > MAX_SESSION_SEGMENT_BYTES);
  const rolledAppend = rollWriter.appendRecord(rollRec);
  rollWriter.close();
  const afterRoll = listCurrentSegments(roll.currentDir);
  rolled = afterRoll.ok && afterRoll.parts.length === 1 && afterRoll.active && afterRoll.active.size === encodedRoll;
  check("rollover happens before the segment budget", rolledAppend.ok && rolled);

  const rollCleanupLeafMarker = "roll-cleanup-leaf-competitor";
  const rollCleanupLeaf = rollCleanupProbe(root, "roll-cleanup-leaf", ({ paths, partPath }) => {
    renameSync(paths.sessionFile, `${paths.sessionFile}.original`);
    writeFileSync(partPath, rollCleanupLeafMarker, { mode: 0o600 });
  });
  check(
    "roll failure retains a leaf replacement instead of unlinking it",
    rollCleanupLeaf.failed.ok === false &&
      existsSync(join(rollCleanupLeaf.paths.currentDir, "part-000001.jsonl")) &&
      readFileSync(join(rollCleanupLeaf.paths.currentDir, "part-000001.jsonl"), "utf8") === rollCleanupLeafMarker,
  );

  let rollCleanupAbaReplacement;
  const rollCleanupAba = rollCleanupProbe(root, "roll-cleanup-aba", ({ paths, partPath }) => {
    renameSync(paths.sessionFile, `${paths.sessionFile}.original`);
    const original = `${partPath}.original`;
    rollCleanupAbaReplacement = `${partPath}.replacement`;
    renameSync(partPath, original);
    writeFileSync(partPath, "roll-cleanup-aba-competitor", { mode: 0o600 });
    renameSync(partPath, rollCleanupAbaReplacement);
    renameSync(original, partPath);
  });
  check(
    "roll failure retains the original claim across an ABA replacement",
    rollCleanupAba.failed.ok === false &&
      existsSync(join(rollCleanupAba.paths.currentDir, "part-000001.jsonl")) &&
      readFileSync(join(rollCleanupAba.paths.currentDir, "part-000001.jsonl"), "utf8") === "",
  );

  const rollCleanupAncestorMarker = "roll-cleanup-ancestor-competitor";
  const rollCleanupAncestor = rollCleanupProbe(root, "roll-cleanup-ancestor", ({ paths, partPath }) => {
    renameSync(paths.currentDir, `${paths.currentDir}.original`);
    mkdirSync(paths.currentDir, { recursive: false, mode: 0o700 });
    writeFileSync(partPath, rollCleanupAncestorMarker, { mode: 0o600 });
  });
  check(
    "roll failure retains a replacement after an ancestor swap",
    rollCleanupAncestor.failed.ok === false &&
      existsSync(join(rollCleanupAncestor.paths.currentDir, "part-000001.jsonl")) &&
      readFileSync(join(rollCleanupAncestor.paths.currentDir, "part-000001.jsonl"), "utf8") === rollCleanupAncestorMarker,
  );

  function recordWithEncodedSize(sseq, targetBytes) {
    const rec = { storageSeq: sseq, type: "message", message: { role: "user", content: "" } };
    const overhead = Buffer.byteLength(`${JSON.stringify(rec)}\n`);
    rec.message.content = "x".repeat(Math.max(1, targetBytes - overhead));
    let line = Buffer.from(`${JSON.stringify(rec)}\n`);
    while (line.length > targetBytes && rec.message.content.length > 0) {
      rec.message.content = rec.message.content.slice(0, -(line.length - targetBytes));
      line = Buffer.from(`${JSON.stringify(rec)}\n`);
    }
    while (line.length < targetBytes) {
      rec.message.content += "x";
      line = Buffer.from(`${JSON.stringify(rec)}\n`);
    }
    return rec;
  }

  check("core session bundle limit is the canonical 64 MiB budget", MAX_SESSION_BUNDLE_BYTES === 64 * 1024 * 1024);
  const testBundleLimit = 32 * 1024;
  const budgeted = bundlePaths(root, "bundle-budget");
  mkdirSync(budgeted.currentDir, { recursive: true, mode: 0o700 });
  const budgetPart = Buffer.from(`${JSON.stringify(recordWithEncodedSize(1, testBundleLimit / 2))}\n`);
  const budgetActive = Buffer.from(`${JSON.stringify(recordWithEncodedSize(2, testBundleLimit / 2))}\n`);
  writeFileSync(join(budgeted.currentDir, "part-000001.jsonl"), budgetPart, { mode: 0o600 });
  writeFileSync(budgeted.sessionFile, budgetActive, { mode: 0o600 });
  const budgetBoundary = await replaySessionBundle(budgeted.sessionFile, { testOnlyMaxBundleBytes: testBundleLimit });
  check("aggregate session bundle accepts its exact byte boundary", budgetBoundary.ok && budgetBoundary.maxSeq === 2);
  writeFileSync(budgeted.sessionFile, Buffer.concat([budgetActive, Buffer.from("\n")]));
  const budgetOver = await replaySessionBundle(budgeted.sessionFile, { testOnlyMaxBundleBytes: testBundleLimit });
  check(
    "aggregate multi-part session bundle rejects one byte over budget before decoding",
    budgetOver.ok === false && String(budgetOver.error).includes("MAX_SESSION_BUNDLE_BYTES"),
  );
  const budgetForkDest = bundlePaths(root, "bundle-budget-fork");
  const budgetFork = await writeForkedSession(
    budgeted.sessionFile,
    budgetForkDest.sessionFile,
    undefined,
    { testOnlyMaxBundleBytes: testBundleLimit },
  );
  check(
    "over-budget core fork rejects without installing its destination",
    budgetFork.ok === false && !existsSync(budgetForkDest.bundleDir),
  );
  const budgetEmptyDest = bundlePaths(root, "bundle-budget-empty-fork");
  const budgetEmptyFork = await writeForkedSession(
    budgeted.sessionFile,
    budgetEmptyDest.sessionFile,
    0,
    { testOnlyMaxBundleBytes: testBundleLimit },
  );
  check(
    "sequence-zero fork still rejects an over-budget source before destination installation",
    budgetEmptyFork.ok === false && !existsSync(budgetEmptyDest.bundleDir),
  );

  const growthRace = bundlePaths(root, "bundle-growth-race");
  mkdirSync(growthRace.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(growthRace.sessionFile, `${JSON.stringify(recordWithEncodedSize(1, 8 * 1024))}\n`, { mode: 0o600 });
  let grewOpenedPart = false;
  const growthDest = bundlePaths(root, "bundle-growth-race-dest");
  const growthFork = await writeForkedSession(growthRace.sessionFile, growthDest.sessionFile, 0, {
    testOnlyMaxBundleBytes: 16 * 1024,
    testHooks: {
      afterSegmentsOpened(paths) {
        if (grewOpenedPart) return;
        grewOpenedPart = true;
        appendFileSync(paths[0], "x".repeat(16 * 1024));
      },
    },
  });
  check(
    "retained descriptors reject part growth before sequence-zero decode or install",
    growthFork.ok === false && !existsSync(growthDest.bundleDir),
  );

  const truncationRace = bundlePaths(root, "bundle-truncation-race");
  mkdirSync(truncationRace.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    truncationRace.sessionFile,
    `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "stable" } })}\n`,
    { mode: 0o600 },
  );
  let postOpenTruncations = 0;
  const truncationDest = bundlePaths(root, "bundle-truncation-race-dest");
  const truncationFork = await writeForkedSession(truncationRace.sessionFile, truncationDest.sessionFile, 0, {
    testHooks: {
      afterSegmentsOpened(paths) {
        const info = lstatSync(paths[0]);
        if (info.size < 1) return;
        postOpenTruncations += 1;
        truncateSync(paths[0], info.size - 1);
      },
    },
  });
  check(
    "retained descriptors reject repeated post-open truncation before decoding or install",
    truncationFork.ok === false && postOpenTruncations === 3 && !existsSync(truncationDest.bundleDir),
  );

  const leafRace = bundlePaths(root, "bundle-leaf-race");
  mkdirSync(leafRace.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(leafRace.sessionFile, `${JSON.stringify({ storageSeq: 1, type: "checkpoint" })}\n`, { mode: 0o600 });
  const leafOutside = join(root, "leaf-race-outside.jsonl");
  writeFileSync(leafOutside, `${JSON.stringify({ storageSeq: 1, type: "checkpoint" })}\n`, { mode: 0o600 });
  let replacedLeaf = false;
  const leafRaceDest = bundlePaths(root, "bundle-leaf-race-dest");
  const leafRaceFork = await writeForkedSession(leafRace.sessionFile, leafRaceDest.sessionFile, 0, {
    testHooks: {
      beforeSegmentOpen(path) {
        if (replacedLeaf) return;
        replacedLeaf = true;
        renameSync(path, `${path}.saved`);
        symlinkSync(leafOutside, path);
      },
    },
  });
  check(
    "no-follow segment open rejects a leaf symlink replacement before install",
    leafRaceFork.ok === false && !existsSync(leafRaceDest.bundleDir),
  );

  const ancestorRace = bundlePaths(root, "bundle-ancestor-race");
  mkdirSync(ancestorRace.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(ancestorRace.sessionFile, `${JSON.stringify({ storageSeq: 1, type: "checkpoint" })}\n`, { mode: 0o600 });
  const outsideCurrent = join(root, "ancestor-race-outside");
  mkdirSync(outsideCurrent, { recursive: true, mode: 0o700 });
  writeFileSync(join(outsideCurrent, "session.jsonl"), `${JSON.stringify({ storageSeq: 1, type: "checkpoint" })}\n`, { mode: 0o600 });
  let replacedAncestor = false;
  const ancestorDest = bundlePaths(root, "bundle-ancestor-race-dest");
  const ancestorFork = await writeForkedSession(ancestorRace.sessionFile, ancestorDest.sessionFile, 0, {
    testHooks: {
      beforeSegmentOpen() {
        if (replacedAncestor) return;
        replacedAncestor = true;
        renameSync(ancestorRace.currentDir, `${ancestorRace.currentDir}.saved`);
        symlinkSync(outsideCurrent, ancestorRace.currentDir, "dir");
      },
    },
  });
  check(
    "anchored source directories reject ancestor symlink replacement before install",
    ancestorFork.ok === false && !existsSync(ancestorDest.bundleDir),
  );

  const bound = bundlePaths(root, "bound-1");
  mkdirSync(bound.currentDir, { recursive: true, mode: 0o700 });
  const boundWriter = openWriter(bound.sessionFile);
  const fillChunk = 700 * 1024;
  let boundSeq = 0;
  for (;;) {
    const next = fillRecord(boundSeq + 1, fillChunk);
    const nextLine = Buffer.byteLength(`${JSON.stringify(next)}\n`);
    if (boundWriter.activeSize + nextLine > MAX_SESSION_SEGMENT_BYTES) break;
    const got = boundWriter.appendRecord(next);
    if (!got.ok) throw new Error(got.error);
    boundSeq += 1;
  }
  const remaining = MAX_SESSION_SEGMENT_BYTES - boundWriter.activeSize;
  check("exact-boundary remainder is a legal record", remaining > 64 && remaining <= MAX_SESSION_RECORD_BYTES);
  boundSeq += 1;
  const exactRec = recordWithEncodedSize(boundSeq, remaining);
  const exactLine = Buffer.from(`${JSON.stringify(exactRec)}\n`);
  check("exact-boundary record matches the remainder", exactLine.length === remaining);
  const exactGot = boundWriter.appendRecord(exactRec);
  const boundListing = listCurrentSegments(bound.currentDir);
  check(
    "exact-boundary append stays on the active segment",
    exactGot.ok &&
      boundListing.ok &&
      boundListing.parts.length === 0 &&
      boundListing.active.size === MAX_SESSION_SEGMENT_BYTES,
  );
  const oversized = fillRecord(boundSeq + 1, MAX_SESSION_RECORD_BYTES);
  const overGot = boundWriter.appendRecord(oversized);
  boundWriter.close();
  check("oversized encoded record is rejected", overGot.ok === false && String(overGot.error).includes("MAX_SESSION_RECORD_BYTES"));
  const afterOver = await replaySessionBundle(bound.sessionFile);
  check("oversized rejection does not persist a record", afterOver.ok && afterOver.maxSeq === boundSeq);

  const gap = bundlePaths(root, "gap-1");
  mkdirSync(gap.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(gap.currentDir, "part-000001.jsonl"),
    [
      JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "g1" } }),
      JSON.stringify({ storageSeq: 4, type: "message", message: { role: "assistant", content: "g2" } }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    gap.sessionFile,
    [
      JSON.stringify({ storageSeq: 10, type: "message", message: { role: "user", content: "gap-ok" } }),
      JSON.stringify({ storageSeq: 15, type: "checkpoint" }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const gapReplay = await replaySessionBundle(gap.sessionFile);
  check(
    "replay accepts sequence gaps across segments",
    gapReplay.ok && gapReplay.maxSeq === 15 && gapReplay.messages.some((m) => m.content === "gap-ok"),
  );

  const writerOrder = bundlePaths(root, "writer-order");
  const writerOrderHandle = openWriter(writerOrder.sessionFile);
  const writerFirst = writerOrderHandle.appendRecord({ storageSeq: 2, type: "checkpoint" });
  const writerDuplicate = writerOrderHandle.appendRecord({ storageSeq: 2, type: "checkpoint" });
  const writerDecrease = writerOrderHandle.appendRecord({ storageSeq: 1, type: "checkpoint" });
  writerOrderHandle.close();
  check(
    "writer rejects duplicate and decreasing sequence addresses",
    writerFirst.ok && writerDuplicate.ok === false && writerDecrease.ok === false,
  );
  const checkpointWithMessage = replaySessionRecords(
    JSON.stringify({ storageSeq: 1, type: "checkpoint", message: { role: "user", content: "hidden" } }),
  );
  check("checkpoint records cannot hide a message", checkpointWithMessage.ok === false);

  const dec = bundlePaths(root, "dec-1");
  mkdirSync(dec.currentDir, { recursive: true, mode: 0o700 });
  const decWriter = openWriter(dec.sessionFile);
  decWriter.appendRecord({ storageSeq: 1, type: "message", message: { role: "user", content: "a" } });
  while (decWriter.activeSize < MAX_SESSION_SEGMENT_BYTES - 4096) {
    decWriter.appendRecord(fillRecord(2, 32 * 1024));
    break;
  }
  decWriter.close();
  writeFileSync(
    join(dec.currentDir, "part-000001.jsonl"),
    `${JSON.stringify({ storageSeq: 5, type: "message", message: { role: "user", content: "late" } })}\n`,
  );
  writeFileSync(
    dec.sessionFile,
    `${JSON.stringify({ storageSeq: 3, type: "message", message: { role: "user", content: "earlier" } })}\n`,
  );
  const decReplay = await replaySessionBundle(dec.sessionFile);
  check("decreasing sequence across segments is rejected", decReplay.ok === false && String(decReplay.error).includes("decreasing"));

  const dup = bundlePaths(root, "dup-1");
  mkdirSync(dup.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dup.currentDir, "part-000001.jsonl"),
    `${JSON.stringify({ storageSeq: 4, type: "message", message: { role: "user", content: "p" } })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    dup.sessionFile,
    `${JSON.stringify({ storageSeq: 4, type: "message", message: { role: "user", content: "d" } })}\n`,
    { mode: 0o600 },
  );
  const dupReplay = await replaySessionBundle(dup.sessionFile);
  check("duplicate sequence across segments is rejected", dupReplay.ok === false && String(dupReplay.error).includes("duplicate"));

  const truncActive = bundlePaths(root, "trunc-a");
  mkdirSync(truncActive.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    truncActive.sessionFile,
    `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "keep" } })}\n{not-json`,
    { mode: 0o600 },
  );
  const truncActiveReplay = await replaySessionBundle(truncActive.sessionFile);
  check("truncated active tail is ignored", truncActiveReplay.ok && truncActiveReplay.messages[0]?.content === "keep");
  const truncActiveOpen = SessionWriter.open(truncActive.sessionFile, 1);
  const truncActiveAppend = truncActiveOpen.ok
    ? truncActiveOpen.writer.appendRecord({ storageSeq: 2, type: "message", message: { role: "assistant", content: "after" } })
    : truncActiveOpen;
  if (truncActiveOpen.ok) truncActiveOpen.writer.close();
  const truncActiveAfter = await replaySessionBundle(truncActive.sessionFile);
  check(
    "writer removes a truncated active tail before appending",
    truncActiveAppend.ok && truncActiveAfter.ok && truncActiveAfter.maxSeq === 2 && truncActiveAfter.messages[1]?.content === "after",
  );

  const validTruncActive = bundlePaths(root, "trunc-valid-a");
  mkdirSync(validTruncActive.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    validTruncActive.sessionFile,
    JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "not durable" } }),
    { mode: 0o600 },
  );
  const validTruncActiveReplay = await replaySessionBundle(validTruncActive.sessionFile);
  check(
    "active record without a newline is ignored even when its JSON is complete",
    validTruncActiveReplay.ok && validTruncActiveReplay.messages.length === 0 && validTruncActiveReplay.maxSeq === 0,
  );

  const truncPart = bundlePaths(root, "trunc-p");
  mkdirSync(truncPart.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(truncPart.currentDir, "part-000001.jsonl"),
    `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "p" } })}\n{not-json`,
    { mode: 0o600 },
  );
  writeFileSync(truncPart.sessionFile, "", { mode: 0o600 });
  const truncPartReplay = await replaySessionBundle(truncPart.sessionFile);
  check("truncated immutable part is rejected", truncPartReplay.ok === false && String(truncPartReplay.error).includes("truncated"));

  const validTruncPart = bundlePaths(root, "trunc-valid-p");
  mkdirSync(validTruncPart.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(validTruncPart.currentDir, "part-000001.jsonl"),
    JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "not durable" } }),
    { mode: 0o600 },
  );
  writeFileSync(validTruncPart.sessionFile, "", { mode: 0o600 });
  const validTruncPartReplay = await replaySessionBundle(validTruncPart.sessionFile);
  check(
    "immutable record without a newline is rejected even when its JSON is complete",
    validTruncPartReplay.ok === false && String(validTruncPartReplay.error).includes("truncated"),
  );

  const crash1 = bundlePaths(root, "crash-1");
  mkdirSync(crash1.currentDir, { recursive: true, mode: 0o700 });
  const c1w = openWriter(crash1.sessionFile);
  c1w.appendRecord({ storageSeq: 1, type: "message", message: { role: "user", content: "before-roll" } });
  c1w.close();
  writeFileSync(join(crash1.currentDir, "part-000001.jsonl"), readFileSync(crash1.sessionFile));
  writeFileSync(crash1.sessionFile, "");
  const crash1Replay = await replaySessionBundle(crash1.sessionFile);
  const crash1Open = SessionWriter.open(crash1.sessionFile, 1);
  check(
    "crash after rename recovers an empty active segment",
    crash1Replay.ok && crash1Replay.messages[0]?.content === "before-roll" && crash1Open.ok && crash1Open.writer.activeSize === 0,
  );
  crash1Open.writer?.close();

  const crash2 = bundlePaths(root, "crash-2");
  mkdirSync(crash2.currentDir, { recursive: true, mode: 0o700 });
  const c2w = openWriter(crash2.sessionFile);
  c2w.appendRecord({ storageSeq: 1, type: "message", message: { role: "user", content: "old" } });
  c2w.close();
  writeFileSync(join(crash2.currentDir, "part-000001.jsonl"), readFileSync(crash2.sessionFile));
  writeFileSync(crash2.sessionFile, "", { mode: 0o600 });
  const c2w2 = openWriter(crash2.sessionFile, 1);
  check("crash after new active before append leaves an empty valid segment", c2w2.activeSize === 0);
  const more = c2w2.appendRecord({ storageSeq: 2, type: "message", message: { role: "user", content: "next" } });
  c2w2.close();
  const crash2Replay = await replaySessionBundle(crash2.sessionFile);
  check("append after rollover crash window continues the sequence", more.ok && crash2Replay.ok && crash2Replay.maxSeq === 2);

  const rev = bundlePaths(root, "rev-1");
  mkdirSync(rev.currentDir, { recursive: true, mode: 0o700 });
  const revBlock = { type: "tool_result", tool_use_id: "t", content: "BODY", tool: "bash", repro: "bash x" };
  const revReceipt = canonicalStubReceipt("rev-1", 1, revBlock);
  writeFileSync(
    join(rev.currentDir, "part-000001.jsonl"),
    [
      JSON.stringify({
        storageSeq: 1,
        type: "message",
        message: { role: "user", content: [revBlock] },
      }),
      JSON.stringify({ storageSeq: 2, type: "message", message: { role: "user", content: "old" } }),
      JSON.stringify({ storageSeq: 3, type: "message", message: { role: "user", content: "tail" } }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    rev.sessionFile,
    [
      JSON.stringify({ storageSeq: 6, type: "revision", kind: "prune", ...revReceipt }),
      JSON.stringify({ storageSeq: 7, type: "revision", kind: "summarize", evicted: 2, summarySseq: 7, message: { role: "user", content: "<context-handoff>\nkeep\n</context-handoff>" } }),
      JSON.stringify({ storageSeq: 8, type: "revision", kind: "truncate", dropped: 1 }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const revReplay = await replaySessionBundle(rev.sessionFile);
  check(
    "revisions targeting earlier segments apply",
    revReplay.ok &&
      revReplay.messages.length === 1 &&
      revReplay.messages[0]?.content === "tail" &&
      String(revReplay.messages[0]?.content ?? "").includes("BODY") === false,
  );
  const recoveryRace = bundlePaths(root, "recovery-race");
  mkdirSync(recoveryRace.currentDir, { recursive: true, mode: 0o700 });
  const recoveryRaceBlock = { type: "tool_result", tool_use_id: "rr", content: "RESTORE", tool: "bash", repro: "bash rr" };
  const recoveryRaceReceipt = canonicalStubReceipt("recovery-race", 1, recoveryRaceBlock);
  writeFileSync(
    recoveryRace.sessionFile,
    [
      JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: [recoveryRaceBlock] } }),
      JSON.stringify({ storageSeq: 2, type: "revision", kind: "prune", ...recoveryRaceReceipt }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  let recoveryOpenCount = 0;
  const recoveryRaceDest = bundlePaths(root, "recovery-race-dest");
  const recoveryRaceFork = await writeForkedSession(recoveryRace.sessionFile, recoveryRaceDest.sessionFile, 2, {
    testHooks: {
      afterSegmentsOpened(paths) {
        recoveryOpenCount += 1;
        if (recoveryOpenCount === 2) appendFileSync(paths[0], "\n");
      },
    },
  });
  check(
    "recovery scan retains and revalidates source descriptors before materialization",
    recoveryRaceFork.ok === false && recoveryOpenCount >= 2 && !existsSync(recoveryRaceDest.bundleDir),
  );
  const pruneBlock = { type: "tool_result", tool_use_id: "t", content: "BODY", tool: "bash", repro: "bash x" };
  const pruneReceipt = canonicalStubReceipt("rev-memory", 1, pruneBlock);
  const pruneReplay = replaySessionRecords(
    [
      JSON.stringify({
        storageSeq: 1,
        type: "message",
        message: { role: "user", content: [pruneBlock] },
      }),
      JSON.stringify({ storageSeq: 2, type: "revision", kind: "prune", ...pruneReceipt }),
    ].join("\n"),
  );
  check("prune revision stubs a tool result", pruneReplay.ok && String(pruneReplay.messages[0]?.content[0]?.content ?? "").includes("storageSeq 1"));
  const badPruneBlock = { type: "tool_result", content: "BODY" };
  const badPruneReceipt = canonicalStubReceipt("rev-bad", 1, badPruneBlock);
  badPruneReceipt.targets[0].action = "unknown";
  const badPruneReplay = replaySessionRecords(
    [
      JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: [badPruneBlock] } }),
      JSON.stringify({ storageSeq: 2, type: "revision", kind: "prune", ...badPruneReceipt }),
    ].join("\n"),
  );
  check("unknown prune actions fail before replay mutation", badPruneReplay.ok === false);

  const evict = bundlePaths(root, "evict-1");
  mkdirSync(evict.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    evict.sessionFile,
    [
      JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "drop-me" } }),
      JSON.stringify({ storageSeq: 2, type: "message", message: { role: "user", content: "keep-me" } }),
      JSON.stringify({ storageSeq: 3, type: "revision", kind: "truncate", dropped: 1 }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const evicted = await replaySessionBundle(evict.sessionFile);
  check(
    "bounded replay index drops evicted messages",
    evicted.ok && evicted.state.bySeq.has(1) === false && evicted.state.bySeq.has(2) === true && evicted.messages.length === 1,
  );

  const fail = bundlePaths(root, "fail-1");
  mkdirSync(fail.currentDir, { recursive: true, mode: 0o700 });
  const failW = openWriter(fail.sessionFile);
  failW.appendRecord({ storageSeq: 1, type: "message", message: { role: "user", content: "ok" } });
  failW.close();
  chmodSync(fail.sessionFile, 0o444);
  const failW2 = SessionWriter.open(fail.sessionFile, 1);
  let failAppend = { ok: false, error: "writer did not open" };
  if (failW2.ok) {
    failAppend = failW2.writer.appendRecord({ storageSeq: 2, type: "message", message: { role: "user", content: "nope" } });
    failW2.writer.close();
  }
  chmodSync(fail.sessionFile, 0o600);
  const failReplay = await replaySessionBundle(fail.sessionFile);
  check("storage failure does not persist a later record", failAppend.ok === false && failReplay.ok && failReplay.maxSeq === 1);

  const events = mkdtempSync(join(tmpdir(), "agent-core-events-"));
  leftovers.push(events);
  const storeId = "store-1";
  const storeFile = coreSessionFile(events, storeId);
  mkdirSync(dirname(storeFile), { recursive: true, mode: 0o700 });
  writeFileSync(storeFile, "", { mode: 0o600 });
  chmodSync(storeFile, 0o444);
  const stored = await spawnCore(
    {
      TERMINA_EVENTS_DIR: events,
      TERMINA_TERMINAL_ID: "term-1",
      TERMINA_CORE_SESSION_ID: storeId,
    },
    ["-p", "hello from test"],
  );
  let sidecar = "";
  try {
    sidecar = readFileSync(join(events, "term-1.jsonl"), "utf8");
  } catch {
    sidecar = "";
  }
  chmodSync(storeFile, 0o600);
  check(
    "storage failure does not publish agent_start",
    !sidecar.includes('"t":"agent_start"') && stored.out.includes("did not start"),
  );

  const pendingEvents = mkdtempSync(join(tmpdir(), "agent-core-pending-store-"));
  leftovers.push(pendingEvents);
  const pendingId = "pending-store-1";
  const terminalId = "term-1";
  const pendingBatch = await host.appendPendingImages(pendingEvents, terminalId, [
    { bytes: png1x1, mediaType: "image/png", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  ]);
  const oversizedPrompt = "x".repeat(MAX_SESSION_RECORD_BYTES);
  const pendingRun = await spawnCore(
    {
      TERMINA_EVENTS_DIR: pendingEvents,
      TERMINA_TERMINAL_ID: terminalId,
      TERMINA_CORE_SESSION_ID: pendingId,
    },
    [],
    [oversizedPrompt],
    { autoAck: true },
  );
  const pendingAfterFailure = await host.pendingImageState(pendingEvents, terminalId);
  check(
    "storage failure keeps pending images until the message is durable",
    pendingBatch.ok &&
      pendingRun.out.includes("did not start") &&
      pendingAfterFailure.ok &&
      pendingAfterFailure.count === 1,
  );
  const pendingSidecar = readFileSync(join(pendingEvents, `${terminalId}.jsonl`), "utf8");
  const cancelledRun = await spawnCore(
    {
      TERMINA_EVENTS_DIR: pendingEvents,
      TERMINA_TERMINAL_ID: "term-cancel",
      TERMINA_CORE_SESSION_ID: "cancel-store-1",
    },
    [],
    [oversizedPrompt],
    { autoAck: true, ackPayload: { token: "lease-token" } },
  );
  const cancelledSidecar = readFileSync(join(pendingEvents, "term-cancel.jsonl"), "utf8");
  check(
    "pre-start storage failure cancels its preflight lease",
    cancelledRun.out.includes("did not start") && cancelledSidecar.includes('"t":"preflight_cancel"') && cancelledSidecar.includes('"token":"lease-token"'),
    pendingSidecar.slice(-120),
  );

  const resumeDir = mkdtempSync(join(tmpdir(), "agent-core-resume-"));
  leftovers.push(resumeDir);
  const resumeId = "resume-1";
  const resumeFile = coreSessionFile(resumeDir, resumeId);
  mkdirSync(dirname(resumeFile), { recursive: true, mode: 0o700 });
  writeFileSync(
    resumeFile,
    `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "resumed-marker" } })}\n`,
    { mode: 0o600 },
  );
  const startupResume = await spawnCore(
    {
      TERMINA_EVENTS_DIR: resumeDir,
      TERMINA_TERMINAL_ID: "term-1",
      TERMINA_CORE_SESSION_ID: resumeId,
      TERMINA_CORE_RESUME: "1",
    },
    [],
    ["hello-during-resume"],
  );
  check(
    "startup resume replays before a queued prompt",
    startupResume.out.includes("resumed-marker") || startupResume.out.includes("stored session"),
  );
  const invalidResumeId = "invalid-resume";
  const invalidResumeFile = coreSessionFile(resumeDir, invalidResumeId);
  mkdirSync(dirname(invalidResumeFile), { recursive: true, mode: 0o700 });
  writeFileSync(invalidResumeFile, `${JSON.stringify({ storageSeq: 1, type: "unknown" })}\n`, { mode: 0o600 });
  await spawnCore(
    {
      TERMINA_EVENTS_DIR: resumeDir,
      TERMINA_TERMINAL_ID: "term-invalid",
      TERMINA_CORE_SESSION_ID: invalidResumeId,
      TERMINA_CORE_RESUME: "1",
    },
  );
  const invalidReady = readFileSync(join(resumeDir, "term-invalid.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .findLast((event) => event.t === "session_ready");
  check("invalid startup bundle reports session_ready failure", invalidReady?.ok === false && typeof invalidReady?.error === "string");
  const explicitResume = await spawnCore(
    {
      TERMINA_EVENTS_DIR: resumeDir,
      TERMINA_TERMINAL_ID: "term-1",
      TERMINA_CORE_SESSION_ID: resumeId,
    },
    [],
    ["/resume", "hello-during-resume"],
  );
  check(
    "explicit resume excludes a racing prompt",
    explicitResume.out.includes("engine busy") || explicitResume.out.includes("resumed-marker") || explicitResume.out.includes("stored session"),
  );

  const forkSrc = bundlePaths(root, "fork-src");
  mkdirSync(forkSrc.currentDir, { recursive: true, mode: 0o700 });
  const forkW = openWriter(forkSrc.sessionFile);
  forkW.appendRecord({ storageSeq: 1, type: "message", message: { role: "user", content: "s1" } });
  while (forkW.activeSize < MAX_SESSION_SEGMENT_BYTES - 4096) {
    forkW.appendRecord(fillRecord(2, 32 * 1024));
    break;
  }
  forkW.appendRecord({ storageSeq: 10, type: "message", message: { role: "assistant", content: "s2" } });
  forkW.appendRecord({ storageSeq: 11, type: "message", message: { role: "user", content: "s3" } });
  forkW.close();
  if (listCurrentSegments(forkSrc.currentDir).ok && listCurrentSegments(forkSrc.currentDir).parts.length === 0) {
    writeFileSync(join(forkSrc.currentDir, "part-000001.jsonl"), readFileSync(forkSrc.sessionFile));
    writeFileSync(
      forkSrc.sessionFile,
      `${JSON.stringify({ storageSeq: 12, type: "message", message: { role: "user", content: "s4" } })}\n`,
    );
  }
  const srcReplay = await replaySessionBundle(forkSrc.sessionFile);
  const forkZero = bundlePaths(root, "fork-zero");
  const zeroGot = await writeForkedSession(forkSrc.sessionFile, forkZero.sessionFile, 0);
  check("fork at sequence 0 writes an empty current", zeroGot.ok && zeroGot.kept === 0 && existsSync(forkZero.sessionFile) && readFileSync(forkZero.sessionFile, "utf8") === "");
  const forkMid = bundlePaths(root, "fork-mid");
  const midGot = await writeForkedSession(forkSrc.sessionFile, forkMid.sessionFile, 1);
  const midReplay = await replaySessionBundle(forkMid.sessionFile);
  check("fork in the first segment keeps that prefix", midGot.ok && midReplay.ok && midReplay.messages[0]?.content === "s1" && midReplay.maxSeq >= 1);
  const gapDest = bundlePaths(root, "fork-gap");
  const gapGot = await writeForkedSession(forkSrc.sessionFile, gapDest.sessionFile, 5);
  const gapForkReplay = await replaySessionBundle(gapDest.sessionFile);
  check(
    "fork accepts an address inside a valid sequence gap",
    gapGot.ok && gapForkReplay.ok && gapForkReplay.messages.every((message) => message.content !== "s2") && gapForkReplay.maxSeq === 5,
  );
  const forkActive = bundlePaths(root, "fork-active");
  const activeGot = await writeForkedSession(forkSrc.sessionFile, forkActive.sessionFile, srcReplay.maxSeq);
  const activeReplay = await replaySessionBundle(forkActive.sessionFile);
  check("fork in the active segment keeps visible messages", activeGot.ok && activeReplay.ok && activeReplay.messages.length === srcReplay.messages.length);
  const forkLatest = bundlePaths(root, "fork-latest");
  const latestGot = await writeForkedSession(forkSrc.sessionFile, forkLatest.sessionFile);
  const latestReplay = await replaySessionBundle(forkLatest.sessionFile);
  check(
    "fork without a sequence materializes the latest durable state",
    latestGot.ok && latestReplay.ok && latestReplay.messages.length === srcReplay.messages.length && latestReplay.maxSeq === srcReplay.maxSeq,
  );
  const beyond = await writeForkedSession(forkSrc.sessionFile, coreSessionFile(root, "fork-beyond"), srcReplay.maxSeq + 5);
  check("fork beyond the source maximum fails closed", beyond.ok === false);
  const redirectedRoot = join(root, "redirected-root");
  mkdirSync(redirectedRoot, { recursive: true });
  const redirected = bundlePaths(redirectedRoot, "redirected");
  const redirectedWriter = openWriter(redirected.sessionFile);
  appendMsg(redirectedWriter, 1, "user", "outside");
  redirectedWriter.close();
  const symlinkProject = join(root, "symlink-project");
  symlinkSync(redirectedRoot, symlinkProject, "dir");
  const symlinkFork = await writeForkedSession(coreSessionFile(symlinkProject, "redirected"), coreSessionFile(root, "symlink-fork"));
  check("fork rejects a symlinked session project directory", symlinkFork.ok === false && String(symlinkFork.error).includes("symlink"));
  const symlinkBundleRoot = join(root, "symlink-bundle-root");
  mkdirSync(symlinkBundleRoot, { recursive: true });
  symlinkSync(redirected.bundleDir, join(symlinkBundleRoot, "redirected"), "dir");
  const symlinkBundleFork = await writeForkedSession(coreSessionFile(symlinkBundleRoot, "redirected"), coreSessionFile(root, "symlink-bundle-fork"));
  check("fork rejects a symlinked session bundle", symlinkBundleFork.ok === false && String(symlinkBundleFork.error).includes("symlink"));

  const sumSrc = bundlePaths(root, "sum-src");
  mkdirSync(sumSrc.currentDir, { recursive: true, mode: 0o700 });
  const handoff = "<context-handoff>\nkeep\n</context-handoff>";
  writeFileSync(
    sumSrc.sessionFile,
    [
      JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "old1" } }),
      JSON.stringify({ storageSeq: 2, type: "message", message: { role: "user", content: "old2" } }),
      JSON.stringify({ storageSeq: 3, type: "message", message: { role: "user", content: "tail" } }),
      JSON.stringify({ storageSeq: 4, type: "revision", kind: "summarize", evicted: 2, summarySseq: 4, message: { role: "user", content: handoff } }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const sumReplay = await replaySessionBundle(sumSrc.sessionFile);
  const sumDst = bundlePaths(root, "sum-dst");
  const sumFork = await writeForkedSession(sumSrc.sessionFile, sumDst.sessionFile, 4);
  const sumForkReplay = await replaySessionBundle(sumDst.sessionFile);
  check(
    "materialized fork matches summarized context",
    sumReplay.ok &&
      sumFork.ok &&
      sumForkReplay.ok &&
      sumForkReplay.messages.length === sumReplay.messages.length &&
      sumForkReplay.messages[0]?.content === handoff &&
      sumForkReplay.messages[1]?.content === "tail" &&
      sumForkReplay.messages[0]?.sseq === 1 &&
      sumForkReplay.messages[1]?.sseq === 2,
  );
  check("dense renumbering writes 1..N after summary", sumForkReplay.maxSeq >= 2 && sumForkReplay.messages[0]?.sseq === 1);

  const ckptDst = bundlePaths(root, "ckpt-dst");
  const ckptFork = await writeForkedSession(sumSrc.sessionFile, ckptDst.sessionFile, 4);
  const ckptReplay = await replaySessionBundle(ckptDst.sessionFile);
  check("checkpoint preserves the source sequence", ckptFork.ok && ckptReplay.ok && ckptReplay.maxSeq === 4);
  const ckptW = openWriter(ckptDst.sessionFile);
  const ckptNext = ckptW.appendRecord({ storageSeq: 6, type: "message", message: { role: "user", content: "after" } });
  ckptW.close();
  check("next append after a checkpoint uses the preserved sequence", ckptNext.ok && ckptNext.storageSeq === 6);

  const tempAttackOutside = join(root, "temp-attack-outside");
  mkdirSync(tempAttackOutside, { recursive: true, mode: 0o700 });
  writeFileSync(join(tempAttackOutside, "marker"), "safe");
  // A symlink replacement is retained as intentionally unreadable evidence;
  // keep its poisoned admission root separate from later probes.
  const tempAttackDest = bundlePaths(join(root, "temp-attack-root"), "temp-attack-dest");
  const tempAttack = await writeForkedSession(sumSrc.sessionFile, tempAttackDest.sessionFile, 4, {
    testHooks: {
      afterTempCreated(path) {
        rmSync(path, { recursive: true, force: true });
        symlinkSync(tempAttackOutside, path, "dir");
      },
    },
  });
  check(
    "exclusive random staging rejects a replaced temp directory without traversing its symlink",
    tempAttack.ok === false && !existsSync(tempAttackDest.bundleDir) && readFileSync(join(tempAttackOutside, "marker"), "utf8") === "safe",
  );

  const tempReplacementDest = bundlePaths(root, "temp-replacement-dest");
  let tempReplacementIdentity = null;
  const tempReplacement = await writeForkedSession(sumSrc.sessionFile, tempReplacementDest.sessionFile, 4, {
    testHooks: {
      afterTempCreated(path) {
        renameSync(path, `${path}.original`);
        mkdirSync(path, { recursive: false, mode: 0o700 });
        writeFileSync(join(path, "competitor.txt"), "competitor-temp-bytes", { mode: 0o600 });
        const info = lstatSync(path);
        tempReplacementIdentity = { dev: info.dev, ino: info.ino };
      },
    },
  });
  const survivingTempReplacement = childDirWithIdentity(dirname(tempReplacementDest.bundleDir), tempReplacementIdentity);
  check(
    "failed staging retains a replacement inserted before temp identity cleanup",
    tempReplacement.ok === false &&
      tempReplacementIdentity !== null &&
      survivingTempReplacement !== null &&
      existsSync(join(survivingTempReplacement, "competitor.txt")) &&
      readFileSync(join(survivingTempReplacement, "competitor.txt"), "utf8") === "competitor-temp-bytes",
  );

  const tempFinallyDest = bundlePaths(root, "temp-finally-replacement-dest");
  let tempFinallyReplacementIdentity = null;
  const tempFinallyReplacement = await writeForkedSession(sumSrc.sessionFile, tempFinallyDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationCurrentInstall() {
        throw new Error("injected failure before temporary disposal");
      },
      beforeTemporaryCleanupMutation(path) {
        renameSync(path, `${path}.original`);
        mkdirSync(path, { recursive: false, mode: 0o700 });
        writeFileSync(join(path, "competitor.txt"), "competitor-finally-bytes", { mode: 0o600 });
        const info = lstatSync(path);
        tempFinallyReplacementIdentity = { dev: info.dev, ino: info.ino };
      },
    },
  });
  const survivingTempFinallyReplacement = childDirWithIdentity(dirname(tempFinallyDest.bundleDir), tempFinallyReplacementIdentity);
  check(
    "finally cleanup retains a replacement inserted after temp descriptors close",
    tempFinallyReplacement.ok === false &&
      tempFinallyReplacement.commit === "uncertain" &&
      tempFinallyReplacementIdentity !== null &&
      survivingTempFinallyReplacement !== null &&
      existsSync(join(survivingTempFinallyReplacement, "competitor.txt")) &&
      readFileSync(join(survivingTempFinallyReplacement, "competitor.txt"), "utf8") === "competitor-finally-bytes",
  );

  const tempFinallyAbaProject = join(root, "temp-finally-aba-project");
  mkdirSync(tempFinallyAbaProject, { recursive: true, mode: 0o700 });
  const tempFinallyAbaDest = bundlePaths(tempFinallyAbaProject, "destination");
  let tempFinallyAbaIdentity = null;
  const tempFinallyAba = await writeForkedSession(sumSrc.sessionFile, tempFinallyAbaDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationCurrentInstall() {
        throw new Error("injected temporary ABA cleanup failure");
      },
      beforeTemporaryCleanupMutation(path) {
        const original = `${path}.aba-original`;
        const replacement = `${path}.aba-replacement`;
        renameSync(path, original);
        mkdirSync(path, { recursive: false, mode: 0o700 });
        writeFileSync(join(path, "competitor.txt"), "competitor-temp-aba", { mode: 0o600 });
        renameSync(path, replacement);
        renameSync(original, path);
        renameSync(path, `${path}.aba-original-late`);
        renameSync(replacement, path);
        const info = lstatSync(path);
        tempFinallyAbaIdentity = { dev: info.dev, ino: info.ino };
      },
    },
  });
  const survivingTempFinallyAba = childDirWithIdentity(dirname(tempFinallyAbaDest.bundleDir), tempFinallyAbaIdentity);
  check(
    "finally cleanup retains a replacement across a temporary ABA generation",
    tempFinallyAba.ok === false &&
      tempFinallyAba.commit === "uncertain" &&
      tempFinallyAbaIdentity !== null &&
      survivingTempFinallyAba !== null &&
      readFileSync(join(survivingTempFinallyAba, "competitor.txt"), "utf8") === "competitor-temp-aba",
  );

  const tempFinallyAncestorBase = join(root, "temp-finally-ancestor-base");
  const tempFinallyAncestorProject = join(tempFinallyAncestorBase, "project");
  mkdirSync(tempFinallyAncestorProject, { recursive: true, mode: 0o700 });
  const tempFinallyAncestorDest = bundlePaths(tempFinallyAncestorProject, "destination");
  let tempFinallyAncestorReplacementPath = null;
  const tempFinallyAncestor = await writeForkedSession(sumSrc.sessionFile, tempFinallyAncestorDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationCurrentInstall() {
        throw new Error("injected temporary ancestor cleanup failure");
      },
      beforeTemporaryCleanupMutation(path) {
        const project = dirname(path);
        renameSync(project, `${project}.original`);
        mkdirSync(project, { recursive: false, mode: 0o700 });
        mkdirSync(path, { recursive: false, mode: 0o700 });
        writeFileSync(join(path, "competitor.txt"), "competitor-temp-ancestor", { mode: 0o600 });
        tempFinallyAncestorReplacementPath = path;
      },
    },
  });
  check(
    "finally cleanup retains a replacement after a temporary ancestor swap",
    tempFinallyAncestor.ok === false &&
      tempFinallyAncestor.commit === "uncertain" &&
      tempFinallyAncestorReplacementPath !== null &&
      existsSync(join(tempFinallyAncestorReplacementPath, "competitor.txt")) &&
      readFileSync(join(tempFinallyAncestorReplacementPath, "competitor.txt"), "utf8") === "competitor-temp-ancestor",
  );

  const destinationClaimRaceDest = bundlePaths(root, "destination-claim-race-dest");
  let competitorClaimIdentity = null;
  const destinationClaimRace = await writeForkedSession(sumSrc.sessionFile, destinationClaimRaceDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationClaim(path) {
        mkdirSync(path, { recursive: false, mode: 0o700 });
        const info = lstatSync(path);
        competitorClaimIdentity = { dev: info.dev, ino: info.ino };
      },
    },
  });
  const survivingClaim = existsSync(destinationClaimRaceDest.bundleDir)
    ? lstatSync(destinationClaimRaceDest.bundleDir)
    : null;
  check(
    "atomic destination claim never replaces an intervening empty competitor directory",
    destinationClaimRace.ok === false &&
      competitorClaimIdentity !== null &&
      survivingClaim?.isDirectory() === true &&
      survivingClaim.dev === competitorClaimIdentity.dev &&
      survivingClaim.ino === competitorClaimIdentity.ino &&
      readdirSync(destinationClaimRaceDest.bundleDir).length === 0,
  );

  const currentCollisionDest = bundlePaths(root, "destination-current-collision-dest");
  const currentCollisionMarker = join(currentCollisionDest.currentDir, "competitor.txt");
  const currentCollision = await writeForkedSession(sumSrc.sessionFile, currentCollisionDest.sessionFile, 4, {
    testHooks: {
      afterDestinationClaim(path) {
        mkdirSync(join(path, "current"), { recursive: false, mode: 0o700 });
        writeFileSync(currentCollisionMarker, "competitor-current-bytes", { mode: 0o600 });
      },
    },
  });
  check(
    "failed current install preserves unexpected content inside the claimed destination",
    currentCollision.ok === false &&
      currentCollision.commit === "uncertain" &&
      existsSync(currentCollisionMarker) &&
      readFileSync(currentCollisionMarker, "utf8") === "competitor-current-bytes",
  );

  const emptyClaimCleanupDest = bundlePaths(root, "empty-claim-cleanup-dest");
  const emptyClaimCleanup = await writeForkedSession(sumSrc.sessionFile, emptyClaimCleanupDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationCurrentInstall() {
        throw new Error("injected precommit current-install failure");
      },
    },
  });
  check(
    "uncontended precommit cleanup fails closed and retains the empty claim",
    emptyClaimCleanup.ok === false &&
      emptyClaimCleanup.commit === "uncertain" &&
      existsSync(emptyClaimCleanupDest.bundleDir) &&
      readdirSync(emptyClaimCleanupDest.bundleDir).length === 0,
  );

  const cleanupSwapDest = bundlePaths(root, "cleanup-identity-swap-dest");
  const cleanupSwapMarker = join(cleanupSwapDest.bundleDir, "competitor.txt");
  let cleanupSwapIdentity = null;
  const cleanupSwap = await writeForkedSession(sumSrc.sessionFile, cleanupSwapDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationCurrentInstall() {
        throw new Error("injected precommit cleanup path");
      },
      afterDestinationCleanupIdentityProof(path) {
        rmdirSync(path);
        mkdirSync(path, { recursive: false, mode: 0o700 });
        writeFileSync(cleanupSwapMarker, "competitor-after-proof", { mode: 0o600 });
        const info = lstatSync(path);
        cleanupSwapIdentity = { dev: info.dev, ino: info.ino };
      },
    },
  });
  const survivingCleanupSwap = existsSync(cleanupSwapDest.bundleDir)
    ? lstatSync(cleanupSwapDest.bundleDir)
    : null;
  check(
    "empty-claim cleanup rechecks identity after proof and preserves a replacement root",
    cleanupSwap.ok === false &&
      cleanupSwap.commit === "uncertain" &&
      cleanupSwapIdentity !== null &&
      survivingCleanupSwap?.isDirectory() === true &&
      survivingCleanupSwap.dev === cleanupSwapIdentity.dev &&
      survivingCleanupSwap.ino === cleanupSwapIdentity.ino &&
      existsSync(cleanupSwapMarker) &&
      readFileSync(cleanupSwapMarker, "utf8") === "competitor-after-proof",
  );

  const cleanupFinalSwapDest = bundlePaths(root, "cleanup-final-swap-dest");
  let cleanupFinalSwapIdentity = null;
  const cleanupFinalSwap = await writeForkedSession(sumSrc.sessionFile, cleanupFinalSwapDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationCurrentInstall() {
        throw new Error("injected final cleanup race");
      },
      beforeDestinationCleanupMutation(path) {
        rmdirSync(path);
        mkdirSync(path, { recursive: false, mode: 0o700 });
        const info = lstatSync(path);
        cleanupFinalSwapIdentity = { dev: info.dev, ino: info.ino };
      },
    },
  });
  const survivingCleanupFinalSwap = existsSync(cleanupFinalSwapDest.bundleDir)
    ? lstatSync(cleanupFinalSwapDest.bundleDir)
    : null;
  check(
    "cleanup fails closed when a leaf is replaced after the final identity proof",
    cleanupFinalSwap.ok === false &&
      cleanupFinalSwap.commit === "uncertain" &&
      cleanupFinalSwapIdentity !== null &&
      survivingCleanupFinalSwap?.isDirectory() === true &&
      survivingCleanupFinalSwap.dev === cleanupFinalSwapIdentity.dev &&
      survivingCleanupFinalSwap.ino === cleanupFinalSwapIdentity.ino,
  );

  const cleanupAbaDest = bundlePaths(root, "cleanup-aba-dest");
  let cleanupAbaReplacement = null;
  let cleanupAbaIdentity = null;
  const cleanupAba = await writeForkedSession(sumSrc.sessionFile, cleanupAbaDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationCurrentInstall() {
        throw new Error("injected cleanup ABA race");
      },
      afterDestinationCleanupIdentityProof(path) {
        const original = `${path}.aba-original`;
        cleanupAbaReplacement = `${path}.aba-replacement`;
        renameSync(path, original);
        mkdirSync(path, { recursive: false, mode: 0o700 });
        renameSync(path, cleanupAbaReplacement);
        renameSync(original, path);
      },
      beforeDestinationCleanupMutation(path) {
        const original = `${path}.aba-original-late`;
        renameSync(path, original);
        renameSync(cleanupAbaReplacement, path);
        const info = lstatSync(path);
        cleanupAbaIdentity = { dev: info.dev, ino: info.ino };
      },
    },
  });
  const survivingCleanupAba = existsSync(cleanupAbaDest.bundleDir)
    ? lstatSync(cleanupAbaDest.bundleDir)
    : null;
  check(
    "cleanup fails closed across an ABA leaf generation after the final identity proof",
    cleanupAba.ok === false &&
      cleanupAba.commit === "uncertain" &&
      cleanupAbaIdentity !== null &&
      survivingCleanupAba?.isDirectory() === true &&
      survivingCleanupAba.dev === cleanupAbaIdentity.dev &&
      survivingCleanupAba.ino === cleanupAbaIdentity.ino,
  );

  const cleanupAncestorBase = join(root, "cleanup-ancestor-base");
  const cleanupAncestorProject = join(cleanupAncestorBase, "project");
  mkdirSync(cleanupAncestorProject, { recursive: true, mode: 0o700 });
  const cleanupAncestorDest = bundlePaths(cleanupAncestorProject, "session");
  let cleanupAncestorIdentity = null;
  const cleanupAncestor = await writeForkedSession(sumSrc.sessionFile, cleanupAncestorDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationCurrentInstall() {
        throw new Error("injected cleanup ancestor race");
      },
      beforeDestinationCleanupMutation(path) {
        const project = dirname(path);
        renameSync(project, `${project}.original`);
        mkdirSync(project, { recursive: false, mode: 0o700 });
        mkdirSync(path, { recursive: false, mode: 0o700 });
        const info = lstatSync(path);
        cleanupAncestorIdentity = { dev: info.dev, ino: info.ino };
      },
    },
  });
  const survivingCleanupAncestor = existsSync(cleanupAncestorDest.bundleDir)
    ? lstatSync(cleanupAncestorDest.bundleDir)
    : null;
  check(
    "cleanup fails closed when its destination ancestor is swapped after proof",
    cleanupAncestor.ok === false &&
      cleanupAncestor.commit === "uncertain" &&
      cleanupAncestorIdentity !== null &&
      survivingCleanupAncestor?.isDirectory() === true &&
      survivingCleanupAncestor.dev === cleanupAncestorIdentity.dev &&
      survivingCleanupAncestor.ino === cleanupAncestorIdentity.ino,
  );

  const rollbackReplacementDest = bundlePaths(root, "rollback-replacement-dest");
  const rollbackReplacementMarker = join(rollbackReplacementDest.bundleDir, "competitor.txt");
  let rollbackReplacementIdentity = null;
  const rollbackReplacement = await writeForkedSession(sumSrc.sessionFile, rollbackReplacementDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationParentSync(path) {
        rmSync(path, { recursive: true, force: true });
        mkdirSync(path, { recursive: false, mode: 0o700 });
        writeFileSync(rollbackReplacementMarker, "competitor-owned-bytes", { mode: 0o600 });
        const info = lstatSync(path);
        rollbackReplacementIdentity = { dev: info.dev, ino: info.ino };
        throw new Error("injected failure after destination replacement");
      },
    },
  });
  const survivingReplacement = existsSync(rollbackReplacementDest.bundleDir)
    ? lstatSync(rollbackReplacementDest.bundleDir)
    : null;
  check(
    "rollback never deletes a replacement destination and reports an uncertain commit",
    rollbackReplacement.ok === false &&
      rollbackReplacement.commit === "uncertain" &&
      rollbackReplacementIdentity !== null &&
      survivingReplacement?.isDirectory() === true &&
      survivingReplacement.dev === rollbackReplacementIdentity.dev &&
      survivingReplacement.ino === rollbackReplacementIdentity.ino &&
      readFileSync(rollbackReplacementMarker, "utf8") === "competitor-owned-bytes",
  );

  const postRenameSyncDest = bundlePaths(root, "post-rename-sync-dest");
  const postRenameExtra = join(postRenameSyncDest.bundleDir, "competitor-extra.txt");
  const postRenameSync = await writeForkedSession(sumSrc.sessionFile, postRenameSyncDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationParentSync() {
        writeFileSync(postRenameExtra, "competitor-post-commit", { mode: 0o600 });
        throw new Error("injected post-rename sync failure");
      },
    },
  });
  const postRenameSyncReplay = await replaySessionBundle(postRenameSyncDest.sessionFile);
  check(
    "post-commit failure preserves the installed session and every unexpected child",
    postRenameSync.ok === false &&
      postRenameSync.commit === "uncertain" &&
      postRenameSyncReplay.ok &&
      existsSync(postRenameExtra) &&
      readFileSync(postRenameExtra, "utf8") === "competitor-post-commit",
  );

  const postRenameVerifyDest = bundlePaths(root, "post-rename-verify-dest");
  const postRenameVerify = await writeForkedSession(sumSrc.sessionFile, postRenameVerifyDest.sessionFile, 4, {
    testHooks: {
      beforeDestinationVerify(path) {
        chmodSync(path, 0o755);
      },
    },
  });
  check(
    "post-rename verification failure preserves the committed destination as uncertain",
    postRenameVerify.ok === false &&
      postRenameVerify.commit === "uncertain" &&
      existsSync(postRenameVerifyDest.sessionFile),
  );

  const failForkSrc = bundlePaths(root, "fail-fork-src");
  mkdirSync(failForkSrc.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    failForkSrc.sessionFile,
    `${JSON.stringify({
      storageSeq: 1,
      type: "message",
      message: { role: "user", content: [{ type: "image", source: { type: "file", name: "session-img-1.png", media_type: "image/png" } }] },
    })}\n`,
    { mode: 0o600 },
  );
  const failDest = bundlePaths(root, "fail-fork-dst");
  const failFork = await writeForkedSession(failForkSrc.sessionFile, failDest.sessionFile, 1);
  check("failed fork does not leave a destination bundle", failFork.ok === false && !existsSync(failDest.bundleDir));
  const leftoversTmp = readdirSync(root).filter((n) => /^t-[0-9a-f]{32}$/.test(n));
  check("failed fork retains temporary siblings when cleanup is not descriptor-bound", leftoversTmp.length > 0);

  const retainedTempCapRoot = join(root, "retained-temp-cap");
  mkdirSync(retainedTempCapRoot, { recursive: true, mode: 0o700 });
  for (let i = 0; i < MAX_RETAINED_TEMP_BUNDLES; i++) {
    mkdirSync(join(retainedTempCapRoot, `t-${String(i).padStart(32, "0")}`), { mode: 0o700 });
  }
  const retainedTempCapDest = bundlePaths(retainedTempCapRoot, "capacity-dest");
  const retainedTempCapFork = await writeForkedSession(sumSrc.sessionFile, retainedTempCapDest.sessionFile, 4);
  check(
    "retained temporary session count is durably bounded",
    retainedTempCapFork.ok === false &&
      retainedTempCapFork.error.includes(`${MAX_RETAINED_TEMP_BUNDLES}`) &&
      readdirSync(retainedTempCapRoot).filter((name) => /^t-[0-9a-f]{32}$/.test(name)).length === MAX_RETAINED_TEMP_BUNDLES,
  );

  const retainedTempBytesRoot = join(root, "retained-temp-bytes");
  mkdirSync(retainedTempBytesRoot, { recursive: true, mode: 0o700 });
  const retainedTempBytesDir = join(retainedTempBytesRoot, `t-${"f".repeat(32)}`);
  mkdirSync(retainedTempBytesDir, { mode: 0o700 });
  const retainedTempBytesFile = join(retainedTempBytesDir, "retained.bin");
  writeFileSync(retainedTempBytesFile, "", { mode: 0o600 });
  truncateSync(retainedTempBytesFile, MAX_RETAINED_TEMP_BYTES);
  const retainedTempBytesDest = bundlePaths(retainedTempBytesRoot, "bytes-dest");
  const retainedTempBytesFork = await writeForkedSession(sumSrc.sessionFile, retainedTempBytesDest.sessionFile, 4);
  check(
    "retained temporary session bytes are durably bounded",
    retainedTempBytesFork.ok === false && retainedTempBytesFork.error.includes(`${MAX_RETAINED_TEMP_BYTES}`),
  );

  const imgSrc = bundlePaths(root, "img-src");
  mkdirSync(imgSrc.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(imgSrc.currentDir, "session-img-1.png"), png1x1);
  writeFileSync(join(imgSrc.currentDir, "session-img-2.png"), png1x1);
  writeFileSync(join(imgSrc.currentDir, "other-img-1.png"), png1x1);
  writeFileSync(
    imgSrc.sessionFile,
    `${JSON.stringify({
      storageSeq: 1,
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "pic" },
          { type: "image", source: { type: "file", name: "session-img-1.png", media_type: "image/png" } },
        ],
      },
    })}\n`,
    { mode: 0o600 },
  );
  const imgDst = bundlePaths(root, "img-dst");
  const imgFork = await writeForkedSession(imgSrc.sessionFile, imgDst.sessionFile, 1);
  check("fork copies a referenced image", imgFork.ok && existsSync(join(imgDst.currentDir, "session-img-1.png")));
  check("fork skips an unreferenced image", !existsSync(join(imgDst.currentDir, "session-img-2.png")));
  check("fork skips a sibling image name", !existsSync(join(imgDst.currentDir, "other-img-1.png")));

  const imageRaceOutside = join(root, "image-race-outside.png");
  writeFileSync(imageRaceOutside, Buffer.from("outside"));
  const imageRaceDest = bundlePaths(root, "img-race-dest");
  let replacedImage = false;
  const imageRaceFork = await writeForkedSession(imgSrc.sessionFile, imageRaceDest.sessionFile, 1, {
    testHooks: {
      beforeImageOpen(path) {
        if (replacedImage) return;
        replacedImage = true;
        renameSync(path, `${path}.saved`);
        symlinkSync(imageRaceOutside, path);
      },
    },
  });
  check(
    "no-follow image copy rejects replacement and installs no destination",
    imageRaceFork.ok === false && !existsSync(imageRaceDest.bundleDir),
  );

  const badImg = bundlePaths(root, "img-bad");
  mkdirSync(badImg.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    badImg.sessionFile,
    `${JSON.stringify({
      storageSeq: 1,
      type: "message",
      message: { role: "user", content: [{ type: "image", source: { type: "file", name: "../secret.png", media_type: "image/png" } }] },
    })}\n`,
    { mode: 0o600 },
  );
  const badImgFork = await writeForkedSession(badImg.sessionFile, coreSessionFile(root, "img-bad-dst"), 1);
  check("fork rejects an unsafe image path", badImgFork.ok === false);

  const missImg = bundlePaths(root, "img-miss");
  mkdirSync(missImg.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    missImg.sessionFile,
    `${JSON.stringify({
      storageSeq: 1,
      type: "message",
      message: { role: "user", content: [{ type: "image", source: { type: "file", name: "session-img-9.png", media_type: "image/png" } }] },
    })}\n`,
    { mode: 0o600 },
  );
  const missFork = await writeForkedSession(missImg.sessionFile, coreSessionFile(root, "img-miss-dst"), 1);
  check("fork fails when a referenced image is missing", missFork.ok === false);

  const linkImg = bundlePaths(root, "img-link");
  mkdirSync(linkImg.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "outside.png"), png1x1);
  try {
    symlinkSync(join(root, "outside.png"), join(linkImg.currentDir, "session-img-1.png"));
  } catch {
    /* windows */
  }
  writeFileSync(
    linkImg.sessionFile,
    `${JSON.stringify({
      storageSeq: 1,
      type: "message",
      message: { role: "user", content: [{ type: "image", source: { type: "file", name: "session-img-1.png", media_type: "image/png" } }] },
    })}\n`,
    { mode: 0o600 },
  );
  const linkFork = await writeForkedSession(linkImg.sessionFile, coreSessionFile(root, "img-link-dst"), 1);
  check("fork fails when a referenced image is a symlink", linkFork.ok === false);

  const clearB = bundlePaths(root, "clear-1");
  mkdirSync(clearB.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(clearB.sessionFile, `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "keep" } })}\n`);
  writeFileSync(join(clearB.currentDir, "session-img-1.png"), png1x1);
  const cleared = clearSessionBundle(clearB.sessionFile, Date.UTC(2026, 7, 26, 15, 4, 5));
  check("clear archives a non-empty current", cleared.ok && typeof cleared.archived === "string" && existsSync(cleared.archived));
  check("clear creates a new current", existsSync(clearB.sessionFile) && readFileSync(clearB.sessionFile, "utf8") === "");
  check("archived current keeps the image", existsSync(join(cleared.archived, "session-img-1.png")));
  const clearedAgain = clearSessionBundle(clearB.sessionFile);
  check("clear of an empty current does not create an archive", clearedAgain.ok && clearedAgain.archived === null);
  const removeCleared = await removeEmptySessionBundle(clearB.sessionFile);
  check(
    "empty-session cleanup preserves a bundle with archives",
    removeCleared.ok && removeCleared.removed === false && existsSync(clearB.bundleDir),
  );

  const emptyRemovable = bundlePaths(root, "empty-removable");
  const emptyWriter = openWriter(emptyRemovable.sessionFile);
  emptyWriter.close();
  const removedEmpty = await removeEmptySessionBundle(emptyRemovable.sessionFile);
  check(
    "empty-session cleanup retains a bundle when removal is not descriptor-bound",
    removedEmpty.ok && removedEmpty.removed === false && existsSync(emptyRemovable.bundleDir),
  );

  const emptyCleanupRace = bundlePaths(root, "empty-cleanup-race");
  const emptyRaceWriter = openWriter(emptyCleanupRace.sessionFile);
  emptyRaceWriter.close();
  let emptyCleanupReplacementIdentity = null;
  const emptyCleanupResult = await removeEmptySessionBundle(emptyCleanupRace.sessionFile, {
    testHooks: {
      beforeEmptySessionCleanupMutation(path) {
        renameSync(path, `${path}.original`);
        mkdirSync(path, { recursive: false, mode: 0o700 });
        mkdirSync(join(path, "current"), { recursive: false, mode: 0o700 });
        writeFileSync(join(path, "current", "session.jsonl"), "", { mode: 0o600 });
        writeFileSync(join(path, "competitor.txt"), "competitor-empty-cleanup", { mode: 0o600 });
        const info = lstatSync(path);
        emptyCleanupReplacementIdentity = { dev: info.dev, ino: info.ino };
      },
    },
  });
  check(
    "empty-session cleanup retains a replacement inserted after final shape proof",
    emptyCleanupResult.ok &&
      emptyCleanupResult.removed === false &&
      emptyCleanupReplacementIdentity !== null &&
      lstatSync(emptyCleanupRace.bundleDir).ino === emptyCleanupReplacementIdentity.ino &&
      existsSync(join(emptyCleanupRace.bundleDir, "competitor.txt")) &&
      readFileSync(join(emptyCleanupRace.bundleDir, "competitor.txt"), "utf8") === "competitor-empty-cleanup",
  );

  const emptyCleanupAba = bundlePaths(root, "empty-cleanup-aba");
  const emptyAbaWriter = openWriter(emptyCleanupAba.sessionFile);
  emptyAbaWriter.close();
  const emptyCleanupAbaResult = await removeEmptySessionBundle(emptyCleanupAba.sessionFile, {
    testHooks: {
      beforeEmptySessionCleanupMutation(path) {
        const original = `${path}.original`;
        const replacement = `${path}.replacement`;
        renameSync(path, original);
        mkdirSync(path, { recursive: false, mode: 0o700 });
        mkdirSync(join(path, "current"), { recursive: false, mode: 0o700 });
        writeFileSync(join(path, "current", "session.jsonl"), "", { mode: 0o600 });
        renameSync(path, replacement);
        renameSync(original, path);
      },
    },
  });
  check(
    "empty-session cleanup retains the original bundle across an ABA replacement",
    emptyCleanupAbaResult.ok &&
      emptyCleanupAbaResult.removed === false &&
      existsSync(emptyCleanupAba.bundleDir) &&
      existsSync(emptyCleanupAba.sessionFile),
  );

  const emptyCleanupAncestorBase = join(root, "empty-cleanup-ancestor-base");
  const emptyCleanupAncestorProject = join(emptyCleanupAncestorBase, "project");
  mkdirSync(emptyCleanupAncestorProject, { recursive: true, mode: 0o700 });
  const emptyCleanupAncestor = bundlePaths(emptyCleanupAncestorProject, "session");
  const emptyAncestorWriter = openWriter(emptyCleanupAncestor.sessionFile);
  emptyAncestorWriter.close();
  const emptyCleanupAncestorResult = await removeEmptySessionBundle(emptyCleanupAncestor.sessionFile, {
    testHooks: {
      beforeEmptySessionCleanupMutation(path) {
        const project = dirname(path);
        renameSync(project, `${project}.original`);
        mkdirSync(project, { recursive: false, mode: 0o700 });
        mkdirSync(path, { recursive: false, mode: 0o700 });
        mkdirSync(join(path, "current"), { recursive: false, mode: 0o700 });
        writeFileSync(join(path, "current", "session.jsonl"), "", { mode: 0o600 });
        writeFileSync(join(path, "competitor.txt"), "competitor-empty-ancestor", { mode: 0o600 });
      },
    },
  });
  check(
    "empty-session cleanup retains a replacement after an ancestor swap",
    emptyCleanupAncestorResult.ok &&
      emptyCleanupAncestorResult.removed === false &&
      existsSync(join(emptyCleanupAncestor.bundleDir, "competitor.txt")) &&
      readFileSync(join(emptyCleanupAncestor.bundleDir, "competitor.txt"), "utf8") === "competitor-empty-ancestor",
  );

  const fresh = bundlePaths(root, "fresh-1");
  mkdirSync(fresh.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(fresh.sessionFile, `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "old" } })}\n`);
  const archived = prepareFreshSession(fresh.sessionFile, Date.UTC(2026, 7, 26, 15, 4, 5));
  check("fresh prompt archives non-empty current", archived.ok && existsSync(archived.archived));

  const q = bundlePaths(root, "q-1");
  mkdirSync(q.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(q.sessionFile, `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "bad" } })}\n`);
  const quarantined = quarantineSessionBundle(q.sessionFile, Date.UTC(2026, 7, 26, 15, 4, 5));
  check("quarantine renames current to bad-*", quarantined.ok && quarantined.aside.includes("bad-") && !existsSync(q.currentDir));
  const quarantinedAgain = quarantineSessionBundle(q.sessionFile);
  check("quarantine of a missing current fails closed", quarantinedAgain.ok === false);
  mkdirSync(q.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(q.sessionFile, "second\n");
  const q2 = quarantineSessionBundle(q.sessionFile, Date.UTC(2026, 7, 26, 15, 4, 5));
  check("quarantine collision uses a numeric suffix", q2.ok && q2.aside !== quarantined.aside && existsSync(q2.aside));

  const collide = bundlePaths(root, "col-1");
  mkdirSync(collide.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(collide.sessionFile, `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content: "a" } })}\n`);
  const stamp = Date.UTC(2026, 7, 26, 15, 4, 5);
  mkdirSync(join(collide.bundleDir, `archive-${sessionRotateStamp(stamp)}`));
  const col = prepareFreshSession(collide.sessionFile, stamp);
  check("archive collision uses a numeric suffix", col.ok && col.archived && col.archived.endsWith("-1"));

  const recover = bundlePaths(root, "rec-1");
  mkdirSync(recover.bundleDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(recover.bundleDir, `archive-${sessionRotateStamp(Date.now())}`));
  const recov = prepareFreshSession(recover.sessionFile);
  check("crash after archive rename recovers a fresh current", recov.ok && existsSync(recover.sessionFile));

  const listed = await listLogicalSessions(root);
  check(
    "logical enumerate lists current and archive, not numbered parts",
    listed.some((e) => e.kind === "current") &&
      listed.some((e) => e.kind === "archive") &&
      listed.every((e) => !e.name.includes("part-")),
  );
  check("logical enumerate ignores bad directories", listed.every((e) => !e.path.includes("/bad-")));
  check("old flat files are not bundle paths", isCoreSessionBundleFile(join(root, "core-flat.jsonl")) === false);
  writeFileSync(join(root, "core-flat.jsonl"), "{}\n");
  const listedAfterFlat = await listLogicalSessions(root);
  check("old flat files are not listed as sessions", listedAfterFlat.every((e) => !e.path.endsWith("core-flat.jsonl")));
  check("resolveSessionFile ignores an old roster path", resolveSessionFile(root, "roll-1", join(root, "core-flat.jsonl")) === coreSessionFile(root, "roll-1"));

  const big = bundlePaths(root, "big-1");
  mkdirSync(big.currentDir, { recursive: true, mode: 0o700 });
  const bigW = openWriter(big.sessionFile);
  let bigSeq = 0;
  let written = 0;
  while (written < 33 * 1024 * 1024) {
    bigSeq += 1;
    const rec = fillRecord(bigSeq, 200 * 1024);
    const got = bigW.appendRecord(rec);
    if (!got.ok) throw new Error(got.error);
    written += Buffer.byteLength(`${JSON.stringify(rec)}\n`);
    if (bigSeq % 16 === 0) await new Promise((r) => setImmediate(r));
  }
  bigW.close();
  const bigListing = listCurrentSegments(big.currentDir);
  const bigSize = (bigListing.ok ? bigListing.parts.reduce((s, p) => s + p.size, 0) : 0) + (bigListing.ok && bigListing.active ? bigListing.active.size : 0);
  check("synthetic session is larger than 32 MiB", bigSize > 32 * 1024 * 1024 && bigListing.ok && bigListing.parts.length >= 4);
  const bigReplay = await replaySessionBundle(big.sessionFile);
  check("32 MiB session resumes without a whole-file read API", bigReplay.ok && bigReplay.maxSeq === bigSeq);
  const bigFork = await writeForkedSession(big.sessionFile, coreSessionFile(root, "big-fork"), 3);
  check("32 MiB session forks a prefix", bigFork.ok && bigFork.kept >= 1);
  const bigClear = clearSessionBundle(big.sessionFile);
  check("32 MiB session clears by directory rename", bigClear.ok && typeof bigClear.archived === "string" && existsSync(bigClear.archived));
  check("cleared 32 MiB session has an empty current", sessionBundleExists(big.sessionFile) && sessionBundleHasContent(big.sessionFile) === false);

  const unexpected = bundlePaths(root, "bad-name");
  mkdirSync(unexpected.currentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(unexpected.currentDir, "notes.jsonl"), "{}\n");
  writeFileSync(unexpected.sessionFile, "", { mode: 0o600 });
  const unexpectedList = listCurrentSegments(unexpected.currentDir);
  check("unexpected jsonl in current is rejected", unexpectedList.ok === false);

  check("sessionBundleExists is not stat(sessionFile) alone", sessionBundleExists(roll.sessionFile) === true);
  writeFileSync(roll.sessionFile, "");
  check("sessionBundleHasContent sees numbered parts when active is empty", sessionBundleHasContent(roll.sessionFile) === true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runExportedChecks(run, { label: "agent-core session" });
  process.exitCode = result.exitCode;
}
