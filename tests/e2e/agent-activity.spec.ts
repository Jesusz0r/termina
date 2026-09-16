import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  test("roster badge and timeline header follow start, error-loop, and settle", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const instanceId = await activeInstanceId(page);
    const eventsDir = join(runRoot, "events");
    mkdirSync(eventsDir, { recursive: true });
    const sidecarFile = join(eventsDir, `${instanceId}.jsonl`);
    const status = page.locator("#status-state");
    const tabDot = page.locator(".terminal-tab .tab-status").first();
    const projectDot = page.locator(".project-tab .tab-status").first();
    const prefix = page.locator("#timeline-prefix");

    await appendSidecarRecord(sidecarFile, { t: "agent_start" });
    await expect(status).toContainText("agent working", { timeout: 15_000 });
    await expect(tabDot).toHaveClass(/busy/);
    await expect(projectDot).toHaveClass(/busy/);
    await expect(prefix).toContainText("working");

    for (let i = 0; i < 3; i++) {
      await appendSidecarRecord(sidecarFile, { t: "tool_end", toolCallId: "loop", isError: true });
    }
    await expect(status).toContainText("blocked: tool-error-loop", { timeout: 15_000 });
    await expect(tabDot).toHaveClass(/blocked/);
    await expect(projectDot).toHaveClass(/blocked/);
    await expect(prefix).toContainText("blocked: tool-error-loop");

    await appendSidecarRecord(sidecarFile, { t: "agent_settled" });
    await expect(status).toHaveText("idle", { timeout: 15_000 });
    await expect(tabDot).toHaveClass(/idle/);
    await expect(tabDot).not.toHaveClass(/blocked/);
    await expect(tabDot).not.toHaveClass(/busy/);
    await expect(projectDot).toHaveClass(/idle/);
    await expect(projectDot).not.toHaveClass(/busy/);
    await expect(projectDot).not.toHaveClass(/blocked/);
  });
});
