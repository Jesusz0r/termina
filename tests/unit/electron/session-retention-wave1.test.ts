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
});
