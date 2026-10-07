import { expect, test } from "./fixtures.ts";
import { access, cp, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import type { FSWatcher } from "node:fs";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";

interface ObservationProbe {
  watcher: FSWatcher | null;
  suppress: boolean;
  dropped: string[];
  errors: number;
  restore(): void;
}

type ProbeGlobal = typeof globalThis & { __verifyObservation?: ObservationProbe };

async function installObservationProbe(electronApp: ElectronApplication, root: string): Promise<void> {
  await electronApp.evaluate((_electron, root) => {
    const fs = process.getBuiltinModule("fs") as typeof import("node:fs");
    const modules = process.getBuiltinModule("module");
    const original = fs.watch;
    const probe: ObservationProbe = {
      watcher: null, suppress: false, dropped: [], errors: 0,
      restore: () => {
        probe.suppress = false;
        fs.watch = original;
        modules.syncBuiltinESMExports();
        delete (globalThis as ProbeGlobal).__verifyObservation;
      },
    };
    // Keep the real native watcher, Rust captures, main callbacks and IPC.
    // Only this fixture root's notification delivery can be withheld.
    fs.watch = ((...args: unknown[]) => {
      const [path, options, listener] = args;
      if (String(path) !== root || !options || typeof options !== "object" || !("recursive" in options)
        || !options.recursive || typeof listener !== "function") {
        return Reflect.apply(original, fs, args);
      }
      const watcher = Reflect.apply(original, fs, [path, options, (event: string, filename: string | Buffer | null) => {
        if (probe.suppress) {
          if (probe.dropped.length < 100) probe.dropped.push(String(filename));
          return;
        }
        listener(event, filename);
      }]) as FSWatcher;
      probe.watcher = watcher;
      watcher.on("error", () => { probe.errors++; });
      return watcher;
    }) as typeof fs.watch;
    modules.syncBuiltinESMExports();
    (globalThis as ProbeGlobal).__verifyObservation = probe;
  }, root);
}

async function restoreObservationProbe(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => (globalThis as ProbeGlobal).__verifyObservation?.restore());
}

async function openOwner(page: Page, root: string) {
  expect(await page.evaluate((root) => window.termina.projectOpenPath(root), root)).not.toBeNull();
  const project = (await page.evaluate(() => window.termina.projectList())).find((entry) => entry.active)!;
  expect(realpathSync(project.cwd)).toBe(root);
  const owner = (await page.evaluate(() => window.termina.getInstances()))
    .find((entry) => entry.projectId === project.id && entry.type === "agent")!;
  expect(owner).toBeTruthy();
  return { project, owner };
}

async function prepareProject(page: Page, electronApp: ElectronApplication, projectRoot: string, runRoot: string) {
  await expect(page.locator("#splash")).toBeHidden();
  const root = join(runRoot, "observed-project");
  await cp(projectRoot, root, { recursive: true });
  await writeFile(join(root, ".gitignore"), "/stages.jsonl\nnode_modules/\n");
  await writeVerifyPackage(root, { test: "termina-verify-fixture main" });
  const canonical = realpathSync(root);
  await installObservationProbe(electronApp, canonical);
  const target = await openOwner(page, canonical);
  expect(await electronApp.evaluate(() => !!(globalThis as ProbeGlobal).__verifyObservation?.watcher)).toBe(true);
  return { root: canonical, ...target };
}

async function verifyInfo(page: Page, id: string) {
  return page.evaluate(async (id) => (await window.termina.getInstances()).find((entry) => entry.id === id)?.verify, id);
}

async function runPassingVerify(page: Page, id: string) {
  expect(await page.evaluate((id) => window.termina.runVerify(id), id)).toEqual({ ok: true });
  await expect.poll(async () => (await verifyInfo(page, id))?.state).toBe("pass");
  return (await verifyInfo(page, id))!;
}

async function inspectStaleHistory(page: Page, projectId: string, terminalId: string, generation: number) {
  const item = (await page.evaluate(() => window.termina.getWorkOverview())).items
    .find((entry) => entry.projectId === projectId && entry.terminalId === terminalId && entry.reason === "verify-stale")!;
  expect(item).toMatchObject({ action: { kind: "evidence", terminalId, generation } });
  await page.locator("#btn-attention").click();
  await page.locator(`#attention-list .attention-item[data-id="${item.id}"] .attention-inspect`).click();
  await expect(page.locator(".work-summary-report")).toContainText("**Status:** ⚠️ OUTDATED");
  await expect(page.locator(".work-summary-report")).toContainText("**Historical execution:** ✅ PASSED (exit code 0)");
  await expect(page.locator(".work-summary-report")).not.toContainText("**Status:** ✅ PASSED");
}

for (const loss of ["close", "error"] as const) {
  test(`native watcher ${loss} invalidates a pass; unavailable retries stay historical until project recovery`, async ({ page, electronApp, projectRoot, runRoot }) => {
    try {
      const { root, project, owner } = await prepareProject(page, electronApp, projectRoot, runRoot);
      const previous = await runPassingVerify(page, owner.id);
      const input = join(root, "greeting.ts");
      const content = 'export const greeting = "written while observation is unavailable";\n';
      await electronApp.evaluate(async (_electron, loss) => {
        const watcher = (globalThis as ProbeGlobal).__verifyObservation!.watcher!;
        const closed = new Promise<void>((resolve) => watcher.once("close", () => resolve()));
        if (loss === "error") watcher.emit("error", new Error("fixture-owned observation failure"));
        else watcher.close();
        await closed;
      }, loss);
      expect(await electronApp.evaluate(() => (globalThis as ProbeGlobal).__verifyObservation!.errors)).toBe(loss === "error" ? 1 : 0);
      await writeFile(input, content);
      await expect.poll(async () => (await verifyInfo(page, owner.id))?.state).toBe("stale");
      const stale = (await verifyInfo(page, owner.id))!;
      expect(stale.staleReason).toBe("Source observation is unavailable");
      expect(stale.source).toEqual(previous.source);
      expect(stale.result).toEqual(previous.result);
      await expect(page.locator("#verify-badge")).toHaveClass(/state-stale/);
      await inspectStaleHistory(page, project.id, owner.id, owner.generation);
      expect(await readVerifyStages(root)).toHaveLength(1);

      // The command can execute, but exit 0 alone is not current evidence.
      expect(await page.evaluate((id) => window.termina.runVerify(id), owner.id)).toEqual({ ok: true });
      await expect.poll(async () => (await readVerifyStages(root)).length).toBe(2);
      await expect.poll(async () => (await verifyInfo(page, owner.id))?.result?.startedAt).toBeGreaterThan(previous.result!.finishedAt);
      const uncertain = (await verifyInfo(page, owner.id))!;
      expect(uncertain.state).toBe("stale");
      expect(uncertain.result).toMatchObject({ state: "pass", exitCode: 0 });
      expect(uncertain.source).toBeUndefined();
      expect(uncertain.staleReason).toBe("The tested source could not be validated");

      expect(await page.evaluate((id) => window.termina.projectClose(id), project.id)).toEqual({ ok: true });
      const recovered = await openOwner(page, root);
      expect((await verifyInfo(page, recovered.owner.id))?.state).toBe("stale");
      expect(await readFile(input, "utf8")).toBe(content);
      const current = await runPassingVerify(page, recovered.owner.id);
      expect(current.source?.tree).not.toBe(previous.source?.tree);
      expect(current.result!.startedAt).toBeGreaterThan(uncertain.result!.finishedAt);
      expect(await readVerifyStages(root)).toHaveLength(3);
    } finally {
      await restoreObservationProbe(electronApp);
    }
  });
}

for (const mutation of ["write", "atomic replacement", "deletion"] as const) {
  test(`Rust detects an external ${mutation} during Verify even when its native notifications are withheld`, async ({ page, electronApp, projectRoot, runRoot }) => {
    const ready = join(runRoot, "verify-ready");
    const release = join(runRoot, "verify-release");
    try {
      const { root, project, owner } = await prepareProject(page, electronApp, projectRoot, runRoot);
      await writeFile(join(root, "verify-gate.cjs"), `
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
(async () => {
  fs.writeFileSync(${JSON.stringify(ready)}, "ready");
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(${JSON.stringify(release)})) {
    if (Date.now() >= deadline) throw new Error("verification gate was not released");
    await delay(20);
  }
})().catch((error) => { console.error(error); process.exitCode = 9; });
`);
      await writeVerifyPackage(root, { test: "node verify-gate.cjs && termina-verify-fixture main" });
      expect(await page.evaluate((id) => window.termina.runVerify(id), owner.id)).toEqual({ ok: true });
      await expect.poll(() => access(ready).then(() => true, () => false)).toBe(true);
      const running = (await verifyInfo(page, owner.id))!;
      expect(running.state).toBe("running");
      expect(running.source?.tree).toBeTruthy();
      await electronApp.evaluate(() => { (globalThis as ProbeGlobal).__verifyObservation!.suppress = true; });
      const input = join(root, "greeting.ts");
      const content = `export const greeting = "external ${mutation}";\n`;
      if (mutation === "deletion") await unlink(input);
      else if (mutation === "atomic replacement") {
        const replacement = join(runRoot, "replacement.ts");
        await writeFile(replacement, content);
        await rename(replacement, input);
      } else await writeFile(input, content);
      await expect.poll(() => electronApp.evaluate(() => (globalThis as ProbeGlobal).__verifyObservation!.dropped)).toContain("greeting.ts");
      await writeFile(release, "release");
      await expect.poll(async () => (await verifyInfo(page, owner.id))?.state).toBe("stale");
      const historical = (await verifyInfo(page, owner.id))!;
      expect(historical.source).toEqual(running.source);
      expect(historical.result).toMatchObject({ state: "pass", exitCode: 0 });
      expect(historical.staleReason).toBe("Source changed during verification");
      await inspectStaleHistory(page, project.id, owner.id, owner.generation);
      expect(await readVerifyStages(root)).toHaveLength(1);
      if (mutation === "deletion") expect(await access(input).then(() => true, () => false)).toBe(false);
      else expect(await readFile(input, "utf8")).toBe(content);
      const current = await runPassingVerify(page, owner.id);
      expect(current.source?.tree).not.toBe(historical.source?.tree);
      expect(current.result!.startedAt).toBeGreaterThan(historical.result!.finishedAt);
      expect(await readVerifyStages(root)).toHaveLength(2);
    } finally {
      await writeFile(release, "release");
      await restoreObservationProbe(electronApp);
    }
  });
}
