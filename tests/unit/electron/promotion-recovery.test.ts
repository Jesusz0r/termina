import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  disposeWorldlineCoreClient,
  ensurePromotionRoots,
  recoverPromotionJournals,
} from "../../../electron/worldlines/index.js";
import { createPromotionArtifactManifest } from "../../../electron/worldlines/promotion-recovery.js";
import { coreSessionFile } from "../../../agent-core/session.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

async function setupRoots(): Promise<{ root: string; worldsRoot: string; primaryRoot: string; canonicalPrimary: string }> {
  const root = await mkdtemp(join(tmpdir(), "termina-promote-recovery-"));
  const worldsRoot = join(root, "worlds");
  const primaryRoot = join(root, "primary");
  await ensurePromotionRoots(worldsRoot, primaryRoot);
  const canonicalPrimary = await realpath(primaryRoot);
  const canonicalWorlds = await realpath(worldsRoot);
  return { root, worldsRoot: canonicalWorlds, primaryRoot: canonicalPrimary, canonicalPrimary };
}

describe("Promotion after-applied crash recovery", () => {
  it("completes session install by moving the staged bundle on a merged tree", async () => {
    const { root, worldsRoot, primaryRoot } = await setupRoots();
    try {
      const rel = "file.txt";
      const before = "before\n";
      const after = "applied\n";
      await writeFile(join(primaryRoot, rel), after, { mode: 0o644 });
      const opId = "promote-after-applied-move";
      const journalDir = join(worldsRoot, "promotion-journal", opId);
      const sessionRoot = join(journalDir, "session");
      await mkdir(join(journalDir, "before"), { recursive: true, mode: 0o700 });
      await writeFile(join(journalDir, "before", rel), before, { mode: 0o644 });
      const stagedSession = coreSessionFile(sessionRoot, "staged");
      await mkdir(dirname(stagedSession), { recursive: true, mode: 0o700 });
      await writeFile(stagedSession, "staged\n", { mode: 0o600 });
      const sessionId = "core-00000000-0000-4000-8000-000000000001";
      const stagedBundleSession = coreSessionFile(sessionRoot, sessionId);
      await mkdir(dirname(stagedBundleSession), { recursive: true, mode: 0o700 });
      await writeFile(stagedBundleSession, "promoted\n", { mode: 0o600 });
      const installProjectDir = join(root, "sessions");
      await mkdir(installProjectDir, { recursive: true, mode: 0o700 });
      const installedSession = coreSessionFile(installProjectDir, sessionId);
      const bundleDir = dirname(dirname(installedSession));
      const fileState = (content: string) => ({ type: "file", mode: 0o644, hash: sha256(content) });
      await writeFile(
        join(journalDir, "journal.json"),
        JSON.stringify({
          opId,
          primaryRoot,
          phase: "applied",
          createdAt: Date.now(),
          paths: [
            {
              rel,
              kind: "write",
              beforeHash: sha256(before),
              afterHash: sha256(after),
              beforeExists: true,
              beforeState: fileState(before),
              afterState: fileState(after),
            },
          ],
          stagedSession,
          installedSession,
          installedSessionTemp: null,
          installedSessionManifest: { status: "planned", path: bundleDir },
          installedSessionTempManifest: null,
          uncertainSessionArtifacts: [],
          rollbackTemps: [],
          engine: "core",
        }),
        { mode: 0o600 },
      );
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      expect(await readFile(join(primaryRoot, rel), "utf8")).toBe(after);
      expect((await lstat(installedSession)).isFile()).toBe(true);
      expect(await readFile(installedSession, "utf8")).toBe("promoted\n");
      await expect(lstat(join(sessionRoot, sessionId))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(join(journalDir, "journal.json"))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves the merged tree when the installed bundle is already present", async () => {
    const { root, worldsRoot, primaryRoot } = await setupRoots();
    try {
      const rel = "merged.txt";
      const before = "before\n";
      const after = "applied\n";
      await writeFile(join(primaryRoot, rel), after, { mode: 0o644 });
      const opId = "promote-after-applied-installed";
      const journalDir = join(worldsRoot, "promotion-journal", opId);
      const sessionRoot = join(journalDir, "session");
      await mkdir(join(journalDir, "before"), { recursive: true, mode: 0o700 });
      await writeFile(join(journalDir, "before", rel), before, { mode: 0o644 });
      const stagedSession = coreSessionFile(sessionRoot, "staged");
      await mkdir(dirname(stagedSession), { recursive: true, mode: 0o700 });
      await writeFile(stagedSession, "staged\n", { mode: 0o600 });
      const sessionId = "core-00000000-0000-4000-8000-000000000002";
      const installProjectDir = join(root, "sessions");
      await mkdir(installProjectDir, { recursive: true, mode: 0o700 });
      const installedSession = coreSessionFile(installProjectDir, sessionId);
      await mkdir(dirname(installedSession), { recursive: true, mode: 0o700 });
      await writeFile(installedSession, "installed\n", { mode: 0o600 });
      const bundleDir = dirname(dirname(installedSession));
      const manifest = await createPromotionArtifactManifest(bundleDir);
      const fileState = (content: string) => ({ type: "file", mode: 0o644, hash: sha256(content) });
      await writeFile(
        join(journalDir, "journal.json"),
        JSON.stringify({
          opId,
          primaryRoot,
          phase: "applied",
          createdAt: Date.now(),
          paths: [
            {
              rel,
              kind: "write",
              beforeHash: sha256(before),
              afterHash: sha256(after),
              beforeExists: true,
              beforeState: fileState(before),
              afterState: fileState(after),
            },
          ],
          stagedSession,
          installedSession,
          installedSessionTemp: null,
          installedSessionManifest: manifest,
          installedSessionTempManifest: null,
          uncertainSessionArtifacts: [],
          rollbackTemps: [],
          engine: "core",
        }),
        { mode: 0o600 },
      );
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      expect(await readFile(join(primaryRoot, rel), "utf8")).toBe(after);
      expect(await readFile(installedSession, "utf8")).toBe("installed\n");
      expect((await lstat(join(journalDir, "journal.json"))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back cleanly when session install is impossible after applied", async () => {
    const { root, worldsRoot, primaryRoot } = await setupRoots();
    try {
      const rel = "rollback.txt";
      const before = "before\n";
      const after = "applied\n";
      await writeFile(join(primaryRoot, rel), after, { mode: 0o644 });
      const opId = "promote-after-applied-rollback";
      const journalDir = join(worldsRoot, "promotion-journal", opId);
      const sessionRoot = join(journalDir, "session");
      await mkdir(join(journalDir, "before"), { recursive: true, mode: 0o700 });
      await writeFile(join(journalDir, "before", rel), before, { mode: 0o644 });
      const stagedSession = coreSessionFile(sessionRoot, "staged");
      await mkdir(dirname(stagedSession), { recursive: true, mode: 0o700 });
      await writeFile(stagedSession, "staged\n", { mode: 0o600 });
      const fileState = (content: string) => ({ type: "file", mode: 0o644, hash: sha256(content) });
      await writeFile(
        join(journalDir, "journal.json"),
        JSON.stringify({
          opId,
          primaryRoot,
          phase: "applied",
          createdAt: Date.now(),
          paths: [
            {
              rel,
              kind: "write",
              beforeHash: sha256(before),
              afterHash: sha256(after),
              beforeExists: true,
              beforeState: fileState(before),
              afterState: fileState(after),
            },
          ],
          stagedSession,
          installedSession: null,
          installedSessionTemp: null,
          installedSessionManifest: null,
          installedSessionTempManifest: null,
          uncertainSessionArtifacts: [],
          rollbackTemps: [],
          engine: "core",
        }),
        { mode: 0o600 },
      );
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      expect(await readFile(join(primaryRoot, rel), "utf8")).toBe(before);
      expect((await lstat(join(journalDir, "journal.json"))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back applied paths from a checkpoint journal with before-image identities", async () => {
    const { root, worldsRoot, primaryRoot } = await setupRoots();
    try {
      const files = ["ck-a.txt", "ck-b.txt", "ck-c.txt"];
      const before = "before\n";
      const after = "applied\n";
      // Two paths applied before the crash, one still at its before-state.
      await writeFile(join(primaryRoot, files[0]!), after, { mode: 0o644 });
      await writeFile(join(primaryRoot, files[1]!), after, { mode: 0o644 });
      await writeFile(join(primaryRoot, files[2]!), before, { mode: 0o644 });
      const opId = "promote-checkpoint-rollback";
      const journalDir = join(worldsRoot, "promotion-journal", opId);
      await mkdir(join(journalDir, "before"), { recursive: true, mode: 0o700 });
      const paths = [];
      for (const rel of files) {
        const imagePath = join(journalDir, "before", rel);
        await writeFile(imagePath, before, { mode: 0o644 });
        const info = await lstat(imagePath, { bigint: true });
        paths.push({
          rel,
          kind: "write",
          beforeHash: sha256(before),
          afterHash: sha256(after),
          beforeExists: true,
          beforeState: { type: "file", mode: 0o644, hash: sha256(before) },
          afterState: { type: "file", mode: 0o644, hash: sha256(after) },
          beforeImageIdentity: { dev: String(info.dev), ino: String(info.ino) },
          beforeImageSize: String(Buffer.byteLength(before)),
        });
      }
      await writeFile(
        join(journalDir, "journal.json"),
        JSON.stringify({
          opId,
          primaryRoot,
          phase: "prepared",
          createdAt: Date.now(),
          paths,
          stagedSession: null,
          installedSession: null,
          installedSessionTemp: null,
          installedSessionManifest: null,
          installedSessionTempManifest: null,
          uncertainSessionArtifacts: [],
          rollbackTemps: [],
          engine: "core",
        }),
        { mode: 0o600 },
      );
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      for (const rel of files) {
        expect(await readFile(join(primaryRoot, rel), "utf8")).toBe(before);
      }
      expect((await lstat(join(journalDir, "journal.json"))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    disposeWorldlineCoreClient();
  });
});
