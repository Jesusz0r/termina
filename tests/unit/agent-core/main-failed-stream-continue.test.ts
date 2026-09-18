import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Row = Record<string, unknown>;

function jsonLines(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Row]; } catch { return []; }
  });
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for kernel"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** A cut-off provider stream must remain in history so "continue" can resume. */
describe("failed provider stream continuation", () => {
  it("keeps streamed assistant text for the next prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-failed-stream-"));
    const project = join(root, "project");
    const home = join(root, "home");
    const events = join(root, "events");
    for (const dir of [project, home, events]) mkdirSync(dir, { recursive: true });
    const terminalId = "term-failed-stream";
    const sessionId = "core-failed-stream";
    const sessionFile = join(events, sessionId, "current", "session.jsonl");
    const requestsFile = join(root, "requests.jsonl");
    const sidecar = join(events, `${terminalId}.jsonl`);
    const marker = "PLAN: edit cache.ts then run tests";
    const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
    const script = `
      import { appendFileSync } from "node:fs";
      let turn = 0;
      globalThis.fetch = async (input, init) => {
        if (String(input) === "https://models.dev/api.json") return new Response("{}", { status: 200 });
        const body = JSON.parse(init.body);
        appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(body) + "\\n");
        const n = ++turn;
        if (n === 1) {
          return new Response(
            "data: " + JSON.stringify({ type: "response.output_text.delta", delta: ${JSON.stringify(marker)} }) + "\\n\\n",
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        const events = [
          { type: "response.output_text.delta", delta: "resumed from salvaged plan" },
          { type: "response.completed", response: { status: "completed", output: [], usage: {} } },
        ];
        return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\\n\\n").join(""), {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      };
      process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname];
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
      cwd: project, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const acked = new Set<string>();
    const ackTimer = setInterval(() => {
      for (const record of jsonLines(sidecar)) {
        if (!["preflight_request", "checkpoint_request"].includes(String(record.t)) || !record.requestId || acked.has(String(record.requestId))) continue;
        writeFileSync(join(events, `ack-${terminalId}-${record.requestId}.json`), JSON.stringify({ ok: true }), { mode: 0o600 });
        acked.add(String(record.requestId));
      }
    }, 10);
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      await waitFor(() => output.includes("> ") || jsonLines(sidecar).some((row) => row.t === "session_ready"), 15_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      child.stdin.write("implement the cache key\n");
      await waitFor(() => jsonLines(sidecar).some((row) => row.t === "agent_settled"), 20_000);
      const afterFail = jsonLines(sessionFile).filter((row) => row.type === "message").map((row) => row.message as Row);
      expect(JSON.stringify(afterFail), output).toContain(marker);
      child.stdin.write("continue\n");
      await waitFor(() => jsonLines(requestsFile).length >= 2, 20_000);
      const second = jsonLines(requestsFile)[1]!;
      expect(JSON.stringify(second), output).toContain(marker);
      expect(JSON.stringify(second), output).toContain(marker);
      child.kill("SIGTERM");
      await closed.catch(() => {});
    } finally {
      clearInterval(ackTimer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
