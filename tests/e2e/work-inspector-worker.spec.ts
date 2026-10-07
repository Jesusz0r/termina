import { test, expect } from "./fixtures.ts";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ReviewTarget } from "../../shared/types.ts";
import type { Terminal } from "@xterm/xterm";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { lifecycleDialogs, mockLifecycleDialogs } from "./lifecycle-dialog.ts";
import { holdNextReviewResponse, heldReviewResponse, releaseReviewResponse, restoreReviewResponse } from "./review-response-gate.ts";

const taskText = "Update hello.txt for worker inspection";
const ownerMarker = "inspector-worker-plan-owner";
function complete(response: ServerResponse, text: string, name: string, args: Record<string, string>): void {
  const item = { type: "function_call", id: `fixture-${name}-${Date.now()}`, name, arguments: JSON.stringify(args) };
  response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
  response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item: { ...item, call_id: item.id } })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ ...item, call_id: item.id }], usage: {} } })}\n\n`);
}

test.describe("Dispatched worker change inspection", () => {
  let server: Server;
  let ownerCalls = 0;
  let workerCalls = 0;
  let attempt = 1;
  let ownerPending = false;
  let workerPending = false;
  let workerToolResults: unknown;
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
        if (body.includes(ownerMarker)) {
          if (++ownerCalls === 1) complete(response, `Plan:\n- [ ] ${taskText}\n`, "read_file", { path: "hello.txt" });
          else { response.flushHeaders(); ownerPending = true; }
        } else if (++workerCalls === 1) {
          complete(response, "Read this attempt's current source before replacing it.", "read_file", { path: "hello.txt" });
        } else if (workerCalls === 2) {
          complete(response, "Change the task source.", "write_file", { path: "hello.txt", content: `worker attempt ${attempt} disk\n` });
        } else if (workerCalls === 3) {
          // A real extra recorded path proves the list is cumulative, not filtered to declared task paths.
          complete(response, "Record an additional source path.", "write_file", { path: `extra-${attempt}.txt`, content: `extra attempt ${attempt}\n` });
        } else {
          workerToolResults = JSON.parse(body).input?.slice(-4);
          response.flushHeaders(); workerPending = true;
        }
      });
    });
    const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing loopback port");
      resolve(address.port);
    }));
    for (const [key, value] of Object.entries({ TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-loopback-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` })) {
      previous.set(key, process.env[key]); process.env[key] = value;
    }
  });
  test.beforeEach(() => { ownerCalls = 0; workerCalls = 0; attempt = 1; ownerPending = false; workerPending = false; workerToolResults = undefined; });
  test.afterAll(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  for (const { deferDiff, focused, interruptWorker } of [
    { deferDiff: false, focused: false, interruptWorker: false }, { deferDiff: true, focused: false, interruptWorker: false },
    { deferDiff: false, focused: true, interruptWorker: false }, { deferDiff: true, focused: true, interruptWorker: false },
    { deferDiff: false, focused: true, interruptWorker: true },
  ]) {
    test(`${focused ? "Focus task reuses its worker terminal, then " : ""}${interruptWorker ? "interrupt" : "close"} ${deferDiff ? "a pending" : "a loaded"} worker diff and explicitly retry with a fresh baseline`, async ({ page, projectRoot, runRoot, electronApp }, testInfo) => {
      await expect(page.locator("#splash")).toBeHidden();
      const source = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
      const owner = (await page.evaluate(() => window.termina.getInstances()))[0]!;
      const sidecar = join(runRoot, "events", `${owner.id}.jsonl`);
      await expect.poll(() => existsSync(sidecar) && readFileSync(sidecar, "utf8").split("\n").some((line) => {
        const record = parseSidecarRecord(line); return record?.t === "session_ready" && record.ok === true;
      }), { timeout: 15_000 }).toBe(true);
      // Seed only this fixture's source. The real /plan producer is read-only;
      // it reads this distinct pre-dispatch content rather than being allowed to write it.
      writeFileSync(join(projectRoot, "hello.txt"), "owner disk before dispatch\n");
      await page.evaluate(({ id, marker }) => window.termina.writeTerminal(id, `/plan ${marker}\r`), { id: owner.id, marker: ownerMarker });
      await expect.poll(() => ownerPending).toBe(true);
      await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id), owner.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: taskText, paths: ["hello.txt"], state: "pending" }),
      ]));
      expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("owner disk before dispatch\n");
      expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: owner.id, text: taskText })).toMatchObject({ ok: true });
      await expect.poll(() => workerPending).toBe(true);
      const workerId = (await page.evaluate((id) => window.termina.getPlan(id), owner.id))[0]!.workerId!;
      expect(workerId).not.toBe(owner.id);
      const worker = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === workerId)!;
      expect(worker).toMatchObject({ dispatchWorker: true, busy: true, projectId: source.id });

      const otherRoot = join(runRoot, "other-project");
      execFileSync("git", ["clone", "-q", "--no-hardlinks", projectRoot, otherRoot]);
      await page.evaluate((root) => window.termina.projectOpenPath(root), otherRoot);
      const active = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
      expect(active.id).not.toBe(source.id);
      const draftPath = join(otherRoot, "greeting.ts");
      const draftDisk = readFileSync(draftPath, "utf8");
      await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
      const draftTab = page.locator(".editor-tab").filter({ hasText: "greeting.ts" });
      await expect(draftTab).toHaveClass(/active/);
      const draft = "// unsaved background inspection draft\n";
      await page.evaluate((text) => {
        const editor = (window as unknown as { __editorMgr: { editor: { getModel(): { getFullModelRange(): unknown }; executeEdits(source: string, edits: { range: unknown; text: string }[]): void } } }).__editorMgr.editor;
        editor.executeEdits("worker-inspector-test", [{ range: editor.getModel().getFullModelRange(), text }]);
      }, draft);
      await expect(draftTab.locator(".tab-dirty")).toBeVisible();
      await page.locator("#btn-all-projects").click();
      const card = page.locator(`.overview-project[data-project-id="${source.id}"] .overview-work-card`).filter({ hasText: taskText });
      await card.locator(".overview-inspect").click();
      const inspector = page.locator("#project-work-inspector");
      await expect(inspector.locator(".overview-inspector-title")).toHaveText(taskText);
      await expect(inspector).toContainText(workerId);
      await expect(inspector).toContainText(source.cwd);
      if (focused) {
        if (deferDiff) await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2));
        const rosterBefore = await page.evaluate(() => window.termina.getInstances());
        const focusButton = inspector.getByRole("button", { name: "Focus task", exact: true });
        await focusButton.click();
        const terminal = page.locator(".focus-task-terminal");
        await expect(terminal.locator(".xterm-helper-textarea")).toBeInViewport();
        await expect(page.locator(".focus-task-context")).toHaveText(`${workerId} · ${worker.cwd}`);
        await expect(page.locator("#project-bar")).toBeVisible();
        await expect(page.locator("#overview-attention-heading")).toBeVisible();
        await expect(inspector.locator(".overview-inspector-facts")).toContainText("Worker check");
        await expect(inspector.locator(".overview-changes-list button")).toHaveCount(2);
        expect((await page.evaluate(() => window.termina.getInstances())).map(({ id, generation }) => ({ id, generation })))
          .toEqual(rosterBefore.map(({ id, generation }) => ({ id, generation })));
        expect((await page.evaluate(() => window.termina.projectList())).find((project) => project.active)?.id).toBe(source.id);
        expect(await page.evaluate((id) => {
          const pane = (window as unknown as { __panes: Map<string, { container: HTMLElement; view: { getTerminal(): Terminal } }> }).__panes.get(id)!;
          return pane.container.parentElement?.classList.contains("focus-task-terminal")
            && pane.container.contains(pane.view.getTerminal().element!);
        }, workerId)).toBe(true);
        await terminal.locator(".xterm-helper-textarea").focus();
        await page.keyboard.type("focus task input");
        await expect.poll(() => page.evaluate((id) => {
          const term = (window as unknown as { __panes: Map<string, { view: { getTerminal(): Terminal } }> }).__panes.get(id)!.view.getTerminal();
          return Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString() ?? "").join("\n");
        }, workerId)).toContain("focus task input");
        await testInfo.attach("focus-task-layout", { body: await page.screenshot(), contentType: "image/png" });
        await page.getByRole("button", { name: "Back to overview", exact: true }).click();
        await expect(focusButton).toBeFocused();
        await expect(card).toHaveClass(/is-selected/);
        await expect(inspector).toBeVisible();
        expect(await page.evaluate((id) => {
          const pane = (window as unknown as { __panes: Map<string, { container: HTMLElement }> }).__panes.get(id)!;
          return pane.container.parentElement?.id;
        }, workerId)).toBe("terminal-container");
        // The real project switch exits the overview and updates both owners.
        // Reopen it explicitly and select the same existing task in the background.
        await page.locator(`.project-tab[data-project-id="${active.id}"]`).click();
        await expect(page.locator("#attention-view")).toBeHidden();
        await page.locator("#btn-all-projects").click();
        await card.locator(".overview-inspect").click();
      }
      await inspector.getByRole("button", { name: "Inspect changes", exact: true }).click();
      const changes = inspector.locator(".overview-work-changes");
      await expect(changes).toContainText("not an attribution to this task");
      await expect(changes.locator(".overview-changes-scope")).toHaveText(`${workerId} · ${worker.cwd}`);
      await expect(changes.locator(".overview-changes-list button")).toHaveCount(2);
      await expect(changes.getByRole("button", { name: "created · extra-1.txt", exact: true })).toBeVisible();
      const modified = changes.getByRole("button", { name: "modified · hello.txt", exact: true });
      await modified.click();
      const diff = changes.locator(".overview-changes-diff");
      await expect(changes.locator(".overview-changes-diff-status")).toHaveText("Read-only captured baseline to current disk diff.");
      await expect(diff).toContainText("owner disk before dispatch");
      await expect(diff).toContainText("worker attempt 1 disk");
      await changes.getByRole("button", { name: "Focus diff", exact: true }).click();
      await page.keyboard.type("SHOULD_NOT_WRITE");
      await expect(diff).not.toContainText("SHOULD_NOT_WRITE");
      expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("worker attempt 1 disk\n");
      await expect(changes.getByRole("button", { name: /Accept|Revert|Save/ })).toHaveCount(0);
      const assignedContext = await inspector.locator(".overview-inspector-facts").textContent();
      const target: ReviewTarget = { projectId: source.id, workspaceId: worker.workspaceId, root: worker.cwd, terminalId: worker.id, generation: worker.generation! };
      const canonical = await page.evaluate(async (target) => {
        const recorded = await window.termina.getReviewFiles(target, 0);
        if (!recorded.ok) throw new Error(recorded.error);
        const file = recorded.files.find((file) => file.relPath === "hello.txt");
        if (!file) throw new Error("Worker did not record hello.txt");
        return window.termina.getReviewDiff(target, file.path);
      }, target);
      expect(canonical).toMatchObject({ ok: true, baseline: "owner disk before dispatch\n", current: "worker attempt 1 disk\n" });
      try {
        if (deferDiff) {
          await holdNextReviewResponse(electronApp, "review:diff", workerId);
          await modified.click();
          await expect.poll(() => heldReviewResponse(electronApp).then((gate) => gate.waiting)).toBe(true);
          const held = await heldReviewResponse(electronApp);
          expect(held.target).toEqual(target);
          expect(held.result).toEqual(canonical);
          await expect(changes.locator(".overview-changes-diff-section")).toHaveAttribute("aria-busy", "true");
        }
        if (focused) {
          const action = interruptWorker ? "Send Ctrl+C" : "Close terminal";
          await mockLifecycleDialogs(electronApp, 1);
          await inspector.getByRole("button", { name: action, exact: true }).click();
          await expect(inspector.locator(".overview-inspector-status")).toContainText("cancelled");
          expect((await lifecycleDialogs(electronApp))[0]!.message).toContain(workerId);
          expect((await lifecycleDialogs(electronApp))[0]!.detail).toContain(taskText);
          expect((await page.evaluate(() => window.termina.getInstances())).some((instance) => instance.id === workerId)).toBe(true);
          expect((await page.evaluate(() => window.termina.projectList())).find((project) => project.active)?.id).toBe(active.id);
          await expect(card).toHaveClass(/is-selected/);
          await mockLifecycleDialogs(electronApp, 0);
          await inspector.getByRole("button", { name: action, exact: true }).click();
          expect((await lifecycleDialogs(electronApp))[0]!.message).toContain(workerId);
        } else {
          await mockLifecycleDialogs(electronApp, 0);
          expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), worker)).toEqual({ ok: true });
        }
        await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), owner.id)).toBe("interrupted");
        await expect(changes.locator(".overview-changes-diff-section")).toBeHidden();
        await expect(changes.locator(".overview-changes-filename")).toHaveText("");
        expect(await page.evaluate((target) => window.termina.getReviewFiles(target, 0), target)).toMatchObject({ ok: interruptWorker });
        if (interruptWorker) {
          expect((await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === workerId)?.busy).toBe(false);
        }
        await expect.poll(() => page.evaluate((text) => window.termina.getWorkOverview().then((overview) => overview.items.some((item) => item.reason === "task-interrupted" && item.taskText === text)), taskText)).toBe(true);
        const attention = (await page.evaluate(() => window.termina.getWorkOverview())).items;
        expect(attention.length).toBeGreaterThan(0);
        if (deferDiff) {
          await releaseReviewResponse(electronApp);
          await expect.poll(() => heldReviewResponse(electronApp).then((gate) => gate.delivered)).toBe(true);
          await page.evaluate(() => window.termina.getWorkOverview());
        }
        await expect(changes.locator(".overview-changes-diff-section")).toBeHidden();
        await expect(inspector.locator(".overview-inspector-title")).toHaveText(taskText);
        await expect(inspector).toContainText(source.cwd);
        expect(assignedContext).toContain(source.cwd);
        const withoutModel = ({ model: _model, ...item }: (typeof attention)[number]) => item;
        await page.locator("#btn-refresh-attention").click();
        expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(attention.map(withoutModel));

        attempt = 2; workerCalls = 0; workerPending = false;
        if (focused) {
          await inspector.getByRole("button", { name: "Retry in plan", exact: true }).click();
          await expect(page.locator("#attention-view")).toBeHidden();
          const retry = page.getByRole("button", { name: `Retry task: ${taskText}`, exact: true });
          await expect(retry).toBeFocused();
          await retry.click();
          await page.locator("#btn-all-projects").click();
          await expect(card).toHaveClass(/is-selected/);
        } else {
          expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: owner.id, text: taskText })).toMatchObject({ ok: true });
        }
        await expect.poll(() => workerPending).toBe(true);
        await expect.poll(() => readFileSync(join(projectRoot, "hello.txt"), "utf8"), {
          message: `Retry must finish its write before review: ${JSON.stringify(workerToolResults)}`,
        }).toBe("worker attempt 2 disk\n");
        const retryId = (await page.evaluate((id) => window.termina.getPlan(id), owner.id))[0]!.workerId!;
        expect(retryId).not.toBe(workerId);
        expect(retryId).not.toBe(owner.id);
        await expect(inspector.locator(".overview-inspector-title")).toHaveText(taskText);
        await expect(inspector).toContainText(retryId);
        await expect(changes.locator(".overview-changes-diff-section")).toBeHidden();
        await inspector.getByRole("button", { name: "Inspect changes", exact: true }).click();
        await expect(changes.locator(".overview-changes-scope")).toContainText(retryId);
        await expect(changes.locator(".overview-changes-list button")).toHaveCount(2);
        await expect(changes.getByRole("button", { name: "created · extra-2.txt", exact: true })).toBeVisible();
        await expect(changes.getByRole("button", { name: "created · extra-1.txt", exact: true })).toHaveCount(0);
        const retry = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === retryId)!;
        const retryTarget: ReviewTarget = {
          projectId: source.id, workspaceId: retry.workspaceId, root: retry.cwd,
          terminalId: retry.id, generation: retry.generation!,
        };
        const retryDiff = await page.evaluate(async (target) => {
          const recorded = await window.termina.getReviewFiles(target, 0);
          if (!recorded.ok) throw new Error(recorded.error);
          return window.termina.getReviewDiff(target, recorded.files.find((file) => file.relPath === "hello.txt")!.path);
        }, retryTarget);
        expect(retryDiff, JSON.stringify(await page.evaluate((id) => window.termina.getRuns(id), retryId))).toMatchObject({
          ok: true, baseline: "worker attempt 1 disk\n", current: "worker attempt 2 disk\n",
        });
        await modified.click();
        await expect(changes.locator(".overview-changes-diff-status")).toHaveText("Read-only captured baseline to current disk diff.");
        await expect(diff).toContainText("worker attempt 1 disk");
        await expect(diff).toContainText("worker attempt 2 disk");
        await expect(diff).not.toContainText("owner disk before dispatch");
        expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("worker attempt 2 disk\n");
        await expect(page.locator("#attention-view")).toBeVisible();
        expect((await page.evaluate(() => window.termina.projectList())).find((project) => project.active)?.id).toBe(focused ? source.id : active.id);
        if (focused) {
          // Retry in plan explicitly visits the task owner. Return through the
          // real project switch before checking the untouched background draft.
          await page.locator(`.project-tab[data-project-id="${active.id}"]`).click();
          await page.locator("#btn-all-projects").click();
          await card.locator(".overview-inspect").click();
          await expect(card).toHaveClass(/is-selected/);
        }
        expect((await page.evaluate(() => window.termina.projectList())).find((project) => project.active)?.id).toBe(active.id);
        await expect.poll(() => page.evaluate(() => (window as unknown as { __editorMgr: { editor: { getModel(): { getValue(): string } } } }).__editorMgr.editor.getModel().getValue())).toBe(draft);
        await expect(draftTab.locator(".tab-dirty")).toBeVisible();
        expect(readFileSync(draftPath, "utf8")).toBe(draftDisk);
      } finally {
        if (deferDiff) await restoreReviewResponse(electronApp);
      }
    });
  }
});
