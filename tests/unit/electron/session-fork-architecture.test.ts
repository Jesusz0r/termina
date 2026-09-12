import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("SessionFork Architecture Contracts", () => {
  const root = process.cwd();
  const main = readFileSync(join(root, "electron", "main.ts"), "utf8");
  // The worldlines owner is a directory; read every module so the contracts
  // below cover the whole owner instead of one file.
  const worldlines = [...readdirSync(join(root, "electron", "worldlines"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => readFileSync(join(root, "electron", "worldlines", name), "utf8")),
    ...readdirSync(join(root, "electron", "worldlines", "promotion-recovery"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => readFileSync(join(root, "electron", "worldlines", "promotion-recovery", name), "utf8")),
  ].join("\n");
  // The Rust core is split into modules; read them all for the same reason.
  const core = readdirSync(join(root, "core", "src"))
    .filter((name) => name.endsWith(".rs"))
    .sort()
    .map((name) => readFileSync(join(root, "core", "src", name), "utf8"))
    .join("\n");
  const worker = readFileSync(join(root, "electron", "session-worker.ts"), "utf8");
  // The retention owner is a directory; read every module so the contracts
  // below cover the whole owner instead of one file.
  const retention = [join(root, "electron", "session-retention.ts"), ...readdirSync(join(root, "electron", "session-retention"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join(root, "electron", "session-retention", name))]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  // The session owner is a directory; read every module so the contracts
  // below cover the whole owner instead of one file.
  const session = [join(root, "agent-core", "session.ts"), ...readdirSync(join(root, "agent-core", "session"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join(root, "agent-core", "session", name))]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

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
    expect(/readPromptPayload\(opts: ReadPromptOpts\): Promise<ReadPromptResult>/.test(worldlines)).toBe(true);
    expect(/readPromptPayload:\s*\(opts\)\s*=>\s*this\.sessionFork\.readPrompt\(opts\)/.test(main)).toBe(true);
    expect(/discardCoreSession:\s*\(runId\)\s*=>\s*this\.sessionRetention\.discard\(runId\)/.test(main)).toBe(true);
    expect(/discardCoreSession\(runId: string\): Promise<\{ ok: boolean; error\?: string \}>/.test(worldlines)).toBe(true);
    expect(!/discardPiSession/.test(worldlines)).toBe(true);
    expect(!/sessionBranchIdentity/.test(worldlines) && !/sourceSessionIdentity/.test(worldlines)).toBe(true);
    expect(!/rm\(run\.sessionBranchFile/.test(worldlines)).toBe(true);
    expect(!/discardPi/.test(main)).toBe(true);
    expect(/boundPromotionRemoveTree/.test(worker) && !/\bremovePiSessionCopy\b/.test(worker)).toBe(true);
    expect(!/SessionManager/.test(worker) && !/copy-pi/.test(worker) && !/discard-pi/.test(worker) && !/forkPiSession/.test(worker)).toBe(true);
    expect(!/export async function removePiSessionCopy/.test(session)).toBe(true);
    expect(!/copyPiSessionFile|PiSessionCopy/.test(session)).toBe(true);
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
    expect(/ensureBoundRetainedRoot/.test(retention)).toBe(true);
    expect(/promotion directory request contains an unknown field/.test(core)).toBe(true);
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
