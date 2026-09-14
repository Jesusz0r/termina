import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, lstat, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKER, UNCERTAIN_COMPARISON_USAGE_LEDGER } from "../../../electron/worldlines/limits.ts";
import { ensureBoundDirectory } from "../../../electron/worldlines/promotion-recovery/bound-dirs.ts";
import {
  releaseUncertainComparisonAdmissionOwner,
  uncertainComparisonAdmissionOwnerFor,
} from "../../../electron/worldlines/uncertain-comparison.ts";

async function setupWorlds(): Promise<{ root: string; worldsRoot: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "termina-uncertain-admission-")));
  const worldsRoot = join(root, "worlds");
  await ensureBoundDirectory(worldsRoot, "worlds root");
  return { root, worldsRoot };
}

/** One retained (counted, measured) comparison tree. */
async function seedRetained(worldsRoot: string, name: string, fileCount: number): Promise<{ dir: string; victim: string }> {
  const dir = join(worldsRoot, name);
  await mkdir(join(dir, "sub"), { recursive: true });
  await writeFile(join(dir, MARKER), "owned\n");
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: name,
      sourceRunId: "run-1",
      createdAt: Date.now(),
      status: "uncertain",
      expectedCandidates: 1,
      candidates: { A: { pid: null, lstart: null, paths: [join(dir, "A")] } },
      uncertainSessionArtifacts: [{ path: join(dir, "staged"), error: "retained for test" }],
    }),
  );
  for (let i = 0; i < fileCount; i++) {
    await writeFile(join(dir, "sub", `f-${String(i).padStart(5, "0")}.bin`), Buffer.alloc(64, i % 251));
  }
  const victim = join(dir, "sub", "victim.txt");
  await writeFile(victim, "old-content-1234");
  return { dir, victim };
}

async function ledgerEntry(worldsRoot: string): Promise<{ counted: boolean; bytes: number; entries: number; proof: string }> {
  const ledger = JSON.parse(await readFile(join(worldsRoot, UNCERTAIN_COMPARISON_USAGE_LEDGER), "utf8")) as {
    entries: Array<{ counted: boolean; bytes: number; entries: number; proof: string }>;
  };
  return ledger.entries[0]!;
}

async function topIdentity(dir: string): Promise<{ dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string }> {
  const info = await lstat(dir, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
}

describe("uncertain admission measurement (issue #192)", () => {
  it("detects a content-only write that leaves the top identity untouched", async () => {
    const { root, worldsRoot } = await setupWorlds();
    try {
      const { dir, victim } = await seedRetained(worldsRoot, "retained-1", 8);
      const binding = await ensureBoundDirectory(worldsRoot, "worlds root");
      const owner = uncertainComparisonAdmissionOwnerFor(binding);
      try {
        const first = await owner.acquire(() => false);
        expect(first.ok).toBe(true);
        if (first.ok) first.lease.release();
        await owner.drain();
        const before = await ledgerEntry(worldsRoot);
        expect(before.counted).toBe(true);
        const topBefore = await topIdentity(dir);

        // Same-size content rewrite: no ancestor directory time moves.
        await writeFile(victim, "new-content-5678");
        const topAfter = await topIdentity(dir);
        expect(topAfter).toEqual(topBefore);

        const second = await owner.acquire(() => false);
        expect(second.ok).toBe(true);
        if (second.ok) second.lease.release();
        await owner.drain();
        const after = await ledgerEntry(worldsRoot);
        expect(after.counted).toBe(true);
        expect(after.bytes).toBe(before.bytes);
        expect(after.entries).toBe(before.entries);
        // Only a full re-measure can see this change: the proof must move.
        expect(after.proof).not.toBe(before.proof);
      } finally {
        releaseUncertainComparisonAdmissionOwner(owner);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts a measurement promptly when closing, without persisting a reservation", async () => {
    const { root, worldsRoot } = await setupWorlds();
    try {
      await seedRetained(worldsRoot, "retained-2", 2000);
      const binding = await ensureBoundDirectory(worldsRoot, "worlds root");
      const owner = uncertainComparisonAdmissionOwnerFor(binding);
      try {
        let calls = 0;
        const result = await owner.acquire(() => ++calls > 4);
        expect(result).toEqual({ ok: false, error: "worldline manager disposed" });
        const names = await readdir(worldsRoot);
        expect(names).not.toContain(UNCERTAIN_COMPARISON_USAGE_LEDGER);
        // The owner is not wedged: a later admission succeeds.
        const retry = await owner.acquire(() => false);
        expect(retry.ok).toBe(true);
        if (retry.ok) retry.lease.release();
        await owner.drain();
        const entry = await ledgerEntry(worldsRoot);
        expect(entry.counted).toBe(true);
      } finally {
        releaseUncertainComparisonAdmissionOwner(owner);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
