import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "./fixtures.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

let server: Server;
let port: number;
let modelCalls = 0;
let mcpCalls = 0;
const previous = new Map<string, string | undefined>();
const test = base.extend({
  projectRoot: async ({ projectRoot, runRoot }, use) => {
    writeFileSync(join(projectRoot, "AGENTS.md"), "PRIVATE_PROJECT_INSTRUCTIONS\n".repeat(1500));
    const user = join(runRoot, "home", ".agents");
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, "AGENTS.md"), "PRIVATE_USER_INSTRUCTIONS\n".repeat(500));
    for (let index = 0; index < 12; index++) {
      const dir = join(projectRoot, ".agents", "skills", String(index));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: skill-${index}-${"x".repeat(900)}\n---\nPRIVATE_SKILL_BODY`);
    }
    const configDir = join(runRoot, "home", ".termina", "agent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: {
      fixture: { type: "http", url: `http://127.0.0.1:${port}/mcp?token=PRIVATE_URL`,
        headers: { Authorization: "Bearer PRIVATE_HEADER" }, env: { TOKEN: "PRIVATE_ENV" } },
    } }));
    await use(projectRoot);
  },
});

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
    } else if (request.url?.startsWith("/mcp")) {
      mcpCalls++;
      response.writeHead(401).end("PRIVATE_ERROR_BODY PRIVATE_HEADER PRIVATE_ENV");
    } else {
      if (request.url?.endsWith("/responses")) modelCalls++;
      response.writeHead(404).end();
    }
  });
  port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing loopback port"));
      resolve(address.port);
    });
  });
  for (const [key, value] of Object.entries({
    TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol",
    TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "PRIVATE_PROVIDER_KEY", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
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

test("/doctor reports frozen loader facts and safe MCP codes without a model turn", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const owner = (await page.evaluate(() => window.termina.getInstances())).find(instance => instance.type === "agent")!;
  const sidecar = join(runRoot, "events", `${owner.id}.jsonl`);
  const records = () => existsSync(sidecar) ? readFileSync(sidecar, "utf8").split("\n").map(parseSidecarRecord).filter(record => record !== null) : [];
  await expect.poll(() => records().some(record => record.t === "session_ready")).toBe(true);
  const commandOutput = (command: string, marker: string) => page.evaluate(({ id, command, marker }) => new Promise<string>((resolve, reject) => {
    let output = "";
    const stop = window.termina.onPtyData(event => {
      if (event.id !== id) return;
      output = (output + event.data).slice(-64_000);
      if (output.includes(marker)) { clearTimeout(timer); stop(); resolve(output); }
    });
    const timer = setTimeout(() => { stop(); reject(new Error(`missing command output: ${marker}\n${output}`)); }, 15_000);
    window.termina.writeTerminal(id, `${command}\r`).catch(error => { clearTimeout(timer); stop(); reject(error); });
  }), { id: owner.id, command, marker });

  expect(await commandOutput("/help", "/doctor")).toContain("report instruction, skill, and MCP loading");
  const first = await commandOutput("/doctor", "MCP connection failures: 0");
  expect(first).toContain("Skills: 0 indexed, 12 omitted by index limit");
  expect(first).toContain("User AGENTS.md: truncated");
  expect(first).toContain("Project AGENTS.md: truncated");
  expect(mcpCalls).toBe(0);
  writeFileSync(join(projectRoot, "AGENTS.md"), "short instructions");
  writeFileSync(join(runRoot, "home", ".agents", "AGENTS.md"), "short instructions");
  expect(await commandOutput("/mcp reconnect", "needs authentication")).not.toContain("PRIVATE_");
  const second = await commandOutput("/doctor", "HTTP_401");
  expect(second).toContain("Skills: 0 indexed, 12 omitted by index limit");
  expect(second).toContain("User AGENTS.md: truncated");
  expect(second).toContain("Project AGENTS.md: truncated");
  expect(second).toContain('"fixture": needs-authentication (HTTP_401)');
  // Redraws include earlier /mcp output; secrets must be absent from all of it.
  expect(first + second).not.toMatch(/PRIVATE_|Bearer/);
  expect(modelCalls).toBe(0);
  expect(mcpCalls).toBe(1);
  expect(records().some(record => record.t === "agent_start")).toBe(false);
});
