import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 3 approval flows through a real headless engine child (mocked
 * provider): the child asks, the test answers like a parent picker, the
 * command runs. Deny-by-default and Mine inheritance need no answer.
 */
describe("Subagent Approval Engine Contract", () => {
  let root: string;
  const mainTs = new URL("../../../agent-core/main.ts", import.meta.url).pathname;
  const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;

  beforeAll(() => {
    // Canonicalize: /var is a symlink to /private/var and the engine
    // resolves the cwd, so unresolved fixture paths would never match.
    root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-approval-")));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function sseEvent(value: unknown): string {
    return `data: ${JSON.stringify(value)}\n\n`;
  }

  function toolCallBody(id: string, toolName: string, args: string): string {
    return toolCallsBody([{ id, name: toolName, args }]);
  }

  function toolCallsBody(calls: Array<{ id: string; name: string; args: string }>): string {
    const blocks = calls.flatMap((call, index) => [
      sseEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } }),
      sseEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: call.args } }),
      sseEvent({ type: "content_block_stop", index }),
    ]);
    return [
      sseEvent({ type: "message_start", message: { usage: {} } }),
      ...blocks,
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

  async function runChild(opts: {
    name: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    answerApproval: boolean;
    approvalTimeoutMs: number;
    inbox?: string[];
    /** Written by the child during its first model call, after the turn-start drain. */
    lateInbox?: string;
    setup?: (dir: string) => void;
  }): Promise<{ exit: number | null; output: string; dir: string }> {
    const dir = join(root, opts.name);
    mkdirSync(dir, { recursive: true });
    opts.setup?.(dir);
    if (opts.inbox) {
      const { appendSubagentInboxMessage } = await import("../../../agent-core/subagents.ts");
      for (const text of opts.inbox) appendSubagentInboxMessage(dir, "term-rt", "bg-1", text);
    }
    const parentTid = "term-rt";
    const runId = "bg-1";
    const childTid = `sub-${parentTid}-${runId}`;
    const sessionId = `${childTid}-session`;
    const sessionFile = join(dir, sessionId, "current", "session.jsonl");
    const taskPath = join(dir, `subagent-${parentTid}-${runId}.task.json`);
    writeFileSync(
      taskPath,
      JSON.stringify({
        version: 1,
        runId,
        task: "do the approved thing",
        brief: "do the approved thing",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        protocol: "anthropic-messages",
        effort: "off",
        paths: [],
        permissionMode: "ask",
        parentTerminalId: parentTid,
        cwd: dir,
        depth: 1,
        createdAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    const toolBody = toolCallBody("call-1", opts.toolName, JSON.stringify(opts.toolArgs));
    const doneBody = finalBody("child done");
    const lateInbox = opts.lateInbox ?? "";
    const firstBody = lateInbox ? finalBody("early answer") : toolBody;
    const restBody = lateInbox ? finalBody("followed parent") : doneBody;
    const subagentsUrl = new URL("../../../agent-core/subagents.ts", import.meta.url).href;
    const lateWrite = lateInbox
      ? `if (globalThis.__calls === 1) {
          const { appendSubagentInboxMessage } = await import(${JSON.stringify(subagentsUrl)});
          const wrote = appendSubagentInboxMessage(${JSON.stringify(dir)}, "term-rt", "bg-1", ${JSON.stringify(lateInbox)});
          if (!wrote.ok) throw new Error(wrote.error);
        }`
      : "";
    const childScript = `
      globalThis.fetch = async (input) => {
        if (String(input) === "https://models.dev/api.json") {
          return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
        }
        globalThis.__calls = (globalThis.__calls ?? 0) + 1;
        ${lateWrite}
        const text = globalThis.__calls === 1 ? ${JSON.stringify(firstBody)} : ${JSON.stringify(restBody)};
        return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      process.argv = [process.execPath, ${JSON.stringify(mainTs)}, "--subagent-task", ${JSON.stringify(taskPath)}];
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
          ANTHROPIC_API_KEY: "subagent-approval-test-key",
          TERMINA_EVENTS_DIR: dir,
          TERMINA_TERMINAL_ID: childTid,
          TERMINA_CORE_SESSION_ID: sessionId,
          TERMINA_CORE_SESSION_FILE: sessionFile,
          TERMINA_SUBAGENT_APPROVAL_TIMEOUT_MS: String(opts.approvalTimeoutMs),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const readJsonLines = () => {
      try {
        return readFileSync(join(dir, `${childTid}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    };
    // Bridge simulator: answer preflight/checkpoint handshakes from the
    // sidecar, and (when asked) approval requests like the picker would.
    const answerTimer = setInterval(() => {
      try {
        for (const row of readJsonLines()) {
          if ((row.t === "preflight_request" || row.t === "checkpoint_request") && row.requestId) {
            const ackName = `ack-${childTid}-${row.requestId}.json`;
            if (!existsSync(join(dir, ackName))) {
              writeFileSync(join(dir, ackName), JSON.stringify({ ok: true }), { mode: 0o600 });
            }
          }
        }
        for (const name of readdirSync(dir)) {
          const match = new RegExp(`^subagent-${parentTid}-${runId}\\.approval-([A-Za-z0-9_-]{1,64})\\.json$`).exec(name);
          if (!match) continue;
          const ackName = `ack-${childTid}-${match[1]}.json`;
          if (opts.answerApproval && !existsSync(join(dir, ackName))) {
            writeFileSync(join(dir, ackName), JSON.stringify({ ok: true }), { mode: 0o600 });
          }
        }
      } catch {
        /* The child may exit mid-scan. */
      }
    }, 25);
    const exit = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(-1);
      }, 55000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        clearInterval(answerTimer);
        resolve(code);
      });
    });
    return { exit, output, dir };
  }

  it("round-trips a bash approval: parent ack runs the command", async () => {
    const sentinel = join(root, "rt-approved.txt");
    if (existsSync(sentinel)) rmSync(sentinel);
    const r = await runChild({
      name: "rt-approve-run",
      toolName: "bash",
      toolArgs: { command: `printf RAN > '${join(root, "rt-approved.txt")}'` },
      answerApproval: true,
      approvalTimeoutMs: 30000,
      inbox: ["steer left"],
    });
    expect(r.exit).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("RAN");
    expect(r.output).toContain("SUBAGENT_RESULT");
    expect(r.output).toContain('"ok":true');
    // The pre-delivered parent message reached the child as a user turn.
    const sessionFile = join(r.dir, "sub-term-rt-bg-1-session", "current", "session.jsonl");
    expect(existsSync(sessionFile)).toBe(true);
    expect(readFileSync(sessionFile, "utf8")).toContain("Parent message (seq 1): steer left");
  });

  it("reads a parent message that arrives during the final generation", async () => {
    const r = await runChild({
      name: "rt-late-inbox",
      toolName: "bash",
      toolArgs: { command: "true" },
      answerApproval: false,
      approvalTimeoutMs: 4000,
      lateInbox: "change course now",
    });
    expect(r.exit).toBe(0);
    expect(r.output).toContain('"result":"followed parent"');
    const { readSubagentOutbox } = await import("../../../agent-core/subagents.ts");
    const outbox = readSubagentOutbox(r.dir, "term-rt", "bg-1");
    expect(outbox?.messages.map((m) => m.text)).toEqual(["early answer", "followed parent"]);
    const sessionFile = join(r.dir, "sub-term-rt-bg-1-session", "current", "session.jsonl");
    expect(readFileSync(sessionFile, "utf8")).toContain("Parent message (seq 1): change course now");
  });

  it("denies by default when no ack arrives", async () => {
    const sentinel = join(root, "rt-denied.txt");
    if (existsSync(sentinel)) rmSync(sentinel);
    const r = await runChild({
      name: "rt-deny-run",
      toolName: "bash",
      toolArgs: { command: `printf RAN > '${sentinel}'` },
      answerApproval: false,
      approvalTimeoutMs: 4000,
    });
    expect(r.exit).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    expect(r.output).toMatch(/bash denied/i);
    expect(r.output).toContain("SUBAGENT_RESULT");
    expect(r.output).toContain('"ok":true');
  });

  it("includes sibling claims in later spawns' briefs", async () => {
    const dir = join(root, "rt-brief-run");
    mkdirSync(dir, { recursive: true });
    const sessionId = "term-brief-session";
    const sessionFile = join(dir, sessionId, "current", "session.jsonl");
    const spawnBody = (id: string, task: string, paths: string[]) =>
      ({ id, name: "spawn_subagent", args: JSON.stringify({ task, paths }) });
    const bodies = [
      toolCallsBody([
        spawnBody("call-1", "first job", ["a-claim.ts"]),
        spawnBody("call-2", "second job", ["b-claim.ts"]),
      ]),
      finalBody("parent done"),
    ];
    const childScript = `
      globalThis.fetch = async (input) => {
        if (String(input) === "https://models.dev/api.json") {
          return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
        }
        globalThis.__n = (globalThis.__n ?? 0) + 1;
        const parts = ${JSON.stringify(bodies)};
        return new Response(parts[Math.min(globalThis.__n, parts.length) - 1], {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      process.argv = [process.execPath, ${JSON.stringify(mainTs)}, "-p", "do two things"];
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
          ANTHROPIC_API_KEY: "subagent-brief-test-key",
          TERMINA_EVENTS_DIR: dir,
          TERMINA_TERMINAL_ID: "term-brief",
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
        const rows = readFileSync(join(dir, "term-brief.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
        for (const row of rows) {
          if ((row.t === "preflight_request" || row.t === "checkpoint_request") && row.requestId) {
            writeFileSync(join(dir, `ack-term-brief-${row.requestId}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
          }
        }
        const runIds = ["bg-1", "bg-2"];
        if (!runIds.every((runId) => existsSync(join(dir, `subagent-term-brief-${runId}.task.json`)))) return;
        for (const runId of runIds) {
          const resultName = `subagent-term-brief-${runId}.result.json`;
          if (existsSync(join(dir, resultName))) continue;
          writeFileSync(join(dir, resultName), JSON.stringify({
            version: 1, runId, outcome: "settled", result: "done", error: null, flags: [], touched: [], settledAt: 1,
          }), { mode: 0o600 });
        }
      } catch {
        /* Wait for the sidecar. */
      }
    }, 10);
    const exit = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(-1);
      }, 55000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        clearInterval(ackTimer);
        resolve(code);
      });
    });
    expect(exit).toBe(0);
    const first = readFileSync(join(dir, "subagent-term-brief-bg-1.task.json"), "utf8");
    const second = readFileSync(join(dir, "subagent-term-brief-bg-2.task.json"), "utf8");
    expect(first).not.toContain("Sibling path claims");
    expect(second).toContain("Sibling path claims");
    expect(second).toContain("a-claim.ts");
  });

  it("enforces the parent's Mine marks in the child", async () => {
    const dir = join(root, "rt-mine-run");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "mine-target.txt");
    writeFileSync(target, "original\n");
    const r = await runChild({
      name: "rt-mine-run",
      toolName: "edit",
      toolArgs: { path: "mine-target.txt", old_text: "original", new_text: "changed" },
      answerApproval: false,
      approvalTimeoutMs: 4000,
      setup: (runDir) => {
        writeFileSync(join(runDir, "mine-term-rt.json"), JSON.stringify([target]));
      },
    });
    expect(readFileSync(target, "utf8")).toBe("original\n");
    expect(r.output).toMatch(/protected file edit denied/i);
  });

  it("denies mutations when the Mine policy is corrupt or oversize (#218)", async () => {
    for (const [name, policyBody] of [
      ["rt-mine-corrupt", "not-json{{{"],
      ["rt-mine-oversize", JSON.stringify(["x".repeat(70 * 1024)])],
    ] as const) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, "mine-target.txt");
      writeFileSync(target, "original\n");
      const r = await runChild({
        name,
        toolName: "edit",
        toolArgs: { path: "mine-target.txt", old_text: "original", new_text: "changed" },
        answerApproval: false,
        approvalTimeoutMs: 4000,
        setup: (runDir) => {
          writeFileSync(join(runDir, "mine-term-rt.json"), policyBody);
        },
      });
      expect(readFileSync(target, "utf8"), name).toBe("original\n");
      expect(r.output, name).toMatch(/protected file edit denied/i);
    }
  });

  it("allows mutations when no Mine policy file exists (#218)", async () => {
    const dir = join(root, "rt-mine-absent");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "mine-target.txt");
    writeFileSync(target, "original\n");
    const r = await runChild({
      name: "rt-mine-absent",
      toolName: "edit",
      toolArgs: { path: "mine-target.txt", old_text: "original", new_text: "changed" },
      answerApproval: false,
      approvalTimeoutMs: 4000,
    });
    expect(readFileSync(target, "utf8")).toBe("changed\n");
    expect(r.output).not.toMatch(/protected file edit denied/i);
  });
});
