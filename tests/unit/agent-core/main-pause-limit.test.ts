import { describe, it } from "vitest";

/** The server-tool continuation budget must terminate and settle durably. */
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

const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;

function sse(events: unknown[]): string {
  return events.map((event) => "data: " + JSON.stringify(event)).join("\n\n") + "\n\n";
}

function pauseSearch(id: string): string {
  return sse([
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id, name: "web_search", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "probe" }) } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: id, content: [{ type: "web_search_result", url: "https://example.com", title: "probe" }] } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { input_tokens: 10, output_tokens: 2 } },
    { type: "message_stop" },
  ]);
}

function clientRead(id: string): string {
  return sse([
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "read_file" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "file.txt" }) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 2 } },
    { type: "message_stop" },
  ]);
}

function endTurn(): string {
  return sse([
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 2 } },
    { type: "message_stop" },
  ]);
}

async function runPauseKernel(fetchProgram: string): Promise<{
  output: string;
  attempts: Array<{ status?: string }>;
  settlements: Array<{ outcome?: { status?: string } }>;
}> {
  const root = mkdtempSync(join(tmpdir(), "agent-core-pause-limit-"));
  const project = join(root, "project");
  const events = join(root, "events");
  const terminalId = "term-pause-limit";
  const sessionId = `${terminalId}-session`;
  const sessionFile = join(events, sessionId, "current", "session.jsonl");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  mkdirSync(events, { recursive: true, mode: 0o700 });
  writeFileSync(join(project, "file.txt"), "hello\n");
  const childScript = `
    let providerCalls = 0;
    globalThis.fetch = async (input) => {
      if (String(input) === "https://models.dev/api.json") return new Response("{}", { status: 200 });
      const turn = ++providerCalls;
      ${fetchProgram}
    };
    process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", "pause continuation regression"];
    await import(${JSON.stringify(mainUrl)});
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript],
    {
      cwd: project,
      env: {
        ...process.env,
        TERMINA_CORE_TEST: "1",
        TERMINA_CORE_PROVIDER: "anthropic",
        TERMINA_CORE_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_API_KEY: "pause-limit-test-key",
        TERMINA_EVENTS_DIR: events,
        TERMINA_TERMINAL_ID: terminalId,
        TERMINA_CORE_SESSION_ID: sessionId,
        TERMINA_CORE_SESSION_FILE: sessionFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let error = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { error += chunk; });
  const ackTimer = setInterval(() => {
    try {
      const sidecar = join(events, `${terminalId}.jsonl`);
      if (!existsSync(sidecar)) return;
      for (const line of readFileSync(sidecar, "utf8").split("\n")) {
        if (!line) continue;
        let record: { t?: string; requestId?: string };
        try {
          record = JSON.parse(line) as { t?: string; requestId?: string };
        } catch {
          continue;
        }
        if ((record.t !== "preflight_request" && record.t !== "checkpoint_request") || !record.requestId) continue;
        const ack = join(events, `ack-${terminalId}-${record.requestId}.json`);
        if (!existsSync(ack)) writeFileSync(ack, JSON.stringify({ ok: true }), { mode: 0o600 });
      }
    } catch {
      /* The sidecar may be between append generations. */
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
    assert.equal(result.code, 0, `${error}\n${output}`);
    const traceDir = join(events, `${terminalId}.traces`);
    const records = existsSync(traceDir)
      ? readdirSync(traceDir)
        .filter((name) => name.startsWith("turn-") && name.endsWith(".json"))
        .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
        .map((name) => JSON.parse(readFileSync(join(traceDir, name), "utf8")) as { recordType?: string; status?: string; outcome?: { status?: string } })
      : [];
    return {
      output,
      attempts: records.filter((record) => record.recordType === "attempt"),
      settlements: records.filter((record) => record.recordType === "task-settled"),
    };
  } finally {
    clearInterval(ackTimer);
    if (!child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Agent Core pause-turn continuation budget", () => {
  it("settles after five resumptions and records the sixth pause as a failure", async () => {
    const result = await runPauseKernel(`
      return new Response(${JSON.stringify(pauseSearch("search-1"))}.replaceAll("search-1", "search-" + turn), {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    `);
    assert.match(result.output, /server-tool continuation limit reached after 5 continuations/);
    assert.equal(result.attempts.length, 6, "one original response plus five resumptions");
    assert.deepEqual(result.attempts.slice(0, 5).map((record) => record.status), ["ok", "ok", "ok", "ok", "ok"]);
    assert.equal(result.attempts[5]?.status, "pause-limit");
    assert.equal(result.settlements.length, 1);
    assert.equal(result.settlements[0]?.outcome?.status, "failure");
    assert.equal("correctness" in (result.settlements[0]?.outcome ?? {}), false);
  }, 60_000);

  it("resets the consecutive pause streak after a client tool turn", async () => {
    const result = await runPauseKernel(`
      const pause = ${JSON.stringify(pauseSearch("search-1"))}.replaceAll("search-1", "search-" + turn);
      const read = ${JSON.stringify(clientRead("read-1"))}.replaceAll("read-1", "read-" + turn);
      const done = ${JSON.stringify(endTurn())};
      const body = turn === 5 ? read : turn === 10 ? done : pause;
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    `);
    assert.doesNotMatch(result.output, /server-tool continuation limit/);
    assert.equal(result.attempts.some((record) => record.status === "pause-limit"), false);
    assert.equal(result.settlements.length, 1);
    assert.equal(result.settlements[0]?.outcome?.status, "success");
  }, 60_000);
});
