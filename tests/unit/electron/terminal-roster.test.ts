import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fitTerminalRoster, isRosterModel, parseTerminalRoster } from "../../../electron/terminal-roster.ts";

describe("terminal roster model pin", () => {
  it("accepts a provider-qualified model on agent entries", () => {
    const [entry] = parseTerminalRoster([
      { id: "term-1", type: "agent", engine: "core", model: "anthropic/claude-opus-4-6" },
    ]);
    expect(entry?.model).toBe("anthropic/claude-opus-4-6");
  });

  it("drops malformed models but keeps the entry", () => {
    for (const model of ["", "no-slash", "/leading", "trailing/", "has space/x", "a\nb/x", "x".repeat(201)]) {
      const [entry] = parseTerminalRoster([{ id: "term-1", type: "agent", engine: "core", model }]);
      expect(entry?.model).toBeUndefined();
      expect(entry?.id).toBe("term-1");
    }
  });

  it("entries without a model stay valid", () => {
    const [entry] = parseTerminalRoster([{ id: "term-2", type: "agent", engine: "core" }]);
    expect(entry?.model).toBeUndefined();
  });

  it("validates the provider/model shape", () => {
    expect(isRosterModel("openai/gpt-5")).toBe(true);
    expect(isRosterModel("openrouter/openai/gpt-5")).toBe(true);
    expect(isRosterModel("bare")).toBe(false);
    expect(isRosterModel("a/")).toBe(false);
  });
});

describe("terminal roster handoff", () => {
  it("keeps plan tasks and the last verdict", () => {
    const [entry] = parseTerminalRoster([{
      id: "term-1",
      type: "agent",
      engine: "core",
      plan: [{ text: "add tests", paths: ["a.ts"], state: "done" }],
      verify: { state: "fail", command: "npm test", summary: "1 failing" },
    }]);
    expect(entry?.plan).toEqual([{ text: "add tests", paths: ["a.ts"], state: "done" }]);
    expect(entry?.verify).toEqual({ state: "fail", command: "npm test", summary: "1 failing" });
  });

  it("drops malformed handoff fields but keeps the entry", () => {
    const [entry] = parseTerminalRoster([{
      id: "term-1",
      type: "agent",
      engine: "core",
      plan: [{ text: "", paths: "nope", state: "bogus" }, "nope", null],
      verify: { state: "running", command: "x".repeat(500), summary: null },
    }]);
    expect(entry?.plan).toBeUndefined();
    expect(entry?.verify).toBeUndefined();
    expect(entry?.id).toBe("term-1");
  });

  it("caps handoff size and ignores non-agent entries", () => {
    const plan = Array.from({ length: 60 }, (_, i) => ({ text: `t${i}`, paths: [], state: "pending" }));
    const [agent, shell] = parseTerminalRoster([
      { id: "term-1", type: "agent", engine: "core", plan },
      { id: "term-2", type: "shell", shell: "/bin/zsh", plan, verify: { state: "pass", command: null, summary: null } },
    ]);
    expect(agent?.plan?.length).toBe(50);
    expect(shell?.plan).toBeUndefined();
    expect(shell?.verify).toBeUndefined();
  });

  it("degrades handoff before identity under the byte budget", () => {
    const big = (id: string) => ({
      id,
      type: "agent" as const,
      engine: "core" as const,
      plan: Array.from({ length: 50 }, (_, _i) => ({ text: "x".repeat(500), paths: ["y".repeat(256)], state: "pending" as const })),
      verify: { state: "fail" as const, command: "c", summary: "s" },
    });
    const full = [big("term-1"), big("term-2")];
    expect(JSON.stringify({ terminals: full }).length).toBeGreaterThan(64 * 1024);
    const fitted = fitTerminalRoster(full);
    expect(JSON.stringify({ terminals: fitted }).length).toBeLessThanOrEqual(64 * 1024);
    expect(fitted).toHaveLength(2);
    expect(fitted[0]?.plan).toBeDefined();
    expect(fitted[1]?.plan).toBeUndefined();
  });
});

describe("roster handoff wiring", () => {
  it("persists the board and verdict, and restores without worker claims", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("../../../electron/roster-store.ts", import.meta.url), "utf8");
    // Persist: board without assignments, settled verdicts only.
    expect(store.includes("entry.plan = inst.plan.slice(0, MAX_ROSTER_PLAN_TASKS).map((t) => ({"))
      .toBe(true);
    expect(store.includes("if (inst.verify.state !== \"untested\" && inst.verify.state !== \"running\") {"))
      .toBe(true);
    // Restore: assignments never survive, active tasks return to pending.
    expect(main.includes("state: t.state === \"done\" ? \"done\" : \"pending\","))
      .toBe(true);
    expect(main.includes("this.sendPlan(inst);"))
      .toBe(true);
    // Save fits the byte budget by degrading handoff before identity.
    expect(store.includes("fitTerminalRoster(composeTerminalRoster(live, unrestored))"))
      .toBe(true);
    // Board and verdict mutations persist the handoff (transients excluded).
    expect(main.includes("this.savePlanRoster(inst);"))
      .toBe(true);
    expect(main.includes("this.savePlanRoster(ownerInst);"))
      .toBe(true);
    expect(main.includes("this.savePlanRoster(owner);"))
      .toBe(true);
  });

  it("pins the roster model on the instance and keeps it across restore saves", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    expect(main.includes("const resumeModel = this.usableAgentModel(opts?.model);"))
      .toBe(true);
    expect(main.includes("const provisional = this.usableAgentModel(`${provider}/${modelName}`);"))
      .toBe(true);
    expect(main.includes("if (provisional) inst.model = provisional;"))
      .toBe(true);
    expect(main.includes("if (modelChanged && inst.persist) this.savePlanRoster(inst);"))
      .toBe(true);
    expect(main.includes("if (!this.projectIsSwitching(project.id)) this.saveTerminalRoster(project);"))
      .toBe(true);
  });
});
