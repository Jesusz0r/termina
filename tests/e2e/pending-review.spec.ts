import { test, expect } from "./fixtures.ts";
import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { editor } from "monaco-editor";
import type { Terminal } from "@xterm/xterm";
import type { PlanTask, PlanTaskStartRequest, WorkAttentionItem } from "../../shared/types.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { activeProject, savedPlanProject } from "./saved-plan-project.ts";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";

const taskText = "Update hello.txt and check the independent result";
const candidateContent = "pending review candidate output\n";
type EditorWindow = Window & { __editorMgr: {
  editor: editor.IStandaloneCodeEditor;
  openFile(path: string, options: { preview: boolean }): Promise<void>;
  flushDrafts(): Promise<boolean>;
} };

function complete(response: ServerResponse, text: string, call?: { name: string; args: Record<string, string> }) {
  response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
  const output = call ? [{ type: "function_call", id: `review-${call.name}`, call_id: `review-${call.name}`,
    name: call.name, arguments: JSON.stringify(call.args) }] : [];
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}

function records(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter((record) => record !== null) : [];
}

async function identities(page: Page) {
  return page.evaluate(async () => (await window.termina.getInstances())
    .map(({ id, cwd, generation, projectId, workspaceId }) => ({ id, cwd, generation, projectId, workspaceId }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

function withoutModel({ model: _model, ...item }: WorkAttentionItem) { return item; }
function attentionRow(page: Page, item: WorkAttentionItem) {
  return page.locator(`#attention-list .attention-item[data-id="${item.id}"]`);
}
function fact(inspector: Locator, label: string) {
  return inspector.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
}
async function openOverview(page: Page) {
  await page.locator("#btn-all-projects").click();
  await expect(page.getByRole("region", { name: "All projects", exact: true })).toBeVisible();
  await expect(page.locator("#attention-status")).not.toContainText("Loading");
}
async function terminalText(page: Page, id: string) {
  return page.evaluate((id) => {
    const panes = (window as unknown as { __panes: Map<string, { view: { getTerminal(): Terminal } }> }).__panes;
    const buffer = panes.get(id)?.view.getTerminal().buffer.active;
    return buffer ? Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "").join("\n") : "";
  }, id);
}

// The provider performs real file tools and a successful check. The final reply
// is held so the test can distinguish live work from a recorded completed result.
test.describe("Result pending review", () => {
  let server: Server;
  let calls = 0;
  let finalResponse: ServerResponse | null = null;
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
        if (++calls === 1) complete(response, "Read the task's source before making changes.", { name: "read_file", args: { path: "hello.txt" } });
        else if (calls === 2) complete(response, "Write the selected task in its independent tree.", {
          name: "write_file", args: { path: "hello.txt", content: candidateContent },
        });
        else if (calls === 3) complete(response, "Check the written file in this tree.", {
          name: "bash", args: { command: 'test "$(cat hello.txt)" = "pending review candidate output"' },
        });
        else { response.flushHeaders(); finalResponse = response; }
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
  test.beforeEach(() => { calls = 0; finalResponse = null; });
  test.afterAll(async () => {
    try {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  test("a saved completed shared-file result in a same-name background project remains pending during inspection and explicit navigation", async ({ page, projectRoot, runRoot }) => {
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
    await openOverview(page);
    const filter = page.getByRole("searchbox", { name: "Filter projects and tasks", exact: true });
    await filter.fill(current.project.cwd);
    await expect(page.locator(".overview-project")).toHaveCount(1);
    const row = attentionRow(page, item);
    await expect(row).toContainText("Result pending review");
    await expect(row).toContainText(/review.*not recorded/i);
    await expect(row).not.toContainText(/not applied|unapplied/i);
    await expect(row).toContainText(target.project.cwd);
    await row.getByRole("button", { name: "Inspect details", exact: true }).click();
    const inspector = page.getByRole("complementary", { name: "Selected work details", exact: true });
    await expect(inspector.locator(".overview-inspector-title")).toHaveText(completed.text);
    await expect(fact(inspector, "Execution")).toContainText(`Previous attempt completed (${completed.dispatchResult!.workerId})`);
    await expect(fact(inspector, "Assigned context")).toContainText("Shared project files");
    await expect(fact(inspector, "Assigned context")).toContainText(target.project.cwd);
    await expect(inspector).toContainText("Result pending review");
    await expect(inspector).not.toContainText(/not applied|unapplied/i);
    await expect(inspector.getByRole("button", { name: /Accept|Resolve|Mark reviewed/ })).toHaveCount(0);
    await expect(page.locator("#attention-view")).toBeVisible();
    await expect(filter).toHaveValue(current.project.cwd);
    await expect(page.locator(".overview-project")).toHaveCount(1);
    expect(await activeProject(page)).toMatchObject({ id: current.project.id, activationGeneration: current.project.activationGeneration });
    expect(await identities(page)).toEqual(beforeInstances);
    expect(await page.evaluate((id) => window.termina.getPlan(id), ownerId)).toEqual(beforePlan);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.items.map(withoutModel));
    expect(await readFile(draftPath, "utf8")).toBe(disk);
    expect(await page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe(draft);
    expect(calls).toBe(0);
    await page.keyboard.press("Escape");
    await expect(inspector).toBeHidden();
    await expect(row.getByRole("button", { name: "Inspect details", exact: true })).toBeFocused();
    await row.getByRole("button", { name: "Inspect details", exact: true }).click();
    await inspector.getByRole("button", { name: "Open plan", exact: true }).click();
    await expect(page.locator("#attention-view")).toBeHidden();
    expect((await activeProject(page)).id).toBe(target.project.id);
    await expect(page.locator("#plan-list")).toContainText(completed.text);
    expect(await page.evaluate((id) => window.termina.getPlan(id), ownerId)).toEqual(beforePlan);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.items.map(withoutModel));
    expect((JSON.parse(await readFile(target.roster, "utf8")) as typeof rosterBefore).terminals.map((terminal) => terminal.plan))
      .toEqual(rosterBefore.terminals.map((terminal) => terminal.plan));
    expect(await identities(page)).toEqual(beforeInstances);
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
    await openOverview(page);
    await expect(page.locator("#attention-list")).not.toContainText("Result pending review");
    await expect(page.locator(`.overview-project[data-project-id="${target.project.id}"]`)).toContainText("Owner check: pass");
    expect(await page.evaluate((id) => window.termina.getPlan(id), ownerId)).toEqual(tasks);
    expect(await readVerifyStages(target.project.cwd)).toHaveLength(1);
    expect(calls).toBe(0);
  });

  test("a real independent completed worker exposes its captured result, survives worker close, and disappears only on explicit discard", async ({ page, projectRoot, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const pending: PlanTask = { text: taskText, paths: ["hello.txt"], state: "pending" };
    const target = await savedPlanProject(page, projectRoot, runRoot, 1, [[pending]]);
    const current = await savedPlanProject(page, projectRoot, runRoot, 2, [[]]);
    await writeFile(join(current.project.cwd, ".gitignore"), "/stages.jsonl\nnode_modules/\n");
    await writeVerifyPackage(current.project.cwd, { test: "termina-verify-fixture pass" });
    expect(await page.evaluate((id) => window.termina.runVerify(id), current.owners[0]!)).toEqual({ ok: true });
    await expect.poll(() => page.evaluate(async (id) => (await window.termina.getInstances()).find((instance) => instance.id === id)?.verify, current.owners[0]!))
      .toMatchObject({ state: "pass", result: { state: "pass", exitCode: 0 } });
    const ownerId = target.owners[0]!;
    const source = await readFile(join(target.project.cwd, "hello.txt"), "utf8");
    await expect.poll(() => records(join(runRoot, "events", `${ownerId}.jsonl`)).some((record) => record.t === "session_ready" && record.ok === true), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => page.evaluate(async (id) => (await window.termina.getInstances()).find((instance) => instance.id === id)?.model ?? null, ownerId)).not.toBeNull();
    const beforeInstances = await identities(page);
    const overview = await page.evaluate(() => window.termina.getWorkOverview());
    const project = overview.projects.find((entry) => entry.projectId === target.project.id)!;
    const owner = project.terminals.find((entry) => entry.terminalId === ownerId)!;
    const request: PlanTaskStartRequest = { projectRoot: project.root, owner: { projectId: project.projectId, terminalId: ownerId,
      generation: owner.generation, workspaceId: owner.workArea!.workspaceId, root: owner.workArea!.root }, task: owner.tasks[0]!.task };
    const started = await page.evaluate((request) => window.termina.startPlanTask(request), request);
    expect(started, started.error).toMatchObject({ ok: true });
    let workerId = "";
    await expect.poll(async () => {
      workerId = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]?.workerId ?? "";
      return workerId.length > 0;
    }).toBe(true);
    // Candidate launch sets TERMINA_CORE_APPROVE=all; exercise that real
    // policy rather than manufacturing an approval prompt for its bounded check.
    await expect.poll(() => terminalText(page, workerId)).toContain("perm always");
    await expect.poll(() => finalResponse !== null).toBe(true);
    expect(calls).toBe(4);
    const worker = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === workerId)!;
    expect(worker).toMatchObject({ dispatchWorker: true, busy: true, projectId: target.project.id });
    expect(worker.cwd).not.toBe(target.project.cwd);
    expect(await readFile(join(worker.cwd, "hello.txt"), "utf8")).toBe(candidateContent);
    expect(await readFile(join(target.project.cwd, "hello.txt"), "utf8")).toBe(source);
    const liveTask = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!;
    const workerSidecar = join(dirname(worker.cwd), `${liveTask.candidate!.label}-support`, "events", `${workerId}.jsonl`);
    expect(records(workerSidecar).filter((record) => record.t === "tool_end" && record.isError === false)).toHaveLength(3);
    expect(records(workerSidecar)).toContainEqual(expect.objectContaining({
      t: "tool_end", toolCallId: "review-bash", isError: false,
    }));
    const live = await page.evaluate(() => window.termina.getWorkOverview());
    expect(live.projects.find((entry) => entry.projectId === target.project.id)!.terminals.find((entry) => entry.terminalId === workerId)!.trackedChanges).toBe(1);
    expect(live.items.filter((item) => item.reason === "pending-review")).toEqual([]);
    expect(live.projects.find((entry) => entry.projectId === target.project.id)!.terminals.find((entry) => entry.terminalId === ownerId)!.tasks[0]!.worker)
      .toMatchObject({ terminalId: workerId, generation: worker.generation });
    const response = finalResponse!; finalResponse = null;
    complete(response, "Feature: complete — Updated hello.txt in the independent candidate.\nChecks: test \"$(cat hello.txt)\" = \"pending review candidate output\" passed.\nThe candidate has not been promoted to the source project.");
    await expect.poll(() => page.evaluate(async (id) => (await window.termina.getPlan(id))[0]?.dispatchResult, ownerId))
      .toEqual({ workerId, outcome: "completed" });
    await expect.poll(() => page.evaluate(async ({ projectId, ownerId }) => (await window.termina.getProjectWorkSummary(projectId))!.terminals
      .find((terminal) => terminal.terminalId === ownerId)!.tasks[0]!.candidate, { projectId: target.project.id, ownerId }))
      .toMatchObject({ state: "ready", headStateId: expect.stringMatching(/^[a-f0-9]{40}$/) });
    const completed = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!;
    expect(completed).toMatchObject({ state: "done", dispatchResult: { workerId, outcome: "completed" } });
    expect(completed.workerId).toBeUndefined();
    expect(completed.claimed).toBeUndefined();
    const canonical = (await page.evaluate((id) => window.termina.getWorldlines(id), target.project.id))
      .find((entry) => entry.comparisonId === completed.candidate!.comparisonId && entry.label === completed.candidate!.label)!;
    expect(canonical).toMatchObject({ root: worker.cwd, state: "ready", headStateId: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(canonical.headStateId).not.toBe(canonical.comparisonBaseStateId);
    const settled = await page.evaluate(() => window.termina.getWorkOverview());
    const item = settled.items.find((entry) => entry.reason === "pending-review" && entry.taskText === taskText)!;
    expect(item).toMatchObject({ projectId: target.project.id, terminalId: ownerId, workArea: { root: target.project.cwd, kind: "project" },
      candidate: { comparisonId: canonical.comparisonId, label: canonical.label, root: canonical.root, version: canonical.version, headStateId: canonical.headStateId } });
    const taskSummary = settled.projects.find((entry) => entry.projectId === target.project.id)!.terminals.find((entry) => entry.terminalId === ownerId)!;
    expect(taskSummary.verify).toMatchObject({ state: "untested" });
    expect(taskSummary.tasks[0]).toMatchObject({ worker: null, attention: ["pending-review"] });
    await openOverview(page);
    const filter = page.getByRole("searchbox", { name: "Filter projects and tasks", exact: true });
    await filter.fill(current.project.cwd);
    await attentionRow(page, item).getByRole("button", { name: "Inspect details", exact: true }).click();
    const inspector = page.locator("#project-work-inspector");
    await expect(fact(inspector, "Assigned context")).toContainText(worker.cwd);
    await expect(fact(inspector, "Assigned context")).toContainText("Separate candidate tree");
    await expect(fact(inspector, "Evidence")).not.toContainText("Owner check: pass");
    await expect(inspector).toContainText("Result pending review");
    await expect(filter).toHaveValue(current.project.cwd);
    expect((await activeProject(page)).id).toBe(current.project.id);
    expect(await identities(page)).toEqual([...beforeInstances, { id: worker.id, cwd: worker.cwd, generation: worker.generation,
      projectId: worker.projectId, workspaceId: worker.workspaceId }]);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.find((entry) => entry.id === item.id)).toBeTruthy();
    // Exit through the real worker's TUI. This keeps native dialogs and all
    // lifecycle methods intact while exercising the owned PTY exit path.
    await page.evaluate((id) => window.termina.writeTerminal(id, "/exit\r"), workerId);
    await expect.poll(() => page.evaluate(async (id) => (await window.termina.getInstances()).some((entry) => entry.id === id), workerId)).toBe(false);
    await expect.poll(() => page.evaluate(async (text) => (await window.termina.getWorkOverview()).items
      .filter((entry) => entry.reason === "pending-review" && entry.taskText === text).length, taskText)).toBe(1);
    const retainedTask = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!;
    expect(retainedTask.candidate).toEqual(completed.candidate);
    expect(retainedTask.dispatchResult).toEqual(completed.dispatchResult);
    const retained = (await page.evaluate((id) => window.termina.getWorldlines(id), target.project.id))
      .find((entry) => entry.comparisonId === canonical.comparisonId && entry.label === canonical.label)!;
    expect(retained).toMatchObject({ root: worker.cwd, state: "settled", headStateId: expect.stringMatching(/^[a-f0-9]{40}$/) });
    await expect(inspector).toContainText(worker.cwd);
    await expect(inspector.getByRole("button", { name: "Focus task", exact: true })).toBeDisabled();
    await inspector.getByRole("button", { name: "Open candidate controls", exact: true }).click();
    await expect(page.locator("#attention-view")).toBeHidden();
    const card = page.locator(`.candidate-card[data-cmp="${canonical.comparisonId}"][data-label="${canonical.label}"]`);
    await expect(card).toBeVisible();
    await expect(card).toBeFocused();
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.filter((entry) => entry.reason === "pending-review" && entry.taskText === taskText)).toHaveLength(1);
    expect(await readFile(join(worker.cwd, "hello.txt"), "utf8")).toBe(candidateContent);
    expect(await readFile(join(target.project.cwd, "hello.txt"), "utf8")).toBe(source);
    expect(await page.evaluate((id) => window.termina.discardWorldline(id), canonical.comparisonId)).toEqual({ ok: true });
    await expect.poll(() => page.evaluate(async ({ projectId, comparisonId }) => (await window.termina.getWorldlines(projectId))
      .some((entry) => entry.comparisonId === comparisonId), { projectId: target.project.id, comparisonId: canonical.comparisonId })).toBe(false);
    await expect.poll(() => page.evaluate(async (text) => (await window.termina.getWorkOverview()).items
      .filter((entry) => entry.reason === "pending-review" && entry.taskText === text), taskText)).toEqual([]);
    expect(existsSync(worker.cwd)).toBe(false);
    expect(await readFile(join(target.project.cwd, "hello.txt"), "utf8")).toBe(source);
    expect((await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]?.dispatchResult).toEqual({ workerId, outcome: "completed" });
    expect(await identities(page)).toEqual(beforeInstances);
    expect(calls).toBe(4);
  });
});
