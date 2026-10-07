import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import type { ReviewTarget, WorldlineSummary } from "../../shared/types.ts";
import { writeVerifyPackage } from "../fixtures/verify-package.ts";
import { mockLifecycleDialogs } from "./lifecycle-dialog.ts";
import { heldReviewResponse, holdNextReviewResponse, releaseReviewResponse, restoreReviewResponse } from "./review-response-gate.ts";
import { observeReviewWrites } from "./review-observation.ts";

function complete(response: ServerResponse, call?: { name: string; args: Record<string, string> }): void {
  const output = call ? [{ type: "function_call", id: `candidate-${call.name}-${Date.now()}`, call_id: `candidate-call-${Date.now()}`, name: call.name, arguments: JSON.stringify(call.args) }] : [];
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  if (!call) response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Source context recorded. No changes made." })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}

function ready(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").split("\n").some((line) => {
    const record = parseSidecarRecord(line);
    return record?.t === "session_ready" && record.ok === true;
  });
}

async function sourceCandidate(page: Page, runRoot: string): Promise<WorldlineSummary> {
  await expect(page.locator("#splash")).toBeHidden();
  const owner = (await page.evaluate(() => window.termina.getInstances()))[0]!;
  await expect.poll(() => ready(join(runRoot, "events", `${owner.id}.jsonl`))).toBe(true);
  await page.evaluate((id) => window.termina.writeTerminal(id, "candidate-review-source\r"), owner.id);
  await expect.poll(async () => (await page.evaluate((id) => window.termina.getRuns(id), owner.id)).at(-1)?.settledStateId).toMatch(/^[a-f0-9]{40}$/);
  await expect.poll(async () => (await page.evaluate((id) => window.termina.getTimeline(id), owner.id))
    .some((event) => event.t === "agent_settled" && event.stateId && event.entryId && !event.evicted)).toBe(true);
  const moment = (await page.evaluate((id) => window.termina.getTimeline(id), owner.id))
    .filter((event) => event.t === "agent_settled" && event.stateId && event.entryId && !event.evicted).at(-1)!;
  expect(moment).toBeTruthy();
  const result = await page.evaluate(({ id, seq }) => window.termina.forkPoint(id, seq), { id: owner.id, seq: moment.seq });
  expect(result).toMatchObject({ ok: true });
  const candidate = (await page.evaluate((id) => window.termina.getWorldlines(id), owner.projectId!))
    .find((item) => item.comparisonId === result.comparisonId)!;
  expect(candidate).toMatchObject({ role: "moment", state: "ready", error: null });
  expect(candidate.terminalId).toBeTruthy();
  await expect.poll(() => ready(join(dirname(candidate.root), "A-support", "events", `${candidate.terminalId}.jsonl`))).toBe(true);
  return candidate;
}

async function backgroundDraft(page: Page, projectRoot: string, runRoot: string) {
  const root = join(runRoot, "background-editor");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", projectRoot, root]);
  await page.evaluate((root) => window.termina.projectOpenPath(root), root);
  const project = (await page.evaluate(() => window.termina.projectList())).find((item) => item.active)!;
  const path = join(root, "greeting.ts");
  const disk = readFileSync(path, "utf8");
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
  const tab = page.locator(".editor-tab").filter({ hasText: "greeting.ts" });
  await expect(tab).toHaveClass(/active/);
  const buffer = () => page.evaluate(() => (window as unknown as {
    __editorMgr: { editor: { getModel(): { getValue(): string } } };
  }).__editorMgr.editor.getModel().getValue());
  await expect.poll(buffer).toBe(disk);
  const text = "// preserve this unsaved draft through candidate lifecycle changes\n";
  await page.evaluate((text) => {
    const editor = (window as unknown as {
      __editorMgr: { editor: { getModel(): { getFullModelRange(): unknown }; executeEdits(source: string, edits: { range: unknown; text: string }[]): void } };
    }).__editorMgr.editor;
    editor.executeEdits("candidate-review-test", [{ range: editor.getModel().getFullModelRange(), text }]);
  }, text);
  await expect.poll(buffer).toBe(text);
  await expect(tab.locator(".tab-dirty")).toBeVisible();
  return { project, path, disk, text, tab, buffer };
}

test.describe("Selected work review in a real candidate", () => {
  let server: Server;
  const calls = new Map<string, number>();
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
        const key = body.includes("candidate-review-reopened") ? "reopened" : body.includes("candidate-review-initial") ? "initial" : "source";
        const count = (calls.get(key) ?? 0) + 1;
        calls.set(key, count);
        if (key === "source") complete(response);
        else if (count === 1) complete(response, { name: "read_file", args: { path: "hello.txt" } });
        else if (count === 2) complete(response, { name: "write_file", args: { path: "hello.txt", content: `candidate ${key} disk\n` } });
        else if (count === 3) complete(response, { name: "write_file", args: { path: "candidate-only.txt", content: `candidate ${key} creation\n` } });
        else response.flushHeaders(); // A real ongoing model call, interrupted only by normal lifecycle actions.
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
    for (const [key, value] of Object.entries({ TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-loopback-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` })) {
      previous.set(key, process.env[key]); process.env[key] = value;
    }
  });
  test.beforeEach(() => calls.clear());
  test.afterAll(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  test("retained failed reopen reveals recovery, then reuses the canonical comparison and live PTY", async ({ page, projectRoot, runRoot, electronApp }) => {
    const candidate = await sourceCandidate(page, runRoot);
    const source = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
    const terminal = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === candidate.terminalId)!;
    await mockLifecycleDialogs(electronApp, 0);
    expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation!), terminal)).toEqual({ ok: true });
    await expect.poll(async () => (await page.evaluate(() => window.termina.getInstances())).some((instance) => instance.id === terminal.id)).toBe(false);
    // Closed roster entries can still be draining. Settled is published only
    // after the runtime releases this PTY, so Open must then attempt a new startup.
    await expect.poll(async () => (await page.evaluate((id) => window.termina.getWorldlines(id), source.id))
      .find((summary) => summary.id === candidate.id)?.state).toBe("settled");
    const sessionFile = candidate.sessionFile!;
    expect(realpathSync(sessionFile).startsWith(`${realpathSync(runRoot)}/`)).toBe(true);
    const sessionBytes = readFileSync(sessionFile);
    const controlFile = join(dirname(candidate.root), `${candidate.label}-support`, "events", "startup-control.json");
    expect(realpathSync(dirname(controlFile)).startsWith(`${realpathSync(runRoot)}/`)).toBe(true);
    expect(existsSync(controlFile)).toBe(false);
    // Block the canonical bound startup-control write, not session validation.
    // No second PTY starts and the actual retained session bytes stay intact.
    mkdirSync(controlFile);
    try {
      expect(await page.evaluate(({ comparisonId, label }) => window.termina.openWorldlineTerminal(comparisonId, label), candidate)).toMatchObject({ ok: false });
    } finally { rmdirSync(controlFile); }
    expect(readFileSync(sessionFile).equals(sessionBytes)).toBe(true);
    const work = await page.evaluate((id) => window.termina.getProjectWorkSummary(id), source.id);
    expect(work!.candidateRecoveries).toEqual([expect.objectContaining({ comparisonId: candidate.comparisonId,
      label: candidate.label, root: candidate.root, recovery: "open" })]);
    const before = (await page.evaluate(() => window.termina.getInstances())).map((instance) => instance.id);
    await page.locator("#btn-all-projects").click();
    const card = page.locator(".overview-work-card").filter({ hasText: "startup recovery" });
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "Recovery details", exact: true }).click();
    const inspector = page.locator("#project-work-inspector");
    await expect(inspector).toContainText("No live candidate terminal");
    await expect(inspector.getByRole("button", { name: "Focus task", exact: true })).toBeHidden();
    await inspector.getByRole("button", { name: "Open candidate recovery", exact: true }).click();
    await expect(page.locator("#attention-view")).toBeHidden();
    const open = page.locator(`.candidate-card[data-cmp="${candidate.comparisonId}"][data-label="${candidate.label}"] .cand-open`);
    await expect(open).toBeFocused();
    expect((await page.evaluate(() => window.termina.getInstances())).map((instance) => instance.id)).toEqual(before);
    await open.click();
    await expect.poll(async () => (await page.evaluate((id) => window.termina.getWorldlines(id), source.id))
      .find((summary) => summary.id === candidate.id)?.state).toBe("ready");
    const reopened = (await page.evaluate((id) => window.termina.getWorldlines(id), source.id)).find((summary) => summary.id === candidate.id)!;
    expect(reopened.comparisonId).toBe(candidate.comparisonId);
    expect(reopened.label).toBe(candidate.label);
    expect(reopened.root).toBe(candidate.root);
    expect(reopened.sessionFile).toBe(sessionFile);
    expect(reopened.terminalId).not.toBe(terminal.id);
    expect((await page.evaluate((id) => window.termina.getProjectWorkSummary(id), source.id))!.candidateRecoveries).toEqual([]);
    const live = (await page.evaluate(() => window.termina.getInstances())).map((instance) => instance.id);
    await open.click();
    expect((await page.evaluate(() => window.termina.getInstances())).map((instance) => instance.id)).toEqual(live);
    expect((await page.evaluate((id) => window.termina.getWorldlines(id), source.id)).map((summary) => summary.terminalId)).toEqual([reopened.terminalId]);
    expect(await page.evaluate((id) => window.termina.getPlan(id), before[0]!)).toEqual([]);
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
  });

  const scenarios = [
    { lifecycle: "close and reopen", delayed: false },
    { lifecycle: "close and reopen", delayed: true },
    { lifecycle: "discard", delayed: false },
    { lifecycle: "discard", delayed: true },
  ] as const;
  for (const { lifecycle, delayed } of scenarios) {
    test(`${lifecycle} invalidates ${delayed ? "a late canonical reply" : "a loaded diff"} without disturbing background work`, async ({ page, projectRoot, runRoot, electronApp }) => {
      writeFileSync(join(projectRoot, ".gitignore"), "/node_modules/\n/stages.jsonl\n");
      await writeVerifyPackage(projectRoot, { test: "termina-verify-fixture fail" });
      const candidate = await sourceCandidate(page, runRoot);
      const source = (await page.evaluate(() => window.termina.projectList())).find((item) => item.active)!;
      const owner = (await page.evaluate(() => window.termina.getInstances())).find((item) => item.projectId === source.id && item.cwd === source.cwd)!;
      expect(await page.evaluate((id) => window.termina.runVerify(id), owner.id)).toEqual({ ok: true });
      await expect.poll(async () => (await page.evaluate(() => window.termina.getInstances())).find((item) => item.id === owner.id)?.verify?.state).toBe("fail");
      await page.evaluate((id) => window.termina.writeTerminal(id, "candidate-review-initial\r"), candidate.terminalId!);
      await expect.poll(() => calls.get("initial")).toBe(4);
      const instance = (await page.evaluate(() => window.termina.getInstances())).find((item) => item.id === candidate.terminalId)!;
      expect(instance.busy).toBe(true);
      expect(instance.workspaceId).not.toBe(owner.workspaceId);
      const target: ReviewTarget = { projectId: source.id, workspaceId: instance.workspaceId!, root: candidate.root, terminalId: instance.id, generation: instance.generation! };
      expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
      expect(existsSync(join(projectRoot, "candidate-only.txt"))).toBe(false);
      expect(readFileSync(join(candidate.root, "hello.txt"), "utf8")).toBe("candidate initial disk\n");
      // Ownership/root checks are real main IPC validation, not renderer-only hiding.
      expect(await page.evaluate((target) => window.termina.getReviewFiles(target, 0), { ...target, root: source.cwd })).toMatchObject({ ok: false });
      expect(await page.evaluate((target) => window.termina.getReviewFiles(target, 0), { ...target, workspaceId: owner.workspaceId! })).toMatchObject({ ok: false });
      const draft = await backgroundDraft(page, projectRoot, runRoot);
      const attention = (await page.evaluate(() => window.termina.getWorkOverview())).items;
      expect(attention.some((item) => item.terminalId === owner.id && item.reason === "verify-failed")).toBe(true);
      await page.locator("#btn-all-projects").click();
      const card = page.locator(`.overview-project[data-project-id="${source.id}"] .overview-work-card`).filter({ hasText: instance.id });
      await expect(card.locator(".overview-work-evidence")).toContainText("2 tracked paths");
      await card.getByRole("button", { name: "Context details", exact: true }).click();
      const inspector = page.locator("#project-work-inspector");
      const changes = inspector.locator(".overview-work-changes");
      await expect(inspector).toContainText("Separate candidate tree");
      await expect(changes).toBeHidden();
      await inspector.getByRole("button", { name: "Inspect changes", exact: true }).click();
      await expect(changes.locator(".overview-changes-scope")).toHaveText(`${instance.id} · ${candidate.root}`);
      await expect(changes.locator(".overview-changes-list button")).toHaveCount(2);
      await changes.getByRole("button", { name: "modified · hello.txt", exact: true }).click();
      const diff = changes.locator(".overview-changes-diff");
      await expect(changes.locator(".overview-changes-diff-status")).toHaveText("Read-only captured baseline to current disk diff.");
      await expect(diff).toContainText("candidate initial disk");
      await expect(diff).toContainText("hello");
      await expect(changes).toContainText("not an attribution to this task");
      await changes.getByRole("button", { name: "Focus diff", exact: true }).click();
      await page.keyboard.type("SHOULD_NOT_WRITE");
      await expect(diff).not.toContainText("SHOULD_NOT_WRITE");
      expect(readFileSync(join(candidate.root, "hello.txt"), "utf8")).toBe("candidate initial disk\n");
      await expect(changes.getByRole("button", { name: /Accept|Revert|Save/ })).toHaveCount(0);
      if (delayed) await holdNextReviewResponse(electronApp, lifecycle === "discard" ? "review:files" : "review:diff", instance.id);
      try {
        if (delayed) {
          if (lifecycle === "discard") await changes.getByRole("button", { name: "Reload changes", exact: true }).click();
          else await changes.getByRole("button", { name: "modified · hello.txt", exact: true }).click();
          await expect.poll(async () => (await heldReviewResponse(electronApp)).waiting).toBe(true);
          const held = await heldReviewResponse(electronApp);
          expect(held.target).toEqual(target);
          expect(held.result).toMatchObject(lifecycle === "discard" ? { ok: true, total: 2 } : { ok: true, baseline: "hello\n", current: "candidate initial disk\n" });
        } else {
          await expect(diff).toBeVisible();
        }
        if (lifecycle === "discard") {
          expect(await page.evaluate((id) => window.termina.discardWorldline(id), candidate.comparisonId)).toEqual({ ok: true });
          await expect.poll(async () => (await page.evaluate((id) => window.termina.getWorldlines(id), source.id)).length).toBe(0);
          expect(existsSync(candidate.root)).toBe(false);
        } else {
          await mockLifecycleDialogs(electronApp, 0);
          expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), instance)).toEqual({ ok: true });
          await expect.poll(async () => (await page.evaluate((id) => window.termina.getWorldlines(id), source.id))[0]?.state).toBe("settled");
          expect(readFileSync(join(candidate.root, "hello.txt"), "utf8")).toBe("candidate initial disk\n");
        }
        await expect.poll(async () => (await page.evaluate(() => window.termina.getInstances())).some((item) => item.id === instance.id)).toBe(false);
        await expect(changes).toBeHidden();
        await expect(changes.locator(".overview-changes-list button")).toHaveCount(0);
        await expect(changes.locator(".overview-changes-filename")).toHaveText("");
        expect(await page.evaluate((target) => window.termina.getReviewDiff(target, `${target.root}/hello.txt`), target)).toMatchObject({ ok: false });
        if (delayed) {
          await releaseReviewResponse(electronApp);
          await expect.poll(async () => (await heldReviewResponse(electronApp)).delivered).toBe(true);
          // A canonical overview round trip after release is an IPC ordering barrier.
          await page.evaluate(() => window.termina.getWorkOverview());
          await expect(changes).toBeHidden();
          await expect(changes.locator(".overview-changes-list button")).toHaveCount(0);
        }
        await expect(diff).toBeHidden();
      } finally {
        if (delayed) await restoreReviewResponse(electronApp);
      }
      if (lifecycle === "close and reopen") {
        const reopened = await page.evaluate(({ comparisonId, label }) => window.termina.openWorldlineTerminal(comparisonId, label), candidate);
        expect(reopened).toMatchObject({ ok: true });
        expect(reopened.terminalId).not.toBe(instance.id);
        const nextWorkspace = (await page.evaluate(() => window.termina.getInstances())).find((item) => item.id === reopened.terminalId)!.workspaceId;
        // Native disk writes finish before main's asynchronous line-diff worker
        // sends file:changed. Wait for both real notifications, or a correct late
        // invalidation can clear the freshly loaded UI diff during this assertion.
        const observedWrites = await observeReviewWrites(page, { projectId: source.id, workspaceId: nextWorkspace }, {
          "hello.txt": "candidate reopened disk\n", "candidate-only.txt": "candidate reopened creation\n",
        });
        await page.evaluate((id) => window.termina.writeTerminal(id, "candidate-review-reopened\r"), reopened.terminalId!);
        await expect.poll(() => calls.get("reopened")).toBe(4);
        await expect.poll(() => readFileSync(join(candidate.root, "hello.txt"), "utf8")).toBe("candidate reopened disk\n");
        await observedWrites();
        const next = (await page.evaluate(() => window.termina.getInstances())).find((item) => item.id === reopened.terminalId)!;
        expect(next.workspaceId).not.toBe(instance.workspaceId);
        expect(next.cwd).toBe(candidate.root);
        const nextCard = page.locator(`.overview-project[data-project-id="${source.id}"] .overview-work-card`).filter({ hasText: next.id });
        // The debounced overview must have consumed the completed tool list too;
        // its legitimate 0 → 2 tracked-path update invalidates earlier review data.
        await expect(nextCard.locator(".overview-work-evidence")).toContainText("2 tracked paths");
        await nextCard.getByRole("button", { name: "Context details", exact: true }).click();
        await inspector.getByRole("button", { name: "Inspect changes", exact: true }).click();
        await changes.getByRole("button", { name: "modified · hello.txt", exact: true }).click();
        await expect(changes.locator(".overview-changes-scope")).toHaveText(`${next.id} · ${candidate.root}`);
        await expect(changes.locator(".overview-changes-diff-status")).toHaveText("Read-only captured baseline to current disk diff.");
        await expect(diff).toContainText("candidate initial disk");
        await expect(diff).toContainText("candidate reopened disk");
        const result = await page.evaluate((target) => window.termina.getReviewDiff(target, `${target.root}/hello.txt`), { ...target, terminalId: next.id, generation: next.generation!, workspaceId: next.workspaceId! });
        expect(result).toMatchObject({ ok: true, baseline: "candidate initial disk\n", current: "candidate reopened disk\n" });
      }
      await expect(page.locator("#attention-view")).toBeVisible();
      expect(await page.locator("#main-split").evaluate((node) => (node as HTMLElement).inert)).toBe(true);
      expect((await page.evaluate(() => window.termina.projectList())).find((item) => item.active)?.id).toBe(draft.project.id);
      const withoutModel = ({ model: _model, ...item }: (typeof attention)[number]) => item;
      expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(attention.map(withoutModel));
      await expect.poll(draft.buffer).toBe(draft.text);
      await expect(draft.tab.locator(".tab-dirty")).toBeVisible();
      expect(readFileSync(draft.path, "utf8")).toBe(draft.disk);
      expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
      expect(existsSync(join(projectRoot, "candidate-only.txt"))).toBe(false);
    });
  }
});
