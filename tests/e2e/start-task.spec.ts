import { test, expect } from "./fixtures.ts";
import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { editor } from "monaco-editor";
import type { PlanTask, PlanTaskStartRequest } from "../../shared/types.ts";
import { activeProject, savedPlanProject } from "./saved-plan-project.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

const taskText = "Start only this selected task: update hello.txt";
const busyMarker = "explicit-start-owner-busy-fixture";
type EditorWindow = Window & { __editorMgr: {
  editor: editor.IStandaloneCodeEditor;
  openFile(path: string, options: { preview: boolean }): Promise<void>;
  flushDrafts(): Promise<boolean>;
} };
function complete(response: ServerResponse, text: string, name: string, args: Record<string, string>) {
  const id = `start-${name}-${Date.now()}`;
  const item = { type: "function_call", id, call_id: id, name, arguments: JSON.stringify(args) };
  response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
  response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item], usage: {} } })}\n\n`);
}
async function identities(page: Page) {
  return page.evaluate(async () => (await window.termina.getInstances()).map(({ id, cwd, generation }) => ({ id, cwd, generation })));
}
async function currentTarget(page: Page, projectId: string, terminalId: string, text: string): Promise<PlanTaskStartRequest> {
  const project = (await page.evaluate(() => window.termina.getWorkOverview())).projects.find((entry) => entry.projectId === projectId)!;
  const owner = project.terminals.find((entry) => entry.terminalId === terminalId)!;
  const task = owner.tasks.find((entry) => entry.task.text === text)!.task;
  return { projectRoot: project.root, owner: { projectId, terminalId, generation: owner.generation,
    workspaceId: owner.workArea!.workspaceId, root: owner.workArea!.root }, task };
}

test.describe("Explicit inspector task start", () => {
  let server: Server;
  let workerCalls = 0;
  let workerPending = false;
  let ownerCalls = 0;
  let ownerPending = false;
  const previous = new Map<string, string | undefined>();
  test.beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) { response.writeHead(404).end(); return; }
      let body = "";
      request.on("data", (chunk) => { body += chunk.toString(); });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (body.includes(busyMarker)) {
          if (++ownerCalls === 1) complete(response, "Read the source while the owner is running.", "read_file", { path: "hello.txt" });
          else { response.flushHeaders(); ownerPending = true; }
        } else if (++workerCalls === 1) {
          complete(response, "Read the assigned source before replacing it.", "read_file", { path: "hello.txt" });
        } else if (workerCalls === 2) {
          complete(response, "Write only the selected task's source.", "write_file", { path: "hello.txt", content: "explicit selected worker\n" });
        } else { response.flushHeaders(); workerPending = true; }
      });
    });
    const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing loopback port");
      resolve(address.port);
    }));
    for (const [key, value] of Object.entries({ TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol",
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-loopback-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` })) {
      previous.set(key, process.env[key]); process.env[key] = value;
    }
  });
  test.beforeEach(() => { workerCalls = 0; ownerCalls = 0; workerPending = false; ownerPending = false; });
  test.afterAll(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  for (const zoomed of [false, true]) {
    test(`creates then explicitly starts one background task${zoomed ? " with keyboard at native 200 percent zoom" : " with repeated clicks"}`, async ({ page, projectRoot, runRoot, electronApp }) => {
      await expect(page.locator("#splash")).toBeHidden();
      const unrelated: PlanTask = { text: "Another pending task on another board", paths: ["greeting.ts"], state: "pending" };
      const target = await savedPlanProject(page, projectRoot, runRoot, 1, [[unrelated], []]);
      const current = await savedPlanProject(page, projectRoot, runRoot, 2);
      await writeFile(join(target.project.cwd, "hello.txt"), "before explicit dispatch\n");
      const draftPath = join(current.project.cwd, "greeting.ts");
      const disk = await readFile(draftPath, "utf8");
      await page.evaluate((path) => (window as unknown as EditorWindow).__editorMgr.openFile(path, { preview: false }), draftPath);
      const draft = "// preserved draft during background start\n";
      expect(await page.evaluate((text) => {
        const editor = (window as unknown as EditorWindow).__editorMgr.editor;
        return editor.executeEdits("explicit-start-test", [{ range: editor.getModel()!.getFullModelRange(), text }]);
      }, draft)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.flushDrafts())).toBe(true);
      if (zoomed) await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setSize(1000, 850); window.webContents.setZoomFactor(2);
      });
      const before = await identities(page);
      await page.locator("#btn-all-projects").click();
      await page.locator(".overview-new-task").click();
      const form = page.locator(".overview-task-composer");
      await form.getByRole("combobox", { name: "Project", exact: true }).selectOption(target.project.id);
      const board = form.getByRole("combobox", { name: "Plan Board", exact: true });
      const option = board.locator("option").filter({ hasText: `${target.owners[1]} ·` });
      await expect(option).toHaveCount(1);
      await board.selectOption((await option.getAttribute("value"))!);
      await form.getByLabel("Outcome", { exact: true }).fill(taskText);
      await form.getByRole("button", { name: "Create task", exact: true }).click();
      const inspector = page.locator("#project-work-inspector");
      await expect(inspector.locator(".overview-inspector-title")).toHaveText(taskText);
      expect(await identities(page)).toEqual(before);
      expect(workerCalls).toBe(0);
      const start = inspector.getByRole("button", { name: "Start task", exact: true });
      await expect(start).toBeEnabled();
      await expect(inspector.locator(".overview-inspector-start-status")).toContainText("shared project files");
      await start.scrollIntoViewIfNeeded();
      if (zoomed) { await start.focus(); await page.keyboard.press("Enter"); }
      else await start.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect.poll(() => workerPending).toBe(true);
      const plan = await page.evaluate((id) => window.termina.getPlan(id), target.owners[1]!);
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({ text: taskText, state: "active", paths: ["hello.txt"] });
      const workerId = plan[0]!.workerId!;
      const instances = await page.evaluate(() => window.termina.getInstances());
      expect(instances.filter((instance) => !before.some((entry) => entry.id === instance.id))).toHaveLength(1);
      expect(instances.find((instance) => instance.id === workerId)).toMatchObject({ dispatchWorker: true,
        projectId: target.project.id, cwd: target.project.cwd, busy: true });
      expect(await page.evaluate((id) => window.termina.getPlan(id), target.owners[0]!)).toEqual([unrelated]);
      for (const id of current.owners) expect(await page.evaluate((id) => window.termina.getPlan(id), id)).toEqual([]);
      expect((await activeProject(page)).id).toBe(current.project.id);
      expect(await readFile(join(target.project.cwd, "hello.txt"), "utf8")).toBe("explicit selected worker\n");
      expect(await readFile(draftPath, "utf8")).toBe(disk);
      await expect(inspector).toContainText(workerId);
      await expect(inspector).toContainText("working");
      await expect(inspector).toContainText("Shared project files");
      await expect(start).toBeHidden();
      expect(await inspector.locator(".overview-inspector-facts").textContent()).not.toMatch(/separate candidate|task completed|reviewed/i);
      await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
      await expect(page.locator("#attention-view")).toBeHidden();
      expect(await page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe(draft);
      await expect(page.locator(".editor-tab .tab-dirty")).toBeVisible();
    });
  }

  test("rejects stale snapshots and a busy owner without interrupting, retargeting or starting a worker", async ({ page, projectRoot, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const pending: PlanTask = { text: taskText, paths: ["hello.txt"], state: "pending" };
    const target = await savedPlanProject(page, projectRoot, runRoot, 1, [[pending]]);
    const request = await currentTarget(page, target.project.id, target.owners[0]!, taskText);
    const before = await identities(page);
    for (const invalid of [
      { ...request, owner: { ...request.owner, generation: request.owner.generation + 1 } },
      { ...request, owner: { ...request.owner, root: join(request.owner.root, "wrong") } },
      { ...request, task: { ...request.task, paths: ["greeting.ts"] } },
      { ...request, projectRoot: join(request.projectRoot, "wrong") },
    ]) expect(await page.evaluate((value) => window.termina.startPlanTask(value), invalid)).toMatchObject({ ok: false });
    expect(await identities(page)).toEqual(before);
    expect(workerCalls).toBe(0);
    await page.locator("#btn-all-projects").click();
    await page.locator(".overview-work-card").filter({ hasText: taskText }).locator(".overview-inspect").click();
    const start = page.locator("#project-work-inspector").getByRole("button", { name: "Start task", exact: true });
    await expect(start).toBeEnabled();
    const sidecar = join(runRoot, "events", `${target.owners[0]}.jsonl`);
    await expect.poll(() => existsSync(sidecar) && readFileSync(sidecar, "utf8").split("\n").some((line) => {
      const record = parseSidecarRecord(line); return record?.t === "session_ready" && record.ok === true;
    }), { timeout: 15_000 }).toBe(true);
    await page.evaluate(({ id, text }) => window.termina.writeTerminal(id, `${text}\r`), { id: target.owners[0]!, text: busyMarker });
    await expect.poll(() => ownerPending).toBe(true);
    await expect(start).toBeDisabled();
    await expect(page.locator(".overview-inspector-start-status")).toContainText("busy");
    await start.evaluate((button) => (button as HTMLButtonElement).click());
    expect(await page.evaluate((value) => window.termina.startPlanTask(value), request)).toMatchObject({ ok: false });
    expect(await identities(page)).toEqual(before);
    expect(workerCalls).toBe(0);
    expect(await page.evaluate((id) => window.termina.getPlan(id), target.owners[0]!)).toEqual([pending]);
    expect((await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === target.owners[0])?.busy).toBe(true);
  });
});
