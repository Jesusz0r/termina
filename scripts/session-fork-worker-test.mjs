/**
 * Focused integration coverage for the canonical session fork worker.
 * Run with:
 *   TERMINA_CORE_TEST=1 node --experimental-strip-types --no-warnings scripts/session-fork-worker-test.mjs
 */
import { build } from "esbuild";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

process.env.TERMINA_CORE_TEST = "1";

const { SessionWriter, coreSessionFile, replaySessionBundle } = await import("../agent-core/session.ts");
const work = mkdtempSync(join(tmpdir(), "termina-session-fork-worker-"));
let client;
const nativeCoreAvailable = [
  process.env.TERMINA_CORE_BIN,
  join(process.cwd(), "core", "target", "release", "termina-core"),
  join(process.cwd(), "core", "target", "debug", "termina-core"),
].some((candidate) => candidate && existsSync(candidate));

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS  ${message}`);
}

function destinationSession(projectName, sessionId) {
  const project = join(work, projectName);
  mkdirSync(project, { recursive: false, mode: 0o700 });
  return coreSessionFile(project, sessionId);
}

try {
  const bundleBanner = {
    js: 'import { createRequire as __sessionForkRequire } from "node:module"; const require = __sessionForkRequire(import.meta.url);',
  };
  await Promise.all([
    build({
      entryPoints: ["electron/session-fork.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: join(work, "session-fork.mjs"),
      logLevel: "silent",
    }),
    build({
      entryPoints: ["electron/session-worker.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: join(work, "session-worker.mjs"),
      banner: bundleBanner,
      logLevel: "silent",
    }),
  ]);

  const { SessionForkClient } = await import(pathToFileURL(join(work, "session-fork.mjs")).href);
  client = new SessionForkClient();

  const piSourceDir = join(work, "pi-source");
  const piSource = SessionManager.create(join(work, "pi-primary"), piSourceDir);
  piSource.appendMessage({ role: "user", content: "keep the existing Pi fork path", timestamp: Date.now() });
  piSource.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Pi fork ready." }],
    api: "anthropic",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const preAbortedPi = new AbortController();
  preAbortedPi.abort();
  let preAbortedPiRejected = false;
  try {
    await client.fork(
      {
        sourceSessionFile: piSource.getSessionFile(),
        entryId: null,
        sessionWorkspaceDir: join(work, "pre-aborted-pi-workspace"),
        candidateRoot: join(work, "pre-aborted-pi-candidate"),
        candidateSessionDir: join(work, "pre-aborted-pi-sessions"),
      },
      { signal: preAbortedPi.signal },
    );
  } catch (error) {
    preAbortedPiRejected = error instanceof Error && error.name === "AbortError";
  }
  assert(preAbortedPiRejected, "pre-aborted Pi worker fork is rejected before dispatch");
  const piFork = await client.fork({
    sourceSessionFile: piSource.getSessionFile(),
    entryId: null,
    sessionWorkspaceDir: join(work, "pi-workspace"),
    candidateRoot: join(work, "pi-candidate"),
    candidateSessionDir: join(work, "pi-candidate-sessions"),
  });
  assert(piFork.ok && piFork.entryCount === 2 && !!piFork.sessionFile, "existing Pi session fork behavior remains valid through the worker");
  assert(
    !readdirSync(join(work, "pi-workspace")).some((name) => name.startsWith("fork-")) || !nativeCoreAvailable,
    "successful Pi worker fork releases its scratch copy (or retains safely without native cleanup)",
  );

  const piDiscardWorkspace = join(work, "pi-discard-workspace");
  const piCopied = await client.copyPi({
    sourceSessionFile: piSource.getSessionFile(),
    sessionWorkspaceDir: piDiscardWorkspace,
  });
  if (!piCopied.ok) throw new Error(piCopied.error);
  assert(
    piCopied.identity.dev && piCopied.identity.ino && piCopied.identity.rootDev && piCopied.identity.rootIno,
    "Pi finalization copy returns leaf and workspace provenance for later discard",
  );
  const piDiscard = await client.discardPi({
    sessionFile: piCopied.sessionFile,
    sessionWorkspaceDir: piDiscardWorkspace,
    identity: piCopied.identity,
  });
  assert(piDiscard.ok && piDiscard.removed && !existsSync(piCopied.sessionFile), "identity-bound Pi discard removes the exact finalized copy");

  const piLeafAbaWorkspace = join(work, "pi-leaf-aba-workspace");
  const piLeafAba = await client.copyPi({
    sourceSessionFile: piSource.getSessionFile(),
    sessionWorkspaceDir: piLeafAbaWorkspace,
  });
  if (!piLeafAba.ok) throw new Error(piLeafAba.error);
  const piLeafAbaHeld = join(work, "pi-leaf-aba-held.jsonl");
  const piLeafAbaOutside = join(work, "pi-leaf-aba-outside.txt");
  writeFileSync(piLeafAbaOutside, "outside\n", { mode: 0o600 });
  renameSync(piLeafAba.sessionFile, piLeafAbaHeld);
  symlinkSync(piLeafAbaOutside, piLeafAba.sessionFile);
  const piLeafAbaDiscard = await client.discardPi({
    sessionFile: piLeafAba.sessionFile,
    sessionWorkspaceDir: piLeafAbaWorkspace,
    identity: piLeafAba.identity,
  });
  assert(
    !piLeafAbaDiscard.ok
      && existsSync(piLeafAbaHeld)
      && existsSync(piLeafAba.sessionFile)
      && readFileSync(piLeafAbaOutside, "utf8") === "outside\n",
    "identity-bound Pi discard retains a symlink leaf ABA replacement",
  );

  const piHardlinkWorkspace = join(work, "pi-hardlink-workspace");
  const piHardlink = await client.copyPi({
    sourceSessionFile: piSource.getSessionFile(),
    sessionWorkspaceDir: piHardlinkWorkspace,
  });
  if (!piHardlink.ok) throw new Error(piHardlink.error);
  const piHardlinkHeld = join(work, "pi-hardlink-held.jsonl");
  renameSync(piHardlink.sessionFile, piHardlinkHeld);
  linkSync(piHardlinkHeld, piHardlink.sessionFile);
  const piHardlinkDiscard = await client.discardPi({
    sessionFile: piHardlink.sessionFile,
    sessionWorkspaceDir: piHardlinkWorkspace,
    identity: piHardlink.identity,
  });
  assert(
    !piHardlinkDiscard.ok && existsSync(piHardlinkHeld) && existsSync(piHardlink.sessionFile),
    "identity-bound Pi discard rejects a same-inode hardlink replacement",
  );

  const piAncestorWorkspace = join(work, "pi-ancestor-workspace");
  const piAncestor = await client.copyPi({
    sourceSessionFile: piSource.getSessionFile(),
    sessionWorkspaceDir: piAncestorWorkspace,
  });
  if (!piAncestor.ok) throw new Error(piAncestor.error);
  const piAncestorHeld = join(work, "pi-ancestor-workspace-held");
  renameSync(piAncestorWorkspace, piAncestorHeld);
  mkdirSync(piAncestorWorkspace, { recursive: true, mode: 0o700 });
  writeFileSync(join(piAncestorWorkspace, "replacement.jsonl"), "replacement\n", { mode: 0o600 });
  const piAncestorDiscard = await client.discardPi({
    sessionFile: piAncestor.sessionFile,
    sessionWorkspaceDir: piAncestorWorkspace,
    identity: piAncestor.identity,
  });
  assert(
    !piAncestorDiscard.ok
      && existsSync(join(piAncestorHeld, basename(piAncestor.sessionFile)))
      && existsSync(join(piAncestorWorkspace, "replacement.jsonl")),
    "identity-bound Pi discard retains both sides of an ancestor replacement",
  );

  const replayIdentityWorkspace = join(work, "pi-replay-identity-workspace");
  const replayIdentity = await client.copyPi({
    sourceSessionFile: piSource.getSessionFile(),
    sessionWorkspaceDir: replayIdentityWorkspace,
  });
  if (!replayIdentity.ok) throw new Error(replayIdentity.error);
  const replayIdentityHeld = join(work, "pi-replay-identity-held.jsonl");
  const replayIdentityOutside = join(work, "pi-replay-identity-outside.txt");
  writeFileSync(replayIdentityOutside, "replay-outside\n", { mode: 0o600 });
  renameSync(replayIdentity.sessionFile, replayIdentityHeld);
  symlinkSync(replayIdentityOutside, replayIdentity.sessionFile);
  let replayIdentityError = null;
  try {
    await client.fork({
      sourceSessionFile: replayIdentity.sessionFile,
      sourceSessionIdentity: replayIdentity.identity,
      entryId: null,
      sessionWorkspaceDir: join(work, "pi-replay-identity-fork-workspace"),
      candidateRoot: join(work, "pi-replay-identity-candidate"),
      candidateSessionDir: join(work, "pi-replay-identity-candidate-sessions"),
    });
  } catch (error) {
    replayIdentityError = error;
  }
  assert(
    replayIdentityError instanceof Error
      && /source|identity|regular|symbolic/i.test(replayIdentityError.message)
      && existsSync(replayIdentityHeld)
      && existsSync(replayIdentity.sessionFile)
      && readFileSync(replayIdentityOutside, "utf8") === "replay-outside\n",
    "Pi replay rejects a replaced finalized-session leaf before branching",
  );

  const restartWorkspace = join(work, "pi-restart-workspace");
  const restartCopyClient = new SessionForkClient();
  const restartCopy = await restartCopyClient.copyPi({
    sourceSessionFile: piSource.getSessionFile(),
    sessionWorkspaceDir: restartWorkspace,
  });
  if (!restartCopy.ok) throw new Error(restartCopy.error);
  await restartCopyClient.dispose();
  const restartedClient = new SessionForkClient();
  const restartDiscard = await restartedClient.discardPi({
    sessionFile: restartCopy.sessionFile,
    sessionWorkspaceDir: restartWorkspace,
    identity: restartCopy.identity,
  });
  await restartedClient.dispose();
  assert(restartDiscard.ok && restartDiscard.removed && !existsSync(restartCopy.sessionFile), "Pi copy identity survives worker restart for explicit discard");

  const emptyCore = destinationSession("empty-core-project", "empty-core");
  const emptyCoreOpened = SessionWriter.open(emptyCore, 0);
  if (!emptyCoreOpened.ok) throw new Error(emptyCoreOpened.error);
  emptyCoreOpened.writer.close();
  const emptyCoreDiscard = await client.discardEmptyCoreSession(emptyCore);
  assert(
    emptyCoreDiscard.ok && emptyCoreDiscard.removed && !existsSync(join(work, "empty-core-project", "empty-core")),
    "empty core-session discard uses the native identity-bound cleanup owner",
  );

  const source = coreSessionFile(join(work, "source-project"), "source");
  const opened = SessionWriter.open(source, 0);
  if (!opened.ok) throw new Error(opened.error);
  const recordBytes = 512 * 1024;
  const recordCount = 24;
  for (let index = 1; index <= recordCount; index++) {
    const appended = opened.writer.appendRecord({
      storageSeq: index,
      type: "message",
      message: { role: index % 2 === 0 ? "assistant" : "user", content: "x".repeat(recordBytes) },
    });
    if (!appended.ok) throw new Error(appended.error);
  }
  opened.writer.close();

  const cancelledDestination = destinationSession("cancelled-project", "cancelled");
  const controller = new AbortController();
  const cancelledFork = client.forkCore(
    { sourceSessionFile: source, destinationSessionFile: cancelledDestination },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 1);
  let cancelled = false;
  try {
    await cancelledFork;
  } catch (error) {
    cancelled = error instanceof Error && error.name === "AbortError";
  }
  assert(cancelled, "active core worker fork reports cancellation structurally");
  assert(!existsSync(join(cancelledDestination, "..", "..")), "cancelled core worker fork installs no destination bundle");

  const destination = destinationSession("destination-project", "destination");
  let timerTicks = 0;
  const heartbeat = setInterval(() => {
    timerTicks += 1;
  }, 1);
  const result = await client.forkCore({ sourceSessionFile: source, destinationSessionFile: destination });
  clearInterval(heartbeat);
  assert(result.ok && result.kept === recordCount, "core worker returns a structured successful fork result");
  assert(timerTicks >= 2, "main event loop remains responsive during a multi-part core fork");
  const replayed = await replaySessionBundle(destination);
  assert(replayed.ok && replayed.messages.length === recordCount, "core worker installs valid replayable fork output");

  const queuedPiBusyDestination = destinationSession("queued-pi-busy-project", "queued-pi-busy");
  const queuedPiController = new AbortController();
  const queuedPiBusy = client.forkCore({
    sourceSessionFile: source,
    destinationSessionFile: queuedPiBusyDestination,
    testOnlyPostRenameDelayMs: 200,
  });
  const queuedPiDestinationRoot = join(work, "queued-pi-candidate");
  let queuedPiError;
  const queuedPi = client
    .fork(
      {
        sourceSessionFile: piSource.getSessionFile(),
        entryId: null,
        sessionWorkspaceDir: join(work, "queued-pi-workspace"),
        candidateRoot: queuedPiDestinationRoot,
        candidateSessionDir: join(work, "queued-pi-sessions"),
      },
      { signal: queuedPiController.signal },
    )
    .catch((error) => {
      queuedPiError = error;
    });
  queuedPiController.abort();
  await queuedPi;
  await queuedPiBusy;
  assert(queuedPiError instanceof Error && queuedPiError.name === "AbortError", "queued Pi worker fork is cancelled before dispatch");
  assert(!existsSync(queuedPiDestinationRoot), "cancelled queued Pi work installs no candidate session");

  const committedDuringDispose = destinationSession("dispose-commit-project", "dispose-commit");
  const commitPromise = client.forkCore({
    sourceSessionFile: source,
    destinationSessionFile: committedDuringDispose,
    testOnlyPostRenameDelayMs: 200,
  });
  const queuedDuringDispose = destinationSession("queued-dispose-project", "queued-dispose");
  let queuedError;
  const queuedPromise = client
    .forkCore({ sourceSessionFile: source, destinationSessionFile: queuedDuringDispose })
    .catch((error) => {
      queuedError = error;
    });
  const commitDeadline = Date.now() + 2_000;
  while (!existsSync(committedDuringDispose) && Date.now() < commitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(existsSync(committedDuringDispose), "active-dispose fixture reaches the atomic destination commit");
  const disposal = client.dispose();
  const committedResult = await commitPromise;
  await disposal;
  assert(committedResult.ok && existsSync(committedDuringDispose), "dispose reconciles a late committed result instead of rejecting it");
  const committedReplay = await replaySessionBundle(committedDuringDispose);
  assert(committedReplay.ok && committedReplay.messages.length === recordCount, "active dispose preserves valid committed output");
  await queuedPromise;
  assert(
    queuedError instanceof Error && /disposed/.test(queuedError.message) && !existsSync(queuedDuringDispose),
    "dispose rejects queued core work without installing its destination",
  );

  let disposedRejected = false;
  try {
    await client.forkCore({ sourceSessionFile: source, destinationSessionFile: destinationSession("late", "late") });
  } catch (error) {
    disposedRejected = error instanceof Error && /disposed/.test(error.message);
  }
  assert(disposedRejected, "disposed session fork client cannot silently respawn its worker");
} finally {
  await client?.dispose();
  rmSync(work, { recursive: true, force: true });
}
