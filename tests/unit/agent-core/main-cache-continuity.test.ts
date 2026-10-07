import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripResponsesBreakpoints } from "../../../agent-core/openai-compat/responses.ts";

type Row = Record<string, any>;
function rows(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; } // Only the in-flight last line may be incomplete.
  });
}

// Real main loop and session writer. Provider replies, project, HOME, events,
// authentication, and the only child process all belong to this fixture.
describe("main cache continuity", () => {
  it("retains snapshots across tools, missing usage, settlement and model switches, but not resume or clear", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-cache-continuity-"));
    const project = join(root, "project"), home = join(root, "home"), events = join(root, "events");
    for (const directory of [project, home, events]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(project, "file.txt"), "fixture source\n");
    const terminal = "term-cache-fixture", session = "core-cache-fixture";
    const sessionFile = join(events, session, "current", "session.jsonl");
    const eventFile = join(events, `${terminal}.jsonl`), requestFile = join(root, "requests.jsonl");
    const contextFile = join(events, `project-${terminal}.md`);
    const resumeRequest = join(root, "resume.request"), resumeResult = join(root, "resume.result.json");
    const mainUrl = new URL("../../../agent-core/main.ts", import.meta.url).href;
    const script = `
      import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
      let turn = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://models.dev/api.json") return new Response("{}");
        if (!String(url).endsWith("/responses")) throw new Error("unexpected fixture URL");
        if (++turn > 6) throw new Error("fixture request bound");
        const body = JSON.parse(init.body);
        appendFileSync(${JSON.stringify(requestFile)}, JSON.stringify(body) + "\\n");
        const output = turn === 1 ? [{ type: "function_call", id: "fixture-item", call_id: "fixture-call",
          name: "read_file", arguments: JSON.stringify({ path: "file.txt" }) }] : [];
        const events = output.map(item => ({ type: "response.output_item.done", item }));
        if (!output.length) events.push({ type: "response.output_text.delta", delta: "fixture completed" });
        const usage = turn === 2 ? undefined : { input_tokens: 400, output_tokens: 5,
          input_tokens_details: { cached_tokens: turn === 1 ? 0 : 320, cache_write_tokens: 0 } };
        events.push({ type: "response.completed", response: { status: "completed", output, usage } });
        return new Response(events.map(event => "data: " + JSON.stringify(event) + "\\n\\n").join(""),
          { headers: { "content-type": "text/event-stream" } });
      };
      process.argv = [process.execPath, new URL(${JSON.stringify(mainUrl)}).pathname];
      const core = await import(${JSON.stringify(mainUrl)});
      // /resume is intentionally fresh-engine only. Exercise the canonical
      // replay installer through its existing seam with stale in-memory state.
      setInterval(() => {
        if (!existsSync(${JSON.stringify(resumeRequest)})) return;
        unlinkSync(${JSON.stringify(resumeRequest)});
        void core.testOnlyResumeSessionBody().then(result =>
          writeFileSync(${JSON.stringify(resumeResult)}, JSON.stringify(result)));
      }, 10).unref();
    `;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(TERMINA_|PI_|OPENAI_|ANTHROPIC_|XAI_|GEMINI_|GOOGLE_|OPENROUTER_|OPENCODE_)/.test(key)) delete env[key];
    }
    Object.assign(env, {
      HOME: home, TERMINA_AUTH_PATH: join(home, "auth.json"), TERMINA_CORE_TEST: "1",
      TERMINA_CORE_PROVIDER: "openai", TERMINA_CORE_MODEL: "gpt-5.6-sol", TERMINA_CORE_EFFORT: "off",
      OPENAI_API_KEY: "fixture-only", TERMINA_CORE_APPROVE: "all", TERMINA_EVENTS_DIR: events,
      TERMINA_TERMINAL_ID: terminal, TERMINA_CORE_SESSION_ID: session, TERMINA_CORE_SESSION_FILE: sessionFile,
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
    const settled = () => rows(eventFile).filter(row => row.t === "agent_settled").length;
    const settings = () => rows(eventFile).filter(row => row.t === "agent_settings");
    const prompt = async (count: number, snapshot: string) => {
      writeFileSync(contextFile, snapshot);
      child.stdin.write(`fixture prompt ${count}\n`);
      await expect.poll(settled, { timeout: 5_000 }).toBe(count);
      // agent_settled precedes checkpoint and trace settlement. The final
      // settings event is emitted after main releases its busy state.
      await expect.poll(() => {
        const log = rows(eventFile);
        const settlement = log.filter(row => row.t === "agent_settled")[count - 1];
        if (!settlement) return false;
        const currentTurn = log.slice(log.indexOf(settlement) + 1);
        const checkpoint = currentTurn.find(row => row.t === "checkpoint_request" && row.kind === "settled");
        if (!checkpoint) return false;
        const completed = currentTurn.findIndex(row => row.t === "checkpoint_result" && row.requestId === checkpoint.requestId);
        return completed >= 0 && currentTurn.slice(completed + 1).some(row => row.t === "agent_settings");
      }, { timeout: 5_000 }).toBe(true);
    };
    try {
      await prompt(1, "snapshot alpha");
      await prompt(2, "snapshot beta");
      const beforeSwitch = rows(requestFile);
      expect(beforeSwitch).toHaveLength(3);
      // Provider cache markers move independently of cacheable content.
      const stableInputs = beforeSwitch.map(body => stripResponsesBreakpoints(body).input as unknown[]);
      expect(stableInputs[1].slice(0, stableInputs[0].length)).toEqual(stableInputs[0]);
      expect(stableInputs[2].slice(0, stableInputs[1].length)).toEqual(stableInputs[1]);
      expect(JSON.stringify(beforeSwitch[2].input)).toContain("snapshot alpha");
      expect(JSON.stringify(beforeSwitch[2].input)).toContain("snapshot beta");
      expect(settings().at(-1)?.usage).toContain("cache last 80% · recent10 -- · session --");

      child.stdin.write("/model openai/gpt-5.6\n");
      await expect.poll(() => settings().at(-1)?.model, { timeout: 5_000 }).toBe("openai/gpt-5.6");
      await prompt(3, "snapshot gamma");
      const switched = rows(requestFile)[3];
      expect(JSON.stringify(switched.input)).toContain("snapshot alpha");
      expect(JSON.stringify(switched.input)).toContain("snapshot beta");
      expect(JSON.stringify(switched.input)).toContain("snapshot gamma");
      expect(settings().at(-1)?.usage).toContain("cache last 80% · recent10 80% · session --");

      writeFileSync(resumeRequest, "fixture request");
      await expect.poll(() => existsSync(resumeResult), { timeout: 5_000 }).toBe(true);
      expect(JSON.parse(readFileSync(resumeResult, "utf8"))).toEqual({ ok: true });
      await prompt(4, "snapshot delta");
      const resumed = JSON.stringify(rows(requestFile)[4].input);
      expect(resumed).not.toMatch(/snapshot alpha|snapshot beta|snapshot gamma/);
      expect(resumed).toContain("fixture prompt 1");
      expect(resumed).toContain("snapshot delta");
      expect(readFileSync(sessionFile, "utf8")).not.toMatch(/snapshot alpha|snapshot beta|snapshot gamma|snapshot delta|working-set/);

      const beforeClear = settings().length;
      child.stdin.write("/clear\n");
      await expect.poll(() => settings().length, { timeout: 5_000 }).toBeGreaterThan(beforeClear);
      await prompt(5, "snapshot epsilon");
      const cleared = JSON.stringify(rows(requestFile)[5].input);
      expect(cleared).not.toMatch(/snapshot delta|fixture prompt [1-4]/);
      expect(cleared).toContain("snapshot epsilon");
      expect(settings().at(-1)?.usage).toContain("tokens 400 in/5 out · cache last 80% · recent10 80% · session 80%");
      expect(readFileSync(sessionFile, "utf8")).not.toMatch(/snapshot|working-set/);
      child.stdin.write("/exit\n");
      expect(await closed, output).toBe(0);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nFixture output:\n${output}`);
    } finally {
      clearInterval(ackTimer);
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
