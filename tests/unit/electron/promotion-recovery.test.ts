import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  disposeWorldlineGitCore,
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

  it("rolls back applied paths from a checkpoint journal with before-image identities", async () => {    const { root, worldsRoot, primaryRoot } = await setupRoots();
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

  it("marks a completed journal so the next open skips re-verification", async () => {
    const { root, worldsRoot, primaryRoot } = await setupRoots();
    try {
      const rel = "marked-done.txt";
      const before = "before\n";
      const after = "applied\n";
      await writeFile(join(primaryRoot, rel), after, { mode: 0o644 });
      const opId = "promote-marker-done";
      const journalDir = join(worldsRoot, "promotion-journal", opId);
      const sessionRoot = join(journalDir, "session");
      await mkdir(join(journalDir, "before"), { recursive: true, mode: 0o700 });
      await writeFile(join(journalDir, "before", rel), before, { mode: 0o644 });
      const stagedSession = coreSessionFile(sessionRoot, "staged");
      await mkdir(dirname(stagedSession), { recursive: true, mode: 0o700 });
      await writeFile(stagedSession, "staged\n", { mode: 0o600 });
      const sessionId = "core-00000000-0000-4000-8000-000000000009";
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
      const marked = JSON.parse(await readFile(join(journalDir, "journal.json"), "utf8")) as { recovery?: { status?: string } };
      expect(marked.recovery?.status).toBe("done");
      const snap = await readFile(join(journalDir, "journal.json"), "utf8");
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      expect(await readFile(join(journalDir, "journal.json"), "utf8")).toBe(snap);
      expect(await readFile(join(primaryRoot, rel), "utf8")).toBe(after);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("completion marker (issue #179)", () => {
  const files = ["mk-a.txt", "mk-b.txt"];
  const before = "before\n";
  const after = "applied\n";

  async function setupMarked(): Promise<{ root: string; worldsRoot: string; primaryRoot: string; journalDir: string }> {
    const { root, worldsRoot, primaryRoot } = await setupRoots();
    for (const rel of files) await writeFile(join(primaryRoot, rel), before, { mode: 0o644 });
    const opId = "promote-marker-probe";
    const journalDir = join(worldsRoot, "promotion-journal", opId);
    await mkdir(join(journalDir, "before"), { recursive: true, mode: 0o700 });
    const paths = [];
    for (const rel of files) {
      await writeFile(join(journalDir, "before", rel), before, { mode: 0o644 });
      paths.push({
        rel,
        kind: "write",
        beforeHash: sha256(before),
        afterHash: sha256(after),
        beforeExists: true,
        beforeState: { type: "file", mode: 0o644, hash: sha256(before) },
        afterState: { type: "file", mode: 0o644, hash: sha256(after) },
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
    return { root, worldsRoot, primaryRoot, journalDir };
  }

  async function journalText(journalDir: string): Promise<string> {
    return readFile(join(journalDir, "journal.json"), "utf8");
  }

  it("marks a recovered journal and leaves it byte-stable on the next open", async () => {
    const { root, worldsRoot, primaryRoot, journalDir } = await setupMarked();
    try {
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      const marked = JSON.parse(await journalText(journalDir)) as { recovery?: { status?: string; digest?: string; inputs?: unknown[] } };
      expect(marked.recovery?.status).toBe("rolled-back");
      expect(typeof marked.recovery?.digest).toBe("string");
      expect(marked.recovery?.inputs?.length).toBe(2);
      const snap = await journalText(journalDir);
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      expect(await journalText(journalDir)).toBe(snap);
      for (const rel of files) {
        expect(await readFile(join(primaryRoot, rel), "utf8")).toBe(before);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-verifies and re-marks when an input drifts, then skips again", async () => {
    const { root, worldsRoot, primaryRoot, journalDir } = await setupMarked();
    try {
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      const marked = await journalText(journalDir);
      await writeFile(join(primaryRoot, files[0]!), after, { mode: 0o644 });
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      expect(await readFile(join(primaryRoot, files[0]!), "utf8")).toBe(before);
      const remarked = await journalText(journalDir);
      expect(remarked).not.toBe(marked);
      expect((JSON.parse(remarked) as { recovery?: { status?: string } }).recovery?.status).toBe("rolled-back");
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      expect(await journalText(journalDir)).toBe(remarked);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-verifies when the journal content changes or the marker is malformed", async () => {
    const { root, worldsRoot, primaryRoot, journalDir } = await setupMarked();
    try {
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      const marked = await journalText(journalDir);
      // A semantic journal edit invalidates the bound digest.
      const edited = JSON.parse(marked) as Record<string, unknown>;
      edited.createdAt = 1;
      await writeFile(join(journalDir, "journal.json"), JSON.stringify(edited), { mode: 0o600 });
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      const remarked = await journalText(journalDir);
      expect(remarked).not.toBe(marked);
      // A malformed marker fails closed to full re-verification and a fresh mark.
      const broken = JSON.parse(remarked) as Record<string, unknown>;
      broken.recovery = { bogus: true };
      await writeFile(join(journalDir, "journal.json"), JSON.stringify(broken), { mode: 0o600 });
      await recoverPromotionJournals(worldsRoot, { primaryRoot });
      const repaired = JSON.parse(await journalText(journalDir)) as { recovery?: { status?: string; digest?: string; inputs?: unknown[] } };
      expect(repaired.recovery?.status).toBe("rolled-back");
      expect(typeof repaired.recovery?.digest).toBe("string");
      expect(repaired.recovery?.inputs?.length).toBe(2);
      for (const rel of files) {
        expect(await readFile(join(primaryRoot, rel), "utf8")).toBe(before);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  });

  afterAll(() => {
    disposeWorldlineGitCore();
  });
});
