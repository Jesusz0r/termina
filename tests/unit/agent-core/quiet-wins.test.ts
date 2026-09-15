/**
 * No Quiet Wins critical class (#237).
 *
 * A success claim after file edits with no observed check fails closed.
 * The class is named on the settle record. Read-only successes and
 * already-failed settles pass through.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createTaskSettledRecord } from "../../../agent-core/trace.ts";
import { NO_QUIET_WINS_CLASS } from "../../../agent-core/trace/schema.ts";
import {
  applyNoQuietWins,
  collectTaskToolOutcomes,
  hasFileEdits,
  hasObservedCheck,
} from "../../../agent-core/trace/quiet-wins.ts";

function settled(overrides: Record<string, unknown> = {}) {
  return createTaskSettledRecord({
    runId: "run-quiet",
    taskId: "task-quiet",
    attemptIds: ["attempt-1"],
    outcome: { status: "success", correctness: null, criteriaHash: null },
    ...overrides,
  });
}

describe("No Quiet Wins class (#237)", () => {
  it("names the class on a fail-closed settle record", () => {
    const record = settled({ criticalClass: NO_QUIET_WINS_CLASS, outcome: { status: "failure" } });
    expect(record.criticalClass).toBe("No Quiet Wins");
    expect(record.outcome.status).toBe("failure");
  });

  it("defaults criticalClass to null", () => {
    expect(settled().criticalClass).toBeNull();
  });

  it("rejects an unknown critical class", () => {
    expect(() => settled({ criticalClass: "lazy" })).toThrow(/No Quiet Wins/);
  });

  it("fails a success claim after edits with no check", () => {
    const gated = applyNoQuietWins("success", [
      { toolName: "edit", isError: false },
    ]);
    expect(gated).toEqual({ status: "failure", criticalClass: "No Quiet Wins" });
  });

  it("fails ok and succeeded claims the same way", () => {
    const outcomes = [{ toolName: "write_file", isError: false }];
    expect(applyNoQuietWins("ok", outcomes).criticalClass).toBe("No Quiet Wins");
    expect(applyNoQuietWins("succeeded", outcomes).status).toBe("failure");
  });

  it("passes when a succeeding bash check is already on the run", () => {
    expect(applyNoQuietWins("success", [
      { toolName: "edit", isError: false },
      { toolName: "bash", isError: false, exitCode: 0 },
    ])).toEqual({ status: "success", criticalClass: null });
  });

  it("treats an absent bash exit code as an observed check", () => {
    expect(hasObservedCheck([{ toolName: "bash", isError: false }])).toBe(true);
    expect(applyNoQuietWins("success", [
      { toolName: "edit", isError: false },
      { toolName: "bash", isError: false },
    ]).criticalClass).toBeNull();
  });

  it("does not treat a failed or errored bash as a check", () => {
    expect(hasObservedCheck([{ toolName: "bash", isError: false, exitCode: 1 }])).toBe(false);
    expect(hasObservedCheck([{ toolName: "bash", isError: true, exitCode: 0 }])).toBe(false);
    expect(applyNoQuietWins("success", [
      { toolName: "edit", isError: false },
      { toolName: "bash", isError: false, exitCode: 1 },
    ]).criticalClass).toBe("No Quiet Wins");
  });

  it("fails a success claim when the trace directory is unreadable", () => {
    expect(applyNoQuietWins("success", null)).toEqual({
      status: "failure",
      criticalClass: "No Quiet Wins",
    });
    expect(applyNoQuietWins("failure", null)).toEqual({ status: "failure", criticalClass: null });
  });

  it("does not fail a read-only or already-failed settle", () => {
    expect(hasFileEdits([{ toolName: "read_file", isError: false }])).toBe(false);
    expect(applyNoQuietWins("success", [])).toEqual({ status: "success", criticalClass: null });
    expect(applyNoQuietWins("success", [{ toolName: "read_file", isError: false }])).toEqual({
      status: "success",
      criticalClass: null,
    });
    expect(applyNoQuietWins("failure", [{ toolName: "edit", isError: false }])).toEqual({
      status: "failure",
      criticalClass: null,
    });
    expect(applyNoQuietWins("interrupted", [{ toolName: "edit", isError: false }])).toEqual({
      status: "interrupted",
      criticalClass: null,
    });
  });

  it("collects tool outcomes already written for the task", () => {
    const root = mkdtempSync(join(tmpdir(), "termina-quiet-wins-"));
    try {
      writeFileSync(join(root, "turn-1.json"), JSON.stringify({
        recordType: "attempt",
        runId: "run-a",
        taskId: "task-a",
        toolOutcomes: [{ toolName: "edit", isError: false }],
      }));
      writeFileSync(join(root, "turn-2.json"), JSON.stringify({
        recordType: "attempt",
        runId: "run-a",
        taskId: "task-a",
        toolOutcomes: [{ toolName: "bash", isError: false, exitCode: 0 }],
      }));
      writeFileSync(join(root, "turn-3.json"), JSON.stringify({
        recordType: "attempt",
        runId: "run-a",
        taskId: "other",
        toolOutcomes: [{ toolName: "write_file", isError: false }],
      }));
      writeFileSync(join(root, "turn-4.json"), JSON.stringify({
        recordType: "task-settled",
        runId: "run-a",
        taskId: "task-a",
      }));
      const collected = collectTaskToolOutcomes(root, "run-a", "task-a");
      expect(collected.readable).toBe(true);
      expect(collected.outcomes).toEqual([
        { toolName: "edit", isError: false },
        { toolName: "bash", isError: false, exitCode: 0 },
      ]);
      expect(collectTaskToolOutcomes(join(root, "missing"), "run-a", "task-a")).toEqual({
        readable: false,
        outcomes: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when settle cannot observe the trace directory", () => {
    const missing = collectTaskToolOutcomes(join(tmpdir(), "termina-quiet-wins-missing"), "run-a", "task-a");
    expect(missing.readable).toBe(false);
    expect(applyNoQuietWins("success", missing.readable ? missing.outcomes : null)).toEqual({
      status: "failure",
      criticalClass: "No Quiet Wins",
    });
  });
});

type Row = Record<string, unknown>;

function jsonLines(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Row]; } catch { return []; }
  });
}

async function settleScenario(toolProgram: string): Promise<{ traces: Row[]; output: string }> {
  const root = mkdtempSync(join(tmpdir(), "termina-quiet-wins-settle-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const events = join(root, "events");
  for (const dir of [project, home, events]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "file.txt"), "original\n");
  const terminalId = "term-quiet-wins";
  const sessionId = "core-quiet-wins";
  const sessionFile = join(events, sessionId, "current", "session.jsonl");
  const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
  const script = `
    let turn = 0;
    const toolsFor = (turn) => { ${toolProgram} };
    globalThis.fetch = async (input) => {
      if (String(input) === "https://models.dev/api.json") return new Response("{}", { status: 200 });
      turn += 1;
      const tools = toolsFor(turn);
      const items = tools.map((tool, i) => ({ type: "function_call", id: "item-" + turn + "-" + i,
        call_id: tool.id ?? "call-" + turn + "-" + i, name: tool.name, arguments: JSON.stringify(tool.input) }));
      const events = items.map((item) => ({ type: "response.output_item.done", item }));
      if (!items.length) events.push({ type: "response.output_text.delta", delta: "finished" });
      events.push({ type: "response.completed", response: { status: "completed", output: items,
        usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } });
      return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\\n\\n").join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname, "-p", "quiet wins settle"];
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
      if (!["preflight_request", "checkpoint_request"].includes(String(record.t)) || !record.requestId || acked.has(String(record.requestId))) continue;
      writeFileSync(join(events, `ack-${terminalId}-${record.requestId}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
      acked.add(String(record.requestId));
    }
  }, 10);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 40_000);
  try {
    const code = await closed;
    expect(timedOut, output).toBe(false);
    expect(code, output).toBe(0);
    const traceDir = join(events, `${terminalId}.traces`);
    const traces = existsSync(traceDir)
      ? readdirSync(traceDir).filter((name) => /^turn-\d+\.json$/.test(name))
        .map((name) => JSON.parse(readFileSync(join(traceDir, name), "utf8")) as Row)
      : [];
    return { traces, output };
  } finally {
    clearTimeout(timeout);
    clearInterval(ackTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

describe("settleTraceTask No Quiet Wins gate (#237)", () => {
  it("fails closed when edits settle without an observed check", async () => {
    const result = await settleScenario(`
      if (turn === 1) return [{ name: "edit", input: { path: "file.txt", old_text: "original", new_text: "changed" } }];
      return [];
    `);
    const settledRow = result.traces.find((row) => row.recordType === "task-settled");
    expect(settledRow?.outcome).toMatchObject({ status: "failure" });
    expect(settledRow?.criticalClass).toBe("No Quiet Wins");
  }, 60_000);

  it("keeps success when a succeeding bash check is on the run", async () => {
    const result = await settleScenario(`
      if (turn === 1) return [{ name: "edit", input: { path: "file.txt", old_text: "original", new_text: "changed" } }];
      if (turn === 2) return [{ name: "bash", input: { command: "true" } }];
      return [];
    `);
    const settledRow = result.traces.find((row) => row.recordType === "task-settled");
    expect(settledRow?.outcome).toMatchObject({ status: "success" });
    expect(settledRow?.criticalClass).toBeNull();
  }, 60_000);
});
