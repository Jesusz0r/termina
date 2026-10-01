import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { appendPendingImages, pendingImageState } from "../../../agent-core/host.ts";
import { appendSubagentOutboxMessage } from "../../../agent-core/subagents.ts";
import { OwnedProcessTree } from "../../e2e/owned-processes.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("steering child did not exit")), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

type Row = Record<string, any>;
function rows(file: string): Row[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** Real interactive kernel and tools; mocked provider, plus scoped storage failure when requested. */
async function steeringScenario(
  mode: "stream" | "tool" | "final" | "children" | "server",
  lines: string[],
  check: (result: { project: string; messages: Row[]; requests: Row[]; events: Row[]; output: string }) => void,
  options: {
    initialLine?: string;
    attachImage?: boolean;
    expectedRuns?: number;
    beforePreflight?: boolean;
    failedImage?: boolean;
    failQueuedAdmission?: boolean;
    draftCase?: "typed" | "overflow";
    failedServer?: boolean;
    followUps?: string[];
    replies?: string[];
    toolsByTurn?: Array<Array<{ name: string; input: Record<string, unknown> }>>;
    mcp?: boolean;
    textWithTools?: boolean;
    resetBeforeFollowUp?: "/clear" | "/new";
  } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "termina-steering-"));
  const project = join(root, "project"), home = join(root, "home"), events = join(root, "events");
  for (const dir of [project, home, events]) mkdirSync(dir);
  writeFileSync(join(project, "file.txt"), "original\n");
  if (options.mcp) {
    const config = join(home, ".termina", "agent");
    mkdirSync(config, { recursive: true });
    const server = join(project, "mcp-server.mjs");
    writeFileSync(server, `
      import { createInterface } from "node:readline";
      import { writeFileSync } from "node:fs";
      createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result = {};
        if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1" } };
        if (request.method === "tools/list") result = { tools: [{ name: "write", inputSchema: { type: "object", properties: {} } }] };
        if (request.method === "tools/call") {
          writeFileSync("mcp-called", "executed");
          result = { content: [{ type: "text", text: "executed" }] };
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      });
    `);
    writeFileSync(join(config, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server] } } }));
  }
  const sessionFile = join(events, "core-steering", "current", "session.jsonl");
  const requestsFile = join(root, "requests.jsonl");
  const sidecarFile = join(events, "term-steering.jsonl");
  const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
  const frameFile = join(root, "frame.txt");
  const blockedImageWrites = join(project, "block-image-writes");
  const script = `
    import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
    if (${Boolean(options.failedImage)}) {
      // Persistence now supports more than 99 images. Cause a real write-open failure
      // instead of assuming that occupying a fixed number of names exhausts storage.
      const { default: fs } = await import("node:fs");
      const { syncBuiltinESMExports } = await import("node:module");
      const open = fs.openSync;
      fs.openSync = (path, ...args) => {
        if (String(path).startsWith(${JSON.stringify(join(events, "core-steering", "current", "session-img-"))})
            && args[0] === "wx" && existsSync(${JSON.stringify(blockedImageWrites)})) {
          throw Object.assign(new Error("test image storage denied"), { code: "EACCES" });
        }
        return open(path, ...args);
      };
      syncBuiltinESMExports();
    }
    if (${Boolean(options.draftCase)}) {
      const { AgentTui } = await import(${JSON.stringify(new URL("../../../agent-core/tui.ts", import.meta.url).href)});
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      process.stdin.setRawMode = () => {};
      process.stdout.columns = 120; process.stdout.rows = 40;
      const start = AgentTui.prototype.start;
      AgentTui.prototype.start = function () {
        setInterval(() => {
          writeFileSync(${JSON.stringify(frameFile + ".tmp")}, this.frame());
          renameSync(${JSON.stringify(frameFile + ".tmp")}, ${JSON.stringify(frameFile)});
        }, 10).unref();
        return start.call(this);
      };
    }
    let turn = 0;
    const planReplies = ${JSON.stringify(options.replies ?? null)};
    const scriptedTools = ${JSON.stringify(options.toolsByTurn ?? null)};
    globalThis.fetch = async (input, init) => {
      if (String(input) === "https://models.dev/api.json") return new Response("{}", { status: 200 });
      if (++turn > 8) throw new Error("test request bound exceeded");
      appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(JSON.parse(init.body)) + "\\n");
      if (turn === 1 && ["stream", "final", "server"].includes(${JSON.stringify(mode)})) {
        while (!existsSync("release-stream")) await new Promise(r => setTimeout(r, 10));
      }
      if (${JSON.stringify(mode)} === "server") {
        const pause = ${Boolean(options.failedServer)} ? turn <= 6 : turn === 1;
        const blocks = turn === 1
          ? [{ type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "probe" } }]
          : !${Boolean(options.failedServer)} && turn === 2
            ? [{ type: "web_search_tool_result", tool_use_id: "search-1", content: [] }]
            : [{ type: "text", text: "finished" }];
        const events = [{ type: "message_start", message: { usage: {} } }];
        blocks.forEach((content_block, index) => {
          events.push({ type: "content_block_start", index, content_block });
          if (content_block.type === "server_tool_use") events.push({ type: "content_block_delta", index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(content_block.input) } });
          events.push({ type: "content_block_stop", index });
        });
        events.push({ type: "message_delta", delta: { stop_reason: pause ? "pause_turn" : "end_turn" }, usage: {} }, { type: "message_stop" });
        return new Response(events.map(event => "data: " + JSON.stringify(event) + "\\n\\n").join(""), {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      }
      const calls = scriptedTools ? scriptedTools[turn - 1] ?? [] : turn === 1 && ${JSON.stringify(mode)} === "children" ? [
        { name: "spawn_subagent", input: { task: "first background job" } },
        { name: "spawn_subagent", input: { task: "second background job" } },
      ] : turn === 1 && ${JSON.stringify(mode)} !== "final" ? [
        { name: "bash", input: { command: ${JSON.stringify(mode === "tool"
          ? "touch tool-started; while [ ! -f release-tool ]; do sleep 0.02; done; printf completed > completed.txt"
          : "printf stale > should-not-exist.txt")} } },
        { name: "write_file", input: { path: "should-not-exist.txt", content: "stale action" } },
      ] : [];
      const items = calls.map((call, i) => ({ type: "function_call", id: "item-" + turn + "-" + i,
        call_id: "call-" + turn + "-" + i, name: call.name, arguments: JSON.stringify(call.input) }));
      const events = items.map(item => ({ type: "response.output_item.done", item }));
      const reply = Array.isArray(planReplies) && typeof planReplies[turn - 1] === "string" ? planReplies[turn - 1] : "finished";
      if (!items.length || ${Boolean(options.textWithTools)}) events.unshift({ type: "response.output_text.delta", delta: reply });
      events.push({ type: "response.completed", response: { status: "completed", output: items, usage: {} } });
      return new Response(events.map(event => "data: " + JSON.stringify(event) + "\\n\\n").join(""), {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    };
    process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname];
    await import(${JSON.stringify(mainUrl)});
  `;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(TERMINA_|PI_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, TERMINA_AUTH_PATH: join(home, "auth.json"), TERMINA_CORE_TEST: "1",
    TERMINA_CORE_PROVIDER: mode === "server" ? "anthropic" : "openai",
    TERMINA_CORE_MODEL: mode === "server" ? "claude-sonnet-4-5" : "gpt-5.6-sol",
    OPENAI_API_KEY: "test-only", ANTHROPIC_API_KEY: "test-only",
    TERMINA_CORE_APPROVE: "all", TERMINA_EVENTS_DIR: events, TERMINA_TERMINAL_ID: "term-steering",
    TERMINA_CORE_SESSION_ID: "core-steering", TERMINA_CORE_SESSION_FILE: sessionFile,
  });
  const child = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", script], {
    cwd: project, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  const submitInput = (text: string): void => { child.stdin.write(text.replaceAll("\n", options.draftCase ? "\r" : "\n")); };
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let allowPreflight = !options.beforePreflight;
  let rejectQueuedAdmission = false;
  const ackTimer = setInterval(() => {
    for (const row of rows(sidecarFile)) {
      if (!["preflight_request", "checkpoint_request"].includes(row.t)) continue;
      if (row.t === "preflight_request" && !allowPreflight) continue;
      const secondPreflight = row.t === "preflight_request" && options.failQueuedAdmission
        && rows(sidecarFile).filter(event => event.t === "preflight_request")[1]?.requestId === row.requestId;
      if (secondPreflight && !rejectQueuedAdmission) continue;
      const ack = join(events, `ack-term-steering-${row.requestId}.json`);
      if (!existsSync(ack)) {
        // Match host publication: the child must never observe partial JSON.
        writeFileSync(ack + ".tmp", JSON.stringify(secondPreflight ? { ok: false, error: "test admission failure" } : { ok: true }), { mode: 0o600 });
        renameSync(ack + ".tmp", ack);
      }
    }
    if (mode === "children") {
      for (const id of ["bg-1", "bg-2"]) {
        const prefix = join(events, `subagent-term-steering-${id}`);
        if (!existsSync(`${prefix}.task.json`) || existsSync(`${prefix}.decision.json`)) continue;
        writeFileSync(`${prefix}.decision.json`, JSON.stringify({ version: 1, runId: id, admitted: true, error: null }), { mode: 0o600 });
        writeFileSync(`${prefix}.live`, "", { mode: 0o600 });
      }
    }
  }, 10);
  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`steering fixture did not progress:\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  let owned: OwnedProcessTree | null = null;
  try {
    owned = new OwnedProcessTree(child.pid!);
    await waitFor(() => rows(sidecarFile).some(row => row.t === "session_ready"));
    submitInput((options.initialLine ?? "start work") + "\n");
    await waitFor(() => {
      if (options.beforePreflight) return rows(sidecarFile).some(row => row.t === "preflight_request");
      if (mode === "tool") return existsSync(join(project, "tool-started"));
      if (mode !== "children") return rows(requestsFile).length === 1;
      const traces = join(events, "term-steering.traces");
      if (!existsSync(traces)) return false;
      return readdirSync(traces).filter(name => /^turn-\d+\.json$/.test(name))
        .flatMap(name => rows(join(traces, name))).filter(row => row.recordType === "attempt").length >= 2;
    });
    if (options.attachImage) {
      expect(await appendPendingImages(events, "term-steering", [{ id: "steer", mediaType: "image/png", bytes: Buffer.from("steering image") }]))
        .toMatchObject({ ok: true });
    }
    if (options.failedImage) writeFileSync(blockedImageWrites, "deny image creation");
    if (lines.length > 0) submitInput(lines.join("\n") + "\n");
    await waitFor(() => rows(sidecarFile).filter(row => row.t === "steer_input").length >= Math.min(lines.length, 16));
    allowPreflight = true;
    if (mode === "server" && !options.failedServer) {
      expect(appendSubagentOutboxMessage(events, "term-steering", "bg-1", "child boundary message")).toMatchObject({ ok: true });
    }
    writeFileSync(join(project, mode === "tool" ? "release-tool" : "release-stream"), "");
    if (options.failedServer) {
      await waitFor(() => output.includes("queued messages retained") || rows(sidecarFile).filter(row => row.t === "agent_start").length > 1);
      expect(rows(sidecarFile).filter(row => row.t === "agent_start")).toHaveLength(1);
      expect(rows(requestsFile)).toHaveLength(6);
      submitInput("\n");
      await waitFor(() => output.split("queued messages retained").length >= 3);
      expect(rows(requestsFile)).toHaveLength(6);
    }
    if (options.failQueuedAdmission) {
      await waitFor(() => rows(sidecarFile).filter(row => row.t === "preflight_request").length === 2);
      const draft = options.draftCase === "typed" ? "new unsubmitted draft" : "admission-message-16-end";
      if (options.draftCase === "typed") child.stdin.write(draft);
      else {
        submitInput(Array.from({ length: 16 }, (_, i) => `admission-message-${i + 1}-end`).join("\n") + "\n");
        await waitFor(() => rows(sidecarFile).filter(row => row.t === "steer_input").length >= 17 || output.includes("message queue full"));
      }
      if (options.draftCase) await waitFor(() => existsSync(frameFile) && readFileSync(frameFile, "utf8").includes(`> ${draft}`));
      rejectQueuedAdmission = true;
      await waitFor(() => output.includes("queued messages retained"));
      if (options.draftCase) {
        await waitFor(() => readFileSync(frameFile, "utf8").includes("queued messages retained"));
        expect(readFileSync(frameFile, "utf8")).toContain(`> ${draft}`);
        child.stdin.write("\x15");
      }
      submitInput("\n");
    }
    if (options.failedImage) {
      await waitFor(() => output.includes("queued messages retained"));
      expect(rows(sidecarFile).filter(row => row.t === "agent_start")).toHaveLength(1);
      expect(rows(requestsFile)).toHaveLength(1);
      // An explicit retry while the failure persists must retain the head too.
      child.stdin.write("\n");
      await waitFor(() => output.split("queued messages retained").length >= 3);
      expect(rows(sidecarFile).filter(row => row.t === "agent_start")).toHaveLength(1);
      rmSync(blockedImageWrites);
      child.stdin.write("\n");
    }
    if (mode === "children") {
      await waitFor(() => rows(requestsFile).length >= 3);
      expect(rows(sidecarFile).filter(row => row.t === "agent_settled")).toHaveLength(0);
      for (const id of ["bg-1", "bg-2"]) {
        writeFileSync(join(events, `subagent-term-steering-${id}.result.json`), JSON.stringify({
          version: 1, runId: id, outcome: "settled", result: "done", error: null, flags: [], touched: [], settledAt: 1,
        }), { mode: 0o600 });
      }
    }
    let followUpRun = 1;
    for (const followUp of options.followUps ?? []) {
      await waitFor(() => rows(sidecarFile).filter(row => row.t === "checkpoint_result").length >= followUpRun);
      if (followUpRun === 1 && options.resetBeforeFollowUp) {
        // checkpoint_result precedes async trace settlement; /clear is only
        // admitted once the final non-TTY prompt confirms the engine is idle.
        await waitFor(() => output.endsWith("\n> "));
        submitInput(options.resetBeforeFollowUp + "\n");
        await waitFor(() => output.includes("session cleared"));
      }
      submitInput(followUp + "\n");
      followUpRun += 1;
    }
    await waitFor(() => rows(sidecarFile).filter(row => row.t === "agent_settled").length === (options.expectedRuns ?? 1));
    // Wait for checkpoint/trace settlement before shutting down the interactive process.
    await waitFor(() => rows(sidecarFile).filter(row => row.t === "checkpoint_result").length === (options.expectedRuns ?? 1) - (options.failedImage ? 1 : 0));
    if (options.attachImage) expect(await pendingImageState(events, "term-steering")).toMatchObject({ count: 0 });
    submitInput("/exit\n");
    expect(await withDeadline(closed, 5_000), output).toBe(0);
    check({
      project, output, requests: rows(requestsFile), events: rows(sidecarFile),
      messages: rows(sessionFile).filter(row => row.type === "message").map(row => row.message),
    });
  } finally {
    clearInterval(ackTimer);
    // Tools have detached process groups: releasing gates and stopping the
    // owned descendants must precede deleting the project, even on failure.
    writeFileSync(join(project, "release-tool"), "");
    writeFileSync(join(project, "release-stream"), "");
    owned?.capture();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await owned?.stop();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await withDeadline(closed, 5_000);
    rmSync(root, { recursive: true, force: true });
  }
}

function toolResults(messages: Row[]): Row[] {
  return messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === "tool_result");
}

function expectOneRun(events: Row[]): void {
  expect(events.filter(row => row.t === "agent_start")).toHaveLength(1);
  expect(events.filter(row => row.t === "agent_settled")).toHaveLength(1);
  expect(events.filter(row => row.t === "preflight_request")).toHaveLength(1);
}

function expectPaired(messages: Row[]): Row[] {
  const index = messages.findIndex(message => message.role === "assistant"
    && Array.isArray(message.content) && message.content.some((block: Row) => block.type === "tool_use"));
  const calls = messages[index].content.filter((block: Row) => block.type === "tool_use");
  const results = messages[index + 1].content.filter((block: Row) => block.type === "tool_result");
  expect(results.map((block: Row) => block.tool_use_id)).toEqual(calls.map((block: Row) => block.id));
  return results;
}

describe("interactive conversation steering", () => {
  it("keeps multiple messages in order and skips stale tools returned by an in-flight model call", async () => {
    await steeringScenario("stream", ["change direction", "also inspect @file.txt"], ({ project, requests, messages, events }) => {
      expectOneRun(events);
      expect(requests).toHaveLength(2);
      const request = JSON.stringify(requests[1]);
      expect(request).toContain("change direction");
      expect(request).toContain("also inspect");
      expect(request.indexOf("change direction")).toBeLessThan(request.indexOf("also inspect"));
      expect(request).toContain("original");
      for (const text of ["change direction", "also inspect"]) {
        expect(messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes(text))).toHaveLength(1);
      }
      expect(existsSync(join(project, "should-not-exist.txt"))).toBe(false);
      expect(expectPaired(messages).every(result => result.is_error && /steer/i.test(result.content))).toBe(true);
    });
  });

  it("finishes the active tool, pairs skipped results, then steers before another tool starts", async () => {
    await steeringScenario("tool", ["stop editing and explain"], ({ project, requests, messages, events }) => {
      expectOneRun(events);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain("stop editing and explain");
      expect(readFileSync(join(project, "completed.txt"), "utf8")).toBe("completed");
      expect(existsSync(join(project, "should-not-exist.txt"))).toBe(false);
      const results = expectPaired(messages);
      expect(results[0].is_error).not.toBe(true);
      expect(results[1]).toMatchObject({ is_error: true });
      expect(results[1].content).toMatch(/steer/i);
    });
  });

  it("does not settle ahead of a message received during the final response", async () => {
    await steeringScenario("final", ["answer this too"], ({ requests, events }) => {
      expectOneRun(events);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].input)).toContain("answer this too");
    });
  });

  it("delivers pending images with the first steering message and acknowledges their persisted copy", async () => {
    await steeringScenario("final", ["explain this image", "use plain language"], ({ requests, messages, events }) => {
      expectOneRun(events);
      expect(JSON.stringify(requests[0].input)).not.toContain("input_image");
      expect(JSON.stringify(requests[1].input)).toContain("data:image/png;base64," + Buffer.from("steering image").toString("base64"));
      const steered = messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("explain this image"));
      expect(steered).toHaveLength(1);
      expect(steered[0].content.some((block: Row) => block.type === "image")).toBe(true);
      const next = messages.find(message => message.role === "user" && JSON.stringify(message.content).includes("use plain language"));
      expect(JSON.stringify(next)).not.toContain('"type":"image"');
    }, { attachImage: true });
  });

  it("wakes a parent waiting for live children without waiting for their results", async () => {
    await steeringScenario("children", ["reconsider while the children work"], ({ requests, events }) => {
      expectOneRun(events);
      expect(JSON.stringify(requests[2].input)).toContain("reconsider while the children work");
    });
  });

  it("publishes /plan follow-ups until a reply contains a task list", async () => {
    const list = "Plan:\n- [ ] edit src/auth.ts\n";
    await steeringScenario("final", [], ({ requests, events }) => {
      expect(events.filter(row => row.t === "agent_start")).toHaveLength(3);
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[0].input)).toContain("Write a Plan Board list. Do not implement.");
      const feature = JSON.stringify(requests[1].input.at(-1));
      const thanks = JSON.stringify(requests[2].input.at(-1));
      expect(feature).toContain("feature");
      expect(feature).not.toContain("Write a Plan Board list");
      expect(thanks).toContain("thanks");
      expect(thanks).not.toContain("Write a Plan Board list");
      expect(events.filter(row => row.t === "plan").map(row => row.text)).toEqual([
        "What should I plan?",
        list,
      ]);
    }, {
      initialLine: "/plan",
      followUps: ["feature", "thanks"],
      replies: ["What should I plan?", list, "implemented"],
      expectedRuns: 3,
    });
  });

  it("stops plan publishing once the /plan reply contains a task list", async () => {
    const list = "Plan:\n- [ ] edit src/auth.ts\n";
    await steeringScenario("final", [], ({ requests, events }) => {
      expect(requests).toHaveLength(2);
      const followUp = JSON.stringify(requests[1].input.at(-1));
      expect(followUp).toContain("now implement");
      expect(followUp).not.toContain("Write a Plan Board list");
      expect(events.filter(row => row.t === "plan").map(row => row.text)).toEqual([list]);
    }, {
      initialLine: "/plan fix auth",
      followUps: ["now implement"],
      replies: [list, "done"],
      expectedRuns: 2,
    });
  });

  it("publishes prose from an immediate /plan turn without detecting a task list", async () => {
    await steeringScenario("final", [], ({ requests, messages, events }) => {
      expectOneRun(events);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0].input)).toContain("Write a Plan Board list. Do not implement.");
      expect(JSON.stringify(requests[0].input)).toContain("clarify scope");
      expect(JSON.stringify(messages)).not.toContain("/plan clarify scope");
      expect(events.filter(row => row.t === "plan").map(row => row.text)).toEqual(["finished"]);
    }, { initialLine: "/plan clarify scope" });
  });

  it("does not publish ordinary assistant replies as plan events", async () => {
    await steeringScenario("final", [], ({ requests, events }) => {
      expectOneRun(events);
      expect(requests).toHaveLength(1);
      expect(events.filter(row => row.t === "plan")).toEqual([]);
    });
  });

  it("keeps queued slash-command expansion and does not let later text jump ahead", async () => {
    await steeringScenario("final", ["/plan revised approach", "include tests"], ({ requests, messages, events }) => {
      expect(events.filter(row => row.t === "agent_start")).toHaveLength(2);
      expect(requests).toHaveLength(2);
      const request = JSON.stringify(requests[1].input);
      expect(request).toContain("Write a Plan Board list. Do not implement.");
      expect(request).toContain("revised approach");
      expect(request.indexOf("revised approach")).toBeLessThan(request.indexOf("include tests"));
      expect(JSON.stringify(messages)).not.toContain("/plan revised approach");
      expect(events.filter(row => row.t === "plan").map(row => row.text)).toEqual(["finished"]);
      const secondStart = events.map(row => row.t).lastIndexOf("agent_start");
      expect(events.slice(0, secondStart).some(row => row.t === "plan")).toBe(false);
      expect(events.slice(secondStart + 1).some(row => row.t === "steer_input")).toBe(true);
    }, { expectedRuns: 2 });
  });

  it("invalidates replay for input queued before the receiving run starts", async () => {
    await steeringScenario("final", ["use the revised request"], ({ requests, events }) => {
      expectOneRun(events);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0].input)).toContain("use the revised request");
      const started = events.findIndex(row => row.t === "agent_start");
      expect(events.slice(0, started).some(row => row.t === "steer_input")).toBe(true);
      expect(events.slice(started + 1).some(row => row.t === "steer_input")).toBe(true);
    }, { beforePreflight: true });
  });

  it("retains both messages across failed image admission and explicit retry", async () => {
    await steeringScenario("final", ["first retained message", "second retained message"], ({ messages, requests, events }) => {
      expect(events.filter(row => row.t === "agent_start")).toHaveLength(2);
      expect(requests).toHaveLength(2);
      const delivered = messages.filter(message => message.role === "user")
        .flatMap(message => typeof message.content === "string" ? [message.content]
          : message.content.filter((block: Row) => block.type === "text").map((block: Row) => block.text));
      expect(delivered.filter(text => text.includes("retained message"))).toEqual(["first retained message", "second retained message"]);
    }, { attachImage: true, failedImage: true, expectedRuns: 2 });
  });

  it("holds steering and child messages until a paused server tool is answered", async () => {
    await steeringScenario("server", ["steer after search"], ({ requests, messages, events, output }) => {
      expectOneRun(events);
      expect(requests, output).toHaveLength(3);
      expect(JSON.stringify(requests[1].messages)).not.toContain("steer after search");
      expect(JSON.stringify(requests[1].messages)).not.toContain("child boundary message");
      expect(JSON.stringify(requests[2].messages)).toContain("steer after search");
      expect(JSON.stringify(requests[2].messages)).toContain("child boundary message");
      expect(messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("child boundary message"))).toHaveLength(1);
    });
  });

  it("retains steering after the server continuation limit instead of corrupting the next run", async () => {
    await steeringScenario("server", ["retained after server pause"], ({ messages, events, output }) => {
      expectOneRun(events);
      expect(JSON.stringify(messages)).not.toContain("retained after server pause");
      expect(output).toContain("provider tool response is unfinished");
    }, { failedServer: true });
  });

  it.each(["typed", "overflow"] as const)("preserves the %s draft when queued admission fails", async (draftCase) => {
    await steeringScenario("final", ["/plan queued plan"], ({ requests, messages, events }) => {
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain("queued plan");
      expect(JSON.stringify(requests[1])).not.toContain("new unsubmitted draft");
      const planPrompts = messages.filter(message => message.role === "user"
        && JSON.stringify(message.content).includes("Write a Plan Board list. Do not implement."));
      expect(planPrompts).toHaveLength(1);
      expect(JSON.stringify(planPrompts[0])).not.toContain("/plan queued plan");
      expect(events.filter(row => row.t === "preflight_request")).toHaveLength(3);
      expect(events.filter(row => row.t === "plan").map(row => row.text)).toEqual(["finished"]);
    }, { failQueuedAdmission: true, draftCase, expectedRuns: 2 });
  });

  it("reserves queue capacity while a queued prompt awaits admission", async () => {
    await steeringScenario("final", ["/plan queued plan"], ({ messages, output }) => {
      expect(output).toContain("message queue full");
      const delivered = JSON.stringify(messages);
      for (let i = 1; i <= 15; i++) expect(delivered).toContain(`admission-message-${i}-end`);
      expect(delivered).not.toContain("admission-message-16-end");
    }, { failQueuedAdmission: true, expectedRuns: 2 });
  });

  it("rejects overflow explicitly without replacing any of the sixteen accepted messages", async () => {
    const lines = Array.from({ length: 17 }, (_, i) => `steering-message-${i + 1}-end`);
    await steeringScenario("final", lines, ({ messages, output, events }) => {
      expectOneRun(events);
      expect(output).toContain("message queue full — not submitted");
      const delivered = messages.filter(message => message.role === "user")
        .flatMap(message => typeof message.content === "string" ? [message.content]
          : message.content.filter((block: Row) => block.type === "text").map((block: Row) => block.text));
      expect(delivered.slice(1)).toEqual(lines.slice(0, 16));
    });
  });
});

describe("/plan tool admission", () => {
  it("allows reads and discovery but refuses every effectful entry even after publishing a list", async () => {
    const allowed = [
      { name: "read_file", input: { path: "file.txt" } },
      { name: "read_files", input: { paths: ["file.txt"] } },
      { name: "grep", input: { pattern: "original", path: "file.txt" } },
      { name: "glob", input: { pattern: "*.txt" } },
      { name: "search_mcp_tools", input: { query: "fixture" } },
    ];
    const denied = [
      { name: "write_file", input: { path: "created.txt", content: "wrong" } },
      { name: "edit", input: { path: "file.txt", old_text: "original", new_text: "wrong" } },
      { name: "bash", input: { command: "printf wrong > bash-called" } },
      { name: "spawn_subagent", input: { task: "write created.txt", paths: ["created.txt"] } },
      { name: "message_subagent", input: { run_id: "bg-1", text: "write created.txt" } },
      { name: "call_mcp_tool", input: { name: "mcp_fixture_write", arguments: {} } },
    ];
    const actions = denied;
    await steeringScenario("final", [], ({ project, requests, messages, events }) => {
      expect(requests).toHaveLength(3);
      for (const action of actions) expect(requests[0].tools.some((tool: Row) => tool.name === action.name)).toBe(true);
      const results = toolResults(messages);
      expect(results).toHaveLength(allowed.length + actions.length + 1);
      for (const result of results.slice(0, allowed.length)) expect(result.is_error, result.content).not.toBe(true);
      expect(results[0].content).toContain("original");
      expect(results[2].content).toContain("original");
      expect(results[4].content).toContain("mcp_fixture_write");
      for (const result of results.slice(allowed.length)) {
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("not executed on a /plan turn");
      }
      expect(readFileSync(join(project, "file.txt"), "utf8")).toBe("original\n");
      for (const file of ["created.txt", "second.txt", "bash-called", "mcp-called"]) {
        expect(existsSync(join(project, file)), file).toBe(false);
      }
      expect(events.some(row => row.t === "subagent_spawn")).toBe(false);
      const ends = events.filter(row => row.t === "tool_end");
      for (const end of ends.slice(allowed.length)) expect(end.isError).toBe(true);
      expect(events.filter(row => row.t === "plan")[0].text).toContain("Plan:");
      expect(expectPaired(messages)).toHaveLength(allowed.length + actions.length);
    }, {
      initialLine: "/plan inspect file.txt", mcp: true, textWithTools: true,
      replies: ["Plan:\n- [ ] edit file.txt\n"],
      toolsByTurn: [[...allowed, ...actions], [{ name: "write_file", input: { path: "second.txt", content: "wrong" } }], []],
    });
  });

  it.each(["What should I plan?", "Plan:\n- [ ] edit file.txt\n"])("does not lock the next implementation submit after %j", async reply => {
    await steeringScenario("final", [], ({ project, requests, messages, events }) => {
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[1].input.at(-1))).toContain("implement now");
      expect(readFileSync(join(project, "file.txt"), "utf8")).toBe("implemented");
      const results = toolResults(messages);
      expect(results).toHaveLength(2);
      expect(results.every(result => result.is_error !== true)).toBe(true);
      expect(results[1].content).toContain("[exit 0]");
      if (reply.startsWith("What")) expect(events.filter(row => row.t === "plan").length).toBeGreaterThan(1);
    }, {
      initialLine: "/plan", followUps: ["implement now"], expectedRuns: 2, replies: [reply],
      toolsByTurn: [[], [
        { name: "write_file", input: { path: "file.txt", content: "implemented" } },
        { name: "bash", input: { command: "test \"$(cat file.txt)\" = implemented" } },
      ], []],
    });
  });

  it("clears the refusal when a new non-plan steering message becomes durable", async () => {
    await steeringScenario("final", ["implement now"], ({ project, requests, messages, events }) => {
      expectOneRun(events);
      expect(requests).toHaveLength(3);
      expect(readFileSync(join(project, "file.txt"), "utf8")).toBe("implemented");
      const results = toolResults(messages);
      expect(results[0]).toMatchObject({ is_error: true });
      expect(results[0].content).toContain("steering");
      expect(results[1].is_error).not.toBe(true);
    }, {
      initialLine: "/plan", toolsByTurn: [
        [{ name: "write_file", input: { path: "file.txt", content: "stale" } }],
        [{ name: "write_file", input: { path: "file.txt", content: "implemented" } }], [],
      ],
    });
  });

  it("applies the refusal when a queued /plan command is eventually rewritten", async () => {
    await steeringScenario("final", ["/plan queued"], ({ project, messages }) => {
      expect(readFileSync(join(project, "file.txt"), "utf8")).toBe("original\n");
      const results = toolResults(messages);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ is_error: true });
      expect(results[0].content).toContain("not executed on a /plan turn");
    }, { expectedRuns: 2, toolsByTurn: [[], [{ name: "write_file", input: { path: "file.txt", content: "wrong" } }], []] });
  });

  it.each(["/clear", "/new"] as const)("clears pending planning state with %s before a normal request", async resetBeforeFollowUp => {
    await steeringScenario("final", [], ({ project, requests, events }) => {
      expect(readFileSync(join(project, "file.txt"), "utf8")).toBe("implemented");
      expect(JSON.stringify(requests[1].input)).not.toContain("Write a Plan Board list");
      expect(events.filter(row => row.t === "plan").map(row => row.text)).toEqual(["What should I plan?"]);
    }, {
      initialLine: "/plan", followUps: ["implement now"], resetBeforeFollowUp, expectedRuns: 2, replies: ["What should I plan?"],
      toolsByTurn: [[], [{ name: "write_file", input: { path: "file.txt", content: "implemented" } }], []],
    });
  });
});
