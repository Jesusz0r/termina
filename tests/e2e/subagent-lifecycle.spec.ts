import { test, expect } from "./fixtures.ts";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Terminal } from "@xterm/xterm";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { readSubagentResultFile, subagentChildTid, subagentTaskFileName } from "../../agent-core/subagents.ts";
import { readSubagentClaimsFile } from "../../agent-core/subagents/claims.ts";
import { readSystemProcessIdentity } from "../../shared/process-identity.ts";
import { quoteShellArg } from "../../shared/terminal-control.ts";
import { answerLifecycleDialog, lifecycleDialogs, mockLifecycleDialogs } from "./lifecycle-dialog.ts";

function complete(response: ServerResponse, call?: { name: string; args: Record<string, unknown> }) {
  const output = call ? [{ type: "function_call", id: call.name, call_id: call.name, name: call.name, arguments: JSON.stringify(call.args) }] : [];
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}

function records(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter((record) => record !== null) : [];
}

test.describe("Real background subagent lifecycle", () => {
  let server: Server;
  let command = "";
  let parentCalls = 0;
  let childCalls = 0;
  const previous = new Map<string, string | undefined>();

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
      } else if (request.method === "POST" && request.url === "/v1/responses") {
        let body = "";
        request.on("data", (chunk) => { body += chunk.toString(); });
        request.on("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const parent = JSON.stringify(JSON.parse(body).tools).includes('"spawn_subagent"');
          if (parent && ++parentCalls === 1) complete(response, { name: "spawn_subagent", args: {
            task: "Run the bounded subagent lifecycle command, then report its outcome. Do not spawn others or alter unrelated files.", paths: ["subagent-command.pid"],
          } });
          else if (!parent && ++childCalls === 1) complete(response, { name: "bash", args: { command } });
          else complete(response);
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
    for (const [key, value] of Object.entries({
      TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol",
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`,
      OPENAI_API_KEY: "synthetic-subagent-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    })) { previous.set(key, process.env[key]); process.env[key] = value; }
  });
  test.beforeEach(() => { parentCalls = 0; childCalls = 0; command = ""; });
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

  for (const scope of ["terminal", "project", "app"] as const) {
    test(`${scope} close discloses a real subagent, preserves it on Cancel and stops its command tree`, async ({ page, electronApp, projectRoot, runRoot }, testInfo) => {
      await expect(page.locator("#splash")).toBeHidden();
      const owner = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.type === "agent")!;
      const eventsDir = join(runRoot, "events");
      const ownerPath = join(eventsDir, `${owner.id}.jsonl`);
      await expect.poll(() => records(ownerPath).some((record) => record.t === "session_ready" && record.ok === true)).toBe(true);
      const pidPath = join(projectRoot, "subagent-command.pid");
      const script = `const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({command:process.pid,shell:process.ppid,descendant:child.pid}));setTimeout(()=>{child.kill('SIGKILL');process.exit(2)},45000);setInterval(()=>{},1000)`;
      command = `node -e ${quoteShellArg(script)}`;
      await page.evaluate((id) => window.termina.writeTerminal(id, "subagent lifecycle test: delegate the bounded command\r"), owner.id);
      await expect.poll(() => records(ownerPath).some((record) => record.t === "subagent_spawn")).toBe(true);
      const spawn = records(ownerPath).find((record) => record.t === "subagent_spawn")!;
      const runId = String(spawn.runId);
      const childPath = join(eventsDir, `${subagentChildTid(owner.id, runId)}.jsonl`);
      await expect.poll(() => page.evaluate((id) => {
        const pane = (window as unknown as { __panes: Map<string, { view: { getTerminal(): Terminal } }> }).__panes.get(id)!;
        const buffer = pane.view.getTerminal().buffer.active;
        return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").join("\n");
      }, owner.id)).toContain("Approve once");
      // Approve through the actual parent's picker; child permissions stay ask.
      await page.evaluate((id) => window.termina.writeTerminal(id, "/approve once\r"), owner.id);
      await expect.poll(() => existsSync(pidPath)).toBe(true);
      const commandPids = JSON.parse(readFileSync(pidPath, "utf8")) as Record<string, number>;
      const childPid = Number(records(childPath).find((record) => record.t === "session_ready")?.producerPid);
      const identities = [childPid, ...Object.values(commandPids)].map((pid) => ({ pid, identity: readSystemProcessIdentity(pid) }));
      expect(identities).toHaveLength(4);
      expect(new Set(identities.map(({ pid }) => pid)).size).toBe(4);
      for (const item of identities) { expect(item.pid).toBeGreaterThan(0); expect(item.identity).not.toBeNull(); }
      const live = () => identities.every(({ pid, identity }) => readSystemProcessIdentity(pid) === identity);
      expect(readSubagentResultFile(eventsDir, owner.id, runId).status).toBe("missing");
      expect(childCalls).toBe(1);

      // Another actual project/terminal must survive a targeted close.
      const otherRoot = join(runRoot, "unrelated-project");
      mkdirSync(otherRoot);
      writeFileSync(join(otherRoot, "other.txt"), "unrelated\n");
      await page.evaluate((root) => window.termina.projectOpenPath(root), otherRoot);
      const other = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.projectId !== owner.projectId)!;
      await expect.poll(() => records(join(eventsDir, `${other.id}.jsonl`)).some((record) => record.t === "session_ready" && record.ok === true)).toBe(true);
      const otherPid = Number(records(join(eventsDir, `${other.id}.jsonl`)).find((record) => record.t === "session_ready")?.producerPid);
      const otherIdentity = readSystemProcessIdentity(otherPid);
      expect(otherIdentity).not.toBeNull();
      await mockLifecycleDialogs(electronApp, 1);
      const close = async () => {
        if (scope === "terminal") return page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), owner);
        if (scope === "project") return page.evaluate((id) => window.termina.projectClose(id), owner.projectId!);
        await electronApp.evaluate(({ app }) => { process.env.NODE_ENV = "production"; app.quit(); });
        await expect.poll(() => lifecycleDialogs(electronApp).then((dialogs) => dialogs.length)).toBe(1);
        return { ok: false, cancelled: true };
      };
      expect(await close()).toMatchObject({ ok: false, cancelled: true });
      const dialog = (await lifecycleDialogs(electronApp))[0];
      expect(dialog.detail).toContain(`1 background child run(s): ${runId}`);
      expect(dialog.detail).toContain(projectRoot);
      expect(dialog.detail).toContain("stops their background child runs");
      expect(dialog.defaultId).toBe(1);
      expect(live()).toBe(true);
      expect(readSubagentResultFile(eventsDir, owner.id, runId).status).toBe("missing");
      expect((await page.evaluate(() => window.termina.getInstances())).some((instance) => instance.id === owner.id)).toBe(true);
      await answerLifecycleDialog(electronApp, 0);
      if (scope === "app") {
        const closed = electronApp.waitForEvent("close");
        await electronApp.evaluate(({ app }) => app.quit());
        await closed;
      } else {
        expect(await close()).toMatchObject({ ok: true });
        await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((instances) => instances.map((instance) => instance.id)))).not.toContain(owner.id);
        expect((await page.evaluate(() => window.termina.getInstances())).some((instance) => instance.id === other.id)).toBe(true);
        expect(readSystemProcessIdentity(otherPid)).toBe(otherIdentity);
        await expect.poll(() => readSubagentResultFile(eventsDir, owner.id, runId), { timeout: 10_000 }).toMatchObject({ status: "ok", file: { outcome: "killed", error: expect.any(String) } });
        await expect.poll(() => existsSync(join(eventsDir, subagentTaskFileName(owner.id, runId)!))).toBe(false);
        await expect.poll(() => readSubagentClaimsFile(eventsDir, owner.id)).toMatchObject({ status: "ok", runs: [] });
      }
      // This assertion precedes fixture cleanup: its orphan cleanup cannot pass it.
      await expect.poll(() => identities.map(({ pid, identity }) => readSystemProcessIdentity(pid) === identity), { timeout: 10_000 }).toEqual([false, false, false, false]);
      await testInfo.attach("owned-subagent-processes", { body: JSON.stringify({ scope, owner: owner.id, runId, identities, parentCalls, childCalls }), contentType: "application/json" });
    });
  }
});
