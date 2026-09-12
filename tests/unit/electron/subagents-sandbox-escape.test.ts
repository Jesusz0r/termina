import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentHost, type SubagentChild, type SubagentLauncher } from "../../../electron/subagents.ts";
import { isWorldlineCandidateEnv } from "../../../agent-core/subagents.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagent-escape-"));
  roots.push(dir);
  return dir;
}

function makeFake(): { api: SubagentChild; exits: Array<() => void> } {
  const exitCbs: Array<(c: number | null, s: NodeJS.Signals | null) => void> = [];
  return {
    api: {
      pid: 4242,
      stdout: { onData: () => {} },
      stderr: { onData: () => {} },
      onExit: (cb) => { exitCbs.push(cb); },
      killChild: () => {},
      killGroup: () => {},
    },
    exits: [],
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

function setup(opts: {
  isWorldlineTerminal?: (terminalId: string) => boolean;
  workspaceRootFor?: (terminalId: string) => { root: string; cwd: string } | null;
  autoApproveAllowedFor?: (terminalId: string) => boolean;
} = {}) {
  const dir = tmp();
  const notes: string[] = [];
  const launches: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined>; cwd: string }> = [];
  const launch: SubagentLauncher = (cmd, args, launchOpts) => {
    launches.push({ cmd, args, env: { ...launchOpts.env }, cwd: launchOpts.cwd });
    return makeFake().api;
  };
  const host = new SubagentHost(
    {
      eventsDirFor: () => dir,
      baseEnv: () => ({}),
      coreBinary: () => "/fake/agent-core.mjs",
      sessionRootFor: async (cwd) => join(dir, "sessions", Buffer.from(cwd).toString("hex").slice(0, 16)),
      appendMailboxNote: (_t, note) => { notes.push(note); },
      watchStream: () => {},
      releaseStream: () => {},
      dispatchKeysFor: async () => ({ keys: new Set<string>(), root: "" }),
      canonicalPath: async (p) => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      },
      isWorldlineTerminal: opts.isWorldlineTerminal ?? (() => false),
      workspaceRootFor: opts.workspaceRootFor ?? (() => ({ root: "/", cwd: "/" })),
      autoApproveAllowedFor: opts.autoApproveAllowedFor ?? (() => false),
    },
    { launch, backoffMs: [1, 1] },
  );
  return { dir, host, notes, launches };
}

describe("Issue #39: candidate sandbox escape via host-spawned subagent", () => {
  it("refuses worldline spawns without launching, even with a valid task file", async () => {
    const s = setup({ isWorldlineTerminal: () => true });
    const cwd = tmp();
    writeFileSync(
      join(s.dir, "subagent-term-7-bg-1.task.json"),
      JSON.stringify(validTask({ cwd, permissionMode: "always" })),
      { mode: 0o600 },
    );
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.launches.length).toBe(0);
    const body = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-1.result.json"), "utf8"));
    expect(body.outcome).toBe("failed");
    expect(s.notes.at(-1)).toMatch(/disabled in worldline candidates/);
  });

  it("ignores forged worldline task files without reading them", async () => {
    const s = setup({ isWorldlineTerminal: () => true });
    // No task file at all: a forged sidecar record alone must not launch.
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.launches.length).toBe(0);
    const body = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-1.result.json"), "utf8"));
    expect(body.outcome).toBe("failed");
    // Forged content claiming host paths and auto-approve is also ignored.
    writeFileSync(
      join(s.dir, "subagent-term-7-bg-2.task.json"),
      JSON.stringify(validTask({ runId: "bg-2", cwd: "/etc", permissionMode: "always" })),
      { mode: 0o600 },
    );
    await s.host.handleSpawn("term-7", "bg-2", "subagent-term-7-bg-2.task.json");
    expect(s.launches.length).toBe(0);
    const forged = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-2.result.json"), "utf8"));
    expect(forged.outcome).toBe("failed");
  });

  it("ignores forged handoffs pointing at another run's file", async () => {
    const s = setup();
    writeFileSync(
      join(s.dir, "subagent-term-7-bg-2.task.json"),
      JSON.stringify(validTask({ runId: "bg-2" })),
      { mode: 0o600 },
    );
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-2.task.json");
    expect(s.launches.length).toBe(0);
    const body = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-1.result.json"), "utf8"));
    expect(body.outcome).toBe("failed");
    expect(s.notes.at(-1)).toMatch(/handoff identity/);
  });

  it("rejects task files whose run id does not match the sidecar record", async () => {
    const s = setup();
    writeFileSync(
      join(s.dir, "subagent-term-7-bg-1.task.json"),
      JSON.stringify(validTask({ runId: "bg-2" })),
      { mode: 0o600 },
    );
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.launches.length).toBe(0);
    const body = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-1.result.json"), "utf8"));
    expect(body.outcome).toBe("failed");
    expect(s.notes.at(-1)).toMatch(/run mismatch/);
  });

  it("rejects cwd outside the parent workspace", async () => {
    const projA = realpathSync(tmp());
    const projB = realpathSync(tmp());
    const s = setup({ workspaceRootFor: () => ({ root: projA, cwd: projA }) });
    writeFileSync(
      join(s.dir, "subagent-term-7-bg-1.task.json"),
      JSON.stringify(validTask({ cwd: projB })),
      { mode: 0o600 },
    );
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.launches.length).toBe(0);
    const body = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-1.result.json"), "utf8"));
    expect(body.outcome).toBe("failed");
    expect(s.notes.at(-1)).toMatch(/outside parent workspace/);
  });

  it("fails closed when the parent workspace is unknown", async () => {
    const s = setup({ workspaceRootFor: () => null });
    writeFileSync(
      join(s.dir, "subagent-term-7-bg-1.task.json"),
      JSON.stringify(validTask()),
      { mode: 0o600 },
    );
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.launches.length).toBe(0);
    const body = JSON.parse(readFileSync(join(s.dir, "subagent-term-7-bg-1.result.json"), "utf8"));
    expect(body.outcome).toBe("failed");
  });

  it("clamps a forged always to ask when the workspace policy forbids auto-approve", async () => {
    const s = setup({ autoApproveAllowedFor: () => false });
    writeFileSync(
      join(s.dir, "subagent-term-7-bg-1.task.json"),
      JSON.stringify(validTask({ permissionMode: "always" })),
      { mode: 0o600 },
    );
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.launches.length).toBe(1);
    expect(s.launches[0]!.env.TERMINA_CORE_APPROVE).toBeUndefined();
  });

  it("inherits always only when the workspace policy allows it", async () => {
    const s = setup({ autoApproveAllowedFor: () => true });
    writeFileSync(
      join(s.dir, "subagent-term-7-bg-1.task.json"),
      JSON.stringify(validTask({ permissionMode: "always" })),
      { mode: 0o600 },
    );
    await s.host.handleSpawn("term-7", "bg-1", "subagent-term-7-bg-1.task.json");
    expect(s.launches.length).toBe(1);
    expect(s.launches[0]!.env.TERMINA_CORE_APPROVE).toBe("all");
  });

  it("detects the worldline candidate marker", () => {
    expect(isWorldlineCandidateEnv({})).toBe(false);
    expect(isWorldlineCandidateEnv({ TERMINA_WORLDLINE_CANDIDATE: "1" })).toBe(true);
    expect(isWorldlineCandidateEnv({ TERMINA_WORLDLINE_CANDIDATE: "0" })).toBe(false);
    expect(isWorldlineCandidateEnv({ TERMINA_WORLDLINE_CANDIDATE: "" })).toBe(false);
  });
});
