import { test as base, expect } from "./fixtures.ts";
import { mockLifecycleDialogs } from "./lifecycle-dialog.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { MARKER } from "../../electron/worldlines/limits.ts";
import { mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";

// All resources, including the incomplete foreign area, belong to the fixture.
const test = base.extend({
  projectRoot: async ({ projectRoot, runRoot }, use) => {
    const bins = join(projectRoot, "node_modules", ".bin");
    await mkdir(bins, { recursive: true });
    await mkdir(join(projectRoot, "node_modules", "tool"));
    await writeFile(join(projectRoot, "node_modules", "tool", "cli.js"), "console.log('fixture tool');\n");
    await symlink("../tool/cli.js", join(bins, "tool"));
    await writeFile(join(projectRoot, ".gitignore"), "node_modules/\n");

    const skills = join(runRoot, "home", ".agents", "skills");
    await mkdir(join(skills, "source"), { recursive: true });
    await writeFile(join(skills, "source", "SKILL.md"), "---\nname: source\ndescription: Synthetic fixture skill\n---\nRead-only fixture.\n");
    await symlink("source", join(skills, "linked-skill"));

    await use(projectRoot);
  },
});

async function seedForeignArea(runRoot: string): Promise<void> {
  // Wait for the app to establish native provenance for worlds before adding
  // synthetic recovery evidence. Never fabricate a trusted root identity.
  const dir = join(runRoot, "worlds", "cmp-2");
  const foreignBins = join(dir, "template", "node_modules", ".bin");
  await mkdir(foreignBins, { recursive: true });
  await symlink("../tool/cli.js", join(foreignBins, "tool"));
  await writeFile(join(dir, MARKER), "owned\n");
  await writeFile(join(dir, "manifest.json"), JSON.stringify({
    id: "cmp-2", sourceRunId: null, createdAt: 1, status: "complete", expectedCandidates: 1,
    session: { primaryRoot: join(runRoot, "other-project"), baseStateId: "base", sourceGitDir: join(runRoot, "other-project", ".git"), model: null, thinkingLevel: null },
    candidates: { A: { pid: null, lstart: null, paths: [join(dir, "A"), join(dir, "A-support")] } },
    uncertainSessionArtifacts: [],
  }));
  // Complete metadata deliberately lacks A-support and profiles, as in the
  // reported failure. It must be retained, not deleted or trusted to launch.
}

async function waitReady(page: Page, eventsDir: string, id: string): Promise<void> {
  await expect.poll(async () => {
    try {
      return (await readFile(join(eventsDir, `${id}.jsonl`), "utf8")).split("\n")
        .map(parseSidecarRecord).some((record) => record?.t === "session_ready" && record.ok);
    } catch { return false; }
  }, { timeout: 30_000 }).toBe(true);
  expect((await page.evaluate(() => window.termina.getInstances())).find((inst) => inst.id === id)).toBeTruthy();
}

async function initialProject(page: Page, runRoot: string) {
  await expect(page.locator("#splash")).toBeHidden();
  const [project] = await page.evaluate(() => window.termina.projectList());
  expect(project).toBeTruthy();
  const [owner] = await page.evaluate(() => window.termina.getInstances());
  expect(owner).toBeTruthy();
  await waitReady(page, join(runRoot, "events"), owner!.id);
  await seedForeignArea(runRoot);
  return project!;
}

async function createAgent(page: Page, projectId: string) {
  const result = await page.evaluate((projectId) => window.termina.createTerminal({ type: "agent", projectId }), projectId);
  expect(result).toMatchObject({ ok: true });
  expect(result.id).toBeTruthy();
  const candidate = (await page.evaluate((id) => window.termina.getWorldlines(id), projectId))
    .find((item) => item.terminalId === result.id)!;
  expect(candidate).toMatchObject({ role: "session", state: "ready", error: null });
  await waitReady(page, join(dirname(candidate.root), "A-support", "events"), result.id!);
  return candidate;
}

test("creates five independent agents with linked dependencies and retains all five across project reopen", async ({ page, projectRoot, runRoot, electronApp }) => {
  test.setTimeout(180_000);
  const project = await initialProject(page, runRoot);
  const foreignManifest = await readFile(join(runRoot, "worlds", "cmp-2", "manifest.json"), "utf8");
  const roots: string[] = [];
  for (let i = 0; i < 5; i++) {
    const candidate = await createAgent(page, project.id);
    expect(candidate.root).not.toBe(projectRoot);
    expect(roots).not.toContain(candidate.root);
    roots.push(candidate.root);
    expect(await readlink(join(candidate.root, "node_modules", ".bin", "tool"))).toBe("../tool/cli.js");
    expect(await readlink(join(dirname(candidate.root), "A-support", "home", ".agents", "skills", "linked-skill"))).toBe("source");
    expect(await readFile(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
    expect(await page.evaluate(() => window.termina.getInstances())).toHaveLength(i + 2);
  }
  expect(await readFile(join(runRoot, "worlds", "cmp-2", "manifest.json"), "utf8")).toBe(foreignManifest);
  await mockLifecycleDialogs(electronApp, 0);
  expect(await page.evaluate((id) => window.termina.projectClose(id), project.id)).toMatchObject({ ok: true });
  expect(await page.evaluate((root) => window.termina.projectOpenPath(root), projectRoot)).toMatchObject({ cwd: projectRoot });
  await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((items) => items.length)), { timeout: 60_000 }).toBe(6);
  const reopened = (await page.evaluate(() => window.termina.projectList()))[0]!;
  const restored = await page.evaluate((id) => window.termina.getWorldlines(id), reopened.id);
  expect(restored.filter((item) => item.role === "session" && item.state === "ready").map((item) => item.root).sort()).toEqual(roots.sort());
  for (const candidate of restored) {
    if (candidate.terminalId) await waitReady(page, join(dirname(candidate.root), "A-support", "events"), candidate.terminalId);
  }
  expect(await readFile(join(runRoot, "worlds", "cmp-2", "manifest.json"), "utf8")).toBe(foreignManifest);
});

test("creates and restores twenty shells without dropping saved tabs", async ({ page, projectRoot, runRoot, electronApp }) => {
  test.setTimeout(180_000);
  const project = await initialProject(page, runRoot);
  const ids = (await page.evaluate(() => window.termina.getInstances())).map((item) => item.id);
  for (let i = 0; i < 20; i++) {
    const result = await page.evaluate((projectId) => window.termina.createTerminal({ type: "shell", projectId }), project.id);
    expect(result).toMatchObject({ ok: true });
    expect(ids).not.toContain(result.id);
    ids.push(result.id!);
  }
  expect(await page.evaluate(() => window.termina.getInstances())).toHaveLength(21);
  await mockLifecycleDialogs(electronApp, 0);
  expect(await page.evaluate((id) => window.termina.projectClose(id), project.id)).toMatchObject({ ok: true });
  expect(await page.evaluate((root) => window.termina.projectOpenPath(root), projectRoot)).toMatchObject({ cwd: projectRoot });
  const restored = await page.evaluate(() => window.termina.getInstances());
  expect(restored.map((item) => item.id).sort()).toEqual(ids.sort());
  expect(restored.filter((item) => item.type === "shell")).toHaveLength(20);
  const canonicalRoot = await realpath(projectRoot);
  for (const item of restored) expect(await realpath(item.cwd)).toBe(canonicalRoot);
  expect((await page.evaluate(() => window.termina.projectList()))[0]!.cwd).toBe(projectRoot);
});

test("an incomplete same-project session stays retained while repeated new agents still start", async ({ page, projectRoot, runRoot, electronApp }) => {
  test.setTimeout(180_000);
  const project = await initialProject(page, runRoot);
  const damaged = await createAgent(page, project.id);
  await mockLifecycleDialogs(electronApp, 0);
  expect(await page.evaluate((id) => window.termina.projectClose(id), project.id)).toMatchObject({ ok: true });
  // Only this test's already-stopped candidate is damaged. Its real captured
  // lineage and durable session metadata are retained for recovery.
  const area = dirname(damaged.root);
  await rm(join(area, "A-support"), { recursive: true });
  await rm(join(area, "profiles"), { recursive: true });
  const savedManifest = await readFile(join(area, "manifest.json"), "utf8");
  expect(await page.evaluate((root) => window.termina.projectOpenPath(root), projectRoot)).toMatchObject({ cwd: projectRoot });
  const reopened = (await page.evaluate(() => window.termina.projectList()))[0]!;
  const retained = (await page.evaluate((id) => window.termina.getWorldlines(id), reopened.id))
    .find((item) => item.comparisonId === damaged.comparisonId)!;
  expect(retained).toMatchObject({ role: "session", state: "error", terminalId: null });
  expect(retained.error).toMatch(/session recovery failed/);
  for (let i = 0; i < 4; i++) await createAgent(page, reopened.id);
  expect(await page.evaluate(() => window.termina.getInstances())).toHaveLength(5);
  expect(await readFile(join(area, "manifest.json"), "utf8")).toBe(savedManifest);
  expect(await readFile(join(damaged.root, "hello.txt"), "utf8")).toBe("hello\n");
  expect(await readlink(join(damaged.root, "node_modules", ".bin", "tool"))).toBe("../tool/cli.js");
});
