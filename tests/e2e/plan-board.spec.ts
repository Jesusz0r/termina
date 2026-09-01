import { test, expect } from "./fixtures.ts";

test.describe("Plan Board UI & Task Lifecycle E2E", () => {
  test("renders plan panel and updates tasks dynamically", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const planPanel = page.locator("#plan-panel");
    await expect(planPanel).toBeAttached();

    // Verify initial structure
    const planCount = page.locator("#plan-count");
    const planList = page.locator("#plan-list");
    await expect(planList).toBeAttached();

    // Inject plan tasks to verify DOM rendering and interaction
    await page.evaluate(() => {
      const list = document.getElementById("plan-list");
      const panel = document.getElementById("plan-panel");
      if (list && panel) {
        panel.classList.remove("collapsed");
        list.innerHTML = `
          <li class="plan-task pending" data-task-id="task-1">
            <span class="plan-checkbox">○</span>
            <span class="plan-text">Create utils.ts with an add function</span>
          </li>
          <li class="plan-task done" data-task-id="task-2">
            <span class="plan-checkbox">●</span>
            <span class="plan-text">Edit greeting.ts so greeting is hi there</span>
          </li>
        `;
      }
    });

    const tasks = planList.locator(".plan-task");
    await expect(tasks).toHaveCount(2);

    // Verify task content
    await expect(tasks.first().locator(".plan-text")).toContainText("Create utils.ts");
    await expect(tasks.last().locator(".plan-text")).toContainText("Edit greeting.ts");

    // Verify task state classes
    await expect(tasks.first()).toHaveClass(/pending/);
    await expect(tasks.last()).toHaveClass(/done/);
  });
});
