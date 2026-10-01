import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures.ts";

const ENV_KEYS = ["TERMINA_CORE_TEST", "TERMINA_CORE_PROVIDER", "TERMINA_CORE_MODEL", "TERMINA_TEST_MODELS_URL", "TERMINA_CORE_APPROVE", "OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;
type ModelRequest = {
  input: Array<{ type: string; call_id?: string; output?: string | Array<{ type: string; text?: string }> }>;
};

function toolOutput(request: ModelRequest, id: string): string {
  const matches = request.input.filter(item => item.type === "function_call_output" && item.call_id === id);
  expect(matches, `paired model-visible result for ${id}`).toHaveLength(1);
  const output = matches[0]!.output;
  if (typeof output === "string") return output;
  expect(Array.isArray(output), `text result for ${id}`).toBe(true);
  return output!.map(item => item.text ?? "").join("\n");
}
function event(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}
function complete(response: ServerResponse, output: unknown[] = []): void {
  for (const item of output) event(response, { type: "response.output_item.done", item });
  event(response, { type: "response.completed", response: { status: "completed", output, usage: {} } });
  response.end();
}
function tool(id: string, name: string, input: unknown): unknown {
  return { type: "function_call", id, call_id: id, name, arguments: JSON.stringify(input) };
}
function sidecar(root: string): string {
  try { return readFileSync(join(root, "events", "term-1.jsonl"), "utf8"); } catch { return ""; }
}
function settledCount(root: string): number {
  return sidecar(root).split("\n").filter(line => line.includes('"t":"agent_settled"')).length;
}

test.describe("/plan execution gate through the real Electron agent", () => {
  let server: Server | undefined;
  let requests: ModelRequest[];
  let providerError: string | undefined;
  let publishList = false;
  const previous = new Map<string, string | undefined>();

  test.beforeAll(async () => {
    for (const key of ENV_KEYS) previous.set(key, process.env[key]);
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      request.on("data", chunk => { body += chunk.toString(); });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        try {
          const input: ModelRequest = JSON.parse(body);
          requests.push(input);
          switch (requests.length) {
            case 1:
              if (publishList) event(response, { type: "response.output_text.delta", delta: "## Plan\n- [ ] Update hello.txt after approval.\n" });
              complete(response, [tool("plan-read", "read_file", { path: "hello.txt" })]);
              break;
            case 2:
              expect(toolOutput(input, "plan-read")).toContain("hello");
              complete(response, [
                tool("plan-write", "write_file", { path: "hello.txt", content: "forbidden write\n" }),
                tool("plan-edit", "edit", { path: "greeting.ts", old_text: '"hello"', new_text: '"forbidden"' }),
                tool("plan-bash", "bash", { command: "printf 'forbidden bash\\n' > plan-bash.txt" }),
              ]);
              break;
            case 3:
              for (const id of ["plan-write", "plan-edit", "plan-bash"]) {
                const result = toolOutput(input, id);
                expect(result).toContain("/plan");
                expect(result).toContain("not executed");
              }
              event(response, { type: "response.output_text.delta", delta: "Implementation was not executed. Awaiting an implementation request." });
              complete(response);
              break;
            case 4:
              complete(response, [tool("implement-write", "write_file", { path: "hello.txt", content: "implemented\n" })]);
              break;
            case 5:
              expect(toolOutput(input, "implement-write")).not.toContain("not executed");
              complete(response, [tool("implement-verify", "bash", { command: "test \"$(cat hello.txt)\" = implemented" })]);
              break;
            case 6:
              expect(toolOutput(input, "implement-verify")).toContain("[exit 0]");
              event(response, { type: "response.output_text.delta", delta: "Implemented hello.txt and verified its contents." });
              complete(response);
              break;
            default:
              throw new Error(`Unexpected provider request ${requests.length}; expected at most six`);
          }
        } catch (error) {
          providerError ??= String(error);
          event(response, { type: "response.output_text.delta", delta: "Loopback provider stopped: " + providerError });
          complete(response);
        }
      });
    });
    const port = await new Promise<number>((done, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        server!.off("error", reject);
        const address = server!.address();
        if (!address || typeof address === "string") return reject(new Error("Missing loopback port"));
        done(address.port);
      });
    });
    Object.assign(process.env, {
      TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol",
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`,
      // Even full tool permission must not bypass the /plan refusal. The later
      // implementation bash probe can then execute without an approval dialog.
      TERMINA_CORE_APPROVE: "all",
      OPENAI_API_KEY: "synthetic-loopback-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    });
  });
  test.beforeEach(() => { requests = []; providerError = undefined; });
  test.afterAll(async () => {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  for (const hasPlanList of [true, false]) {
    test(`reads are allowed, mutations denied, then ordinary submit unlocks tools (${hasPlanList ? "published list" : "no list"})`, async ({ page, projectRoot, runRoot, closeElectron }) => {
      publishList = hasPlanList;
      try {
        await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
        await expect.poll(() => sidecar(runRoot), { timeout: 15_000 }).toContain('"permissions":"always"');
        const terminal = await page.evaluate(async () => (await window.termina.getInstances()).find(item => item.type === "agent")!.id);
        const initialSettled = settledCount(runRoot);
        await page.evaluate(id => window.termina.writeTerminal(id, "/plan Update hello.txt and greeting.ts.\r"), terminal);
        await expect.poll(() => settledCount(runRoot), { timeout: 30_000 }).toBe(initialSettled + 1);
        expect(providerError).toBeUndefined();
        expect(requests).toHaveLength(3);
        expect(toolOutput(requests[1]!, "plan-read")).toContain("hello");
        for (const id of ["plan-write", "plan-edit", "plan-bash"]) {
          expect(toolOutput(requests[2]!, id)).toContain("not executed");
        }
        expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
        expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).toBe('export const greeting = "hello";\n');
        expect(existsSync(join(projectRoot, "plan-bash.txt"))).toBe(false);

        // Without a headed list, plan publishing may still be pending. That
        // reporting state must not keep the execution gate on an ordinary turn.
        await page.evaluate(id => window.termina.writeTerminal(id, "Implement the hello.txt change now and verify it.\r"), terminal);
        await expect.poll(() => settledCount(runRoot), { timeout: 30_000 }).toBe(initialSettled + 2);
        expect(providerError).toBeUndefined();
        expect(requests).toHaveLength(6);
        expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("implemented\n");
        expect(toolOutput(requests[5]!, "implement-verify")).toContain("[exit 0]");
        expect(existsSync(join(projectRoot, "plan-bash.txt"))).toBe(false);
      } finally { await closeElectron(); }
    });
  }
});
