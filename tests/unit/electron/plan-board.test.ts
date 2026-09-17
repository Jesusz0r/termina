import { describe, it, expect } from "vitest";
import {
  MIN_SCHEDULE_INTERVAL_MS,
  dispatchWorkerModel,
  nextScheduleRun,
  parsePlanModelMarker,
  parsePlanTasks,
  parseScheduleMarker,
} from "../../../electron/plan-board.ts";

describe("Plan Board Task Parser Contract", () => {
  it("accepts a headed list with bullet, numbered, unchecked, and checked variants", async () => {
    const parsedSyntaxes = await parsePlanTasks(
      "## Plan\n\n- dash\n* star\n+ plus\n1. numbered dot\n2) numbered paren\n- [ ] unchecked\n* [x] checked lower\n+ [X] checked upper",
      null,
      (path: string) => path,
    );

    const summary = parsedSyntaxes.map((task) => `${task.text}:${task.state}`).join("|");
    expect(summary).toBe(
      "dash:pending|star:pending|plus:pending|numbered dot:pending|numbered paren:pending|unchecked:pending|checked lower:done|checked upper:done",
    );
  });

  it("ignores ordinary summary bullets when no plan heading or tasks exist", async () => {
    const summaryTasks = await parsePlanTasks(
      "Cleanup complete:\n\n- Deleted branches\n- Working tree is clean",
      null,
      (path: string) => path,
    );

    expect(summaryTasks.length).toBe(0);
  });

  it("ignores a heading-less checkbox list", async () => {
    const tasks = await parsePlanTasks(
      "- [ ] edit src/foo.ts\n- [ ] edit src/bar.ts\n",
      null,
      (path: string) => path,
    );
    expect(tasks).toEqual([]);
  });

  it("accepts a Plan: heading with a trailing title and prose before tasks", async () => {
    const tasks = await parsePlanTasks(
      "Plan: fix auth\n\nHere is the work:\n- [ ] edit src/auth.ts\n- [ ] add src/session.ts\n",
      null,
      (path: string) => path,
    );
    expect(tasks.map((task) => task.text)).toEqual(["edit src/auth.ts", "add src/session.ts"]);
  });

  it("does not treat a prose plan sentence as a heading", async () => {
    const tasks = await parsePlanTasks(
      "plan for the weekend\n- [ ] edit src/foo.ts\n",
      null,
      (path: string) => path,
    );
    expect(tasks).toEqual([]);
  });

  it("associates relative paths mentioned in tasks", async () => {
    const tasks = await parsePlanTasks(
      "Plan:\n- [ ] Create src/utils.ts for math helpers\n- [x] Edit greeting.ts to say hello",
      null,
      (path: string) => path,
    );

    expect(tasks.length).toBe(2);
    expect(tasks[0].state).toBe("pending");
    expect(tasks[1].state).toBe("done");
  });
});

describe("Plan Board model markers", () => {
  it("parses provider/id and ignores malformed refs", () => {
    expect(parsePlanModelMarker("fix src/auth.ts @model anthropic/claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
    expect(parsePlanModelMarker("fix src/auth.ts @model openai/gpt-5.4")).toBe("openai/gpt-5.4");
    expect(parsePlanModelMarker("plain task")).toBeNull();
    expect(parsePlanModelMarker("fix @model foo")).toBeNull();
    expect(parsePlanModelMarker("fix @model /openai/gpt")).toBeNull();
  });

  it("keeps the marker in task text and does not treat the model id as a path", async () => {
    const tasks = await parsePlanTasks(
      "Plan:\n- [ ] Create src/utils.ts @model anthropic/claude-sonnet-4-5\n- [ ] Edit greeting.ts",
      null,
      (path: string) => path,
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.text).toContain("@model anthropic/claude-sonnet-4-5");
    expect(tasks[0]!.model).toBe("anthropic/claude-sonnet-4-5");
    expect(tasks[0]!.paths).toEqual(["src/utils.ts"]);
    expect(tasks[1]!.model).toBeUndefined();
    expect(tasks[1]!.paths).toEqual(["greeting.ts"]);
  });

  it("lets an inherit IPC pin beat a task @model", () => {
    const task = { text: "Create src/utils.ts @model anthropic/claude-sonnet-4-5", paths: ["src/utils.ts"], state: "pending" as const, model: "anthropic/claude-sonnet-4-5" };
    expect(dispatchWorkerModel(task, "inherit")).toBeUndefined();
    expect(dispatchWorkerModel(task, "openai/gpt-5.4")).toBe("openai/gpt-5.4");
    expect(dispatchWorkerModel(task)).toBe("anthropic/claude-sonnet-4-5");
    expect(dispatchWorkerModel({ text: "Edit greeting.ts", paths: ["greeting.ts"], state: "pending" })).toBeUndefined();
  });
});

describe("Plan Board Schedule Markers", () => {
  it("parses every/at markers and rejects the rest", () => {
    expect(parseScheduleMarker("lint @every 30m")).toEqual({ kind: "every", intervalMs: 30 * 60_000 });
    expect(parseScheduleMarker("lint @every 2h")).toEqual({ kind: "every", intervalMs: 2 * 3_600_000 });
    expect(parseScheduleMarker("standup @at 09:30")).toEqual({ kind: "at", hour: 9, minute: 30 });
    expect(parseScheduleMarker("plain task")).toBeNull();
    expect(parseScheduleMarker("lint @every 30x")).toBeNull();
    expect(parseScheduleMarker("standup @at 25:00")).toBeNull();
  });

  it("rejects intervals below the minimum", () => {
    expect(parseScheduleMarker("lint @every 30s")).toBeNull();
    expect(parseScheduleMarker("lint @every 4m")).toBeNull();
    expect(parseScheduleMarker(`lint @every ${MIN_SCHEDULE_INTERVAL_MS / 60_000}m`)).not.toBeNull();
  });

  it("fires every-intervals immediately at first, then by interval", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const spec = parseScheduleMarker("lint @every 1h")!;
    expect(nextScheduleRun(spec, now, true)).toBe(now);
    expect(nextScheduleRun(spec, now, false)).toBe(now + 3_600_000);
  });

  it("schedules at-markers for the next occurrence", () => {
    const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();
    const morning = parseScheduleMarker("standup @at 09:30")!;
    const evening = parseScheduleMarker("sync @at 18:00")!;
    const nextMorning = new Date(nextScheduleRun(morning, noon, false));
    expect(nextMorning.getHours()).toBe(9);
    expect(nextMorning.getDate()).toBe(2);
    const nextEvening = new Date(nextScheduleRun(evening, noon, false));
    expect(nextEvening.getHours()).toBe(18);
    expect(nextEvening.getDate()).toBe(1);
  });
});
