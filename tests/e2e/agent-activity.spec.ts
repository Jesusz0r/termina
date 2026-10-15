import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

/**
 * Roster + timeline activity from the live sidecar tail (issue #291).
 * Same producer-bound append path as plan-board.spec.ts.
 */

function liveSidecarStream(file: string): { bridgeId: string; seq: number; producerPid: number } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let latest: { bridgeId: string; seq: number; producerPid: number } | null = null;
  for (const line of text.split("\n")) {
    const rec = parseSidecarRecord(line);
    if (!rec) continue;
    const bridgeId = rec.bridgeId;
    const seq = rec.seq;
    const producerPid = rec.producerPid;
    if (typeof bridgeId !== "string" || bridgeId.length === 0) continue;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) continue;
    if (typeof producerPid !== "number" || !Number.isSafeInteger(producerPid) || producerPid < 1) continue;
    latest = { bridgeId, seq, producerPid };
  }
  return latest;
}

async function waitForLiveSidecarStream(file: string): Promise<{ bridgeId: string; seq: number; producerPid: number }> {
  let previous: { bridgeId: string; seq: number; producerPid: number } | null = null;
  await expect.poll(() => {
    const stream = liveSidecarStream(file);
    if (!stream) {
      previous = null;
      return null;
    }
    if (
      previous
      && previous.bridgeId === stream.bridgeId
      && previous.seq === stream.seq
      && previous.producerPid === stream.producerPid
    ) {
      return stream;
    }
    previous = stream;
    return null;
  }, { timeout: 15_000 }).toBeTruthy();
  const stream = liveSidecarStream(file);
  if (!stream) throw new Error(`sidecar stream disappeared: ${file}`);
  return stream;
}

async function appendSidecarRecord(sidecarFile: string, record: Record<string, unknown>): Promise<void> {
  const stream = await waitForLiveSidecarStream(sidecarFile);
  appendFileSync(
    sidecarFile,
    JSON.stringify({ bridgeId: stream.bridgeId, seq: stream.seq + 1, producerPid: stream.producerPid, ...record }) + "\n",
  );
}

async function activeInstanceId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const panes = w.__panes as Map<string, { instanceId: string; error: boolean; exited: boolean }>;
    const pane = [...panes.values()].find((p) => !p.error && !p.exited) ?? [...panes.values()][0]!;
    return pane.instanceId;
  });
}

test.describe("agent activity roster and timeline (issue #291)", () => {
  test("projects an exact human picker and original age, replaces it without focus jumps, and clears only its answer", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const instanceId = await activeInstanceId(page);
    const sidecarFile = join(runRoot, "events", `${instanceId}.jsonl`);
    const status = page.locator("#status-state");
    const activeTab = page.locator(".terminal-tab.active");
    const tabIndex = await activeTab.evaluate((tab) => [...tab.parentElement!.children].indexOf(tab));
    const readIntervention = () => page.evaluate(async (id) => {
      const overview = await window.termina.getWorkOverview();
      return overview.projects.flatMap((project) => project.terminals).find((terminal) => terminal.terminalId === id)?.activity?.intervention;
    }, instanceId);
    const intervention = { requestId: "approval-e2e-1", kind: "permission", since: Date.now() - 60_000 };
    await appendSidecarRecord(sidecarFile, { t: "agent_start" });
    await appendSidecarRecord(sidecarFile, { t: "intervention_requested", ...intervention });
    await expect(status).toContainText("waiting for permission", { timeout: 15_000 });
    await expect.poll(readIntervention).toEqual(intervention);
    await expect(page.locator("#timeline-prefix")).toContainText("waiting for permission");
    await appendSidecarRecord(sidecarFile, { t: "intervention_requested", ...intervention, since: Date.now() });
    await expect.poll(readIntervention).toEqual(intervention);
    const replacement = { ...intervention, requestId: "approval-e2e-2", since: intervention.since + 10_000 };
    await appendSidecarRecord(sidecarFile, { t: "intervention_requested", ...replacement });
    await expect.poll(readIntervention).toEqual(replacement);
    expect(await activeTab.evaluate((tab) => [...tab.parentElement!.children].indexOf(tab))).toBe(tabIndex);
    await expect(page.locator("#attention-view")).toBeVisible();
    await appendSidecarRecord(sidecarFile, { t: "intervention_resolved", requestId: intervention.requestId });
    await expect.poll(readIntervention).toEqual(replacement);
    await appendSidecarRecord(sidecarFile, { t: "intervention_resolved", requestId: replacement.requestId });
    await expect.poll(readIntervention).toBeNull();
    await expect(status).toContainText("agent working");
    await appendSidecarRecord(sidecarFile, { t: "agent_settled" });
    await expect(status).toHaveText("idle");
  });

  test("roster badge and timeline header follow start, error-loop, and settle", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const instanceId = await activeInstanceId(page);
    const eventsDir = join(runRoot, "events");
    mkdirSync(eventsDir, { recursive: true });
    const sidecarFile = join(eventsDir, `${instanceId}.jsonl`);
    const status = page.locator("#status-state");
    const tabDot = page.locator(".terminal-tab .tab-status").first();
    const projectWorking = page.locator(".project-tab .project-working").first();
    const projectAttention = page.locator(".project-tab .project-attention").first();
    const prefix = page.locator("#timeline-prefix");

    await appendSidecarRecord(sidecarFile, { t: "agent_start" });
    await expect(status).toContainText("agent working", { timeout: 15_000 });
    await expect(tabDot).toHaveClass(/busy/);
    await expect(projectWorking).toHaveText("1 working");
    await expect(projectAttention).toHaveText("0 attention");
    await expect(prefix).toContainText("working");

    for (let i = 0; i < 3; i++) {
      await appendSidecarRecord(sidecarFile, { t: "tool_end", toolCallId: "loop", isError: true });
    }
    await expect(status).toContainText("blocked: tool-error-loop", { timeout: 15_000 });
    await expect(tabDot).toHaveClass(/blocked/);
    await expect(projectWorking).toHaveText("0 working");
    await expect(projectAttention).toHaveText("1 attention");
    await expect(prefix).toContainText("blocked: tool-error-loop");

    await appendSidecarRecord(sidecarFile, { t: "agent_settled" });
    await expect(status).toHaveText("idle", { timeout: 15_000 });
    await expect(tabDot).toHaveClass(/idle/);
    await expect(tabDot).not.toHaveClass(/blocked/);
    await expect(tabDot).not.toHaveClass(/busy/);
    await expect(projectWorking).toHaveText("0 working");
    await expect(projectAttention).toHaveText("0 attention");
  });

  test("named toast names the project and dismisses on jump", async ({ page, runRoot, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    });

    const instanceId = await activeInstanceId(page);
    const eventsDir = join(runRoot, "events");
    mkdirSync(eventsDir, { recursive: true });
    const sidecarFile = join(eventsDir, `${instanceId}.jsonl`);
    const tabDot = page.locator(".terminal-tab .tab-status").first();

    await appendSidecarRecord(sidecarFile, { t: "agent_start" });
    await expect(tabDot).toHaveClass(/busy/, { timeout: 15_000 });

    await appendSidecarRecord(sidecarFile, { t: "agent_settled" });
    const toast = page.getByRole("button", { name: `${basename(projectRoot)} is idle` });
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await toast.click();
    await expect(toast).toHaveCount(0);
    await expect(page.locator(".terminal-tab.active")).toBeVisible();
  });

  test("named toast fires when a background project's agent settles", async ({ page, runRoot, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const instanceId = await activeInstanceId(page);
    const eventsDir = join(runRoot, "events");
    mkdirSync(eventsDir, { recursive: true });
    const sidecarFile = join(eventsDir, `${instanceId}.jsonl`);
    const other = join(runRoot, "other-project");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "readme.txt"), "other\n");
    await page.evaluate((dir) => window.termina.projectOpenPath(dir), other);
    const otherTab = page.locator(".project-tab").filter({ hasText: "other-project" });
    await expect(otherTab).toHaveClass(/active/, { timeout: 15_000 });

    await appendSidecarRecord(sidecarFile, { t: "agent_start" });
    const backgroundWorking = page.locator(".project-tab").filter({ hasText: basename(projectRoot) }).locator(".project-working");
    await expect(backgroundWorking).toHaveText("1 working", { timeout: 15_000 });
    await expect(otherTab).toHaveClass(/active/);

    await appendSidecarRecord(sidecarFile, { t: "agent_settled" });
    await expect(page.getByRole("button", { name: `${basename(projectRoot)} is idle` })).toBeVisible({ timeout: 15_000 });
    await expect(backgroundWorking).toHaveText("0 working");
    await expect(otherTab).toHaveClass(/active/);
  });

  test("project entry opens the oldest permission, explicit tabs override it, and resolved permissions restore recency", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const firstId = await activeInstanceId(page);
    const first = await page.evaluate(async (id) => (await window.termina.getInstances()).find((instance) => instance.id === id)!, firstId);
    expect(first.type).toBe("agent");
    const projectId = first.projectId!;
    const created = await page.evaluate((projectId) => window.termina.createTerminal({ type: "agent", projectId }), projectId);
    expect(created.ok).toBe(true); const secondId = created.id!;
    const sidecarFiles = new Map([
      [firstId, join(runRoot, "events", `${firstId}.jsonl`)],
      [secondId, join(runRoot, "events", `${secondId}.jsonl`)],
    ]);
    type PaneWindow = Window & { __panes: Map<string, { tabEl: HTMLElement; container: HTMLElement }> };
    const selected = () => page.evaluate(() => [...(window as unknown as PaneWindow).__panes.entries()].find(([, pane]) => pane.tabEl.classList.contains("active"))?.[0]);
    const clickTab = async (id: string) => {
      await expect.poll(() => page.evaluate((id) => (window as unknown as PaneWindow).__panes.has(id), id)).toBe(true);
      await page.evaluate((id) => (window as unknown as PaneWindow).__panes.get(id)!.tabEl.click(), id);
      await expect.poll(selected).toBe(id);
    };
    await clickTab(firstId);
    await page.locator(".term-pane.active .xterm-helper-textarea").focus();
    const requests = () => page.evaluate(async (projectId) => (await window.termina.getWorkOverview()).projects
      .find((project) => project.projectId === projectId)!.terminals.map((terminal) => terminal.activity?.intervention?.requestId ?? null), projectId);
    const since = Date.now() - 60_000;
    for (const [id, requestId, age] of [[firstId, "entry-recent", since + 30_000], [secondId, "entry-oldest", since]] as const) {
      const file = sidecarFiles.get(id)!;
      await appendSidecarRecord(file, { t: "agent_start" });
      await appendSidecarRecord(file, { t: "intervention_requested", requestId, kind: "permission", since: age });
    }
    await expect.poll(requests).toEqual(["entry-recent", "entry-oldest"]);
    expect(await selected()).toBe(firstId);
    expect(await page.evaluate((id) => (window as unknown as PaneWindow).__panes.get(id)!.container.contains(document.activeElement), firstId)).toBe(true);
    await expect(page.locator("#project-bar #attention-view")).toBeVisible();
    await expect(page.locator("#attention-heading")).toContainText("Attention");
    await page.locator(`#project-tabs .project-tab[data-project-id="${projectId}"] .project-select`).click();
    await expect(page.locator("#attention-view")).toBeVisible();
    await expect.poll(selected).toBe(secondId);
    await clickTab(firstId);
    for (const [id, requestId] of [[firstId, "entry-recent"], [secondId, "entry-oldest"]] as const) {
      const file = sidecarFiles.get(id)!;
      await appendSidecarRecord(file, { t: "intervention_resolved", requestId });
      await appendSidecarRecord(file, { t: "agent_settled" });
    }
    await expect.poll(requests).toEqual([null, null]);
    const other = join(runRoot, "entry-other-project"); mkdirSync(other, { recursive: true });
    await page.evaluate((dir) => window.termina.projectOpenPath(dir), other);
    await expect(page.locator(".project-tab.active")).toContainText("entry-other-project");
    await page.locator(`#project-tabs .project-tab[data-project-id="${projectId}"] .project-select`).click();
    await expect.poll(selected).toBe(firstId);
    expect(await page.evaluate(async (projectId) => (await window.termina.getInstances())
      .filter((instance) => instance.projectId === projectId).map((instance) => instance.id), projectId)).toEqual([firstId, secondId]);
  });
});
