import { test as base, expect } from "./fixtures.ts";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Terminal } from "@xterm/xterm";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

const AUTH_BYTES = Buffer.from('{\n  "openai": { "type": "api_key", "key": "synthetic-independent-session-token" }\n}\n');
const MCP_BYTES = Buffer.from('{\n  "mcpServers": { "fixture-mcp": { "command": "node", "args": ["mcp-server.mjs"], "env": { "FIXTURE_TOKEN": "synthetic-mcp-token" } } }\n}\n');
const MCP_SCRIPT = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync("mcp-started", "started");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture-mcp", version: "1" } }
    : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`;
const RESPONSE_TEXT = "Independent session loopback response received.";

const test = base.extend({
  projectRoot: async ({ projectRoot, runRoot }, use) => {
    // electronApp depends on projectRoot, so both files exist before its launch.
    const resources = join(runRoot, "home", ".termina", "agent");
    mkdirSync(resources, { recursive: true, mode: 0o700 });
    writeFileSync(join(resources, "auth.json"), AUTH_BYTES, { mode: 0o600 });
    writeFileSync(join(resources, "mcp.json"), MCP_BYTES, { mode: 0o600 });
    writeFileSync(join(projectRoot, "mcp-server.mjs"), MCP_SCRIPT, { mode: 0o600 });
    await use(projectRoot);
  },
});

async function waitForReady(sidecar: string): Promise<void> {
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
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "").join("\n");
  }, id);
}

test.describe("Independent session private resources", () => {
  let server: Server;
  const previous = new Map<string, string | undefined>();
  const credentials: string[] = [];

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
      } else if (request.method === "POST" && request.url?.endsWith("/responses")) {
        request.resume();
        request.on("end", () => {
          credentials.push(request.headers.authorization ?? "");
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: RESPONSE_TEXT })}\n\n`);
          response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], usage: {} } })}\n\n`);
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
    const environment: Record<string, string | undefined> = {
      TERMINA_CORE_TEST: "1",
      TERMINA_CORE_PROVIDER: "openai",
      TERMINA_CORE_MODEL: "gpt-5.6-sol",
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      // Require the real copied credential rather than an environment fallback.
      OPENAI_API_KEY: undefined,
    };
    for (const [key, value] of Object.entries(environment)) {
      previous.set(key, process.env[key]);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

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

  test("a second agent uses the shared project and its home auth", async ({ page, runRoot, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const primary = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.type === "agent")!;
    expect(primary).toBeDefined();
    await waitForReady(join(runRoot, "events", `${primary.id}.jsonl`));

    const created = await page.evaluate(() => window.termina.createTerminal({ type: "agent" }));
    expect(created).toMatchObject({ ok: true });
    expect(created.id).not.toBe(primary.id);
    const id = created.id!;
    const second = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === id)!;
    expect(realpathSync(second.cwd)).toBe(realpathSync(projectRoot));
    await waitForReady(join(runRoot, "events", `${id}.jsonl`));

    const homeAgent = join(runRoot, "home", ".termina", "agent");
    for (const [name, bytes] of [["auth.json", AUTH_BYTES], ["mcp.json", MCP_BYTES]] as const) {
      expect(readFileSync(join(homeAgent, name))).toEqual(bytes);
      expect(existsSync(join(projectRoot, ".termina", "agent", name))).toBe(false);
    }
    expect(statSync(join(homeAgent, "auth.json")).mode & 0o777).toBe(0o600);

    const marker = join(projectRoot, "mcp-started");
    expect(existsSync(marker)).toBe(false);
    expect(credentials).toEqual([]);

    const prompt = "Connect fixture-mcp, then reply with a short greeting; do not use tools.\r";
    await page.evaluate(({ id, prompt }) => window.termina.writeTerminal(id, prompt), { id, prompt });
    await expect.poll(() => terminalText(page, id), { timeout: 15_000 }).toContain(RESPONSE_TEXT);
    await expect.poll(() => terminalText(page, id)).toContain("mcp fixture-mcp connected");
    expect(readFileSync(marker, "utf8")).toBe("started");
    expect(credentials).toEqual(["Bearer synthetic-independent-session-token"]);
    for (const [name, bytes] of [["auth.json", AUTH_BYTES], ["mcp.json", MCP_BYTES]] as const) {
      expect(readFileSync(join(homeAgent, name))).toEqual(bytes);
    }
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
  });
});
