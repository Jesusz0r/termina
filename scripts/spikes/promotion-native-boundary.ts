import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  boundPromotionCopyFile,
  boundPromotionCopyTree,
  boundPromotionCreateDirectory,
  boundPromotionInstallDirectory,
  boundPromotionOpenDirectory,
  boundPromotionPrepareDirectory,
  boundPromotionRemoveTree,
  boundPromotionCreateSymlink,
  boundPromotionWriteFile,
  readBoundPromotionJournal,
  boundPromotionTransition,
  SnapshotStore,
} from "../../electron/worldline-git.js";
import { coreClient } from "../../electron/core-client.js";

// The native pause/release seam is test-only and must be enabled by this
// spike itself so the race regressions cannot silently become no-ops.
process.env.TERMINA_CORE_TEST ??= "1";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const identity = (path: string): { dev: string; ino: string } => {
  const info = lstatSync(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};
const makeNestedDirectory = (base: string, depth: number): string => {
  let current = base;
  mkdirSync(current, { recursive: true, mode: 0o700 });
  for (let level = 0; level < depth; level += 1) {
    current = join(current, `level-${level}`);
    mkdirSync(current, { mode: 0o700 });
  }
  return current;
};
const fileState = (path: string) => {
  const bytes = readFileSync(path);
  const info = lstatSync(path);
  return { type: "file" as const, mode: info.mode & 0o777, size: String(bytes.byteLength), sha256: sha256(bytes) };
};
const waitForPath = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      lstatSync(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new Error(`timed out waiting for native test hook: ${path}`);
};
const hookPaths = (root: string, name: string) => ({
  readyPath: join(root, `${name}.ready`),
  releasePath: join(root, `${name}.release`),
});

type FreshCoreResponse = {
  ok?: boolean;
  error?: string;
  result?: Record<string, unknown>;
};

// The process-local capability registry is deliberately not shared across
// CoreClient instances. These short-lived children exercise restart and
// admission behavior without leaving an unowned core alive if a probe fails.
const freshCoreChildren = new Set<ReturnType<typeof spawn>>();
const freshCoreRequest = (binary: string, request: Record<string, unknown>): Promise<FreshCoreResponse> => new Promise((resolve, reject) => {
  const child = spawn(binary, [], {
    env: { ...process.env, TERMINA_CORE_TEST: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  freshCoreChildren.add(child);
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    reject(new Error("fresh core probe timed out"));
  }, 180_000);
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback();
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", (error) => finish(() => reject(error)));
  child.on("close", (code, signal) => {
    freshCoreChildren.delete(child);
    finish(() => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      const line = lines.at(-1);
      if (!line) {
        reject(new Error(`fresh core probe returned no response (${code ?? signal ?? "unknown"}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line) as FreshCoreResponse);
      } catch (error) {
        reject(new Error(`fresh core probe returned malformed JSON: ${error instanceof Error ? error.message : String(error)}; stderr: ${stderr}`));
      }
    });
  });
  child.stdin?.end(`${JSON.stringify({ ...request, requestId: `probe-${Date.now()}-${Math.random()}` })}\n`);
});

export default async function run(log: (message: string) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "termina-promotion-native-test-"));
  try {
    const canonicalRoot = realpathSync(root);
    const journalRoot = join(canonicalRoot, "promotion-journal");
    const operation = join(journalRoot, "operation");
    mkdirSync(operation, { recursive: true, mode: 0o700 });
    writeFileSync(join(operation, "journal.json"), '{"phase":"applying","primaryRoot":"/primary"}\n');
    const content = await readBoundPromotionJournal({
      journalRoot,
      journalRootIdentity: identity(journalRoot),
      operationName: "operation",
      operationIdentity: identity(operation),
    });
    if (content.toString("utf8") !== '{"phase":"applying","primaryRoot":"/primary"}\n') throw new Error("bound journal bytes changed");
    log("PASS descriptor-bound journal read returns bytes from the bound operation directory");

    let wrongIdentity = false;
    try {
      await readBoundPromotionJournal({
        journalRoot,
        journalRootIdentity: identity(journalRoot),
        operationName: "operation",
        operationIdentity: { dev: "0", ino: "0" },
      });
    } catch (error) {
      wrongIdentity = /identity|changed|mismatch/i.test(String(error));
    }
    if (!wrongIdentity) throw new Error("forged operation identity was accepted");
    log("PASS bound journal read rejects a forged operation identity");

    const operationOpenHook = hookPaths(canonicalRoot, "journal-operation-open");
    const forgedOperation = join(journalRoot, "operation-forged");
    const parkedOperation = join(journalRoot, "operation-parked");
    const parkedForgedOperation = join(journalRoot, "operation-forged-parked");
    mkdirSync(forgedOperation, { recursive: true, mode: 0o700 });
    writeFileSync(join(forgedOperation, "journal.json"), '{"phase":"forged"}\n');
    const operationOpenRead = readBoundPromotionJournal({
      journalRoot,
      journalRootIdentity: identity(journalRoot),
      operationName: "operation",
      operationIdentity: identity(operation),
      testHook: { stage: "journal-operation-open", ...operationOpenHook },
    });
    await waitForPath(operationOpenHook.readyPath);
    renameSync(operation, parkedOperation);
    renameSync(forgedOperation, operation);
    renameSync(operation, parkedForgedOperation);
    renameSync(parkedOperation, operation);
    writeFileSync(operationOpenHook.releasePath, "release");
    const operationOpenBytes = await operationOpenRead;
    if (operationOpenBytes.toString("utf8") !== '{"phase":"applying","primaryRoot":"/primary"}\n') {
      throw new Error("operation-directory ABA swap-back changed the journal bytes");
    }
    log("PASS journal read remains bound across an operation-directory ABA swap-back");

    const fileOpenHook = hookPaths(canonicalRoot, "journal-file-open");
    const parkedJournal = join(operation, "journal-parked.json");
    const parkedForgedJournal = join(operation, "journal-forged-parked.json");
    const fileOpenRead = readBoundPromotionJournal({
      journalRoot,
      journalRootIdentity: identity(journalRoot),
      operationName: "operation",
      operationIdentity: identity(operation),
      testHook: { stage: "journal-file-open", ...fileOpenHook },
    });
    await waitForPath(fileOpenHook.readyPath);
    renameSync(join(operation, "journal.json"), parkedJournal);
    writeFileSync(join(operation, "journal.json"), '{"phase":"forged-file"}\n');
    renameSync(join(operation, "journal.json"), parkedForgedJournal);
    renameSync(parkedJournal, join(operation, "journal.json"));
    writeFileSync(fileOpenHook.releasePath, "release");
    const fileOpenBytes = await fileOpenRead;
    if (fileOpenBytes.toString("utf8") !== '{"phase":"applying","primaryRoot":"/primary"}\n') {
      throw new Error("journal-file ABA swap-back changed the journal bytes");
    }
    log("PASS journal read remains bound across a journal-file ABA swap-back");

    // Root/parent identities must be captured by Core before a mutable
    // pathname preflight can be interleaved.  The root hook swaps in a real
    // directory (not a symlink), so a pathname-only opener would return the
    // replacement identity.
    const preboundRoot = join(canonicalRoot, "prebound-root");
    const preboundReplacement = join(canonicalRoot, "prebound-replacement");
    mkdirSync(preboundRoot, { recursive: true, mode: 0o700 });
    mkdirSync(preboundReplacement, { recursive: true, mode: 0o700 });
    const preboundHook = hookPaths(canonicalRoot, "prebound-root");
    const preboundOpen = boundPromotionOpenDirectory({
      path: preboundRoot,
      expectedIdentity: identity(preboundRoot),
      testHook: { stage: "promotion-directory-prebind", ...preboundHook },
    });
    await waitForPath(preboundHook.readyPath);
    const parkedPreboundRoot = join(canonicalRoot, "prebound-root-parked");
    renameSync(preboundRoot, parkedPreboundRoot);
    renameSync(preboundReplacement, preboundRoot);
    writeFileSync(preboundHook.releasePath, "release");
    const preboundIdentity = await preboundOpen;
    if (preboundIdentity.dev !== identity(parkedPreboundRoot).dev || preboundIdentity.ino !== identity(parkedPreboundRoot).ino) {
      throw new Error("native root prebind captured a swapped real directory");
    }
    const swappedPreboundRoot = join(canonicalRoot, "prebound-replacement-parked");
    renameSync(preboundRoot, swappedPreboundRoot);
    renameSync(parkedPreboundRoot, preboundRoot);
    log("PASS native root prebind retains the descriptor identity across a real-directory swap");

    // A capability must reject a replacement at the same pathname, and an
    // opaque token must not survive a native-core restart.  The latter is
    // deliberately exercised with a fresh core child because CoreClient is a
    // singleton in the app process.
    const parkedCapabilityRoot = join(canonicalRoot, "prebound-capability-held");
    renameSync(preboundRoot, parkedCapabilityRoot);
    renameSync(swappedPreboundRoot, preboundRoot);
    let replacementCapabilityRejected = false;
    try {
      await boundPromotionOpenDirectory({ path: preboundRoot, capability: preboundIdentity.capability });
    } catch (error) {
      replacementCapabilityRejected = /identity|changed|mismatch/i.test(String(error));
    }
    if (!replacementCapabilityRejected) throw new Error("root capability adopted a replacement at its bound pathname");
    renameSync(preboundRoot, swappedPreboundRoot);
    renameSync(parkedCapabilityRoot, preboundRoot);
    const coreBinary = process.env.TERMINA_CORE_BIN ?? join(process.cwd(), "core", "target", "release", "termina-core");
    const restartedResponse = execFileSync(coreBinary, [], {
      input: `${JSON.stringify({ op: "promotion-bound-open-directory", requestId: "restart-probe", path: preboundRoot, capability: preboundIdentity.capability })}\n`,
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).at(-1);
    if (restartedResponse?.ok !== false || !/unknown|restart|rebind/i.test(String(restartedResponse?.error))) {
      throw new Error("root capability was accepted by a restarted core");
    }
    log("PASS root capability rejects same-path replacement and native-core restart reuse");

    // A configured root that already exists before the first app bind is not
    // a trust anchor. The native trusted-parent form must reject it without a
    // persisted expected leaf identity; after the owner restores its original
    // inode, a fresh core may rebind only with that exact durable identity.
    const firstBindParent = join(canonicalRoot, "first-bind-parent");
    const firstBindRoot = join(firstBindParent, "worlds");
    const firstBindOriginal = join(canonicalRoot, "first-bind-original");
    const firstBindReplacement = join(canonicalRoot, "first-bind-replacement");
    mkdirSync(firstBindParent, { recursive: true, mode: 0o700 });
    mkdirSync(firstBindOriginal, { mode: 0o700 });
    mkdirSync(firstBindReplacement, { mode: 0o700 });
    renameSync(firstBindOriginal, firstBindRoot);
    const firstBindHeld = join(canonicalRoot, "first-bind-held");
    renameSync(firstBindRoot, firstBindHeld);
    renameSync(firstBindReplacement, firstBindRoot);
    const trustedFirstParent = { path: firstBindParent, identity: identity(firstBindParent), name: "worlds" };
    const initialReplacement = await freshCoreRequest(coreBinary, {
      op: "promotion-bound-ensure-directory",
      path: firstBindRoot,
      trustedParent: trustedFirstParent,
    });
    const initialReplacementAccepted = initialReplacement.ok === true;
    if (initialReplacementAccepted || !existsSync(firstBindRoot) || !existsSync(firstBindHeld)) {
      throw new Error("native first bind adopted an existing replacement root without provenance");
    }
    renameSync(firstBindRoot, firstBindReplacement);
    renameSync(firstBindHeld, firstBindRoot);
    const firstBindIdentity = identity(firstBindRoot);
    const legitimateRestart = await freshCoreRequest(coreBinary, {
      op: "promotion-bound-open-directory",
      path: firstBindRoot,
      expectedIdentity: firstBindIdentity,
    });
    const legitimateRestartIdentity = legitimateRestart.result?.identity as { dev?: unknown; ino?: unknown } | undefined;
    if (legitimateRestart.ok !== true || legitimateRestartIdentity?.dev !== firstBindIdentity.dev || legitimateRestartIdentity?.ino !== firstBindIdentity.ino) {
      throw new Error("native legitimate restart rebind rejected the persisted root identity");
    }
    const restartHeld = join(canonicalRoot, "first-bind-restart-held");
    const restartReplacement = join(canonicalRoot, "first-bind-restart-replacement");
    renameSync(firstBindRoot, restartHeld);
    mkdirSync(restartReplacement, { mode: 0o700 });
    renameSync(restartReplacement, firstBindRoot);
    const restartReplacementResult = await freshCoreRequest(coreBinary, {
      op: "promotion-bound-ensure-directory",
      path: firstBindRoot,
      trustedParent: trustedFirstParent,
    });
    if (restartReplacementResult.ok !== false || !/identity|expected|trusted/i.test(String(restartReplacementResult.error))) {
      throw new Error("native restart trusted-parent bind adopted a replacement root");
    }
    renameSync(firstBindRoot, restartReplacement);
    renameSync(restartHeld, firstBindRoot);
    log("PASS first/restart root binds reject unproven existing leaves and accept the persisted identity");

    const preboundParentRoot = join(canonicalRoot, "prebound-parent-root");
    const preboundParent = join(preboundParentRoot, "parent");
    const preboundParentReplacement = join(canonicalRoot, "prebound-parent-replacement");
    mkdirSync(preboundParent, { recursive: true, mode: 0o700 });
    mkdirSync(preboundParentReplacement, { recursive: true, mode: 0o700 });
    const preboundParentRootIdentity = identity(preboundParentRoot);
    const preboundParentResult = await boundPromotionPrepareDirectory({
      root: preboundParentRoot,
      rootIdentity: preboundParentRootIdentity,
      components: ["parent"],
    });
    if (!preboundParentResult.identity) throw new Error("native parent prebind did not return an identity");
    const parkedPreboundParent = join(preboundParentRoot, "parent-parked");
    renameSync(preboundParent, parkedPreboundParent);
    renameSync(preboundParentReplacement, preboundParent);
    let staleParentRejected = false;
    try {
      await boundPromotionCreateDirectory({
        root: preboundParentRoot,
        rootIdentity: preboundParentRootIdentity,
        components: ["parent", "new-child"],
        parentIdentity: preboundParentResult.identity,
        requireMissing: true,
      });
    } catch (error) {
      staleParentRejected = /identity|changed|mismatch/i.test(String(error));
    }
    if (!staleParentRejected) throw new Error("native parent identity accepted a swapped real directory");
    const swappedPreboundParent = join(canonicalRoot, "prebound-parent-replacement-parked");
    renameSync(preboundParent, swappedPreboundParent);
    renameSync(parkedPreboundParent, preboundParent);
    log("PASS native parent prebind rejects a swapped real directory before mutation");

    // A missing nested parent must retain the identities of every existing
    // prefix.  Replacing that prefix before materialization must fail closed
    // instead of creating the missing tail below the replacement directory.
    const prepareChainRoot = join(canonicalRoot, "prepare-chain-root");
    const prepareChainPrefix = join(prepareChainRoot, "prefix");
    const prepareChainReplacement = join(canonicalRoot, "prepare-chain-replacement");
    mkdirSync(prepareChainPrefix, { recursive: true, mode: 0o700 });
    mkdirSync(prepareChainReplacement, { recursive: true, mode: 0o700 });
    const prepareChainProbe = await boundPromotionPrepareDirectory({
      root: prepareChainRoot,
      rootIdentity: identity(prepareChainRoot),
      components: ["prefix", "missing", "leaf"],
      allowMissing: true,
    });
    if (prepareChainProbe.missingAt !== 1 || prepareChainProbe.chain.length !== 1) {
      throw new Error("native prepare did not return the existing prefix identity chain");
    }
    const parkedPrepareChainPrefix = join(prepareChainRoot, "prefix-held");
    renameSync(prepareChainPrefix, parkedPrepareChainPrefix);
    renameSync(prepareChainReplacement, prepareChainPrefix);
    let prepareChainRejected = false;
    try {
      await boundPromotionPrepareDirectory({
        root: prepareChainRoot,
        rootIdentity: identity(prepareChainRoot),
        components: ["prefix", "missing", "leaf"],
        createMissing: true,
        expectedMissingAt: prepareChainProbe.missingAt,
        expectedChain: prepareChainProbe.chain,
      });
    } catch (error) {
      prepareChainRejected = /identity|changed|mismatch/i.test(String(error));
    }
    if (!prepareChainRejected || existsSync(join(prepareChainPrefix, "missing"))) {
      throw new Error("native prepare adopted a swapped existing prefix");
    }
    const parkedPrepareChainReplacement = join(canonicalRoot, "prepare-chain-replacement-held");
    renameSync(prepareChainPrefix, parkedPrepareChainReplacement);
    renameSync(parkedPrepareChainPrefix, prepareChainPrefix);
    const preparedChain = await boundPromotionPrepareDirectory({
      root: prepareChainRoot,
      rootIdentity: identity(prepareChainRoot),
      components: ["prefix", "missing", "leaf"],
      createMissing: true,
      expectedMissingAt: prepareChainProbe.missingAt,
      expectedChain: prepareChainProbe.chain,
    });
    if (!preparedChain.identity || !existsSync(join(prepareChainPrefix, "missing", "leaf"))) {
      throw new Error("native prepare did not materialize the expected missing tail");
    }
    log("PASS native prepare rejects a swapped existing prefix before missing-tail materialization");

    const primary = join(canonicalRoot, "primary");
    mkdirSync(primary, { recursive: true, mode: 0o755 });
    const destination = join(primary, "destination.txt");
    const source = join(primary, ".termina-promotion-restore.tmp");
    writeFileSync(destination, "applied\n");
    writeFileSync(source, "before\n");
    const primaryInfo = identity(primary);
    const exchanged = await boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: primaryInfo,
      destinationComponents: ["destination.txt"],
      parentIdentity: primaryInfo,
      transition: {
        kind: "exchange",
        sourceName: ".termina-promotion-restore.tmp",
        expectedSource: { identity: identity(source), state: fileState(source) },
        expectedDestination: { identity: identity(destination), state: fileState(destination) },
      },
    });
    if (exchanged.outcome !== "applied" || readFileSync(destination, "utf8") !== "before\n" || readFileSync(source, "utf8") !== "applied\n") {
      throw new Error("bound exchange did not retain both leaf artifacts");
    }
    log("PASS bound exchange restores the destination while retaining the applied artifact");

    // Initial promotion installs a staged entry whose parent is outside the
    // primary tree. The native operation must bind both parent descriptors and
    // use a no-replace install when the destination is absent.
    const stagedRoot = join(canonicalRoot, "staged");
    const stagedNested = join(stagedRoot, "nested");
    mkdirSync(stagedNested, { recursive: true, mode: 0o700 });
    const stagedInstall = join(stagedNested, "install.txt");
    writeFileSync(stagedInstall, "staged-install\n");
    const installDestination = join(primary, "install.txt");
    const installed = await boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["install.txt"],
      parentIdentity: identity(primary),
      transition: {
        kind: "install",
        sourceRoot: stagedRoot,
        sourceRootIdentity: identity(stagedRoot),
        sourceComponents: ["nested", "install.txt"],
        sourceParentIdentity: identity(stagedNested),
        expectedSource: { identity: identity(stagedInstall), state: fileState(stagedInstall) },
        expectedDestination: { state: { type: "missing" } },
      },
    } as never);
    if (installed.outcome !== "applied" || readFileSync(installDestination, "utf8") !== "staged-install\n") {
      throw new Error("bound install did not move the staged entry into an absent destination");
    }
    let stagedInstallExists = true;
    try {
      lstatSync(stagedInstall);
    } catch {
      stagedInstallExists = false;
    }
    if (stagedInstallExists) throw new Error("bound install left the staged source entry");
    log("PASS bound install uses descriptor-bound cross-parent no-replace semantics");

    const stagedReplace = join(stagedNested, "replace.txt");
    const replaceDestination = join(primary, "replace.txt");
    writeFileSync(stagedReplace, "staged-replace\n");
    writeFileSync(replaceDestination, "primary-replace\n");
    const replaced = await boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["replace.txt"],
      parentIdentity: identity(primary),
      transition: {
        kind: "install",
        sourceRoot: stagedRoot,
        sourceRootIdentity: identity(stagedRoot),
        sourceComponents: ["nested", "replace.txt"],
        sourceParentIdentity: identity(stagedNested),
        expectedSource: { identity: identity(stagedReplace), state: fileState(stagedReplace) },
        expectedDestination: { identity: identity(replaceDestination), state: fileState(replaceDestination) },
      },
    });
    if (replaced.outcome !== "applied" || readFileSync(replaceDestination, "utf8") !== "staged-replace\n" || readFileSync(stagedReplace, "utf8") !== "primary-replace\n") {
      throw new Error("bound install did not preserve an existing destination during cross-parent exchange");
    }
    log("PASS bound install uses descriptor-bound cross-parent exchange for existing destinations");

    const retireSource = join(primary, "retire.txt");
    const retainedName = ".termina-promotion-retained-retire.tmp";
    const retained = join(primary, retainedName);
    writeFileSync(retireSource, "applied-only\n");
    const retired = await boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: primaryInfo,
      destinationComponents: ["retire.txt"],
      parentIdentity: primaryInfo,
      transition: {
        kind: "retire",
        retainedName,
        expectedDestination: { identity: identity(retireSource), state: fileState(retireSource) },
      },
    });
    if (retired.outcome !== "applied" || readFileSync(retained, "utf8") !== "applied-only\n") throw new Error("bound retire did not preserve the artifact");
    let destinationExists = true;
    try {
      lstatSync(retireSource);
    } catch {
      destinationExists = false;
    }
    if (destinationExists) throw new Error("bound retire left the destination entry");
    log("PASS bound retire moves the applied artifact to a no-replace retained name");

    const retainedRoot = join(canonicalRoot, "retained-journal");
    const retainedParent = join(retainedRoot, "retained");
    const externalRetireDestination = join(primary, "external-retire.txt");
    const externalRetainedName = ".termina-promotion-retained-external.tmp";
    const externalRetained = join(retainedParent, externalRetainedName);
    mkdirSync(retainedParent, { recursive: true, mode: 0o700 });
    writeFileSync(externalRetireDestination, "external-retire\n");
    const externalRetired = await boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["external-retire.txt"],
      parentIdentity: identity(primary),
      transition: {
        kind: "retire",
        retainedName: externalRetainedName,
        retainedRoot,
        retainedRootIdentity: identity(retainedRoot),
        retainedComponents: ["retained", externalRetainedName],
        retainedParentIdentity: identity(retainedParent),
        expectedDestination: { identity: identity(externalRetireDestination), state: fileState(externalRetireDestination) },
      },
    });
    if (externalRetired.outcome !== "applied" || readFileSync(externalRetained, "utf8") !== "external-retire\n") {
      throw new Error("bound retire did not move the applied artifact into the journal retention root");
    }
    let externalDestinationExists = true;
    try {
      lstatSync(externalRetireDestination);
    } catch {
      externalDestinationExists = false;
    }
    if (externalDestinationExists) throw new Error("bound external retire left the primary destination entry");
    log("PASS bound retire preserves deletes in an app-owned cross-parent retention root");

    const sinkDestination = join(primary, "sink-swap-back.txt");
    const sinkSource = join(primary, ".termina-promotion-restore-sink.tmp");
    writeFileSync(sinkDestination, "sink-applied\n");
    writeFileSync(sinkSource, "sink-before\n");
    const sinkHook = hookPaths(canonicalRoot, "sink-swap-back");
    const sinkTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["sink-swap-back.txt"],
      parentIdentity: identity(primary),
      testHook: { stage: "promotion-leaf-validated", ...sinkHook },
      transition: {
        kind: "exchange",
        sourceName: ".termina-promotion-restore-sink.tmp",
        expectedSource: { identity: identity(sinkSource), state: fileState(sinkSource) },
        expectedDestination: { identity: identity(sinkDestination), state: fileState(sinkDestination) },
      },
    });
    await waitForPath(sinkHook.readyPath);
    const sinkParked = join(primary, "sink-swap-back-parked.txt");
    const sinkReplacementParked = join(primary, "sink-swap-back-replacement.txt");
    renameSync(sinkDestination, sinkParked);
    writeFileSync(sinkDestination, "sink-replacement\n");
    renameSync(sinkDestination, sinkReplacementParked);
    renameSync(sinkParked, sinkDestination);
    writeFileSync(sinkHook.releasePath, "release");
    const sinkResult = await sinkTransition;
    if (sinkResult.outcome !== "applied" || readFileSync(sinkDestination, "utf8") !== "sink-before\n" || readFileSync(sinkSource, "utf8") !== "sink-applied\n") {
      throw new Error("bound exchange did not linearize safely after a sink ABA swap-back");
    }
    if (readFileSync(sinkReplacementParked, "utf8") !== "sink-replacement\n") throw new Error("sink ABA replacement was not retained");
    log("PASS bound exchange remains safe across a final-sink ABA swap-back");

    const sourceDestination = join(primary, "source-swap-back.txt");
    const sourceOperand = join(primary, ".termina-promotion-source-swap-back.tmp");
    writeFileSync(sourceDestination, "source-applied\n");
    writeFileSync(sourceOperand, "source-before\n");
    const sourceHook = hookPaths(canonicalRoot, "source-swap-back");
    const sourceTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["source-swap-back.txt"],
      parentIdentity: identity(primary),
      testHook: { stage: "promotion-leaf-validated", ...sourceHook },
      transition: {
        kind: "exchange",
        sourceName: ".termina-promotion-source-swap-back.tmp",
        expectedSource: { identity: identity(sourceOperand), state: fileState(sourceOperand) },
        expectedDestination: { identity: identity(sourceDestination), state: fileState(sourceDestination) },
      },
    });
    await waitForPath(sourceHook.readyPath);
    const sourceParked = join(primary, "source-swap-back-parked.txt");
    const sourceReplacementParked = join(primary, "source-swap-back-replacement.txt");
    renameSync(sourceOperand, sourceParked);
    writeFileSync(sourceOperand, "source-replacement\n");
    renameSync(sourceOperand, sourceReplacementParked);
    renameSync(sourceParked, sourceOperand);
    writeFileSync(sourceHook.releasePath, "release");
    const sourceResult = await sourceTransition;
    if (sourceResult.outcome !== "applied" || readFileSync(sourceDestination, "utf8") !== "source-before\n" || readFileSync(sourceOperand, "utf8") !== "source-applied\n") {
      throw new Error("bound exchange did not linearize safely after a source ABA swap-back");
    }
    if (readFileSync(sourceReplacementParked, "utf8") !== "source-replacement\n") throw new Error("source ABA replacement was not retained");
    log("PASS bound exchange remains safe across a source ABA swap-back");

    const installRaceRoot = join(canonicalRoot, "install-race-staged");
    const installRaceParent = join(installRaceRoot, "nested");
    const installRaceSource = join(installRaceParent, "race.txt");
    const installRaceDestination = join(primary, "race.txt");
    mkdirSync(installRaceParent, { recursive: true, mode: 0o700 });
    writeFileSync(installRaceSource, "race-source\n");
    const installRaceHook = hookPaths(canonicalRoot, "install-race");
    const installRaceTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["race.txt"],
      parentIdentity: identity(primary),
      testHook: { stage: "promotion-leaf-validated", ...installRaceHook },
      transition: {
        kind: "install",
        sourceRoot: installRaceRoot,
        sourceRootIdentity: identity(installRaceRoot),
        sourceComponents: ["nested", "race.txt"],
        sourceParentIdentity: identity(installRaceParent),
        expectedSource: { identity: identity(installRaceSource), state: fileState(installRaceSource) },
        expectedDestination: { state: { type: "missing" } },
      },
    });
    await waitForPath(installRaceHook.readyPath);
    writeFileSync(installRaceDestination, "race-replacement\n");
    writeFileSync(installRaceHook.releasePath, "release");
    let installRaceRejected = false;
    try {
      await installRaceTransition;
    } catch (error) {
      installRaceRejected = /install|exist|destination/i.test(String(error));
    }
    if (!installRaceRejected || readFileSync(installRaceSource, "utf8") !== "race-source\n" || readFileSync(installRaceDestination, "utf8") !== "race-replacement\n") {
      throw new Error("bound install overwrote a destination that appeared after validation");
    }
    log("PASS bound install fails closed when a destination appears after validation");

    const retireRaceDestination = join(primary, "retire-swap-back.txt");
    const retireRaceName = ".termina-promotion-retained-swap-back.tmp";
    const retireRaceRetained = join(primary, retireRaceName);
    writeFileSync(retireRaceDestination, "retire-original\n");
    const retireHook = hookPaths(canonicalRoot, "retire-swap-back");
    const retireTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["retire-swap-back.txt"],
      parentIdentity: identity(primary),
      testHook: { stage: "promotion-leaf-validated", ...retireHook },
      transition: {
        kind: "retire",
        retainedName: retireRaceName,
        expectedDestination: { identity: identity(retireRaceDestination), state: fileState(retireRaceDestination) },
      },
    });
    await waitForPath(retireHook.readyPath);
    const retireParked = join(primary, "retire-swap-back-parked.txt");
    const retireReplacementParked = join(primary, "retire-swap-back-replacement.txt");
    renameSync(retireRaceDestination, retireParked);
    writeFileSync(retireRaceDestination, "retire-replacement\n");
    renameSync(retireRaceDestination, retireReplacementParked);
    renameSync(retireParked, retireRaceDestination);
    writeFileSync(retireHook.releasePath, "release");
    const retireResult = await retireTransition;
    if (retireResult.outcome !== "applied" || readFileSync(retireRaceRetained, "utf8") !== "retire-original\n") {
      throw new Error("bound retire did not linearize safely after a sink ABA swap-back");
    }
    if (readFileSync(retireReplacementParked, "utf8") !== "retire-replacement\n") throw new Error("retire ABA replacement was not retained");
    log("PASS bound retire remains safe across a final-sink ABA swap-back");

    // A source/destination type flip after validation must not be accepted as
    // a clean apply. The exchange is intentionally allowed to complete so the
    // native result exposes a conflict while retaining both operands.
    const typeFlipDestination = join(primary, "type-flip.txt");
    const typeFlipSource = join(primary, ".termina-promotion-type-flip.tmp");
    writeFileSync(typeFlipDestination, "type-flip-applied\n");
    writeFileSync(typeFlipSource, "type-flip-before\n");
    const typeFlipHook = hookPaths(canonicalRoot, "type-flip");
    const typeFlipTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["type-flip.txt"],
      parentIdentity: identity(primary),
      testHook: { stage: "promotion-leaf-validated", ...typeFlipHook },
      transition: {
        kind: "exchange",
        sourceName: ".termina-promotion-type-flip.tmp",
        expectedSource: { identity: identity(typeFlipSource), state: fileState(typeFlipSource) },
        expectedDestination: { identity: identity(typeFlipDestination), state: fileState(typeFlipDestination) },
      },
    });
    await waitForPath(typeFlipHook.readyPath);
    const typeFlipParked = join(primary, "type-flip-parked.txt");
    renameSync(typeFlipDestination, typeFlipParked);
    mkdirSync(typeFlipDestination);
    writeFileSync(typeFlipHook.releasePath, "release");
    const typeFlipResult = await typeFlipTransition;
    if (typeFlipResult.outcome !== "conflict-after-mutation" || !lstatSync(typeFlipSource).isDirectory() || readFileSync(typeFlipDestination, "utf8") !== "type-flip-before\n") {
      throw new Error("bound exchange did not report a destination type flip as a retained conflict");
    }
    if (readFileSync(typeFlipParked, "utf8") !== "type-flip-applied\n") throw new Error("type-flip destination artifact was not retained");
    log("PASS bound exchange reports and retains a destination type flip after validation");

    const sourceTypeDestination = join(primary, "source-type-flip.txt");
    const sourceTypeOperand = join(primary, ".termina-promotion-source-type-flip.tmp");
    writeFileSync(sourceTypeDestination, "source-type-applied\n");
    writeFileSync(sourceTypeOperand, "source-type-before\n");
    const sourceTypeHook = hookPaths(canonicalRoot, "source-type-flip");
    const sourceTypeTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["source-type-flip.txt"],
      parentIdentity: identity(primary),
      testHook: { stage: "promotion-leaf-validated", ...sourceTypeHook },
      transition: {
        kind: "exchange",
        sourceName: ".termina-promotion-source-type-flip.tmp",
        expectedSource: { identity: identity(sourceTypeOperand), state: fileState(sourceTypeOperand) },
        expectedDestination: { identity: identity(sourceTypeDestination), state: fileState(sourceTypeDestination) },
      },
    });
    await waitForPath(sourceTypeHook.readyPath);
    const sourceTypeParked = join(primary, "source-type-flip-parked.txt");
    renameSync(sourceTypeOperand, sourceTypeParked);
    mkdirSync(sourceTypeOperand);
    writeFileSync(sourceTypeHook.releasePath, "release");
    const sourceTypeResult = await sourceTypeTransition;
    if (sourceTypeResult.outcome !== "conflict-after-mutation" || !lstatSync(sourceTypeDestination).isDirectory() || readFileSync(sourceTypeOperand, "utf8") !== "source-type-applied\n") {
      throw new Error("bound exchange did not report a source type flip as a retained conflict");
    }
    if (readFileSync(sourceTypeParked, "utf8") !== "source-type-before\n") throw new Error("source type-flip artifact was not retained");
    log("PASS bound exchange reports and retains a source type flip after validation");

    const retireTypeDestination = join(primary, "retire-type-flip.txt");
    const retireTypeName = ".termina-promotion-retained-retire-type-flip.tmp";
    writeFileSync(retireTypeDestination, "retire-type-original\n");
    const retireTypeHook = hookPaths(canonicalRoot, "retire-type-flip");
    const retireTypeTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["retire-type-flip.txt"],
      parentIdentity: identity(primary),
      testHook: { stage: "promotion-leaf-validated", ...retireTypeHook },
      transition: {
        kind: "retire",
        retainedName: retireTypeName,
        expectedDestination: { identity: identity(retireTypeDestination), state: fileState(retireTypeDestination) },
      },
    });
    await waitForPath(retireTypeHook.readyPath);
    const retireTypeParked = join(primary, "retire-type-flip-parked.txt");
    renameSync(retireTypeDestination, retireTypeParked);
    mkdirSync(retireTypeDestination);
    writeFileSync(retireTypeHook.releasePath, "release");
    const retireTypeResult = await retireTypeTransition;
    if (retireTypeResult.outcome !== "conflict-after-mutation" || readFileSync(retireTypeParked, "utf8") !== "retire-type-original\n") {
      throw new Error("bound retire did not retain a destination type flip");
    }
    log("PASS bound retire reports and retains a destination type flip after validation");

    const installSourceTypeDestination = join(primary, "install-source-type-flip.txt");
    const installSourceTypeRoot = join(canonicalRoot, "install-source-type-flip-staged");
    const installSourceTypeOperand = join(installSourceTypeRoot, "source.tmp");
    mkdirSync(installSourceTypeRoot, { recursive: true, mode: 0o700 });
    writeFileSync(installSourceTypeOperand, "install-source-original\n");
    const installSourceTypeHook = hookPaths(canonicalRoot, "install-source-type-flip");
    const installSourceTypeTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["install-source-type-flip.txt"],
      parentIdentity: identity(primary),
      testHook: { stage: "promotion-leaf-validated", ...installSourceTypeHook },
      transition: {
        kind: "install",
        sourceRoot: installSourceTypeRoot,
        sourceRootIdentity: identity(installSourceTypeRoot),
        sourceComponents: ["source.tmp"],
        sourceParentIdentity: identity(installSourceTypeRoot),
        expectedSource: { identity: identity(installSourceTypeOperand), state: fileState(installSourceTypeOperand) },
        expectedDestination: { state: { type: "missing" } },
      },
    });
    await waitForPath(installSourceTypeHook.readyPath);
    const installSourceTypeParked = join(installSourceTypeRoot, "source-parked.tmp");
    renameSync(installSourceTypeOperand, installSourceTypeParked);
    mkdirSync(installSourceTypeOperand);
    writeFileSync(installSourceTypeHook.releasePath, "release");
    const installSourceTypeResult = await installSourceTypeTransition;
    if (installSourceTypeResult.outcome !== "conflict-after-mutation" || !lstatSync(installSourceTypeDestination).isDirectory() || readFileSync(installSourceTypeParked, "utf8") !== "install-source-original\n") {
      throw new Error("bound install did not retain a source type flip conflict");
    }
    log("PASS bound install reports and retains a source type flip after validation");

    const installDestinationTypeDestination = join(primary, "install-destination-type-flip.txt");
    const installDestinationTypeSource = join(canonicalRoot, "install-destination-type-flip.tmp");
    writeFileSync(installDestinationTypeDestination, "install-destination-original\n");
    writeFileSync(installDestinationTypeSource, "install-destination-source\n");
    const installDestinationTypeHook = hookPaths(canonicalRoot, "install-destination-type-flip");
    const installDestinationTypeTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["install-destination-type-flip.txt"],
      parentIdentity: identity(primary),
      testHook: { stage: "promotion-leaf-validated", ...installDestinationTypeHook },
      transition: {
        kind: "install",
        sourceRoot: canonicalRoot,
        sourceRootIdentity: identity(canonicalRoot),
        sourceComponents: ["install-destination-type-flip.tmp"],
        sourceParentIdentity: identity(canonicalRoot),
        expectedSource: { identity: identity(installDestinationTypeSource), state: fileState(installDestinationTypeSource) },
        expectedDestination: { identity: identity(installDestinationTypeDestination), state: fileState(installDestinationTypeDestination) },
      },
    });
    await waitForPath(installDestinationTypeHook.readyPath);
    const installDestinationTypeParked = join(primary, "install-destination-type-flip-parked.txt");
    renameSync(installDestinationTypeDestination, installDestinationTypeParked);
    mkdirSync(installDestinationTypeDestination);
    writeFileSync(installDestinationTypeHook.releasePath, "release");
    const installDestinationTypeResult = await installDestinationTypeTransition;
    if (installDestinationTypeResult.outcome !== "conflict-after-mutation" || !lstatSync(installDestinationTypeSource).isDirectory() || readFileSync(installDestinationTypeDestination, "utf8") !== "install-destination-source\n" || readFileSync(installDestinationTypeParked, "utf8") !== "install-destination-original\n") {
      throw new Error("bound install did not retain a destination type flip conflict");
    }
    log("PASS bound install reports and retains a destination type flip after validation");

    // The ancestor path is swapped after the native parent descriptor is
    // opened. The operation must stay on the original directory, never
    // follow the replacement symlink into an unrelated tree.
    const ancestorParent = join(primary, "ancestor-parent");
    const ancestorDestination = join(ancestorParent, "ancestor.txt");
    const ancestorSource = join(ancestorParent, ".termina-promotion-ancestor.tmp");
    mkdirSync(ancestorParent, { recursive: true, mode: 0o755 });
    writeFileSync(ancestorDestination, "ancestor-applied\n");
    writeFileSync(ancestorSource, "ancestor-before\n");
    const outsideAncestor = join(canonicalRoot, "outside-ancestor");
    mkdirSync(outsideAncestor, { recursive: true, mode: 0o755 });
    writeFileSync(join(outsideAncestor, "ancestor.txt"), "outside\n");
    const ancestorHook = hookPaths(canonicalRoot, "ancestor-swap");
    const ancestorTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["ancestor-parent", "ancestor.txt"],
      parentIdentity: identity(ancestorParent),
      testHook: { stage: "promotion-leaf-validated", ...ancestorHook },
      transition: {
        kind: "exchange",
        sourceName: ".termina-promotion-ancestor.tmp",
        expectedSource: { identity: identity(ancestorSource), state: fileState(ancestorSource) },
        expectedDestination: { identity: identity(ancestorDestination), state: fileState(ancestorDestination) },
      },
    });
    await waitForPath(ancestorHook.readyPath);
    const parkedAncestorParent = join(primary, "ancestor-parent-parked");
    renameSync(ancestorParent, parkedAncestorParent);
    symlinkSync(outsideAncestor, ancestorParent, "dir");
    writeFileSync(ancestorHook.releasePath, "release");
    const ancestorResult = await ancestorTransition;
    if (ancestorResult.outcome !== "applied" || readFileSync(join(parkedAncestorParent, "ancestor.txt"), "utf8") !== "ancestor-before\n" || readFileSync(join(parkedAncestorParent, ".termina-promotion-ancestor.tmp"), "utf8") !== "ancestor-applied\n") {
      throw new Error("bound exchange did not remain on the descriptor-pinned ancestor");
    }
    if (readFileSync(join(outsideAncestor, "ancestor.txt"), "utf8") !== "outside\n") throw new Error("ancestor swap redirected promotion into the outside tree");
    log("PASS bound exchange remains on the pinned parent across an ancestor symlink swap");

    const deleteAncestorParent = join(primary, "delete-ancestor-parent");
    const deleteAncestorDestination = join(deleteAncestorParent, "delete-ancestor.txt");
    const deleteAncestorName = ".termina-promotion-retained-delete-ancestor.tmp";
    const deleteAncestorRetained = join(retainedParent, deleteAncestorName);
    mkdirSync(deleteAncestorParent, { recursive: true, mode: 0o755 });
    writeFileSync(deleteAncestorDestination, "delete-ancestor\n");
    const deleteAncestorOutside = join(canonicalRoot, "outside-delete-ancestor");
    mkdirSync(deleteAncestorOutside, { recursive: true, mode: 0o755 });
    writeFileSync(join(deleteAncestorOutside, "delete-ancestor.txt"), "outside-delete\n");
    const deleteAncestorHook = hookPaths(canonicalRoot, "delete-ancestor-swap");
    const deleteAncestorTransition = boundPromotionTransition({
      primaryRoot: primary,
      primaryRootIdentity: identity(primary),
      destinationComponents: ["delete-ancestor-parent", "delete-ancestor.txt"],
      parentIdentity: identity(deleteAncestorParent),
      testHook: { stage: "promotion-leaf-validated", ...deleteAncestorHook },
      transition: {
        kind: "retire",
        retainedName: deleteAncestorName,
        retainedRoot,
        retainedRootIdentity: identity(retainedRoot),
        retainedComponents: ["retained", deleteAncestorName],
        retainedParentIdentity: identity(retainedParent),
        expectedDestination: { identity: identity(deleteAncestorDestination), state: fileState(deleteAncestorDestination) },
      },
    });
    await waitForPath(deleteAncestorHook.readyPath);
    const parkedDeleteAncestorParent = join(primary, "delete-ancestor-parent-parked");
    renameSync(deleteAncestorParent, parkedDeleteAncestorParent);
    symlinkSync(deleteAncestorOutside, deleteAncestorParent, "dir");
    writeFileSync(deleteAncestorHook.releasePath, "release");
    const deleteAncestorResult = await deleteAncestorTransition;
    if (deleteAncestorResult.outcome !== "applied" || readFileSync(deleteAncestorRetained, "utf8") !== "delete-ancestor\n" || existsSync(join(parkedDeleteAncestorParent, "delete-ancestor.txt"))) {
      throw new Error("bound retire did not remain on the descriptor-pinned ancestor");
    }
    if (readFileSync(join(deleteAncestorOutside, "delete-ancestor.txt"), "utf8") !== "outside-delete\n") throw new Error("ancestor delete swap redirected promotion into the outside tree");
    log("PASS bound retire remains on the pinned parent across an ancestor symlink swap");

    // Every live promotion artifact preparation operation is descriptor-bound
    // too. Swap each root to an outside symlink after the native open; the
    // operation must either mutate the parked original or fail closed, never
    // the outside target.
    const lifecycleRoot = join(canonicalRoot, "lifecycle-root");
    const lifecycleOutside = join(canonicalRoot, "lifecycle-outside");
    mkdirSync(lifecycleRoot, { recursive: true, mode: 0o700 });
    mkdirSync(lifecycleOutside, { recursive: true, mode: 0o700 });
    const lifecycleCreateHook = hookPaths(canonicalRoot, "lifecycle-create");
    const lifecycleCreate = boundPromotionCreateDirectory({
      root: lifecycleRoot,
      rootIdentity: identity(lifecycleRoot),
      components: ["journal"],
      parentIdentity: identity(lifecycleRoot),
      requireMissing: true,
      testHook: { stage: "promotion-directory-root-open", ...lifecycleCreateHook },
    });
    await waitForPath(lifecycleCreateHook.readyPath);
    const parkedLifecycleRoot = join(canonicalRoot, "lifecycle-root-parked");
    renameSync(lifecycleRoot, parkedLifecycleRoot);
    symlinkSync(lifecycleOutside, lifecycleRoot, "dir");
    writeFileSync(lifecycleCreateHook.releasePath, "release");
    let lifecycleCreateRejected = false;
    try {
      await lifecycleCreate;
    } catch (error) {
      lifecycleCreateRejected = /identity|changed|root|symlink|directory/i.test(String(error));
    }
    unlinkSync(lifecycleRoot);
    renameSync(parkedLifecycleRoot, lifecycleRoot);
    if (!lifecycleCreateRejected || existsSync(join(lifecycleRoot, "journal")) || existsSync(join(lifecycleOutside, "journal"))) throw new Error("bound directory creation did not fail closed after an ancestor swap");
    log("PASS bound artifact directory creation fails closed across an ancestor swap");

    // Seed the parent for the population probe after the rejected create; the
    // next operation must likewise reject before writing the parked root.
    mkdirSync(join(lifecycleRoot, "journal"), { mode: 0o700 });

    const materializeRepo = join(canonicalRoot, "materialize-repo");
    mkdirSync(materializeRepo, { recursive: true, mode: 0o700 });
    execFileSync("git", ["init", "-q"], { cwd: materializeRepo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: materializeRepo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: materializeRepo });
    writeFileSync(join(materializeRepo, "merged.txt"), "merged\n");
    execFileSync("git", ["add", "merged.txt"], { cwd: materializeRepo });
    execFileSync("git", ["commit", "-qm", "materialize"], { cwd: materializeRepo });
    const materializeStore = await SnapshotStore.create(join(canonicalRoot, "materialize-store"), materializeRepo, join(materializeRepo, ".git"), "sha1");
    const materializeState = await materializeStore.capture(execFileSync("git", ["rev-parse", "HEAD"], { cwd: materializeRepo, encoding: "utf8" }).trim(), null);
    const materializeRoot = join(canonicalRoot, "materialize-root");
    const materializeOutside = join(canonicalRoot, "materialize-outside");
    mkdirSync(materializeRoot, { recursive: true, mode: 0o700 });
    mkdirSync(materializeOutside, { recursive: true, mode: 0o700 });
    const materializeHook = hookPaths(canonicalRoot, "lifecycle-materialize");
    const materialize = materializeStore.materialize(materializeState.commit, materializeRoot, {
      boundRootIdentity: identity(materializeRoot),
      testHook: { stage: "promotion-materialize-root-open", ...materializeHook },
    });
    await waitForPath(materializeHook.readyPath);
    const parkedMaterializeRoot = join(canonicalRoot, "materialize-root-parked");
    renameSync(materializeRoot, parkedMaterializeRoot);
    symlinkSync(materializeOutside, materializeRoot, "dir");
    writeFileSync(join(materializeOutside, "replacement-evidence.txt"), "replacement-tree\n");
    writeFileSync(materializeHook.releasePath, "release");
    let materializeRejected = false;
    let materializeError = "";
    try {
      await materialize;
    } catch (error) {
      materializeError = String(error);
      materializeRejected = /materialize target|not a directory|identity|symlink/i.test(materializeError);
    }
    unlinkSync(materializeRoot);
    renameSync(parkedMaterializeRoot, materializeRoot);
    if (!materializeRejected || readFileSync(join(materializeRoot, "merged.txt"), "utf8") !== "merged\n" || existsSync(join(materializeOutside, "merged.txt")) || readFileSync(join(materializeOutside, "replacement-evidence.txt"), "utf8") !== "replacement-tree\n") {
      throw new Error(`bound materialization did not fail closed after a swapped ancestor: ${materializeError}`);
    }
    log("PASS bound merged-tree materialization writes only to the pinned root and reports a swapped public path");

    // Forge state commits directly in the app-owned store to exercise the
    // native materializer's tree/blob envelope, rather than relying on the
    // capture path (which correctly refuses oversized source files first).
    const forgeStoreObject = (args: string[], input: Buffer | string): string => execFileSync(
      "git",
      ["--git-dir", materializeStore.gitDir, ...args],
      {
        input,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "termina-probe",
          GIT_AUTHOR_EMAIL: "termina-probe@example.invalid",
          GIT_COMMITTER_NAME: "termina-probe",
          GIT_COMMITTER_EMAIL: "termina-probe@example.invalid",
        },
      },
    ).trim();
    const oversizedBlob = forgeStoreObject(["hash-object", "-w", "--stdin"], Buffer.alloc(64 * 1024 * 1024 + 1, 0x61));
    const oversizedTree = forgeStoreObject(["mktree"], `100644 blob ${oversizedBlob}\toversized.bin\n`);
    const oversizedCommit = forgeStoreObject(["commit-tree", oversizedTree], "forged oversized blob\n");
    let oversizedMaterializeRejected = false;
    try {
      await materializeStore.materialize(oversizedCommit, materializeRoot, { boundRootIdentity: identity(materializeRoot) });
    } catch (error) {
      oversizedMaterializeRejected = /blob|byte|budget|bounded|materialize/i.test(String(error));
    }
    if (!oversizedMaterializeRejected || !existsSync(join(materializeRoot, "merged.txt")) || readFileSync(join(materializeRoot, "merged.txt"), "utf8") !== "merged\n") {
      throw new Error("oversized forged Git blob was materialized or mutated the target");
    }
    let oversizedReadRejected = false;
    try {
      await materializeStore.readBlob(oversizedCommit, "oversized.bin");
    } catch (error) {
      oversizedReadRejected = /blob|byte|budget|bounded|read/i.test(String(error));
    }
    if (!oversizedReadRejected) throw new Error("oversized forged Git blob passed the bounded read endpoint");
    const deepBlob = forgeStoreObject(["hash-object", "-w", "--stdin"], Buffer.from("deep\n"));
    let deepTree = forgeStoreObject(["mktree"], `100644 blob ${deepBlob}\tdeep.bin\n`);
    for (let level = 0; level < 70; level += 1) {
      deepTree = forgeStoreObject(["mktree"], `040000 tree ${deepTree}\tlevel-${String(level).padStart(3, "0")}\n`);
    }
    const deepCommit = forgeStoreObject(["commit-tree", deepTree], "forged deep tree\n");
    let deepMaterializeRejected = false;
    try {
      await materializeStore.materialize(deepCommit, materializeRoot, { boundRootIdentity: identity(materializeRoot) });
    } catch (error) {
      deepMaterializeRejected = /depth|tree|bound|materialize/i.test(String(error));
    }
    if (!deepMaterializeRejected || !existsSync(join(materializeRoot, "merged.txt")) || readFileSync(join(materializeRoot, "merged.txt"), "utf8") !== "merged\n") {
      throw new Error("deep forged Git tree was materialized or mutated the target");
    }
    log("PASS forged Git blob/tree materialization and reads fail before target mutation");
    await materializeStore.destroy();

    const lifecycleWriteHook = hookPaths(canonicalRoot, "lifecycle-write");
    const lifecycleWrite = boundPromotionWriteFile({
      root: lifecycleRoot,
      rootIdentity: identity(lifecycleRoot),
      components: ["journal", "journal.json"],
      parentIdentity: identity(join(lifecycleRoot, "journal")),
      expectedDestination: { state: { type: "missing" } },
      content: Buffer.from("bound-journal\n"),
      testHook: { stage: "promotion-write-parent-open", ...lifecycleWriteHook },
    });
    await waitForPath(lifecycleWriteHook.readyPath);
    const parkedLifecycleWriteRoot = join(canonicalRoot, "lifecycle-root-write-parked");
    renameSync(lifecycleRoot, parkedLifecycleWriteRoot);
    symlinkSync(lifecycleOutside, lifecycleRoot, "dir");
    writeFileSync(lifecycleWriteHook.releasePath, "release");
    let lifecycleWriteRejected = false;
    try {
      await lifecycleWrite;
    } catch (error) {
      lifecycleWriteRejected = /identity|changed|root|symlink|directory/i.test(String(error));
    }
    unlinkSync(lifecycleRoot);
    renameSync(parkedLifecycleWriteRoot, lifecycleRoot);
    if (!lifecycleWriteRejected || existsSync(join(lifecycleRoot, "journal", "journal.json")) || existsSync(join(lifecycleOutside, "journal.json"))) throw new Error("bound journal write did not fail closed after an ancestor swap");
    log("PASS bound journal/evidence write fails closed across an ancestor swap");

    const finalWriteRoot = join(canonicalRoot, "final-write-root");
    mkdirSync(finalWriteRoot, { recursive: true, mode: 0o700 });
    const finalWritePath = join(finalWriteRoot, "journal.json");
    const finalWriteHook = hookPaths(canonicalRoot, "final-write-observe");
    const finalWrite = boundPromotionWriteFile({
      root: finalWriteRoot,
      rootIdentity: identity(finalWriteRoot),
      components: ["journal.json"],
      parentIdentity: identity(finalWriteRoot),
      expectedDestination: { state: { type: "missing" } },
      content: Buffer.from("descriptor-owned\n"),
      testHook: { stage: "promotion-write-final-observe", ...finalWriteHook },
    });
    await waitForPath(finalWriteHook.readyPath);
    const parkedFinalWrite = join(finalWriteRoot, "journal-held.json");
    renameSync(finalWritePath, parkedFinalWrite);
    writeFileSync(finalWritePath, "replacement\n");
    let finalWriteRejected = false;
    writeFileSync(finalWriteHook.releasePath, "release");
    try {
      await finalWrite;
    } catch (error) {
      finalWriteRejected = /final observation|changed|evidence/i.test(String(error));
    }
    if (!finalWriteRejected || readFileSync(parkedFinalWrite, "utf8") !== "descriptor-owned\n" || readFileSync(finalWritePath, "utf8") !== "replacement\n") {
      throw new Error("final write observation accepted a replacement leaf");
    }
    log("PASS bound write ties final evidence to its open descriptor");

    const finalCopySourceRoot = join(canonicalRoot, "final-copy-source");
    const finalCopyDestinationRoot = join(canonicalRoot, "final-copy-destination");
    mkdirSync(finalCopySourceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(finalCopyDestinationRoot, { recursive: true, mode: 0o700 });
    const finalCopySource = join(finalCopySourceRoot, "before.txt");
    const finalCopyDestination = join(finalCopyDestinationRoot, "before.txt");
    writeFileSync(finalCopySource, "copy-owned\n");
    const finalCopyHook = hookPaths(canonicalRoot, "final-copy-observe");
    const finalCopy = boundPromotionCopyFile({
      sourceRoot: finalCopySourceRoot,
      sourceRootIdentity: identity(finalCopySourceRoot),
      sourceComponents: ["before.txt"],
      sourceParentIdentity: identity(finalCopySourceRoot),
      expectedSource: { identity: identity(finalCopySource), state: fileState(finalCopySource) },
      destinationRoot: finalCopyDestinationRoot,
      destinationRootIdentity: identity(finalCopyDestinationRoot),
      destinationComponents: ["before.txt"],
      destinationParentIdentity: identity(finalCopyDestinationRoot),
      testHook: { stage: "promotion-copy-final-observe", ...finalCopyHook },
    });
    await waitForPath(finalCopyHook.readyPath);
    const parkedFinalCopy = join(finalCopyDestinationRoot, "before-held.txt");
    renameSync(finalCopyDestination, parkedFinalCopy);
    writeFileSync(finalCopyDestination, "copy-replacement\n");
    let finalCopyRejected = false;
    writeFileSync(finalCopyHook.releasePath, "release");
    try {
      await finalCopy;
    } catch (error) {
      finalCopyRejected = /final observation|changed|evidence/i.test(String(error));
    }
    if (!finalCopyRejected || readFileSync(parkedFinalCopy, "utf8") !== "copy-owned\n" || readFileSync(finalCopyDestination, "utf8") !== "copy-replacement\n") {
      throw new Error("final copy observation accepted a replacement leaf");
    }
    log("PASS bound copy ties final evidence to its open descriptor");

    const finalSymlinkRoot = join(canonicalRoot, "final-symlink-root");
    mkdirSync(finalSymlinkRoot, { recursive: true, mode: 0o700 });
    const finalSymlinkPath = join(finalSymlinkRoot, "link");
    const finalSymlinkHook = hookPaths(canonicalRoot, "final-symlink-observe");
    const finalSymlink = boundPromotionCreateSymlink({
      root: finalSymlinkRoot,
      rootIdentity: identity(finalSymlinkRoot),
      components: ["link"],
      parentIdentity: identity(finalSymlinkRoot),
      target: "owned-target",
      testHook: { stage: "promotion-symlink-final-observe", ...finalSymlinkHook },
    });
    await waitForPath(finalSymlinkHook.readyPath);
    const parkedFinalSymlink = join(finalSymlinkRoot, "link-held");
    renameSync(finalSymlinkPath, parkedFinalSymlink);
    symlinkSync("replacement-target", finalSymlinkPath);
    let finalSymlinkRejected = false;
    writeFileSync(finalSymlinkHook.releasePath, "release");
    try {
      await finalSymlink;
    } catch (error) {
      finalSymlinkRejected = /final observation|changed|evidence/i.test(String(error));
    }
    if (!finalSymlinkRejected || readlinkSync(parkedFinalSymlink) !== "owned-target" || readlinkSync(finalSymlinkPath) !== "replacement-target") {
      throw new Error("final symlink observation accepted a replacement leaf");
    }
    log("PASS bound symlink ties final evidence to its created identity and target");

    const copySourceRoot = join(canonicalRoot, "copy-source-root");
    const copyDestinationRoot = join(canonicalRoot, "copy-destination-root");
    const copyOutside = join(canonicalRoot, "copy-outside");
    mkdirSync(copySourceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(copyDestinationRoot, { recursive: true, mode: 0o700 });
    mkdirSync(copyOutside, { recursive: true, mode: 0o700 });
    const copySource = join(copySourceRoot, "before.txt");
    writeFileSync(copySource, "before-image\n");
    const copyHook = hookPaths(canonicalRoot, "lifecycle-copy");
    const copy = boundPromotionCopyFile({
      sourceRoot: copySourceRoot,
      sourceRootIdentity: identity(copySourceRoot),
      sourceComponents: ["before.txt"],
      sourceParentIdentity: identity(copySourceRoot),
      expectedSource: { identity: identity(copySource), state: fileState(copySource) },
      destinationRoot: copyDestinationRoot,
      destinationRootIdentity: identity(copyDestinationRoot),
      destinationComponents: ["before.txt"],
      destinationParentIdentity: identity(copyDestinationRoot),
      testHook: { stage: "promotion-copy-roots-open", ...copyHook },
    });
    await waitForPath(copyHook.readyPath);
    const parkedCopyRoot = join(canonicalRoot, "copy-destination-root-parked");
    renameSync(copyDestinationRoot, parkedCopyRoot);
    symlinkSync(copyOutside, copyDestinationRoot, "dir");
    writeFileSync(copyHook.releasePath, "release");
    await copy;
    unlinkSync(copyDestinationRoot);
    renameSync(parkedCopyRoot, copyDestinationRoot);
    if (readFileSync(join(copyDestinationRoot, "before.txt"), "utf8") !== "before-image\n" || existsSync(join(copyOutside, "before.txt"))) throw new Error("bound before-image copy followed a swapped ancestor");
    log("PASS bound before-image copy stays on the pinned source/destination roots");

    const installSourceRoot = join(canonicalRoot, "install-source-root");
    const installDestinationRoot = join(canonicalRoot, "install-destination-root");
    const installOutside = join(canonicalRoot, "install-outside");
    const installBundle = join(installSourceRoot, "bundle");
    mkdirSync(installBundle, { recursive: true, mode: 0o700 });
    mkdirSync(installDestinationRoot, { recursive: true, mode: 0o700 });
    mkdirSync(installOutside, { recursive: true, mode: 0o700 });
    writeFileSync(join(installBundle, "session.jsonl"), "session\n");
    const installHook = hookPaths(canonicalRoot, "lifecycle-install-directory");
    const install = boundPromotionInstallDirectory({
      sourceRoot: installSourceRoot,
      sourceRootIdentity: identity(installSourceRoot),
      sourceComponents: ["bundle"],
      sourceParentIdentity: identity(installSourceRoot),
      expectedSource: { identity: identity(installBundle), mode: lstatSync(installBundle).mode & 0o777 },
      destinationRoot: installDestinationRoot,
      destinationRootIdentity: identity(installDestinationRoot),
      destinationComponents: ["bundle"],
      destinationParentIdentity: identity(installDestinationRoot),
      testHook: { stage: "promotion-install-directory-parents-open", ...installHook },
    });
    await waitForPath(installHook.readyPath);
    const parkedInstallRoot = join(canonicalRoot, "install-destination-root-parked");
    renameSync(installDestinationRoot, parkedInstallRoot);
    symlinkSync(installOutside, installDestinationRoot, "dir");
    writeFileSync(installHook.releasePath, "release");
    const installResult = await install;
    unlinkSync(installDestinationRoot);
    renameSync(parkedInstallRoot, installDestinationRoot);
    if (installResult.outcome !== "applied" || !existsSync(join(installDestinationRoot, "bundle", "session.jsonl")) || existsSync(join(installOutside, "bundle"))) throw new Error("bound session-directory install followed a swapped ancestor");
    log("PASS bound session-directory install stays on the pinned roots across an ancestor swap");

    const cleanupRoot = join(canonicalRoot, "cleanup-root");
    const cleanupOutside = join(canonicalRoot, "cleanup-outside");
    const cleanupOperation = join(cleanupRoot, "operation");
    mkdirSync(cleanupOperation, { recursive: true, mode: 0o700 });
    mkdirSync(cleanupOutside, { recursive: true, mode: 0o700 });
    writeFileSync(join(cleanupOperation, "journal.json"), "cleanup\n");
    writeFileSync(join(cleanupOutside, "journal.json"), "outside\n");
    const cleanupHook = hookPaths(canonicalRoot, "lifecycle-cleanup");
    const cleanup = boundPromotionRemoveTree({
      root: cleanupRoot,
      rootIdentity: identity(cleanupRoot),
      components: ["operation"],
      parentIdentity: identity(cleanupRoot),
      expectedIdentity: identity(cleanupOperation),
      testHook: { stage: "promotion-cleanup-root-open", ...cleanupHook },
    });
    await waitForPath(cleanupHook.readyPath);
    const parkedCleanupRoot = join(canonicalRoot, "cleanup-root-parked");
    renameSync(cleanupRoot, parkedCleanupRoot);
    symlinkSync(cleanupOutside, cleanupRoot, "dir");
    writeFileSync(cleanupHook.releasePath, "release");
    let cleanupAncestorRejected = false;
    try {
      await cleanup;
    } catch (error) {
      cleanupAncestorRejected = /directory|changed|symlink|evidence/i.test(String(error));
    }
    unlinkSync(cleanupRoot);
    renameSync(parkedCleanupRoot, cleanupRoot);
    if (!cleanupAncestorRejected || !existsSync(cleanupOperation) || readFileSync(join(cleanupOutside, "journal.json"), "utf8") !== "outside\n") throw new Error("bound cleanup followed a swapped ancestor");
    log("PASS bound journal cleanup fails closed across an ancestor symlink swap");

    const cleanupFileRoot = join(canonicalRoot, "cleanup-file-aba-root");
    const cleanupFileOperation = join(cleanupFileRoot, "operation");
    const cleanupFile = join(cleanupFileOperation, "leaf.txt");
    mkdirSync(cleanupFileOperation, { recursive: true, mode: 0o700 });
    writeFileSync(cleanupFile, "original-cleanup\n");
    const cleanupFileHook = hookPaths(canonicalRoot, "cleanup-file-aba");
    const cleanupFileRun = boundPromotionRemoveTree({
      root: cleanupFileRoot,
      rootIdentity: identity(cleanupFileRoot),
      components: ["operation"],
      parentIdentity: identity(cleanupFileRoot),
      expectedIdentity: identity(cleanupFileOperation),
      testHook: { stage: "promotion-cleanup-leaf-validated", ...cleanupFileHook },
    });
    await waitForPath(cleanupFileHook.readyPath);
    if (!existsSync(cleanupFile)) throw new Error("cleanup file disappeared before ABA swap");
    const parkedCleanupFile = join(cleanupFileOperation, "leaf-held.txt");
    renameSync(cleanupFile, parkedCleanupFile);
    writeFileSync(cleanupFile, "replacement-cleanup\n");
    writeFileSync(cleanupFileHook.releasePath, "release");
    let cleanupFileRejected = false;
    try {
      await cleanupFileRun;
    } catch (error) {
      cleanupFileRejected = /changed|evidence|cleanup/i.test(String(error));
    }
    if (!cleanupFileRejected || readFileSync(cleanupFile, "utf8") !== "replacement-cleanup\n" || readFileSync(parkedCleanupFile, "utf8") !== "original-cleanup\n" || !existsSync(cleanupFileOperation)) {
      throw new Error("cleanup deleted a replacement file leaf");
    }
    log("PASS cleanup retains both sides of a file-leaf ABA replacement");

    const cleanupDirectoryRoot = join(canonicalRoot, "cleanup-directory-aba-root");
    const cleanupDirectoryOperation = join(cleanupDirectoryRoot, "operation");
    const cleanupDirectory = join(cleanupDirectoryOperation, "nested");
    mkdirSync(cleanupDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(cleanupDirectory, "original.txt"), "original-directory\n");
    const cleanupDirectoryHook = hookPaths(canonicalRoot, "cleanup-directory-aba");
    const cleanupDirectoryRun = boundPromotionRemoveTree({
      root: cleanupDirectoryRoot,
      rootIdentity: identity(cleanupDirectoryRoot),
      components: ["operation"],
      parentIdentity: identity(cleanupDirectoryRoot),
      expectedIdentity: identity(cleanupDirectoryOperation),
      testHook: { stage: "promotion-cleanup-leaf-validated", ...cleanupDirectoryHook },
    });
    await waitForPath(cleanupDirectoryHook.readyPath);
    const parkedCleanupDirectory = join(cleanupDirectoryOperation, "nested-held");
    renameSync(cleanupDirectory, parkedCleanupDirectory);
    mkdirSync(cleanupDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(cleanupDirectory, "replacement.txt"), "replacement-directory\n");
    writeFileSync(cleanupDirectoryHook.releasePath, "release");
    let cleanupDirectoryRejected = false;
    try {
      await cleanupDirectoryRun;
    } catch (error) {
      cleanupDirectoryRejected = /changed|evidence|cleanup/i.test(String(error));
    }
    if (!cleanupDirectoryRejected || !existsSync(cleanupDirectory) || !existsSync(parkedCleanupDirectory) || readFileSync(join(cleanupDirectory, "replacement.txt"), "utf8") !== "replacement-directory\n" || readFileSync(join(parkedCleanupDirectory, "original.txt"), "utf8") !== "original-directory\n") {
      throw new Error("cleanup deleted a replacement directory leaf");
    }
    log("PASS cleanup retains both sides of a directory-leaf ABA replacement");

    const cleanupRootAbaRoot = join(canonicalRoot, "cleanup-root-aba-root");
    const cleanupRootAbaOperation = join(cleanupRootAbaRoot, "operation");
    mkdirSync(cleanupRootAbaOperation, { recursive: true, mode: 0o700 });
    const cleanupRootAbaHook = hookPaths(canonicalRoot, "cleanup-root-aba");
    const cleanupRootAbaRun = boundPromotionRemoveTree({
      root: cleanupRootAbaRoot,
      rootIdentity: identity(cleanupRootAbaRoot),
      components: ["operation"],
      parentIdentity: identity(cleanupRootAbaRoot),
      expectedIdentity: identity(cleanupRootAbaOperation),
      testHook: { stage: "promotion-cleanup-root-validated", ...cleanupRootAbaHook },
    });
    await waitForPath(cleanupRootAbaHook.readyPath);
    const parkedCleanupRootAba = join(cleanupRootAbaRoot, "operation-held");
    renameSync(cleanupRootAbaOperation, parkedCleanupRootAba);
    mkdirSync(cleanupRootAbaOperation, { recursive: true, mode: 0o700 });
    writeFileSync(join(cleanupRootAbaOperation, "replacement.txt"), "replacement-root\n");
    writeFileSync(cleanupRootAbaHook.releasePath, "release");
    let cleanupRootAbaRejected = false;
    try {
      await cleanupRootAbaRun;
    } catch (error) {
      cleanupRootAbaRejected = /changed|evidence|cleanup/i.test(String(error));
    }
    if (!cleanupRootAbaRejected || !existsSync(cleanupRootAbaOperation) || !existsSync(parkedCleanupRootAba) || readFileSync(join(cleanupRootAbaOperation, "replacement.txt"), "utf8") !== "replacement-root\n") {
      throw new Error("cleanup deleted a replacement operation root");
    }
    log("PASS cleanup retains both sides of an operation-root ABA replacement");

    const cleanupFinalRoot = join(canonicalRoot, "cleanup-final-stat-root");
    const cleanupFinalOperation = join(cleanupFinalRoot, "operation");
    mkdirSync(cleanupFinalOperation, { recursive: true, mode: 0o700 });
    writeFileSync(join(cleanupFinalOperation, "evidence.txt"), "final-stat-original\n");
    const cleanupFinalHook = hookPaths(canonicalRoot, "cleanup-final-stat");
    const cleanupFinalRun = boundPromotionRemoveTree({
      root: cleanupFinalRoot,
      rootIdentity: identity(cleanupFinalRoot),
      components: ["operation"],
      parentIdentity: identity(cleanupFinalRoot),
      expectedIdentity: identity(cleanupFinalOperation),
      testHook: { stage: "promotion-cleanup-quarantine-final-stat", ...cleanupFinalHook },
    });
    await waitForPath(cleanupFinalHook.readyPath);
    const quarantineParent = dirname(cleanupFinalRoot);
    const quarantineRoot = readdirSync(quarantineParent)
      .filter((name) => name.startsWith(".termina-promotion-quarantine-"))
      .map((name) => join(quarantineParent, name))
      .find((candidate) => {
        try {
          return readdirSync(candidate).some((name) => existsSync(join(candidate, name, "evidence.txt")));
        } catch {
          return false;
        }
      });
    if (!quarantineRoot) throw new Error("native cleanup did not expose its durable quarantine root");
    const quarantinedName = readdirSync(quarantineRoot).find((name) => name.startsWith(".termina-promotion-cleanup-root-"));
    if (!quarantinedName) throw new Error("native cleanup did not retain the quarantined operation");
    const quarantinedPath = join(quarantineRoot, quarantinedName);
    const heldQuarantine = `${quarantinedPath}-held`;
    renameSync(quarantinedPath, heldQuarantine);
    mkdirSync(quarantinedPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(quarantinedPath, "replacement.txt"), "final-stat-replacement\n");
    writeFileSync(cleanupFinalHook.releasePath, "release");
    let cleanupFinalRejected = false;
    try {
      await cleanupFinalRun;
    } catch (error) {
      cleanupFinalRejected = /changed|evidence|cleanup/i.test(String(error));
    }
    if (!cleanupFinalRejected || !existsSync(heldQuarantine) || readFileSync(join(quarantinedPath, "replacement.txt"), "utf8") !== "final-stat-replacement\n") {
      throw new Error("cleanup deleted a replacement at its final quarantine name");
    }
    log("PASS cleanup retains the original and replacement across final-quarantine ABA");

    // The incoming tree itself consumes the same durable entry budget as
    // retained evidence. A dense tree must be rejected before its root can
    // be renamed into quarantine, even when the existing aggregate is empty.
    const denseParent = join(canonicalRoot, "quarantine-dense-parent");
    const denseIncoming = join(denseParent, "incoming");
    mkdirSync(denseIncoming, { recursive: true, mode: 0o700 });
    for (let index = 0; index <= 250_000; index += 1) {
      symlinkSync("dense-target", join(denseIncoming, `entry-${index.toString().padStart(6, "0")}`));
    }
    const denseResult = await freshCoreRequest(coreBinary, {
      op: "promotion-bound-remove-tree",
      root: denseParent,
      rootIdentity: identity(denseParent),
      components: ["incoming"],
      parentIdentity: identity(denseParent),
      expectedIdentity: identity(denseIncoming),
    });
    if (denseResult.ok !== false || !/entry|bound|quarantine/i.test(String(denseResult.error)) || !existsSync(denseIncoming)) {
      throw new Error("dense incoming cleanup tree exceeded the entry cap or was moved");
    }
    log("PASS dense incoming cleanup tree is rejected before quarantine admission");

    // Recovery/cleanup, copy, and quarantine all reject a deep adversarial
    // tree before their bounded descriptor stack can grow beyond the native
    // depth envelope. Each probe leaves its source/evidence in place so a
    // failed admission remains recoverable rather than partially discarded.
    const deepCleanupParent = join(canonicalRoot, "quarantine-deep-cleanup-parent");
    const deepCleanupIncoming = join(deepCleanupParent, "incoming");
    const deepCleanupLeafParent = makeNestedDirectory(deepCleanupIncoming, 70);
    writeFileSync(join(deepCleanupLeafParent, "evidence.txt"), "deep-cleanup\n");
    const deepCleanupResult = await freshCoreRequest(coreBinary, {
      op: "promotion-bound-remove-tree",
      root: deepCleanupParent,
      rootIdentity: identity(deepCleanupParent),
      components: ["incoming"],
      parentIdentity: identity(deepCleanupParent),
      expectedIdentity: identity(deepCleanupIncoming),
    });
    if (deepCleanupResult.ok !== false || !/depth|bound/i.test(String(deepCleanupResult.error)) || !existsSync(deepCleanupIncoming)) {
      throw new Error("deep incoming cleanup tree was not rejected with bounded traversal");
    }
    log("PASS deep incoming cleanup traversal is iterative and depth-bounded");

    const deepCopySource = join(canonicalRoot, "deep-copy-source");
    const deepCopyDestination = join(canonicalRoot, "deep-copy-destination");
    const deepCopyLeafParent = makeNestedDirectory(deepCopySource, 70);
    mkdirSync(deepCopyDestination, { recursive: true, mode: 0o700 });
    writeFileSync(join(deepCopyLeafParent, "evidence.txt"), "deep-copy\n");
    const deepCopyResult = await freshCoreRequest(coreBinary, {
      op: "promotion-bound-copy-tree",
      sourceRoot: deepCopySource,
      sourceRootIdentity: identity(deepCopySource),
      destinationRoot: deepCopyDestination,
      destinationRootIdentity: identity(deepCopyDestination),
    });
    if (deepCopyResult.ok !== false || !/depth|bound/i.test(String(deepCopyResult.error)) || !existsSync(join(deepCopyLeafParent, "evidence.txt"))) {
      throw new Error("deep promotion copy was not rejected with bounded traversal");
    }
    log("PASS deep promotion copy traversal is iterative and depth-bounded");

    // Symlink targets are logical payload bytes and must consume the same
    // aggregate copy budget as regular-file content. The result should report
    // both payloads while still counting every directory entry.
    const symlinkCopySource = join(canonicalRoot, "symlink-copy-source");
    const symlinkCopyDestination = join(canonicalRoot, "symlink-copy-destination");
    mkdirSync(symlinkCopySource, { recursive: true, mode: 0o700 });
    mkdirSync(symlinkCopyDestination, { recursive: true, mode: 0o700 });
    const symlinkCopyFile = join(symlinkCopySource, "payload.txt");
    const symlinkCopyLink = join(symlinkCopySource, "payload-link");
    const symlinkCopyPayload = "payload-bytes\n";
    const symlinkCopyTarget = "payload-target";
    writeFileSync(symlinkCopyFile, symlinkCopyPayload);
    symlinkSync(symlinkCopyTarget, symlinkCopyLink);
    const symlinkCopyResult = await boundPromotionCopyTree({
      sourceRoot: symlinkCopySource,
      sourceRootIdentity: identity(symlinkCopySource),
      destinationRoot: symlinkCopyDestination,
      destinationRootIdentity: identity(symlinkCopyDestination),
    });
    if (symlinkCopyResult.entries !== 2 || symlinkCopyResult.bytes !== Buffer.byteLength(symlinkCopyPayload) + Buffer.byteLength(symlinkCopyTarget) || readlinkSync(join(symlinkCopyDestination, "payload-link")) !== symlinkCopyTarget) {
      throw new Error(`symlink copy accounting omitted target bytes: ${JSON.stringify(symlinkCopyResult)}`);
    }
    log("PASS promotion copy accounts for symlink target bytes and entries");

    const aggregateWorkSource = join(canonicalRoot, "aggregate-work-source");
    const aggregateWorkDestination = join(canonicalRoot, "aggregate-work-destination");
    mkdirSync(aggregateWorkSource, { recursive: true, mode: 0o700 });
    mkdirSync(aggregateWorkDestination, { recursive: true, mode: 0o700 });
    writeFileSync(join(aggregateWorkSource, "work.txt"), "work\n");
    const aggregateWorkResult = await freshCoreRequest(coreBinary, {
      op: "promotion-bound-copy-tree",
      sourceRoot: aggregateWorkSource,
      sourceRootIdentity: identity(aggregateWorkSource),
      destinationRoot: aggregateWorkDestination,
      destinationRootIdentity: identity(aggregateWorkDestination),
      maxWorkBytes: 1,
    });
    if (aggregateWorkResult.ok !== false || !/work|bound|budget|entry|copy/i.test(String(aggregateWorkResult.error)) || existsSync(join(aggregateWorkDestination, "work.txt"))) {
      throw new Error("promotion copy ignored its aggregate work cap");
    }
    log("PASS promotion copy enforces an aggregate work cap before destination mutation");

    const deepQuarantineScope = join(canonicalRoot, "quarantine-deep-scope");
    const deepQuarantineParent = join(deepQuarantineScope, "operation-parent");
    const deepQuarantineIncoming = join(deepQuarantineParent, "incoming");
    const deepQuarantineContainer = join(deepQuarantineScope, ".termina-promotion-quarantine-deep");
    mkdirSync(deepQuarantineIncoming, { recursive: true, mode: 0o700 });
    const deepQuarantineLeafParent = makeNestedDirectory(deepQuarantineContainer, 70);
    writeFileSync(join(deepQuarantineLeafParent, "evidence.txt"), "deep-quarantine\n");
    const deepQuarantineResult = await freshCoreRequest(coreBinary, {
      op: "promotion-bound-remove-tree",
      root: deepQuarantineParent,
      rootIdentity: identity(deepQuarantineParent),
      components: ["incoming"],
      parentIdentity: identity(deepQuarantineParent),
      expectedIdentity: identity(deepQuarantineIncoming),
    });
    if (deepQuarantineResult.ok !== false || !/depth|bound|quarantine/i.test(String(deepQuarantineResult.error)) || !existsSync(deepQuarantineIncoming)) {
      throw new Error("deep quarantine scan was not rejected with bounded traversal");
    }
    log("PASS deep quarantine accounting is iterative and depth-bounded");

    // Two independent cores contend for the same aggregate admission. The
    // descriptor-bound grandparent flock reserves the current count and the
    // incoming root as one transaction, so exactly one empty root may consume
    // the final available entry and the other remains at its source path.
    const admissionParent = join(canonicalRoot, "quarantine-admission-parent");
    const admissionContainer = join(admissionParent, ".termina-promotion-quarantine-r5-seed");
    // Reuse the dense fixture rather than allocating a second quarter-million
    // entries. Remove exactly two links, leaving the final 249,999-entry
    // aggregate that makes one of the two incoming roots win deterministically.
    mkdirSync(admissionParent, { recursive: true, mode: 0o700 });
    renameSync(denseIncoming, admissionContainer);
    unlinkSync(join(admissionContainer, "entry-249999"));
    unlinkSync(join(admissionContainer, "entry-250000"));
    const admissionRootA = join(admissionParent, "operation-a-root");
    const admissionRootB = join(admissionParent, "operation-b-root");
    const admissionOperationA = join(admissionRootA, "operation");
    const admissionOperationB = join(admissionRootB, "operation");
    mkdirSync(admissionOperationA, { recursive: true, mode: 0o700 });
    mkdirSync(admissionOperationB, { recursive: true, mode: 0o700 });
    const admissionRequest = (rootPath: string, operationPath: string) => ({
      op: "promotion-bound-remove-tree",
      root: rootPath,
      rootIdentity: identity(rootPath),
      components: ["operation"],
      parentIdentity: identity(rootPath),
      expectedIdentity: identity(operationPath),
    });
    const [admissionA, admissionB] = await Promise.all([
      freshCoreRequest(coreBinary, admissionRequest(admissionRootA, admissionOperationA)),
      freshCoreRequest(coreBinary, admissionRequest(admissionRootB, admissionOperationB)),
    ]);
    const admissionSuccesses = [admissionA, admissionB].filter((result) => result.ok === true).length;
    if (admissionSuccesses !== 1 || existsSync(admissionOperationA) === existsSync(admissionOperationB) || readdirSync(admissionContainer).length !== 250_000) {
      throw new Error(`concurrent quarantine admission was not atomic: A=${JSON.stringify(admissionA)} B=${JSON.stringify(admissionB)}`);
    }
    log("PASS concurrent quarantine admissions reserve entries atomically and retain the losing source");

    const linked = join(canonicalRoot, "linked-operation");
    symlinkSync(operation, linked, "dir");
    let symlinkRejected = false;
    try {
      await readBoundPromotionJournal({
        journalRoot,
        journalRootIdentity: identity(journalRoot),
        operationName: "linked-operation",
        operationIdentity: identity(operation),
      });
    } catch (error) {
      symlinkRejected = /directory|symlink|identity|open/i.test(String(error));
    }
    if (!symlinkRejected) throw new Error("symlinked operation directory was accepted");
    log("PASS bound journal read rejects symlinked operation directories");
  } finally {
    const { rmSync } = await import("node:fs");
    for (const child of freshCoreChildren) child.kill();
    freshCoreChildren.clear();
    rmSync(root, { recursive: true, force: true });
    coreClient.dispose();
  }
}
