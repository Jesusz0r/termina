import { test, expect } from "./fixtures.ts";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

let server: Server;
const previous = new Map<string, string | undefined>();

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
    } else response.writeHead(404).end();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing loopback port"));
      resolve(address.port);
    });
  });
  for (const [key, value] of Object.entries({
    TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol",
    TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`,
    OPENAI_API_KEY: "synthetic-new-agent-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  })) {
    previous.set(key, process.env[key]); process.env[key] = value;
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

function records(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").map(parseSidecarRecord).filter(Boolean) : [];
}

async function newSession(page: Page, projectId: string, previousIds: string[]) {
  await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((instances) => instances.length))).toBe(previousIds.length + 1);
  const instances = await page.evaluate(() => window.termina.getInstances());
  const created = instances.find((instance) => !previousIds.includes(instance.id))!;
  expect(created).toMatchObject({ projectId, type: "agent", busy: false });
  await expect.poll(() => page.evaluate(({ projectId, id }) => window.termina.getWorldlines(projectId)
    .then((entries) => entries.find((entry) => entry.terminalId === id)?.state), { projectId, id: created.id })).toBe("ready");
  const candidate = (await page.evaluate((projectId) => window.termina.getWorldlines(projectId), projectId)).find((entry) => entry.terminalId === created.id)!;
  expect(candidate).toMatchObject({ role: "session", state: "ready", root: created.cwd });
  const sidecar = join(dirname(candidate.root), `${candidate.label}-support`, "events", `${created.id}.jsonl`);
  await expect.poll(() => records(sidecar).some((record) => record?.t === "session_ready" && record.ok)).toBe(true);
  expect(records(sidecar).some((record) => record?.t === "agent_start")).toBe(false);
  await expect.poll(() => page.evaluate((id) => {
    const panes = (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes;
    return panes.get(id)?.tabEl.classList.contains("active");
  }, created.id)).toBe(true);
  await expect(page.locator(".terminal-menu")).toHaveCount(0);
  return { created, candidate };
}

for (const zoom of [1, 2]) {
  test(`creates agents in one action and opens a usable shell by keyboard at ${zoom * 100} percent zoom`, async ({ page, electronApp, runRoot, projectRoot }, testInfo) => {
    await expect(page.locator("#splash")).toBeHidden();
    await electronApp.evaluate(({ BrowserWindow }, factor) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setSize(1000, 720); window.webContents.setZoomFactor(factor);
    }, zoom);
    const project = (await page.evaluate(() => window.termina.projectList())).find((entry) => entry.active)!;
    const original = await page.evaluate(() => window.termina.getInstances());
    await expect.poll(() => records(join(runRoot, "events", `${original[0]!.id}.jsonl`)).some((record) => record?.t === "session_ready" && record.ok)).toBe(true);
    const source = readFileSync(join(projectRoot, "hello.txt"), "utf8");
    const agent = page.getByRole("button", { name: "New agent", exact: true });
    await expect(agent).toBeInViewport(); await agent.click();
    const first = await newSession(page, project.id, original.map((entry) => entry.id));
    expect(first.created.cwd).not.toBe(project.cwd);
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe(source);
    // The same command/shortcut creates directly with persistent Attention visible.
    await expect(page.locator("#project-bar #attention-view")).toBeVisible();
    await expect(page.locator("#attention-heading")).toContainText("Attention");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+t" : "Control+t");
    await expect(page.locator("#attention-view")).toBeVisible();
    const second = await newSession(page, project.id, [...original.map((entry) => entry.id), first.created.id]);
    expect(second.candidate.comparisonId).not.toBe(first.candidate.comparisonId);
    const ids = (await page.evaluate(() => window.termina.getInstances())).map((entry) => entry.id);
    const shellMenu = page.getByRole("button", { name: "Open shell menu", exact: true });
    await expect(shellMenu).toBeInViewport(); await shellMenu.focus(); await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Open shell", exact: true });
    await expect(menu).toBeVisible();
    const shells = await page.evaluate(() => window.termina.getShells());
    await expect(menu.getByRole("menuitem")).toHaveCount(shells.length);
    expect(shells.length).toBeGreaterThan(0);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden(); await expect(shellMenu).toBeFocused();
    expect((await page.evaluate(() => window.termina.getInstances())).map((entry) => entry.id)).toEqual(ids);
    await page.keyboard.press("Enter"); await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    await page.keyboard.press("End"); await expect(menu.getByRole("menuitem").last()).toBeFocused();
    await page.keyboard.press("Home"); await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Enter"); await expect(menu).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((instances) => instances.length))).toBe(ids.length + 1);
    const shell = (await page.evaluate(() => window.termina.getInstances())).find((entry) => !ids.includes(entry.id))!;
    expect(shell).toMatchObject({ type: "shell", projectId: project.id });
    expect(realpathSync(shell.cwd!)).toBe(realpathSync(project.cwd));
    const marker = join(projectRoot, "new-agent-shell-marker.txt");
    await page.evaluate(({ id, text }) => window.termina.writeTerminal(id, text), { id: shell.id, text: "printf '%s\\n' 'shell menu works' > new-agent-shell-marker.txt\r" });
    await expect.poll(() => existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("shell menu works\n");
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe(source);
    expect(records(join(runRoot, "events", `${original[0]!.id}.jsonl`)).some((record) => record?.t === "agent_start")).toBe(false);
    await testInfo.attach(`new-agent-${zoom * 100}-percent`, { body: await page.screenshot(), contentType: "image/png" });
  });
}

test("direct creation admits a fourth independent session without replacing existing terminals or starting a run", async ({ page, electronApp, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const project = (await page.evaluate(() => window.termina.projectList())).find((entry) => entry.active)!;
  const source = readFileSync(join(projectRoot, "hello.txt"), "utf8");
  let instances = await page.evaluate(() => window.termina.getInstances());
  const ownerId = instances[0]!.id;
  for (let index = 0; index < 3; index++) {
    if (index < 2) await page.getByRole("button", { name: "New agent", exact: true }).click();
    else await electronApp.evaluate(({ Menu, BrowserWindow }) => {
      const terminal = Menu.getApplicationMenu()?.items.find((item) => item.label === "Terminal");
      const action = terminal?.submenu?.items.find((item) => item.label === "New agent");
      if (!action) throw new Error("Missing native New agent action");
      action.click(undefined, BrowserWindow.getAllWindows()[0], {});
    });
    await newSession(page, project.id, instances.map((entry) => entry.id));
    instances = await page.evaluate(() => window.termina.getInstances());
  }
  const identities = instances.map(({ id, generation, cwd, type }) => ({ id, generation, cwd, type }));
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  const fourth = await newSession(page, project.id, instances.map((entry) => entry.id));
  await expect(page.getByRole("button", { name: "New agent", exact: true })).toBeEnabled();
  const retained = (await page.evaluate(() => window.termina.getInstances())).filter((entry) => entry.id !== fourth.created.id);
  expect(retained.map(({ id, generation, cwd, type }) => ({ id, generation, cwd, type }))).toEqual(identities);
  await expect(page.locator(".toast-warning")).toHaveCount(0);
  await expect(page.locator(".terminal-menu")).toHaveCount(0);
  await expect(page.locator(".terminal-tab")).toHaveCount(instances.length + 1);
  const sessions = (await page.evaluate((id) => window.termina.getWorldlines(id), project.id)).filter((entry) => entry.role === "session");
  expect(sessions).toHaveLength(4);
  const roots = sessions.map((entry) => realpathSync(entry.root));
  expect(new Set(roots).size).toBe(4);
  expect(roots).not.toContain(realpathSync(project.cwd));
  for (const session of sessions) expect(session).toMatchObject({ state: "ready", error: null });
  expect(readFileSync(join(projectRoot, "hello.txt"), "utf8")).toBe(source);
  expect(records(join(runRoot, "events", `${ownerId}.jsonl`)).some((record) => record?.t === "agent_start")).toBe(false);
});
