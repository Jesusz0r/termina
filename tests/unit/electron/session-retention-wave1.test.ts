import { describe, it } from "vitest";
/**
 * Wave 1 session-retention regressions.
 *
 * Uses the actual bundled SessionRetentionOwner with the native core, like
 * session-retention-performance.test.ts. Run with TERMINA_CORE_TEST=1.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function writeBundle(path: string, records = 8) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "w", 0o600);
  try {
    for (let index = 1; index <= records; index++) {
      writeFileSync(fd, `${JSON.stringify({ storageSeq: index, type: "message", message: { role: "user", content: `record-${index}` } })}\n`);
    }
  } finally {
    closeSync(fd);
  }
}

async function loadRetentionBundle(work: string) {
  process.env.TERMINA_CORE_TEST = "1";
  const retentionBundle = join(work, "session-retention.mjs");
  await build({
    entryPoints: ["electron/session-retention.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: retentionBundle,
    logLevel: "silent",
  });
  return import(pathToFileURL(retentionBundle).href) as Promise<{
    SessionRetentionOwner: new (root: string) => {
      transact<T>(runId: string, publish: (destination: string) => Promise<T>): Promise<{ destinationSessionFile: string; result: T }>;
      list(): Promise<Array<{ runId: string; bytes: number | null }>>;
    };
    RETAINED_SESSION_USAGE_LEDGER: string;
    disposeSessionRetentionCoreClient: () => void;
  }>;
}

describe("Session Retention Wave 1 regressions", () => {
  it("rebuilds a ledger with corrupt nested destinations (refs #150)", async () => {
    const work = mkdtempSync(join(tmpdir(), "termina-retention-wave1-150-"));
    try {
      const { SessionRetentionOwner, RETAINED_SESSION_USAGE_LEDGER, disposeSessionRetentionCoreClient } = await loadRetentionBundle(work);
      try {
        const root = join(work, "retained");
        const owner = new SessionRetentionOwner(root);
        // An uncertain result leaves a durable claim: the ledger gains a
        // claim entry with a nested measured destination.
        await owner.transact("claim-run", async (destination: string) => {
          writeBundle(destination, 2);
          return { ok: false };
        });
        const ledgerPath = join(root, RETAINED_SESSION_USAGE_LEDGER);
        const pristine = JSON.parse(readFileSync(ledgerPath, "utf8"));
        const claimIndex = pristine.entries.findIndex((entry: { kind: string }) => entry.kind === "claim");
        assert.notEqual(claimIndex, -1, "uncertain transaction did not persist a claim entry");
        assert.equal(typeof pristine.entries[claimIndex].destination?.name, "string", "claim entry lacks a nested destination");

        // Valid control: the clean ledger lists its durable claim.
        const control = await owner.list();
        assert.equal(control.length, 1, "clean ledger did not list its claim");
        assert.equal(control[0]!.runId, "claim-run");

        // Valid JSON with corrupt nested destinations must rebuild from
        // measured evidence instead of throwing (null dereferences `.name`).
        for (const badDestination of [null, 42, [], "x"]) {
          const corrupt = JSON.parse(JSON.stringify(pristine));
          corrupt.entries[claimIndex].destination = badDestination;
          writeFileSync(ledgerPath, JSON.stringify(corrupt), { mode: 0o600 });
          const rebuilt = await owner.list();
          assert.equal(rebuilt.length, 1, `corrupt destination ${JSON.stringify(badDestination)} was not rebuilt`);
          assert.equal(rebuilt[0]!.runId, "claim-run");
          assert.ok((rebuilt[0]!.bytes ?? 0) > 0, "rebuilt claim was not remeasured from evidence");
          assert.equal(existsSync(join(root, "claim-run")), true, "rebuild erased the destination evidence");
          assert.equal(existsSync(join(root, ".termina-retained-claim-claim-run.json")), true, "rebuild erased the claim evidence");
        }

        // The root recovers to a clean on-disk ledger on the next admission.
        await owner.transact("after-corrupt", async (destination: string) => {
          writeBundle(destination, 1);
          return "ok";
        });
        const recovered = JSON.parse(readFileSync(ledgerPath, "utf8"));
        const recoveredClaim = recovered.entries.find((entry: { kind: string }) => entry.kind === "claim");
        assert.equal(recoveredClaim?.destination?.name, "claim-run", "recovered ledger destination was not remeasured");
        assert.ok(recoveredClaim.destination.usage.bytes > 0, "recovered destination usage was not remeasured");
      } finally {
        disposeSessionRetentionCoreClient();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60000);

  it("retries root binding after repair on the same owner (refs #151)", async () => {
    const work = mkdtempSync(join(tmpdir(), "termina-retention-wave1-151-"));
    try {
      const { SessionRetentionOwner, disposeSessionRetentionCoreClient } = await loadRetentionBundle(work);
      try {
        const rootPath = join(work, "poison-root");
        // A regular file where the root directory belongs: native binding
        // must reject it.
        writeFileSync(rootPath, "obstruction", { mode: 0o600 });
        const owner = new SessionRetentionOwner(rootPath);
        await assert.rejects(owner.list(), "obstructed root binding did not reject");

        // Repair only the fixture. The same owner must retry instead of
        // replaying its memoized rejection.
        rmSync(rootPath, { force: true });
        const repaired = await owner.list();
        assert.deepEqual(repaired, [], "repaired root did not list on the same owner");

        // Control: a fresh owner agrees the root is healthy.
        const fresh = await new SessionRetentionOwner(rootPath).list();
        assert.deepEqual(fresh, [], "fresh owner disagrees about the repaired root");

        // A substituted root at the same path must still fail closed: the
        // retry path never reinterprets unproven evidence as trusted. (A
        // plain rm+mkdir reuses the same inode; renaming a separately
        // created directory into place proves a true identity change.)
        const substitute = join(work, "substitute-root");
        mkdirSync(substitute, { recursive: true, mode: 0o700 });
        rmSync(rootPath, { recursive: true, force: true });
        renameSync(substitute, rootPath);
        await assert.rejects(owner.list(), "substituted root did not fail closed");
      } finally {
        disposeSessionRetentionCoreClient();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60000);
});
