import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measurePromotionTreeBytes } from "../../../electron/worldlines/promotion-journal.ts";

const managerSrc = readFileSync(new URL("../../../electron/worldlines/manager.ts", import.meta.url), "utf8");
const journalSrc = readFileSync(new URL("../../../electron/worldlines/promotion-journal.ts", import.meta.url), "utf8");
const indexSrc = readFileSync(new URL("../../../electron/worldlines/index.ts", import.meta.url), "utf8");
const uncertainSrc = readFileSync(new URL("../../../electron/worldlines/uncertain-comparison.ts", import.meta.url), "utf8");
const retainedSrc = readFileSync(new URL("../../../electron/session-retention/measure.ts", import.meta.url), "utf8");

describe("forkRun tree budget (issue #380)", () => {
  it("uses measurePromotionTreeBytes for the forkRun cap and does not spawn du", () => {
    expect(journalSrc).not.toMatch(/\bdirBytes\b/);
    expect(journalSrc).not.toMatch(/\bspawn\b/);
    expect(journalSrc).not.toMatch(/\bdu\b/);
    expect(indexSrc).not.toMatch(/\bdirBytes\b/);
    expect(managerSrc).not.toMatch(/\bdirBytes\b/);
    expect(managerSrc).toContain("measurePromotionTreeBytes(cmp.templateDir, BigInt(MAX_TEMPLATE_BYTES) + 1n)");
    expect(managerSrc).toContain('measurePromotionTreeBytes(cmp.candidates.get("A")!.dir, BigInt(MAX_CANDIDATE_BYTES) + 1n)');
  });

  it("keeps the three tree measurers as separate fail-closed owners", () => {
    expect(journalSrc).toContain("export async function measurePromotionTreeBytes");
    expect(uncertainSrc).toContain("async function measureUncertainComparisonTree");
    expect(retainedSrc).toContain("export async function measureRetainedClaimTree");
    expect(journalSrc).not.toContain("measureUncertainComparisonTree");
    expect(journalSrc).not.toContain("measureRetainedClaimTree");
  });

  it("sums lstat sizes, saturates at the limit, and does not follow symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-promo-tree-"));
    try {
      const tree = join(root, "tree");
      await mkdir(tree);
      const file = join(tree, "a.bin");
      await writeFile(file, Buffer.alloc(128, 7));
      const dirInfo = await lstat(tree, { bigint: true });
      const fileInfo = await lstat(file, { bigint: true });
      expect(await measurePromotionTreeBytes(tree, 1_000_000n)).toBe(dirInfo.size + fileInfo.size);
      expect(await measurePromotionTreeBytes(tree, 1n)).toBe(1n);

      const target = join(root, "outside.bin");
      await writeFile(target, Buffer.alloc(50_000, 9));
      const linked = join(root, "linked");
      await mkdir(linked);
      const link = join(linked, "out");
      await symlink(target, link);
      const linkedDir = await lstat(linked, { bigint: true });
      const linkInfo = await lstat(link, { bigint: true });
      const measuredLink = await measurePromotionTreeBytes(linked, 1_000_000n);
      expect(measuredLink).toBe(linkedDir.size + linkInfo.size);
      expect(measuredLink).toBeLessThan(50_000n);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
