import { test, expect } from "./fixtures.ts";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import type { editor } from "monaco-editor";
import type { PlanTask, WorkAttentionItem } from "../../shared/types.ts";
import { activeProject, savedPlanProject } from "./saved-plan-project.ts";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";

type EditorWindow = Window & { __editorMgr: {
  editor: editor.IStandaloneCodeEditor;
  openFile(path: string, options: { preview: boolean }): Promise<void>;
  flushDrafts(): Promise<boolean>;
} };

async function identities(page: Page) {
  return page.evaluate(async () => (await window.termina.getInstances())
    .map(({ id, cwd, generation, projectId, workspaceId }) => ({ id, cwd, generation, projectId, workspaceId }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

function withoutModel({ model: _model, ...item }: WorkAttentionItem) { return item; }
function attentionRow(page: Page, item: WorkAttentionItem) {
  return page.locator(`#attention-list .attention-item[data-id="${item.id}"]`);
}
async function waitForAttention(page: Page) {
  await expect(page.locator("#project-bar #attention-view")).toBeVisible();
  await expect(page.locator("#attention-heading")).toContainText("Attention");
  await expect(page.locator("#attention-heading .attention-count")).toHaveText(/^\d+$/);
  await expect(page.locator("#attention-status")).not.toContainText("Loading");
}

// Saved results are navigation-only: no provider request may execute a task.
test.describe("Result pending review", () => {
  let server: Server;
  let calls = 0;
  const previous = new Map<string, string | undefined>();

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) { response.writeHead(404).end(); return; }
      request.resume();
      request.on("end", () => {
        calls++;
        response.writeHead(500).end("Task execution is not part of pending-review navigation");
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("missing loopback port"));
        resolve(address.port);
      });
    });
    for (const [key, value] of Object.entries({
      TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol",
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`,
      OPENAI_API_KEY: "synthetic-pending-review-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    })) { previous.set(key, process.env[key]); process.env[key] = value; }
  });
  test.beforeEach(() => { calls = 0; });
  test.afterAll(async () => {
    try {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  test("a saved completed shared-file result in a same-name background project remains pending during Attention browsing and native Plan Board navigation", async ({ page, projectRoot, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const completed: PlanTask = { text: "Recorded <shared> result & historical worker", paths: ["hello.txt"], state: "done",
      dispatchResult: { workerId: "term-901", outcome: "completed" } };
    const target = await savedPlanProject(page, projectRoot, runRoot, 1, [[completed]]);
    const current = await savedPlanProject(page, projectRoot, runRoot, 2, [[{ text: completed.text, paths: ["hello.txt"], state: "done" }]]);
    expect(basename(target.project.cwd)).toBe(basename(current.project.cwd));
    expect(target.project.cwd).not.toBe(current.project.cwd);
    const ownerId = target.owners[0]!;
    const draftPath = join(current.project.cwd, "greeting.ts");
    const disk = await readFile(draftPath, "utf8");
    const draft = "// inspection must not save this draft\n";
    await page.evaluate((path) => (window as unknown as EditorWindow).__editorMgr.openFile(path, { preview: false }), draftPath);
    expect(await page.evaluate((text) => {
      const editor = (window as unknown as EditorWindow).__editorMgr.editor;
      return editor.executeEdits("pending-review-test", [{ range: editor.getModel()!.getFullModelRange(), text }]);
    }, draft)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.flushDrafts())).toBe(true);
    const beforeInstances = await identities(page);
    const beforePlan = await page.evaluate((id) => window.termina.getPlan(id), ownerId);
    const rosterBefore = JSON.parse(await readFile(target.roster, "utf8")) as { terminals: Array<{ plan?: PlanTask[] }> };
    const before = await page.evaluate(() => window.termina.getWorkOverview());
    expect(before.items).toHaveLength(1);
    const item = before.items[0]!;
    expect(item).toMatchObject({ projectId: target.project.id, terminalId: ownerId, taskText: completed.text, reason: "pending-review",
      workArea: { root: target.project.cwd, kind: "project" }, action: { kind: "plan", terminalId: ownerId } });
    expect(item.candidate).toBeUndefined();
    await waitForAttention(page);
    expect(await activeProject(page)).toMatchObject({ id: current.project.id, activationGeneration: current.project.activationGeneration });
    const row = attentionRow(page, item);
    await expect(row).toContainText("Result pending review");
    await expect(row).toContainText(/review.*not recorded/i);
    await expect(row).not.toContainText(/not applied|unapplied/i);
    await expect(row).toContainText(target.project.cwd);
    await expect(row).toContainText("Shared project files");
    await expect(row.getByRole("button", { name: /Accept|Resolve|Mark reviewed/ })).toHaveCount(0);
    await expect(page.locator("#project-work-inspector, #project-details")).toHaveCount(0);
    expect(await activeProject(page)).toMatchObject({ id: current.project.id, activationGeneration: current.project.activationGeneration });
    expect(await identities(page)).toEqual(beforeInstances);
    expect(await page.evaluate((id) => window.termina.getPlan(id), ownerId)).toEqual(beforePlan);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.items.map(withoutModel));
    expect(await readFile(draftPath, "utf8")).toBe(disk);
    expect(await page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe(draft);
    expect(calls).toBe(0);
    await row.getByRole("button", { name: "Open plan", exact: true }).click();
    await expect.poll(() => page.evaluate((id) => (window as unknown as {
      __panes: Map<string, { tabEl: HTMLElement }>;
    }).__panes.get(id)?.tabEl.classList.contains("active"), ownerId)).toBe(true);
    const task = page.locator("#plan-list .plan-task").filter({ hasText: completed.text });
    await expect(task).toBeFocused();
    await expect(task.locator(".plan-dispatch-result")).toHaveText(`last completed · ${completed.dispatchResult!.workerId}`);
    await expect(page.locator("#attention-view")).toBeVisible();
    expect((await activeProject(page)).id).toBe(target.project.id);
    await expect(page.locator("#plan-list")).toContainText(completed.text);
    expect(await page.evaluate((id) => window.termina.getPlan(id), ownerId)).toEqual(beforePlan);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.items.map(withoutModel));
    expect((JSON.parse(await readFile(target.roster, "utf8")) as typeof rosterBefore).terminals.map((terminal) => terminal.plan))
      .toEqual(rosterBefore.terminals.map((terminal) => terminal.plan));
    expect(await identities(page)).toEqual(beforeInstances);
    expect(await readFile(draftPath, "utf8")).toBe(disk);
    await page.locator(`#project-tabs .project-tab[data-project-id="${current.project.id}"] .project-select`).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe(draft);
    await expect(page.locator(".editor-tab .tab-dirty")).toBeVisible();
    expect(await readFile(draftPath, "utf8")).toBe(disk);
    expect(calls).toBe(0);
  });

  test("marked done, idle with no worker and a passing owner check are not completed dispatch results", async ({ page, projectRoot, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const tasks: PlanTask[] = [
      { text: "Marked done without an attempt", paths: ["hello.txt"], state: "done" },
      { text: "Pending with no worker", paths: ["greeting.ts"], state: "pending" },
      { text: "Idle task with modified paths and no live assignment", paths: ["hello.txt"], state: "pending" },
      { text: "Marked done but the recorded attempt is incomplete", paths: ["hello.txt"], state: "done",
        dispatchResult: { workerId: "term-902", outcome: "incomplete" } },
    ];
    const target = await savedPlanProject(page, projectRoot, runRoot, 1, [tasks]);
    const ownerId = target.owners[0]!;
    await writeFile(join(target.project.cwd, "hello.txt"), "Modified paths are not completed dispatch results\n");
    await writeFile(join(target.project.cwd, ".gitignore"), "/stages.jsonl\nnode_modules/\n");
    await writeVerifyPackage(target.project.cwd, { test: "termina-verify-fixture pass" });
    expect(await page.evaluate((id) => window.termina.runVerify(id), ownerId)).toEqual({ ok: true });
    await expect.poll(() => page.evaluate(async (id) => (await window.termina.getInstances()).find((instance) => instance.id === id)?.verify, ownerId))
      .toMatchObject({ state: "pass", result: { state: "pass", exitCode: 0 } });
    const overview = await page.evaluate(() => window.termina.getWorkOverview());
    const owner = overview.projects.find((project) => project.projectId === target.project.id)!.terminals.find((terminal) => terminal.terminalId === ownerId)!;
    expect(owner.activity?.state).toBe("idle");
    // Test-fixture Git proves the source is changed; trackedChanges is the
    // agent's tool ledger and does not count this external filesystem write.
    expect(execFileSync("git", ["diff", "--name-only"], { cwd: target.project.cwd, encoding: "utf8" })
      .trim().split("\n")).toContain("hello.txt");
    expect(owner.tasks.map((task) => task.worker)).toEqual([null, null, null, null]);
    expect(owner.tasks.flatMap((task) => task.attention)).not.toContain("pending-review");
    expect(overview.items.filter((item) => item.reason === "pending-review")).toEqual([]);
    await waitForAttention(page);
    await expect(page.locator("#attention-list")).not.toContainText("Result pending review");
    await page.keyboard.press("Escape");
    await page.locator(".activity-tab[data-tab='plan']").click();
    await expect(page.locator("#plan-list .plan-task")).toHaveCount(tasks.length);
    await expect(page.locator("#plan-list .plan-task").filter({ hasText: tasks[0]!.text })).toHaveClass(/state-done/);
    await expect(page.locator("#attention-view")).toBeVisible();
    await expect(page.locator("#project-work-inspector, #project-details")).toHaveCount(0);
    expect(await page.evaluate((id) => window.termina.getPlan(id), ownerId)).toEqual(tasks);
    expect(await readVerifyStages(target.project.cwd)).toHaveLength(1);
    expect(calls).toBe(0);
  });

});
