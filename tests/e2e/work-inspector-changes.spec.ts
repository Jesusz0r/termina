import { test, expect } from "./fixtures.ts";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { observeReviewWrites } from "./review-observation.ts";

function complete(response: ServerResponse, call: { name: string; args: Record<string, string> }): void {
  const item = { type: "function_call", id: `fixture-${call.name}-${Date.now()}`, name: call.name, arguments: JSON.stringify(call.args) };
  response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item: { ...item, call_id: item.id } })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ ...item, call_id: item.id }], usage: {} } })}\n\n`);
}

test.describe("Selected work cumulative change review", () => {
  let server: Server;
  let calls = 0;
  let pending: ServerResponse | null = null;
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
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (++calls === 1) complete(response, { name: "read_file", args: { path: "hello.txt" } });
        else if (calls === 2) complete(response, { name: "write_file", args: { path: "hello.txt", content: "inspector current disk\n" } });
        else if (calls === 3) complete(response, { name: "write_file", args: { path: "created.txt", content: "inspector created source\n" } });
        else { response.flushHeaders(); pending = response; }
      });
    });
    const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture port");
      resolve(address.port);
    }));
    for (const [key, value] of Object.entries({ TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-loopback-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` })) {
      previous.set(key, process.env[key]); process.env[key] = value;
    }
  });
  test.beforeEach(() => { calls = 0; pending = null; });
  test.afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  for (const compact of [false, true]) {
    test(`real captured changes remain read-only in a background project${compact ? " at compact 200% zoom" : ""}`, async ({ page, projectRoot, runRoot, electronApp }) => {
      await expect(page.locator("#splash")).toBeHidden();
      const source = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
      const owner = (await page.evaluate(() => window.termina.getInstances()))[0]!;
      const sidecar = join(runRoot, "events", `${owner.id}.jsonl`);
      await expect.poll(() => existsSync(sidecar) && readFileSync(sidecar, "utf8").split("\n").some((line) => {
        const record = parseSidecarRecord(line); return record?.t === "session_ready" && record.ok === true;
      }), { timeout: 15_000 }).toBe(true);
      const observedInitial = await observeReviewWrites(page, { projectId: source.id, workspaceId: owner.workspaceId }, {
        "hello.txt": "inspector current disk\n", "created.txt": "inspector created source\n",
      });
      await page.evaluate((id) => window.termina.writeTerminal(id, "Read hello.txt, then modify hello.txt and create created.txt for inspection. Later remove hello.txt and create 55 page-*.txt files after we inspect the diffs.\r"), owner.id);
      await expect.poll(() => pending !== null, { timeout: 30_000 }).toBe(true);
      expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("inspector current disk\n");
      expect(readFileSync(join(projectRoot, "created.txt"), "utf8")).toBe("inspector created source\n");
      await observedInitial();

      const otherRoot = join(runRoot, "other-project");
      execFileSync("git", ["clone", "-q", "--no-hardlinks", projectRoot, otherRoot]);
      await page.evaluate((root) => window.termina.projectOpenPath(root), otherRoot);
      const active = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
      expect(active.id).not.toBe(source.id);
      const draftPath = join(otherRoot, "greeting.ts");
      const draftDisk = readFileSync(draftPath, "utf8");
      await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
      const draftTab = page.locator(".editor-tab").filter({ hasText: "greeting.ts" });
      const bufferText = () => page.evaluate(() => (window as unknown as {
        __editorMgr: { editor: { getModel(): { getValue(): string } } };
      }).__editorMgr.editor.getModel().getValue());
      await expect(draftTab).toHaveClass(/active/);
      await expect.poll(bufferText).toBe(draftDisk);
      const draft = "// keep this unsaved buffer while inspecting background changes\n";
      await page.evaluate((text) => {
        const editor = (window as unknown as {
          __editorMgr: { editor: { getModel(): { getFullModelRange(): unknown }; executeEdits(source: string, edits: { range: unknown; text: string }[]): void } };
        }).__editorMgr.editor;
        editor.executeEdits("work-inspector-changes-test", [{ range: editor.getModel().getFullModelRange(), text }]);
      }, draft);
      await expect.poll(bufferText).toBe(draft);
      await expect(draftTab.locator(".tab-dirty")).toBeVisible();
      const attentionBefore = (await page.evaluate(() => window.termina.getWorkOverview())).items;
      if (compact) await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!; window.setSize(900, 700); window.webContents.setZoomFactor(2);
      });
      await page.locator("#btn-all-projects").click();
      const card = page.locator(`.overview-project[data-project-id="${source.id}"] .overview-work-card`).filter({ hasText: owner.id }).first();
      await expect(card.locator(".overview-work-evidence")).toContainText("2 tracked paths");
      await card.locator(".overview-inspect").click();
      const inspector = page.locator("#project-work-inspector");
      await expect(inspector.locator(".overview-work-changes")).toBeHidden();
      await inspector.getByRole("button", { name: "Inspect changes", exact: true }).click();
      const changes = inspector.locator(".overview-work-changes");
      await expect(changes).toContainText("not an attribution to this task");
      await expect(changes.locator(".overview-changes-list button")).toHaveCount(2);
      await expect(changes.getByRole("button", { name: "created · created.txt", exact: true })).toBeVisible();
      const modified = changes.getByRole("button", { name: "modified · hello.txt", exact: true });
      await modified.focus();
      await page.keyboard.press("Enter");
      await expect(changes.locator(".overview-changes-diff-status")).toHaveText("Read-only captured baseline to current disk diff.");
      const diff = changes.locator(".overview-changes-diff");
      await expect(diff).toContainText("hello");
      await expect(diff).toContainText("inspector current disk");
      await changes.getByRole("button", { name: "Focus diff", exact: true }).click();
      await page.keyboard.press("End");
      await page.keyboard.type("SHOULD_NOT_WRITE");
      expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("inspector current disk\n");
      await expect(diff).not.toContainText("SHOULD_NOT_WRITE");
      await expect(changes.getByRole("button", { name: /Accept|Revert/ })).toHaveCount(0);
      await expect(page.locator("#attention-view")).toBeVisible();
      expect(await page.locator("#main-split").evaluate((node) => (node as HTMLElement).inert)).toBe(true);
      expect((await page.evaluate(() => window.termina.projectList())).find((project) => project.active)?.id).toBe(active.id);

      const response = pending!; pending = null;
      complete(response, { name: "write_file", args: { path: "hello.txt", content: "inspector later disk\n" } });
      await expect.poll(() => readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("inspector later disk\n");
      await expect(changes.locator(".overview-changes-diff-section")).toBeHidden();
      await expect(changes.locator(".overview-changes-status")).toContainText("Reload changes before inspecting");
      await changes.getByRole("button", { name: "Reload changes", exact: true }).click();
      await modified.focus(); await page.keyboard.press("Enter");
      await expect(changes.locator(".overview-changes-diff-status")).toHaveText("Read-only captured baseline to current disk diff.");
      await expect(diff).toContainText("hello");
      await expect(diff).toContainText("inspector later disk");
      await changes.getByRole("button", { name: "created · created.txt", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(changes.locator(".overview-changes-filename")).toHaveText("created.txt");
      await expect(changes.locator(".overview-changes-diff-status")).toContainText("no file existed in the captured baseline");
      await expect.poll(() => pending !== null).toBe(true);
      const deletion = pending!; pending = null;
      // The real agent asks for bash permission. Approve only this fixture-owned bash command
      // through its ordinary terminal input; do not disable the permission policy.
      await page.evaluate((id) => {
        const unbind = window.termina.onPtyData((event) => {
          if (event.id !== id || !event.data.includes("Approve bash?")) return;
          unbind();
          void window.termina.writeTerminal(id, "/approve once\r");
        });
      }, owner.id);
      complete(deletion, { name: "bash", args: { command: "rm -- hello.txt && for n in {1..55}; do printf 'page file\\n' > \"page-$n.txt\"; done" } });
      await expect.poll(() => existsSync(join(projectRoot, "hello.txt"))).toBe(false);
      await expect.poll(async () => {
        const result = await page.evaluate((target) => window.termina.getReviewFiles(target, 0), {
          projectId: source.id, workspaceId: owner.workspaceId, root: owner.cwd, terminalId: owner.id, generation: owner.generation!,
        });
        return result.ok ? result.total : 0;
      }).toBe(57);
      await expect(changes.locator(".overview-changes-diff-section")).toBeHidden();
      await changes.getByRole("button", { name: "Reload changes", exact: true }).click();
      await expect(changes.locator(".overview-changes-list button")).toHaveCount(50);
      await expect(changes.locator(".overview-changes-status")).toContainText("50 of 57 recorded terminal paths");
      const deleted = changes.getByRole("button", { name: "deleted · hello.txt", exact: true });
      await deleted.focus(); await page.keyboard.press("Enter");
      await expect(changes.locator(".overview-changes-diff-status")).toContainText("Deleted on disk");
      await expect(diff).toContainText("hello");
      await expect(diff).not.toContainText("inspector later disk");
      await changes.getByRole("button", { name: "Show more paths (7 remaining)", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(changes.locator(".overview-changes-list button")).toHaveCount(57);
      await expect(changes.locator(".overview-changes-list button").nth(50)).toBeFocused();
      await expect(changes.locator(".overview-changes-more")).toBeHidden();
      await expect(changes.locator(".overview-changes-filename")).toHaveText("hello.txt");
      await expect(changes.locator(".overview-changes-diff-status")).toContainText("Deleted on disk");
      await expect.poll(bufferText).toBe(draft);
      await expect(draftTab.locator(".tab-dirty")).toBeVisible();
      expect(readFileSync(draftPath, "utf8")).toBe(draftDisk);
      const withoutModel = ({ model: _model, ...item }: (typeof attentionBefore)[number]) => item;
      expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(attentionBefore.map(withoutModel));
      await page.keyboard.press("Escape");
      await expect(page.locator("#attention-view")).toBeVisible();
      await page.locator(`.overview-project[data-project-id="${active.id}"] .overview-inspect`).first().click();
      await expect(inspector.locator(".overview-work-changes")).toBeHidden();
      await expect(inspector.locator(".overview-changes-filename")).toHaveText("");
      expect((await page.evaluate(() => window.termina.projectList())).find((project) => project.active)?.id).toBe(active.id);
    });
  }
});
