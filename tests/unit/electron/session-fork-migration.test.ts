import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("SessionFork Architecture & Migration Boundary Contracts", () => {
  const root = process.cwd();
  const main = readFileSync(join(root, "electron", "main.ts"), "utf8");
  const worldlines = readFileSync(join(root, "electron", "worldlines.ts"), "utf8");
  const worker = readFileSync(join(root, "electron", "session-worker.ts"), "utf8");
  const retention = readFileSync(join(root, "electron", "session-retention.ts"), "utf8");
  const session = readFileSync(join(root, "agent-core", "session.ts"), "utf8");

  function methodBody(source: string, signature: string, nextSignature?: string) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`missing method ${signature}`);
    const end = nextSignature ? source.indexOf(nextSignature, start + signature.length) : source.length;
    return source.slice(start, end < 0 ? source.length : end);
  }

  it("ensures session worker remains the sole production owner call for core session forks", () => {
    expect(/import[\s\S]{0,500}\bwriteForkedSession\b/.test(main)).toBe(false);
    expect(/import[\s\S]{0,800}\bwriteForkedSession\b/.test(worldlines)).toBe(false);
    expect(/\bwriteForkedSession\b/.test(worker)).toBe(true);
    expect(!/\bwriteForkedSession\b/.test(main) && !/\bwriteForkedSession\b/.test(worldlines)).toBe(true);
  });

  it("wires WorldlineDeps through shared SessionForkClient and session retention", () => {
    expect(/forkCoreSession\(opts: CoreSessionForkOpts, callOptions\?: SessionForkCallOptions\): Promise<CoreSessionForkResult>/.test(worldlines)).toBe(true);
    expect(/forkCoreSession:\s*\(opts,\s*callOptions\)\s*=>\s*this\.sessionFork\.forkCore\(opts,\s*callOptions\)/.test(main)).toBe(true);
    expect(/discardCoreSession:\s*\(runId\)\s*=>\s*this\.sessionRetention\.discard\(runId\)/.test(main)).toBe(true);
    expect(/discardCoreSession\(runId: string\): Promise<\{ ok: boolean; error\?: string \}>/.test(worldlines)).toBe(true);
    expect(/discardPiSession\(sessionFile: string, identity: PiSessionCopyIdentity\)/.test(worldlines)).toBe(true);
    expect(/sessionBranchIdentity/.test(worldlines) && /sourceSessionIdentity/.test(worldlines)).toBe(true);
    expect(!/rm\(run\.sessionBranchFile/.test(worldlines)).toBe(true);
    expect(/discardPiSession:\s*\(sessionFile, identity\)\s*=>\s*this\.sessionFork\.discardPi/.test(main)).toBe(true);
    expect(/boundPromotionRemoveTree/.test(worker) && !/\bremovePiSessionCopy\b/.test(worker)).toBe(true);
    expect(!/export async function removePiSessionCopy/.test(session)).toBe(true);
    expect(/discardEmptyCoreSession/.test(main) && /inspectEmptySessionBundle/.test(worker) && /boundPromotionRemoveTree/.test(worker)).toBe(true);
    expect(/MAX_RETAINED_EMPTY_SESSION_BUNDLES/.test(session) && /admitNewEmptySessionBundle/.test(session)).toBe(true);
    expect(!/\bremoveSessionBundle\b/.test(worldlines)).toBe(true);
    expect(!/export async function removeSessionBundle/.test(session)).toBe(true);
  });

  it("routes core forks and retained session transactions in finalizeRun", () => {
    const finalize = methodBody(main, "private async finalizeRun(", "  /** The descendant pids");
    expect(/this\.sessionFork\.forkCore\(/.test(finalize)).toBe(true);
    expect(/commit\s+uncertain|commit:\s*["']uncertain["']|\.commit\s*===\s*["']uncertain["']/.test(finalize)).toBe(true);
    expect(/uncertainSessionFile/.test(finalize)).toBe(true);
    expect(/this\.sessionRetention\.transact\(run\.id/.test(finalize)).toBe(true);
    expect(/MAX_RETAINED_SESSION_BUNDLES/.test(retention) && /MAX_RETAINED_SESSION_BYTES/.test(retention)).toBe(true);
    expect(/RETAINED_SESSION_ADMISSION_LOCK/.test(retention) && /queueTail/.test(retention)).toBe(true);
    expect(/ensureBoundRetainedRoot/.test(retention) && /bootstrapExisting:\s*true/.test(worldlines)).toBe(true);
    expect(/retainedSessionRoot/.test(main) && !/rmSync\(this\.retainedSessionRoot/.test(main)).toBe(true);
  });

  it("handles uncertain commits explicitly across challenge, forkRun, and promotion", () => {
    const challenge = methodBody(worldlines, "async challengeFromCandidate(", "  /** The ignored/generated writes");
    expect(/forkCoreSession\(/.test(challenge)).toBe(true);
    expect(/!fork[AB]?\.ok/.test(challenge) && /recordUncertainSession/.test(challenge)).toBe(true);
    expect(/recordUncertainSession/.test(challenge)).toBe(true);

    const forkCoreSessions = methodBody(worldlines, "private async forkCoreSessions(", "  private async safePromptPayloadPath");
    expect(/forkCoreSession\(/.test(forkCoreSessions)).toBe(true);
    expect(!/Promise\.all\s*\(/.test(forkCoreSessions)).toBe(true);
    expect(/!fork[AB]?\.ok/.test(forkCoreSessions) && /recordUncertainSession/.test(forkCoreSessions)).toBe(true);

    const promotion = methodBody(worldlines, "private async promoteUnderTransaction(", "  // ------------------------------------------------------- fork any moment");
    expect(/forkCoreSession\(/.test(promotion)).toBe(true);
    expect((promotion.match(/commit\s+uncertain|commit:\s*["']uncertain["']|\.commit\s*===\s*["']uncertain["']/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(/journal\.stagedSession/.test(promotion) && /journal\.installedSession/.test(promotion)).toBe(true);
  });

  it("descriptor-bounds comparison cleanup and fails closed on unproven state", () => {
    const teardown = methodBody(worldlines, "private async teardown(", "  /** Remove a worlds dir");
    expect(/uncertainSessionArtifacts/.test(teardown)).toBe(true);
    expect(/removeUncertain/.test(teardown)).toBe(true);
    expect(/cancelSessionForks\(comparisonId\)/.test(teardown) && /teardownPromise/.test(teardown)).toBe(true);
    expect(/writeComparisonManifestBound/.test(worldlines)
      && /writeUncertainComparisonUsageLedger/.test(worldlines)
      && /boundPromotionWriteJsonFile/.test(worldlines)
      && /persist:\s*false/.test(worldlines)).toBe(true);
    expect(/loadUncertainComparisonUsageLedger/.test(worldlines)
      && /unreadable|corrupt|malformed/.test(worldlines)
      && /throw new Error/.test(worldlines)).toBe(true);
    expect(/manifest\s*!==\s*null|if\s*\(!manifest\)/.test(worldlines) && /unproven comparison manifest retained/.test(worldlines)).toBe(true);
    expect(/uncertainAdmissionOwner/.test(worldlines) && /acquireUncertainComparisonAdmission/.test(worldlines) && /acquireSessionRetentionLock/.test(worldlines)).toBe(true);
    expect(/marker|orphan/i.test(worldlines) && /measureUncertainComparisonTree/.test(worldlines)).toBe(true);

    const removeOwnedDir = methodBody(worldlines, "private async removeOwnedDir(", "  /** Rehydrate retained uncertain evidence");
    expect(/boundPromotionRemoveTree/.test(removeOwnedDir)
      && /expectedIdentity/.test(removeOwnedDir)
      && /parentIdentity/.test(removeOwnedDir)
      && /Promise<boolean>/.test(removeOwnedDir)
      && !/rm\s*\([^)]*recursive/.test(removeOwnedDir)).toBe(true);
  });
});
