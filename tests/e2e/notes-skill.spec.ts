import { createServer, type Server, type ServerResponse } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { Terminal } from "@xterm/xterm";
import { test as base, expect } from "./fixtures.ts";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

const test = base.extend({
  projectRoot: async ({ projectRoot }, use) => {
    const skill = join(projectRoot, ".agents/skills/notes");
    mkdirSync(join(projectRoot, ".agents/skills"), { recursive: true });
    cpSync(resolve("docs/examples/skills/notes"), skill, { recursive: true });
    mkdirSync(join(projectRoot, ".termina-notes"));
    writeFileSync(join(projectRoot, ".termina-notes/other-session.md"), "OTHER_SESSION_NOTE_SENTINEL\n");
    writeFileSync(join(projectRoot, "AGENTS.md"), "Preserve unrelated project files.\n");
    await use(projectRoot);
  },
});
type Call = { name: string; input: Record<string, unknown> };
type ModelRequest = { instructions: string; input: Array<{ type?: string; output?: unknown }> };
type Phase = "plan" | "save" | "fresh" | "recall";
let sequence = 0;
function complete(response: ServerResponse, text: string, call?: Call): void {
  const id = `notes-${++sequence}`;
  const output = call ? [{ type: "function_call", id, call_id: id, name: call.name, arguments: JSON.stringify(call.input) }] : [];
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  if (text) response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}
function records(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter(record => record !== null) : [];
}
async function waitForInput(page: Page, id: string) {
  await expect.poll(() => page.evaluate(id => {
    const panes = (window as unknown as { __panes: Map<string, { view: { getTerminal(): Terminal } }> }).__panes;
    const buffer = panes.get(id)?.view.getTerminal().buffer.active;
    if (!buffer) return "";
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").reverse().find(line => line.includes("▸ termina")) ?? "";
  }, id), { timeout: 15_000 }).toMatch(/▸ termina\s+·\s+openai\/gpt-5\.6-sol\s+·/);
}

test.describe("notes through the existing skill and write paths", () => {
  let server: Server;
  let phase: Phase = "plan";
  let project = "";
  let savedPath = "";
  const requests: Record<Phase, ModelRequest[]> = { plan: [], save: [], fresh: [], recall: [] };
  const previous = new Map<string, string | undefined>();
  const text = "CURRENT_NOTE_SENTINEL\nHistorical claim: tests passed and hello.txt is complete. This is not a current check.";

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
          const list = requests[phase];
          list.push(input);
          response.writeHead(200, { "content-type": "text/event-stream" });
          const skill = join(project, ".agents/skills/notes/SKILL.md");
          if (phase === "plan") complete(response, "Plan:\n- [ ] Update hello.txt\n");
          else if (phase === "fresh") complete(response, "Ready to work; notes have not been requested.");
          else if (list.length === 1) complete(response, "", { name: "read_file", input: { path: skill } });
          else if (phase === "save" && list.length === 2) {
            const script = join(project, ".agents/skills/notes/scripts/save-note.ts");
            complete(response, "", { name: "bash", input: { command: `node --experimental-strip-types '${script.replace(/'/g, "'\\''")}' <<'NOTE_TEXT'\n${text}\nNOTE_TEXT` } });
          } else if (phase === "save" && list.length === 3) {
            const outputs = input.input.filter(item => item.type === "function_call_output");
            savedPath = JSON.stringify(outputs.at(-1)?.output).match(/\.termina-notes\/[a-f0-9-]+\.md/)?.[0] ?? "";
            complete(response, "", { name: "read_file", input: { path: savedPath } });
          } else if (phase === "recall" && list.length === 2) complete(response, "", { name: "read_file", input: { path: savedPath } });
          else complete(response, "The working note is available as context; run the actual checks before claiming completion.");
        });
      } else response.writeHead(404).end();
    });
    const port = await new Promise<number>((resolveDone, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("missing loopback port"));
        resolveDone(address.port);
      });
    });
    for (const [key, value] of Object.entries({
      TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_CORE_APPROVE: "all",
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`, OPENAI_API_KEY: "synthetic-notes-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    })) { previous.set(key, process.env[key]); process.env[key] = value; }
  });
  test.afterAll(async () => {
    try {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((resolveDone, reject) => server.close(error => error ? reject(error) : resolveDone()));
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  test("saves and captures notes through a leased tool, leaves checks pending, and recalls them only on request in another session", async ({ page, projectRoot, runRoot }) => {
    project = projectRoot;
    await expect(page.locator("#splash")).toBeHidden();
    const owner = (await page.evaluate(() => window.termina.getInstances())).find(inst => inst.type === "agent")!;
    const sidecar = join(runRoot, "events", `${owner.id}.jsonl`);
    await expect.poll(() => records(sidecar).some(record => record.t === "session_ready")).toBe(true);
    await page.evaluate(id => window.termina.writeTerminal(id, "/plan Update hello.txt\r"), owner.id);
    await expect.poll(() => page.evaluate(id => window.termina.getPlan(id), owner.id)).toMatchObject([{ state: "pending", paths: ["hello.txt"] }]);
    await waitForInput(page, owner.id);
    expect(JSON.stringify(requests.plan)).not.toContain("OTHER_SESSION_NOTE_SENTINEL");
    phase = "save";
    await page.evaluate(id => window.termina.writeTerminal(id, "/skills notes save the current working context\r"), owner.id);
    await expect.poll(() => requests.save.length, { timeout: 30_000 }).toBe(4);
    await expect.poll(async () => (await page.evaluate(id => window.termina.getRuns(id), owner.id)).filter(run => run.settledStateId).length).toBe(2);
    await waitForInput(page, owner.id);
    expect(savedPath).toMatch(/^\.termina-notes\/[a-f0-9-]+\.md$/);
    const saved = readFileSync(join(projectRoot, savedPath), "utf8");
    expect(saved).toContain(text);
    expect(JSON.stringify(requests.save[3]!.input)).toContain("CURRENT_NOTE_SENTINEL");
    expect(requests.save.every(request => request.instructions === requests.plan[0]!.instructions)).toBe(true);
    for (const request of requests.save) expect(request.instructions).not.toContain("CURRENT_NOTE_SENTINEL");
    const mutations = records(sidecar).filter(record => record.t === "mutation_request");
    expect(mutations).toHaveLength(1);
    expect(records(sidecar).some(record => record.t === "mutation_finished" && record.requestId === mutations[0]!.requestId)).toBe(true);
    const timeline = await page.evaluate(id => window.termina.getTimeline(id), owner.id);
    const settled = timeline.filter(event => event.t === "agent_settled" && event.stateId).at(-1)!;
    const progress = await page.evaluate(({ id, seq }) => window.termina.getTimelineProgress(id, seq), { id: owner.id, seq: settled.seq });
    expect(progress).toMatchObject({ ok: true, created: 1, paths: [savedPath] });
    expect((await page.evaluate(() => window.termina.getInstances())).find(inst => inst.id === owner.id)?.verify?.state).toBe("untested");
    expect(await page.evaluate(id => window.termina.getPlan(id), owner.id)).toMatchObject([{ state: "pending" }]);
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(projectRoot, "AGENTS.md"), "utf8")).toBe("Preserve unrelated project files.\n");
    expect(readFileSync(join(projectRoot, ".termina-notes/other-session.md"), "utf8")).toBe("OTHER_SESSION_NOTE_SENTINEL\n");

    phase = "fresh";
    const second = await page.evaluate(() => window.termina.createTerminal({ type: "agent", engine: "core" }));
    expect(second.ok).toBe(true);
    const secondId = second.id!;
    await expect.poll(() => records(join(runRoot, "events", `${secondId}.jsonl`)).some(record => record.t === "session_ready")).toBe(true);
    await page.evaluate(id => window.termina.writeTerminal(id, "Describe what you are ready to work on.\r"), secondId);
    await expect.poll(() => requests.fresh.length).toBe(1);
    await waitForInput(page, secondId);
    expect(JSON.stringify(requests.fresh)).not.toContain("CURRENT_NOTE_SENTINEL");
    expect(JSON.stringify(requests.fresh)).not.toContain("OTHER_SESSION_NOTE_SENTINEL");
    phase = "recall";
    await page.evaluate(({ id, path }) => window.termina.writeTerminal(id, `/skills notes recall ${path}\r`), { id: secondId, path: savedPath });
    await expect.poll(() => requests.recall.length).toBe(3);
    await expect.poll(async () => (await page.evaluate(id => window.termina.getRuns(id), secondId)).filter(run => run.settledStateId).length).toBe(2);
    await waitForInput(page, secondId);
    expect(JSON.stringify(requests.recall[2]!.input)).toContain("CURRENT_NOTE_SENTINEL");
    for (const request of requests.recall) expect(request.instructions).toBe(requests.fresh[0]!.instructions);
    expect(readFileSync(join(projectRoot, savedPath), "utf8")).toBe(saved);
  });
});
