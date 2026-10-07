import type { Page } from "@playwright/test";
import { readFileSync, writeFileSync, unlinkSync, symlinkSync, existsSync, realpathSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect, closeOwnedElectron, launchOwnedElectron } from "./fixtures.ts";

async function replaceBuffer(page: Page, content: string): Promise<void> {
  await page.evaluate((text) => {
    const manager = (window as any).__editorMgr;
    const editor = manager.editor;
    editor.executeEdits("draft-test", [{ range: editor.getModel().getFullModelRange(), text }]);
  }, content);
  await expect.poll(() => page.evaluate(() => (window as any).__editorMgr?.editor?.getModel()?.getValue())).toBe(content);
  expect(await page.evaluate(() => (window as any).__editorMgr.flushDrafts())).toBe(true);
}

async function openGreeting(page: Page): Promise<void> {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
  await expect(page.locator(".editor-tab .tab-name").getByText("greeting.ts")).toBeVisible();
}

async function expectRecovered(page: Page, content: string, fileName = "greeting.ts"): Promise<void> {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__editorMgr?.editor?.getModel()?.getValue()), { timeout: 15_000 }).toBe(content);
  const tab = page.locator(".editor-tab").filter({ hasText: fileName });
  await expect(tab.locator(".tab-dirty")).toBeVisible();
  await expect(tab).toHaveClass(/conflict/);
  await expect(tab).not.toHaveClass(/preview/);
}

test.describe("unsaved draft recovery", () => {
  test("renderer reload restores a pinned unsaved buffer without writing the project", async ({ page, projectRoot }) => {
    const path = join(projectRoot, "greeting.ts");
    const original = readFileSync(path, "utf8");
    await openGreeting(page);
    await replaceBuffer(page, "// recovered draft\n");
    expect(readFileSync(path, "utf8")).toBe(original);
    await page.reload();
    await expectRecovered(page, "// recovered draft\n");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("disk changes do not replace the recovered draft", async ({ page, projectRoot }) => {
    const path = join(projectRoot, "greeting.ts");
    await openGreeting(page);
    await replaceBuffer(page, "// my unsaved text\n");
    writeFileSync(path, "// external disk change\n");
    await page.reload();
    await expectRecovered(page, "// my unsaved text\n");
    expect(readFileSync(path, "utf8")).toBe("// external disk change\n");
  });

  test("deleted files recover as drafts and require explicit restore", async ({ page, projectRoot }) => {
    const path = join(projectRoot, "greeting.ts");
    await openGreeting(page);
    await replaceBuffer(page, "// recreate only with consent\n");
    unlinkSync(path);
    await page.reload();
    await expectRecovered(page, "// recreate only with consent\n");
    await expect(page.locator(".editor-tab").filter({ hasText: "greeting.ts" })).toHaveClass(/deleted/);
    const save = page.evaluate(() => (window as any).__editorMgr.saveActive());
    const modal = page.locator(".modal");
    await expect(modal).toContainText("Restore deleted file");
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    await save;
    expect(existsSync(path)).toBe(false);
    const owner = await page.evaluate(() => {
      const pane = (window as any).__panes.values().next().value;
      return { projectId: pane.projectId, workspaceId: pane.workspaceId };
    });
    const draft = await page.evaluate((ref) => window.termina.getEditorDrafts(ref.projectId), owner);
    expect(draft.files.map((file) => file.path)).toContain(join(realpathSync(projectRoot), "greeting.ts"));
  });

  test("save and explicit tab discard remove copies; cancelled close retains them", async ({ page, projectRoot }) => {
    const path = join(projectRoot, "greeting.ts");
    await openGreeting(page);
    await replaceBuffer(page, "// keep on cancel\n");
    const close = page.evaluate(() => { const manager = (window as any).__editorMgr; return manager.requestCloseTab(manager.activeKey); });
    const modal = page.locator(".modal");
    await expect(modal).toContainText("Unsaved changes");
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await close).toBe(false);
    await page.reload();
    await expectRecovered(page, "// keep on cancel\n");
    expect((await page.evaluate(() => (window as any).__editorMgr.flushAll())).ok).toBe(true);
    expect(await page.evaluate(() => (window as any).__editorMgr.flushDrafts())).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("// keep on cancel\n");
    await page.reload();
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await expect(page.locator(".editor-tab").filter({ hasText: "greeting.ts" })).toHaveCount(0);
    await openGreeting(page);
    await replaceBuffer(page, "// discard this\n");
    const discard = page.evaluate(() => { const manager = (window as any).__editorMgr; return manager.requestCloseTab(manager.activeKey); });
    await expect(modal).toContainText("Unsaved changes");
    await modal.getByRole("button", { name: "Discard", exact: true }).click();
    expect(await discard).toBe(true);
    await page.reload();
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await expect(page.locator(".editor-tab").filter({ hasText: "greeting.ts" })).toHaveCount(0);
    expect(readFileSync(path, "utf8")).toBe("// keep on cancel\n");
  });

  for (const mode of ["binary", "invalid UTF-8", "oversized"] as const) {
    test(`${mode} replacement cannot hide an accepted text draft`, async ({ page, projectRoot }) => {
      const path = join(projectRoot, "greeting.ts");
      await openGreeting(page);
      await replaceBuffer(page, "// still recover this text\n");
      const replacement = mode === "binary" ? Buffer.from([0, 255, 1])
        : mode === "invalid UTF-8" ? Buffer.from([0xc3, 0x28]) : Buffer.alloc(3 * 1024 * 1024, 65);
      writeFileSync(path, replacement);
      await page.reload();
      await expectRecovered(page, "// still recover this text\n");
      const save = page.evaluate(() => (window as any).__editorMgr.saveActive());
      await expect(page.locator(".modal")).toContainText("Replace current file");
      await page.locator(".modal").getByRole("button", { name: "Cancel", exact: true }).click();
      await save;
      expect(readFileSync(path)).toEqual(replacement);
    });
  }

  test("a non-file replacement recovers the buffer but cannot be overwritten by Save", async ({ page, projectRoot }) => {
    const path = join(projectRoot, "greeting.ts");
    await openGreeting(page);
    await replaceBuffer(page, "// text remains available for copying\n");
    unlinkSync(path);
    mkdirSync(path);
    await page.reload();
    await expectRecovered(page, "// text remains available for copying\n");
    await page.evaluate(() => (window as any).__editorMgr.saveActive());
    await expect(page.locator(".modal")).toHaveCount(0);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(await page.evaluate(() => (window as any).__editorMgr.flushDrafts())).toBe(true);
  });

  for (const concurrent of [false, true]) {
    test(`${concurrent ? "concurrent" : "sequential"} alias opens keep one model and its recovery access`, async ({ page, projectRoot }) => {
      const path = join(projectRoot, "greeting.ts");
      const alias = join(projectRoot, "alias.ts");
      symlinkSync(path, alias);
      await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
      await expect.poll(() => page.evaluate(() => !!(window as any).__editorMgr), { timeout: 15_000 }).toBe(true);
      await page.evaluate(async ({ path, alias, concurrent }) => {
        const manager = (window as any).__editorMgr;
        if (concurrent) await Promise.all([manager.openFile(path, { preview: false }), manager.openFile(alias, { preview: false })]);
        else { await manager.openFile(path, { preview: false }); await manager.openFile(alias, { preview: false }); }
      }, { path, alias, concurrent });
      await expect(page.locator(".editor-tab").filter({ hasText: "greeting.ts" })).toHaveCount(1);
      await replaceBuffer(page, "// aliased model keeps recovery\n");
      await page.reload();
      await expectRecovered(page, "// aliased model keeps recovery\n");
    });
  }

  for (const scope of ["tabs", "project"] as const) {
    test(`failed ${scope} discard re-protects open dirty buffers after partial removal`, async ({ page, electronApp, projectRoot }) => {
      await openGreeting(page);
      await replaceBuffer(page, "// first dirty buffer\n");
      await page.evaluate((path) => (window as any).__editorMgr.openFile(path, { preview: false }), join(projectRoot, "hello.txt"));
      await replaceBuffer(page, "second dirty buffer\n");
      await electronApp.evaluate(async ({ app }) => {
        const promises = process.getBuiltinModule("fs").promises as typeof import("node:fs/promises");
        const directory = app.getPath("userData") + "/editor-drafts/";
        const original = promises.unlink;
        (globalThis as any).__draftTestUnlink = original;
        let removed = 0;
        promises.unlink = async (path) => {
          await original(path);
          if (String(path).startsWith(directory) && String(path).endsWith(".json") && ++removed === 2) {
            throw new Error("EIO: injected failure after recovery-copy unlink");
          }
        };
        process.getBuiltinModule("module").syncBuiltinESMExports();
      });
      try {
        const close = page.evaluate(async (scope) => {
          const manager = (window as any).__editorMgr;
          if (scope === "tabs") return manager.requestCloseKeys([...manager.userDirty]);
          const owner = manager.tabs.values().next().value.owner;
          try { return (await window.termina.projectClose(owner.projectId)).ok; } catch { return false; }
        }, scope);
        const modal = page.locator(".modal");
        await expect(modal).toContainText("Unsaved changes");
        await modal.getByRole("button", { name: "Discard", exact: true }).click();
        expect(await close).toBe(false);
        await expect.poll(() => page.evaluate(() => {
          const tabs = [...(window as any).__editorMgr.tabs.values()] as any[];
          return tabs.map((tab) => tab.dirtyDot.dataset.recovery);
        })).toEqual(["saved", "saved"]);
        await page.reload();
        await expect(page.locator(".editor-tab")).toHaveCount(2, { timeout: 15_000 });
        await expect.poll(() => page.evaluate(() => {
          const tabs = [...((window as any).__editorMgr?.tabs.values() ?? [])] as any[];
          return tabs.map((tab) => tab.model.getValue()).sort();
        }), { timeout: 15_000 }).toEqual(["// first dirty buffer\n", "second dirty buffer\n"]);
      } finally {
        await electronApp.evaluate(async () => {
          const promises = process.getBuiltinModule("fs").promises as typeof import("node:fs/promises");
          promises.unlink = (globalThis as any).__draftTestUnlink;
          process.getBuiltinModule("module").syncBuiltinESMExports();
          delete (globalThis as any).__draftTestUnlink;
        });
      }
    });
  }

  test("one corrupt private copy does not prevent recovery of later valid copies", async ({ page, electronApp, projectRoot }) => {
    await openGreeting(page);
    await replaceBuffer(page, "// copy that will be corrupted\n");
    await page.evaluate((path) => (window as any).__editorMgr.openFile(path, { preview: false }), join(projectRoot, "hello.txt"));
    await replaceBuffer(page, "valid later copy\n");
    const corruptPath = await electronApp.evaluate(({ app }) => {
      const fs = process.getBuiltinModule("fs");
      const directory = app.getPath("userData") + "/editor-drafts/";
      for (const name of fs.readdirSync(directory)) {
        const path = directory + name;
        if (JSON.parse(fs.readFileSync(path, "utf8")).path.endsWith("/greeting.ts")) {
          fs.writeFileSync(path, "{corrupt");
          return path;
        }
      }
      throw new Error("expected greeting recovery copy");
    });
    await page.reload();
    await expectRecovered(page, "valid later copy\n", "hello.txt");
    expect(readFileSync(corruptPath, "utf8")).toBe("{corrupt");
  });

  test("one reopen failure does not prevent restoring later copies", async ({ page, projectRoot }) => {
    await openGreeting(page);
    await replaceBuffer(page, "// first retained copy\n");
    await page.evaluate((path) => (window as any).__editorMgr.openFile(path, { preview: false }), join(projectRoot, "hello.txt"));
    await replaceBuffer(page, "later restored copy\n");
    const result = await page.evaluate(async () => {
      const manager = (window as any).__editorMgr;
      const projectId = manager.tabs.values().next().value.owner.projectId;
      const open = manager.openFile.bind(manager);
      for (const key of [...manager.tabs.keys()]) manager.closeTab(key);
      manager.openFile = (path: string, options: unknown) => path.endsWith("/greeting.ts")
        ? Promise.reject(new Error("injected first-file open failure")) : open(path, options);
      try {
        await manager.restoreDrafts(projectId);
        return "unexpected success";
      } catch (error) {
        return (error as Error).message;
      } finally {
        manager.openFile = open;
      }
    });
    expect(result).toContain("injected first-file open failure");
    await expectRecovered(page, "later restored copy\n", "hello.txt");
  });

  test("reload retires clean abandoned model tokens", async ({ page }) => {
    await openGreeting(page);
    const access = await page.evaluate(() => {
      const tab = (window as any).__editorMgr.tabs.values().next().value;
      return { token: tab.draftRecovery.token, owner: tab.owner };
    });
    await page.reload();
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const result = await page.evaluate(({ token, owner }) => window.termina.checkpointEditorDraft(token, 1, "not admitted", owner), access);
    expect(result.ok).toBe(false);
  });

  test("an isolated application restart recovers the last confirmed copy", async ({ electronApp, page, projectRoot, runRoot }) => {
    await openGreeting(page);
    await replaceBuffer(page, "// survives process restart\n");
    const environment = await electronApp.evaluate(() => ({ ...process.env }));
    const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    // Only the fixture-owned process tree is stopped; retain its isolated data roots.
    await closeOwnedElectron(electronApp);
    const replacement = await launchOwnedElectron(env, runRoot);
    try {
      const restored = await replacement.firstWindow();
      await expectRecovered(restored, "// survives process restart\n");
      expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).not.toBe("// survives process restart\n");
    } finally {
      // Discard is an explicit test cleanup action, not the recovery path.
      try {
        const restored = replacement.windows()[0];
        if (restored) await restored.evaluate(() => (window as any).__editorMgr?.discardDrafts());
      } finally {
        await closeOwnedElectron(replacement);
      }
    }
  });
});
