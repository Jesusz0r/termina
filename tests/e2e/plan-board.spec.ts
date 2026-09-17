import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSidecarRecord } from "../../electron/sidecar.ts";

/**
 * Plan Board UI & Task Lifecycle E2E.
 *
 * Drives the production path: plan sidecar records are appended to the live
 * terminal's sidecar file (the same real-path approach as review.spec.ts —
 * no provider needed), main parses them and pushes plan:update, and the
 * renderer owner renders. Nothing is injected into the DOM.
 */

/** Last producer-bound sidecar envelope on disk. */
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

/**
 * Wait until the live agent has bound a sidecar stream and that envelope
 * is stable across two polls (same stability rule as review.spec.ts).
 */
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

/** Append one record to the live producer stream (re-reads the head first). */
async function appendSidecarRecord(sidecarFile: string, record: Record<string, unknown>): Promise<void> {
  const stream = await waitForLiveSidecarStream(sidecarFile);
  appendFileSync(
    sidecarFile,
    JSON.stringify({ bridgeId: stream.bridgeId, seq: stream.seq + 1, producerPid: stream.producerPid, ...record }) + "\n",
  );
}

/** The active pane's terminal id (same seam as review.spec.ts). */
async function activeInstanceId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const panes = w.__panes as Map<string, { instanceId: string; error: boolean; exited: boolean }>;
    const pane = [...panes.values()].find((p) => !p.error && !p.exited) ?? [...panes.values()][0]!;
    return pane.instanceId;
  });
}

test.describe("Plan Board UI & Task Lifecycle E2E", () => {
  test("renders plan panel and updates tasks dynamically", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const instanceId = await activeInstanceId(page);
    const eventsDir = join(runRoot, "events");
    mkdirSync(eventsDir, { recursive: true });
    const sidecarFile = join(eventsDir, `${instanceId}.jsonl`);

    // A plan message only applies while the terminal is busy: open the run first.
    await appendSidecarRecord(sidecarFile, { t: "agent_start" });
    await expect(page.locator("#status-state")).toContainText("agent working", { timeout: 15_000 });

    // 1. Seed a valid plan through the sidecar boundary. Main parses it and
    //    pushes plan:update; the production renderer owner renders the rows.
    await appendSidecarRecord(sidecarFile, {
      t: "plan",
      text: "Plan:\n- [ ] Create utils.ts with an add function\n- [x] Edit greeting.ts so greeting is hi there\n",
    });
    await page.locator(".activity-tab[data-tab='plan']").click();
    const planList = page.locator("#plan-list");
    const tasks = planList.locator(".plan-task");
    await expect(tasks).toHaveCount(2, { timeout: 15_000 });

    // Production row shape: state class, plan-mark glyph, and plan text.
    const first = tasks.first();
    const last = tasks.last();
    await expect(first.locator(".plan-text")).toHaveText("Create utils.ts with an add function");
    await expect(last.locator(".plan-text")).toHaveText("Edit greeting.ts so greeting is hi there");
    await expect(first).toHaveClass(/state-pending/);
    await expect(last).toHaveClass(/state-done/);
    await expect(first.locator(".plan-mark")).toHaveText("○");
    await expect(last.locator(".plan-mark")).toHaveText("✓");
    await expect(first.locator(".plan-model")).toHaveCount(1);
    await expect(last.locator(".plan-model")).toHaveCount(0);
    // Only the pending row offers the dispatch action.
    await expect(first).toHaveClass(/dispatchable/);
    await expect(last).not.toHaveClass(/dispatchable/);

    // 2. A subsequent plan push updates the production rows in place.
    await appendSidecarRecord(sidecarFile, {
      t: "plan",
      text: "Plan:\n- [x] Create utils.ts with an add function\n- [x] Edit greeting.ts so greeting is hi there\n- [ ] Write tests for the add function\n",
    });
    await expect(tasks).toHaveCount(3, { timeout: 15_000 });
    await expect(tasks.first()).toHaveClass(/state-done/);
    await expect(tasks.first().locator(".plan-mark")).toHaveText("✓");
    await expect(tasks.last().locator(".plan-text")).toHaveText("Write tests for the add function");
    await expect(tasks.last()).toHaveClass(/dispatchable/);
    await expect(tasks.last().locator(".plan-model")).toHaveCount(1);

    // 3. The task action: dispatching the pending row runs the production
    //    dispatch IPC, and main spawns a worker terminal for the task. (The
    //    preload bridge is immutable from the page, so the outbound call is
    //    asserted by its real effect: the dispatch worker tab.)
    test.setTimeout(180_000);
    await tasks.last().locator(".plan-text").click();
    const dispatchTab = page.locator(".terminal-tab .tab-name", { hasText: "dispatch" });
    await expect(dispatchTab).toBeVisible({ timeout: 60_000 });

    // Clicking a done row dispatches nothing: still exactly one worker tab
    // after the click settles (negative assertion).
    await tasks.first().click();
    await page.waitForTimeout(1_000);
    await expect(page.locator(".terminal-tab .tab-name", { hasText: "dispatch" })).toHaveCount(1);
  });
});
