/**
 * Focused integration contract for provider retry attempt tracing.
 *
 *   node --experimental-strip-types --no-warnings scripts/agent-core-main-stage3b-test.mjs
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

const root = mkdtempSync(join(tmpdir(), "agent-core-main-stage3b-"));
const events = join(root, "events");
const terminalId = "term-main-retry";
const requestLog = join(root, "provider-requests.jsonl");
mkdirSync(events, { recursive: true, mode: 0o700 });
const providerBase = "https://api.openai.com/v1";
const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
const childScript = `
  import fs from "node:fs";
  const providerBase = ${JSON.stringify(providerBase)};
  const requestLog = ${JSON.stringify(requestLog)};
  let providerCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith(providerBase)) {
      return new Response(JSON.stringify({
        openai: { models: { "gpt-5.6-sol": { cost: {
          input: 1, output: 2, cache_read: 0.1, cache_write: 1.25, reasoning: 2
        } } } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    let body = null;
    try { body = typeof init.body === "string" ? JSON.parse(init.body) : init.body ?? null; } catch {}
    fs.appendFileSync(requestLog, JSON.stringify({ url, body }) + "\\n");
    if (providerCalls++ === 0) {
      return new Response(JSON.stringify({ error: { message: "busy" } }), {
        status: 429,
        headers: { "retry-after": "0", "content-type": "application/json" },
      });
    }
    return new Response([
      "data: " + JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
      "",
      "data: " + JSON.stringify({ type: "response.completed", response: {
        status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1 }
      } }),
      "",
    ].join("\\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", "retry trace probe"];
  await import(${JSON.stringify(mainUrl)});
`;

const env = {
  ...process.env,
  TERMINA_CORE_TEST: "1",
  TERMINA_CORE_PROVIDER: "openai",
  TERMINA_CORE_MODEL: "gpt-5.6-sol",
  OPENAI_API_KEY: "retry-test-token",
  OPENAI_BASE_URL: providerBase,
  TERMINA_EVENTS_DIR: events,
  TERMINA_TERMINAL_ID: terminalId,
  TERMINA_CORE_SESSION_ID: `${terminalId}-session`,
  TERMINA_AUTH_PATH: join(root, "auth.json"),
  TERMINA_PROVIDER_REQUEST_LOG: requestLog,
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
clearInterval(ackTimer);

try {
  assert.equal(result.code, 0, stderr);
  const requests = readJsonLines(requestLog);
  assert.equal(requests.length, 2, "one retry must produce exactly two provider requests");
  const traceDir = join(events, `${terminalId}.traces`);
  const traces = readdirSync(traceDir)
    .filter((name) => /^turn-\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .map((name) => JSON.parse(readFileSync(join(traceDir, name), "utf8")))
    .filter((record) => record.recordType === "attempt");
  assert.ok(traces.length >= 2, "retry and final attempts must both be persisted");
  const retry = traces.find((record) => record.status === "retrying");
  const final = traces.find((record) => record.status === "ok");
  assert.ok(retry);
  assert.ok(final);
  assert.equal(final.retryOfAttemptId, retry.attemptId);
  assert.equal(final.parentAttemptId, retry.attemptId);
  assert.equal(final.fallbackReason, "provider-429");
  assert.equal(retry.retryCount, 0);
  assert.equal(final.retryCount, 1);
  assert.equal(typeof retry.startedAtMs, "number");
  assert.equal(typeof retry.endedAtMs, "number");
  assert.equal(typeof final.startedAtMs, "number");
  assert.equal(typeof final.endedAtMs, "number");
  assert.ok(final.endedAtMs >= final.startedAtMs);
  assert.ok(final.ttftMs === null || final.ttftMs >= 0);
  console.log("agent-core main Stage 3B retry trace contract passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
