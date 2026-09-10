import { test, expect } from "./fixtures.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

test.describe("Explorer File Tree & Actions", () => {
  test("renders root directory and files with folder expansion", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorerTree = page.locator("#explorer-tree");
    await expect(explorerTree).toBeVisible();

    // Verify root files are visible
    await expect(explorerTree.getByText("greeting.ts")).toBeVisible();
    await expect(explorerTree.getByText("hello.txt")).toBeVisible();

    // Check directory "src"
    const srcFolder = explorerTree.locator(".explorer-row").filter({ hasText: "src" });
    await expect(srcFolder).toBeVisible();

    // Click src to toggle expansion
    await srcFolder.click();
    await expect(explorerTree.getByText("index.ts")).toBeVisible();
  });

  test("creates a new file through explorer context menu", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorerTree = page.locator("#explorer-tree");
    const rootRow = explorerTree.locator(".explorer-row").filter({ hasText: "test-project" });
    await rootRow.click({ button: "right" });

    const contextMenu = page.locator(".context-menu");
    await expect(contextMenu).toBeVisible();

    // Click "New File"
    await contextMenu.getByText("New File").click();

    // The modal should appear to name the file
    const input = page.locator(".modal input");
    await expect(input).toBeVisible();
    await input.fill("created-file.ts");
    await page.locator(".modal .modal-btn").filter({ hasText: "OK" }).click();

    // The new file should now be in the tree
    await expect(explorerTree.getByText("created-file.ts")).toBeVisible({ timeout: 10_000 });
  });

  test("recovers subfolders after collapsing and re-expanding the project root", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorerTree = page.locator("#explorer-tree");
    const srcFolder = explorerTree.locator(".explorer-row").filter({ hasText: "src" });
    const rootRow = explorerTree.locator(".explorer-row").filter({ hasText: "test-project" });

    // Expand src so it holds expanded+loaded state, then cycle the root.
    await srcFolder.click();
    await expect(explorerTree.getByText("index.ts")).toBeVisible({ timeout: 10_000 });
    await rootRow.click();
    await expect(explorerTree.getByText("greeting.ts")).toBeHidden({ timeout: 10_000 });
    await rootRow.click();
    await expect(explorerTree.getByText("greeting.ts")).toBeVisible({ timeout: 10_000 });

    // The subfolder must load its content again instead of sticking empty.
    await srcFolder.click();
    await expect(explorerTree.getByText("index.ts")).toBeVisible({ timeout: 10_000 });
  });

  test("opens file from explorer into editor on click", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorerTree = page.locator("#explorer-tree");
    const greeting = explorerTree.locator(".explorer-row").filter({ hasText: "greeting.ts" });
    await greeting.click();

    // Tab opens and becomes active
    const tab = page.locator(".editor-tab.active");
    await expect(tab).toBeVisible();
    await expect(tab.locator(".tab-name")).toHaveText("greeting.ts");
  });
});

test.describe("Explorer keyboard navigation & tree semantics", () => {
  test("exposes tree roles and a single roving tabindex", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");

    await expect(tree).toHaveAttribute("role", "tree");
    await expect(tree).toHaveAttribute("aria-label", "Project files");

    const root = tree.locator(".explorer-row").first();
    await expect(root).toHaveAttribute("role", "treeitem");
    await expect(root).toHaveAttribute("aria-level", "1");
    await expect(root).toHaveAttribute("data-rel-path", "");

    const assertRoving = async (): Promise<void> => {
      const tabs = await tree
        .locator(".explorer-row")
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).tabIndex));
      // Exactly one row is tabbable; the rest are reached with the arrow keys.
      expect(tabs.filter((t) => t === 0)).toHaveLength(1);
      expect(tabs.every((t) => t === 0 || t === -1)).toBe(true);
    };
    await assertRoving();

    // The tabindex hand-off is O(1) (previous row to -1, next to 0), so the
    // invariant must survive navigation. Focus a file row: clicking a folder
    // would toggle it.
    await tree.locator(".explorer-row").filter({ hasText: "greeting.ts" }).click();
    await page.keyboard.press("ArrowDown");
    await assertRoving();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await assertRoving();

    // ...and a collapse, which detaches the previously focused subtree.
    const src = tree.locator(".explorer-row").filter({ hasText: "src" }).first();
    await src.click(); // expands src
    await expect(tree.getByText("index.ts")).toBeVisible({ timeout: 10_000 });
    await tree.locator(".explorer-row").filter({ hasText: "index.ts" }).click();
    await assertRoving();

    // ArrowLeft on a folder's child steps out to the folder (VS Code behavior)...
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-rel-path")))
      .toBe("src");
    await expect(src).toHaveAttribute("aria-expanded", "true");
    await assertRoving();

    // ...and a second ArrowLeft collapses it, detaching the focused subtree.
    await page.keyboard.press("ArrowLeft");
    await expect(tree.getByText("index.ts")).toBeHidden();
    await expect(src).toHaveAttribute("aria-expanded", "false");
    await assertRoving();
  });

  test("moves focus with arrows and keeps selection with it", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");
    const greeting = tree.locator(".explorer-row").filter({ hasText: "greeting.ts" });

    // Clicking a file row focuses it (rows are focusable but not tab-stops).
    await greeting.click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-rel-path")))
      .toBe("greeting.ts");

    await page.keyboard.press("ArrowDown");
    const focused = await page.evaluate(() => ({
      rel: document.activeElement?.getAttribute("data-rel-path"),
      selected: document.activeElement?.getAttribute("aria-selected"),
    }));
    expect(focused.rel).not.toBe("greeting.ts");
    expect(focused.selected).toBe("true");

    await page.keyboard.press("ArrowUp");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-rel-path")))
      .toBe("greeting.ts");

    await page.keyboard.press("Home");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-rel-path")))
      .toBe("");
    await page.keyboard.press("End");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-rel-path"))).not.toBe("");
  });

  test("expands and collapses with left/right arrows", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");
    const root = tree.locator(".explorer-row").first();

    // The root starts expanded: ArrowRight steps into the first child.
    await root.click();
    await page.keyboard.press("ArrowRight"); // re-expand after the click toggled it
    await expect(root).toHaveAttribute("aria-expanded", "true");

    const src = tree.locator(".explorer-row").filter({ hasText: "src" }).first();
    await src.click();
    await expect(src).toHaveAttribute("aria-expanded", "true");
    await expect(tree.getByText("index.ts")).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press("ArrowLeft");
    await expect(src).toHaveAttribute("aria-expanded", "false");
    await expect(tree.getByText("index.ts")).toBeHidden();

    // A collapsed folder steps back out to its parent row.
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-rel-path")))
      .toBe("");
  });

  test("jumps by type-ahead and opens the file on Enter", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");

    // Focus a file row: clicking a folder would toggle it, and the type-ahead
    // wraps, so the search reaches hello.txt from here.
    await tree.locator(".explorer-row").filter({ hasText: "greeting.ts" }).click();
    await page.keyboard.type("hello");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-name")))
      .toBe("hello.txt");

    // Enter opens pinned (the double-click behavior), not as a preview.
    await page.keyboard.press("Enter");
    await expect(page.locator(".editor-tab.active .tab-name")).toHaveText("hello.txt");
  });

  test("F2 and Delete reach the existing shortcut/menu paths", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");

    const greetingRow = tree.locator(".explorer-row").filter({ hasText: "greeting.ts" });
    await greetingRow.click();

    // F2 is owned by the capture-phase shortcut dispatcher in main, which must
    // win over any tree handler (one rename path, never two modals).
    await page.keyboard.press("F2");
    await expect(page.locator(".modal input")).toHaveValue("greeting.ts");
    await expect(page.locator(".modal")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal")).toHaveCount(0);

    // Closing a modal returns focus to the document, so re-focus the tree
    // before a tree-scoped key (Delete) can reach it.
    await greetingRow.click();
    await page.keyboard.press("Delete");
    await expect(page.locator(".modal")).toHaveCount(1);
    await expect(page.locator(".modal-title")).toHaveText("Delete");
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal")).toHaveCount(0);
  });
});

test.describe("Explorer type-ahead safety", () => {
  test("Backspace edits an active type-ahead instead of arming a delete", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");
    await tree.locator(".explorer-row").filter({ hasText: "greeting.ts" }).click();

    // Start a name search, then correct it: this must never open a confirm.
    await page.keyboard.type("hel");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-name")))
      .toBe("hello.txt");
    await page.keyboard.press("Backspace");
    await expect(page.locator(".modal")).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    // Buffer is empty again; still no destructive dialog.
    await expect(page.locator(".modal")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-name"))).toBe("hello.txt");

    // With no buffer, Backspace is a delete again (confirm-guarded).
    await page.keyboard.press("Backspace");
    await expect(page.locator(".modal-title")).toHaveText("Delete");
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal")).toHaveCount(0);
  });

  test("navigation ends the type-ahead buffer", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");
    await tree.locator(".explorer-row").filter({ hasText: "greeting.ts" }).click();

    await page.keyboard.type("h");
    const first = await page.evaluate(() => document.activeElement?.getAttribute("data-name"));
    expect(first).toBe("hello.txt");

    // An arrow key ends the search, so the next letter starts a new one rather
    // than extending the stale buffer (which would match nothing).
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("g");
    const afterNav = await page.evaluate(() => document.activeElement?.getAttribute("data-name"));
    expect(afterNav).toBe("greeting.ts");
  });
});

test.describe("Explorer create targets & delete confirmation", () => {
  // new-file / new-folder accelerators (shared/commands.ts): the File-menu
  // command path, which is where the wrong-target bug lived.
  const NEW_FILE = "Meta+Alt+KeyN";
  const NEW_FOLDER = "Meta+Alt+Shift+KeyN";

  test("New File lands in the selected folder, not the project root", async ({ page, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");

    const src = tree.locator(".explorer-row").filter({ hasText: "src" }).first();
    await src.click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-rel-path")))
      .toBe("src");

    await page.keyboard.press(NEW_FILE);
    const input = page.locator(".modal input");
    await expect(input).toBeVisible();
    await input.fill("created-in-src.ts");
    await page.locator(".modal .modal-btn").filter({ hasText: "OK" }).click();

    await expect(tree.getByText("created-in-src.ts")).toBeVisible({ timeout: 10_000 });
    // It must exist inside src, and must not have landed at the root.
    expect(existsSync(join(projectRoot, "src", "created-in-src.ts"))).toBe(true);
    expect(existsSync(join(projectRoot, "created-in-src.ts"))).toBe(false);
  });

  test("New Folder with a file selected uses that file's parent", async ({ page, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");

    await tree.locator(".explorer-row").filter({ hasText: "src" }).first().click();
    await expect(tree.getByText("index.ts")).toBeVisible({ timeout: 10_000 });
    await tree.locator(".explorer-row").filter({ hasText: "index.ts" }).click();

    await page.keyboard.press(NEW_FOLDER);
    const input = page.locator(".modal input");
    await expect(input).toBeVisible();
    await input.fill("beside-index");
    await page.locator(".modal .modal-btn").filter({ hasText: "OK" }).click();

    await expect(tree.getByText("beside-index")).toBeVisible({ timeout: 10_000 });
    expect(existsSync(join(projectRoot, "src", "beside-index"))).toBe(true);
    expect(existsSync(join(projectRoot, "beside-index"))).toBe(false);
  });

  test("New File with nothing selected still targets the project root", async ({ page, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");

    // Nothing is selected on a fresh boot, so the create target is the root.
    // (Deliberately no click: clicking the root row would toggle it collapsed.)
    await page.keyboard.press(NEW_FILE);
    const input = page.locator(".modal input");
    await expect(input).toBeVisible();
    await input.fill("root-level.ts");
    await page.locator(".modal .modal-btn").filter({ hasText: "OK" }).click();

    await expect(tree.getByText("root-level.ts")).toBeVisible({ timeout: 10_000 });
    expect(existsSync(join(projectRoot, "root-level.ts"))).toBe(true);
  });

  test("delete confirmation names the kind and warns a folder delete is recursive", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const tree = page.locator("#explorer-tree");

    // A file reads as a file.
    await tree.locator(".explorer-row").filter({ hasText: "greeting.ts" }).click();
    await page.keyboard.press("Delete");
    await expect(page.locator(".modal-body")).toContainText('Delete file "greeting.ts"?');
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal")).toHaveCount(0);

    // A folder must say its contents go too.
    await tree.locator(".explorer-row").filter({ hasText: "src" }).first().click();
    await page.keyboard.press("Delete");
    await expect(page.locator(".modal-body")).toContainText("Delete folder");
    await expect(page.locator(".modal-body")).toContainText("everything inside it");
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal")).toHaveCount(0);
  });
});
