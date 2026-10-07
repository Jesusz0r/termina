import { test as base, expect, closeOwnedElectron, launchOwnedElectron } from "./fixtures.ts";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { sanitizeSessionDir } from "../../electron/main/project-workspace.ts";
import { rosterFilePath } from "../../electron/roster-store.ts";
import { writeVerifyPackage } from "../fixtures/verify-package.ts";

const test = base.extend({
  projectRoot: async ({ projectRoot }, use, testInfo) => {
    if (testInfo.title.includes("limited history")) {
      mkdirSync(join(projectRoot, "history"));
      for (let i = 0; i < 106; i++) writeFileSync(join(projectRoot, "history", `${i}.txt`), `historical file ${i}\n` + "x".repeat(70_000));
    } else writeFileSync(join(projectRoot, "oversize.txt"), "oversize historical file\n" + "x".repeat(100_001));
    await use(projectRoot);
  },
});

function records(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter((record) => record !== null) : [];
}

async function editorState(page: Page) {
  return page.evaluate(() => {
    const editor = (window as unknown as { __editorMgr: { editor: { getModel(): { getValue(): string } | null; getRawOptions(): { readOnly?: boolean } } } }).__editorMgr.editor;
    return { content: editor.getModel()?.getValue(), readOnly: editor.getRawOptions().readOnly };
  });
}

test.describe("Incomplete history through real local producers", () => {
  let server: Server;
  let tools: Array<{ name: "write_file" | "edit"; args: Record<string, string> }> = [];
  let calls = 0;
  const previous = new Map<string, string | undefined>();
  test.beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
      } else if (request.method === "POST" && request.url === "/v1/responses") {
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const index = calls++;
          const output = index < tools.length ? [{ type: "function_call", id: `history-${index}`, call_id: `history-${index}`, name: tools[index]!.name, arguments: JSON.stringify(tools[index]!.args) }] : [];
          for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
          if (!output.length) response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "History probe." })}\n\n`);
          response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
        });
      } else response.writeHead(404).end();
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
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-history-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    })) { previous.set(key, process.env[key]); process.env[key] = value; }
  });
  test.beforeEach(() => { tools = []; calls = 0; });
  test.afterAll(async () => {
    try {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  async function writeMoments(page: Page, runRoot: string) {
    await expect(page.locator("#splash")).toBeHidden();
    const owner = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.type === "agent")!;
    const path = join(runRoot, "events", `${owner.id}.jsonl`);
    await expect.poll(() => records(path).some((record) => record.t === "session_ready" && record.ok === true)).toBe(true);
    await page.evaluate((id) => window.termina.writeTerminal(id, "Produce the local history fixtures, altering only their designated files.\r"), owner.id);
    await expect.poll(() => records(path).filter((record) => record.t === "tool_end" && record.isError !== true).length, { timeout: 45_000 }).toBe(tools.length);
    await expect.poll(() => page.evaluate((id) => window.termina.getRuns(id).then((runs) => runs.some((run) => run.settledStateId != null && run.settledEntryId != null)), owner.id), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => page.evaluate((id) => window.termina.getTimeline(id).then((events) => events.some((event) => event.t === "agent_settled" && event.stateId && event.entryId)), owner.id), { timeout: 15_000 }).toBe(true);
    await page.locator("#activity-tab-timeline").click();
    return owner;
  }

  test("a missing file snapshot is explained without substituting live content; retained evidence still opens read-only", async ({ page, projectRoot, runRoot }) => {
    tools = ["oversize.txt", "hello.txt"].map((path) => ({ name: "write_file", args: { path, content: readFileSync(join(projectRoot, path), "utf8") } }));
    const owner = await writeMoments(page, runRoot);
    const timeline = await page.evaluate((id) => window.termina.getTimeline(id), owner.id);
    const missing = timeline.find((event) => event.relPath === "oversize.txt")!;
    const retained = timeline.find((event) => event.relPath === "hello.txt")!;
    expect(missing.stateId).toBeTruthy();
    expect(await page.evaluate(({ id, seq }) => window.termina.getTimelineContent(id, seq), { id: owner.id, seq: missing.seq })).toMatchObject({ ok: false, relPath: "oversize.txt" });
    await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
    await expect.poll(() => editorState(page)).toEqual({ content: readFileSync(join(projectRoot, "greeting.ts"), "utf8"), readOnly: false });
    const before = await editorState(page);
    await page.locator(`.timeline-dot[data-seq="${missing.seq}"]`).click();
    await expect(page.locator(".toast")).toContainText("oversize.txt — no snapshot for this moment");
    expect(await editorState(page)).toEqual(before);
    await expect(page.locator(".editor-tab")).toHaveCount(1);
    // The historical tab must not silently show today's file.
    writeFileSync(join(projectRoot, "hello.txt"), "new live content\n");
    await page.locator(`.timeline-dot[data-seq="${retained.seq}"]`).click();
    await expect.poll(() => editorState(page)).toEqual({ content: "hello\n", readOnly: true });
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("new live content\n");
    await expect(page.locator("#timeline-recorder")).toBeHidden();
    // Missing in-memory file content does not mean the immutable source is gone.
    const forked = await page.evaluate(({ id, seq }) => window.termina.forkPoint(id, seq), { id: owner.id, seq: missing.seq });
    expect(forked).toMatchObject({ ok: true, comparisonId: expect.any(String) });
    const candidate = (await page.evaluate((id) => window.termina.getWorldlines(id), owner.projectId!)).find((item) => item.comparisonId === forked.comparisonId)!;
    expect(candidate).toMatchObject({ role: "moment", state: "ready", error: null });
    expect(await page.evaluate((id) => window.termina.getWorldlineFile(id, "A", "hello.txt"), forked.comparisonId!)).toMatchObject({ ok: true, content: "hello\n" });
    const branch = readFileSync(candidate.sessionFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const messages = branch.filter((row) => row.type === "message").map((row) => row.message);
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.at(-1)?.content.some((block: { type: string }) => block.type === "tool_result")).toBe(true);
  });

  test("limited history remains explicit after settlement and pane refresh; discarded snapshot content does not become live evidence", async ({ page, runRoot }, testInfo) => {
    tools = Array.from({ length: 106 }, (_, i) => ({ name: "edit", args: { path: `history/${i}.txt`, old_text: `historical file ${i}\n`, new_text: `historical file ${i} edited\n` } }));
    const owner = await writeMoments(page, runRoot);
    const timeline = await page.evaluate((id) => window.termina.getTimeline(id), owner.id);
    expect(timeline).toHaveLength(100);
    expect(timeline.some((event) => event.relPath === "history/0.txt")).toBe(false);
    const first = timeline.find((event) => event.t === "tool")!;
    const last = timeline.filter((event) => event.t === "tool").at(-1)!;
    await expect(page.locator("#timeline-recorder")).toHaveText("Recent moments only");
    await expect(page.locator("#timeline-recorder")).toHaveAttribute("title", /not the full session history/);
    expect(await page.evaluate(({ id, seq }) => window.termina.getTimelineContent(id, seq), { id: owner.id, seq: first.seq })).toMatchObject({ ok: false });
    const beforeTabs = await page.locator(".editor-tab").count();
    const beforeEditor = await editorState(page);
    await page.locator(`.timeline-dot[data-seq="${first.seq}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".toast")).toContainText("no snapshot for this moment");
    // Real edit notifications can already have opened a live preview tab.
    // Missing evidence must neither replace it nor create a historical tab.
    await expect(page.locator(".editor-tab")).toHaveCount(beforeTabs);
    expect(await editorState(page)).toEqual(beforeEditor);
    await page.locator(`.timeline-dot[data-seq="${last.seq}"]`).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => editorState(page).then((state) => state.content?.startsWith("historical file 105 edited\n") && state.readOnly)).toBe(true);
    const created = await page.evaluate(() => window.termina.createTerminal({ type: "agent" }));
    expect(created.ok).toBe(true);
    await page.evaluate((id) => (window as any).__panes.get(id).tabEl.click(), created.id);
    await page.evaluate((id) => (window as any).__panes.get(id).tabEl.click(), owner.id);
    await expect(page.locator("#timeline-recorder")).toHaveText("Recent moments only");
    await expect(page.locator(".timeline-dot")).toHaveCount(100);
    await testInfo.attach("bounded-history", { body: JSON.stringify({ executedEdits: tools.length, retainedMoments: timeline.length, first, last }), contentType: "application/json" });
  });

  test("an unavailable immutable snapshot refuses a fork honestly and recovers on explicit retry", async ({ page, projectRoot, runRoot }) => {
    tools = [{ name: "write_file", args: { path: "hello.txt", content: "historical recovery content\n" } }];
    const owner = await writeMoments(page, runRoot);
    const moment = (await page.evaluate((id) => window.termina.getTimeline(id), owner.id)).find((event) => event.relPath === "hello.txt")!;
    expect(moment.stateId).toMatch(/^[a-f0-9]{40}$/);
    writeFileSync(join(projectRoot, "hello.txt"), "new live content\n");
    // Reversible fault injection in this fixture's private snapshot store only.
    // No source Git objects, host directories, leases or protocol mocks change.
    const storesRoot = join(runRoot, "user-data", "worldlines");
    const objects = readdirSync(storesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => join(storesRoot, entry.name, "git", "objects", moment.stateId!.slice(0, 2), moment.stateId!.slice(2)))
      .filter(existsSync);
    expect(objects).toHaveLength(1);
    const objectPath = objects[0]!;
    const heldPath = `${objectPath}.held-by-history-test`;
    const dot = page.locator(`.timeline-dot[data-seq="${moment.seq}"]`);
    renameSync(objectPath, heldPath);
    try {
      await dot.focus();
      await page.keyboard.press("Control+Enter");
      await expect(page.locator(".toast")).toContainText("fork at this moment failed");
      const candidates = await page.evaluate((id) => window.termina.getWorldlines(id), owner.projectId!);
      expect(candidates.every((candidate) => candidate.state === "error")).toBe(true);
      expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("new live content\n");
    } finally { renameSync(heldPath, objectPath); }
    await expect(dot).not.toHaveAttribute("aria-busy", "true");
    await dot.focus();
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => page.evaluate((id) => window.termina.getWorldlines(id).then((items) => items.some((item) => item.role === "moment" && item.state === "ready" && item.error === null)), owner.projectId!)).toBe(true);
    const candidate = (await page.evaluate((id) => window.termina.getWorldlines(id), owner.projectId!)).find((item) => item.state === "ready")!;
    expect(await page.evaluate((id) => window.termina.getWorldlineFile(id, "A", "hello.txt"), candidate.comparisonId)).toMatchObject({ ok: true, content: "historical recovery content\n" });
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("new live content\n");
  });

  test("bounded Verify output and a genuinely lost saved output retain execution facts after isolated restart", async ({ page, electronApp, projectRoot, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    await writeVerifyPackage(projectRoot, { test: `node -e "console.log('BEGIN-MARKER');console.log('x'.repeat(9000));console.log('END-MARKER')"` });
    const owner = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.type === "agent")!;
    expect(await page.evaluate((id) => window.termina.runVerify(id), owner.id)).toMatchObject({ ok: true });
    const project = (await page.evaluate(() => window.termina.projectList())).find((item) => item.active)!;
    await expect.poll(() => page.evaluate((id) => window.termina.getProjectWorkSummary(id).then((summary) => summary?.terminals[0]?.verify?.state), project.id)).toBe("pass");
    const original = (await page.evaluate((id) => window.termina.getProjectWorkSummary(id), project.id))!.terminals[0]!.verify!;
    const report = await page.evaluate(({ id, generation }) => window.termina.getVerifyReport(id, generation), owner);
    expect(report).toContain("Output (bounded tail)");
    expect(report).toContain("END-MARKER");
    expect(report).not.toContain("BEGIN-MARKER");
    const environment = await electronApp.evaluate(() => ({ ...process.env }));
    const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    await closeOwnedElectron(electronApp);
    // Lose only this test-owned persisted output, after its writer has stopped.
    const rosterPath = rosterFilePath(join(runRoot, "user-data"), sanitizeSessionDir(realpathSync(project.cwd)));
    const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
    const saved = roster.terminals.find((item: { id: string }) => item.id === owner.id);
    expect(saved.verifyOutput).toContain("END-MARKER");
    delete saved.verifyOutput;
    writeFileSync(rosterPath, JSON.stringify(roster));
    const replacement = await launchOwnedElectron(env, runRoot);
    try {
      const restored = await replacement.firstWindow();
      await expect(restored.locator("#splash")).toBeHidden();
      const restoredProject = (await restored.evaluate(() => window.termina.projectList())).find((item) => item.active)!;
      const restoredOwner = (await restored.evaluate(() => window.termina.getInstances())).find((item) => item.id === owner.id)!;
      const summary = await restored.evaluate((id) => window.termina.getProjectWorkSummary(id), restoredProject.id);
      const historical = summary!.terminals.find((item) => item.terminalId === owner.id)!.verify!;
      expect(historical.result).toEqual(original.result);
      expect(original.source).toBeDefined();
      expect(historical.source).toEqual(original.source);
      await restored.locator("#work-summary > summary").click();
      await restored.getByRole("button", { name: "Check details", exact: true }).click();
      await expect(restored.locator(".work-summary-report")).toContainText("Output:** not retained for this historical run");
      await expect(restored.locator(".work-summary-report")).toContainText("Historical execution:** ✅ PASSED (exit code 0)");
      await expect(restored.locator(".work-summary-report")).not.toContainText("END-MARKER");
      expect(await restored.evaluate(({ id, generation }) => window.termina.getVerifyReport(id, generation + 1), restoredOwner)).toBeNull();
    } finally { await closeOwnedElectron(replacement); }
  });
});
