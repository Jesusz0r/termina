import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import type { Page } from "@playwright/test";
import type { editor as MonacoEditor } from "monaco-editor";

type EditorProbe = { activeKey: string; editor: MonacoEditor.IStandaloneCodeEditor; flushDrafts(): Promise<boolean> };

async function editDraft(page: Page, name: string, text: string): Promise<void> {
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: name }).dblclick();
  await expect.poll(() => page.evaluate(file => (window as unknown as { __editorMgr: EditorProbe }).__editorMgr.activeKey?.endsWith(`/${file}`), name)).toBe(true);
  expect(await page.evaluate(content => {
    const manager = (window as unknown as { __editorMgr: EditorProbe }).__editorMgr;
    const model = manager.editor.getModel();
    if (!model) return false;
    return manager.editor.executeEdits("restore-test", [{ range: model.getFullModelRange(), text: content }]);
  }, text)).toBe(true);
  await expect(page.locator(".editor-tab").filter({ hasText: name }).locator(".tab-dirty")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __editorMgr: EditorProbe }).__editorMgr.flushDrafts())).toBe(true);
}

let server: Server;
let calls = 0;
let held: ServerResponse | null = null;
const previous = new Map<string, string | undefined>();

function complete(response: ServerResponse, index: number): void {
  const first = index <= 3;
  const step = (index - 1) % 3;
  const name = step === 0 ? "edit" : "bash";
  const input = step === 0 ? { path: "hello.txt", old_text: first ? "hello\n" : "first\n", new_text: first ? "first\n" : "second\n" }
    : { command: `test $(cat hello.txt) = ${first ? "first" : "second"}` };
  const output = step === 2 ? [] : [{ type: "function_call", id: `call-${index}`, call_id: `call-${index}`, name, arguments: JSON.stringify(input) }];
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  if (step === 2) response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "The requested file change was verified." })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
    } else if (request.method === "POST" && request.url?.endsWith("/responses")) {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (++calls === 6) held = response;
        else complete(response, calls);
      });
    } else response.writeHead(404).end();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing loopback port"));
      resolve(address.port);
    });
  });
  for (const [key, value] of Object.entries({
    TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_CORE_APPROVE: "all",
    TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-timeline-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  })) { previous.set(key, process.env[key]); process.env[key] = value; }
});

test.afterAll(async () => {
  try {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("restores only captured file bytes, protects unsaved buffers, and keeps the live session", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const owner = (await page.evaluate(() => window.termina.getInstances())).find(instance => instance.type === "agent")!;
  const sidecar = join(runRoot, "events", `${owner.id}.jsonl`);
  const records = () => existsSync(sidecar) ? readFileSync(sidecar, "utf8").split("\n").map(parseSidecarRecord).filter(record => record !== null) : [];
  const runs = () => page.evaluate(id => window.termina.getRuns(id), owner.id);
  const timeline = () => page.evaluate(id => window.termina.getTimeline(id), owner.id);
  await expect.poll(() => records().some(record => record.t === "session_ready")).toBe(true);
  await page.evaluate(id => window.termina.writeTerminal(id, "Change hello.txt to first and verify it.\r"), owner.id);
  await expect.poll(async () => (await runs()).filter(run => run.settledStateId).length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await timeline()).some(event => event.t === "tool" && event.relPath === "hello.txt" && !!event.stateId)).toBe(true);
  const moment = (await timeline()).find(event => event.t === "tool" && event.relPath === "hello.txt" && event.stateId)!;
  await page.evaluate(id => window.termina.writeTerminal(id, "Change hello.txt to second and verify it.\r"), owner.id);
  await expect.poll(() => held !== null, { timeout: 30_000 }).toBe(true);
  expect((await page.evaluate(({ id, generation, seq }) => window.termina.restoreTimelineFile(id, generation, seq), { id: owner.id, generation: owner.generation, seq: moment.seq })).ok).toBe(false);
  expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("second\n");
  complete(held!, 6); held = null;
  await expect.poll(async () => (await runs()).filter(run => run.settledStateId).length, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => (await page.evaluate(() => window.termina.getInstances())).find(instance => instance.id === owner.id)?.busy).toBe(false);
  const before = await runs();
  const sessionPath = before.at(-1)!.sessionFile!;
  const sessionBytes = readFileSync(sessionPath);
  const other = readFileSync(join(projectRoot, "greeting.ts"));

  await page.locator("#activity-tab-timeline").click();
  const dot = page.locator(`#timeline-dots .timeline-dot[data-seq='${moment.seq}']`);
  await dot.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __timelineTab: { content: string } }).__timelineTab?.content)).toBe("first\n");
  expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("second\n");
  await editDraft(page, "hello.txt", "my unsaved hello\n");
  await dot.click({ button: "right" });
  await page.locator(".context-menu-item", { hasText: "Restore captured file" }).click();
  const modal = page.locator(".modal");
  await expect(modal).toContainText("Unsaved changes");
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("second\n");
  await expect(page.locator(".editor-tab").filter({ hasText: "hello.txt" }).locator(".tab-dirty")).toBeVisible();

  await dot.focus();
  await page.keyboard.press("Shift+F10");
  await page.locator(".context-menu-item", { hasText: "Restore captured file" }).click();
  await expect(modal).toContainText("Unsaved changes");
  await modal.getByRole("button", { name: "Discard", exact: true }).click();
  await expect.poll(() => readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("first\n");
  expect(readFileSync(join(projectRoot, "greeting.ts"))).toEqual(other);

  await editDraft(page, "greeting.ts", "my unrelated unsaved draft\n");
  unlinkSync(join(projectRoot, "hello.txt"));
  await dot.click({ button: "right" });
  await page.locator(".context-menu-item", { hasText: "Restore captured file" }).click();
  await expect.poll(() => existsSync(join(projectRoot, "hello.txt")) ? readFileSync(join(projectRoot, "hello.txt"), "utf8") : "missing").toBe("first\n");
  await expect(page.locator(".editor-tab").filter({ hasText: "greeting.ts" }).locator(".tab-dirty")).toBeVisible();
  expect(readFileSync(join(projectRoot, "greeting.ts"))).toEqual(other);
  expect(readFileSync(sessionPath)).toEqual(sessionBytes);
  expect((await runs()).map(run => run.id)).toEqual(before.map(run => run.id));
  expect((await page.evaluate(() => window.termina.getInstances())).find(instance => instance.id === owner.id)).toMatchObject({ generation: owner.generation, busy: false });
  expect(records().filter(record => record.t === "agent_start")).toHaveLength(2);
  expect(calls).toBe(6);
});
