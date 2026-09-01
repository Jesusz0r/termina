/**
 * Static contract coverage for the production SessionForkClient migration.
 * Run with: node scripts/session-fork-migration-test.mjs
 *
 * This is intentionally source-level: the production callers are private
 * Electron lifecycle code, while the worker/session owner has separate runtime
 * tests. The assertions pin the ownership boundary and every uncertainty path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const main = readFileSync(join(root, "electron", "main.ts"), "utf8");
const worldlines = readFileSync(join(root, "electron", "worldlines.ts"), "utf8");
const worker = readFileSync(join(root, "electron", "session-worker.ts"), "utf8");
const retention = readFileSync(join(root, "electron", "session-retention.ts"), "utf8");
const session = readFileSync(join(root, "agent-core", "session.ts"), "utf8");

function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

function methodBody(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing method ${signature}`);
  const end = nextSignature ? source.indexOf(nextSignature, start + signature.length) : source.length;
  return source.slice(start, end < 0 ? source.length : end);
}

check(!/import[\s\S]{0,500}\bwriteForkedSession\b/.test(main), "main does not import the core session owner");
check(!/import[\s\S]{0,800}\bwriteForkedSession\b/.test(worldlines), "worldlines does not import the core session owner");
check(/\bwriteForkedSession\b/.test(worker), "session worker remains the sole production owner call");
check(!/\bwriteForkedSession\b/.test(main) && !/\bwriteForkedSession\b/.test(worldlines), "all eight production direct owner calls are removed outside the worker");

check(/forkCoreSession\(opts: CoreSessionForkOpts, callOptions\?: SessionForkCallOptions\): Promise<CoreSessionForkResult>/.test(worldlines), "WorldlineDeps exposes one cancellable core fork callback");
check(/forkCoreSession:\s*\(opts,\s*callOptions\)\s*=>\s*this\.sessionFork\.forkCore\(opts,\s*callOptions\)/.test(main), "main wires the shared SessionForkClient into WorldlineDeps");
check(/discardCoreSession:\s*\(runId\)\s*=>\s*this\.sessionRetention\.discard\(runId\)/.test(main), "main wires proven core-bundle discard through the canonical retention owner");
check(/discardCoreSession\(runId: string\): Promise<\{ ok: boolean; error\?: string \}>/.test(worldlines), "WorldlineDeps exposes canonical proven-bundle discard");
check(/discardPiSession\(sessionFile: string, identity: PiSessionCopyIdentity\)/.test(worldlines), "WorldlineDeps exposes identity-bound Pi branch discard");
check(/sessionBranchIdentity/.test(worldlines) && /sourceSessionIdentity/.test(worldlines), "Pi branch identity is carried through run replay");
check(!/rm\(run\.sessionBranchFile/.test(worldlines), "run discard has no pathname Pi branch removal fallback");
check(/discardPiSession:\s*\(sessionFile, identity\)\s*=>\s*this\.sessionFork\.discardPi/.test(main), "main wires Pi branch discard through SessionForkClient");
check(/discardEmptyCoreSession/.test(main) && /inspectEmptySessionBundle/.test(worker) && /boundPromotionRemoveTree/.test(worker), "empty core-session cleanup uses native bound proof and quarantine");
check(/MAX_RETAINED_EMPTY_SESSION_BUNDLES/.test(session) && /admitNewEmptySessionBundle/.test(session), "unbound empty core-session retention has bounded admission");
check(!/\bremoveSessionBundle\b/.test(worldlines), "worldlines has no parallel agent-core bundle removal path");
check(!/export async function removeSessionBundle/.test(session), "agent-core no longer exports the dead parallel bundle removal API");

const finalize = methodBody(main, "private async finalizeRun(", "  /** The descendant pids");
check(/this\.sessionFork\.forkCore\(/.test(finalize), "finalizeRun routes core forks through the client");
check(/commit\s+uncertain|commit:\s*["']uncertain["']|\.commit\s*===\s*["']uncertain["']/.test(finalize), "finalizeRun records uncertain commit explicitly");
check(/uncertainSessionFile/.test(finalize), "finalizeRun records the uncertain destination separately from a valid branch");
check(/this\.sessionRetention\.transact\(run\.id/.test(finalize), "core finalization uses the serialized retained-session transaction");
check(/MAX_RETAINED_SESSION_BUNDLES/.test(retention) && /MAX_RETAINED_SESSION_BYTES/.test(retention), "retained finalization evidence has bounded admission");
check(/RETAINED_SESSION_ADMISSION_LOCK/.test(retention) && /queueTail/.test(retention), "retained-session admission serializes across app and process boundaries");
check(/ensureBoundRetainedRoot/.test(retention) && /bootstrapExisting:\s*true/.test(worldlines), "retained root creation/adoption uses the native descriptor-bound bootstrap transaction");
check(/retainedSessionRoot/.test(main) && !/rmSync\(this\.retainedSessionRoot/.test(main), "launch scratch cleanup cannot remove the durable retained-session root");

const challenge = methodBody(worldlines, "async challengeFromCandidate(", "  /** The ignored/generated writes");
check(/forkCoreSession\(/.test(challenge), "challenge core forks use the dependency callback");
check(/!fork[AB]?\.ok/.test(challenge) && /recordUncertainSession/.test(challenge), "challenge records uncertain commit explicitly");
check(/recordUncertainSession/.test(challenge), "challenge records retained uncertain artifacts");

const forkCoreSessions = methodBody(worldlines, "private async forkCoreSessions(", "  private async safePromptPayloadPath");
check(/forkCoreSession\(/.test(forkCoreSessions), "fork-run pair uses the dependency callback");
check(!/Promise\.all\s*\(/.test(forkCoreSessions), "fork-run core pair cannot tear down while a queued sibling fork runs");
check(/!fork[AB]?\.ok/.test(forkCoreSessions) && /recordUncertainSession/.test(forkCoreSessions), "fork-run pair records uncertain commit explicitly");

const promotion = methodBody(worldlines, "private async promoteUnderTransaction(", "  // ------------------------------------------------------- fork any moment");
check(/forkCoreSession\(/.test(promotion), "promotion stage/install use the dependency callback");
check((promotion.match(/commit\s+uncertain|commit:\s*["']uncertain["']|\.commit\s*===\s*["']uncertain["']/g) ?? []).length >= 2, "promotion stage and install each handle uncertain commit");
check(/journal\.stagedSession/.test(promotion) && /journal\.installedSession/.test(promotion), "promotion retains both journal session anchors");

const forkPoint = methodBody(worldlines, "async forkPoint(", "  /** Launch one candidate");
check(/forkCoreSession\(/.test(forkPoint), "fork-point uses the dependency callback");
check(/!fork\.ok/.test(forkPoint) && /recordUncertainSession/.test(forkPoint), "fork-point records uncertain commit explicitly");
check(/recordUncertainSession/.test(forkPoint), "fork-point records retained uncertain artifacts");

const teardown = methodBody(worldlines, "private async teardown(", "  /** Remove a worlds dir");
check(/uncertainSessionArtifacts/.test(teardown), "comparison teardown knows about retained uncertain artifacts");
check(/removeUncertain/.test(teardown), "only explicit discard may remove retained uncertain comparison artifacts");
check(/cancelSessionForks\(comparisonId\)/.test(teardown) && /teardownPromise/.test(teardown), "comparison teardown cancels and drains its own fork queue before cleanup");
check(/writeComparisonManifestBound/.test(worldlines)
  && /writeUncertainComparisonUsageLedger/.test(worldlines)
  && /boundPromotionWriteJsonFile/.test(worldlines)
  && /persist:\s*false/.test(worldlines), "uncertain manifests and ledgers use the canonical native-bound writer");
check(/loadUncertainComparisonUsageLedger/.test(worldlines)
  && /unreadable|corrupt|malformed/.test(worldlines)
  && /throw new Error/.test(worldlines), "corrupt or unproven ledger state fails closed before uncertain admission");
check(/manifest\s*!==\s*null|if\s*\(!manifest\)/.test(worldlines) && /unproven comparison manifest retained/.test(worldlines), "stale sweep fails closed on unreadable or incomplete manifests");
check(/uncertainAdmissionOwner/.test(worldlines) && /acquireUncertainComparisonAdmission/.test(worldlines) && /acquireSessionRetentionLock/.test(worldlines), "uncertain comparison admission has one root-scoped serialized reservation owner");
check(/marker|orphan/i.test(worldlines) && /measureUncertainComparisonTree/.test(worldlines), "marked orphan comparison evidence remains in global count and byte accounting");
for (const method of [
  methodBody(worldlines, "async challengeFromCandidate(", "  /** The ignored/generated writes"),
  methodBody(worldlines, "async forkRun(", "  private createComparison"),
  methodBody(worldlines, "async forkPoint(", "  /** Launch one candidate"),
]) check(/acquireUncertainComparisonAdmission\(/.test(method), "each uncertain comparison creator acquires the shared reservation");
const removeOwnedDir = methodBody(worldlines, "private async removeOwnedDir(", "  /** Rehydrate retained uncertain evidence");
check(/boundPromotionRemoveTree/.test(removeOwnedDir) && /expectedIdentity/.test(removeOwnedDir) && /parentIdentity/.test(removeOwnedDir) && /Promise<boolean>/.test(removeOwnedDir) && !/rm\s*\([^)]*recursive/.test(removeOwnedDir), "comparison cleanup is descriptor-bound and retains entries when identity proof fails");

check(/await\s+this\.sessionFork\.dispose\(\)/.test(main), "app shutdown awaits session worker disposal");
check(main.indexOf("project.worldlines?.dispose()") < main.indexOf("await this.sessionFork.dispose()"), "app shutdown drains Pi run discards before disposing the session worker");
check(/drainSessionForks\(\)/.test(worldlines), "worldline manager exposes a session-fork drain boundary");
check(/worldlines\?\.drainSessionForks\(\)/.test(main), "project teardown drains worldline session forks before removing comparison dirs");

console.log("PASS SessionForkClient migration contract");
