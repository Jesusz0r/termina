import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentHost, lastResultFrame, type SubagentChild, type SubagentLauncher } from "../../../electron/subagents.ts";
import { parseSubagentResultFile } from "../../../agent-core/subagents.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagent-host-"));
  roots.push(dir);
  return dir;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface FakeProc {
  api: SubagentChild;
  kills: string[];
  out(data: string): void;
  err(data: string): void;
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
}

function makeFake(): FakeProc {
  const outCbs: Array<(d: Buffer) => void> = [];
  const errCbs: Array<(d: Buffer) => void> = [];
  const exitCbs: Array<(c: number | null, s: NodeJS.Signals | null) => void> = [];
  const kills: string[] = [];
  return {
    kills,
    api: {
      pid: 4242,
      stdout: { onData: (cb) => { outCbs.push(cb); } },
      stderr: { onData: (cb) => { errCbs.push(cb); } },
      onExit: (cb) => { exitCbs.push(cb); },
      killChild: (s) => { kills.push(`child:${s}`); },
      killGroup: (s) => { kills.push(`group:${s}`); },
    },
    out: (s) => { for (const cb of outCbs) cb(Buffer.from(s)); },
    err: (s) => { for (const cb of errCbs) cb(Buffer.from(s)); },
    exit: (code, signal = null) => { for (const cb of exitCbs) cb(code, signal); },
  };
}

function validTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    runId: "bg-1",
    task: "do the thing",
    brief: "do the thing",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    protocol: "anthropic-messages",
    effort: "off",
    maxTurns: 10,
    paths: [],
    permissionMode: "ask",
    parentTerminalId: "term-7",
    cwd: tmp(),
    depth: 1,
    createdAt: 1,
    ...overrides,
  };
}

function setup(opts: { wallMs?: number; maxAttempts?: number; backoffMs?: number[]; launchFailures?: number; dispatch?: { keys: Set<string>; root: string } } = {}) {
  const dir = tmp();
  const { dispatch, launchFailures = 0, ...hostOpts } = opts;
  const notes: Array<{ terminalId: string; note: string }> = [];
  const watched: string[] = [];
  const unwatched: string[] = [];
  const procs: FakeProc[] = [];
  const launches: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> = [];
  let launchAttempts = 0;
  const launch: SubagentLauncher = (cmd, args, launchOpts) => {
    if (++launchAttempts <= launchFailures) throw new Error("launch temporarily unavailable");
    const fake = makeFake();
    procs.push(fake);
    launches.push({ cmd, args, env: launchOpts.cwd ? { ...launchOpts.env, PWD: launchOpts.cwd } : launchOpts.env });
    return fake.api;
  };
  const host = new SubagentHost(
    {
      eventsDirFor: () => dir,
      baseEnv: () => ({}),
      coreBinary: () => "/fake/agent-core.mjs",
      sessionRootFor: async (cwd) => join(dir, "sessions", Buffer.from(cwd).toString("hex").slice(0, 16)),
      appendMailboxNote: (terminalId, note) => { notes.push({ terminalId, note }); },
      watchStream: (id) => { watched.push(id); },
      releaseStream: (id) => { unwatched.push(id); },
      dispatchKeysFor: async () => dispatch ?? { keys: new Set<string>(), root: "" },
      canonicalPath: async (p) => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      },
    },
    { launch, backoffMs: [5, 5], ...hostOpts },
  );
  const taskFile = `subagent-term-7-bg-1.task.json`;
  const writeTask = (body: unknown = validTask(), name = taskFile) => {
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  };
  const resultFile = join(dir, "subagent-term-7-bg-1.result.json");
  const readResult = () => JSON.parse(readFileSync(resultFile, "utf8"));
  return { dir, host, notes, watched, unwatched, procs, launches, writeTask, resultFile, readResult, get launchAttempts() { return launchAttempts; } };
}

describe("SubagentHost", () => {
  it("fails closed on a missing task file without launching", async () => {
    const s = setup();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.procs.length).toBe(0);
    const body = s.readResult();
    expect(body.outcome).toBe("failed");
    expect(body.runId).toBe("bg-1");
    expect(parseSubagentResultFile("bg-1", body).ok).toBe(true);
    expect(s.notes.length).toBe(1);
    expect(s.notes[0]!.note).toMatch(/failed/);
  });

  it("fails closed on parent mismatch and malformed shapes", async () => {
    const s = setup();
    s.writeTask(validTask({ parentTerminalId: "term-999" }));
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.procs.length).toBe(0);
    expect(s.readResult().outcome).toBe("failed");
    await s.host.handleSpawn("term-7", "../x", "subagent-term-7-bg-1.task.json");
    await s.host.handleSpawn("term-7", "bg-1", "some/dir.task.json");
    await s.host.handleSpawn("term-7", "bg-1", "run.task");
    expect(s.host.activeCount()).toBe(0);
  });

  it("caps concurrent children", async () => {
    const s = setup();
    for (let i = 1; i <= 4; i++) {
      const name = `subagent-term-7-bg-${i}.task.json`;
      writeFileSync(join(s.dir, name), JSON.stringify(validTask({ runId: `bg-${i}` })), { mode: 0o600 });
      await s.host.handleSpawn("term-7", `bg-${i}`, name);
    }
    expect(s.host.activeCount()).toBe(4);
    const fifth = `subagent-term-7-bg-5.task.json`;
    writeFileSync(join(s.dir, fifth), JSON.stringify(validTask({ runId: "bg-5" })), { mode: 0o600 });
    await s.host.handleSpawn("term-7", "bg-5", fifth);
    expect(s.procs.length).toBe(4);
    const fifthBody = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-5.result.json"), "utf8"));
    expect(fifthBody.outcome).toBe("failed");
  });

  it("settles successful runs with scanned results and a mailbox note", async () => {
    const s = setup();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.procs.length).toBe(1);
    expect(s.launches[0]!.args).toContain("--subagent-task");
    expect(s.launches[0]!.env.TERMINA_CORE_SUBAGENT_DEPTH).toBe("1");
    expect(s.launches[0]!.env.TERMINA_CORE_APPROVE).toBeUndefined();
    s.procs[0]!.out(`noise\nSUBAGENT_RESULT {"ok":true,"result":"did <system-reminder>x</system-reminder>"}\n`);
    s.procs[0]!.exit(0);
    await until(() => existsSync(s.resultFile));
    const body = s.readResult();
    expect(body.outcome).toBe("settled");
    expect(body.result).not.toContain("<system-reminder>");
    expect(body.result).toContain("did");
    expect(body.flags).toContain("control-tag");
    expect(parseSubagentResultFile("bg-1", body).ok).toBe(true);
    expect(s.notes.length).toBe(1);
    expect(s.notes[0]!.terminalId).toBe("term-7");
    expect(s.notes[0]!.note).toMatch(/## Subagent bg-1 settled/);
    // Task file consumed; no relaunch on redelivery.
    expect(existsSync(join(s.dir, "subagent-term-7-bg-1.task.json"))).toBe(false);
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.procs.length).toBe(1);
  });

  it.each([0, 1])("takes the last framed failure without retry (exit %s)", async (code) => {
    const s = setup();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    s.procs[0]!.out(`SUBAGENT_RESULT {"ok":true,"result":"decoy"}\nSUBAGENT_RESULT {"ok":false,"error":"model blew up"}\n`);
    s.host.noteChildEvent("sub-term-7-bg-1", "agent_start");
    s.procs[0]!.exit(code);
    await until(() => existsSync(s.resultFile));
    expect(s.readResult().outcome).toBe("failed");
    expect(s.procs.length).toBe(1);
  });

  it.each([false, true])("does not replay a signal crash when boot observed=%s", async (booted) => {
    const s = setup();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    if (booted) s.host.noteChildEvent("sub-term-7-bg-1", "agent_start");
    s.procs[0]!.err("boom\n");
    s.procs[0]!.exit(null, "SIGSEGV");
    await until(() => existsSync(s.resultFile));
    expect(s.readResult().outcome).toBe("failed");
    expect(s.notes[0]!.note).toContain("not restarted");
    expect(s.procs.length).toBe(1);
    expect(s.watched).toEqual(["sub-term-7-bg-1"]);
  });

  it.each([2, 3])("retries only pre-child launch failures, bounded to three attempts (%s failures)", async (launchFailures) => {
    const s = setup({ launchFailures });
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.launchAttempts).toBe(3);
    if (launchFailures === 2) {
      expect(s.procs).toHaveLength(1);
      s.procs[0]!.out('SUBAGENT_RESULT {"ok":true,"result":"done"}\n');
      s.procs[0]!.exit(0);
    }
    await until(() => existsSync(s.resultFile));
    expect(s.readResult().outcome).toBe(launchFailures === 2 ? "settled" : "failed");
  });

  it("escalates wall timeout when SIGTERM is ignored, without releasing or replaying a live child", async () => {
    const s = setup({ wallMs: 20 });
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    await until(() => s.procs[0]!.kills.includes("group:SIGKILL"), 7000);
    expect(s.host.activeCount()).toBe(1);
    expect(existsSync(s.resultFile)).toBe(false);
    s.procs[0]!.exit(null, "SIGKILL");
    await until(() => existsSync(s.resultFile));
    expect(s.readResult().outcome).toBe("killed");
    expect(s.procs).toHaveLength(1);
  });

  it("kills terminate without retry", async () => {
    const s = setup();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.host.kill("term-7", "bg-1", "parent cleared")).toBe(true);
    expect(s.procs[0]!.kills).toContain("group:SIGTERM");
    s.procs[0]!.exit(null, "SIGTERM");
    await until(() => existsSync(s.resultFile));
    const body = s.readResult();
    expect(body.outcome).toBe("killed");
    expect(s.procs.length).toBe(1);
    expect(s.host.kill("term-7", "bg-1", "again")).toBe(false);
    expect(s.host.kill("term-7", "bg-404", "missing")).toBe(false);
  });

  it("times out hanging children", async () => {
    const s = setup({ wallMs: 40 });
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    // Wall timer fires; the fake dies only when told, like a real SIGTERM.
    await until(() => s.procs[0]!.kills.includes("group:SIGTERM"), 5000);
    s.procs[0]!.exit(null, "SIGTERM");
    await until(() => existsSync(s.resultFile), 5000);
    const body = s.readResult();
    expect(body.outcome).toBe("killed");
  });

  it("runs a real engine child to a failed result", async () => {
    const dir = tmp();
    const notes: string[] = [];
    const { spawn } = await import("node:child_process");
    const engineTs = new URL("../../../agent-core/main.ts", import.meta.url).pathname;
    const name = "subagent-term-7-bg-1.task.json";
    const realHost = new SubagentHost(
      {
        eventsDirFor: () => dir,
        baseEnv: () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TERMINA_CORE_TEST: "1" }),
        coreBinary: () => "unused",
        sessionRootFor: async () => join(dir, "sessions"),
        appendMailboxNote: (_t, note) => { notes.push(note); },
        watchStream: () => {},
        releaseStream: () => {},
        dispatchKeysFor: async () => new Set<string>(),
        canonicalPath: async (p) => p,
      },
      {
        wallMs: 20000,
        maxAttempts: 1,
        launch: (_cmd, _args, opts) => {
          const child = spawn(
            process.execPath,
            ["--experimental-strip-types", "--no-warnings", engineTs, "--subagent-task", join(dir, name)],
            { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] },
          );
          const wrap = (stream: { on(e: string, cb: (d: Buffer) => void): void } | null) => ({
            onData: (cb: (d: Buffer) => void) => { stream?.on("data", cb); },
          });
          return {
            pid: child.pid,
            stdout: wrap(child.stdout),
            stderr: wrap(child.stderr),
            onExit: (cb) => { child.on("exit", (c, sig) => cb(c, sig)); },
            killChild: (sig) => { try { child.kill(sig); } catch { /* exited */ } },
            killGroup: (sig) => { try { child.kill(sig); } catch { /* exited */ } },
          };
        },
      },
    );
    // Valid shape, impossible model: the engine boots, fails the run, and
    // the host records the failure (or the wall clock kills it first).
    writeFileSync(join(dir, name), JSON.stringify(validTask({ model: "definitely-not-a-real-model-xyz", cwd: dir })), { mode: 0o600 });
    await realHost.handleSpawn("term-7", "bg-1", name);
    await until(() => existsSync(join(dir, "subagent-term-7-bg-1.result.json")), 45000);
    const body = JSON.parse(readFileSync(join(dir, "subagent-term-7-bg-1.result.json"), "utf8"));
    expect(["failed", "killed"]).toContain(body.outcome);
    expect(notes.length).toBe(1);
  }, 60000);

  it("rejects claims overlapping another parent's live run", async () => {
    const s = setup();
    const proj = tmp();
    s.writeTask(validTask({ cwd: proj, paths: ["src/a.ts"] }));
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.host.activeCount()).toBe(1);
    expect(s.host.claimsForOwner("term-7")).toEqual([{ path: "src/a.ts", cwd: proj }]);
    expect(s.host.claimsForOwner("term-9")).toEqual([]);
    // Same tree, overlapping claim, other parent: rejected like a sibling.
    const other = "subagent-term-9-bg-1.task.json";
    writeFileSync(join(s.dir, other), JSON.stringify(validTask({ runId: "bg-1", parentTerminalId: "term-9", cwd: proj, paths: ["src"] })), { mode: 0o600 });
    await s.host.handleSpawn("term-9", "bg-1", other);
    expect(s.procs.length).toBe(1);
    const body = JSON.parse(readFileSync(join(s.dir, "subagent-term-9-bg-1.result.json"), "utf8"));
    expect(body.outcome).toBe("failed");
    // Same relative path under another root proceeds.
    const elsewhere = "subagent-term-9-bg-2.task.json";
    writeFileSync(join(s.dir, elsewhere), JSON.stringify(validTask({ runId: "bg-2", parentTerminalId: "term-9", cwd: tmp(), paths: ["src/a.ts"] })), { mode: 0o600 });
    await s.host.handleSpawn("term-9", "bg-2", elsewhere);
    expect(s.procs.length).toBe(2);
  });

  it("vetoes spawns overlapping dispatch workers", async () => {
    const proj = tmp();
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "a.ts"), "x");
    const key = realpathSync(join(proj, "src", "a.ts"));
    const s = setup({ dispatch: { keys: new Set([key]), root: realpathSync(proj) } });
    s.writeTask(validTask({ cwd: proj, paths: ["src/a.ts"] }));
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.procs.length).toBe(0);
    expect(s.readResult().outcome).toBe("failed");
    const free = setup({ dispatch: { keys: new Set([key]), root: realpathSync(proj) } });
    free.writeTask(validTask({ cwd: proj, paths: ["src/b.ts"] }));
    await free.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(free.procs.length).toBe(1);
  });

  it("vetoes through a subdirectory anchor", async () => {
    // Terminal cwd is a subdir of the dispatch root: keys must still meet.
    const proj = tmp();
    const sub = join(proj, "pkg");
    mkdirSync(join(sub, "src"), { recursive: true });
    writeFileSync(join(sub, "src", "a.ts"), "x");
    const key = realpathSync(join(sub, "src", "a.ts"));
    const s = setup({ dispatch: { keys: new Set([key]), root: realpathSync(proj) } });
    s.writeTask(validTask({ cwd: realpathSync(sub), paths: ["src/a.ts"] }));
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.procs.length).toBe(0);
    expect(s.readResult().outcome).toBe("failed");
  });

  it("reports merge needs when siblings touch the same files", async () => {
    const s = setup();
    for (const run of ["bg-1", "bg-2"] as const) {
      const name = `subagent-term-7-${run}.task.json`;
      writeFileSync(join(s.dir, name), JSON.stringify(validTask({ runId: run, paths: [] })), { mode: 0o600 });
      await s.host.handleSpawn("term-7", run, name);
    }
    expect(s.procs.length).toBe(2);
    s.host.noteChildEvent("sub-term-7-bg-1", "tool", "/proj/shared.ts");
    s.host.noteChildEvent("sub-term-7-bg-1", "agent_start");
    s.host.noteChildEvent("sub-term-7-bg-2", "tool", "/proj/shared.ts");
    s.host.noteChildEvent("sub-term-7-bg-2", "tool", "/proj/own.ts");
    s.host.noteChildEvent("nope", "tool", "/proj/shared.ts");
    s.procs[0]!.out(`SUBAGENT_RESULT {"ok":true,"result":"one"}\n`);
    s.procs[0]!.exit(0);
    await until(() => existsSync(join(s.dir, "subagent-term-7-bg-1.result.json")));
    expect(s.notes.at(-1)!.note).not.toContain("Merge needed");
    s.procs[1]!.out(`SUBAGENT_RESULT {"ok":true,"result":"two"}\n`);
    s.procs[1]!.exit(0);
    await until(() => existsSync(join(s.dir, "subagent-term-7-bg-2.result.json")));
    const note = s.notes.at(-1)!.note;
    expect(note).toContain("Merge needed");
    expect(note).toContain("bg-1");
    expect(note).toContain("/proj/shared.ts");
    expect(note).not.toContain("/proj/own.ts");
    const body = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-2.result.json"), "utf8"));
    expect(parseSubagentResultFile("bg-2", body).ok).toBe(true);
    expect(body.touched).toEqual(["/proj/shared.ts", "/proj/own.ts"]);
  });

  it("forgets settled history when the owner is killed", async () => {
    const s = setup();
    const name = "subagent-term-7-bg-1.task.json";
    s.writeTask(validTask({ paths: [] }));
    await s.host.handleSpawn("term-7", "bg-1", name);
    s.host.noteChildEvent("sub-term-7-bg-1", "tool", "/proj/shared.ts");
    s.procs[0]!.out(`SUBAGENT_RESULT {"ok":true,"result":"one"}\n`);
    s.procs[0]!.exit(0);
    await until(() => existsSync(join(s.dir, "subagent-term-7-bg-1.result.json")));
    expect(s.host.killOwner("term-7", "terminal cleared")).toBe(0);
    // A new run touching the same file must not merge-note against the
    // cleared session's history.
    const name2 = "subagent-term-7-bg-2.task.json";
    writeFileSync(join(s.dir, name2), JSON.stringify(validTask({ runId: "bg-2", paths: [] })), { mode: 0o600 });
    await s.host.handleSpawn("term-7", "bg-2", name2);
    s.host.noteChildEvent("sub-term-7-bg-2", "tool", "/proj/shared.ts");
    s.procs[1]!.out(`SUBAGENT_RESULT {"ok":true,"result":"two"}\n`);
    s.procs[1]!.exit(0);
    await until(() => existsSync(join(s.dir, "subagent-term-7-bg-2.result.json")));
    expect(s.notes.at(-1)!.note).not.toContain("Merge needed");
  });

  it("takes the last result frame", () => {
    expect(lastResultFrame("no frame here")).toBeNull();
    const two = `SUBAGENT_RESULT {"ok":true,"result":"first"}\nlog\nSUBAGENT_RESULT {"ok":false,"error":"last"}\n`;
    expect(lastResultFrame(two)).toEqual({ ok: false, error: "last" });
    expect(lastResultFrame(`SUBAGENT_RESULT {broken\n`)).toBeNull();
  });

  it("tracks child streams for liveness and releases them on finish", async () => {
    const s = setup();
    expect(s.host.hasStream("sub-term-7-bg-1")).toBe(false);
    s.host.noteChildEvent("sub-term-7-bg-1", "agent_start");
    expect(s.host.streamInfo("sub-term-7-bg-1")).toBeNull();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.host.hasStream("sub-term-7-bg-1")).toBe(true);
    expect(s.watched).toEqual(["sub-term-7-bg-1"]);
    const before = s.host.streamInfo("sub-term-7-bg-1");
    expect(before?.booted).toBe(false);
    expect(before?.runId).toBe("bg-1");
    s.host.noteChildEvent("sub-term-7-bg-1", "agent_start");
    s.host.noteChildEvent("sub-term-7-bg-1", "tool");
    const after = s.host.streamInfo("sub-term-7-bg-1");
    expect(after?.booted).toBe(true);
    expect(after!.lastActivityAt).toBeGreaterThanOrEqual(before!.lastActivityAt);
    s.procs[0]!.out(`SUBAGENT_RESULT {"ok":true,"result":"done"}\n`);
    s.procs[0]!.exit(0);
    await until(() => existsSync(s.resultFile));
    expect(s.host.hasStream("sub-term-7-bg-1")).toBe(false);
    expect(s.unwatched).toEqual(["sub-term-7-bg-1"]);
  });

  it("kills one owner's runs and keeps the other's", async () => {
    const s = setup();
    for (const [term, run] of [["term-7", "bg-1"], ["term-7", "bg-2"], ["term-9", "bg-1"]] as const) {
      const name = `subagent-${term}-${run}.task.json`;
      writeFileSync(join(s.dir, name), JSON.stringify(validTask({ runId: run, parentTerminalId: term })), { mode: 0o600 });
      await s.host.handleSpawn(term, run, name);
    }
    expect(s.host.activeCount()).toBe(3);
    expect(s.host.killOwner("term-7", "terminal cleared")).toBe(2);
    // Runs stay active until their children exit; the survivor is untouched.
    expect(s.host.activeCount()).toBe(3);
    expect(s.procs.filter((p) => p.kills.includes("group:SIGTERM")).length).toBe(2);
    // Exit both cleared children; only the survivor keeps running.
    for (const proc of s.procs.filter((child) => child.kills.includes("group:SIGTERM"))) proc.exit(null, "SIGTERM");
    await until(() => existsSync(join(s.dir, "subagent-term-7-bg-1.result.json")));
    await until(() => existsSync(join(s.dir, "subagent-term-7-bg-2.result.json")));
    await until(() => s.host.activeCount() === 1);
    expect(existsSync(join(s.dir, "subagent-term-9-bg-1.result.json"))).toBe(false);
    expect(s.host.killOwner("term-unknown", "x")).toBe(0);
  });

  it("settles a never-booted child without retrying", async () => {
    const s = setup();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    // Exit before agent_start: same task+env would fail identically, so no retry.
    s.procs[0]!.exit(1);
    await until(() => existsSync(s.resultFile));
    expect(s.readResult().outcome).toBe("failed");
    expect(s.procs.length).toBe(1);
  });

  it("does not replay a nonzero exit after booting", async () => {
    const s = setup();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    s.host.noteChildEvent("sub-term-7-bg-1", "agent_start");
    s.procs[0]!.exit(1);
    await until(() => existsSync(s.resultFile));
    expect(s.readResult().outcome).toBe("failed");
    expect(s.procs.length).toBe(1);
  });

  it("quotes the full task in the mailbox failure note", async () => {
    const s = setup();
    const tail = "node_modules/.bin/vitest run src/platform/database/x.integration.test.ts --reporter=dot";
    s.writeTask(validTask({ task: `${"step text. ".repeat(30)}\n3. ${tail}` }));
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    s.procs[0]!.exit(1);
    await until(() => existsSync(s.resultFile));
    expect(s.notes.length).toBe(1);
    expect(s.notes[0]!.note).toContain("## Subagent bg-1 failed");
    expect(s.notes[0]!.note).toContain(tail);
    expect(s.notes[0]!.note).not.toContain("…[truncated]");
  });

  it("marks an over-budget task quote as truncated", async () => {
    const s = setup();
    s.writeTask(validTask({ task: `x${"y".repeat(3000)}` }));
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    s.procs[0]!.exit(1);
    await until(() => existsSync(s.resultFile));
    expect(s.notes[0]!.note).toContain("…[truncated]");
  });

  it("fails a resume without launching when the prior session is gone", async () => {
    const s = setup();
    const task = { ...validTask({ runId: "bg-2", task: "follow up" }), resumeRunId: "bg-1" };
    writeFileSync(join(s.dir, "subagent-term-7-bg-2.task.json"), JSON.stringify(task));
    await s.host.handleSpawn("term-7", "bg-2", "subagent-term-7-bg-2.task.json");
    // No bg-1 ever ran on this host: no bundle to replay, so no child boots.
    expect(s.procs.length).toBe(0);
    await until(() => existsSync(join(s.dir, "subagent-term-7-bg-2.result.json")));
    const body = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-2.result.json"), "utf8"));
    expect(body.outcome).toBe("failed");
    expect(s.notes.at(-1)!.note).toMatch(/cannot resume bg-1/);
  });

  it("rejects a second live continuation of the same run", async () => {
    const s = setup();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    s.procs[0]!.out(`SUBAGENT_RESULT {"ok":true,"result":"done"}\n`);
    s.procs[0]!.exit(0);
    await until(() => existsSync(s.resultFile));
    const second = "subagent-term-7-bg-2.task.json";
    writeFileSync(join(s.dir, second), JSON.stringify({ ...validTask({ runId: "bg-2" }), resumeRunId: "bg-1" }));
    await s.host.handleSpawn("term-7", "bg-2", second);
    expect(s.procs.length).toBe(2);
    const third = "subagent-term-7-bg-3.task.json";
    writeFileSync(join(s.dir, third), JSON.stringify({ ...validTask({ runId: "bg-3" }), resumeRunId: "bg-1" }));
    await s.host.handleSpawn("term-7", "bg-3", third);
    // Two live children must never append to one replayed bundle.
    expect(s.procs.length).toBe(2);
    await until(() => existsSync(join(s.dir, "subagent-term-7-bg-3.result.json")));
    const body = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-3.result.json"), "utf8"));
    expect(body.outcome).toBe("failed");
    expect(s.notes.at(-1)!.note).toMatch(/already being continued by bg-2/);
  });

  it("exempts killed runs from the no-respawn instruction", async () => {
    const s = setup();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.host.kill("term-7", "bg-1", "parent cleared")).toBe(true);
    s.procs[0]!.exit(null, "SIGTERM");
    await until(() => existsSync(s.resultFile));
    expect(s.readResult().outcome).toBe("killed");
    // Timeouts may legitimately retry with an adjusted budget.
    expect(s.notes.at(-1)!.note).not.toContain("Do not respawn");
  });

  it("replays the prior bundle on resume", async () => {
    const s = setup();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    s.procs[0]!.out(`SUBAGENT_RESULT {"ok":true,"result":"done"}\n`);
    s.procs[0]!.exit(0);
    await until(() => existsSync(s.resultFile));
    expect(s.readResult().outcome).toBe("settled");
    const firstEnv = s.launches[0]!.env;
    expect(firstEnv.TERMINA_CORE_RESUME).toBeUndefined();
    const second = "subagent-term-7-bg-2.task.json";
    const task = { ...validTask({ runId: "bg-2", task: "follow up" }), resumeRunId: "bg-1" };
    writeFileSync(join(s.dir, second), JSON.stringify(task));
    await s.host.handleSpawn("term-7", "bg-2", second);
    await until(() => s.procs.length === 2, 5000);
    const secondEnv = s.launches[1]!.env;
    expect(secondEnv.TERMINA_CORE_SESSION_FILE).toBe(firstEnv.TERMINA_CORE_SESSION_FILE);
    // No RESUME flag: the task file's resume pointer is the single trigger,
    // so boot cannot replay the bundle a second time.
    expect(secondEnv.TERMINA_CORE_RESUME).toBeUndefined();
    expect(secondEnv.TERMINA_CORE_SESSION_ID).toBe(firstEnv.TERMINA_CORE_SESSION_ID);
    s.procs[1]!.out(`SUBAGENT_RESULT {"ok":true,"result":"continued"}\n`);
    s.procs[1]!.exit(0);
    await until(() => existsSync(join(s.dir, "subagent-term-7-bg-2.result.json")));
    expect(s.notes.at(-1)!.note).toContain("Continued from bg-1");
  });

  it("admits only one of two concurrent continuations of the same run", async () => {
    const s = setup();
    s.writeTask();
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    s.procs[0]!.out(`SUBAGENT_RESULT {"ok":true,"result":"done"}\n`);
    s.procs[0]!.exit(0);
    await until(() => existsSync(s.resultFile));
    writeFileSync(join(s.dir, "subagent-term-7-bg-2.task.json"), JSON.stringify({ ...validTask({ runId: "bg-2" }), resumeRunId: "bg-1" }));
    writeFileSync(join(s.dir, "subagent-term-7-bg-3.task.json"), JSON.stringify({ ...validTask({ runId: "bg-3" }), resumeRunId: "bg-1" }));
    // No await between the spawns: both are in flight across the same
    // admission awaits, so exactly one may insert.
    await Promise.all([
      s.host.handleSpawn("term-7", "bg-2", "subagent-term-7-bg-2.task.json"),
      s.host.handleSpawn("term-7", "bg-3", "subagent-term-7-bg-3.task.json"),
    ]);
    expect(s.procs.length).toBe(2);
    const outcomes = ["bg-2", "bg-3"].map((id) => {
      const file = join(s.dir, `subagent-term-7-${id}.result.json`);
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { outcome: string }).outcome : "running";
    });
    expect(outcomes.filter((o) => o === "failed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "running")).toHaveLength(1);
    expect(s.notes.some((n) => /already being continued by bg-[23]/.test(n.note))).toBe(true);
  });

  it("spawns once for a duplicated concurrent delivery", async () => {
    const s = setup();
    s.writeTask();
    await Promise.all([
      s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json"),
      s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json"),
    ]);
    expect(s.procs.length).toBe(1);
  });
});
