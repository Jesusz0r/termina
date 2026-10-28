import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures.ts";
import { MAX_SUBAGENT_RESULT_CHARS, subagentChildTid } from "../../agent-core/subagents.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

type Call = { name: string; input: Record<string, unknown> };
type ModelRequest = { tools: Array<{ name: string }>; input: Array<{ type: string; call_id?: string; output?: unknown }> };
let callSequence = 0;

function complete(response: ServerResponse, text: string, calls: Call[] = []): void {
  const output = calls.map(call => {
    const id = `call-${++callSequence}`;
    return { type: "function_call", id, call_id: id, name: call.name, arguments: JSON.stringify(call.input) };
  });
  if (text) response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}

function records(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter(record => record !== null) : [];
}

test.describe("Read-only research and writable Dispatch", () => {
  let server: Server;
  let phase: "research" | "plan" | "dispatch" = "research";
  let childCalls = 0;
  let workerCalls = 0;
  let parentCalls = 0;
  const childRequests: ModelRequest[] = [];
  const parentRequests: ModelRequest[] = [];
  const previous = new Map<string, string | undefined>();
  const taskText = "Update hello.txt through Dispatch";
  const report = `Observed hello.txt: hello. Evidence ${"x".repeat(40_000)} uncapped-tail`;
  const actions: Call[] = [
    { name: "write_file", input: { path: "hello.txt", content: "forbidden\n" } },
    { name: "edit", input: { path: "hello.txt", old_text: "hello", new_text: "forbidden" } },
    { name: "bash", input: { command: "printf forbidden > hello.txt" } },
    { name: "fetch", input: { url: "https://example.com" } },
    { name: "browser", input: { action: "open" } },
    { name: "spawn_subagent", input: { task: "write hello.txt" } },
    { name: "search_mcp_tools", input: { query: "fixture" } },
    { name: "call_mcp_tool", input: { name: "mcp_fixture_write", arguments: {} } },
  ];

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
      } else if (request.method === "POST" && request.url?.endsWith("/responses")) {
        let body = "";
        request.on("data", chunk => { body += chunk.toString(); });
        request.on("end", () => {
          const input: ModelRequest = JSON.parse(body);
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (phase === "plan") complete(response, `Plan:\n- [ ] ${taskText}\n`);
          else if (phase === "dispatch") {
            if (++workerCalls === 1) complete(response, "", [{ name: "write_file", input: { path: "hello.txt", content: "dispatched\n" } }]);
            else if (workerCalls === 2) complete(response, "", [{ name: "bash", input: { command: "test \"$(cat hello.txt)\" = dispatched" } }]);
            else complete(response, "The dispatched change was verified.");
          } else if (input.tools.some(tool => tool.name === "spawn_subagent")) {
            parentRequests.push(input);
            if (++parentCalls === 1) complete(response, "", [{ name: "spawn_subagent", input: { task: "Use fixture to inspect hello.txt and return the observed evidence.", read_only: true } }]);
            else complete(response, "Research response received.");
          } else {
            childRequests.push(input);
            if (++childCalls === 1) complete(response, "", [{ name: "read_file", input: { path: "hello.txt" } }, ...actions]);
            else complete(response, report);
          }
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
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-read-only-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
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

  test.afterEach(async ({ runRoot }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    const events = join(runRoot, "events");
    await testInfo.attach("subagent-requests", { body: JSON.stringify({ phase, parentRequests, childRequests }), contentType: "application/json" });
    for (const name of readdirSync(events).filter(name => name.endsWith(".jsonl") || name.endsWith(".result.json"))) {
      await testInfo.attach(name, { path: join(events, name), contentType: "text/plain" });
    }
  });

  test("refuses research actions, delivers the bounded result, then Dispatch writes its claimed file", async ({ page, runRoot, projectRoot }) => {
    const config = join(runRoot, "home", ".termina", "agent");
    mkdirSync(config, { recursive: true });
    const marker = join(projectRoot, "mcp-started");
    const mcpServer = join(runRoot, "mcp-server.mjs");
    writeFileSync(mcpServer, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started"); process.stdin.resume();`);
    writeFileSync(join(config, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [mcpServer] } } }));
    await expect(page.locator("#splash")).toBeHidden();
    const owner = (await page.evaluate(() => window.termina.getInstances())).find(instance => instance.type === "agent")!;
    const ownerPath = join(runRoot, "events", `${owner.id}.jsonl`);
    await expect.poll(() => records(ownerPath).some(record => record.t === "session_ready")).toBe(true);
    await page.evaluate(id => window.termina.writeTerminal(id, "Research the local file using a read-only child.\r"), owner.id);
    await expect.poll(() => JSON.stringify(parentRequests).includes(report.slice(0, MAX_SUBAGENT_RESULT_CHARS)), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => records(ownerPath).some(record => record.t === "agent_settled")).toBe(true);
    expect(JSON.stringify(parentRequests)).not.toContain("uncapped-tail");
    expect(childRequests).toHaveLength(2);
    expect(childRequests[0]!.tools.map(tool => tool.name)).toEqual(["read_file", "read_files", "grep", "glob"]);
    const outputs = childRequests[1]!.input.filter(item => item.type === "function_call_output");
    expect(outputs).toHaveLength(actions.length + 1);
    expect(JSON.stringify(outputs[0]!.output)).toContain("hello");
    for (const item of outputs.slice(1)) expect(JSON.stringify(item.output)).toContain("not executed by a read-only subagent");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
    const childPath = join(runRoot, "events", `${subagentChildTid(owner.id, "bg-1")}.jsonl`);
    expect(records(childPath).some(record => record.t === "subagent_spawn")).toBe(false);

    phase = "plan";
    await page.evaluate(id => window.termina.writeTerminal(id, "/plan Update hello.txt through Dispatch\r"), owner.id);
    await expect.poll(() => page.evaluate(id => window.termina.getPlan(id), owner.id)).toMatchObject([{ text: taskText, paths: ["hello.txt"] }]);
    await expect.poll(() => records(ownerPath).filter(record => record.t === "agent_settled").length).toBe(2);
    phase = "dispatch";
    expect(await page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: owner.id, text: taskText })).toMatchObject({ ok: true });
    await expect.poll(() => readFileSync(join(projectRoot, "hello.txt"), "utf8"), { timeout: 30_000 }).toBe("dispatched\n");
    await expect.poll(() => page.evaluate(id => window.termina.getPlan(id), owner.id)).toMatchObject([{ state: "done", dispatchResult: { outcome: "completed" } }]);
    expect(workerCalls).toBe(3);
  });
});
