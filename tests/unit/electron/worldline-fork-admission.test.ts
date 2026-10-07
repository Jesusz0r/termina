import { describe, expect, it, vi } from "vitest";
import { WorldlineManager, type WorldlineDeps } from "../../../electron/worldlines/manager.ts";
import type { RunRecord } from "../../../electron/worldlines/types.ts";
import type { TimelineEvent } from "../../../shared/types.ts";

function fixture() {
  const run: RunRecord = {
    id: "run-1", engine: "core", replayable: true, startStateId: "base", settledStateId: "head",
    sessionFile: "/sessions/source/current/active.jsonl", sessionBranchFile: "/sessions/branch/current/active.jsonl",
    terminalId: "term-1", workspaceId: "workspace-1", promptPayloadFile: null, promptEventsDir: null,
    promptText: null, promptEntryId: null, promptParentEntryId: null, settledEntryId: null,
    uncertainSessionFile: null, model: null, thinkingLevel: null, reason: null, interrupted: false,
    steering: false, overlap: false, unownedEdits: 0, startedAt: 0, settledAt: 1,
    trustHashes: { "AGENTS.md": "baseline" },
  } satisfies RunRecord;
  const deps = {
    primaryRoot: "/primary",
    preflight: vi.fn(async () => ({ ok: true, reasons: [] as string[] })),
    getStore: vi.fn(async () => ({ sourceRoot: "/primary", sourceGitDir: "/primary/.git" })),
    trustHashes: vi.fn(async (): Promise<Record<string, string>> => ({ "AGENTS.md": "baseline" })),
  };
  const allocate = vi.fn(async () => ({ ok: false, error: "allocation reached" }));
  const manager: WorldlineManager = Object.assign(Object.create(WorldlineManager.prototype), {
    ready: Promise.resolve(), deps: deps as unknown as WorldlineDeps,
    runOf: () => run, runCovering: () => run, candidateContextOf: () => null,
    readPromptPayload: async () => ({ kind: "absent" }),
    acquireUncertainComparisonAdmission: allocate,
  });
  const moment = { seq: 1, t: "tool", ts: 1, stateId: "moment", entryId: "seq:1" } as TimelineEvent;
  return { run, deps, manager, moment, allocate };
}

for (const kind of ["run", "moment"] as const) {
  describe(`${kind} candidate source admission`, () => {
    const fork = ({ manager, moment }: ReturnType<typeof fixture>) => kind === "run" ? manager.forkRun("run-1") : manager.forkPoint("term-1", moment);

    it("rejects unavailable sandbox or repository before allocating candidates", async () => {
      const f = fixture();
      f.deps.preflight.mockResolvedValue({ ok: false, reasons: ["the platform has no sandbox-exec"] });
      expect(await fork(f)).toEqual({ ok: false, error: "the platform has no sandbox-exec" });
      expect(f.deps.getStore).not.toHaveBeenCalled();
    });

    it("rejects a changed repository identity", async () => {
      const f = fixture();
      f.deps.getStore.mockResolvedValue({ sourceRoot: "/replacement", sourceGitDir: "/replacement/.git" });
      expect(await fork(f)).toEqual({ ok: false, error: "the source repository identity changed since the run" });
    });

    it("rejects a missing trust-sensitive baseline", async () => {
      const f = fixture();
      f.run.trustHashes = null;
      expect(await fork(f)).toEqual({ ok: false, error: "the run has no complete trust-sensitive baseline" });
    });

    it("rejects changed or unreadable trust-sensitive resources", async () => {
      const f = fixture();
      f.deps.trustHashes.mockResolvedValue({ "AGENTS.md": "changed" });
      expect(await fork(f)).toEqual({ ok: false, error: "trust-sensitive resources changed since the run: AGENTS.md" });
      f.deps.trustHashes.mockRejectedValue(new Error("hash failed"));
      expect(await fork(f)).toEqual({ ok: false, error: "trust-sensitive resources could not be verified: hash failed" });
    });

    it.each(["added", "deleted"] as const)("rejects %s trust-sensitive paths before allocation", async (change) => {
      const f = fixture();
      const current: Record<string, string> = { "AGENTS.md": "baseline" };
      const path = change === "added" ? ".agents/skills/new/SKILL.md" : "AGENTS.md";
      if (change === "added") current[path] = "new";
      else delete current[path];
      f.deps.trustHashes.mockResolvedValue(current);
      expect(await fork(f)).toEqual({ ok: false, error: `trust-sensitive resources changed since the run: ${path}` });
      expect(f.allocate).not.toHaveBeenCalled();
    });

    it("reaches allocation only after successful source checks", async () => {
      const f = fixture();
      expect(await fork(f)).toEqual({ ok: false, error: "allocation reached" });
      expect(f.deps.preflight).toHaveBeenCalledTimes(1);
      expect(f.deps.trustHashes).toHaveBeenCalledTimes(1);
    });
  });
}
