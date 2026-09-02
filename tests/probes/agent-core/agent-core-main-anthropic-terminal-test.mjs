/** Anthropic streams must terminate cleanly and contain complete tool JSON. */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
const start = { type: "message_start", message: { usage: {} } };
const textStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const textDelta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
const stop = { type: "message_stop" };

async function runScenario(name, body, expected) {
  const childScript = `
    globalThis.fetch = async (input) => {
      if (String(input) === "https://models.dev/api.json") return new Response(JSON.stringify({}), { status: 200 });
      return new Response(${JSON.stringify(body)}, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", ${JSON.stringify(`anthropic ${name}`)}];
    await import(${JSON.stringify(mainUrl)});
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript],
    {
      cwd: process.cwd(),
      env: { ...process.env, ANTHROPIC_API_KEY: "terminal-test-key", TERMINA_CORE_PROVIDER: "anthropic", TERMINA_CORE_MODEL: "claude-sonnet-4-5" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let error = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { error += chunk; });
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
  assert.equal(result.code, 0, `${name}: ${error}`);
  assert.match(`${output}\n${error}`, expected, `${name} must be classified as incomplete`);
  assert.ok(Buffer.byteLength(output, "utf8") < 100_000, `${name} must not emit partial success text`);
}

const event = (value) => `data: ${JSON.stringify(value)}\n`;
await runScenario(
  "malformed-json",
  `${event(start)}${event("not-json")}${event(stop)}`.replace('data: "not-json"', "data: {broken"),
  /incomplete|malformed|bounded/i,
);
await runScenario(
  "missing-message-stop",
  `${event(start)}${event(textStart)}${event(textDelta)}`,
  /incomplete|message_stop/i,
);
await runScenario(
  "partial-tool-json",
  `${event(start)}${event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "read_file", input: {} } })}${event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\\\"path\\\":" } })}${event(stop)}`,
  /incomplete|partial tool JSON/i,
);
console.log("agent-core Anthropic terminal contract passed");
