import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, lstat, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

async function ledgerEntryNames(worldsRoot: string): Promise<string[]> {
  const ledger = JSON.parse(await readFile(join(worldsRoot, UNCERTAIN_COMPARISON_USAGE_LEDGER), "utf8")) as {
    entries: Array<{ name: string }>;
  };
  return ledger.entries.map((entry) => entry.name);
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

  it.each(["uncertain", "complete"] as const)("measures dependency and skill links without following targets in a %s retained area", async (status) => {
    const { root, worldsRoot } = await setupWorlds();
    try {
      const { dir } = await seedRetained(worldsRoot, "cmp-2", 1);
      if (status === "complete") {
        // A session from another project survives the sweep but is not in this
        // manager's safe set. A-support and profiles are deliberately absent.
        const manifestPath = join(dir, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        Object.assign(manifest, { sourceRunId: null, status: "complete", uncertainSessionArtifacts: [],
          session: { primaryRoot: join(root, "other-project"), baseStateId: "base", sourceGitDir: join(root, "other-project", ".git"), model: null, thinkingLevel: null } });
        await writeFile(manifestPath, JSON.stringify(manifest));
      }
      const bins = join(dir, "A", "node_modules", ".bin");
      const skills = join(dir, "template", ".agents", "skills");
      await mkdir(bins, { recursive: true });
      await mkdir(skills, { recursive: true });
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "untouched.txt"), "outside contents");
      const links = [join(bins, "tool"), join(skills, "linked-skill"), join(bins, "dangling"), join(skills, "cycle")];
      await symlink("../package/tool.js", links[0]!);
      await symlink(outside, links[1]!);
      await symlink("missing", links[2]!);
      await symlink(".", links[3]!);
      const owner = uncertainComparisonAdmissionOwnerFor(await ensureBoundDirectory(worldsRoot, "worlds root"));
      try {
        const first = await owner.acquire(() => false);
        expect(first.ok).toBe(true);
        if (first.ok) first.lease.release();
        await owner.drain();
        const before = await ledgerEntry(worldsRoot);
        expect(before.counted).toBe(true);
        // Adding huge content outside the area does not change its measured
        // size or proof: only the link itself is recovery evidence here.
        await writeFile(join(outside, "large.bin"), Buffer.alloc(1024 * 1024));
        const second = await owner.acquire(() => false);
        expect(second.ok).toBe(true);
        if (second.ok) second.lease.release();
        await owner.drain();
        expect(await ledgerEntry(worldsRoot)).toEqual(before);
        await rm(links[0]!);
        await symlink("../another/tool.js", links[0]!);
        const third = await owner.acquire(() => false);
        expect(third.ok).toBe(true);
        if (third.ok) third.lease.release();
        await owner.drain();
        expect((await ledgerEntry(worldsRoot)).proof).not.toBe(before.proof);
        expect(await readFile(join(outside, "untouched.txt"), "utf8")).toBe("outside contents");
        for (const link of links) expect((await lstat(link)).isSymbolicLink()).toBe(true);
      } finally { releaseUncertainComparisonAdmissionOwner(owner); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("still refuses a special entry without deleting retained evidence", async () => {
    const { root, worldsRoot } = await setupWorlds();
    try {
      const { dir, victim } = await seedRetained(worldsRoot, "cmp-special", 1);
      const pipe = join(dir, "sub", "pipe");
      execFileSync("mkfifo", [pipe]);
      const manifest = await readFile(join(dir, "manifest.json"), "utf8");
      const owner = uncertainComparisonAdmissionOwnerFor(await ensureBoundDirectory(worldsRoot, "worlds root"));
      try {
        const result = await owner.acquire(() => false);
        // Release before asserting so a regression cannot leak the admission lease.
        if (result.ok) result.lease.release();
        await owner.drain();
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining("unsupported entry") });
        expect((await lstat(pipe)).isFIFO()).toBe(true);
        expect(await readFile(victim, "utf8")).toBe("old-content-1234");
        expect(await readFile(join(dir, "manifest.json"), "utf8")).toBe(manifest);
      } finally { releaseUncertainComparisonAdmissionOwner(owner); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("orders ledger entries by code unit, never by locale (issue #193)", async () => {
    const { root, worldsRoot } = await setupWorlds();
    try {
      await seedRetained(worldsRoot, "a", 1);
      await seedRetained(worldsRoot, "B", 1);
      const binding = await ensureBoundDirectory(worldsRoot, "worlds root");
      const owner = uncertainComparisonAdmissionOwnerFor(binding);
      try {
        const admission = await owner.acquire(() => false);
        expect(admission.ok).toBe(true);
        if (admission.ok) admission.lease.release();
        await owner.drain();
        // Code-unit order ("B" < "a"); locale order would put "a" first.
        expect(await ledgerEntryNames(worldsRoot)).toEqual(["B", "a"]);
      } finally {
        releaseUncertainComparisonAdmissionOwner(owner);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
