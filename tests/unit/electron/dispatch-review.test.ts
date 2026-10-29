import { describe, expect, it } from "vitest";
import { formatDispatchBriefing, isReviewTask, parsePlanTasks, pickDispatchTasks } from "../../../electron/plan-board.ts";

describe("file-scoped review Dispatch", () => {
  it("uses an explicit marker and the normal task paths and model pin", async () => {
    const [task] = await parsePlanTasks("Plan:\n- [ ] Review src/auth.ts @review @model openai/example", null, p => p);
    expect(task).toMatchObject({ paths: ["src/auth.ts"], model: "openai/example", state: "pending" });
    expect(isReviewTask(task!)).toBe(true);
    for (const text of ["mail@review", "src/@review.ts", "@reviewer", "Review src/auth.ts"]) {
      expect(isReviewTask({ text })).toBe(false);
    }
  });

  it("refuses a pathless review and shares exact existing claims with ordinary tasks", async () => {
    const tasks = await parsePlanTasks("Plan:\n- [ ] Review everything @review\n- [ ] Review a.ts @review\n- [ ] Edit a.ts\n- [ ] Edit b.ts", null, p => p);
    const options = { plan: tasks, remainingSlots: 3, inFlightPathKeys: new Set<string>(), pathKey: (p: string) => p };
    expect(await pickDispatchTasks({ ...options, taskText: tasks[0]!.text })).toMatchObject({ tasks: [], error: expect.stringContaining("explicit file paths") });
    expect((await pickDispatchTasks(options)).tasks.map(t => t.text)).toEqual([tasks[1]!.text, tasks[3]!.text]);
    expect(await pickDispatchTasks({ ...options, taskText: tasks[1]!.text, inFlightPathKeys: new Set(["a.ts"]) })).toMatchObject({ tasks: [], error: expect.stringContaining("overlaps") });
  });

  it("briefs the reviewer through the existing worker briefing without changing writable jobs", async () => {
    const [review, edit] = await parsePlanTasks("Plan:\n- [ ] Review a.ts @review\n- [ ] Edit b.ts", null, p => p);
    const jobs = [{ id: "term-2", task: review! }, { id: "term-3", task: edit! }];
    expect(formatDispatchBriefing("term-2", review!, jobs)).toContain("disabled for this entire session");
    expect(formatDispatchBriefing("term-2", review!, jobs)).toContain("file and line");
    expect(formatDispatchBriefing("term-2", review!, jobs)).toContain("`b.ts`");
    expect(formatDispatchBriefing("term-3", edit!, jobs)).not.toContain("### Read-only review");
  });
});
