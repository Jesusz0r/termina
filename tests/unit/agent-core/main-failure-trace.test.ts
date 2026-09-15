import { describe, it } from "vitest";
/** Failed-provider trace must not claim an inverted or phantom storage range. */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectRunFrom } from "../../../agent-core/main/env.ts";

describe("Agent Core Failed Provider Trace Contract", () => {
  it("treats identical entry paths as a direct run when realpath cannot resolve them", () => {
    const missing = join(tmpdir(), "termina-direct-run-missing", "entry.mjs");
    assert.equal(isDirectRunFrom(pathToFileURL(missing).href, missing), true);
    assert.equal(isDirectRunFrom(pathToFileURL(missing).href, join(tmpdir(), "other-missing.mjs")), false);
  });

  it("does not mix realpath and resolve when only one entry exists", () => {
    const root = mkdtempSync(join(tmpdir(), "termina-direct-run-"));
    try {
      const entry = join(root, "entry.mjs");
      writeFileSync(entry, "");
      const alias = join(root, "alias.mjs");
      symlinkSync(entry, alias);
      assert.equal(isDirectRunFrom(pathToFileURL(entry).href, alias), true);
      assert.equal(isDirectRunFrom(pathToFileURL(entry).href, pathToFileURL(entry).href), true);
      assert.equal(isDirectRunFrom(pathToFileURL(entry).href, join(root, "missing.mjs")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes failed-provider trace contract", async () => {
    function readJsonLines(path: string) {
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    }

    const root = mkdtempSync(join(tmpdir(), "agent-core-main-failure-trace-"));
    const events = join(root, "events");
    const terminalId = "term-main-failure";
    mkdirSync(events, { recursive: true, mode: 0o700 });
    const providerBase = "https://api.openai.com/v1";
    const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
    const mainPath = fileURLToPath(mainUrl);
    const childScript = `
      const providerBase = ${JSON.stringify(providerBase)};
      const requestUrl = (input) => {
        if (typeof input === "string") return input;
        if (input instanceof URL) return input.href;
        if (input && typeof input === "object" && "url" in input) return String(input.url);
        return String(input);
      };
      globalThis.fetch = async (input) => {
        const url = requestUrl(input);
        if (!url.startsWith(providerBase)) {
          return new Response(JSON.stringify({
            openai: { models: { "gpt-5.6-sol": { cost: {
              input: 1, output: 2, cache_read: 0.1, cache_write: 1.25, reasoning: 2
            }, limit: { context: 400000 } } } }
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: { message: "provider failed" } }), {
          status: 500,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      };
      process.argv = [process.execPath, ${JSON.stringify(mainPath)}, "-p", "provider failure trace probe"];
      await import(${JSON.stringify(mainUrl)});
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINA_CORE_TEST: "1",
          TERMINA_CORE_PROVIDER: "openai",
          TERMINA_CORE_MODEL: "gpt-5.6-sol",
          OPENAI_API_KEY: "failure-test-token",
          OPENAI_BASE_URL: providerBase,
          TERMINA_EVENTS_DIR: events,
          TERMINA_TERMINAL_ID: terminalId,
          TERMINA_CORE_SESSION_ID: `${terminalId}-session`,
          TERMINA_AUTH_PATH: join(root, "auth.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const ackTimer = setInterval(() => {
      try {
        const request = [...readJsonLines(join(events, `${terminalId}.jsonl`))].reverse().find((record) => record.t === "preflight_request");
        if (request?.requestId) {
          writeFileSync(
            join(events, `ack-${terminalId}-${request.requestId}.json`),
            JSON.stringify({ ok: true }),
            { mode: 0o600 },
          );
        }
      } catch {
        /* Wait for startup. */
      }
    }, 10);

    try {
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ code: -1, signal: "SIGKILL" });
        }, 40_000);
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
      assert.equal(result.code, 0, stderr);
      const sidecar = readJsonLines(join(events, `${terminalId}.jsonl`));
      const sidecarTypes = sidecar.map((record) => record.t).join(",");
      assert.ok(
        sidecar.some((record) => record.t === "agent_start"),
        `agent-core never started a run; events=${sidecarTypes || "(none)"}; stderr=${stderr}`,
      );
      const traceDir = join(events, `${terminalId}.traces`);
      const traces = readdirSync(traceDir)
        .filter((name) => /^turn-\d+\.json$/.test(name))
        .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
        .map((name) => JSON.parse(readFileSync(join(traceDir, name), "utf8")));
      const attempts = traces.filter((record) => record.recordType === "attempt" && record.role === "main");
      assert.ok(
        attempts.length >= 2,
        `provider retries and terminal failure must be persisted (attempts=${attempts.length} statuses=${attempts.map((record) => record.status).join(",")})`,
      );
      assert.ok(attempts.some((record) => record.status === "retrying"));
      const terminal = [...attempts].reverse().find((record) => record.status === "error");
      assert.ok(terminal, "terminal provider failure must be persisted");
      assert.equal(terminal.storageSeqRange, null);
      assert.ok(attempts.every((record) => record.storageSeqRange === null || record.storageSeqRange[1] >= record.storageSeqRange[0]));
      const settlement = traces.find((record) => record.recordType === "task-settled");
      assert.ok(settlement);
      assert.equal(settlement.finalAttemptId, terminal.attemptId);
      console.log("agent-core failed-provider trace contract passed");
    } finally {
      clearInterval(ackTimer);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
