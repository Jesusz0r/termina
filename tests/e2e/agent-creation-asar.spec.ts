import { test, expect } from "./fixtures.ts";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { MARKER, UNCERTAIN_COMPARISON_USAGE_LEDGER } from "../../electron/worldlines/limits.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

// A failed or unopened area may contain Electron dependencies. Their .asar
// files are physical archives, not directories in the retained source tree.
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

  const expectedBytes = [retained, join(retained, MARKER), join(retained, "manifest.json"), archive]
    .reduce((bytes, path) => bytes + lstatSync(path).size, 0);
  const liveIds = [owner.id];
  // The second creation also exercises the existing durable ledger, rather
  // than only the first reconstruction of retained evidence.
  for (let index = 0; index < 2; index++) {
    const created = await page.evaluate((projectId) => window.termina.createTerminal({ projectId }), owner.projectId!);
    expect(created.ok, created.error).toBe(true);
    expect(created.id).toBeTruthy();
    liveIds.push(created.id!);
    const candidate = (await page.evaluate((projectId) => window.termina.getWorldlines(projectId), owner.projectId!))
      .find((item) => item.terminalId === created.id)!;
    expect(candidate).toMatchObject({ role: "session", state: "ready", error: null });
    expect(candidate.root).not.toBe(projectRoot);
    const events = join(dirname(candidate.root), "A-support", "events", `${created.id}.jsonl`);
    expect(readFileSync(events, "utf8").split("\n").map(parseSidecarRecord)
      .some((record) => record?.t === "session_ready" && record.ok)).toBe(true);
    const ledger = JSON.parse(readFileSync(join(runRoot, "worlds", UNCERTAIN_COMPARISON_USAGE_LEDGER), "utf8")) as {
      entries: Array<{ name: string; bytes: number; entries: number; counted: boolean }>;
    };
    expect(ledger.entries.find((entry) => entry.name === "cmp-9000"))
      .toMatchObject({ bytes: expectedBytes, entries: 4, counted: true });
    expect(readFileSync(archive)).toEqual(before);
  }
  expect((await page.evaluate(() => window.termina.getInstances())).map((instance) => instance.id))
    .toEqual(expect.arrayContaining(liveIds));
});
