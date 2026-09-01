/** Invalid Anthropic tool calls must fail before session persistence or tool start. */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-core-anthropic-tool-args-"));
const mainUrl = new URL("../agent-core/main.ts", import.meta.url).href;

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function event(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function scenario(name, { id = "call-1", toolName = "read_file", args, streamEvents, expectFailure = true }) {
  const dir = join(root, name);
  const eventsDir = join(dir, "events");
  const terminalId = `term-${name}`;
  const sessionId = `${terminalId}-session`;
  const sessionFile = join(eventsDir, sessionId, "current", "session.jsonl");
  mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
  const body = (streamEvents ?? [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: toolName, input: {} } },
    ...(args === undefined ? [] : [{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }]),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
    { type: "message_stop" },
  ]).map(event).join("");
  const finalBody = [
    event({ type: "message_start", message: { usage: {} } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
    event({ type: "message_stop" }),
  ].join("");
  const childScript = `
    let calls = 0;
    globalThis.fetch = async (input) => {
      if (String(input) === "https://models.dev/api.json") {
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      }
      calls += 1;
      return new Response(calls === 1 ? ${JSON.stringify(body)} : ${JSON.stringify(finalBody)}, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", "anthropic invalid tool probe"];
    await import(${JSON.stringify(mainUrl)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERMINA_CORE_TEST: "1",
      TERMINA_CORE_PROVIDER: "anthropic",
      TERMINA_CORE_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_API_KEY: "anthropic-tool-test-key",
      TERMINA_EVENTS_DIR: eventsDir,
      TERMINA_TERMINAL_ID: terminalId,
      TERMINA_CORE_SESSION_ID: sessionId,
      TERMINA_CORE_SESSION_FILE: sessionFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const ackTimer = setInterval(() => {
    try {
      const requests = readJsonLines(join(eventsDir, `${terminalId}.jsonl`)).filter(
        (row) => row.t === "preflight_request" || row.t === "checkpoint_request",
      );
      for (const request of requests) {
        if (!request.requestId) continue;
        writeFileSync(join(eventsDir, `ack-${terminalId}-${request.requestId}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
      }
    } catch {
      /* Wait for the request. */
    }
  }, 10);
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, signal: "SIGKILL" });
    }, 15_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      clearInterval(ackTimer);
      resolve({ code, signal });
    });
  });
  assert.equal(exit.code, 0, `${name}: ${output}`);
  const session = readJsonLines(sessionFile);
  const sidecar = readJsonLines(join(eventsDir, `${terminalId}.jsonl`));
  if (expectFailure) {
    assert.match(output, /tool call|tool JSON|content block|event index/i, `${name}: provider turn must fail`);
    assert.equal(
      session.some((row) => row.message?.role === "assistant"),
      false,
      `${name}: invalid provider turn must not persist any assistant message`,
    );
    assert.equal(sidecar.some((row) => row.t === "tool"), false, `${name}: invalid tool call must not start`);
  } else {
    assert.equal(session.some((row) => row.message?.role === "assistant"), true, `${name}: valid provider turn must persist`);
    assert.equal(sidecar.some((row) => row.t === "tool"), true, `${name}: valid tool call must start`);
  }
}

try {
  await scenario("array", { args: "[]" });
  await scenario("null", { args: "null" });
  await scenario("malformed", { args: "{" });
  await scenario("missing-args", { args: undefined });
  await scenario("empty-id", { id: "", args: "{}" });
  await scenario("empty-name", { toolName: "", args: "{}" });
  await scenario("duplicate-index-fragment-splice", { streamEvents: [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "first", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"package' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "second", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '.json"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ] });
  await scenario("overwritten-tool-slot", { streamEvents: [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "null" } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "must not persist" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ] });
  for (const [name, index] of [
    ["oversized-index", 10_001],
    ["coerced-index", "0"],
    ["null-index", null],
    ["fractional-index", 0.5],
  ]) {
    await scenario(name, { streamEvents: [
      { type: "message_start", message: { usage: {} } },
      { type: "content_block_start", index, content_block: { type: "tool_use", id: "tool", name: "read_file", input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "null" } },
      { type: "content_block_stop", index },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "must not persist" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ] });
  }
  await scenario("mixed-text-invalid-tool", { streamEvents: [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "must not persist" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "null" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_stop" },
  ] });
  await scenario("delta-after-stop", { streamEvents: [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "message_stop" },
  ] });
  await scenario("stop-without-start", { streamEvents: [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ] });
  await scenario("unclosed-tool-block", { streamEvents: [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "message_stop" },
  ] });
  await scenario("mismatched-delta", { streamEvents: [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ] });
  await scenario("non-string-tool-fragment", { streamEvents: [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: null } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ] });
  await scenario("valid-empty-object", { args: "{}", expectFailure: false });
  console.log("agent-core Anthropic tool argument contract passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
