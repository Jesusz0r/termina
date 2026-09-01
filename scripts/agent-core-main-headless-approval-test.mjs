/** Headless ask mode must fail closed for safe and dangerous commands; explicit all may run. */
process.env.TERMINA_CORE_TEST = "1";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-core-headless-approval-"));
const mainUrl = new URL("../agent-core/main.ts", import.meta.url).href;

function event(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function scenario(name, approve, command, shouldRun) {
  const sentinel = join(root, `${name}.txt`);
  const call = {
    type: "function_call",
    id: "item-1",
    call_id: "call-1",
    name: "bash",
    arguments: JSON.stringify({ command }),
  };
  const toolBody = [
    event({ type: "response.output_item.done", item: call }),
    event({ type: "response.completed", response: { status: "completed", output: [call], usage: {} } }),
  ].join("");
  const finalBody = [
    event({ type: "response.output_text.delta", delta: "done" }),
    event({ type: "response.completed", response: { status: "completed", output: [], usage: {} } }),
  ].join("");
  const childScript = `
    let calls = 0;
    globalThis.fetch = async (input) => {
      if (String(input) === "https://models.dev/api.json") {
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      }
      calls += 1;
      return new Response(calls === 1 ? ${JSON.stringify(toolBody)} : ${JSON.stringify(finalBody)}, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", "approval probe"];
    await import(${JSON.stringify(mainUrl)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERMINA_CORE_TEST: "1",
      TERMINA_CORE_PROVIDER: "openai",
      TERMINA_CORE_MODEL: "gpt-5.6-sol",
      TERMINA_CORE_APPROVE: approve,
      OPENAI_API_KEY: "headless-approval-test-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: -1, signal: "SIGKILL" });
    }, 15_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(exit.code, 0, `${name}: ${output}`);
  assert.equal(existsSync(sentinel), shouldRun, `${name}: command execution did not match policy`);
  if (shouldRun) assert.equal(readFileSync(sentinel, "utf8"), "ran");
  else assert.match(output, /error: bash denied/i, `${name}: denial must be returned as the tool result`);
}

try {
  await scenario("ask", "ask", `printf ran > '${join(root, "ask.txt")}'`, false);
  await scenario("ask-dangerous", "ask", `sh -c \"printf ran > '${join(root, "ask-dangerous.txt")}'\"`, false);
  await scenario("all", "all", `printf ran > '${join(root, "all.txt")}'`, true);
  console.log("agent-core headless approval contract passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
