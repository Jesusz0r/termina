import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceEngine, type EvidenceDeps } from "../../../electron/evidence.ts";
import type { SnapshotStore } from "../../../electron/worldline-git.ts";
import type { EvidenceRecord } from "../../../shared/types.ts";

type Head = { commit: string; tree: string };

async function measureWithHeads(heads: Array<Head | Error>): Promise<EvidenceRecord[]> {
  const root = await mkdtemp(join(tmpdir(), "termina-evidence-pin-"));
  const queue = [...heads];
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const store = {
      readBlob: async (_stateId: string, relPath: string): Promise<Buffer | null> =>
        relPath === "package.json" ? Buffer.from(JSON.stringify({ dependencies: {} })) : null,
      diffTree: async (): Promise<Array<{ relPath: string; status: "created" | "modified" | "deleted" }>> => [],
    } as unknown as SnapshotStore;
    const deps: EvidenceDeps = {
      store,
      baseStateId: "base",
      primaryRoot: root,
      mineFiles: new Set(),
      captureHead: async () => {
        const next = queue.shift();
        if (!next) throw new Error("no more heads");
        if (next instanceof Error) throw next;
        return next;
      },
      runSandboxed: async () => {
        throw new Error("no sandboxed run expected");
      },
      baseTestCommand: () => null,
      benchmarkConfig: () => null,
      sourceFilesOf: async () => [],
    };
    const engine = new EvidenceEngine(deps);
    return await engine.measure("A", {
      root,
      profilePath: join(root, "p.sb"),
      homeDir: root,
      tmpDir: root,
      shell: "/bin/sh",
      eventsDir: "",
      terminalId: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("evidence state pinning (issue #239)", () => {
  it("records the pinned state id on every evidence record", async () => {
    const records = await measureWithHeads([
      { commit: "h1a", tree: "t1" },
      { commit: "h1b", tree: "t1" },
    ]);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.stateId).toBe("h1a");
      expect(record.baseStateId).toBe("base");
    }
  });

  it("accepts a new capture commit when the tree is unchanged", async () => {
    const records = await measureWithHeads([
      { commit: "h1a", tree: "t1" },
      { commit: "h1b", tree: "t1" },
    ]);
    expect(records.every((record) => record.stateId === "h1a")).toBe(true);
  });

  it("fails closed when the start pin is missing", async () => {
    await expect(measureWithHeads([{ commit: "", tree: "" }])).rejects.toThrow(/could not pin the candidate state/);
    await expect(measureWithHeads([{ commit: "h1a", tree: "" }])).rejects.toThrow(/could not pin the candidate state/);
  });

  it("fails closed when the start pin throws", async () => {
    await expect(measureWithHeads([new Error("recording is not available")])).rejects.toThrow(
      /could not pin the candidate state: recording is not available/,
    );
  });

  it("fails closed when the candidate tree moves during measure", async () => {
    await expect(
      measureWithHeads([
        { commit: "h1a", tree: "t1" },
        { commit: "h2b", tree: "t2" },
      ]),
    ).rejects.toThrow(/the candidate changed during evidence/);
  });

  it("fails closed when the recheck capture fails", async () => {
    await expect(
      measureWithHeads([
        { commit: "h1a", tree: "t1" },
        new Error("recording is not available"),
      ]),
    ).rejects.toThrow(/could not re-verify the candidate state: recording is not available/);
  });

  it("fails closed when the recheck omits commit or tree", async () => {
    await expect(
      measureWithHeads([
        { commit: "h1a", tree: "t1" },
        { commit: "h1b", tree: "" },
      ]),
    ).rejects.toThrow(/could not re-verify the candidate state/);
  });
});
