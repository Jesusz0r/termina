import { describe, expect, it, vi } from "vitest";
import { appendPlanTask } from "../../../electron/main/plan-create.ts";
import { planCreationError, planTaskTextError, parseScheduleMarker } from "../../../electron/plan-board.ts";
import { parsePlanTaskCreateRequest } from "../../../electron/main/ipc-validate.ts";
import { projectWorkSummary } from "../../../electron/main/work-summary.ts";
import type { PlanTask } from "../../../shared/types.ts";

const owner = { projectId: "background-project", workspaceId: "primary-workspace", terminalId: "term-1", generation: 4, root: "/actual/root" };
const request = { owner, projectRoot: "/displayed/root", text: "Fix src/file.ts @model provider/model" };
const eligible = { available: true, primary: true, persistent: true, agent: true, dispatchWorker: false, busy: false, taskCount: 0 };
function host(text = request.text, plan: PlanTask[] = []) {
  return { text, plan, root: owner.root, currentError: vi.fn((): string | null => null),
    canonicalize: vi.fn(async (path: string) => path), publish: vi.fn() };
}

describe("manual Plan Board creation", () => {
  it("validates and copies exact identity without guessing roots or trimming text", () => {
    const parsed = parsePlanTaskCreateRequest(request);
    expect(parsed).toEqual(request);
    expect(parsed?.owner).not.toBe(owner);
    for (const value of [null, {}, { ...request, owner: null }, { ...request, projectRoot: "" },
      { ...request, owner: { ...owner, generation: 0 } }, { ...request, owner: { ...owner, workspaceId: "" } },
      { ...request, text: "x".repeat(501) }]) expect(parsePlanTaskCreateRequest(value)).toBeNull();
  });

  it("projects the exact authoritative eligibility error", () => {
    const error = planCreationError({ ...eligible, busy: true });
    const summary = projectWorkSummary({ id: owner.projectId, cwd: request.projectRoot }, [{
      id: owner.terminalId, generation: owner.generation, type: "agent", model: null,
      activity: { state: "idle", reason: null }, workspace: { id: owner.workspaceId, root: owner.root, primary: true },
      verify: { state: "untested", command: null, summary: null }, trackedChanges: 0, plan: [], planCreationError: error, planStartOwnerError: error,
    }]);
    expect(summary.terminals[0]?.planCreationError).toBe(error);
    expect(planCreationError(eligible)).toBeNull();
    for (const facts of [{ available: false }, { primary: false }, { persistent: false }, { agent: false },
      { dispatchWorker: true }, { busy: true }, { taskCount: 20 }]) {
      expect(planCreationError({ ...eligible, ...facts })).toEqual(expect.any(String));
    }
  });

  it("appends pending task and preserves existing objects, claims, results and model", async () => {
    const existing: PlanTask = { text: "Existing", paths: ["other.ts"], state: "active", workerId: "term-2",
      claimed: ["other.ts"], model: "provider/other", dispatchResult: { workerId: "old", outcome: "failed" } };
    const before = structuredClone(existing);
    const h = host(request.text, [existing]);
    const result = await appendPlanTask(h);
    expect(result).toEqual({ ok: true, task: { text: request.text, paths: ["src/file.ts"], state: "pending", model: "provider/model" } });
    expect(h.plan[0]).toBe(existing);
    expect(existing).toEqual(before);
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.currentError).toHaveBeenCalledTimes(2);
    expect(parseScheduleMarker(h.plan[1]!.text)).toBeNull();
  });

  it.each(["", "   ", "a\nb", "a\rb", "a\tb", "a\x00b", "a\x7fb", "a\u2028b", "x".repeat(501), "Run @every 30m", "Run @at 09:30",
    "Run @every 4m", "Run @every -5m", "Run @at 25:00", "Run @AT 10:00", "Run @every later"])(
    "rejects invalid/automatically scheduled text %j without persistence", async (text) => {
      const h = host(text);
      expect(await appendPlanTask(h)).toMatchObject({ ok: false });
      expect(h.plan).toEqual([]);
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.canonicalize).not.toHaveBeenCalled();
    });

  it("accepts exactly 500 characters and rejects exact duplicates/capacity", async () => {
    expect(planTaskTextError("x".repeat(500), [])).toBeNull();
    const duplicate = host("same", [{ text: "same", paths: [], state: "done" }]);
    expect(await appendPlanTask(duplicate)).toMatchObject({ ok: false });
    const full = host("new", Array.from({ length: 20 }, (_, i) => ({ text: `task ${i}`, paths: [], state: "pending" })));
    expect(await appendPlanTask(full)).toMatchObject({ ok: false });
    expect(full.publish).not.toHaveBeenCalled();
  });

  it("rechecks lifecycle after asynchronous path derivation", async () => {
    const h = host("Fix /actual/root/file.ts");
    h.canonicalize.mockImplementation(async (path) => {
      h.currentError.mockReturnValue("The Plan Board context has changed.");
      return path;
    });
    expect(await appendPlanTask(h)).toEqual({ ok: false, error: "The Plan Board context has changed." });
    expect(h.plan).toEqual([]);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "capacity"])("rechecks concurrent %s before append", async (kind) => {
    const h = host("Fix /actual/root/file.ts");
    h.canonicalize.mockImplementation(async (path) => {
      if (h.plan.length === 0) h.plan.push(...(kind === "duplicate"
        ? [{ text: h.text, paths: [], state: "pending" as const }]
        : Array.from({ length: 20 }, (_, i) => ({ text: `task ${i}`, paths: [], state: "pending" as const }))));
      return path;
    });
    expect(await appendPlanTask(h)).toMatchObject({ ok: false });
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.plan).toHaveLength(kind === "duplicate" ? 1 : 20);
  });

  it("reports derivation failure without changing the board", async () => {
    const h = host("Fix /actual/root/file.ts");
    h.canonicalize.mockRejectedValue(new Error("unavailable"));
    expect(await appendPlanTask(h)).toEqual({ ok: false, error: "Could not derive task paths: unavailable" });
    expect(h.plan).toEqual([]);
    expect(h.publish).not.toHaveBeenCalled();
  });
});
