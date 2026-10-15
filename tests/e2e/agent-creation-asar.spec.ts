import { test, expect } from "./fixtures.ts";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKER } from "../../electron/worldlines/limits.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

// A retained area may contain an asar archive. Opening more agents on the
// project must not need to walk that archive.
test("creates another agent when retained work contains an asar archive", async ({ page, electronApp, runRoot, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const owner = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.type === "agent")!;
  const resources = await electronApp.evaluate(() => process.resourcesPath);
  const retained = join(runRoot, "worlds", "cmp-9000");
  mkdirSync(retained, { recursive: true });
  writeFileSync(join(retained, MARKER), "owned\n");
  writeFileSync(join(retained, "manifest.json"), JSON.stringify({
    id: "cmp-9000", sourceRunId: "saved-run", createdAt: 1, status: "uncertain", expectedCandidates: 1,
    candidates: { A: { pid: null, lstart: null, paths: [join(retained, "A")] } },
    uncertainSessionArtifacts: [{ path: join(retained, "saved-session"), error: "retained for recovery" }],
  }));
  const archive = join(retained, "dependency.asar");
  copyFileSync(join(resources, "default_app.asar"), archive);
  const before = readFileSync(archive);

  const liveIds = [owner.id];
  for (let index = 0; index < 2; index++) {
    const created = await page.evaluate((projectId) => window.termina.createTerminal({ projectId }), owner.projectId!);
    expect(created.ok, created.error).toBe(true);
    expect(created.id).toBeTruthy();
    liveIds.push(created.id!);
    const inst = (await page.evaluate(() => window.termina.getInstances())).find((item) => item.id === created.id)!;
    expect(realpathSync(inst.cwd)).toBe(realpathSync(projectRoot));
    const events = join(runRoot, "events", `${created.id}.jsonl`);
    await expect.poll(() => {
      try {
        return readFileSync(events, "utf8").split("\n").map(parseSidecarRecord)
          .some((record) => record?.t === "session_ready" && record.ok);
      } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    expect(readFileSync(archive)).toEqual(before);
  }
  expect((await page.evaluate(() => window.termina.getInstances())).map((instance) => instance.id))
    .toEqual(expect.arrayContaining(liveIds));
});
