import { test, expect } from "./fixtures.ts";

test.describe("Worldlines IPC & State Management E2E", () => {
  test("lists worldlines and queries runs for active project", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    // 1. Get active project ID
    const activeProject = await page.evaluate(async () => {
      const projects = await (window as any).pi.projectList();
      return projects.find((p: any) => p.active) ?? projects[0];
    });

    expect(activeProject).toBeTruthy();
    expect(activeProject.id).toBeTruthy();

    // 2. Query worldlines for active project
    const worldlines = await page.evaluate(async (projectId) => {
      return (window as any).pi.getWorldlines(projectId);
    }, activeProject.id);

    expect(Array.isArray(worldlines)).toBe(true);

    // 3. Query runs for terminal
    const runs = await page.evaluate(async () => {
      return (window as any).pi.getRuns("term-1");
    });

    expect(Array.isArray(runs)).toBe(true);
  });

  test("rejects invalid worldline actions gracefully", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    // Calling forkRun with a nonexistent run ID must return ok: false or fail safely
    const forkResult = await page.evaluate(async () => {
      try {
        return await (window as any).pi.forkRun("nonexistent-run-id");
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    });
    expect(forkResult.ok).toBe(false);

    // Calling discardWorldline with a nonexistent comparison ID must return ok: false or fail safely
    const discardResult = await page.evaluate(async () => {
      try {
        return await (window as any).pi.discardWorldline("nonexistent-comparison");
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    });
    expect(discardResult.ok).toBe(false);

    // Calling cancelWorldline with a nonexistent comparison ID
    const cancelResult = await page.evaluate(async () => {
      try {
        return await (window as any).pi.cancelWorldline("nonexistent-comparison");
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    });
    expect(cancelResult.ok).toBe(false);

    // Calling forkPoint with invalid sequence
    const forkPointResult = await page.evaluate(async () => {
      try {
        return await (window as any).pi.forkPoint("term-1", 999999);
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    });
    expect(forkPointResult.ok).toBe(false);

    // Calling promoteWorldline on invalid comparison
    const promoteResult = await page.evaluate(async () => {
      try {
        return await (window as any).pi.promoteWorldline("nonexistent-comparison", "A", false);
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    });
    expect(promoteResult.ok).toBe(false);
  });

  test("handles candidate details and base file queries safely", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    // Querying non-existent details returns { ok: false } or null without crashing
    const details = await page.evaluate(async () => {
      try {
        return await (window as any).pi.getWorldlineDetails("nonexistent-comparison", "A");
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    });
    expect(details === null || details.ok === false).toBe(true);

    // Querying non-existent file
    const fileContent = await page.evaluate(async () => {
      try {
        return await (window as any).pi.getWorldlineFile("nonexistent-comparison", "A", "test.txt");
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    });
    expect(fileContent === null || fileContent.ok === false).toBe(true);

    // Querying non-existent base file
    const baseContent = await page.evaluate(async () => {
      try {
        return await (window as any).pi.getWorldlineBaseFile("nonexistent-comparison", "test.txt");
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    });
    expect(baseContent === null || baseContent.ok === false).toBe(true);
  });
});
