import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_SUBAGENT_RESULT_CHARS, parseSubagentResultFrame, resolveSubagentPermissionMode } from "../../../agent-core/subagents.ts";

describe("subagent permission resolution (#206)", () => {
  it("applies ask and dangerous from the validated task file", () => {
    expect(resolveSubagentPermissionMode("ask", undefined)).toBe("ask");
    expect(resolveSubagentPermissionMode("ask", "all")).toBe("ask");
    expect(resolveSubagentPermissionMode("dangerous", undefined)).toBe("dangerous");
    expect(resolveSubagentPermissionMode("dangerous", "all")).toBe("dangerous");
  });

  it("grants always only with the host bridge present", () => {
    expect(resolveSubagentPermissionMode("always", "all")).toBe("always");
    // A forged `always` task file without the host env degrades to ask.
    expect(resolveSubagentPermissionMode("always", undefined)).toBe("ask");
    expect(resolveSubagentPermissionMode("always", "")).toBe("ask");
    expect(resolveSubagentPermissionMode("always", "yes")).toBe("ask");
  });
});

type Row = Record<string, any>;
function jsonLines(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/**
 * Boot a real headless child (`--subagent-task`) with a mocked provider that
 * runs one bash command, then settles. An auto-acker plays the parent: every
 * approval request is granted, so the discriminator is whether the child
 * asked at all (approval request files), which is exactly permissionMode.
 */
async function runChild(opts: {
  taskMode: string;
  approveEnv?: string;
  command: string;
  timeoutMs?: number;
  taskFileBody?: string;
  readOnly?: boolean;
  calls?: Array<{ name: string; input: Record<string, unknown> }>;
  mcp?: boolean;
  reply?: string;
}): Promise<{ code: number | null; output: string; approvals: string[]; frameOk: boolean; result: string | null; requests: Row[]; target: string | null; mcpStarted: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "termina-subagent-perm-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const events = join(root, "events");
  for (const dir of [project, home, events]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "child-target"), "delete me\n");
  const mcpMarker = join(project, "mcp-started");
  if (opts.mcp) {
    const config = join(home, ".termina", "agent");
    mkdirSync(config, { recursive: true });
    const server = join(root, "mcp-server.mjs");
    writeFileSync(server, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(mcpMarker)}, "started"); process.stdin.resume();`);
    writeFileSync(join(config, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server] } } }));
  }
  const parentTid = "term-parent";
  const runId = "bg-1";
  const childTid = `sub-${parentTid}-${runId}`;
  const taskFile = join(events, "task.json");
  writeFileSync(
    taskFile,
    opts.taskFileBody ?? JSON.stringify({
      version: 1,
      runId,
      task: "run one command",
      brief: opts.mcp ? "Use fixture to inspect the project and report." : "Run the command and report.",
      resumeRunId: null,
      provider: "openai",
      model: "gpt-5.6-sol",
      protocol: "openai-responses",
      effort: "medium",
      paths: [],
      permissionMode: opts.taskMode,
      readOnly: opts.readOnly ?? false,
      parentTerminalId: parentTid,
      cwd: project,
      depth: 1,
      userRequested: false,
      createdAt: Date.now(),
    }),
  );
  const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
  const commandJson = JSON.stringify(opts.command);
  const requestsFile = join(root, "requests.jsonl");
  const script = `
    import { appendFileSync } from "node:fs";
    let turn = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input) === "https://models.dev/api.json") return new Response("{}", { status: 200 });
      appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(JSON.parse(init.body)) + "\\n");
      turn += 1;
      const tools = turn === 1
        ? ${opts.calls ? JSON.stringify(opts.calls) : `[{ name: "bash", input: { command: ${commandJson} } }]`}
        : [];
      const items = tools.map((tool, i) => ({ type: "function_call", id: "item-" + turn + "-" + i,
        call_id: "call-" + turn + "-" + i, name: tool.name, arguments: JSON.stringify(tool.input) }));
      const events = items.map((item) => ({ type: "response.output_item.done", item }));
      if (!items.length) events.push({ type: "response.output_text.delta", delta: ${JSON.stringify(opts.reply ?? "finished")} });
      events.push({ type: "response.completed", response: { status: "completed", output: items,
        usage: { input_tokens: 3000 + turn, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } });
      return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\\n\\n").join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "--subagent-task", ${JSON.stringify(taskFile)}];
    await import(${JSON.stringify(mainUrl)});
  `;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(TERMINA_|PI_SESSION_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
  Object.assign(env, {
    HOME: home,
    TERMINA_AUTH_PATH: join(home, "auth.json"),
    TERMINA_CORE_TEST: "1",
    TERMINA_CORE_PROVIDER: "openai",
    TERMINA_CORE_MODEL: "gpt-5.6-sol",
    OPENAI_API_KEY: "test-only",
    TERMINA_EVENTS_DIR: events,
    TERMINA_TERMINAL_ID: childTid,
    TERMINA_CORE_SESSION_ID: "core-subagent-perm",
    TERMINA_CORE_SESSION_FILE: join(events, "core-subagent-perm", "current", "session.jsonl"),
    TERMINA_CORE_SUBAGENT_DEPTH: "1",
  });
  if (opts.approveEnv !== undefined) env.TERMINA_CORE_APPROVE = opts.approveEnv;
  const child = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", script], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // Play the parent: ack preflight/checkpoint requests and grant approvals.
  const acked = new Set<string>();
  const ackTimer = setInterval(() => {
    for (const record of jsonLines(join(events, `${childTid}.jsonl`))) {
      if (!["preflight_request", "checkpoint_request"].includes(record.t) || !record.requestId || acked.has(record.requestId)) continue;
      writeFileSync(join(events, `ack-${childTid}-${record.requestId}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
      acked.add(record.requestId);
    }
    let names: string[] = [];
    try {
      names = readdirSync(events);
    } catch {
      /* events dir appears with the first write */
    }
    for (const name of names) {
      const match = new RegExp(`^subagent-${parentTid}-${runId}\\.approval-([A-Za-z0-9_-]{1,64})\\.json$`).exec(name);
      if (!match || acked.has(name)) continue;
      writeFileSync(join(events, `ack-${childTid}-${match[1]}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
      acked.add(name);
    }
  }, 10);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, opts.timeoutMs ?? 40_000);
  try {
    const code = await closed;
    expect(timedOut, output).toBe(false);
    const approvals = readdirSync(events).filter((n) => n.includes(".approval-"));
    const frame = output.split("\n").map(parseSubagentResultFrame).find(frame => frame !== null);
    return { code, output, approvals, frameOk: frame?.ok === true, result: frame?.result ?? null, requests: jsonLines(requestsFile),
      target: existsSync(join(project, "child-target")) ? readFileSync(join(project, "child-target"), "utf8") : null,
      mcpStarted: existsSync(mcpMarker) };
  } finally {
    clearTimeout(timeout);
    clearInterval(ackTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

describe("headless child permission mode (#206)", () => {
  it("flushes the complete capped result before the headless child exits", async () => {
    const reply = `Observed evidence ${"x".repeat(40_000)}`;
    const result = await runChild({ taskMode: "ask", readOnly: true, command: "", calls: [{ name: "read_file", input: { path: "child-target" } }], reply });
    expect(result.code).toBe(0);
    expect(result.result).toBe(reply.slice(0, MAX_SUBAGENT_RESULT_CHARS));
  });

  it("refuses every action in a read-only child even with full approval, and preserves paired read evidence", async () => {
    const reads = [
      { name: "read_file", input: { path: "child-target" } },
      { name: "read_files", input: { paths: ["child-target"] } },
      { name: "grep", input: { pattern: "delete me", path: "child-target" } },
      { name: "glob", input: { pattern: "child-*" } },
    ];
    const actions = [
      { name: "write_file", input: { path: "child-target", content: "wrong" } },
      { name: "edit", input: { path: "child-target", old_text: "delete me", new_text: "wrong" } },
      { name: "bash", input: { command: "rm child-target" } },
      { name: "fetch", input: { url: "https://example.com" } },
      { name: "browser", input: { action: "open" } },
      { name: "spawn_subagent", input: { task: "write child-target" } },
      { name: "message_subagent", input: { run_id: "bg-1", text: "write child-target" } },
      { name: "search_mcp_tools", input: { query: "write" } },
      { name: "call_mcp_tool", input: { name: "mcp_fixture_write", arguments: {} } },
    ];
    const result = await runChild({ taskMode: "always", approveEnv: "all", readOnly: true, command: "", calls: [...reads, ...actions], mcp: true });
    expect(result.code, result.output).toBe(0);
    expect(result.frameOk, result.output).toBe(true);
    expect(result.target).toBe("delete me\n");
    expect(result.mcpStarted).toBe(false);
    expect(result.approvals).toEqual([]);
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0].tools.map((tool: Row) => tool.name)).toEqual(reads.map(tool => tool.name));
    const outputs = result.requests[1].input.filter((item: Row) => item.type === "function_call_output");
    expect(outputs).toHaveLength(reads.length + actions.length);
    expect(JSON.stringify(outputs[0].output)).toContain("delete me");
    for (const output of outputs.slice(reads.length)) expect(JSON.stringify(output.output)).toContain("not executed in a read-only session");
  });

  it("runs safe commands unasked in dangerous mode", async () => {
    const result = await runChild({ taskMode: "dangerous", command: "echo hi" });
    expect(result.output).not.toContain("timed out");
    expect(result.code, result.output).toBe(0);
    expect(result.frameOk, result.output).toBe(true);
    expect(result.approvals).toEqual([]);
  });

  it("still asks for dangerous commands in dangerous mode", async () => {
    const result = await runChild({ taskMode: "dangerous", command: "rm -f child-target" });
    expect(result.code, result.output).toBe(0);
    expect(result.frameOk, result.output).toBe(true);
    expect(result.approvals.length).toBe(1);
  });

  it("asks for every command in ask mode", async () => {
    const result = await runChild({ taskMode: "ask", command: "echo hi" });
    expect(result.code, result.output).toBe(0);
    expect(result.frameOk, result.output).toBe(true);
    expect(result.approvals.length).toBe(1);
  });

  it("distrusts a forged always task file without the host bridge", async () => {
    const result = await runChild({ taskMode: "always", command: "echo hi" });
    expect(result.code, result.output).toBe(0);
    expect(result.frameOk, result.output).toBe(true);
    // Degraded to ask: the safe command still round-trips to the parent.
    expect(result.approvals.length).toBe(1);
  });

  it("honors always with the host bridge present", async () => {
    const result = await runChild({ taskMode: "always", approveEnv: "all", command: "rm -f child-target" });
    expect(result.code, result.output).toBe(0);
    expect(result.frameOk, result.output).toBe(true);
    expect(result.approvals).toEqual([]);
  });

  it("rejects an oversized task file before parsing (#222)", async () => {
    const result = await runChild({
      taskMode: "ask",
      command: "echo hi",
      taskFileBody: `{"version":1,"padding":"${"p".repeat(70 * 1024)}"}`,
    });
    expect(result.code, result.output).toBe(2);
    expect(result.output).toMatch(/task file exceeds its budget/);
  });
});
