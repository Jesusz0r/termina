import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";

const THINKING = "Inspect the fixture before changing its greeting.";
const DRAFT = "keep this unsent composer draft";
const ENV_KEYS = [
  "TERMINA_CORE_TEST", "TERMINA_CORE_PROVIDER", "TERMINA_CORE_MODEL",
  "TERMINA_TEST_MODELS_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL",
] as const;

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = [...(window as any).__panes.values()][0]?.view.getTerminal();
    if (!term) throw new Error("missing fixture terminal");
    const buffer = term.buffer.active;
    return Array.from({ length: term.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n");
  });
}

async function terminalPoint(page: Page, text: string): Promise<{ x: number; y: number; cellWidth: number }> {
  await expect.poll(() => terminalText(page)).toContain(text);
  return page.evaluate((needle) => {
    const term = [...(window as any).__panes.values()][0]?.view.getTerminal();
    const screen = term?.element?.querySelector(".xterm-screen");
    if (!term || !screen) throw new Error("missing terminal screen");
    const rect = screen.getBoundingClientRect();
    const buffer = term.buffer.active;
    for (let row = 0; row < term.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      const text = line?.translateToString(true) ?? "";
      const start = text.indexOf(needle);
      if (start < 0) continue;
      // Locate the actual cell rather than assuming UTF-16 offsets are columns.
      let offset = 0;
      for (let col = 0; col < term.cols; col++) {
        const cell = line.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        if (offset >= start) return {
          x: rect.x + (col + 0.5) * rect.width / term.cols,
          y: rect.y + (row + 0.5) * rect.height / term.rows,
          cellWidth: rect.width / term.cols,
        };
        offset += (cell.getChars() || " ").length;
      }
    }
    throw new Error(`terminal text is not visible: ${needle}`);
  }, text);
}

async function clickTerminalText(page: Page, text: string): Promise<void> {
  const point = await terminalPoint(page, text);
  // Enter the target cell afresh: xterm 6 clears hover on resize but only
  // resolves it again when the pointer crosses a cell boundary.
  await page.mouse.move(point.x + point.cellWidth, point.y);
  await page.mouse.move(point.x, point.y);
  // xterm resolves OSC 8 and file-link hover ranges asynchronously.
  await page.waitForTimeout(100);
  await page.mouse.click(point.x, point.y);
}

async function startTask(page: Page): Promise<void> {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await expect.poll(() => terminalText(page)).toContain("Type a task");
  await page.bringToFront();
  await page.locator("#terminal-container .xterm-helper-textarea").focus();
  await page.keyboard.insertText("/permissions always");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("permissions always");
  await page.keyboard.insertText("Read greeting.ts, edit its greeting, and verify it.");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain(THINKING);
  await expect.poll(() => terminalText(page)).toContain("▾ Thinking");
}

function sendEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function complete(response: ServerResponse, output: unknown[] = []): void {
  for (const item of output) sendEvent(response, { type: "response.output_item.done", item });
  sendEvent(response, { type: "response.completed", response: { status: "completed", output, usage: {} } });
  response.end();
}

function tool(name: string, input: Record<string, unknown>): unknown {
  return { type: "function_call", id: `item-${name}`, call_id: `call-${name}`, name, arguments: JSON.stringify(input) };
}

test.describe("clickable Core transcript folds", () => {
  let server: Server;
  let calls = 0;
  let releaseThinking: (() => void) | undefined;
  const previousEnv = new Map<string, string | undefined>();

  test.beforeAll(async () => {
    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        switch (calls++) {
          case 0:
            sendEvent(response, { type: "response.reasoning_summary_text.delta", item_id: "reasoning-fixture", delta: THINKING });
            releaseThinking = () => complete(response, [tool("read_file", { path: "greeting.ts" })]);
            break;
          case 1:
            complete(response, [tool("edit", { path: "greeting.ts", old_text: '"hello"', new_text: '"folded-edit-value"' })]);
            break;
          case 2:
            complete(response, [tool("bash", { command: "cat greeting.ts" })]);
            break;
          default:
            sendEvent(response, { type: "response.output_text.delta", delta: "Verified. See greeting.ts:1:1" });
            complete(response);
        }
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("provider did not bind a TCP port"));
        resolve(address.port);
      });
    });
    Object.assign(process.env, {
      TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol",
      TERMINA_TEST_MODELS_URL: `http://127.0.0.1:${port}/v1/models`,
      OPENAI_API_KEY: "e2e-loopback-token", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    });
  });

  test.beforeEach(() => { calls = 0; releaseThinking = undefined; });

  test.afterAll(async () => {
    try {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  async function finishTask(page: Page, runRoot: string): Promise<void> {
    expect(releaseThinking).toBeDefined();
    releaseThinking!();
    releaseThinking = undefined;
    await expect.poll(() => {
      try { return readFileSync(join(runRoot, "events", "term-1.jsonl"), "utf8"); }
      catch { return ""; }
    }, { timeout: 30_000 }).toContain('"t":"agent_settled"');
    await expect.poll(() => terminalText(page)).toContain("Verified. See greeting.ts:1:1");
    expect(calls).toBe(4);
  }

  test("settles collapsed, toggles each entry by real click, and preserves draft and file navigation", async ({ page, runRoot, projectRoot, closeElectron }) => {
    try {
      await startTask(page);
      await finishTask(page, runRoot);
      expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).toBe('export const greeting = "folded-edit-value";\n');
      await expect.poll(() => terminalText(page)).toContain("▸ Thinking");
      for (const name of ["read_file", "edit", "bash"]) {
        await expect.poll(() => terminalText(page)).toContain(`▸ ◆ ${name}`);
      }
      expect(await terminalText(page)).not.toContain(THINKING);
      expect(await terminalText(page)).not.toContain('export const greeting = "hello";');
      expect(await terminalText(page)).not.toContain("ok: edited greeting.ts");
      await page.keyboard.insertText(DRAFT);
      await expect.poll(() => terminalText(page)).toContain(DRAFT);

      await clickTerminalText(page, "▸ Thinking");
      await expect.poll(() => terminalText(page)).toContain(THINKING);
      await clickTerminalText(page, "▾ Thinking");
      await expect.poll(() => terminalText(page)).not.toContain(THINKING);

      await clickTerminalText(page, "▸ ◆ read_file");
      await expect.poll(() => terminalText(page)).toContain('export const greeting = "hello";');
      await clickTerminalText(page, "▸ ◆ edit");
      await expect.poll(() => terminalText(page)).toContain("ok: edited greeting.ts");
      expect(await terminalText(page)).toContain("▾ ◆ read_file");
      expect(await terminalText(page)).toContain("▸ ◆ bash");
      await clickTerminalText(page, "▾ ◆ read_file");
      await expect.poll(() => terminalText(page)).not.toContain('export const greeting = "hello";');
      expect(await terminalText(page)).toContain("▾ ◆ edit");
      expect(await terminalText(page)).toContain('"hello"');
      expect(await terminalText(page)).toContain('"folded-edit-value"');
      await clickTerminalText(page, "▾ ◆ edit");
      await expect.poll(() => terminalText(page)).not.toContain("ok: edited greeting.ts");
      expect(await terminalText(page)).not.toContain('"folded-edit-value"');
      expect(await terminalText(page)).toContain(DRAFT);

      const point = await terminalPoint(page, "▸ ◆ edit");
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(100);
      await page.mouse.down();
      await page.mouse.move(point.x + point.cellWidth * 10, point.y, { steps: 10 });
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => [...(window as any).__panes.values()][0].view.getTerminal().getSelection())).toContain("edit");
      expect(await terminalText(page)).toContain("▸ ◆ edit");
      expect(await terminalText(page)).not.toContain("ok: edited greeting.ts");

      // Clear selection via the existing xterm API, not by clicking a fold.
      await page.evaluate(() => [...(window as any).__panes.values()][0].view.getTerminal().clearSelection());
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.down(modifier);
      try {
        await clickTerminalText(page, "▸ ◆ edit");
        expect(await terminalText(page)).toContain("▸ ◆ edit");
        await clickTerminalText(page, "greeting.ts  done");
        await expect(page.locator(".editor-tab").getByText("greeting.ts").first()).toBeVisible();
        await clickTerminalText(page, "greeting.ts:1:1");
      } finally {
        await page.keyboard.up(modifier);
      }
      await expect(page.locator(".editor-tab").getByText("greeting.ts").first()).toBeVisible();
      await page.locator("#terminal-container .xterm-helper-textarea").focus();
      await page.keyboard.insertText("!");
      await expect.poll(() => terminalText(page)).toContain(`${DRAFT}!`);
      expect(await terminalText(page)).toContain("▸ ◆ edit");
      expect(await terminalText(page)).not.toContain("ok: edited greeting.ts");
      expect(calls).toBe(4); // No click submitted the draft as another task.
    } finally {
      releaseThinking?.();
      releaseThinking = undefined;
      await closeElectron();
    }
  });

  test("thinking explicitly reopened while live remains open after settling", async ({ page, runRoot, closeElectron }) => {
    try {
      await startTask(page);
      await clickTerminalText(page, "▾ Thinking");
      await expect.poll(() => terminalText(page)).not.toContain(THINKING);
      await clickTerminalText(page, "▸ Thinking");
      await expect.poll(() => terminalText(page)).toContain(THINKING);
      await finishTask(page, runRoot);
      await expect.poll(() => terminalText(page)).toContain("▾ Thinking");
      expect(await terminalText(page)).toContain(THINKING);
      await clickTerminalText(page, "▾ Thinking");
      await expect.poll(() => terminalText(page)).not.toContain(THINKING);
    } finally {
      releaseThinking?.();
      releaseThinking = undefined;
      await closeElectron();
    }
  });
});
