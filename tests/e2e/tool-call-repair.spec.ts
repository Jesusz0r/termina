import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "./fixtures.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

const test = base.extend({
  projectRoot: async ({ projectRoot }, use) => {
    writeFileSync(join(projectRoot, "literal,}.txt"), "EXACT_PATH_CONTENT\n");
    await use(projectRoot);
  },
});

type InputItem = { type?: string; call_id?: string; arguments?: string; output?: string | Array<{ text?: string }> };
type ModelRequest = { input: InputItem[] };
let server: Server;
const requests: ModelRequest[] = [];
const previous = new Map<string, string | undefined>();

test.beforeAll(async () => {
  const argumentsByTurn = ['{"path":"literal,}.txt",}', '{"path":7}', '{"path":"hello.txt",,}'];
  server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
    } else if (request.method === "POST" && request.url?.endsWith("/responses")) {
      let body = "";
      request.on("data", chunk => { body += chunk.toString(); });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "text/event-stream" });
        const args = argumentsByTurn[requests.length - 1];
        const id = `call-${requests.length}`;
        const output = args === undefined ? [] : [{ type: "function_call", id, call_id: id, name: "read_file", arguments: args }];
        for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
        if (!output.length) response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Inspection complete." })}\n\n`);
        response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
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
    TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol",
    TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-repair-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
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

test("repairs once, preserves parsed schema errors and resumes with paired history", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const owner = (await page.evaluate(() => window.termina.getInstances())).find(instance => instance.type === "agent")!;
  const events = join(runRoot, "events", `${owner.id}.jsonl`);
  const records = () => existsSync(events) ? readFileSync(events, "utf8").split("\n").map(parseSidecarRecord).filter(record => record !== null) : [];
  await expect.poll(() => records().some(record => record.t === "session_ready")).toBe(true);
  const errorOutput = await page.evaluate(id => new Promise<string>((resolve, reject) => {
    let output = "";
    const stop = window.termina.onPtyData(event => {
      if (event.id !== id) return;
      output = (output + event.data).slice(-64_000);
      if (output.includes("tool call arguments must be a JSON object")) { clearTimeout(timer); stop(); resolve(output); }
    });
    const timer = setTimeout(() => { stop(); reject(new Error(`missing provider error\n${output}`)); }, 30_000);
    window.termina.writeTerminal(id, "Inspect the requested files.\r").catch(error => { clearTimeout(timer); stop(); reject(error); });
  }), owner.id);
  expect(errorOutput).toContain("tool call arguments must be a JSON object");
  await expect.poll(() => records().filter(record => record.t === "agent_settled").length).toBe(1);
  // Each tool result prompts the next ordinary request; repair adds no model turn.
  expect(requests).toHaveLength(3);
  const output = (request: ModelRequest, id: string): string => {
    const matches = request.input.filter(item => item.type === "function_call_output" && item.call_id === id);
    expect(matches).toHaveLength(1);
    const value = matches[0]!.output;
    return typeof value === "string" ? value : value?.map(part => part.text ?? "").join("\n") ?? "";
  };
  expect(output(requests[1]!, "call-1")).toContain("EXACT_PATH_CONTENT");
  expect(output(requests[2]!, "call-2")).toContain("error: invalid tool arguments: read_file.path must be string");
  const calls = requests[2]!.input.filter(item => item.type === "function_call");
  expect(calls.map(item => [item.call_id, JSON.parse(item.arguments!)])).toEqual([
    ["call-1", { path: "literal,}.txt" }], ["call-2", { path: 7 }],
  ]);
  expect(records().filter(record => record.t === "tool").map(record => record.toolCallId)).toEqual(["call-1", "call-2"]);
  expect(readFileSync(join(projectRoot, "literal,}.txt"), "utf8")).toBe("EXACT_PATH_CONTENT\n");
  expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");

  await page.evaluate(id => window.termina.writeTerminal(id, "Continue the inspection.\r"), owner.id);
  await expect.poll(() => records().filter(record => record.t === "agent_settled").length).toBe(2);
  expect(requests).toHaveLength(4);
  const resumed = requests[3]!.input;
  expect(resumed.filter(item => item.type === "function_call").map(item => item.call_id)).toEqual(["call-1", "call-2"]);
  expect(resumed.filter(item => item.type === "function_call_output").map(item => item.call_id)).toEqual(["call-1", "call-2"]);
});
