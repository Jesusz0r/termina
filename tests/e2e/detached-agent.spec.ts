import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import type { Terminal } from "@xterm/xterm";
import { test, expect, launchOwnedElectron, closeOwnedElectron } from "./fixtures.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { readSystemProcessIdentity } from "../../shared/process-identity.ts";
import { quoteShellArg } from "../../shared/terminal-control.ts";

type Request = { input: Array<{ type?: string; call_id?: string; output?: unknown }> };
let server: Server;
let port: number;
let scenario: "detach" | "crash" | "restart";
let held: ServerResponse | null;
let command: string;
const requests: Request[] = [];
const previous = new Map<string, string | undefined>();
const records = (path: string) => existsSync(path) ? readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter(record => record !== null) : [];

function complete(response: ServerResponse, index: number, call?: { name: string; input: Record<string, unknown> }): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const id = `${scenario}-call-${index}`;
  const output = call ? [{ type: "function_call", id, call_id: id, name: call.name, arguments: JSON.stringify(call.input) }] : [];
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  if (!call) response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "The file was checked." })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}

function terminalText(page: Page, id: string): Promise<string> {
  return page.evaluate(id => {
    const pane = (window as unknown as { __panes: Map<string, { view: { getTerminal(): Terminal } }> }).__panes.get(id)!;
    const buffer = pane.view.getTerminal().buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").join("\n");
  }, id);
}

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
        const index = requests.length;
        if (scenario === "detach" && index === 1) { held = response; return; }
        if (scenario === "detach" && index === 2) complete(response, index, { name: "write_file", input: { path: "hello.txt", content: "approved\n" } });
        else if (scenario === "detach" && index === 3 || scenario === "crash" && index === 1) complete(response, index, { name: "bash", input: { command } });
        else if (scenario === "restart" && index === 1) complete(response, index, { name: "write_file", input: { path: "hello.txt", content: "recovered\n" } });
        else if (scenario === "restart" && index === 2) complete(response, index, { name: "bash", input: { command: "test $(cat hello.txt) = recovered" } });
        else complete(response, index);
      });
    } else response.writeHead(404).end();
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
    TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_CORE_APPROVE: "all",
    TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-detach-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  })) { previous.set(key, process.env[key]); process.env[key] = value; }
});

test.beforeEach(() => { requests.length = 0; held = null; });
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

test("window close preserves the agent, requires reattached approval and drains admitted writes", async ({ page, electronApp, projectRoot, runRoot, closeElectron }) => {
  scenario = "detach";
  const script = "const fs=require('node:fs');fs.writeFileSync('command.pid',String(process.pid));const timer=setInterval(()=>{if(fs.existsSync('finish-command')){clearInterval(timer);if(fs.readFileSync('hello.txt','utf8')!=='approved\\n')process.exit(1);fs.writeFileSync('checked.txt','checked');process.exit(0)}},25)";
  command = `node -e ${quoteShellArg(script)}`;
  await expect(page.locator("#splash")).toBeHidden();
  const owner = (await page.evaluate(() => window.termina.getInstances())).find(instance => instance.type === "agent")!;
  const events = join(runRoot, "events", `${owner.id}.jsonl`);
  await expect.poll(() => records(events).some(record => record.t === "session_ready")).toBe(true);
  const pid = Number(records(events).find(record => record.t === "session_ready")!.producerPid);
  const identity = readSystemProcessIdentity(pid);
  expect(identity).not.toBeNull();
  await page.evaluate(id => window.termina.writeTerminal(id, "Inspect, update and check hello.txt.\r"), owner.id);
  await expect.poll(() => held !== null).toBe(true);
  const sessionFile = records(events).find(record => record.t === "agent_start")!.sessionFile;
  expect(typeof sessionFile).toBe("string");
  await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close(); });
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  expect(readSystemProcessIdentity(pid)).toBe(identity);
  complete(held!, 1, { name: "read_file", input: { path: "hello.txt" } });
  await expect.poll(() => records(events).some(record => record.t === "intervention_requested")).toBe(true);
  expect(requests).toHaveLength(2);
  const read = requests[1]!.input.find(item => item.type === "function_call_output");
  expect(read?.output).toEqual([{ type: "input_text", text: "hello.txt line 1\nhello" }]);
  expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
  expect(records(events).some(record => record.t === "agent_settled")).toBe(false);

  await electronApp.evaluate(({ app }) => { app.emit("activate"); });
  const reopened = await electronApp.firstWindow();
  await expect(reopened.locator("#splash")).toBeHidden();
  const same = (await reopened.evaluate(() => window.termina.getInstances())).find(instance => instance.id === owner.id)!;
  expect(same.generation).toBe(owner.generation);
  expect(readSystemProcessIdentity(pid)).toBe(identity);
  await expect.poll(() => terminalText(reopened, owner.id)).toContain("Continue after window close?");
  expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
  expect(requests).toHaveLength(2);
  await reopened.evaluate(id => window.termina.writeTerminal(id, "/approve once\r"), owner.id);
  await expect.poll(() => existsSync(join(projectRoot, "command.pid"))).toBe(true);
  expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("approved\n");
  await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close(); });
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(existsSync(join(projectRoot, "checked.txt"))).toBe(false);
  writeFileSync(join(projectRoot, "finish-command"), "finish");
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await expect.poll(() => records(events).some(record => record.t === "agent_settled")).toBe(true);
  expect(readFileSync(join(projectRoot, "checked.txt"), "utf8")).toBe("checked");
  expect(requests).toHaveLength(4);
  expect(records(events).filter(record => record.t === "agent_start")).toHaveLength(1);
  expect(records(events).find(record => record.t === "agent_start")!.sessionFile).toBe(sessionFile);
  expect(readSystemProcessIdentity(pid)).toBe(identity);
  await closeElectron();
  expect(readSystemProcessIdentity(pid)).toBeNull();
});

test("main-process crash stops the orphan and releases its session and write lease for restart", async ({ page, electronApp, projectRoot, runRoot, closeElectron }) => {
  scenario = "crash";
  const script = "const fs=require('node:fs');fs.writeFileSync('command.pid',String(process.pid));setTimeout(()=>fs.writeFileSync('orphan-write.txt','unexpected'),10000);setInterval(()=>{},1000)";
  command = `node -e ${quoteShellArg(script)}`;
  await expect(page.locator("#splash")).toBeHidden();
  const owner = (await page.evaluate(() => window.termina.getInstances())).find(instance => instance.type === "agent")!;
  const events = join(runRoot, "events", `${owner.id}.jsonl`);
  await expect.poll(() => records(events).some(record => record.t === "session_ready")).toBe(true);
  const agentPid = Number(records(events).find(record => record.t === "session_ready")!.producerPid);
  await page.evaluate(id => window.termina.writeTerminal(id, "Run the bounded crash probe.\r"), owner.id);
  await expect.poll(() => existsSync(join(projectRoot, "command.pid"))).toBe(true);
  const commandPid = Number(readFileSync(join(projectRoot, "command.pid"), "utf8"));
  const identities = [agentPid, commandPid].map(pid => ({ pid, identity: readSystemProcessIdentity(pid) }));
  for (const process of identities) expect(process.identity).not.toBeNull();
  const sessionFile = records(events).find(record => record.t === "agent_start")!.sessionFile;
  const sessionBytes = readFileSync(String(sessionFile));
  const child = electronApp.process();
  const closed = new Promise<void>(resolve => { child.once("exit", () => resolve()); });
  child.kill("SIGKILL");
  await closed;
  // Observe before fixture cleanup: its orphan reaper must not make this assertion pass.
  await expect.poll(() => identities.map(({ pid }) => {
    const identity = readSystemProcessIdentity(pid);
    if (identity === null) return null;
    return { pid, identity, status: execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim() };
  }), { timeout: 8000 }).toEqual([null, null]);
  expect(existsSync(join(projectRoot, "orphan-write.txt"))).toBe(false);
  await closeElectron();

  scenario = "restart";
  requests.length = 0;
  const restarted = await launchOwnedElectron({
    ...process.env as Record<string, string>, HOME: join(runRoot, "home"), USERPROFILE: join(runRoot, "home"),
    TERMINA_INITIAL_CWD: projectRoot, TERMINA_EVENTS_DIR: join(runRoot, "events"), TERMINA_WORLDS_DIR: join(runRoot, "worlds"),
    TERMINA_USER_DATA_DIR: join(runRoot, "user-data"), TERMINA_E2E_RUN_ROOT: runRoot, TERMINA_E2E_HIDDEN: "1", NODE_ENV: "test",
  }, runRoot);
  try {
    const reattached = await restarted.firstWindow();
    await expect(reattached.locator("#splash")).toBeHidden();
    const next = (await reattached.evaluate(() => window.termina.getInstances())).find(instance => instance.type === "agent")!;
    await expect.poll(() => records(events).filter(record => record.t === "session_ready").length).toBe(2);
    await expect.poll(() => terminalText(reattached, next.id)).toContain("termina");
    await reattached.evaluate(id => window.termina.writeTerminal(id, "Write recovered to hello.txt and check it.\r"), next.id);
    try {
      await expect.poll(() => readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("recovered\n");
    } catch (error) {
      throw new Error(`${String(error)}\nRestart terminal: ${await terminalText(reattached, next.id)}\nModel calls: ${requests.length}\nRecent events: ${JSON.stringify(records(events).slice(-10))}`);
    }
    await expect.poll(() => records(events).some(record => record.t === "agent_settled")).toBe(true);
    const starts = records(events).filter(record => record.t === "agent_start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.sessionFile).toBe(sessionFile);
    expect(readFileSync(String(sessionFile)).subarray(0, sessionBytes.length)).toEqual(sessionBytes);
    expect(requests).toHaveLength(3);
  } finally {
    await closeOwnedElectron(restarted);
  }
});
