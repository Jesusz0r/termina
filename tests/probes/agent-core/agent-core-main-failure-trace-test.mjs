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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const root = mkdtempSync(join(tmpdir(), "agent-core-main-failure-trace-"));
const events = join(root, "events");
const terminalId = "term-main-failure";
mkdirSync(events, { recursive: true, mode: 0o700 });
const providerBase = "https://api.openai.com/v1";
const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
const childScript = `
  globalThis.fetch = async (input) => {
    if (String(input) === "https://models.dev/api.json") {
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: "provider failed" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };
  process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", "provider failure trace probe"];
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
    const request = readJsonLines(join(events, `${terminalId}.jsonl`)).findLast((record) => record.t === "preflight_request");
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
  const attempts = traces.filter((record) => record.recordType === "attempt" && record.role === "main");
  assert.ok(attempts.length >= 2, "provider retries and terminal failure must be persisted");
  assert.ok(attempts.some((record) => record.status === "retrying"));
  const terminal = attempts.findLast((record) => record.status === "error");
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
