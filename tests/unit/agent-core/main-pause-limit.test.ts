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

describe("Agent Core pause-turn continuation budget", () => {
  it("settles after five resumptions and records the sixth pause as a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-core-pause-limit-"));
    const events = join(root, "events");
    const terminalId = "term-pause-limit";
    const sessionId = `${terminalId}-session`;
    const sessionFile = join(events, sessionId, "current", "session.jsonl");
    const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
    mkdirSync(events, { recursive: true, mode: 0o700 });

    const childScript = `
      let providerCalls = 0;
      globalThis.fetch = async (input) => {
        if (String(input) === "https://models.dev/api.json") return new Response("{}", { status: 200 });
        const id = "search-" + (++providerCalls);
        return new Response([
          "data: " + JSON.stringify({ type: "message_start", message: { usage: {} } }),
          "",
          "data: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id, name: "web_search", input: {} } }),
          "",
          "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "probe" }) } }),
          "",
          "data: " + JSON.stringify({ type: "content_block_stop", index: 0 }),
          "",
          "data: " + JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: id, content: [{ type: "web_search_result", url: "https://example.com", title: "probe" }] } }),
          "",
          "data: " + JSON.stringify({ type: "content_block_stop", index: 1 }),
          "",
          "data: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { input_tokens: 10, output_tokens: 2 } }),
          "",
          "data: " + JSON.stringify({ type: "message_stop" }),
          "",
        ].join("\\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", "pause continuation regression"];
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
      assert.equal(result.code, 0, error);
      assert.match(output, /server-tool continuation limit reached after 5 continuations/);

      const traceDir = join(events, `${terminalId}.traces`);
      const records = readdirSync(traceDir)
        .filter((name) => name.startsWith("turn-") && name.endsWith(".json"))
        .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
        .map((name) => JSON.parse(readFileSync(join(traceDir, name), "utf8")) as { recordType?: string; status?: string; outcome?: { status?: string; correctness?: unknown } });
      const attempts = records.filter((record) => record.recordType === "attempt");
      const settlements = records.filter((record) => record.recordType === "task-settled");
      assert.equal(attempts.length, 6, "one original response plus five resumptions");
      assert.deepEqual(attempts.slice(0, 5).map((record) => record.status), ["ok", "ok", "ok", "ok", "ok"]);
      assert.equal(attempts[5]?.status, "pause-limit");
      assert.equal(settlements.length, 1);
      assert.equal(settlements[0]?.outcome?.status, "failure");
      assert.equal(settlements[0]?.outcome?.correctness, null);
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
  }, 60_000);
});
