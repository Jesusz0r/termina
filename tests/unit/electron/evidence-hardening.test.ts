import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceEngine, type EvidenceDeps } from "../../../electron/evidence.ts";
import type { SnapshotStore } from "../../../electron/worldline-git.ts";
import type { EvidenceRecord } from "../../../shared/types.ts";

interface MeasureOpts {
  baseBlobs?: Record<string, string>;
  headFiles?: Record<string, string>;
  diff?: Array<{ relPath: string; status: "created" | "modified" | "deleted" }>;
  sourceFiles?: Array<{ relPath: string; content: string }>;
  benchmarkConfig?: EvidenceDeps["benchmarkConfig"];
  runSandboxed?: EvidenceDeps["runSandboxed"];
  baseTestCommand?: EvidenceDeps["baseTestCommand"];
  eventsFile?: { terminalId: string; content: string };
}

async function measured(opts: MeasureOpts): Promise<EvidenceRecord[]> {
  const root = await mkdtemp(join(tmpdir(), "termina-evidence-harden-"));
  try {
    await writeFile(join(root, "package.json"), opts.headFiles?.["package.json"] ?? JSON.stringify({ dependencies: {} }));
    for (const [rel, content] of Object.entries(opts.headFiles ?? {})) {
      if (rel === "package.json") continue;
      await writeFile(join(root, rel), content);
    }
    const eventsDir = join(root, "events");
    let terminalId: string | null = null;
    if (opts.eventsFile) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(eventsDir, { recursive: true });
      await writeFile(join(eventsDir, `${opts.eventsFile.terminalId}.jsonl`), opts.eventsFile.content);
      terminalId = opts.eventsFile.terminalId;
    }
    const store = {
      readBlob: async (stateId: string, relPath: string): Promise<Buffer | null> => {
        if (relPath === "package.json") {
          const manifest = stateId === "base" ? opts.baseBlobs?.["package.json"] : undefined;
          return Buffer.from(manifest ?? JSON.stringify({ dependencies: {} }));
        }
        const key = `${stateId}:${relPath}`;
        const text = opts.baseBlobs?.[key] ?? opts.baseBlobs?.[relPath];
        return text === undefined ? null : Buffer.from(text);
      },
      diffTree: async (): Promise<Array<{ relPath: string; status: "created" | "modified" | "deleted" }>> => opts.diff ?? [],
    } as unknown as SnapshotStore;
    const deps: EvidenceDeps = {
      store,
      baseStateId: "base",
      primaryRoot: root,
      mineFiles: new Set(),
      captureHead: async () => ({ commit: "head", tree: "tree" }),
      runSandboxed: opts.runSandboxed ?? (async () => {
        throw new Error("no sandboxed run expected");
      }),
      baseTestCommand: opts.baseTestCommand ?? (() => null),
      benchmarkConfig: opts.benchmarkConfig ?? (() => null),
      sourceFilesOf: async () => opts.sourceFiles ?? [],
    };
    const engine = new EvidenceEngine(deps);
    // Awaited: returning the bare promise would let finally raze the fixture.
    return await engine.measure("A", {
      root,
      profilePath: join(root, "p.sb"),
      homeDir: root,
      tmpDir: root,
      shell: "/bin/sh",
      eventsDir: terminalId ? eventsDir : "",
      terminalId,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("evidence hardening (issue #193)", () => {
  it("detects signatures differing only inside // string runs", async () => {
    const manifest = JSON.stringify({ main: "index.js" });
    const records = await measured({
      baseBlobs: { "package.json": manifest, "index.d.ts": 'export const u: "http://a";\n' },
      headFiles: { "package.json": manifest, "index.d.ts": 'export const u: "http://b";\n' },
    });
    const api = records.find((r) => r.kind === "api")!;
    expect(api.status).toBe("fail");
    expect(api.result.changed).toEqual(["index.d.ts"]);
  });

  it("treats comment-only signature edits as unchanged", async () => {
    const manifest = JSON.stringify({ main: "index.js" });
    const records = await measured({
      baseBlobs: { "package.json": manifest, "index.d.ts": "/* banner\nspanning lines */\nexport const x: 1;\n// trailing\n" },
      headFiles: { "package.json": manifest, "index.d.ts": "export const x: 1;\n" },
    });
    expect(records.find((r) => r.kind === "api")?.status).toBe("pass");
  });

  it("counts deleted files in the footprint", async () => {
    const records = await measured({
      baseBlobs: { "base:gone.ts": "a\nb\nc", "head:new.ts": "x\ny" },
      diff: [
        { relPath: "gone.ts", status: "deleted" },
        { relPath: "new.ts", status: "created" },
      ],
    });
    const footprint = records.find((r) => r.kind === "footprint")!;
    expect(footprint.result.changedFiles).toBe(2);
    expect(footprint.result.changedLines).toBe(5);
  });

  it("reports unavailable benchmarks for a non-usable sample count", async () => {
    const store = {} as unknown as SnapshotStore;
    const deps: EvidenceDeps = {
      store,
      baseStateId: "base",
      primaryRoot: "/tmp",
      mineFiles: new Set(),
      captureHead: async () => ({ commit: "h", tree: "t" }),
      runSandboxed: async () => {
        throw new Error("no sandboxed run expected");
      },
      baseTestCommand: () => null,
      benchmarkConfig: () => ({ command: ["bench"], unit: "ms", direction: "lower", samples: NaN, thresholdPct: 5 }),
      sourceFilesOf: async () => [],
    };
    const engine = new EvidenceEngine(deps);
    const cands = {
      A: { root: "/tmp", profilePath: "p", homeDir: "/tmp", tmpDir: "/tmp", shell: "sh", eventsDir: "", terminalId: null },
      B: { root: "/tmp", profilePath: "p", homeDir: "/tmp", tmpDir: "/tmp", shell: "sh", eventsDir: "", terminalId: null },
    };
    const both = await engine.measureBenchmarks(cands, { A: "a", B: "b" });
    expect(both.A.status).toBe("unavailable");
    expect(both.B.status).toBe("unavailable");
    expect(both.A.reason).toContain("sample count");
  });

  it("scores a valid single-sample benchmark", async () => {
    const store = {} as unknown as SnapshotStore;
    const deps: EvidenceDeps = {
      store,
      baseStateId: "base",
      primaryRoot: "/tmp",
      mineFiles: new Set(),
      captureHead: async () => ({ commit: "h", tree: "t" }),
      runSandboxed: async () => ({ code: 0, stdout: "bench 10 ms\n", timedOut: false }),
      baseTestCommand: () => null,
      benchmarkConfig: () => ({ command: ["bench"], unit: "ms", direction: "lower", samples: 1, thresholdPct: 5 }),
      sourceFilesOf: async () => [],
    };
    const engine = new EvidenceEngine(deps);
    const cands = {
      A: { root: "/tmp", profilePath: "p", homeDir: "/tmp", tmpDir: "/tmp", shell: "sh", eventsDir: "", terminalId: null },
      B: { root: "/tmp", profilePath: "p", homeDir: "/tmp", tmpDir: "/tmp", shell: "sh", eventsDir: "", terminalId: null },
    };
    const both = await engine.measureBenchmarks(cands, { A: "a", B: "b" });
    expect(both.A.status).toBe("pass");
    expect((both.A.result.median as number)).toBe(10);
  });

  it("counts only the last run's trajectory signals", async () => {
    const lines = [
      { bridgeId: "b", seq: 1, t: "agent_start" },
      { bridgeId: "b", seq: 2, t: "tool", path: "a.ts", toolCallId: "c1" },
      { bridgeId: "b", seq: 3, t: "tool_end", toolCallId: "c1", isError: true },
      { bridgeId: "b", seq: 4, t: "agent_start" },
      { bridgeId: "b", seq: 5, t: "tool", path: "c.ts", toolCallId: "c3" },
      { bridgeId: "b", seq: 6, t: "agent_settled", timedOut: true, command: "run npm test now" },
      { bridgeId: "b", seq: 7, t: "agent_settled", cancelled: true },
    ];
    const records = await measured({
      baseTestCommand: () => ({ command: "npm", args: ["test"], label: "npm test" }),
      runSandboxed: async () => ({ code: 0, stdout: "", timedOut: false }),
      eventsFile: { terminalId: "term-1", content: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n` },
    });
    const trajectory = records.find((r) => r.kind === "trajectory")!;
    expect(trajectory.status).toBe("pass");
    expect(trajectory.result).toMatchObject({
      fileToolStarts: 1,
      fileToolErrors: 0,
      lastErrorCount: 0,
      openFileTools: 1,
      timedOut: 1,
      cancelled: 1,
      testLabelSeen: true,
    });
  });
});
