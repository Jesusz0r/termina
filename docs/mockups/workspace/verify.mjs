import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { chromium, expect } from "@playwright/test";

const directory = dirname(fileURLToPath(import.meta.url));
const url = new URL("index.html", import.meta.url).href;
const screenshots = process.argv.includes("--screenshots");
const browser = await chromium.launch();
const errors = [];
const externalRequests = [];
let checks = 0;

async function check(label, action) {
  await action();
  checks++;
  console.log(`PASS ${label}`);
}

try {
  const page = await browser.newPage({ viewport: { width: 1512, height: 1100 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", (request) => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);

  await check("overview identifies three projects, six tasks, and two outstanding decisions", async () => {
    await expect(page.locator(".project-link")).toHaveCount(3);
    await expect(page.locator(".task-card")).toHaveCount(6);
    await expect(page.locator(".attention-card")).toHaveCount(2);
    await expect(page.locator(".attention-card").first()).toHaveAttribute("data-task", "cancel");
    await expect(page.locator("#inspector")).toContainText("Add upload cancellation");
  });
  if (screenshots) await page.screenshot({ path: resolve(directory, "overview.png"), fullPage: true });

  await check("project filtering preserves global attention and does not stop simulated work", async () => {
    await page.locator('[data-project="termina"]').first().click();
    await expect(page.locator(".task-card")).toHaveCount(2);
    await expect(page.locator(".attention-card")).toHaveCount(2);
    await expect(page.locator("#work-summary")).toContainText("4 working");
    await page.locator('[data-action="overview"]').click();
  });

  await check("review opens the owning task, terminal, files, and sample evidence together", async () => {
    await page.locator('.attention-card[data-task="checkout"]').click();
    await page.getByRole("button", { name: "Review 3 changed files →", exact: true }).click();
    await expect(page.locator("#breadcrumb")).toContainText("STOREFRONT");
    await expect(page.locator(".focus-panel-title").first()).toContainText("Agent 03");
    await expect(page.locator(".file-entry")).toHaveCount(3);
    await expect(page.locator(".diff-code")).toContainText("idempotencyKey");
    await page.locator('[data-file="1"]').click();
    await expect(page.locator(".diff-code")).toContainText("Sample test excerpt");
    await page.locator('[data-file="0"]').click();
  });
  if (screenshots) await page.screenshot({ path: resolve(directory, "focus.png"), fullPage: true });

  await check("inspection shows sample evidence honestly and dialogs return keyboard focus", async () => {
    const trigger = page.locator('#inspector [data-action="checks"]');
    await trigger.click();
    await expect(page.locator("#info-dialog")).toContainText("illustrative—not evidence from a real run");
    await page.keyboard.press("Escape");
    await expect(page.locator("#info-dialog")).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  await check("marking review removes only that outstanding item, without applying files", async () => {
    await page.locator('[data-action="mark-reviewed"]').click();
    await expect(page.locator(".attention-card")).toHaveCount(1);
    await expect(page.locator("#inspector")).toContainText("No files were applied, staged, or committed");
  });

  await check("a cross-project decision in Focus also updates the selected project", async () => {
    await page.locator('.attention-card[data-task="cancel"]').click();
    await expect(page.locator('.project-link[data-project="platform"]')).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#breadcrumb")).toContainText("PLATFORM-API");
    await expect(page.locator(".focus-panel-title").first()).toContainText("Agent 05");
    await page.locator('[data-action="decide"]').click();
    await page.locator('[data-decision="idempotent"]').click();
    await expect(page.locator("#inspector")).toContainText("Decision recorded: 204");
    await expect(page.locator(".attention-card")).toHaveCount(0);
  });

  await check("sample follow-ups render as text, not HTML or executable content", async () => {
    await page.locator('[aria-label="Sample follow-up"]').fill('<img src=x onerror="alert(1)">');
    await page.locator("#follow-up-form button").click();
    await expect(page.locator(".terminal-output")).toContainText('<img src=x onerror="alert(1)">');
    await expect(page.locator(".terminal-output img")).toHaveCount(0);
  });

  await page.locator('[data-scenario="overlap"]').click();
  if (screenshots) await page.screenshot({ path: resolve(directory, "overlap.png"), fullPage: true });
  await check("overlap resolution queues rather than pretending a sandbox or process exists", async () => {
    await expect(page.locator("#inspector")).toContainText("competing writers");
    await page.locator('[data-action="separate"]').click();
    await expect(page.locator("#inspector")).toContainText("No actual copy or sandbox has been created");
    await page.locator('[data-action="start-sample"]').click();
    await expect(page.locator("#inspector")).toContainText("No live agent or process was started");
  });

  await check("restart requires explicit inspection and preserves stale verification", async () => {
    await page.locator('[data-scenario="recovery"]').click();
    await expect(page.locator("#inspector")).toContainText("Previous check is stale");
    await page.locator('[data-action="resume"]').click();
    await expect(page.locator("#info-dialog")).toContainText("unsaved editor drafts");
    await page.locator('[data-action="confirm-resume"]').click();
    await expect(page.locator("#inspector")).toContainText("Previous checks remain stale");
  });

  await check("first run works without credentials and can queue a clearly attributed sample task", async () => {
    await page.locator('[data-scenario="empty"]').click();
    await expect(page.locator(".project-link")).toHaveCount(0);
    await expect(page.locator("#work-content")).toContainText("Files and a shell are useful even before a provider is connected");
    await page.getByRole("button", { name: "Open sample project", exact: true }).click();
    await page.locator('[data-action="new-task"]').click();
    await page.locator("#task-goal").fill("   ");
    await page.getByRole("button", { name: "Queue sample task", exact: true }).click();
    assert.equal(await page.locator("#task-dialog").evaluate((dialog) => dialog.open), true);
    await page.locator("#task-goal").fill("Investigate long project names <script>alert(1)</script>");
    await page.getByRole("button", { name: "Queue sample task", exact: true }).click();
    await expect(page.locator(".task-card")).toHaveCount(1);
    await expect(page.locator("#inspector")).toContainText("No agent has started");
    await expect(page.locator("#inspector script")).toHaveCount(0);
    await page.locator('[data-action="view-focus"]').click();
    await expect(page.locator(".diff-code")).toHaveAttribute("aria-label", "Sample diff for No file changes yet");
  });

  await check("workspace search is keyboard-accessible and opens the correct task", async () => {
    await page.locator('[data-scenario="normal"]').click();
    await page.keyboard.press("Control+k");
    await expect(page.locator("#workspace-search")).toBeFocused();
    await page.locator("#workspace-search").fill("pagination");
    await expect(page.locator(".jump-result")).toHaveCount(1);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.locator("#inspector")).toContainText("Cover cursor pagination boundaries");
    await expect(page.locator("#breadcrumb")).toContainText("PLATFORM-API");
  });

  await check("desktop, tablet, and narrow layouts have no page-level horizontal overflow", async () => {
    for (const width of [1512, 1280, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 982 });
      for (const scenario of ["normal", "overlap", "recovery", "empty"]) {
        await page.locator(`[data-scenario="${scenario}"]`).click();
        const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(dimensions.scroll <= dimensions.width + 1, `${width}px / ${scenario}: ${JSON.stringify(dimensions)}`);
      }
      await page.locator('[data-scenario="normal"]').click();
      await page.locator('[data-action="view-focus"]').click();
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(scroll <= width + 1, `${width}px / focus overflow: ${scroll}`);
    }
  });

  await check("light and high-contrast production tokens remain usable; reduced motion is respected", async () => {
    for (const theme of ["light", "high-contrast"]) {
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      await expect(page.locator(".primary-button").first()).toBeVisible();
      assert.ok(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--accent").trim()));
    }
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
  });

  assert.deepEqual(errors, [], "Browser/CSP errors");
  assert.deepEqual(externalRequests, [], "The mockup must not use the network");
  console.log(`\n${checks} browser checks passed. No browser/CSP errors or external requests.`);
} finally {
  await browser.close();
}
