import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const TEST_PROVIDER_TURN_CAP = 80;

type Row = Record<string, any>;
function jsonLines(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** Real kernel + real local tools, mocked provider only. Every file and process
 * belongs to this fixture, including HOME, authentication, events and traces. */
async function scenario(toolProgram: string, check: (result: {
  root: string; output: string; messages: Row[]; requests: Row[]; traces: Row[]; events: Row[];
}) => void, timeoutMs = 40_000, extraFiles: Record<string, string> = {}, textProgram = 'return "finished";'): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "termina-tool-loop-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const events = join(root, "events");
  for (const dir of [project, home, events]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "file.txt"), "original\n");
  for (const [name, content] of Object.entries(extraFiles)) writeFileSync(join(project, name), content);
  const terminalId = "term-tool-loop";
  const sessionId = "core-tool-loop";
  const sessionFile = join(events, sessionId, "current", "session.jsonl");
  const requestsFile = join(root, "requests.jsonl");
  const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
  const script = `
    import { appendFileSync } from "node:fs";
    let turn = 0;
    const toolsFor = (turn) => { ${toolProgram} };
    const textFor = (turn) => { ${textProgram} };
    globalThis.fetch = async (input, init) => {
      if (String(input) === "https://models.dev/api.json") return new Response("{}", { status: 200 });
      if (++turn > ${TEST_PROVIDER_TURN_CAP}) throw new Error("test provider request safety bound");
      appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(JSON.parse(init.body)) + "\\n");
      const tools = toolsFor(turn);
      const items = tools.map((tool, i) => ({ type: "function_call", id: "item-" + turn + "-" + i,
        call_id: tool.id ?? "call-" + turn + "-" + i, name: tool.name, arguments: JSON.stringify(tool.input) }));
      const events = items.map((item) => ({ type: "response.output_item.done", item }));
      if (!items.length) events.push({ type: "response.output_text.delta", delta: textFor(turn) });
      events.push({ type: "response.completed", response: { status: "completed", output: items,
        usage: { input_tokens: 3000 + turn, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } });
      return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\\n\\n").join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", "tool lifecycle regression"];
    await import(${JSON.stringify(mainUrl)});
  `;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(TERMINA_|PI_SESSION_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
  Object.assign(env, {
    HOME: home, TERMINA_AUTH_PATH: join(home, "auth.json"), TERMINA_CORE_TEST: "1",
    TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", OPENAI_API_KEY: "test-only",
    TERMINA_CORE_APPROVE: "all", TERMINA_EVENTS_DIR: events, TERMINA_TERMINAL_ID: terminalId,
    TERMINA_CORE_SESSION_ID: sessionId, TERMINA_CORE_SESSION_FILE: sessionFile,
  });
  const child = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", script], {
    cwd: project, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const acked = new Set<string>();
  const ackTimer = setInterval(() => {
    for (const record of jsonLines(join(events, `${terminalId}.jsonl`))) {
      if (!["preflight_request", "checkpoint_request"].includes(record.t) || !record.requestId || acked.has(record.requestId)) continue;
      writeFileSync(join(events, `ack-${terminalId}-${record.requestId}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
      acked.add(record.requestId);
    }
  }, 10);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const code = await closed;
    expect(timedOut, output).toBe(false);
    expect(code, output).toBe(0);
    const messages = jsonLines(sessionFile).filter((row) => row.type === "message").map((row) => row.message);
    const traceDir = join(events, `${terminalId}.traces`);
    const traces = existsSync(traceDir) ? readdirSync(traceDir).filter((name) => /^turn-\d+\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(traceDir, name), "utf8"))) : [];
    check({ root: project, output, messages, requests: jsonLines(requestsFile), traces, events: jsonLines(join(events, `${terminalId}.jsonl`)) });
  } finally {
    clearTimeout(timeout);
    clearInterval(ackTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

function toolResults(messages: Row[]): Row[] {
  return messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "tool_result");
}
function expectPaired(messages: Row[]): void {
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i]?.role === "assistant" && Array.isArray(messages[i]?.content)
      ? messages[i]!.content.filter((block: Row) => block.type === "tool_use") : [];
    if (!calls.length) continue;
    const results = toolResults([messages[i + 1]!]);
    expect(results.map((block) => block.tool_use_id)).toEqual(calls.map((block: Row) => block.id));
  }
}

describe("real tool loop regressions", () => {
  it("does not attribute ordinary tool-history growth as a prefix flip", async () => {
    await scenario('return turn < 3 ? [{ name: "read_file", input: { path: "file.txt", start_line: turn } }] : [];', (result) => {
      const attempts = result.traces.filter((row) => row.recordType === "attempt" && row.status === "ok")
        .sort((a, b) => a.traceTurn - b.traceTurn);
      expect(attempts).toHaveLength(3);
      expect(attempts[0].cache.comparedPrefixHash).toBeNull();
      for (let i = 1; i < attempts.length; i++) {
        const before = attempts[i - 1].cache, after = attempts[i].cache;
        expect(after.reusablePrefixItems).toBeGreaterThan(before.reusablePrefixItems);
        expect(after.comparedPrefixItems).toBe(before.reusablePrefixItems);
        expect(after.comparedPrefixHash).toBe(before.reusablePrefixHash);
        expect(after.workingSetChanged).toBe(false);
        expect(after.missAttribution.primary).toBe("backend-or-unknown");
        expect(after.missAttribution.contributing).not.toContain("message-prefix-changed");
      }
    });
  });

  it("warns in model-visible history before stopping identical reads with fresh IDs", async () => {
    await scenario('return [{ name: "read_file", input: { path: "file.txt" } }];', (result) => {
      expect(result.requests).toHaveLength(6);
      expect(JSON.stringify(result.requests[3])).toContain("Tool loop detected");
      expect(JSON.stringify(result.requests[3])).toContain("You already have this read_file result");
      expect(JSON.stringify(result.requests[3])).toContain("do not keep re-reading a template");
      expect(JSON.stringify(result.requests[3])).not.toContain("inspect the failed");
      expect(result.traces.some((row) => row.status === "stalled")).toBe(true);
      expect(result.events.find((row) => row.t === "agent_settled")?.error).toContain("stalled");
      expectPaired(result.messages);
    });
  });

  it("stops read/edit self-correction cycles even with changing guessed snippets", async () => {
    await scenario('return turn % 2 ? [{ name: "edit", input: { path: "file.txt", old_text: "guess-" + turn, new_text: "fixed" } }] : [{ name: "read_file", input: { path: "file.txt" } }];', (result) => {
      expect(result.requests).toHaveLength(12);
      expect(JSON.stringify(result.requests[6])).toContain("Tool loop detected");
      expect(readFileSync(join(result.root, "file.txt"), "utf8")).toBe("original\n");
      expectPaired(result.messages);
    });
  });

  it("allows a fresh read and corrected edit after recovery guidance", async () => {
    await scenario(`if (turn <= 3) return [{ name: "edit", input: { path: "file.txt", old_text: "missing", new_text: "fixed" } }];
      if (turn === 4) return [{ name: "read_file", input: { path: "file.txt" } }];
      if (turn === 5) return [{ name: "edit", input: { path: "file.txt", old_text: "original", new_text: "fixed" } }];
      return [];`, (result) => {
      expect(result.requests).toHaveLength(6);
      expect(JSON.stringify(result.requests)).not.toContain("Settle gate");
      expect(result.events.find((row) => row.t === "agent_settled")?.error).toBeNull();
      expect(result.traces.some((row) => row.status === "stalled")).toBe(false);
      expect(readFileSync(join(result.root, "file.txt"), "utf8")).toBe("fixed\n");
      expectPaired(result.messages);
    });
  });

  it("settles when the model finishes after edits, without extra review turns", async () => {
    await scenario(`if (turn === 1) return [{ name: "edit", input: { path: "file.txt", old_text: "original", new_text: "v1" } }];
      if (turn === 2) return [{ name: "edit", input: { path: "file.txt", old_text: "v1", new_text: "v2" } }];
      return [];`, (result) => {
      expect(result.requests).toHaveLength(3);
      expect(JSON.stringify(result.requests)).not.toContain("code-review critic");
      expect(JSON.stringify(result.requests)).not.toContain("Settle gate");
      expect(result.events.find((row) => row.t === "agent_settled")?.error).toBeNull();
      expect(result.traces.some((row) => row.recordType === "attempt" && row.role === "critic")).toBe(false);
      const settled = result.traces.find((row) => row.recordType === "task-settled");
      expect(settled).not.toHaveProperty("critic");
      expect(readFileSync(join(result.root, "file.txt"), "utf8")).toBe("v2\n");
      expectPaired(result.messages);
    });
  });

  it("rejects missing or wrongly typed mutation arguments without changing files", async () => {
    await scenario(`return turn === 1 ? [
      { name: "write_file", input: { path: "file.txt" } },
      { name: "edit", input: { path: "file.txt", old_text: "original" } },
      { name: "edit", input: { path: "file.txt", old_text: "original", new_text: "wrong", replace_all: "true" } },
      { name: "bash", input: { command: ["touch bad"] } }
    ] : [];`, (result) => {
      expect(toolResults(result.messages)).toHaveLength(4);
      expect(toolResults(result.messages).every((row) => row.is_error === true && row.content.includes("invalid tool arguments"))).toBe(true);
      expect(readFileSync(join(result.root, "file.txt"), "utf8")).toBe("original\n");
      expectPaired(result.messages);
    });
  });

  it("orders read/action/read and refuses repeated side effects in one batch", async () => {
    await scenario(`return turn === 1 ? [
      { name: "read_file", input: { path: "file.txt" } },
      { name: "read_file", input: { path: "file.txt" } },
      { name: "bash", input: { command: "sleep 0.05; printf x >> file.txt" } },
      { name: "bash", input: { command: "sleep 0.05; printf x >> file.txt" } },
      { name: "read_file", input: { path: "file.txt" } }
    ] : [];`, (result) => {
      const results = toolResults(result.messages);
      expect(results[0]?.content).toBe(results[1]?.content);
      expect(results[3]?.content).toContain("duplicate action");
      expect(results[3]?.is_error).toBe(true);
      expect(results[4]?.content).toContain("2|x");
      expect(readFileSync(join(result.root, "file.txt"), "utf8")).toBe("original\nx");
      expectPaired(result.messages);
    });
  });

  it("does not cap a long unique-tool run", async () => {
    await scenario(`return turn < 40 ? [{ name: "read_file", input: { path: "file.txt", start_line: turn } }] : [];`, (result) => {
      expect(result.requests).toHaveLength(40);
      expectPaired(result.messages);
    });
  });
});
