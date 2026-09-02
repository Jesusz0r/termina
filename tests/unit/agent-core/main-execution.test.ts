import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Agent Core Main Process Execution & Policy Verification", () => {
  let root: string;
  const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agent-core-main-exec-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function readJsonLines(path: string) {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  function sseEvent(value: any) {
    return `data: ${JSON.stringify(value)}\n\n`;
  }

  describe("Headless Approval Policy Enforcement", () => {
    async function runApprovalScenario(name: string, approve: string, command: string, shouldRun: boolean) {
      const sentinel = join(root, `${name}.txt`);
      const call = {
        type: "function_call",
        id: "item-1",
        call_id: "call-1",
        name: "bash",
        arguments: JSON.stringify({ command }),
      };
      const toolBody = [
        sseEvent({ type: "response.output_item.done", item: call }),
        sseEvent({ type: "response.completed", response: { status: "completed", output: [call], usage: {} } }),
      ].join("");
      const finalBody = [
        sseEvent({ type: "response.output_text.delta", delta: "done" }),
        sseEvent({ type: "response.completed", response: { status: "completed", output: [], usage: {} } }),
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
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ code: -1, signal: "SIGKILL" });
        }, 40_000);
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
      expect(exit.code).toBe(0);
      expect(existsSync(sentinel)).toBe(shouldRun);
      if (shouldRun) {
        expect(readFileSync(sentinel, "utf8")).toBe("ran");
      } else {
        expect(output).toMatch(/error: bash denied/i);
      }
    }

    it("denies safe bash in headless ask mode", async () => {
      await runApprovalScenario("ask", "ask", `printf ran > '${join(root, "ask.txt")}'`, false);
    });

    it("denies dangerous bash in headless ask mode", async () => {
      await runApprovalScenario("ask-dangerous", "ask", `sh -c "printf ran > '${join(root, "ask-dangerous.txt")}'"`, false);
    });

    it("allows execution when approve policy is all", async () => {
      await runApprovalScenario("all", "all", `printf ran > '${join(root, "all.txt")}'`, true);
    });
  });

  describe("Anthropic Streaming Tool Call Input Validation", () => {
    async function runToolScenario(name: string, { id = "call-1", toolName = "read_file", args, streamEvents, expectFailure = true }: any) {
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
      ]).map(sseEvent).join("");
      const finalBody = [
        sseEvent({ type: "message_start", message: { usage: {} } }),
        sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
        sseEvent({ type: "content_block_stop", index: 0 }),
        sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
        sseEvent({ type: "message_stop" }),
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
            (row: any) => row.t === "preflight_request" || row.t === "checkpoint_request",
          );
          for (const request of requests) {
            if (!request.requestId) continue;
            writeFileSync(join(eventsDir, `ack-${terminalId}-${request.requestId}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
          }
        } catch {
          /* Wait for the request. */
        }
      }, 10);
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ code: -1, signal: "SIGKILL" });
        }, 30_000);
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          clearInterval(ackTimer);
          resolve({ code, signal });
        });
      });
      expect(exit.code).toBe(0);
      const session = readJsonLines(sessionFile);
      const sidecar = readJsonLines(join(eventsDir, `${terminalId}.jsonl`));
      if (expectFailure) {
        expect(output).toMatch(/tool call|tool JSON|content block|event index/i);
        expect(session.some((row: any) => row.message?.role === "assistant")).toBe(false);
        expect(sidecar.some((row: any) => row.t === "tool")).toBe(false);
      } else {
        expect(session.some((row: any) => row.message?.role === "assistant")).toBe(true);
        expect(sidecar.some((row: any) => row.t === "tool")).toBe(true);
      }
    }

    it("rejects non-object array arguments", async () => {
      await runToolScenario("array", { args: "[]" });
    });

    it("rejects null tool arguments", async () => {
      await runToolScenario("null", { args: "null" });
    });

    it("rejects malformed json arguments", async () => {
      await runToolScenario("malformed", { args: "{" });
    });

    it("rejects empty id or empty name", async () => {
      await runToolScenario("empty-id", { id: "", args: "{}" });
      await runToolScenario("empty-name", { toolName: "", args: "{}" });
    });

    it("accepts valid empty object arguments", async () => {
      await runToolScenario("valid-empty-object", { args: "{}", expectFailure: false });
    });
  });
});
