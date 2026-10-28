import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "./fixtures.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";
import { mockLifecycleDialogs } from "./lifecycle-dialog.ts";

const test = base.extend({
  projectRoot: async ({ projectRoot }, use) => {
    writeFileSync(join(projectRoot, ".gitignore"), "node_modules/\nstages.jsonl\n/.verify-*\n");
    await writeVerifyPackage(projectRoot, { test: "termina-verify-fixture main && node verify-check.cjs" });
    writeFileSync(join(projectRoot, ".verify-control"), "pass");
    writeFileSync(join(projectRoot, "verify-check.cjs"), `
      const fs = require("node:fs");
      const mode = fs.readFileSync(".verify-control", "utf8");
      if (mode === "fail") process.exit(7);
      if (mode === "hold") {
        fs.writeFileSync(".verify-started", "started");
        const timer = setInterval(() => { if (fs.existsSync(".verify-release")) { clearInterval(timer); process.exit(0); } }, 20);
      }
    `);
    await use(projectRoot);
  },
});

type Call = { name: string; input: Record<string, unknown> };
function complete(response: ServerResponse, id: number, text: string, call?: Call): void {
  const output = call ? [{ type: "function_call", id: `call-${id}`, call_id: `call-${id}`, name: call.name, arguments: JSON.stringify(call.input) }] : [];
  if (text) response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}

test.describe("Plan Board completion from real Verify", () => {
  let server: Server;
  let phase: "plan" | "implementation" | "dispatch" = "plan";
  let calls = 0;
  let implementationCalls = 0;
  let workerCalls = 0;
  const previous = new Map<string, string | undefined>();
  const helloTask = "Fix hello.txt";
  const greetingTask = "Fix greeting.ts";

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
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (phase === "plan") complete(response, calls, `Plan:\n- [x] ${helloTask}\n- [x] ${greetingTask}\n- [x] Review results\n`);
        else if (phase === "implementation") {
          if (++implementationCalls === 1) complete(response, calls, "", { name: "write_file", input: { path: "hello.txt", content: "implemented\n" } });
          else if (implementationCalls === 2) complete(response, calls, "", { name: "bash", input: { command: "test $(cat hello.txt) = implemented" } });
          else complete(response, calls, "Tests passed. All plan tasks are complete.");
        } else if (++workerCalls === 1) complete(response, calls, "", { name: "write_file", input: { path: "greeting.ts", content: 'export const greeting = "updated";\n' } });
        else complete(response, calls, "The file was written. No Verify result is available yet.");
      });
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
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-plan-verify-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
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

  test("requires a current observed pass and matching paths, retaining worker proof through closure", async ({ page, projectRoot, runRoot, electronApp }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const owner = (await page.evaluate(() => window.termina.getInstances())).find(instance => instance.type === "agent")!;
    const sidecar = join(runRoot, "events", `${owner.id}.jsonl`);
    const events = () => existsSync(sidecar) ? readFileSync(sidecar, "utf8").split("\n").map(parseSidecarRecord).filter(record => record !== null) : [];
    const plan = () => page.evaluate(id => window.termina.getPlan(id), owner.id);
    const verify = () => page.evaluate(async id => (await window.termina.getInstances()).find(instance => instance.id === id)!.verify, owner.id);
    await expect.poll(() => events().some(record => record.t === "session_ready")).toBe(true);
    await page.evaluate(id => window.termina.writeTerminal(id, "/plan Fix hello.txt and greeting.ts\r"), owner.id);
    await expect.poll(() => events().filter(record => record.t === "agent_settled").length).toBe(1);
    expect((await plan()).map(task => task.state)).toEqual(["pending", "pending", "pending"]);

    expect(await page.evaluate(id => window.termina.runVerify(id), owner.id)).toEqual({ ok: true });
    await expect.poll(async () => (await verify())?.state).toBe("pass");
    expect((await plan()).map(task => task.state)).toEqual(["pending", "pending", "pending"]);
    phase = "implementation";
    await page.evaluate(id => window.termina.writeTerminal(id, "Implement hello.txt and check its contents.\r"), owner.id);
    await expect.poll(() => events().filter(record => record.t === "agent_settled").length, { timeout: 30_000 }).toBe(2);
    expect((await plan()).map(task => task.state)).toEqual(["active", "pending", "pending"]);
    await expect.poll(async () => (await verify())?.state).toBe("stale");

    writeFileSync(join(projectRoot, ".verify-control"), "fail");
    expect(await page.evaluate(id => window.termina.runVerify(id), owner.id)).toEqual({ ok: true });
    await expect.poll(async () => (await verify())?.state).toBe("fail");
    expect((await plan())[0]!.state).toBe("active");
    writeFileSync(join(projectRoot, ".verify-control"), "pass");
    expect(await page.evaluate(id => window.termina.runVerify(id), owner.id)).toEqual({ ok: true });
    await expect.poll(async () => (await verify())?.state).toBe("pass");
    expect((await plan()).map(task => task.state)).toEqual(["done", "pending", "pending"]);
    expect(calls).toBe(4);
    await page.locator(".activity-tab[data-tab='plan']").click();
    await expect(page.locator("#plan-list .plan-task").filter({ hasText: helloTask })).toHaveClass(/state-done/);

    phase = "dispatch";
    writeFileSync(join(projectRoot, ".verify-control"), "hold");
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: owner.id, text: greetingTask })).toMatchObject({ ok: true });
    await expect.poll(() => existsSync(join(projectRoot, ".verify-started")), { timeout: 30_000 }).toBe(true);
    const attempt = (await plan())[1]!;
    expect(attempt).toMatchObject({ state: "pending", dispatchResult: { outcome: "completed", paths: ["greeting.ts"] } });
    expect((await verify())?.state).toBe("running");
    const worker = (await page.evaluate(() => window.termina.getInstances())).find(instance => instance.id === attempt.dispatchResult!.workerId)!;
    await mockLifecycleDialogs(electronApp, 0);
    expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), worker)).toEqual({ ok: true });
    writeFileSync(join(projectRoot, "src", "index.ts"), "export const index = false;\n");
    writeFileSync(join(projectRoot, ".verify-release"), "release");
    await expect.poll(async () => (await verify())?.state).toBe("stale");
    expect((await plan())[1]!.state).toBe("pending");

    writeFileSync(join(projectRoot, ".verify-control"), "pass");
    expect(await page.evaluate(id => window.termina.runVerify(id), owner.id)).toEqual({ ok: true });
    await expect.poll(async () => (await verify())?.state).toBe("pass");
    expect((await plan()).map(task => task.state)).toEqual(["done", "done", "pending"]);
    expect(workerCalls).toBe(2);
    expect(calls).toBe(6);
    expect(await readVerifyStages(projectRoot)).toHaveLength(5);
    expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).toContain('"updated"');
  });
});
