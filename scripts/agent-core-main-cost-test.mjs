/**
 * Focused integration contract for canonical per-run rate snapshots.
 *
 *   node --experimental-strip-types --no-warnings scripts/agent-core-main-cost-test.mjs
 */
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const root = mkdtempSync(join(tmpdir(), "agent-core-main-cost-"));
const events = join(root, "events");
const terminalId = "term-main-cost";
mkdirSync(events, { recursive: true, mode: 0o700 });
const providerBase = "https://api.openai.com/v1";
const mainUrl = new URL("../agent-core/main.ts", import.meta.url).href;
const childScript = `
  const providerBase = ${JSON.stringify(providerBase)};
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (!url.startsWith(providerBase)) {
      return new Response(JSON.stringify({
        version: "cost-fixture-v1",
        openai: { models: { "gpt-5.6-sol": { cost: {
          input: 1, output: 2, cache_read: 0.1, cache_write: 1.25, reasoning: 2
        } } } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return new Response([
      "data: " + JSON.stringify({ type: "response.output_text.delta", delta: "done" }),
      "",
      "data: " + JSON.stringify({ type: "response.completed", response: {
        status: "completed", output: [], usage: {
          input_tokens: 3,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 }
        }
      } }),
      "",
    ].join("\\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", "cost trace probe"];
  await import(${JSON.stringify(mainUrl)});
`;

const env = {
  ...process.env,
  TERMINA_CORE_TEST: "1",
  TERMINA_CORE_PROVIDER: "openai",
  TERMINA_CORE_MODEL: "gpt-5.6-sol",
  OPENAI_API_KEY: "cost-test-token",
  OPENAI_BASE_URL: providerBase,
  TERMINA_EVENTS_DIR: events,
  TERMINA_TERMINAL_ID: terminalId,
  TERMINA_CORE_SESSION_ID: `${terminalId}-session`,
  TERMINA_AUTH_PATH: join(root, "auth.json"),
};

const child = spawn(
  process.execPath,
  ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript],
  { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const ackTimer = setInterval(() => {
  try {
    const request = readJsonLines(join(events, `${terminalId}.jsonl`)).findLast((record) => record.t === "preflight_request");
    if (request?.requestId) {
      writeFileSync(
        join(events, `ack-${terminalId}-${request.requestId}.json`),
        JSON.stringify({ ok: true }),
        { mode: 0o600 },
      );
    }
  } catch {
    /* Wait until startup writes the preflight request. */
  }
}, 10);

try {
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, signal: "SIGKILL" });
    }, 15_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(result.code, 0, stderr);
  const traceDir = join(events, `${terminalId}.traces`);
  const traces = readdirSync(traceDir)
    .filter((name) => /^turn-\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .map((name) => JSON.parse(readFileSync(join(traceDir, name), "utf8")));
  const attempt = traces.find((record) => record.recordType === "attempt" && record.role === "main");
  assert.ok(attempt, "main attempt must be persisted");
  assert.equal(attempt.cost.source, "https://models.dev/api.json");
  assert.equal(attempt.cost.version, "cost-fixture-v1");
  assert.deepEqual(attempt.cost.unknownFields, []);
  assert.deepEqual(attempt.cost.unknownReasons, []);
  assert.deepEqual(attempt.cost.components, {
    input: 0.000003,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0.000002,
    reasoning: 0,
    storage: null,
  });
  assert.equal(attempt.cost.cacheWriteTtlClass, "30m");
  assert.equal(attempt.cost.reasoningBilling, "separate");
  assert.equal(attempt.cost.scope.role, "main");
  assert.equal(typeof attempt.cache.serializedToolsHash, "string");
  assert.ok(attempt.cache.serializedToolsBytes > 0);
  assert.equal(attempt.cost.units.input, "usd_per_million_tokens");
  assert.deepEqual(attempt.cost.rates, {
    input: 1,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    output: 2,
    reasoning: 2,
    storage: null,
  });
  assert.ok(Math.abs(attempt.cost.usd - 0.000005) < 1e-12);
  console.log("agent-core main canonical cost contract passed");
} finally {
  clearInterval(ackTimer);
  rmSync(root, { recursive: true, force: true });
}
