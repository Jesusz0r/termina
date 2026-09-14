import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaySessionBundle } from "../../../agent-core/session.ts";

type Row = Record<string, any>;
function rows(path: string): Row[] {
  if (!existsSync(path)) return [];
  const out: Row[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Row);
    } catch {
      // The child may still be appending this line.
    }
  }
  return out;
}

// Real multi-prompt kernel and durable receipts; only provider responses are
// synthetic. HOME, sessions, events, files and children all belong to the test.
describe("compaction churn in the main loop", () => {
  it("does not summarize immediately after pruning relieved stale billed pressure", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-compaction-churn-"));
    const project = join(root, "project"), home = join(root, "home"), events = join(root, "events");
    for (const directory of [project, home, events]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(project, "large.txt"), "x".repeat(39_000));
    const terminal = "term-compaction", session = "core-compaction";
    const sessionFile = join(events, session, "current", "session.jsonl");
    const eventFile = join(events, `${terminal}.jsonl`), requestFile = join(root, "requests.jsonl");
    const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
    const script = `
      import { appendFileSync } from "node:fs";
      let turn = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://models.dev/api.json") return new Response("{}");
        const body = JSON.parse(init.body);
        const summary = String(body.instructions).includes("compress coding-agent");
        appendFileSync(${JSON.stringify(requestFile)}, JSON.stringify({ summary }) + "\\n");
        if (!summary && ++turn > 4) throw new Error("fixture request bound");
        const output = !summary && turn === 1 ? [{ type: "function_call", id: "fc-1", call_id: "call-1",
          name: "read_file", arguments: JSON.stringify({ path: "large.txt" }) }] : [];
        const text = summary ? "handoff" : turn === 2 ? "a".repeat(60_000) : turn === 3 ? "b".repeat(80_000) : "done";
        const usage = { input_tokens: !summary && turn === 3 ? 65_000 : 30_000,
          output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
        if (summary) return new Response(JSON.stringify({ status: "completed", output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text }] }
        ], usage }), { headers: { "content-type": "application/json" } });
        const events = output.map(item => ({ type: "response.output_item.done", item }));
        if (!output.length) events.push({ type: "response.output_text.delta", delta: text });
        events.push({ type: "response.completed", response: { status: "completed", output, usage } });
        return new Response(events.map(e => "data: " + JSON.stringify(e) + "\\n\\n").join(""),
          { headers: { "content-type": "text/event-stream" } });
      };
      process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname];
      await import(${JSON.stringify(mainUrl)});
    `;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^(TERMINA_|PI_SESSION_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
    Object.assign(env, {
      HOME: home, TERMINA_AUTH_PATH: join(home, "auth.json"), TERMINA_CORE_TEST: "1",
      TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_CORE_EFFORT: "off",
      TERMINA_CORE_SUMMARY_MODEL: "openai/gpt-5.6-sol", TERMINA_CORE_CONTEXT: "90000", OPENAI_API_KEY: "fixture-only",
      TERMINA_CORE_APPROVE: "all", TERMINA_EVENTS_DIR: events, TERMINA_TERMINAL_ID: terminal,
      TERMINA_CORE_SESSION_ID: session, TERMINA_CORE_SESSION_FILE: sessionFile,
    });
    const child = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", script], {
      cwd: project, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-12_000); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-12_000); });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    const acked = new Set<string>();
    const ackTimer = setInterval(() => {
      for (const row of rows(eventFile)) {
        if (!["preflight_request", "checkpoint_request"].includes(row.t) || !row.requestId || acked.has(row.requestId)) continue;
        writeFileSync(join(events, `ack-${terminal}-${row.requestId}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
        acked.add(row.requestId);
      }
    }, 10);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
    try {
      for (let turn = 1; turn <= 3; turn++) {
        child.stdin.write(`fixture prompt ${turn}\n`);
        await expect.poll(() => rows(eventFile).filter(row => row.t === "agent_settled").length, { timeout: 5_000 }).toBe(turn);
      }
      child.stdin.write("/exit\n");
      expect(await closed, output).toBe(0);
      const revisions = rows(sessionFile).filter(row => row.type === "revision");
      expect(revisions.map(row => row.kind), output).toEqual(["prune"]);
      expect(rows(requestFile).filter(row => row.summary)).toHaveLength(0);
      expect(rows(requestFile).filter(row => !row.summary)).toHaveLength(4);
      const replay = await replaySessionBundle(sessionFile);
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.stubbed))).toBe(true);
      expect(rows(sessionFile).some(row => row.type === "message" && JSON.stringify(row.message).includes("x".repeat(1000)))).toBe(true);
    } finally {
      clearInterval(ackTimer);
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("falls back to the current model when the cheap summary lane 401s", async () => {    const root = mkdtempSync(join(tmpdir(), "termina-summary-fallback-"));
    const project = join(root, "project"), home = join(root, "home"), events = join(root, "events");
    for (const directory of [project, home, events]) mkdirSync(directory, { recursive: true });
    const terminal = "term-summary-fallback", session = "core-summary-fallback";
    const sessionFile = join(events, session, "current", "session.jsonl");
    const eventFile = join(events, `${terminal}.jsonl`), requestFile = join(root, "requests.jsonl");
    const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
    const script = `
      import { appendFileSync } from "node:fs";
      let turn = 0, summaries = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://models.dev/api.json") return new Response("{}");
        const body = JSON.parse(init.body);
        const summary = String(body.instructions).includes("compress coding-agent");
        appendFileSync(${JSON.stringify(requestFile)}, JSON.stringify({ summary, model: body.model }) + "\\n");
        if (summary && ++summaries === 1) return new Response("unauthorized", { status: 401 });
        if (!summary && ++turn > 5) throw new Error("fixture request bound");
        const text = summary ? "handoff" : turn <= 2 ? "a".repeat(40_000) : "done";
        const usage = { input_tokens: !summary && turn === 1 ? 15_000 : 30_000, output_tokens: 10,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
        const events = [{ type: "response.output_text.delta", delta: text }];
        events.push({ type: "response.completed", response: { status: "completed", output: [], usage } });
        return new Response(events.map(e => "data: " + JSON.stringify(e) + "\\n\\n").join(""),
          { headers: { "content-type": "text/event-stream" } });
      };
      process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname];
      await import(${JSON.stringify(mainUrl)});
    `;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^(TERMINA_|PI_SESSION_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
    Object.assign(env, {
      HOME: home, TERMINA_AUTH_PATH: join(home, "auth.json"), TERMINA_CORE_TEST: "1",
      TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_CORE_EFFORT: "off",
      TERMINA_CORE_SUMMARY_MODEL: "openai/gpt-5.6-luna", TERMINA_CORE_CONTEXT: "50000", OPENAI_API_KEY: "fixture-only",
      TERMINA_CORE_APPROVE: "all", TERMINA_EVENTS_DIR: events, TERMINA_TERMINAL_ID: terminal,
      TERMINA_CORE_SESSION_ID: session, TERMINA_CORE_SESSION_FILE: sessionFile,
    });
    const child = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", script], {
      cwd: project, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-12_000); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-12_000); });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    const acked = new Set<string>();
    const ackTimer = setInterval(() => {
      for (const row of rows(eventFile)) {
        if (!["preflight_request", "checkpoint_request"].includes(row.t) || !row.requestId || acked.has(row.requestId)) continue;
        writeFileSync(join(events, `ack-${terminal}-${row.requestId}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
        acked.add(row.requestId);
      }
    }, 10);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
    try {
      for (let turn = 1; turn <= 3; turn++) {
        child.stdin.write(`fixture prompt ${turn}\n`);
        await expect.poll(() => rows(eventFile).filter(row => row.t === "agent_settled").length, { timeout: 5_000 }).toBe(turn);
      }
      child.stdin.write("/exit\n");
      expect(await closed, output).toBe(0);
      const summaryModels = rows(requestFile).filter(row => row.summary).map(row => row.model);
      expect(summaryModels, output).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
      const revisions = rows(sessionFile).filter(row => row.type === "revision");
      expect(revisions.map(row => row.kind), output).toContain("summarize");
      expect(output).not.toContain("(summarization failed");
    } finally {
      clearInterval(ackTimer);
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("paces back-to-back prunes by token growth, diverting regrowth to summarize", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-prune-cooldown-"));
    const project = join(root, "project"), home = join(root, "home"), events = join(root, "events");
    for (const directory of [project, home, events]) mkdirSync(directory, { recursive: true });
    // Reads cap at 40KB, so stage 1 stacks four capped results across four
    // prompts; the prune at prompt six targets prompt-one content past the
    // two-turn protection. Regrowth (two more capped reads) trips the
    // high-water gate with growth below reclaimed + margin, so the second
    // prune must hold and the loop must summarize instead.
    for (const name of ["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt"]) {
      writeFileSync(join(project, name), "x".repeat(40_000));
    }
    const terminal = "term-prune-cooldown", session = "core-prune-cooldown";
    const sessionFile = join(events, session, "current", "session.jsonl");
    const eventFile = join(events, `${terminal}.jsonl`), requestFile = join(root, "requests.jsonl");
    const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
    const script = `
      import { appendFileSync } from "node:fs";
      let turn = 0;
      const reads = { 1: "f1.txt", 3: "f2.txt", 5: "f3.txt", 7: "f4.txt", 10: "f5.txt", 12: "f6.txt" };
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://models.dev/api.json") return new Response("{}");
        const body = JSON.parse(init.body);
        const summary = String(body.instructions).includes("compress coding-agent");
        appendFileSync(${JSON.stringify(requestFile)}, JSON.stringify({ summary }) + "\\n");
        if (!summary && ++turn > 20) throw new Error("fixture request bound");
        if (!summary && reads[turn]) {
          const output = [{ type: "function_call", id: "fc-" + turn, call_id: "call-" + turn,
            name: "read_file", arguments: JSON.stringify({ path: reads[turn] }) }];
          const events = output.map(item => ({ type: "response.output_item.done", item }));
          events.push({ type: "response.completed", response: { status: "completed", output,
            usage: { input_tokens: 30_000, output_tokens: 10,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } });
          return new Response(events.map(e => "data: " + JSON.stringify(e) + "\\n\\n").join(""),
            { headers: { "content-type": "text/event-stream" } });
        }
        const even = turn % 2 === 0;
        const text = summary ? "handoff" : !summary && turn <= 8 && even ? "c".repeat(8_000) : "done";
        const usage = { input_tokens: !summary && turn === 9 ? 65_000 : 30_000,
          output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
        if (summary) {
          // The openai-responses summary lane streams; a JSON body fails SSE parsing.
          const handoff = [{ type: "response.output_text.delta", delta: "handoff" }];
          handoff.push({ type: "response.completed", response: { status: "completed", output: [], usage } });
          return new Response(handoff.map(e => "data: " + JSON.stringify(e) + "\\n\\n").join(""),
            { headers: { "content-type": "text/event-stream" } });
        }
        const events = [{ type: "response.output_text.delta", delta: text }];
        events.push({ type: "response.completed", response: { status: "completed", output: [], usage } });
        return new Response(events.map(e => "data: " + JSON.stringify(e) + "\\n\\n").join(""),
          { headers: { "content-type": "text/event-stream" } });
      };
      process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname];
      await import(${JSON.stringify(mainUrl)});
    `;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^(TERMINA_|PI_SESSION_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
    Object.assign(env, {
      HOME: home, TERMINA_AUTH_PATH: join(home, "auth.json"), TERMINA_CORE_TEST: "1",
      TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_CORE_EFFORT: "off",
      TERMINA_CORE_SUMMARY_MODEL: "openai/gpt-5.6-luna", TERMINA_CORE_CONTEXT: "88000", OPENAI_API_KEY: "fixture-only",
      TERMINA_CORE_APPROVE: "all", TERMINA_EVENTS_DIR: events, TERMINA_TERMINAL_ID: terminal,
      TERMINA_CORE_SESSION_ID: session, TERMINA_CORE_SESSION_FILE: sessionFile,
    });
    const child = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", script], {
      cwd: project, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-12_000); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-12_000); });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    const acked = new Set<string>();
    const ackTimer = setInterval(() => {
      for (const row of rows(eventFile)) {
        if (!["preflight_request", "checkpoint_request"].includes(row.t) || !row.requestId || acked.has(row.requestId)) continue;
        writeFileSync(join(events, `ack-${terminal}-${row.requestId}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
        acked.add(row.requestId);
      }
    }, 10);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    try {
      // P1-P4 read f1-f4, P5 bills high to trip the gate, P6 prunes f1-era
      // content, P7-P8 regrow with f5/f6, P9 settles.
      const prompts = ["read f1.txt", "read f2.txt", "read f3.txt", "read f4.txt", "go", "read f5.txt", "read f6.txt", "go", "go"];
      for (let turn = 1; turn <= prompts.length; turn++) {
        child.stdin.write(`${prompts[turn - 1]}\n`);
        await expect.poll(() => rows(eventFile).filter(row => row.t === "agent_settled").length, { timeout: 15_000 }).toBe(turn);
      }
      child.stdin.write("/exit\n");
      expect(await closed, output).toBe(0);
      const revisions = rows(sessionFile).filter(row => row.type === "revision");
      expect(revisions.map(row => row.kind), output).toEqual(["prune", "summarize"]);
    } finally {
      clearInterval(ackTimer);
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 75_000);
});
