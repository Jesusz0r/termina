import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSubagentPermissionMode } from "../../../agent-core/subagents.ts";

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
}): Promise<{ code: number | null; output: string; approvals: string[]; frameOk: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "termina-subagent-perm-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const events = join(root, "events");
  for (const dir of [project, home, events]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "child-target"), "delete me\n");
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
      brief: "Run the command and report.",
      resumeRunId: null,
      provider: "openai",
      model: "gpt-5.6-sol",
      protocol: "openai-responses",
      effort: "medium",
      paths: [],
      permissionMode: opts.taskMode,
      parentTerminalId: parentTid,
      cwd: project,
      depth: 1,
      userRequested: false,
      createdAt: Date.now(),
    }),
  );
  const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
  const commandJson = JSON.stringify(opts.command);
  const script = `
    import { appendFileSync } from "node:fs";
    let turn = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input) === "https://models.dev/api.json") return new Response("{}", { status: 200 });
      turn += 1;
      const tools = turn === 1
        ? [{ name: "bash", input: { command: ${commandJson} } }]
        : [];
      const items = tools.map((tool, i) => ({ type: "function_call", id: "item-" + turn + "-" + i,
        call_id: "call-" + turn + "-" + i, name: tool.name, arguments: JSON.stringify(tool.input) }));
      const events = items.map((item) => ({ type: "response.output_item.done", item }));
      if (!items.length) events.push({ type: "response.output_text.delta", delta: "finished" });
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
    const frameOk = output.split("\n").some((line) => line.includes("SUBAGENT_RESULT ") && line.includes('"ok":true'));
    return { code, output, approvals, frameOk };
  } finally {
    clearTimeout(timeout);
    clearInterval(ackTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

describe("headless child permission mode (#206)", () => {
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
