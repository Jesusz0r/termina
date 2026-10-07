import { test, expect } from "./fixtures.ts";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Page } from "@playwright/test";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { Terminal } from "@xterm/xterm";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { readSystemProcessIdentity } from "../../shared/process-identity.ts";
import { answerLifecycleDialog, lifecycleDialogs, mockLifecycleDialogs } from "./lifecycle-dialog.ts";

/**
 * Plans travel through the real agent → sidecar → main → plan:update path.
 * The loopback provider keeps the owner genuinely running until dispatch
 * interrupts it. No producer sequences or DOM markup are fabricated.
 */
const OWNER_PROMPT = "/plan plan-board-e2e-owner\r";

function complete(response: ServerResponse, text: string, call?: { id: string; name: "read_file" | "write_file" | "bash"; args: Record<string, string> }): void {
  response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
  const output = call ? [{ type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }] : [];
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}

/** The active pane's terminal id (same seam as review.spec.ts). */
async function activeInstanceId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const panes = w.__panes as Map<string, { instanceId: string; error: boolean; exited: boolean }>;
    const pane = [...panes.values()].find((p) => !p.error && !p.exited) ?? [...panes.values()][0]!;
    return pane.instanceId;
  });
}

async function waitForReady(runRoot: string, id: string): Promise<void> {
  const sidecar = join(runRoot, "events", `${id}.jsonl`);
  await expect.poll(() => existsSync(sidecar) && readFileSync(sidecar, "utf8").split("\n").some((line) => {
    const record = parseSidecarRecord(line);
    return record?.t === "session_ready" && record.ok === true;
  }), { timeout: 15_000 }).toBe(true);
}

async function terminalText(page: Page, id: string): Promise<string> {
  return page.evaluate((id) => {
    const panes = (window as unknown as { __panes: Map<string, { view: { getTerminal(): Terminal } }> }).__panes;
    const buffer = panes.get(id)?.view.getTerminal().buffer.active;
    if (!buffer) return "";
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").join("\n");
  }, id);
}

test.describe("Plan Board UI & Task Lifecycle E2E", () => {
  let server: Server;
  let ownerPlan = "";
  let ownerCalls = 0;
  let ownerResponse: ServerResponse | null = null;
  let catalogAvailable = true;
  let expireWorkerCredential = false;
  let workerBashCommand = "";
  let holdWorkerAfterRead = false;
  let holdWorkerAfterWrite = false;
  let workerResponse: ServerResponse | null = null;
  const workerCredentials: string[] = [];
  const previous = new Map<string, string | undefined>();

  async function startOwnerPlan(page: Page, id: string, plan: string, runRoot: string): Promise<void> {
    ownerPlan = plan;
    // session_ready follows raw input initialization; CR is then a submit key.
    await waitForReady(runRoot, id);
    await page.evaluate(({ id, prompt }) => window.termina.writeTerminal(id, prompt), { id, prompt: OWNER_PROMPT });
    try {
      await expect.poll(() => ownerResponse !== null, { timeout: 15_000 }).toBe(true);
    } catch (error) {
      await test.info().attach("owner-provider", { body: JSON.stringify({ ownerCalls, instances: await page.evaluate(() => window.termina.getInstances()) }), contentType: "application/json" });
      const sidecar = join(runRoot, "events", `${id}.jsonl`);
      if (existsSync(sidecar)) await test.info().attach("owner-sidecar", { path: sidecar, contentType: "application/x-ndjson" });
      throw error;
    }
    await expect(page.locator("#status-state")).toContainText("agent working");
  }
  test.beforeAll(async () => {
    // A real startup worker needs a provider. Keep it local and explicitly
    // report no work, so this exercises incomplete settlement, not auth failure.
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: catalogAvailable ? "gpt-5.6-sol" : "gpt-5.6-other" }] }));
      } else if (request.method === "POST" && request.url?.endsWith("/responses")) {
        let body = "";
        request.on("data", (chunk) => { body += chunk.toString(); });
        request.on("end", () => {
          const isOwner = body.includes("plan-board-e2e-owner");
          if (!isOwner) workerCredentials.push(request.headers.authorization ?? "");
          if (!isOwner && expireWorkerCredential && request.headers.authorization !== "Bearer synthetic-reauthenticated-token" && workerCredentials.length > 1) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "Fixture credential was revoked during the run." } }));
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (!isOwner && holdWorkerAfterWrite) {
            if (workerCredentials.length === 1) complete(response, "Writing the designated fixture input.", {
              id: "worker-before-finalization", name: "write_file", args: { path: "hello.txt", content: "fixture durable output\n" },
            });
            else if (workerCredentials.length === 2) complete(response, "Checking the real write before finalization.", {
              id: "worker-settlement-check", name: "bash", args: { command: `test "$(cat hello.txt)" = "fixture durable output"` },
            });
            else { response.flushHeaders(); workerResponse = response; }
          } else if (!isOwner && holdWorkerAfterRead) {
            if (workerCredentials.length === 1) complete(response, "Reading source before waiting.", { id: "worker-before-exit", name: "read_file", args: { path: "hello.txt" } });
            else { response.flushHeaders(); workerResponse = response; }
          } else if (!isOwner && workerBashCommand && workerCredentials.length === 1) {
            complete(response, "Running the bounded dispatch command.", { id: "worker-running-bash", name: "bash", args: { command: workerBashCommand } });
          } else if (!isOwner && expireWorkerCredential && workerCredentials.length === 1) {
            complete(response, "Reading source before the fixture credential is revoked.", { id: "worker-before-auth-rejection", name: "read_file", args: { path: "hello.txt" } });
          } else if (!isOwner) {
            complete(response, "No changes made; this task remains incomplete.");
          } else if (++ownerCalls === 1) {
            complete(response, ownerPlan, { id: "owner-read-1", name: "read_file", args: { path: "hello.txt" } });
          } else {
            // A real pending model call, interrupted by the production dispatch path.
            response.flushHeaders();
            ownerResponse = response;
          }
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
    const environment = {
      TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol",
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`,
      OPENAI_API_KEY: "synthetic-loopback-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    };
    for (const [key, value] of Object.entries(environment)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
  });
  test.beforeEach(() => { ownerPlan = ""; ownerCalls = 0; ownerResponse = null; catalogAvailable = true; expireWorkerCredential = false; workerBashCommand = ""; holdWorkerAfterRead = false; holdWorkerAfterWrite = false; workerResponse = null; workerCredentials.length = 0; });
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
  test("blocks an independent agent before startup on the same source tree", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const ownerId = await activeInstanceId(page);
    await startOwnerPlan(page, ownerId, "Plan:\n- [ ] Edit greeting.ts\n", runRoot);
    const other = await page.evaluate(() => window.termina.createTerminal({ type: "agent" }));
    expect(other.ok).toBe(true);
    const otherId = other.id!;
    await waitForReady(runRoot, otherId);
    await page.evaluate((id) => window.termina.writeTerminal(id, "Edit greeting.ts independently\r"), otherId);
    await expect.poll(() => terminalText(page, otherId), { timeout: 15_000 }).toContain("Source files overlap");
    const records = readFileSync(join(runRoot, "events", `${otherId}.jsonl`), "utf8").split("\n").map(parseSidecarRecord);
    expect(records.some((record) => record?.t === "agent_start")).toBe(false);
    const instances = await page.evaluate(() => window.termina.getInstances());
    expect(instances.find((instance) => instance.id === ownerId)?.busy).toBe(true);
    expect(instances.find((instance) => instance.id === otherId)?.busy).toBe(false);
  });

  test("agent and shell admission requires a real source handoff, not concurrent unknown shell writes", async ({ page, runRoot, projectRoot, electronApp }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const ownerId = await activeInstanceId(page);
    await startOwnerPlan(page, ownerId, "Plan:\n- [ ] Inspect hello.txt\n", runRoot);
    const before = await page.evaluate(() => window.termina.getInstances());
    const rejected = await page.evaluate(() => window.termina.createTerminal({ type: "shell", shell: "/bin/bash" }));
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining("Source files overlap") });
    expect((await page.evaluate(() => window.termina.getInstances())).map((instance) => instance.id)).toEqual(before.map((instance) => instance.id));
    complete(ownerResponse!, "The plan is ready; no files were changed.");
    await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)?.busy), ownerId)).toBe(false);
    const shell = await page.evaluate(() => window.termina.createTerminal({ type: "shell", shell: "/bin/bash" }));
    expect(shell).toMatchObject({ ok: true });
    await page.evaluate((id) => window.termina.writeTerminal(id, "printf '%s\\n' 'shell handoff source' > hello.txt\r"), shell.id!);
    await expect.poll(() => readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("shell handoff source\n");
    const sidecar = join(runRoot, "events", `${ownerId}.jsonl`);
    const starts = () => readFileSync(sidecar, "utf8").split("\n").map(parseSidecarRecord).filter((record) => record?.t === "agent_start").length;
    const priorStarts = starts();
    const priorCalls = ownerCalls;
    await page.evaluate((id) => window.termina.writeTerminal(id, "Read hello.txt during the live shell\r"), ownerId);
    await expect.poll(() => terminalText(page, ownerId)).toContain("Shell activity is unknown while its terminal is live");
    expect(starts()).toBe(priorStarts);
    expect(ownerCalls).toBe(priorCalls);
    const instance = (await page.evaluate(() => window.termina.getInstances())).find((entry) => entry.id === shell.id)!;
    await mockLifecycleDialogs(electronApp, 0);
    let nativeExitObserved = false;
    let outputTail = "";
    const observeExit = (chunk: Buffer) => {
      outputTail = (outputTail + chunk.toString()).slice(-4096);
      nativeExitObserved ||= outputTail.includes(`terminal ${shell.id} (shell) exited code=`);
    };
    const stdout = electronApp.process().stdout!;
    stdout.on("data", observeExit);
    try {
      expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), instance)).toEqual({ ok: true });
      // Roster removal precedes actual PTY cleanup. Source remains reserved until
      // native exit; observe that boundary instead of adding a delay or retries.
      await expect.poll(() => nativeExitObserved).toBe(true);
    } finally {
      stdout.off("data", observeExit);
    }
    ownerResponse = null;
    // The real TUI retains the rejected prompt and asks for Enter to retry it.
    await page.evaluate((id) => window.termina.writeTerminal(id, "\r"), ownerId);
    try {
      await expect.poll(() => ownerResponse !== null).toBe(true);
    } catch (error) {
      await test.info().attach("source-handoff-state", { body: JSON.stringify({
        ownerCalls, instances: await page.evaluate(() => window.termina.getInstances()),
        terminal: await terminalText(page, ownerId),
        records: readFileSync(sidecar, "utf8").split("\n").map(parseSidecarRecord).filter(Boolean),
      }, null, 2), contentType: "application/json" });
      throw error;
    }
    expect(starts()).toBe(priorStarts + 1);
    const current = ownerResponse!;
    ownerResponse = null;
    complete(current, "Reading the handed-off source.", { id: "owner-handoff-read", name: "read_file", args: { path: "hello.txt" } });
    await expect.poll(() => ownerResponse !== null).toBe(true);
    expect(readFileSync(sidecar, "utf8").split("\n").map(parseSidecarRecord).some((record) => record?.t === "tool_end" && record.toolCallId === "owner-handoff-read" && record.isError === false)).toBe(true);
    complete(ownerResponse!, "Source inspected; no writes or verification commands were requested.");
    await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)?.busy), ownerId)).toBe(false);
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("shell handoff source\n");
  });

  test("opening a physical-source alias preserves visible identity and rejects an independent writer", async ({ page, runRoot, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const ownerId = await activeInstanceId(page);
    await startOwnerPlan(page, ownerId, "Plan:\n- [ ] Edit greeting.ts\n", runRoot);
    const original = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
    const alias = join(runRoot, "alias-project");
    symlinkSync(projectRoot, alias, "dir");
    await page.evaluate((path) => window.termina.projectOpenPath(path), alias);
    const projects = await page.evaluate(() => window.termina.projectList());
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: original.id, cwd: original.cwd, active: true });
    expect(realpathSync(projects[0]!.cwd)).toBe(realpathSync(projectRoot));
    const select = page.locator(`#project-tabs .project-tab[data-project-id="${original.id}"] .project-select`);
    await expect(select).toContainText(original.cwd);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).projects).toEqual([
      { projectId: original.id, name: basename(original.cwd), root: original.cwd, working: 1, attentionCount: 0 },
    ]);
    const greeting = readFileSync(join(projectRoot, "greeting.ts"), "utf8");
    const other = await page.evaluate((projectId) => window.termina.createTerminal({ type: "agent", projectId }), original.id);
    expect(other).toMatchObject({ ok: true });
    await waitForReady(runRoot, other.id!);
    await page.evaluate((id) => window.termina.writeTerminal(id, "Edit greeting.ts independently through the alias\r"), other.id!);
    await expect.poll(() => terminalText(page, other.id!)).toContain("Source files overlap");
    const records = readFileSync(join(runRoot, "events", `${other.id}.jsonl`), "utf8").split("\n").map(parseSidecarRecord);
    expect(records.some((record) => record?.t === "agent_start")).toBe(false);
    expect((await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === ownerId)?.busy).toBe(true);
    expect(readFileSync(join(alias, "greeting.ts"), "utf8")).toBe(greeting);
    expect((await page.evaluate(() => window.termina.projectList())).find((project) => project.active)?.id).toBe(original.id);
  });

  test("source denial happens before a named MCP process starts", async ({ page, runRoot, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const ownerId = await activeInstanceId(page);
    await startOwnerPlan(page, ownerId, "Plan:\n- [ ] Edit greeting.ts\n", runRoot);
    const agentDir = join(runRoot, "home", ".termina", "agent");
    const script = join(projectRoot, "mcp-server.mjs");
    const marker = join(projectRoot, "mcp-started");
    writeFileSync(script, `
      import { createInterface } from "node:readline";
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "started");
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        const result = request.method === "initialize"
          ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture-mcp", version: "1" } }
          : { tools: [] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      });
    `);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "fixture-mcp": { command: process.execPath, args: [script] } } }));
    const other = await page.evaluate(() => window.termina.createTerminal({ type: "agent" }));
    expect(other.ok).toBe(true);
    await waitForReady(runRoot, other.id!);
    const prompt = "Use fixture-mcp to inspect greeting.ts\r";
    await page.evaluate(({ id, prompt }) => window.termina.writeTerminal(id, prompt), { id: other.id!, prompt });
    await expect.poll(() => terminalText(page, other.id!), { timeout: 15_000 }).toContain("Source files overlap");
    expect(existsSync(marker)).toBe(false);
    // A positive retry proves the named configuration really launches a process.
    const pending = ownerResponse!;
    ownerResponse = null;
    complete(pending, "The plan is ready for review.");
    await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)?.busy), ownerId)).toBe(false);
    await page.evaluate(({ id, prompt }) => window.termina.writeTerminal(id, `\x15${prompt}`), { id: other.id!, prompt });
    await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true);
  });

  test("allows nested navigation but rejects its independent writer", async ({ page, runRoot, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const ownerId = await activeInstanceId(page);
    await startOwnerPlan(page, ownerId, "Plan:\n- [ ] Edit greeting.ts\n", runRoot);
    const nested = join(projectRoot, "nested");
    mkdirSync(nested);
    await page.evaluate((path) => window.termina.projectOpenPath(path), nested);
    let nestedId = "";
    await expect.poll(async () => {
      const instances = await page.evaluate(() => window.termina.getInstances());
      nestedId = instances.find((instance) => instance.cwd === nested && instance.type === "agent")?.id ?? "";
      return nestedId;
    }).not.toBe("");
    await waitForReady(runRoot, nestedId);
    await page.evaluate((id) => window.termina.writeTerminal(id, "Create a nested file\r"), nestedId);
    await expect.poll(() => terminalText(page, nestedId), { timeout: 15_000 }).toContain("Source files overlap");
    const records = readFileSync(join(runRoot, "events", `${nestedId}.jsonl`), "utf8").split("\n").map(parseSidecarRecord);
    expect(records.some((record) => record?.t === "agent_start")).toBe(false);
    expect((await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === ownerId)?.busy).toBe(true);
  });

  test("renders plan panel and updates tasks dynamically", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const instanceId = await activeInstanceId(page);
    await startOwnerPlan(page, instanceId, "Plan:\n- [ ] Create utils.ts with an add function\n- [x] Edit greeting.ts so greeting is hi there\n", runRoot);
    await page.locator(".activity-tab[data-tab='plan']").click();
    const planList = page.locator("#plan-list");
    const tasks = planList.locator(".plan-task");
    await expect(tasks).toHaveCount(2, { timeout: 15_000 });

    // Production row shape: state class, plan-mark glyph, and plan text.
    const first = tasks.first();
    const last = tasks.last();
    await expect(first.locator(".plan-text")).toHaveText("Create utils.ts with an add function");
    await expect(last.locator(".plan-text")).toHaveText("Edit greeting.ts so greeting is hi there");
    await expect(first).toHaveClass(/state-pending/);
    await expect(last).toHaveClass(/state-done/);
    await expect(first.locator(".plan-mark")).toHaveText("○");
    await expect(last.locator(".plan-mark")).toHaveText("✓");
    await expect(first.locator(".plan-model")).toHaveCount(1);
    await expect(last.locator(".plan-model")).toHaveCount(0);
    // Only the pending row offers the dispatch action.
    await expect(first).toHaveClass(/dispatchable/);
    await expect(last).not.toHaveClass(/dispatchable/);

    // 2. A subsequent plan push updates the production rows in place.
    const pending = ownerResponse!;
    ownerResponse = null;
    complete(pending, "Plan:\n- [x] Create utils.ts with an add function\n- [x] Edit greeting.ts so greeting is hi there\n- [ ] Write tests for the add function\n", { id: "owner-read-2", name: "read_file", args: { path: "hello.txt" } });
    await expect.poll(() => ownerResponse !== null).toBe(true);
    await expect(tasks).toHaveCount(3, { timeout: 15_000 });
    await expect(tasks.first()).toHaveClass(/state-done/);
    await expect(tasks.first().locator(".plan-mark")).toHaveText("✓");
    await expect(tasks.last().locator(".plan-text")).toHaveText("Write tests for the add function");
    await expect(tasks.last()).toHaveClass(/dispatchable/);
    await expect(tasks.last().locator(".plan-model")).toHaveCount(1);

    // 3. The task action: dispatching the pending row runs the production
    //    dispatch IPC, and main spawns a worker terminal for the task. (The
    //    preload bridge is immutable from the page, so the outbound call is
    //    asserted by its real effect: the dispatch worker tab.)
    test.setTimeout(180_000);
    await tasks.last().locator(".plan-text").click();
    const dispatchTab = page.locator(".terminal-tab .tab-name", { hasText: "dispatch" });
    await expect(dispatchTab).toBeVisible({ timeout: 60_000 });

    // Clicking a done row dispatches nothing: still exactly one worker tab
    // after the click settles (negative assertion).
    await tasks.first().click();
    await page.waitForTimeout(1_000);
    await expect(page.locator(".terminal-tab .tab-name", { hasText: "dispatch" })).toHaveCount(1);
  });

  test("a worker rejected before preflight releases its assignment and can be retried", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const ownerId = await activeInstanceId(page);
    const taskText = "Edit greeting.ts after startup succeeds";
    await startOwnerPlan(page, ownerId, `Plan:\n- [ ] ${taskText}\n`, runRoot);
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks.length), ownerId)).toBe(1);
    catalogAvailable = false;
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId), { timeout: 15_000 }).toBe("failed");
    const rejected = await page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]!), ownerId);
    expect(rejected.state).toBe("pending");
    expect(rejected.workerId).toBeUndefined();
    expect(rejected.claimed).toBeUndefined();
    const workerId = rejected.dispatchResult!.workerId;
    const records = readFileSync(join(runRoot, "events", `${workerId}.jsonl`), "utf8").split("\n").map(parseSidecarRecord).filter(Boolean);
    expect(records.some((record) => record?.t === "agent_start_rejected" && String(record.error).includes("unavailable in the live catalog"))).toBe(true);
    expect(records.some((record) => record?.t === "preflight_request" || record?.t === "agent_start" || record?.t === "agent_settled")).toBe(false);
    await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)?.activity?.state), workerId)).toBe("idle");
    const mailbox = join(runRoot, "events", `mailbox-${ownerId}.md`);
    await expect.poll(() => existsSync(mailbox) ? readFileSync(mailbox, "utf8") : "").toContain("Start rejected:");
    expect(readFileSync(mailbox, "utf8")).toContain(`Sibling failed (\`${workerId}\`)`);
    catalogAvailable = true;
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId), { timeout: 15_000 }).toBe("incomplete");
    const retried = await page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]!), ownerId);
    expect(retried.dispatchResult!.workerId).not.toBe(workerId);
  });

  test("an abruptly exited dispatch releases ownership, retains interrupted attention and admits retry", async ({ page, runRoot }, testInfo) => {
    await expect(page.locator("#splash")).toBeHidden();
    const ownerId = await activeInstanceId(page);
    const taskText = "Inspect hello.txt before a worker exit";
    await startOwnerPlan(page, ownerId, `Plan:\n- [ ] ${taskText}\n`, runRoot);
    holdWorkerAfterRead = true;
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
    await expect.poll(() => workerResponse !== null).toBe(true);
    const workerId = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!.workerId!;
    const path = join(runRoot, "events", `${workerId}.jsonl`);
    const before = readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter(Boolean);
    expect(before.some((record) => record?.t === "tool_end" && record.toolCallId === "worker-before-exit" && record.isError === false)).toBe(true);
    const pid = Number(before.find((record) => record?.t === "agent_start")!.producerPid);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    const identity = readSystemProcessIdentity(pid);
    expect(identity).not.toBeNull();
    expect((await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === workerId)?.busy).toBe(true);
    // Only the actual producer from this fixture-owned sidecar, birth-fenced
    // immediately before signaling. No host session or arbitrary PID discovery.
    expect(readSystemProcessIdentity(pid)).toBe(identity);
    process.kill(pid, "SIGKILL");
    // Native PTY reports code 0 for this signaled exit on macOS. The existing
    // main contract retains it as interruption, never completion or a known failure.
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId)).toBe("interrupted");
    const interrupted = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!;
    expect(interrupted.state).toBe("pending");
    expect(interrupted.workerId).toBeUndefined();
    expect(interrupted.claimed).toBeUndefined();
    const after = readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter(Boolean);
    expect(after.some((record) => record?.t === "agent_settled")).toBe(false);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).projects[0]?.working).toBe(0);
    const attention = (await page.evaluate(() => window.termina.getWorkOverview())).items.find((item) => item.reason === "task-interrupted" && item.taskText === taskText)!;
    expect(attention).toMatchObject({ terminalId: ownerId, action: { kind: "plan", terminalId: ownerId } });
    await page.locator("#btn-attention").click();
    await page.locator(`#attention-list .attention-item[data-id="${attention.id}"] .attention-inspect`).click();
    await expect(page.locator("#plan-list .plan-task").filter({ hasText: taskText })).toContainText(`last interrupted · ${workerId}`);
    holdWorkerAfterRead = false;
    workerCredentials.length = 0;
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId)).toBe("incomplete");
    const retry = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!;
    expect(retry.dispatchResult!.workerId).not.toBe(workerId);
    await testInfo.attach("abrupt-dispatch-exit", { body: JSON.stringify({ workerId, pid, identity, interrupted, attention, retry }, null, 2), contentType: "application/json" });
  });

  test("closing an executing dispatch discloses its task, preserves Cancel and stops the actual command", async ({ page, runRoot, electronApp }, testInfo) => {
    await expect(page.locator("#splash")).toBeHidden();
    const ownerId = await activeInstanceId(page);
    const taskText = "Run a bounded hello.txt check";
    await startOwnerPlan(page, ownerId, `Plan:\n- [ ] ${taskText}\n`, runRoot);
    const pidPath = join(runRoot, "executing-dispatch.pid");
    workerBashCommand = `printf '%s\\n' "$$" > ${JSON.stringify(pidPath)}; for ((i=0; i<450; i++)); do printf 'dispatch check %s\\n' "$i"; sleep 0.1; done; test -f hello.txt`;
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
    let workerId = "";
    await expect.poll(async () => {
      workerId = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]?.workerId ?? "";
      if (!workerId) return false;
      const path = join(runRoot, "events", `${workerId}.jsonl`);
      return existsSync(path) && readFileSync(path, "utf8").split("\n").map(parseSidecarRecord)
        .some((record) => record?.t === "tool" && record.toolCallId === "worker-running-bash");
    }).toBe(true);
    // Keep the real approval policy and choose Approve once in the worker's TUI.
    await page.evaluate((id) => window.termina.writeTerminal(id, "\u001b[B\r"), workerId);
    await expect.poll(() => existsSync(pidPath)).toBe(true);
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    const worker = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === workerId)!;
    expect(worker).toMatchObject({ busy: true, dispatchWorker: true });
    await mockLifecycleDialogs(electronApp, 1, true);
    const cancelled = page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), worker);
    await expect.poll(() => lifecycleDialogs(electronApp).then((dialogs) => dialogs.length)).toBe(1);
    const options = (await lifecycleDialogs(electronApp))[0]!;
    expect(options.message).toBe(`Close terminal ${workerId}?`);
    expect(options.detail).toContain("dispatch worker");
    expect(options.detail).toContain(taskText);
    expect(options.detail).toContain(worker.cwd);
    expect(alive()).toBe(true);
    await answerLifecycleDialog(electronApp, 1);
    expect(await cancelled).toEqual({ ok: false, cancelled: true });
    expect(alive()).toBe(true);
    expect((await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]?.workerId).toBe(workerId);
    await answerLifecycleDialog(electronApp, 0);
    expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), worker)).toEqual({ ok: true });
    await expect.poll(alive).toBe(false);
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId)).toBeTruthy();
    await testInfo.attach("dispatch-at-close", { body: JSON.stringify({
      task: (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0],
      records: readFileSync(join(runRoot, "events", `${workerId}.jsonl`), "utf8").split("\n").map(parseSidecarRecord).filter(Boolean),
    }, null, 2), contentType: "application/json" });
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId)).toBe("interrupted");
    const interrupted = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!;
    expect(interrupted.workerId).toBeUndefined();
    expect(interrupted.claimed).toBeUndefined();
    expect(interrupted.state).toBe("pending");
    expect((await page.evaluate(() => window.termina.getInstances())).some((instance) => instance.id === ownerId)).toBe(true);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskText, reason: "task-interrupted", terminalId: ownerId }),
    ]));
    workerBashCommand = "";
    workerCredentials.length = 0;
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId)).toBe("incomplete");
    const retry = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!;
    expect(retry.dispatchResult!.workerId).not.toBe(workerId);
    await testInfo.attach("executing-dispatch-close", { body: JSON.stringify({ options, workerId, pid, interrupted, retry }, null, 2), contentType: "application/json" });
  });

  test("mid-run credential rejection retains failed attention; TUI login admits an explicit retry", async ({ page, runRoot }, testInfo) => {
    await expect(page.locator("#splash")).toBeHidden();
    const ownerId = await activeInstanceId(page);
    const taskText = "Inspect hello.txt after reauthentication";
    await startOwnerPlan(page, ownerId, `Plan:\n- [ ] ${taskText}\n`, runRoot);
    expireWorkerCredential = true;
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId)).toBe("failed");
    const failed = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!;
    const workerId = failed.dispatchResult!.workerId;
    const records = readFileSync(join(runRoot, "events", `${workerId}.jsonl`), "utf8").split("\n").map(parseSidecarRecord).filter(Boolean);
    expect(records.some((record) => record?.t === "agent_start")).toBe(true);
    expect(records.some((record) => record?.t === "tool_end" && record.isError === false)).toBe(true);
    expect(records.some((record) => record?.t === "agent_settled" && String(record.error).includes("invalid API key"))).toBe(true);
    expect((await page.evaluate((id) => window.termina.getRuns(id), workerId)).at(-1)).toMatchObject({ replayable: false, reason: "run failed: invalid API key" });
    expect(workerCredentials).toEqual(Array(2).fill("Bearer synthetic-loopback-token"));
    expect(failed.workerId).toBeUndefined();
    expect(failed.claimed).toBeUndefined();
    expect(failed.state).toBe("pending");
    const attention = (await page.evaluate(() => window.termina.getWorkOverview())).items.find((item) => item.reason === "task-failed" && item.taskText === taskText)!;
    expect(attention).toMatchObject({ terminalId: ownerId, action: { kind: "plan", terminalId: ownerId } });
    await page.locator("#btn-attention").click();
    const row = page.locator(`#attention-list .attention-item[data-id="${attention.id}"]`);
    await expect(row).toContainText(taskText);
    await row.getByRole("button", { name: "Inspect plan", exact: true }).click();
    await expect(page.locator("#plan-list .plan-task").filter({ hasText: taskText })).toContainText(`last failed · ${workerId}`);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map((item) => item.id)).toContain(attention.id);
    await page.evaluate((id) => window.termina.writeTerminal(id, "/login openai key\r"), ownerId);
    await expect.poll(() => terminalText(page, ownerId)).toContain("paste the openai API key");
    await page.evaluate((id) => window.termina.writeTerminal(id, "synthetic-reauthenticated-token\r"), ownerId);
    const authPath = join(runRoot, "home", ".termina", "agent", "auth.json");
    await expect.poll(() => existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")).openai?.key : null).toBe("synthetic-reauthenticated-token");
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId)).toBe("incomplete");
    const retried = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!;
    expect(retried.dispatchResult!.workerId).not.toBe(workerId);
    expect(retried.state).toBe("pending");
    expect(workerCredentials.at(-1)).toBe("Bearer synthetic-reauthenticated-token");
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "task-incomplete", taskText }),
    ]));
    expect(await page.evaluate((id) => window.termina.inspectWorkAttention(id), attention.id)).toMatchObject({ ok: false });
    await testInfo.attach("authentication-recovery", { body: JSON.stringify({ failed, retried, oldAttentionId: attention.id, requests: workerCredentials.length }, null, 2), contentType: "application/json" });
  });

  for (const failure of ["session append", "settled checkpoint"] as const) {
    test(`a real ${failure} failure preserves work, ends its run honestly and admits explicit retry`, async ({ page, projectRoot, runRoot }, testInfo) => {
      await expect(page.locator("#splash")).toBeHidden();
      const ownerId = await activeInstanceId(page);
      const taskText = "Write and verify hello.txt before finalization";
      await startOwnerPlan(page, ownerId, `Plan:\n- [ ] ${taskText}\n`, runRoot);
      holdWorkerAfterWrite = true;
      expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
      let workerId = "";
      await expect.poll(async () => {
        workerId = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]?.workerId ?? "";
        const path = join(runRoot, "events", `${workerId}.jsonl`);
        return !!workerId && existsSync(path) && readFileSync(path, "utf8").split("\n").map(parseSidecarRecord)
          .some((record) => record?.t === "tool" && record.toolCallId === "worker-settlement-check");
      }).toBe(true);
      await page.evaluate((id) => window.termina.writeTerminal(id, "\u001b[B\r"), workerId);
      await expect.poll(() => workerResponse !== null).toBe(true);
      const sidecar = join(runRoot, "events", `${workerId}.jsonl`);
      const records = () => readFileSync(sidecar, "utf8").split("\n").map(parseSidecarRecord).filter((record) => record !== null);
      expect(records().filter((record) => record.t === "tool_end" && record.isError === false)).toHaveLength(2);
      expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("fixture durable output\n");
      const run = (await page.evaluate((id) => window.termina.getRuns(id), workerId)).at(-1)!;
      expect(run).toMatchObject({ replayable: true, settledAt: null });
      let path: string;
      if (failure === "session append") path = run.sessionFile!;
      else {
        const stores = join(runRoot, "user-data", "worldlines");
        const candidates = readdirSync(stores, { withFileTypes: true }).filter((entry) => entry.isDirectory())
          .map((entry) => join(stores, entry.name, "git", "objects")).filter(existsSync);
        expect(candidates).toHaveLength(1);
        path = candidates[0]!;
      }
      path = realpathSync(path);
      expect(path.startsWith(`${realpathSync(runRoot)}/`)).toBe(true);
      const held = `${path}.held-by-finalization-test`;
      const sessionBefore = failure === "session append" ? readFileSync(path, "utf8") : null;
      // Reversible faults in this fixture's private persistence only. The
      // original session/store remains intact; source .git and leases are untouched.
      renameSync(path, held);
      writeFileSync(path, "fixture-owned persistence blocker\n");
      let failedRun;
      try {
        complete(workerResponse!, "The designated write and check have finished.");
        workerResponse = null;
        await expect.poll(async () => (await page.evaluate((id) => window.termina.getRuns(id), workerId)).at(-1)?.settledAt).toEqual(expect.any(Number));
        failedRun = (await page.evaluate((id) => window.termina.getRuns(id), workerId)).at(-1)!;
        expect(failedRun).toMatchObject({ id: run.id, replayable: false, settledStateId: null, sessionBranchFile: null });
        await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)?.busy), workerId)).toBe(false);
        const task = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!;
        expect(task.workerId).toBeUndefined();
        expect(task.claimed).toBeUndefined();
        if (failure === "session append") {
          expect(task).toMatchObject({ state: "pending", dispatchResult: { workerId, outcome: "failed" } });
          const settled = records().find((record) => record.t === "agent_settled");
          expect(settled?.t === "agent_settled" && settled.error).toContain("session segment changed");
          expect(failedRun.reason).toBe(`run failed: ${settled?.t === "agent_settled" ? settled.error : ""}`);
          expect(records().some((record) => record.t === "checkpoint_request" && record.kind === "settled")).toBe(false);
          expect(readFileSync(held, "utf8")).toBe(sessionBefore);
          const attention = (await page.evaluate(() => window.termina.getWorkOverview())).items
            .find((item) => item.reason === "task-failed" && item.taskText === taskText)!;
          await page.locator("#btn-attention").click();
          await page.locator(`#attention-list .attention-item[data-id="${attention.id}"] .attention-inspect`).click();
          await expect(page.locator("#plan-list .plan-task").filter({ hasText: taskText })).toContainText(`last failed · ${workerId}`);
        } else {
          // A failed checkpoint does not rewrite a successful, tested file tool
          // into a failed task. It denies replay and reports missing recording.
          expect(task).toMatchObject({ state: "done", dispatchResult: { workerId, outcome: "completed" } });
          expect(records().find((record) => record.t === "agent_settled")).toMatchObject({ error: null });
          await expect.poll(() => records().some((record) => record.t === "checkpoint_result" && record.ok === false)).toBe(true);
          expect(failedRun.reason).toMatch(/^settled checkpoint failed: /);
          await page.evaluate((id) => (window as any).__panes.get(id).tabEl.click(), workerId);
          await page.locator("#activity-tab-timeline").click();
          await expect(page.locator("#timeline-recorder")).toHaveText("degraded");
          await expect(page.locator("#timeline-recorder")).toHaveAttribute("title", /some moments could not be captured:/);
          expect(await page.locator("#timeline-recorder").getAttribute("title")).toContain(failedRun.reason!.slice("settled checkpoint failed: ".length).slice(0, 160));
          const denied = await page.evaluate((runId) => window.termina.forkRun(runId), failedRun.id);
          expect(denied).toMatchObject({ ok: false });
          expect(denied.error).toBe(failedRun.reason);
        }
        expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("fixture durable output\n");
      } finally {
        expect(readFileSync(path, "utf8")).toBe("fixture-owned persistence blocker\n");
        unlinkSync(path);
        renameSync(held, path);
      }
      holdWorkerAfterWrite = false;
      workerCredentials.length = 0;
      let retryWorkerId = workerId;
      if (failure === "session append") {
        expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
        await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId)).toBe("incomplete");
        retryWorkerId = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!.dispatchResult!.workerId;
        expect(retryWorkerId).not.toBe(workerId);
      } else {
        // The completed task is not silently reopened. Explicit new work on
        // the same terminal proves its previous failed recording released ownership.
        await page.evaluate((id) => window.termina.writeTerminal(id, "Inspect recovered hello.txt without changing it.\r"), workerId);
        await expect.poll(async () => (await page.evaluate((id) => window.termina.getRuns(id), workerId)).at(-1)?.id).not.toBe(run.id);
        expect((await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]).toMatchObject({ state: "done", dispatchResult: { workerId, outcome: "completed" } });
      }
      await expect.poll(async () => (await page.evaluate((id) => window.termina.getRuns(id), retryWorkerId)).at(-1)?.settledStateId).toMatch(/^[a-f0-9]{40}$/);
      await expect.poll(async () => (await page.evaluate((id) => window.termina.getRuns(id), retryWorkerId)).at(-1)?.sessionBranchFile).toEqual(expect.any(String));
      const retryRun = (await page.evaluate((id) => window.termina.getRuns(id), retryWorkerId)).at(-1)!;
      expect(retryRun, JSON.stringify(retryRun, null, 2)).toMatchObject({ replayable: true, settledEntryId: expect.any(String), sessionBranchFile: expect.any(String) });
      expect((await page.evaluate((id) => window.termina.getRuns(id), workerId)).find((entry) => entry.id === run.id)).toEqual(failedRun);
      await testInfo.attach("persistence-failure-recovery", { body: JSON.stringify({ failure, failedRun, retryRun, records: records() }, null, 2), contentType: "application/json" });
    });
  }

  test("a lone dispatch keeps its recorded source eligible rather than overlapping its own ledger entry", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const ownerId = await activeInstanceId(page);
    const taskText = "Inspect hello.txt in the sole dispatched worker";
    await startOwnerPlan(page, ownerId, `Plan:\n- [ ] ${taskText}\n`, runRoot);
    holdWorkerAfterRead = true;
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText })).toMatchObject({ ok: true });
    await expect.poll(() => workerResponse !== null).toBe(true);
    const workerId = (await page.evaluate((id) => window.termina.getPlan(id), ownerId))[0]!.workerId!;
    expect((await page.evaluate((id) => window.termina.getRuns(id), workerId)).at(-1)).toMatchObject({ replayable: true, overlap: false });
    complete(workerResponse!, "No changes made; this task remains incomplete.");
    workerResponse = null;
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId)).toBe("incomplete");
    await expect.poll(async () => (await page.evaluate((id) => window.termina.getRuns(id), workerId)).at(-1)?.sessionBranchFile).toEqual(expect.any(String));
    const run = (await page.evaluate((id) => window.termina.getRuns(id), workerId)).at(-1)!;
    expect(run, JSON.stringify(run, null, 2)).toMatchObject({ replayable: true, overlap: false, reason: null });
    expect(run.startStateId).toBe(run.settledStateId);
  });

  test("an incomplete worker can be closed and the task retried without losing the last result", async ({ page, runRoot, electronApp }) => {
    test.setTimeout(120_000);
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const ownerId = await activeInstanceId(page);
    const taskText = "Edit greeting.ts and src/index.ts";
    await startOwnerPlan(page, ownerId, `Plan:\n- [ ] ${taskText}\n`, runRoot);
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks.length), ownerId)).toBe(1);
    const dispatched = await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: ownerId, text: taskText });
    expect(dispatched.ok).toBe(true);
    let workerId = "";
    await expect.poll(async () => {
      const tasks = await page.evaluate((id) => window.termina.getPlan(id), ownerId);
      workerId = tasks[0]?.workerId ?? tasks[0]?.dispatchResult?.workerId ?? "";
      return workerId;
    }).not.toBe("");
    try {
      await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.dispatchResult?.outcome), ownerId), { timeout: 30_000 }).toBe("incomplete");
    } catch (error) {
      const snapshot = await page.evaluate((id) => Promise.all([window.termina.getInstances(), window.termina.getPlan(id)]), ownerId);
      await test.info().attach("worker-lifecycle", { body: JSON.stringify(snapshot, null, 2), contentType: "application/json" });
      await test.info().attach("worker-sidecar", { path: join(runRoot, "events", `${workerId}.jsonl`), contentType: "application/x-ndjson" });
      throw error;
    }
    const beforeClose = await page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]!), ownerId);
    expect(beforeClose.state).toBe("pending");
    expect(beforeClose.workerId).toBeUndefined();
    expect(beforeClose.claimed).toBeUndefined();
    const worker = await page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)!), workerId);
    // A settled worker label is not active dispatch work. It closes without a warning.
    await mockLifecycleDialogs(electronApp, 1);
    expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), worker)).toEqual({ ok: true });
    expect(await lifecycleDialogs(electronApp)).toHaveLength(0);
    await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((instances) => instances.map((instance) => instance.id)))).not.toContain(workerId);
    await page.evaluate((id) => {
      (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes.get(id)!.tabEl.click();
    }, ownerId);
    await page.locator(".activity-tab[data-tab='plan']").click();
    const row = page.locator("#plan-list .plan-task").filter({ hasText: taskText });
    await expect(row.locator(".plan-dispatch-result")).toContainText(`last incomplete · ${workerId}`);
    await expect(row).toHaveAttribute("title", "retry this task");
    const project = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
    const summary = await page.evaluate((id) => window.termina.getProjectWorkSummary(id), project.id);
    const work = summary!.terminals.find((terminal) => terminal.terminalId === ownerId)!;
    expect(work.tasks[0]).toMatchObject({ task: { text: taskText, state: "pending", dispatchResult: { workerId, outcome: "incomplete" } },
      worker: null, attention: ["task-incomplete"], nextAction: { kind: "plan", terminalId: ownerId } });
    await page.locator("#work-summary > summary").click();
    await expect(page.locator(".work-summary-tasks")).toContainText(`last incomplete (${workerId})`);
    await expect(page.locator("#work-summary dd").filter({ hasText: "Task attempt incomplete" })).toBeVisible();
    await page.locator(".work-summary-tasks").getByRole("button", { name: "Inspect plan" }).click();
    await expect(page.locator("#plan-panel")).toBeVisible();
    await row.locator(".plan-text").click();
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks[0]?.workerId ?? tasks[0]?.dispatchResult?.workerId), ownerId)).not.toBe(workerId);
  });
});
