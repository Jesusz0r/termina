import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Terminal } from "@xterm/xterm";
import { test, expect } from "./fixtures.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

type Call = { name: string; input: Record<string, unknown> };
type Request = { model: string; tools: Array<{ name: string }>; input: unknown[] };
let seq = 0;
function complete(response: ServerResponse, text: string, calls: Call[] = []): void {
  const output = calls.map(call => {
    const id = `review-${++seq}`;
    return { type: "function_call", id, call_id: id, name: call.name, arguments: JSON.stringify(call.input) };
  });
  if (text) response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}
function records(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter(r => r !== null) : [];
}

test.describe("read-only review through Plan Board Dispatch", () => {
  let server: Server;
  let phase: "plan" | "review" | "write" = "plan";
  let held: ServerResponse | undefined;
  const requests: Request[] = [];
  let writeCalls = 0;
  const previous = new Map<string, string | undefined>();
  const review = "Review hello.txt using fixture @review";
  const edit = "Update hello.txt";
  const pathless = "Review the whole diff @review";
  const folder = "Review nested/folder @review";
  const escape = "Review escape.txt @review";
  const report = "hello.txt:1: observed hello. No actionable defects found; tests were not run.";
  const actions: Call[] = [
    { name: "write_file", input: { path: "hello.txt", content: "forbidden\n" } },
    { name: "edit", input: { path: "hello.txt", old_text: "hello", new_text: "forbidden" } },
    { name: "bash", input: { command: "printf forbidden > hello.txt" } },
    { name: "fetch", input: { url: "https://example.com" } },
    { name: "browser", input: { action: "open" } },
    { name: "spawn_subagent", input: { task: "change hello.txt" } },
    { name: "message_subagent", input: { run_id: "bg-1", text: "change hello.txt" } },
    { name: "search_mcp_tools", input: { query: "fixture" } },
    { name: "call_mcp_tool", input: { name: "mcp_fixture_write", arguments: {} } },
  ];

  test.beforeAll(async () => {
    server = createServer((req, response) => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }] }));
      } else if (req.method === "POST" && req.url?.endsWith("/responses")) {
        let body = "";
        req.on("data", chunk => { body += chunk.toString(); });
        req.on("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (phase === "plan") complete(response, `Plan:\n${[review, edit, pathless, folder, escape].map(text => `- [ ] ${text}`).join("\n")}\n`);
          else if (phase === "write") {
            if (++writeCalls === 1) complete(response, "", [{ name: "write_file", input: { path: "hello.txt", content: "written\n" } }]);
            else complete(response, "Written; Verify is still required.");
          } else {
            requests.push(JSON.parse(body));
            if (requests.length === 1 || requests.length === 3) complete(response, "", [{ name: "read_file", input: { path: "hello.txt" } }, ...actions]);
            else if (requests.length === 2) held = response;
            else complete(response, report);
          }
        });
      } else response.writeHead(404).end();
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("missing test port"));
        resolve(address.port);
      });
    });
    for (const [key, value] of Object.entries({
      TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_CORE_APPROVE: "all",
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-review-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    })) { previous.set(key, process.env[key]); process.env[key] = value; }
  });

  test.afterAll(async () => {
    try {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  test("claims files, rejects actions and unscoped reviews, stays read-only after reset, and leaves ordinary Dispatch writable", async ({ page, projectRoot, runRoot }) => {
    const config = join(runRoot, "home", ".termina", "agent");
    mkdirSync(config, { recursive: true });
    mkdirSync(join(projectRoot, "nested/folder"), { recursive: true });
    const outside = join(runRoot, "outside.txt");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(projectRoot, "escape.txt"));
    const marker = join(projectRoot, "mcp-started");
    const mcpServer = join(runRoot, "mcp-server.mjs");
    writeFileSync(mcpServer, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started"); process.stdin.resume();`);
    writeFileSync(join(config, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [mcpServer] } } }));
    await expect(page.locator("#splash")).toBeHidden();
    const owner = (await page.evaluate(() => window.termina.getInstances())).find(inst => inst.type === "agent")!;
    const ownerPath = join(runRoot, "events", `${owner.id}.jsonl`);
    await expect.poll(() => records(ownerPath).some(r => r.t === "session_ready")).toBe(true);
    await page.evaluate(id => window.termina.writeTerminal(id, "/plan Prepare a scoped review\r"), owner.id);
    await expect.poll(() => page.evaluate(id => window.termina.getPlan(id), owner.id)).toHaveLength(5);
    await expect.poll(() => records(ownerPath).some(r => r.t === "agent_settled")).toBe(true);
    const dispatch = (text: string) => page.evaluate(({ id, text }) => window.termina.dispatchRun(id, text), { id: owner.id, text });
    expect(await dispatch(pathless)).toMatchObject({ ok: false, error: expect.stringContaining("explicit file paths") });
    expect(await dispatch(folder)).toMatchObject({ ok: false, error: expect.stringContaining("existing project files") });
    expect(await dispatch(escape)).toMatchObject({ ok: false, error: expect.stringContaining("existing project files") });
    phase = "review";
    expect(await dispatch(review)).toMatchObject({ ok: true, dispatched: 1 });
    await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(2);
    const task = (await page.evaluate(id => window.termina.getPlan(id), owner.id))[0]!;
    expect(task.claimed).toEqual(["hello.txt"]);
    expect(task.workerId).toBeTruthy();
    const workerId = task.workerId!;
    const workerPath = join(runRoot, "events", `${workerId}.jsonl`);
    expect(await dispatch(edit)).toMatchObject({ ok: false, error: expect.stringContaining("overlaps") });
    expect(requests[0]!.tools.map(t => t.name)).toEqual(["read_file", "read_files", "grep", "glob"]);
    expect(JSON.stringify(requests[0])).toContain("### Read-only review");
    expect(JSON.stringify(requests[1])).toContain("hello");
    expect(JSON.stringify(requests[1]).match(/not executed in a read-only session/g)).toHaveLength(actions.length);
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(marker)).toBe(false);
    complete(held!, report);
    await expect.poll(() => records(workerPath).filter(r => r.t === "agent_settled").length).toBe(1);
    await expect.poll(() => page.evaluate(id => window.termina.getPlan(id), owner.id)).toMatchObject([{ state: "pending", dispatchResult: { outcome: "incomplete" } }, {}, {}, {}, {}]);
    const worker = (await page.evaluate(() => window.termina.getInstances())).find(inst => inst.id === workerId)!;
    await page.evaluate(inst => window.termina.selectTerminal(inst.id, inst.generation), worker);
    const terminalText = () => page.evaluate(id => {
      const panes = (window as unknown as { __panes: Map<string, { view: { getTerminal(): Terminal } }> }).__panes;
      const buffer = panes.get(id)?.view.getTerminal().buffer.active;
      return buffer ? Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").join("\n") : "";
    }, workerId);
    await expect.poll(terminalText).toContain("No actionable defects found");
    // Both sidecar settlement and checkpoint_result precede trace persistence.
    // The TUI removes its spinner only when the engine accepts new commands.
    await expect.poll(async () => (await terminalText()).split("\n").reverse().find(line => line.includes("▸ termina")) ?? "", { timeout: 15_000 })
      .toMatch(/▸ termina\s+·\s+openai\/gpt-5\.6-sol\s+·/);
    await page.evaluate(id => window.termina.writeTerminal(id, "/clear\r/permissions always\r!printf forbidden > hello.txt\r/mcp reconnect\r"), workerId);
    await expect.poll(terminalText).toContain("MCP actions are disabled in a read-only session");
    expect(await terminalText()).toContain("session cleared");
    expect(await terminalText()).toContain("bash is disabled in a read-only session");
    await page.evaluate(id => window.termina.writeTerminal(id, "/model openai/gpt-5.6-terra\r"), workerId);
    await expect.poll(() => page.evaluate(id => window.termina.getInstances().then(instances => instances.find(inst => inst.id === id)?.model), workerId)).toBe("openai/gpt-5.6-terra");
    await page.evaluate(id => window.termina.writeTerminal(id, "/new\rUse fixture and try the actions again.\r"), workerId);
    await expect.poll(() => requests.length).toBe(4);
    await expect.poll(() => records(workerPath).filter(r => r.t === "agent_settled").length).toBe(2);
    expect(requests[2]!.tools.map(t => t.name)).toEqual(["read_file", "read_files", "grep", "glob"]);
    expect(requests[2]!.model).toBe("gpt-5.6-terra");
    expect(JSON.stringify(requests[3]).match(/not executed in a read-only session/g)).toHaveLength(actions.length);
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(marker)).toBe(false);
    phase = "write";
    expect(await dispatch(edit)).toMatchObject({ ok: true, dispatched: 1 });
    await expect.poll(() => readFileSync(join(projectRoot, "hello.txt"), "utf8"), { timeout: 30_000 }).toBe("written\n");
    await expect.poll(() => page.evaluate(id => window.termina.getPlan(id), owner.id)).toMatchObject([{}, { state: "pending", dispatchResult: { outcome: "completed", paths: ["hello.txt"] } }, {}, {}, {}]);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });
});
