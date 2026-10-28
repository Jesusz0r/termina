import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "./fixtures.ts";
import { PATH_RULE_BYTES } from "../../agent-core/main/skills.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

const test = base.extend({
  projectRoot: async ({ projectRoot, runRoot }, use) => {
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "match.ts"), "original\n");
    writeFileSync(join(projectRoot, "src", "large.ts"), "large\n");
    writeFileSync(join(runRoot, "outside.ts"), "outside\n");
    symlinkSync(join(runRoot, "outside.ts"), join(projectRoot, "src", "escape.ts"));
    symlinkSync(join(projectRoot, "src", "match.ts"), join(projectRoot, "alias.ts"));
    const definitions: Array<[string, string, string]> = [
      ["scoped", "src/**/*.ts", "SCOPED_RULE_BODY"],
      ["large", "src/large.ts", `LARGE_RULE_BODY ${"🧪".repeat(10_000)}`],
    ];
    for (const [name, pattern, body] of definitions) {
      const directory = join(projectRoot, ".agents", "skills", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\npaths: ${JSON.stringify([pattern])}\n---\n${body}`);
    }
    const ancestor = join(runRoot, ".agents", "skills", "ancestor");
    mkdirSync(ancestor, { recursive: true });
    writeFileSync(join(ancestor, "SKILL.md"), '---\nname: ancestor\npaths: ["**"]\n---\nANCESTOR_RULE_BODY');
    await use(projectRoot);
  },
});

type Call = { name: string; input: Record<string, unknown> };
type ModelRequest = { instructions: string; tools: unknown[]; input: Array<{ type?: string; call_id?: string; output?: string | Array<{ text?: string }> }> };

function complete(response: ServerResponse, index: number, call?: Call): void {
  const id = `call-${index}`;
  const output = call ? [{ type: "function_call", id, call_id: id, name: call.name, arguments: JSON.stringify(call.input) }] : [];
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  if (!call) response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "The file changes were verified." })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}

function toolOutput(request: ModelRequest, index: number): string {
  const result = request.input.filter(item => item.type === "function_call_output" && item.call_id === `call-${index}`);
  expect(result).toHaveLength(1);
  const output = result[0]!.output;
  return typeof output === "string" ? output : output?.map(part => part.text ?? "").join("\n") ?? "";
}

test.describe("Path-scoped rules through the real agent", () => {
  let server: Server;
  const requests: ModelRequest[] = [];
  const previous = new Map<string, string | undefined>();
  const calls: Call[] = [
    { name: "read_file", input: { path: "hello.txt" } },
    { name: "read_file", input: { path: "src/match.ts" } },
    { name: "edit", input: { path: "src/match.ts", old_text: "original", new_text: "updated" } },
    { name: "read_files", input: { paths: ["src/match.ts", "hello.txt"] } },
    { name: "write_file", input: { path: "src/new.ts", content: "new\n" } },
    { name: "read_file", input: { path: "alias.ts" } },
    { name: "read_file", input: { path: "src/escape.ts" } },
    { name: "read_file", input: { path: "../outside.ts" } },
    { name: "read_file", input: { path: "src/large.ts" } },
    { name: "bash", input: { command: "test $(cat src/match.ts) = updated && test $(cat src/new.ts) = new" } },
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
          requests.push(JSON.parse(body));
          response.writeHead(200, { "content-type": "text/event-stream" });
          complete(response, requests.length, calls[requests.length - 1]);
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
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-path-rules-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
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

  test("attaches only matching canonical rules with a shared cap and an unchanged system prefix", async ({ page, projectRoot, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const owner = (await page.evaluate(() => window.termina.getInstances())).find(instance => instance.type === "agent")!;
    const events = join(runRoot, "events", `${owner.id}.jsonl`);
    const records = () => existsSync(events) ? readFileSync(events, "utf8").split("\n").map(parseSidecarRecord).filter(record => record !== null) : [];
    await expect.poll(() => records().some(record => record.t === "session_ready")).toBe(true);
    await page.evaluate(id => window.termina.writeTerminal(id, "Inspect the files, make the requested edits and verify them.\r"), owner.id);
    await expect.poll(() => records().some(record => record.t === "agent_settled"), { timeout: 30_000 }).toBe(true);
    expect(requests).toHaveLength(calls.length + 1);
    for (const request of requests) {
      expect(request.instructions).toBe(requests[0]!.instructions);
      expect(request.instructions).not.toContain("SCOPED_RULE_BODY");
      expect(request.instructions).not.toContain("LARGE_RULE_BODY");
      expect(request.tools).toEqual(requests[0]!.tools);
      expect(JSON.stringify(request)).not.toContain("ANCESTOR_RULE_BODY");
    }
    for (const index of [2, 3, 4, 5, 6]) expect(toolOutput(requests[index]!, index)).toContain("SCOPED_RULE_BODY");
    for (const index of [1, 7, 8, 10]) expect(toolOutput(requests[index]!, index)).not.toContain("RULE_BODY");
    expect(toolOutput(requests[7]!, 7)).toContain("outside project");
    const capped = toolOutput(requests[9]!, 9);
    expect(capped).toContain("LARGE_RULE_BODY");
    expect(capped).toContain("path rules truncated");
    expect(capped).not.toContain("\uFFFD");
    expect(Buffer.byteLength(capped.slice(capped.indexOf("\n\nPath rules from")))).toBeLessThanOrEqual(PATH_RULE_BYTES);
    expect(readFileSync(join(projectRoot, "src", "match.ts"), "utf8")).toBe("updated\n");
    expect(readFileSync(join(projectRoot, "src", "new.ts"), "utf8")).toBe("new\n");
    expect(readFileSync(join(runRoot, "outside.ts"), "utf8")).toBe("outside\n");
  });
});
