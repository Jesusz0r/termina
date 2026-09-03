import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { readTraceDirectory, summarizeTraces } from "../unit/agent-core/trace-report.ts";

const TURNS = 10;
const LIVE_MODEL = process.env.TERMINA_LIVE_CACHE_MODEL ?? "anthropic/claude-sonnet-5";
// Claude Sonnet 5 requires at least 1,024 input tokens before a prompt prefix
// is cacheable. Put this stable prefix in turn one so every later turn retains it.
const CACHE_WARMING_PREFIX = "x ".repeat(1_300).trim();
const ENV_KEYS = [
  "TERMINA_CORE_TEST",
  "TERMINA_CORE_PROVIDER",
  "TERMINA_CORE_MODEL",
  "TERMINA_TEST_MODELS_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

test.use({ terminalEngine: "core" });

function traceDir(runRoot: string): string {
  return join(runRoot, "events", "term-1.traces");
}

async function waitForSettledTurns(root: string, count: number): Promise<void> {
  await expect.poll(() => {
    try {
      return readTraceDirectory(traceDir(root)).records.filter((record) => record.recordType === "task-settled").length;
    } catch {
      return 0;
    }
  }, { timeout: 30_000, intervals: [50, 100, 250] }).toBe(count);
}

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pane = [...(window as any).__panes.values()][0];
    const buffer = pane?.view.getTerminal()?.buffer.active;
    if (!buffer) return "<no terminal buffer>";
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    return lines.join("\n");
  });
}

async function focusTerminal(page: Page): Promise<void> {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const terminal = page.locator("#terminal-container");
  await expect(terminal).toBeVisible();
  await page.waitForFunction(() => {
    const pane = [...(window as any).__panes.values()][0];
    const buffer = pane?.view.getTerminal()?.buffer.active;
    if (!buffer) return false;
    for (let index = 0; index < buffer.length; index++) {
      if (buffer.getLine(index)?.translateToString(true).includes("Type a task")) return true;
    }
    return false;
  });
  await terminal.click();
}

async function selectModelThroughTerminalUi(page: Page, target: string): Promise<string> {
  await focusTerminal(page);
  // The first submission selects a loaded row or loads authenticated catalogs;
  // retry so an asynchronously loaded catalog can provide the exact picker row.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.insertText(`/models ${target}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_000);
    const selected = [...(await terminalText(page)).matchAll(/(?:^|\n)model ([a-z0-9_-]+\/[^\s]+)/gi)].at(-1)?.[1];
    if (selected === target) return selected;
  }
  throw new Error(`terminal model picker did not find ${target}:\n${await terminalText(page)}`);
}

async function submitTurns(page: Page, runRoot: string): Promise<void> {
  await focusTerminal(page);

  for (let turn = 1; turn <= TURNS; turn++) {
    const cacheWarmup = turn === 1 ? `Stable cache fixture; ignore this repeated text:\n${CACHE_WARMING_PREFIX}\n\n` : "";
    await page.keyboard.insertText(`${cacheWarmup}Turn ${turn}: reply with exactly OK. Do not use tools or modify any files.`);
    await page.keyboard.press("Enter");
    await waitForSettledTurns(runRoot, turn);
    const source = readTraceDirectory(traceDir(runRoot));
    const report = summarizeTraces(source.records, `cache-e2e-turn-${turn}`);
    if (report.tasks.failed > 0) {
      throw new Error(`provider failed on turn ${turn}:\n${await terminalText(page)}`);
    }
  }
}

function projectContents(projectRoot: string): Record<string, string> {
  const contents: Record<string, string> = {};
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === ".git") continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        contents[`${relativePath}/`] = "directory";
        visit(absolutePath, relativePath);
      } else if (entry.isSymbolicLink()) {
        contents[relativePath] = `symlink:${readlinkSync(absolutePath)}`;
      } else {
        contents[relativePath] = `file:${readFileSync(absolutePath).toString("base64")}`;
      }
    }
  };
  visit(projectRoot);
  return contents;
}

function assertCleanTrace(report: any, sourceErrors: unknown[]): void {
  expect(sourceErrors).toEqual([]);
  expect(report.diagnostics).toMatchObject({
    omittedRecords: 0,
    writeFailures: 0,
    malformedRecords: 0,
    partialRecords: 0,
    retentionFailures: 0,
    manifestWriteFailures: 0,
    readerOmittedRecords: 0,
    manifestErrors: 0,
    mixedSchemas: false,
  });
  expect(report.tasks).toMatchObject({ total: TURNS, settled: TURNS, successful: TURNS, unsettled: 0 });
}

async function persistAndAttachReport(testInfo: TestInfo, provider: string, report: unknown): Promise<void> {
  const providerSlug = provider.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const body = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const resultDirectory = join(process.cwd(), "test-results");
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(join(resultDirectory, `live-cache-trace-report-${providerSlug}.json`), body);
  await testInfo.attach(`cache-trace-report-${providerSlug}`, {
    body,
    contentType: "application/json",
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("mock provider did not bind a TCP port"));
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test.describe("deterministic Core cache traces", () => {
  let server: Server;
  let providerCalls = 0;
  const previousEnv = new Map<string, string | undefined>();

  test.beforeAll(async () => {
    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/models")) {
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
        const turn = providerCalls++;
        const cached = turn * 10;
        const event = {
          type: "response.completed",
          response: {
            status: "completed",
            output: [],
            usage: {
              input_tokens: 100 + cached,
              input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
              output_tokens: 1,
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\ndata: ${JSON.stringify(event)}\n\n`);
      });
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}/v1`;
    Object.assign(process.env, {
      TERMINA_CORE_TEST: "1",
      TERMINA_CORE_PROVIDER: "openai",
      TERMINA_CORE_MODEL: "gpt-5.6-sol",
      TERMINA_TEST_MODELS_URL: `${base}/models`,
      OPENAI_API_KEY: "e2e-loopback-token",
      OPENAI_BASE_URL: base,
    });
  });

  test.afterAll(async () => {
    try {
      await closeServer(server);
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("records ten clean turns with stable hashes and exact cache usage", async ({
    page,
    runRoot,
    projectRoot,
    closeElectron,
  }) => {
    const before = projectContents(projectRoot);
    try {
      await submitTurns(page, runRoot);
      expect(providerCalls).toBe(TURNS);
    } finally {
      await closeElectron();
    }

    expect(projectContents(projectRoot)).toEqual(before);
    const source = readTraceDirectory(traceDir(runRoot));
    const report = summarizeTraces(source.records, "deterministic-cache-e2e");
    assertCleanTrace(report, source.errors);
    expect(report.mainTurns).toBe(TURNS);
    expect(report.records).toBe(TURNS * 2);
    expect(report.usage.main).toMatchObject({ completeSamples: TURNS, partialSamples: 0, unknownSamples: 0 });
    expect(report.usage).toMatchObject({ input: 1_000, cacheRead: 450, cacheWrite: 0, output: 10, totalInput: 1_450 });
    expect(report.usage.cachedInputShare).toBeCloseTo(450 / 1_450, 12);
    expect(report.usage.cold).toMatchObject({ turns: 1, totalInput: 100, cacheRead: 0, cachedInputShare: 0 });
    expect(report.usage.warm).toMatchObject({ turns: 9, totalInput: 1_350, cacheRead: 450 });
    expect(report.usage.warm.cachedInputShare).toBeCloseTo(450 / 1_350, 12);

    const turns = report.attempts.perTurn;
    for (const field of ["modelSettingsHash", "toolsHash", "stablePrefixHash", "workingSetHash"]) {
      const values = turns.map((turn: any) => turn.cache[field]);
      expect(values.every((value: unknown) => typeof value === "string" && value.length > 0)).toBe(true);
      expect(new Set(values).size, `${field} must remain stable`).toBe(1);
    }
    expect(turns.slice(1).every((turn: any) => turn.cache.workingSetChanged === false)).toBe(true);
  });
});

test.describe("live Core cache probe", () => {
  test.skip(process.env.TERMINA_LIVE_CACHE_PROBE !== "1", "set TERMINA_LIVE_CACHE_PROBE=1 to spend ten real provider requests");

  test("reports ten paid requests without imposing a cache percentage", async ({
    page,
    runRoot,
    projectRoot,
    closeElectron,
  }, testInfo) => {
    const selectedModel = await selectModelThroughTerminalUi(page, LIVE_MODEL);
    const separator = selectedModel.indexOf("/");
    const selectedProvider = selectedModel.slice(0, separator);
    const selectedModelId = selectedModel.slice(separator + 1);
    const before = projectContents(projectRoot);
    let report: any = null;
    try {
      await submitTurns(page, runRoot);
    } finally {
      await closeElectron();
    }

    try {
      expect(projectContents(projectRoot)).toEqual(before);
      const source = readTraceDirectory(traceDir(runRoot));
      report = summarizeTraces(source.records, "live-cache-e2e");
      assertCleanTrace(report, source.errors);
      expect(report.mainTurns).toBe(TURNS);
      expect(report.usage.main.completeSamples).toBeGreaterThan(0);
      expect(report.usage.cold.turns).toBe(1);
      expect(report.usage.warm.turns).toBe(TURNS - 1);
      expect(new Set(report.attempts.perTurn.map((turn: any) => turn.provider))).toEqual(new Set([selectedProvider]));
      expect(new Set(report.attempts.perTurn.map((turn: any) => turn.model))).toEqual(new Set([selectedModelId]));
      for (const field of ["modelSettingsHash", "toolsHash", "stablePrefixHash", "workingSetHash"]) {
        const values = report.attempts.perTurn.map((turn: any) => turn.cache[field]);
        expect(values.every((value: unknown) => typeof value === "string" && value.length > 0)).toBe(true);
        expect(new Set(values).size, `${field} must remain stable`).toBe(1);
      }
    } finally {
      if (report) await persistAndAttachReport(testInfo, selectedProvider, report);
    }
  });
});
