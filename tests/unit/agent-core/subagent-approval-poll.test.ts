import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TERMINA_CORE_TEST = "1";

import { AgentTui } from "../../../agent-core/tui.ts";
import {
  SUBAGENT_APPROVAL_POLL_MS,
  SUBAGENT_APPROVAL_TIMEOUT_MS,
  writeSubagentApprovalRequest,
} from "../../../agent-core/subagents.ts";
import { isApprovalAnswer } from "../../../agent-core/main.ts";

function fakeTui(onSubmit: (line: string) => void): AgentTui {
  return new AgentTui({
    stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
    stdin: { isTTY: false },
    onSubmit,
    onInterrupt: () => {},
    onExit: () => {},
  });
}

const APPROVAL_ROWS = [
  { name: "Deny", hint: "reject", submit: "/approve deny" },
  { name: "Approve once", hint: "run", submit: "/approve once" },
];

describe("subagent approval poll cadence", () => {
  it("polls on a short timer, far below the child timeout", () => {
    expect(SUBAGENT_APPROVAL_POLL_MS).toBeGreaterThan(0);
    expect(SUBAGENT_APPROVAL_POLL_MS).toBeLessThanOrEqual(2000);
    expect(SUBAGENT_APPROVAL_POLL_MS).toBeLessThan(SUBAGENT_APPROVAL_TIMEOUT_MS);
  });

  it("recognizes exactly the /approve answers", () => {
    expect(isApprovalAnswer("/approve deny")).toBe(true);
    expect(isApprovalAnswer("/approve once")).toBe(true);
    expect(isApprovalAnswer("/approve always")).toBe(true);
    expect(isApprovalAnswer("/approve protected")).toBe(true);
    expect(isApprovalAnswer("/approve")).toBe(true);
    expect(isApprovalAnswer("hello queued")).toBe(false);
    expect(isApprovalAnswer("/help")).toBe(false);
    expect(isApprovalAnswer("/permissions always")).toBe(false);
    expect(isApprovalAnswer("!ls")).toBe(false);
    expect(isApprovalAnswer("/approveX")).toBe(false);
    expect(isApprovalAnswer("")).toBe(false);
  });
});

describe("typed-ahead queueing during a picker", () => {
  it("queues a typed prompt and keeps the picker open", () => {
    const picks: string[] = [];
    const tui = fakeTui((line) => picks.push(line));
    tui.setDraft("keep this draft");
    tui.setChoices("Approve bash? rm -rf build", APPROVAL_ROWS);
    expect(tui.frame()).toContain("Approve bash?");

    tui.feed("hello queued");
    const typing = tui.frame();
    expect(typing).toContain("hello queued");
    expect(typing).toContain("Deny");

    tui.feed("\r");
    expect(picks).toEqual(["hello queued"]);
    const stillOpen = tui.frame();
    expect(stillOpen).toContain("Approve bash?");
    expect(stillOpen).toContain("Deny");

    tui.feed("\r");
    expect(picks).toEqual(["hello queued", "/approve deny"]);
    const closed = tui.frame();
    expect(closed).toContain("keep this draft");
    expect(closed).not.toContain("Approve bash?");
  });

  it("still picks the highlighted row on empty submit", () => {
    const picks: string[] = [];
    const tui = fakeTui((line) => picks.push(line));
    tui.setChoices("Subagent bg-1 asks to run bash: ls", APPROVAL_ROWS);
    tui.feed("\r");
    expect(picks).toEqual(["/approve deny"]);
    expect(tui.frame()).not.toContain("Subagent bg-1 asks");
  });

  it("still picks an exact name match", () => {
    const picks: string[] = [];
    const tui = fakeTui((line) => picks.push(line));
    tui.setChoices("Approve bash? ls", APPROVAL_ROWS);
    tui.feed("Approve once\r");
    expect(picks).toEqual(["/approve once"]);
    expect(tui.frame()).not.toContain("Approve bash?");
  });

  it("still picks via arrow navigation", () => {
    const picks: string[] = [];
    const tui = fakeTui((line) => picks.push(line));
    tui.setChoices("Approve bash? ls", APPROVAL_ROWS);
    tui.feed("\x1b[B\r");
    expect(picks).toEqual(["/approve once"]);
  });
});

describe("parent mid-stream approval polling", () => {
  let root: string;
  const mainTs = new URL("../../../agent-core/main.ts", import.meta.url).pathname;
  const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-poll-")));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function sseEvent(value: unknown): string {
    return `data: ${JSON.stringify(value)}\n\n`;
  }

  function toolCallBody(id: string, toolName: string, args: string): string {
    return [
      sseEvent({ type: "message_start", message: { usage: {} } }),
      sseEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: toolName, input: {} } }),
      sseEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }),
      sseEvent({ type: "content_block_stop", index: 0 }),
      sseEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
      sseEvent({ type: "message_stop" }),
    ].join("");
  }

  function finalBody(text: string): string {
    return [
      sseEvent({ type: "message_start", message: { usage: {} } }),
      sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
      sseEvent({ type: "content_block_stop", index: 0 }),
      sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
      sseEvent({ type: "message_stop" }),
    ].join("");
  }

  it("denies a mid-stream child request in seconds, before the parent turn ends", async () => {
    const dir = join(root, "poll-midstream");
    mkdirSync(dir, { recursive: true });
    const terminalId = "term-poll";
    const runId = "bg-1";
    const childTid = `sub-${terminalId}-${runId}`;
    const sessionId = `${terminalId}-session`;
    const sessionFile = join(dir, sessionId, "current", "session.jsonl");
    const spawnBody = toolCallBody("call-1", "spawn_subagent", JSON.stringify({ task: "background job" }));
    const doneBody = finalBody("parent done");
    // The second model turn streams slowly: without a mid-stream poller the
    // headless deny would never land before the run settles.
    const slowMs = 6000;
    const childScript = `
      globalThis.fetch = async (input) => {
        if (String(input) === "https://models.dev/api.json") {
          return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
        }
        globalThis.__n = (globalThis.__n ?? 0) + 1;
        if (globalThis.__n === 1) {
          return new Response(${JSON.stringify(spawnBody)}, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        await new Promise((r) => setTimeout(r, ${slowMs}));
        return new Response(${JSON.stringify(doneBody)}, { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      process.argv = [process.execPath, ${JSON.stringify(mainTs)}, "-p", "do work"];
      await import(${JSON.stringify(mainUrl)});
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", childScript],
      {
        cwd: dir,
        env: {
          ...process.env,
          TERMINA_CORE_TEST: "1",
          TERMINA_CORE_PROVIDER: "anthropic",
          TERMINA_CORE_MODEL: "claude-sonnet-4-5",
          ANTHROPIC_API_KEY: "subagent-poll-test-key",
          TERMINA_EVENTS_DIR: dir,
          TERMINA_TERMINAL_ID: terminalId,
          TERMINA_CORE_SESSION_ID: sessionId,
          TERMINA_CORE_SESSION_FILE: sessionFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const ackTimer = setInterval(() => {
      try {
        const rows = readFileSync(join(dir, `${terminalId}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
        for (const row of rows) {
          if ((row.t === "preflight_request" || row.t === "checkpoint_request") && row.requestId) {
            const ackName = `ack-${terminalId}-${row.requestId}.json`;
            if (!existsSync(join(dir, ackName))) {
              writeFileSync(join(dir, ackName), JSON.stringify({ ok: true }), { mode: 0o600 });
            }
          }
        }
      } catch {
        /* Wait for the sidecar. */
      }
    }, 10);
    const exitPromise = new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(-1);
      }, 55000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    try {
      // Wait for the spawn to land: the slow second turn is now in flight.
      const taskFile = join(dir, `subagent-${terminalId}-${runId}.task.json`);
      const spawnDeadline = Date.now() + 15000;
      while (!existsSync(taskFile)) {
        if (Date.now() >= spawnDeadline) throw new Error(`spawn never landed; output=${output}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 500));
      const reqId = "appr-polltest1";
      const written = writeSubagentApprovalRequest(dir, terminalId, runId, { reqId, kind: "bash", text: "ls mid-stream" });
      expect(written.ok).toBe(true);
      const requestedAt = Date.now();
      const ackFile = join(dir, `ack-${childTid}-${reqId}.json`);
      const ackDeadline = requestedAt + 4000;
      while (!existsSync(ackFile)) {
        if (Date.now() >= ackDeadline) {
          const names = (() => { try { return readdirSync(dir).join(","); } catch { return "(unreadable)"; } })();
          throw new Error(`mid-stream ack never landed within 4s; files=${names}; output=${output}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      const elapsed = Date.now() - requestedAt;
      expect(elapsed).toBeLessThan(slowMs);
      expect(JSON.parse(readFileSync(ackFile, "utf8"))).toMatchObject({ ok: false });
      const exit = await exitPromise;
      expect(exit).toBe(0);
    } finally {
      clearInterval(ackTimer);
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      await exitPromise.catch(() => null);
    }
  }, 60000);
});
