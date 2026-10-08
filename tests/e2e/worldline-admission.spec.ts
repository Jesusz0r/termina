import { test, expect, sampleOwnedProcessMemory } from "./fixtures.ts";
import { readSystemProcessIdentity } from "../../shared/process-identity.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";
import type { Page } from "@playwright/test";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { mockLifecycleDialogs, lifecycleDialogs } from "./lifecycle-dialog.ts";
import type { TimelineEvent, WorldlineSummary } from "../../shared/types.ts";

function complete(response: ServerResponse, text: string, call?: { id: string; name: "write_file" | "bash"; args: Record<string, string> }) {
  response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
  const output = call ? [{ type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }] : [];
  for (const item of output) response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
  response.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: {} } })}\n\n`);
}

function sustainedCommand(key: string): string {
  const grandchild = `const fs = require('node:fs'); const memory = Buffer.alloc(8 * 1024 * 1024, 1); fs.writeFileSync('six-child.pid', String(process.pid)); setInterval(() => { memory[0]++; }, 100); setTimeout(() => process.exit(9), 110000);`;
  const script = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const memory = Buffer.alloc(4 * 1024 * 1024, 1);
const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
let childExited = false;
child.once('exit', () => { childExited = true; });
fs.writeFileSync('six-running.pid', String(process.pid));
const deadline = Date.now() + 90000;
let finishing = false;
const timer = setInterval(() => {
  memory[0]++;
  process.stdout.write(${JSON.stringify(key + " ")} + 'x'.repeat(2048) + '\\n');
  const released = fs.existsSync('.six-agent-release');
  if ((!released && Date.now() < deadline) || finishing) return;
  finishing = true;
  clearInterval(timer);
  const ok = released && fs.readFileSync('six-result.txt', 'utf8') === ${JSON.stringify(key + "\n")};
  const finish = () => { process.exitCode = ok ? 0 : 9; };
  if (childExited) finish();
  else { child.once('exit', finish); child.kill('SIGTERM'); }
}, 50);
child.once('error', (error) => { console.error(error); clearInterval(timer); process.exitCode = 9; });
`;
  return `node -e '${script.replace(/'/g, "'\\''")}'`;
}

function completeModels(response: ServerResponse) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
}

function records(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter((record) => record !== null) : [];
}

async function sourceMoment(page: Page, runRoot: string, projectId?: string): Promise<{ ownerId: string; projectId: string; moment: TimelineEvent }> {
  await expect(page.locator("#splash")).toBeHidden();
  const owner = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.type === "agent" && (!projectId || instance.projectId === projectId))!;
  const path = join(runRoot, "events", `${owner.id}.jsonl`);
  await expect.poll(() => records(path).some((record) => record.t === "session_ready" && record.ok === true)).toBe(true);
  const settledCount = (await page.evaluate((id) => window.termina.getRuns(id), owner.id)).filter((run) => run.settledStateId !== null).length;
  await page.evaluate((id) => window.termina.writeTerminal(id, "worldline-source-e2e\r"), owner.id);
  await expect.poll(async () => (await page.evaluate((id) => window.termina.getRuns(id), owner.id)).filter((run) => run.settledStateId !== null).length).toBeGreaterThan(settledCount);
  await expect.poll(async () => (await page.evaluate((id) => window.termina.getTimeline(id), owner.id)).filter((event) => event.t === "agent_settled" && event.stateId && event.entryId && !event.evicted).length).toBeGreaterThan(settledCount);
  const timeline = await page.evaluate((id) => window.termina.getTimeline(id), owner.id);
  const moment = timeline.filter((event) => event.t === "agent_settled" && event.stateId && event.entryId && !event.evicted).at(-1)!;
  const run = (await page.evaluate((id) => window.termina.getRuns(id), owner.id)).at(-1)!;
  expect(moment.ts).toBeLessThanOrEqual(run.settledAt!);
  return { ownerId: owner.id, projectId: owner.projectId!, moment };
}

async function fork(page: Page, ownerId: string, projectId: string, moment: TimelineEvent): Promise<WorldlineSummary> {
  const result = await page.evaluate(({ ownerId, seq }) => window.termina.forkPoint(ownerId, seq), { ownerId, seq: moment.seq });
  expect(result).toMatchObject({ ok: true });
  const candidates = await page.evaluate((id) => window.termina.getWorldlines(id), projectId);
  const candidate = candidates.find((item) => item.comparisonId === result.comparisonId)!;
  expect(candidate).toMatchObject({ role: "moment", state: "ready", error: null });
  expect(candidate.terminalId).toBeTruthy();
  expect(candidate.sessionFile).toBeTruthy();
  expect(candidate.terminalId).not.toBe(ownerId);
  const sidecar = join(dirname(candidate.root), "A-support", "events", `${candidate.terminalId}.jsonl`);
  expect(records(sidecar).some((record) => record.t === "session_ready" && record.ok === true)).toBe(true);
  const manifest = JSON.parse(readFileSync(join(dirname(candidate.root), "manifest.json"), "utf8"));
  expect(manifest.status).toBe("complete");
  expect(manifest.candidates.A.pid).toBeGreaterThan(0);
  return candidate;
}

test.describe("Candidate admission through the real sandbox", () => {
  let server: Server;
  let primaryResponse: ServerResponse | null = null;
  let candidateCalls = 0;
  let primaryPath = "";
  let candidateResults: unknown[] = [];
  let holdModels = false;
  let sourceWriteCalls = 0;
  let sustained = false;
  const pendingModels: ServerResponse[] = [];
  const scaleCalls = new Map<string, number>();
  const previous = new Map<string, string | undefined>();

  function releaseModels() {
    holdModels = false;
    for (const response of pendingModels.splice(0)) completeModels(response);
  }

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        if (holdModels) pendingModels.push(response);
        else completeModels(response);
      } else if (request.method === "POST" && request.url?.endsWith("/responses")) {
        let body = "";
        request.on("data", (chunk) => { body += chunk.toString(); });
        request.on("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const scaleKey = body.match(/attention-six-run-(?:primary|candidate)-[0-2]/)?.[0];
          if (scaleKey) {
            const count = (scaleCalls.get(scaleKey) ?? 0) + 1;
            scaleCalls.set(scaleKey, count);
            if (count === 1) complete(response, "Writing in the admitted work area.", {
              id: `${scaleKey}-write`, name: "write_file", args: { path: "six-result.txt", content: `${scaleKey}\n` },
            });
            else if (count === 2) complete(response, "Running bounded source-local verification and output.", {
              id: `${scaleKey}-check`, name: "bash", args: {
                command: sustained ? sustainedCommand(scaleKey) : `printf '%s\\n' "$$" > six-running.pid; deadline=$((SECONDS+45)); i=0; while [[ ! -e .six-agent-release && $SECONDS -lt $deadline ]]; do printf '%s output %s\\n' ${scaleKey} "$i"; ((i+=1)); sleep 0.1; done; test -e .six-agent-release && test "$(cat six-result.txt)" = ${scaleKey}`,
              },
            });
            else complete(response, "Source-local work verified by the preceding command.");
          } else if (body.includes("verify-agent-write-e2e")) {
            sourceWriteCalls++;
            if (sourceWriteCalls === 1) complete(response, "Changing the requested primary source file.", {
              id: "verify-primary-write", name: "write_file", args: { path: "greeting.ts", content: 'export const greeting = "agent tool mutation";\n' },
            });
            else complete(response, "The requested file was written. No verification command was run.");
          } else if (body.includes("candidate-simple-write-e2e")) {
            candidateCalls++;
            if (candidateCalls === 1) complete(response, "Writing only in the candidate.", { id: "candidate-write", name: "write_file", args: { path: "candidate-only.txt", content: "independent candidate\n" } });
            else complete(response, "Candidate file written. No verification command was run.");
          } else if (body.includes("candidate-independent-write-e2e")) {
            candidateCalls++;
            candidateResults = (JSON.parse(body).input as Array<{ type?: string }>).filter((item) => item.type === "function_call_output");
            if (candidateCalls === 1) complete(response, "Writing only in the candidate.", { id: "candidate-write", name: "write_file", args: { path: "candidate-only.txt", content: "independent candidate\n" } });
            else if (candidateCalls === 2) complete(response, "Checking the primary write boundary.", { id: "primary-write", name: "bash", args: { command: `printf 'must not reach primary\\n' > ${JSON.stringify(primaryPath)}` } });
            else {
              complete(response, "Candidate file written. Primary write refused. No verification command was run.");
            }
          } else if (body.includes("keep-primary-working-e2e")) {
            response.flushHeaders();
            primaryResponse = response;
          } else complete(response, "Source context recorded. No changes made.");
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
    const env = {
      TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol",
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`,
      OPENAI_API_KEY: "synthetic-loopback-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    };
    for (const [key, value] of Object.entries(env)) { previous.set(key, process.env[key]); process.env[key] = value; }
  });
  test.beforeEach(() => { primaryResponse = null; candidateCalls = 0; primaryPath = ""; candidateResults = []; sourceWriteCalls = 0; sustained = false; scaleCalls.clear(); });
  test.afterEach(() => releaseModels());
  test.afterAll(async () => {
    try {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  test("an independent area remains usable before its first prompt", async ({ page, projectRoot, electronApp }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const owner = (await page.evaluate(() => window.termina.getInstances())).find((i) => i.type === "agent")!;
    expect((await page.evaluate((id) => window.termina.createTerminal({ projectId: id }), owner.projectId!)).ok).toBe(true);
    const candidate = (await page.evaluate((id) => window.termina.getWorldlines(id), owner.projectId!))[0]!;
    expect(candidate.state).toBe("ready");
    writeFileSync(join(candidate.root, "before-first-prompt.txt"), "saved before a prompt\n");
    await mockLifecycleDialogs(electronApp, 0);
    expect((await page.evaluate((id) => window.termina.projectClose(id), owner.projectId!)).ok).toBe(true);
    await page.evaluate((path) => window.termina.projectOpenPath(path), projectRoot);
    const reopened = (await page.evaluate(() => window.termina.projectList())).find((p) => p.active)!;
    const restored = (await page.evaluate((id) => window.termina.getWorldlines(id), reopened.id))[0]!;
    expect(restored.state, restored.error ?? "").toBe("ready");
    const preview = await page.evaluate((id) => window.termina.promoteWorldline(id, "A"), restored.comparisonId);
    expect(preview.confirm).toContain("no evidence");
    const promoted = await page.evaluate((id) => window.termina.promoteWorldline(id, "A", true), restored.comparisonId);
    expect(promoted.ok, promoted.error ?? promoted.confirm).toBe(true);
    expect(readFileSync(join(projectRoot, "before-first-prompt.txt"), "utf8")).toBe("saved before a prompt\n");
  });

  test("new terminals run concurrently in automatic isolated areas and survive project reopen", async ({ page, runRoot, projectRoot, electronApp }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const owner = (await page.evaluate(() => window.termina.getInstances())).find((i) => i.type === "agent")!;
    await expect.poll(() => records(join(runRoot, "events", `${owner.id}.jsonl`)).some((r) => r.t === "session_ready" && r.ok)).toBe(true);
    expect(await page.evaluate((id) => window.termina.getRuns(id), owner.id)).toEqual([]);
    const created = await page.evaluate(async (projectId) => Promise.all([
      window.termina.createTerminal({ projectId }), window.termina.createTerminal({ projectId }),
    ]), owner.projectId!);
    expect(created.every((r) => r.ok && r.id)).toBe(true);
    const candidates = await page.evaluate((id) => window.termina.getWorldlines(id), owner.projectId!);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.role === "session" && c.sourceRunId === null && c.state === "ready")).toBe(true);
    expect(new Set(candidates.map((c) => c.root)).size).toBe(2);
    await page.evaluate((id) => window.termina.writeTerminal(id, "keep-primary-working-e2e\r"), owner.id);
    await expect.poll(() => primaryResponse !== null).toBe(true);
    for (let index = 0; index < candidates.length; index++) {
      await page.evaluate(({ id, index }) => window.termina.writeTerminal(id, `attention-six-run-candidate-${index}\r`), { id: candidates[index]!.terminalId!, index });
    }
    for (const candidate of candidates) await expect.poll(() => existsSync(join(candidate.root, "six-running.pid"))).toBe(true);
    expect(existsSync(join(projectRoot, "six-result.txt"))).toBe(false);
    const running = await page.evaluate(() => window.termina.getInstances());
    expect(running.filter((i) => [owner.id, ...created.map((r) => r.id)].includes(i.id) && i.busy)).toHaveLength(3);
    for (const candidate of candidates) writeFileSync(join(candidate.root, ".six-agent-release"), "release\n");
    complete(primaryResponse!, "Primary run complete.");
    primaryResponse = null;
    await expect.poll(async () => (await page.evaluate(() => window.termina.getInstances())).filter((i) => i.busy).length).toBe(0);
    // /clear affects conversation, not another session's durable source tree.
    await page.evaluate((id) => window.termina.writeTerminal(id, "/clear\r"), owner.id);
    for (const candidate of candidates) expect(existsSync(join(candidate.root, "six-result.txt"))).toBe(true);
    await mockLifecycleDialogs(electronApp, 0);
    const closed = await page.evaluate((id) => window.termina.projectClose(id), owner.projectId!);
    expect(closed.ok, JSON.stringify({ closed, dialogs: await lifecycleDialogs(electronApp) })).toBe(true);
    expect(JSON.stringify(await lifecycleDialogs(electronApp))).not.toContain("Their work areas and activity will be discarded");
    for (const candidate of candidates) expect(existsSync(candidate.root)).toBe(true);
    await page.evaluate((path) => window.termina.projectOpenPath(path), projectRoot);
    const reopened = (await page.evaluate(() => window.termina.projectList())).find((p) => p.active)!;
    const restored = await page.evaluate((id) => window.termina.getWorldlines(id), reopened.id);
    expect(restored.filter((c) => c.role === "session")).toHaveLength(2);
    for (const candidate of restored) {
      expect(candidate.state, candidate.error ?? "").toBe("ready");
      expect(candidate.sourceRunId).toBeNull();
      expect(existsSync(join(candidate.root, "six-result.txt"))).toBe(true);
    }
    const preview = await page.evaluate((id) => window.termina.promoteWorldline(id, "A"), restored[0]!.comparisonId);
    expect(preview.confirm).toContain("no evidence");
    const promoted = await page.evaluate((id) => window.termina.promoteWorldline(id, "A", true), restored[0]!.comparisonId);
    expect(promoted.ok, promoted.error).toBe(true);
    expect(readFileSync(join(projectRoot, "six-result.txt"), "utf8")).toMatch(/attention-six-run-candidate-[01]/);
    expect(existsSync(restored[1]!.root)).toBe(true);
  });

  test("confirms both result-based candidates before reporting successful admission", async ({ page, runRoot }) => {
    const { ownerId, projectId } = await sourceMoment(page, runRoot);
    const run = (await page.evaluate((id) => window.termina.getRuns(id), ownerId)).at(-1)!;
    expect(run.replayable).toBe(true);
    expect(run.promptParentEntryId).toBe("0");
    await page.locator("#activity-tab-timeline").click();
    const control = page.locator("#btn-fork-run");
    await expect(control).toBeEnabled();
    holdModels = true;
    try {
      await control.click();
      await expect(control).toHaveText("Preparing…");
      await expect(control).toBeDisabled();
      await expect(control).toHaveAttribute("aria-busy", "true");
      await expect.poll(() => pendingModels.length).toBeGreaterThan(0);
      const cards = page.locator("#worldline-list .candidate-card");
      await expect(cards).toHaveCount(2);
      await expect(cards.locator(".cand-state")).toHaveText(["creating", "creating"]);
      const pending = await page.evaluate((id) => window.termina.getWorldlines(id), projectId);
      expect(pending).toHaveLength(2);
      expect(pending.every((candidate) => candidate.state === "creating")).toBe(true);
    } finally {
      releaseModels();
    }
    await expect.poll(async () => (await page.evaluate((id) => window.termina.getWorldlines(id), projectId)).filter((candidate) => candidate.state === "ready").length).toBe(2);
    await expect(control).toHaveText("Fork Run");
    await expect(control).toBeEnabled();
    await expect(control).toHaveAttribute("aria-busy", "false");
    const candidates = await page.evaluate((id) => window.termina.getWorldlines(id), projectId);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((item) => item.state)).toEqual(["ready", "ready"]);
    expect(candidates[0]!.root).not.toBe(candidates[1]!.root);
    for (const candidate of candidates) {
      const sidecar = join(dirname(candidate.root), `${candidate.label}-support`, "events", `${candidate.terminalId}.jsonl`);
      expect(records(sidecar).some((record) => record.t === "session_ready" && record.ok === true)).toBe(true);
    }
    const replay = candidates.find((item) => item.label === "B")!;
    const replaySidecar = join(dirname(replay.root), "B-support", "events", `${replay.terminalId}.jsonl`);
    // A text-only fork prefills an editable task, never automatically starts it.
    expect(records(replaySidecar).some((record) => record.t === "agent_start")).toBe(false);
    await page.evaluate((id) => window.termina.writeTerminal(id, "\r"), replay.terminalId!);
    await expect.poll(() => records(replaySidecar).some((record) => record.t === "checkpoint_result" && record.ok === true)).toBe(true);
  });

  test("runs and checkpoints candidate-only work while the primary stays working, without promotion", async ({ page, runRoot, projectRoot }) => {
    const { ownerId, projectId, moment } = await sourceMoment(page, runRoot);
    const original = readFileSync(join(projectRoot, "greeting.ts"), "utf8");
    await page.evaluate((id) => window.termina.writeTerminal(id, "keep-primary-working-e2e\r"), ownerId);
    await expect.poll(() => primaryResponse !== null).toBe(true);
    const candidate = await fork(page, ownerId, projectId, moment);
    const summary = await page.evaluate((id) => window.termina.getProjectWorkSummary(id), projectId);
    const work = summary!.terminals.find((terminal) => terminal.terminalId === candidate.terminalId)!;
    expect(work.workArea).toMatchObject({ kind: "candidate", root: candidate.root, comparisonId: candidate.comparisonId });
    await page.evaluate((id) => window.termina.writeTerminal(id, "candidate-simple-write-e2e\r"), candidate.terminalId!);
    const file = join(candidate.root, "candidate-only.txt");
    await expect.poll(() => existsSync(file) && readFileSync(file, "utf8")).toBe("independent candidate\n");
    const sidecar = join(dirname(candidate.root), "A-support", "events", `${candidate.terminalId}.jsonl`);
    await expect.poll(() => records(sidecar).some((record) => record.t === "checkpoint_result" && record.ok === true)).toBe(true);
    expect(records(sidecar).some((record) => record.t === "agent_start")).toBe(true);
    expect(existsSync(join(projectRoot, "candidate-only.txt"))).toBe(false);
    expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).toBe(original);
    const instances = await page.evaluate(() => window.termina.getInstances());
    expect(instances.find((instance) => instance.id === ownerId)?.busy).toBe(true);
    expect(instances.find((instance) => instance.id === candidate.terminalId)?.workspaceId).not.toBe(instances.find((instance) => instance.id === ownerId)?.workspaceId);
    const candidates = await page.evaluate((id) => window.termina.getWorldlines(id), projectId);
    expect(candidates.find((item) => item.comparisonId === candidate.comparisonId)?.state).not.toBe("promoted");
  });

  test("opening another project preserves an already admitted candidate in the shared worlds root", async ({ page, runRoot, projectRoot }) => {
    const first = await sourceMoment(page, runRoot);
    const original = await fork(page, first.ownerId, first.projectId, first.moment);
    const root = join(runRoot, "other-project", basename(projectRoot));
    mkdirSync(dirname(root), { recursive: true });
    execFileSync("git", ["clone", "-q", "--no-hardlinks", projectRoot, root]);
    await page.evaluate((root) => window.termina.projectOpenPath(root), root);
    const project = (await page.evaluate(() => window.termina.projectList())).find((entry) => entry.active)!;
    const second = await sourceMoment(page, runRoot, project.id);
    const candidate = await fork(page, second.ownerId, second.projectId, second.moment);
    expect(candidate.root).not.toBe(original.root);
    expect(candidate.comparisonId).not.toBe(original.comparisonId);
    expect(existsSync(original.root)).toBe(true);
    const retained = await page.evaluate((id) => window.termina.getWorldlines(id), first.projectId);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ state: "ready", terminalId: original.terminalId, root: original.root });
    expect((await page.evaluate(() => window.termina.getInstances())).some((instance) => instance.id === original.terminalId)).toBe(true);
    expect(await page.evaluate(({ comparisonId, label }) => window.termina.openWorldlineTerminal(comparisonId, label), original)).toMatchObject({ ok: true, terminalId: original.terminalId });
  });

  for (const sustainedWork of [false, true]) {
    test(sustainedWork ? "measures sustained descendant-inclusive memory and navigation with six admitted live agents" : "runs six agents in three primary and three admitted candidate trees with globally inspectable stale checks", async ({ page, runRoot, projectRoot, electronApp }, testInfo) => {
      if (sustainedWork) test.setTimeout(180_000);
      sustained = sustainedWork;
      await expect(page.locator("#splash")).toBeHidden();
      const originalGreeting = readFileSync(join(projectRoot, "greeting.ts"), "utf8");
      const contexts: Array<{ projectId: string; ownerId: string; root: string; candidate: WorldlineSummary }> = [];
      for (let index = 0; index < 3; index++) {
        const root = index === 0 ? projectRoot : join(runRoot, `six-${index}`, basename(projectRoot));
        if (index !== 0) {
          mkdirSync(dirname(root), { recursive: true });
          execFileSync("git", ["clone", "-q", "--no-hardlinks", projectRoot, root]);
        }
        writeFileSync(join(root, ".gitignore"), "/stages.jsonl\n/node_modules/\n/six-running.pid\n/six-child.pid\n/.six-agent-release\n");
        await writeVerifyPackage(root, { test: "termina-verify-fixture fail" });
        if (index !== 0) expect(await page.evaluate((root) => window.termina.projectOpenPath(root), root)).toMatchObject({ cwd: root });
        const project = (await page.evaluate(() => window.termina.projectList())).find((entry) => entry.active)!;
        const owner = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.type === "agent" && instance.projectId === project.id)!;
        expect(await page.evaluate((id) => window.termina.runVerify(id), owner.id)).toEqual({ ok: true });
        await expect.poll(async () => (await page.evaluate(() => window.termina.getWorkOverview())).items.some((item) => item.projectId === project.id && item.reason === "verify-failed")).toBe(true);
        const source = await sourceMoment(page, runRoot, project.id);
        const candidate = await fork(page, source.ownerId, project.id, source.moment);
        contexts.push({ projectId: project.id, ownerId: owner.id, root, candidate });
      }
      const work = contexts.flatMap((context, index) => [
        { id: context.ownerId, root: context.root, key: `attention-six-run-primary-${index}`, sidecar: join(runRoot, "events", `${context.ownerId}.jsonl`) },
        { id: context.candidate.terminalId!, root: context.candidate.root, key: `attention-six-run-candidate-${index}`, sidecar: join(dirname(context.candidate.root), "A-support", "events", `${context.candidate.terminalId}.jsonl`) },
      ]);
      const release = () => {
        for (const job of work) if (existsSync(job.root)) writeFileSync(join(job.root, ".six-agent-release"), "release\n");
      };
      const cdp = sustainedWork ? await page.context().newCDPSession(page) : null;
      const samples: Array<{
        phase: string; ts: number; owned: ReturnType<typeof sampleOwnedProcessMemory>;
        main: NodeJS.MemoryUsage; rendererHeapBytes: number; outputChars: number;
      }> = [];
      const navigationMs: number[] = [];
      const descendants = new Map<number, string>();
      const sample = async (phase: string) => {
        if (!cdp) return;
        const { metrics } = await cdp.send("Performance.getMetrics");
        const heap = metrics.find((metric: { name: string }) => metric.name === "JSHeapUsedSize");
        expect(heap).toBeTruthy();
        const owned = sampleOwnedProcessMemory(electronApp);
        samples.push({ phase, ts: Date.now(), owned, main: await electronApp.evaluate(() => process.memoryUsage()),
          rendererHeapBytes: heap!.value, outputChars: await page.evaluate(() => (window as unknown as { __sixOutputChars: number }).__sixOutputChars) });
        return owned;
      };
      if (cdp) {
        await cdp.send("Performance.enable");
        await page.evaluate(() => {
          const state = window as unknown as { __sixOutputChars: number; __sixOutputOff: () => void };
          state.__sixOutputChars = 0;
          state.__sixOutputOff = window.termina.onPtyData(({ data }) => { state.__sixOutputChars += data.length; });
        });
      }
      try {
        await sample("before-tools");
        const checkpoints = work.map((job) => records(job.sidecar).filter((record) => record.t === "checkpoint_result" && record.ok === true).length);
        expect(new Set(work.map((job) => job.root)).size).toBe(6);
        await Promise.all(work.map((job) => page.evaluate(({ id, key }) => window.termina.writeTerminal(id, `${key}\r`), job)));
        const primaries = work.filter((job) => contexts.some((context) => context.ownerId === job.id));
        await expect.poll(() => primaries.every((job) => records(job.sidecar).some((record) => record.t === "tool" && record.toolName === "bash" && record.toolCallId === `${job.key}-check`))).toBe(true);
        // Ordinary agents keep ask mode: choose Approve once in each real TUI picker.
        await Promise.all(primaries.map((job) => page.evaluate((id) => window.termina.writeTerminal(id, "\u001b[B\r"), job.id)));
        try {
          await expect.poll(() => work.every((job) => existsSync(join(job.root, "six-running.pid")))).toBe(true);
        } catch (error) {
          const diagnostic = work.map((job) => ({ ...job, calls: scaleCalls.get(job.key), written: existsSync(join(job.root, "six-result.txt")), running: existsSync(join(job.root, "six-running.pid")), records: records(job.sidecar).slice(-8) }));
          await testInfo.attach("six-agent-startup", { body: JSON.stringify(diagnostic), contentType: "application/json" });
          throw error;
        }
        const pids = work.map((job) => Number(readFileSync(join(job.root, "six-running.pid"), "utf8")));
        expect(new Set(pids).size).toBe(6);
        for (const pid of pids) {
          expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
          expect(() => process.kill(pid, 0)).not.toThrow(); // Existence probe only; no process is stopped.
        }
        await expect.poll(async () => (await page.evaluate(() => window.termina.getInstances())).filter((instance) => instance.type === "agent" && instance.busy).length).toBe(6);
        if (cdp) {
          await expect.poll(() => work.every((job) => existsSync(join(job.root, "six-child.pid")))).toBe(true);
          for (const pid of [...pids, ...work.map((job) => Number(readFileSync(join(job.root, "six-child.pid"), "utf8")))]) {
            const identity = readSystemProcessIdentity(pid);
            expect(identity).not.toBeNull();
            descendants.set(pid, identity!);
          }
          expect(descendants.size).toBe(12);
          const live = (await sample("all-tools-live"))!;
          for (const [pid, identity] of descendants) expect(live.processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid, identity })]));
        }
        await expect.poll(async () => (await page.evaluate(() => window.termina.getWorkOverview())).items.filter((item) => item.reason === "verify-stale").length).toBe(3);
        const overview = await page.evaluate(() => window.termina.getWorkOverview());
        expect(overview.projects).toHaveLength(3);
        expect(overview.projects.map((project) => project.working)).toEqual([2, 2, 2]);
        expect(overview.items).toHaveLength(3);
        for (const context of contexts) {
          const summary = await page.evaluate((id) => window.termina.getProjectWorkSummary(id), context.projectId);
          expect(summary!.terminals.map((terminal) => terminal.workArea?.kind).sort()).toEqual(["candidate", "project"]);
          expect(new Set(summary!.terminals.map((terminal) => terminal.workArea?.workspaceId)).size).toBe(2);
        }
        const selected = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
        expect(selected.id).toBe(contexts[2]!.projectId);
        await page.locator("#btn-attention").click();
        await expect(page.locator("#attention-list .attention-item")).toHaveCount(3);
        for (const context of contexts) {
          const item = page.locator(`#attention-list .attention-item[data-project-id="${context.projectId}"]`);
          await expect(item).toContainText(context.root);
          await expect(item).toContainText(context.ownerId);
          await expect(item).toContainText("Verify is outdated");
        }
        // Inspect one background owner through the real view, without opening the other five terminals.
        await page.locator(`#attention-list .attention-item[data-project-id="${contexts[0]!.projectId}"] .attention-inspect`).click();
        await expect(page.locator("#attention-view")).toBeHidden();
        await expect(page.locator(".work-summary-report")).toContainText("**Status:** ⚠️ OUTDATED");
        expect((await page.evaluate(() => window.termina.projectList())).find((project) => project.active)?.id).toBe(contexts[0]!.projectId);
        expect((await page.evaluate(() => window.termina.getInstances())).filter((instance) => instance.type === "agent" && instance.busy)).toHaveLength(6);
        await testInfo.attach("six-running-agents", { body: JSON.stringify({ overview, work, pids, instances: await page.evaluate(() => window.termina.getInstances()) }, null, 2), contentType: "application/json" });
        if (cdp) {
          for (let cycle = 0; cycle < 36; cycle++) {
            const context = contexts[cycle % contexts.length]!;
            const started = Date.now();
            await page.locator(`#project-tabs .project-tab[data-project-id="${context.projectId}"] .project-select`).click();
            await page.locator("#btn-attention").click();
            await expect(page.locator("#attention-list .attention-item")).toHaveCount(3);
            await page.locator(`#attention-list .attention-item[data-project-id="${context.projectId}"] .attention-inspect`).click();
            await expect(page.locator(".work-summary-report")).toContainText("**Status:** ⚠️ OUTDATED");
            navigationMs.push(Date.now() - started);
            expect((await page.evaluate(() => window.termina.getInstances())).filter((instance) => instance.busy)).toHaveLength(6);
            const snapshot = (await sample(`live-${cycle}`))!;
            for (const [pid, identity] of descendants) expect(snapshot.processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid, identity })]));
            expect(await page.evaluate(() => ({ attentionRows: document.querySelectorAll("#attention-list .attention-item").length,
              mountedPanes: document.querySelectorAll(".term-pane").length, visiblePanes: [...document.querySelectorAll(".term-pane")].filter((element) => getComputedStyle(element).visibility === "visible").length })))
              .toEqual({ attentionRows: 3, mountedPanes: 6, visiblePanes: 1 });
            await delay(1_000);
          }
          expect(samples.at(-1)!.outputChars - samples[0]!.outputChars).toBeGreaterThan(32_768);
          const p95 = [...navigationMs].sort((a, b) => a - b)[Math.floor(navigationMs.length * 0.95)]!;
          // Keep the same navigation budget as the existing Phase 5 idle profile.
          expect(p95).toBeLessThan(750);
        }
        // Release only after overlap/inspection is proven. Missing release at the
        // bounded command deadline fails the command, never produces false success.
        release();
        await expect.poll(() => work.every((job) => records(job.sidecar).some((record) => record.t === "tool_end" && record.toolCallId === `${job.key}-check` && record.isError === false)), { timeout: 30_000 }).toBe(true);
        await expect.poll(() => work.every((job, index) => records(job.sidecar).filter((record) => record.t === "checkpoint_result" && record.ok === true).length > checkpoints[index]!)).toBe(true);
        expect(primaries.every((job) => !records(job.sidecar).some((record) => record.t === "agent_settings" && record.permissions === "always"))).toBe(true);
        await expect.poll(async () => (await page.evaluate(() => window.termina.getInstances())).every((instance) => !instance.busy)).toBe(true);
        for (const job of work) {
          expect(readFileSync(join(job.root, "six-result.txt"), "utf8")).toBe(`${job.key}\n`);
          expect(scaleCalls.get(job.key)).toBe(3);
        }
        if (cdp) {
          await expect.poll(() => [...descendants].every(([pid, identity]) => readSystemProcessIdentity(pid) !== identity)).toBe(true);
          await sample("after-tools");
          await cdp.send("HeapProfiler.collectGarbage");
          await sample("after-renderer-gc");
          const summary = { samples: samples.length, liveSamples: samples.filter((entry) => entry.phase.startsWith("live-")).length,
            liveDurationMs: samples.find((entry) => entry.phase === "after-tools")!.ts - samples.find((entry) => entry.phase === "all-tools-live")!.ts,
            peakOwnedRssKiB: Math.max(...samples.map((entry) => entry.owned.totalRssKiB)), peakRendererHeapBytes: Math.max(...samples.map((entry) => entry.rendererHeapBytes)),
            p95NavigationMs: [...navigationMs].sort((a, b) => a - b)[Math.floor(navigationMs.length * 0.95)] };
          console.log("six-agent sustained memory", JSON.stringify(summary));
          await testInfo.attach("six-agent-sustained-memory", { body: JSON.stringify({ note: "RSS sums include shared pages per process; this is a bounded workload, not a leak-free soak certification.", summary, descendants: [...descendants], navigationMs, samples }, null, 2), contentType: "application/json" });
        }
        for (const context of contexts) {
          expect(readFileSync(join(context.root, "greeting.ts"), "utf8")).toBe(originalGreeting);
          expect(readFileSync(join(context.candidate.root, "greeting.ts"), "utf8")).toBe(originalGreeting);
          expect((await page.evaluate((id) => window.termina.getWorldlines(id), context.projectId)).every((candidate) => candidate.state !== "promoted")).toBe(true);
        }
      } finally {
        release();
        if (cdp) {
          await page.evaluate(() => {
            const state = window as unknown as { __sixOutputChars?: number; __sixOutputOff?: () => void };
            state.__sixOutputOff?.();
            delete state.__sixOutputOff;
            delete state.__sixOutputChars;
          });
          await cdp.detach();
        }
      }
    });
  }

  test("a real agent write invalidates passing Verify without replacing its historical execution", async ({ page, runRoot, projectRoot }) => {
    const { ownerId, projectId } = await sourceMoment(page, runRoot);
    writeFileSync(join(projectRoot, ".gitignore"), "/stages.jsonl\n/node_modules/\n");
    await writeVerifyPackage(projectRoot, { test: "termina-verify-fixture agent-write-check" });
    expect(await page.evaluate((id) => window.termina.runVerify(id), ownerId)).toEqual({ ok: true });
    await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)?.verify?.state), ownerId)).toBe("pass");
    const previous = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === ownerId)!.verify!;
    const sidecar = join(runRoot, "events", `${ownerId}.jsonl`);
    const checkpoints = records(sidecar).filter((record) => record.t === "checkpoint_result" && record.ok === true).length;
    await page.evaluate((id) => window.termina.writeTerminal(id, "verify-agent-write-e2e\r"), ownerId);
    await expect.poll(() => records(sidecar).some((record) => record.t === "tool_end" && record.toolCallId === "verify-primary-write" && record.isError === false)).toBe(true);
    await expect.poll(() => records(sidecar).filter((record) => record.t === "checkpoint_result" && record.ok === true).length).toBeGreaterThan(checkpoints);
    expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).toBe('export const greeting = "agent tool mutation";\n');
    await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)?.verify?.state), ownerId)).toBe("stale");
    const stale = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.id === ownerId)!.verify!;
    expect(stale.source).toEqual(previous.source);
    expect(stale.result).toEqual(previous.result);
    const item = (await page.evaluate(() => window.termina.getWorkOverview())).items.find((item) => item.projectId === projectId && item.reason === "verify-stale")!;
    expect(item).toMatchObject({ terminalId: ownerId, action: { kind: "evidence", terminalId: ownerId } });
    await page.locator("#btn-attention").click();
    await page.locator(`#attention-list .attention-item[data-id="${item.id}"] .attention-inspect`).click();
    await expect(page.locator(".work-summary-report")).toContainText("**Status:** ⚠️ OUTDATED");
    await expect(page.locator(".work-summary-report")).toContainText("**Historical execution:** ✅ PASSED (exit code 0)");
    await expect(page.locator(".work-summary-report")).not.toContainText("**Status:** ✅ PASSED");
    expect(await readVerifyStages(projectRoot)).toHaveLength(1);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map((item) => item.id)).toContain(item.id);
    expect(sourceWriteCalls).toBe(2);
  });

  test("shows a real reopen failure and retries the retained candidate with a new confirmed terminal", async ({ page, runRoot }) => {
    const { ownerId, projectId, moment } = await sourceMoment(page, runRoot);
    const candidate = await fork(page, ownerId, projectId, moment);
    const instance = (await page.evaluate(() => window.termina.getInstances())).find((item) => item.id === candidate.terminalId)!;
    expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), instance)).toMatchObject({ ok: true });
    await expect.poll(async () => (await page.evaluate(() => window.termina.getInstances())).some((item) => item.id === candidate.terminalId)).toBe(false);
    await expect.poll(async () => (await page.evaluate((id) => window.termina.getWorldlines(id), projectId))[0]?.state).toBe("settled");
    await page.locator("#activity-tab-worldlines").click();
    const card = page.locator("#worldline-list .candidate-card");
    const open = card.locator(".cand-open");
    holdModels = true;
    try {
      await expect(open).toBeEnabled();
      await open.click();
      await expect.poll(() => pendingModels.length).toBeGreaterThan(0);
      await expect(card.locator(".cand-state")).toHaveText("creating");
      await expect(open).toBeDisabled();
      const reopening = (await page.evaluate((id) => window.termina.getWorldlines(id), projectId))[0];
      expect(reopening.terminalId).not.toBe(candidate.terminalId);
      const reopeningInstance = (await page.evaluate(() => window.termina.getInstances())).find((item) => item.id === reopening.terminalId)!;
      // Interrupt exactly this fixture's reopened terminal before confirmation.
      // The real exit must fail admission without corrupting the retained session.
      expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), reopeningInstance)).toMatchObject({ ok: true });
      await expect(card.locator(".cand-state")).toHaveText("error");
      await expect(page.locator(".toast-warning")).toBeVisible();
      await expect(open).toBeEnabled();
      const failed = (await page.evaluate((id) => window.termina.getWorldlines(id), projectId))[0];
      expect(failed.terminalId).toBeNull();
      expect(failed.sessionFile).toBe(candidate.sessionFile);
      expect(failed.error).toMatch(/exited before/);
      await expect(card).toHaveAttribute("title", `error: ${failed.error}`);
    } finally {
      releaseModels();
    }
    await open.click();
    await expect(card.locator(".cand-state")).toHaveText("ready");
    const retried = (await page.evaluate((id) => window.termina.getWorldlines(id), projectId))[0];
    expect(retried.terminalId).not.toBe(candidate.terminalId);
    expect(retried.terminalId).toBeTruthy();
    expect(retried.sessionFile).toBe(candidate.sessionFile);
    expect(retried.error).toBeNull();
    const eventsDir = join(dirname(candidate.root), "A-support", "events");
    const oldReady = records(join(eventsDir, `${candidate.terminalId}.jsonl`)).find((record) => record.t === "session_ready" && record.ok === true)!;
    const newReady = records(join(eventsDir, `${retried.terminalId}.jsonl`)).find((record) => record.t === "session_ready" && record.ok === true)!;
    expect(newReady.opId).toBeTruthy();
    expect(newReady.opId).not.toBe(oldReady.opId);
  });

  test("admits separate work without stopping the primary and denies writes back to it", async ({ page, runRoot, projectRoot }) => {
    const { ownerId, projectId, moment } = await sourceMoment(page, runRoot);
    primaryPath = join(projectRoot, "greeting.ts");
    const original = readFileSync(primaryPath, "utf8");
    await page.evaluate((id) => window.termina.writeTerminal(id, "keep-primary-working-e2e\r"), ownerId);
    await expect.poll(() => primaryResponse !== null).toBe(true);
    const candidate = await fork(page, ownerId, projectId, moment);
    expect(candidate.root).not.toBe(projectRoot);
    const summary = await page.evaluate((id) => window.termina.getProjectWorkSummary(id), projectId);
    const work = summary!.terminals.find((terminal) => terminal.terminalId === candidate.terminalId)!;
    expect(work.workArea).toMatchObject({ kind: "candidate", root: candidate.root, comparisonId: candidate.comparisonId });
    const opened = await page.evaluate(({ comparisonId, label }) => window.termina.openWorldlineTerminal(comparisonId, label), candidate);
    expect(opened).toMatchObject({ ok: true, terminalId: candidate.terminalId });
    await page.evaluate((id) => window.termina.writeTerminal(id, "candidate-independent-write-e2e\r"), candidate.terminalId!);
    const file = join(candidate.root, "candidate-only.txt");
    try {
      await expect.poll(() => existsSync(file) && readFileSync(file, "utf8")).toBe("independent candidate\n");
    } catch (error) {
      const sidecar = join(dirname(candidate.root), "A-support", "events", `${candidate.terminalId}.jsonl`);
      await test.info().attach("candidate-startup", { body: JSON.stringify({ candidateCalls, candidateResults, candidate, records: records(sidecar), instances: await page.evaluate(() => window.termina.getInstances()) }), contentType: "application/json" });
      throw error;
    }
    await expect.poll(() => candidateCalls).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(candidateResults)).toMatch(/EACCES|EPERM|[Oo]peration not permitted|[Pp]ermission denied/);
    expect(existsSync(join(projectRoot, "candidate-only.txt"))).toBe(false);
    expect(readFileSync(primaryPath, "utf8")).toBe(original);
    const instances = await page.evaluate(() => window.termina.getInstances());
    expect(instances.find((instance) => instance.id === ownerId)?.busy).toBe(true);
    expect(instances.find((instance) => instance.id === candidate.terminalId)?.workspaceId).not.toBe(instances.find((instance) => instance.id === ownerId)?.workspaceId);
    const sidecar = join(dirname(candidate.root), "A-support", "events", `${candidate.terminalId}.jsonl`);
    expect(records(sidecar).some((record) => record.t === "agent_start")).toBe(true);
    await expect.poll(() => records(sidecar).some((record) => record.t === "checkpoint_result" && record.ok === true)).toBe(true);
    const candidates = await page.evaluate((id) => window.termina.getWorldlines(id), projectId);
    expect(candidates.find((item) => item.comparisonId === candidate.comparisonId)?.state).not.toBe("promoted");
  });

  test("unsupported platform capabilities refuse a fork honestly and permit explicit retry after restoration", async ({ page, runRoot, electronApp, projectRoot }) => {
    const { ownerId, projectId } = await sourceMoment(page, runRoot);
    const greeting = readFileSync(join(projectRoot, "greeting.ts"), "utf8");
    await page.locator("#activity-tab-timeline").click();
    const control = page.locator("#btn-fork-run");
    await expect(control).toBeEnabled();
    const descriptor = await electronApp.evaluate(() => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...original, value: "linux" });
      return original;
    });
    try {
      // Only the isolated main process's capability input changes. Canonical
      // preflight, IPC, source and verdict production remain unmodified.
      await control.click();
      await expect(page.locator(".toast-warning")).toContainText("the platform has no sandbox-exec");
      await expect(page.locator(".toast-warning")).toContainText("the platform has no reliable recursive watcher");
      expect(await page.evaluate((id) => window.termina.getWorldlines(id), projectId)).toEqual([]);
      expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).toBe(greeting);
      expect((await page.evaluate((id) => window.termina.getRuns(id), ownerId)).at(-1)?.replayable).toBe(true);
      await expect(control).toBeEnabled();
    } finally {
      await electronApp.evaluate((_electron, descriptor) => { Object.defineProperty(process, "platform", descriptor); }, descriptor);
    }
    await control.click();
    await expect.poll(async () => (await page.evaluate((id) => window.termina.getWorldlines(id), projectId)).filter((candidate) => candidate.state === "ready").length).toBe(2);
    expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).toBe(greeting);
  });

  test("rejects changed trust resources before creation and allows an explicit retry", async ({ page, runRoot, projectRoot }) => {
    const { projectId, moment } = await sourceMoment(page, runRoot);
    const resource = join(projectRoot, ".agents", "skills", "admission-fixture", "SKILL.md");
    mkdirSync(dirname(resource), { recursive: true });
    writeFileSync(resource, "---\nname: admission-fixture\ndescription: Local candidate admission fixture\n---\nUse only the isolated test project.\n");
    await page.locator("#activity-tab-timeline").click();
    const point = page.locator(`#timeline-dots .timeline-dot[data-seq="${moment.seq}"]`);
    await expect(point).toBeVisible();
    await point.click({ modifiers: ["Meta"] });
    await expect(page.locator(".toast-warning").filter({ hasText: "trust-sensitive resources changed since the run" })).toBeVisible();
    expect(await page.evaluate((id) => window.termina.getWorldlines(id), projectId)).toEqual([]);
    // A new source run establishes a new baseline. Do not remove or bypass the changed instructions.
    const retry = await sourceMoment(page, runRoot);
    await page.locator("#activity-tab-timeline").click();
    await page.locator(`#timeline-dots .timeline-dot[data-seq="${retry.moment.seq}"]`).click({ modifiers: ["Meta"] });
    await expect.poll(async () => (await page.evaluate((id) => window.termina.getWorldlines(id), projectId)).filter((candidate) => candidate.state === "ready").length).toBe(1);
    await expect(page.locator("#worldline-list .candidate-card")).toHaveCount(1);
    await expect(page.locator("#worldline-list .cand-state")).toHaveText("ready");
  });
});
