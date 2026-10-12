import { describe, expect, it } from "vitest";
import { spawn } from "@lydell/node-pty";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSubagentApprovalRequest } from "../../../agent-core/subagents.ts";

type Call = { name: string; args: Record<string, unknown> };
async function nativePicker(calls: Call[], test: (f: {
  write: (text: string) => void;
  events: () => Array<Record<string, any>>;
  wait: (predicate: () => boolean) => Promise<void>;
  root: string;
  cwd: string;
}) => Promise<void>, protectedFile = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "termina-intervention-")));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd); mkdirSync(home);
  if (protectedFile) {
    writeFileSync(join(cwd, "mine.txt"), "original");
    writeFileSync(join(root, "mine-term-test.json"), JSON.stringify([join(cwd, "mine.txt")]));
  }
  const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const output = calls.map((call, index) => ({ type: "function_call", id: `item-${index}`, call_id: `call-${index}`, name: call.name, arguments: JSON.stringify(call.args) }));
  const first = output.map((item) => sse({ type: "response.output_item.added", item })).join("") + sse({ type: "response.completed", response: { status: "completed", output, usage: { input_tokens: 1, output_tokens: 1 } } });
  const final = sse({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } });
  const main = new URL("../../../agent-core/main.ts", import.meta.url);
  const script = `
    let n = 0;
    globalThis.fetch = async (input) => {
      if (String(input) === "https://models.dev/api.json") return new Response("{}");
      n++;
      return new Response(n === 1 ? ${JSON.stringify(first)} : ${JSON.stringify(final)}, {headers: {"content-type":"text/event-stream"}});
    };
    process.argv = [process.execPath, ${JSON.stringify(main.pathname)}];
    await import(${JSON.stringify(main.href)});
  `;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("TERMINA_") || key.startsWith("PI_")) delete env[key];
  const pty = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "--no-warnings", "-e", script], {
    cwd, cols: 120, rows: 40, name: "xterm-256color",
    env: { ...env, HOME: home, TERMINA_AUTH_PATH: join(home, "auth.json"), TERMINA_CORE_SESSION_FILE: join(root, "sessions", "current", "session.jsonl"), TERMINA_CORE_TEST: "1", TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_CORE_APPROVE: "ask", OPENAI_API_KEY: "test-key", TERMINA_EVENTS_DIR: root, TERMINA_TERMINAL_ID: "term-test", TERMINA_SUBAGENT_APPROVAL_TIMEOUT_MS: "3000" },
  });
  let text = "";
  let exited = false;
  const closed = new Promise<number>((resolve) => pty.onExit(({ exitCode }) => { exited = true; resolve(exitCode); }));
  pty.onData((chunk) => { text += chunk; });
  const events = () => {
    try { return readFileSync(join(root, "term-test.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  };
  const timer = setInterval(() => {
    for (const row of events()) {
      if ((row.t === "preflight_request" || row.t === "checkpoint_request") && row.requestId) {
        const file = join(root, `ack-term-test-${row.requestId}.json`);
        if (!existsSync(file)) writeFileSync(file, JSON.stringify({ ok: true }));
      }
    }
    for (const name of readdirSync(root)) {
      const match = /^subagent-term-test-(bg-\d+)\.task\.json$/.exec(name);
      if (!match) continue;
      const decision = join(root, `subagent-term-test-${match[1]}.decision.json`);
      if (!existsSync(decision)) writeFileSync(decision, JSON.stringify({ version: 1, runId: match[1], admitted: true, error: null }));
      const live = join(root, `subagent-term-test-${match[1]}.live`);
      if (!existsSync(live)) writeFileSync(live, "");
    }
  }, 10);
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline || exited) throw new Error(`native picker wait failed: ${text}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await wait(() => /termina\s+·\s+openai\//.test(text));
    pty.write("perform the task\r");
    await test({ write: (value) => pty.write(value), events, wait, root, cwd });
    if (!exited) pty.write("\x04");
    await wait(() => exited);
    expect(await closed).toBe(0);
  } finally {
    clearInterval(timer);
    if (!exited) { try { pty.kill("SIGKILL"); } catch { /* already exited */ } }
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
}
const interventions = (events: Array<Record<string, any>>) => events.filter((row) => row.t === "intervention_requested" || row.t === "intervention_resolved");
function expectPair(rows: Array<Record<string, any>>) {
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ t: "intervention_requested", kind: "permission", since: expect.any(Number), requestId: expect.any(String) });
  expect(rows[1]).toMatchObject({ t: "intervention_resolved", requestId: rows[0].requestId });
  // Sidecar adds envelope metadata; producer payload must not include secrets.
  expect(JSON.stringify(rows)).not.toContain("private-command");
}

describe("native human permission intervention producers", () => {
  it("publishes bash only on display and preserves age through typed-ahead", async () => {
    await nativePicker([{ name: "bash", args: { command: "echo private-command-1" } }], async ({ write, events, wait }) => {
      await wait(() => interventions(events()).length === 1);
      const original = interventions(events())[0];
      write("typed ahead\r");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(interventions(events())).toEqual([original]);
      write("/approve once\r");
      await wait(() => interventions(events()).length === 2);
      expectPair(interventions(events()));
    });
  }, 30000);

  it.each(["\x03", "/clear\r", "/new\r", "\x04"])("resolves bash on cancellation %j", async (cancel) => {
    await nativePicker([{ name: "bash", args: { command: "echo private-command" } }], async ({ write, events, wait }) => {
      await wait(() => interventions(events()).length === 1);
      write(cancel);
      await wait(() => interventions(events()).length === 2);
      expectPair(interventions(events()));
    });
  }, 30000);

  it("publishes the protected file picker and denial leaves its file unchanged", async () => {
    await nativePicker([{ name: "write_file", args: { path: "mine.txt", content: "changed" } }], async ({ write, events, wait, cwd }) => {
      await wait(() => interventions(events()).length === 1);
      write("/approve deny\r");
      await wait(() => interventions(events()).length === 2);
      expectPair(interventions(events()));
      expect(readFileSync(join(cwd, "mine.txt"), "utf8")).toBe("original");
    }, true);
  }, 30000);

  it("interrupt cancels the displayed child picker and invalidates queued human surfaces", async () => {
    await nativePicker([{ name: "spawn_subagent", args: { task: "background work" } }], async ({ write, events, wait, root }) => {
      await wait(() => existsSync(join(root, "subagent-term-test-bg-1.task.json")));
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const reqId of ["appr-cancel-1", "appr-cancel-2"]) {
        expect(writeSubagentApprovalRequest(root, "term-test", "bg-1", { reqId, kind: "bash", text: "private-command" }).ok).toBe(true);
      }
      await wait(() => interventions(events()).length === 1);
      write("\x03");
      await wait(() => interventions(events()).length === 2);
      await wait(() => ["appr-cancel-1", "appr-cancel-2"].every((id) =>
        !existsSync(join(root, `subagent-term-test-bg-1.approval-${id}.json`)) &&
        existsSync(join(root, `ack-sub-term-test-bg-1-${id}.json`))));
      for (const id of ["appr-cancel-1", "appr-cancel-2"]) {
        expect(JSON.parse(readFileSync(join(root, `ack-sub-term-test-bg-1-${id}.json`), "utf8"))).toMatchObject({ ok: false });
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expectPair(interventions(events()));
      writeFileSync(join(root, "subagent-term-test-bg-1.result.json"), JSON.stringify({ version: 1, runId: "bg-1", outcome: "settled", result: "done", error: null, flags: [], touched: [], settledAt: Date.now() }));
    });
  }, 30000);

  it("cleans dead child requests without displaying the queued picker or writing orphan acknowledgements", async () => {
    await nativePicker([{ name: "spawn_subagent", args: { task: "background work" } }], async ({ write, events, wait, root }) => {
      await wait(() => existsSync(join(root, "subagent-term-test-bg-1.task.json")));
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const reqId of ["appr-dead-1", "appr-dead-2"]) {
        expect(writeSubagentApprovalRequest(root, "term-test", "bg-1", { reqId, kind: "bash", text: "private-command" }).ok).toBe(true);
      }
      await wait(() => interventions(events()).length === 1);
      writeFileSync(join(root, "subagent-term-test-bg-1.result.json"), JSON.stringify({ version: 1, runId: "bg-1", outcome: "settled", result: "done", error: null, flags: [], touched: [], settledAt: Date.now() }));
      await new Promise((resolve) => setTimeout(resolve, 1100));
      write("/approve once\r");
      await wait(() => ["appr-dead-1", "appr-dead-2"].every((id) =>
        !existsSync(join(root, `subagent-term-test-bg-1.approval-${id}.json`))));
      expectPair(interventions(events()));
      for (const id of ["appr-dead-1", "appr-dead-2"]) {
        expect(existsSync(join(root, `ack-sub-term-test-bg-1-${id}.json`))).toBe(false);
      }
    });
  }, 30000);

  it("serializes parent-surfaced child pickers without early events and resolves displayed timeout", async () => {
    await nativePicker([{ name: "spawn_subagent", args: { task: "background work" } }], async ({ write, events, wait, root }) => {
      await wait(() => existsSync(join(root, "subagent-term-test-bg-1.task.json")));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(interventions(events())).toEqual([]);
      expect(writeSubagentApprovalRequest(root, "term-test", "bg-1", { reqId: "appr-native-test", kind: "bash", text: "private-command" }).ok).toBe(true);
      expect(writeSubagentApprovalRequest(root, "term-test", "bg-1", { reqId: "appr-native-test-2", kind: "protected", text: "private-command" }).ok).toBe(true);
      await wait(() => interventions(events()).length === 1);
      const first = interventions(events())[0];
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(interventions(events())).toEqual([first]);
      write("/approve deny\r");
      await wait(() => interventions(events()).length === 3);
      expectPair(interventions(events()).slice(0, 2));
      expect(interventions(events())[2].requestId).not.toBe(first.requestId);
      expect(interventions(events())[2].since).toBeGreaterThanOrEqual(first.since);
      await wait(() => interventions(events()).length === 4);
      expectPair(interventions(events()).slice(2));
      await wait(() => ["appr-native-test", "appr-native-test-2"].every((id) =>
        !existsSync(join(root, `subagent-term-test-bg-1.approval-${id}.json`))));
      // The displayed request expires with the child: cleanup must not create
      // an orphan acknowledgement after the child's original deadline.
      const acks = ["appr-native-test", "appr-native-test-2"].map((id) => join(root, `ack-sub-term-test-bg-1-${id}.json`));
      expect(acks.filter(existsSync)).toHaveLength(1);
      expect(JSON.parse(readFileSync(acks.find(existsSync)!, "utf8"))).toMatchObject({ ok: false });
      writeFileSync(join(root, "subagent-term-test-bg-1.result.json"), JSON.stringify({ version: 1, runId: "bg-1", outcome: "settled", result: "done", error: null, flags: [], touched: [], settledAt: Date.now() }));
    });
  }, 30000);
});
