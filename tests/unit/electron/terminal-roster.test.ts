import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { composeTerminalRoster, fitTerminalRoster, isRosterModel, MAX_ROSTER_FILE_BYTES, MAX_ROSTER_HANDOFF_BYTES, parseTerminalRoster } from "../../../electron/terminal-roster.ts";

describe("terminal roster model pin", () => {
  it("accepts a provider-qualified model on agent entries", () => {
    const [entry] = parseTerminalRoster([
      { id: "term-1", type: "agent", engine: "core", model: "anthropic/claude-opus-4-6" },
    ]);
    expect(entry?.model).toBe("anthropic/claude-opus-4-6");
  });

  it("keeps a shell's absolute directory and drops a relative one", () => {
    const [kept] = parseTerminalRoster([{ id: "term-1", type: "shell", shell: "/bin/zsh", cwd: "/tmp/work" }]);
    const [dropped] = parseTerminalRoster([{ id: "term-2", type: "shell", shell: "/bin/zsh", cwd: "relative" }]);
    expect(kept?.cwd).toBe("/tmp/work");
    expect(dropped?.cwd).toBeUndefined();
    expect(dropped?.id).toBe("term-2");
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
    const verify = {
      state: "fail", command: "npm test", summary: "1 failing",
      source: { root: "/project", workspaceId: "ws-1", tree: "a".repeat(40), revision: 3, observationEpoch: 1, generation: 4 },
      result: { state: "fail", exitCode: 1, startedAt: 100, finishedAt: 200 },
    };
    const [entry] = parseTerminalRoster([{
      id: "term-1",
      type: "agent",
      engine: "core",
      plan: [{ text: "add tests", paths: ["a.ts"], state: "done" }],
      verify,
      verifyOutput: "fixture output\n",
    }]);
    expect(entry?.plan).toEqual([{ text: "add tests", paths: ["a.ts"], state: "done" }]);
    expect(entry?.verify).toEqual(verify);
    expect(entry?.verifyOutput).toBe("fixture output\n");
    const restored = parseTerminalRoster(JSON.parse(JSON.stringify([entry])))[0]!;
    expect(restored.verify).toEqual(verify);
    expect(restored.verifyOutput).toBe("fixture output\n");
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

  it("drops bounded output before verdicts when the roster byte budget is full", () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `term-${i + 1}`, type: "agent" as const, engine: "core" as const,
      verify: { state: "pass" as const, command: "npm run test", summary: "tests green" },
      verifyOutput: "x".repeat(6000),
    }));
    const fitted = fitTerminalRoster(entries);
    expect(Buffer.byteLength(JSON.stringify({ terminals: fitted }))).toBeLessThanOrEqual(64 * 1024);
    expect(fitted).toHaveLength(12);
    expect(fitted.every((entry) => entry.verify?.state === "pass")).toBe(true);
    expect(fitted.every((entry) => entry.verifyOutput === undefined)).toBe(true);
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
    expect(store.includes("fitTerminalRoster(roster)"))
      .toBe(true);
    // Board and verdict mutations persist the handoff (transients excluded).
    expect(main.includes("this.savePlanRoster(inst);"))
      .toBe(true);
    expect(main.includes("this.savePlanRoster(ownerInst);"))
      .toBe(true);
    expect(main.includes("this.savePlanRoster(owner);"))
      .toBe(true);
  });

  it("keeps the plan board across ordinary agent_start runs", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const start = main.indexOf('case "agent_start":');
    const end = main.indexOf('case "agent_settled":', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const startBlock = main.slice(start, end);
    expect(startBlock).not.toContain("inst.plan = []");
    expect(startBlock).toContain("inst.touched = new Set()");
    expect(startBlock).not.toContain("this.sendPlan(inst, rendererTarget)");
  });

  it("pins the roster model on the instance and keeps it across restore saves", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    expect(main.includes("const pin = this.usableAgentModel(opts?.model) ?? this.copiedCoreModel(opts?.fromTerminalId);"))
      .toBe(true);
    expect(main.includes("const workerModel = dispatchWorkerModel(job.task, ipcModel);"))
      .toBe(true);
    expect(main.includes("...(workerModel ? { model: workerModel } : {}),"))
      .toBe(true);
    expect(main.includes("const provisional = this.usableAgentModel(`${provider}/${modelName}`);"))
      .toBe(true);
    expect(main.includes("if (provisional) created.model = provisional;"))
      .toBe(true);
    expect(main.includes("if (modelChanged && inst.persist) this.savePlanRoster(inst);"))
      .toBe(true);
    expect(main.includes("if (!this.projectIsSwitching(project.id)) this.saveTerminalRoster(project);"))
      .toBe(true);
  });
});

describe("uncapped durable roster identities", () => {
  it("parses and fits 100 mixed identities without truncating", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: `term-${i + 1}`, type: i % 2 ? "shell" as const : "agent" as const,
      ...(i % 2 ? { shell: "/bin/zsh", cwd: "/project" } : { model: "openai/gpt-5" }),
    }));
    const parsed = parseTerminalRoster(entries);
    expect(parsed).toHaveLength(100);
    expect(fitTerminalRoster(parsed)).toEqual(parsed);
  });

  it("retains failed restores and prefers live entries over duplicates", () => {
    const failed = Array.from({ length: 40 }, (_, i) => ({ id: `term-${i + 1}`, type: "agent" as const, model: "openai/old" }));
    const live = [{ id: "term-20", type: "agent" as const, model: "openai/new" }];
    const composed = composeTerminalRoster(live, [...failed, failed[0]!]);
    expect(composed).toHaveLength(40);
    expect(composed[0]).toEqual(live[0]);
    expect(new Set(composed.map((entry) => entry.id)).size).toBe(40);
  });

  it("bounds only handoff bytes when identities already exceed 64 KiB", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: `term-${i + 1}`, type: "shell" as const, cwd: `/${"x".repeat(900)}`,
      verifyOutput: "x".repeat(6000),
    }));
    const fitted = fitTerminalRoster(entries);
    expect(fitted).toHaveLength(100);
    expect(fitted.every((entry) => entry.verifyOutput === undefined)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ terminals: fitted }))).toBeGreaterThan(MAX_ROSTER_HANDOFF_BYTES);
    expect(fitted.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
  });

  it("refuses identities above the load limit instead of slicing", () => {
    const entries = Array.from({ length: 17000 }, (_, i) => ({ id: `term-${i + 1}`, type: "shell" as const, cwd: `/${"x".repeat(1000)}` }));
    expect(Buffer.byteLength(JSON.stringify({ terminals: entries }))).toBeGreaterThan(MAX_ROSTER_FILE_BYTES);
    expect(() => fitTerminalRoster(entries))
      .toThrow("identities exceed");
  });
});
