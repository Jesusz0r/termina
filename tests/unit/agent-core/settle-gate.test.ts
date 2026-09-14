import { describe, expect, it } from "vitest";

import {
  checksSectionState,
  checkKindsForCommand,
  claimedCheckKinds,
  gateEditCount,
  isCheckCommand,
  ranChecks,
  recordGateObservation,
  settleGateVerdict,
  type GateToolObservation,
} from "../../../agent-core/main/settle-gate.ts";
import type { ToolOutcome, ToolUse } from "../../../agent-core/main/tools.ts";

function use(name: string, input: ToolUse["input"]): ToolUse {
  return { id: `call-${name}`, name, input };
}

function outcome(partial: Partial<ToolOutcome> & { result?: Record<string, unknown> } = {}): ToolOutcome {
  return {
    result: partial.result ?? { type: "tool_result", tool_use_id: "call-x", content: "ok" },
    isError: partial.isError ?? false,
    ...("executed" in partial ? { executed: partial.executed } : {}),
    ...("exitCode" in partial ? { exitCode: partial.exitCode } : {}),
  };
}

function observe(name: string, input: ToolUse["input"], result: ToolOutcome): GateToolObservation {
  const observations: GateToolObservation[] = [];
  recordGateObservation(observations, use(name, input), result);
  return observations[0]!;
}

describe("settle gate observations", () => {
  it("records edits, checks, and execution state", () => {
    expect(observe("edit", { path: "a.ts" }, outcome())).toMatchObject({
      name: "edit",
      path: "a.ts",
      executed: true,
      ok: true,
    });
    expect(observe("bash", { command: "pnpm test" }, outcome({ exitCode: 0 }))).toMatchObject({
      name: "bash",
      command: "pnpm test",
      executed: true,
      ok: true,
      exitCode: 0,
    });
    expect(observe("bash", { command: "pnpm test" }, outcome({ isError: true, exitCode: 1 }))).toMatchObject({
      executed: true,
      ok: false,
      exitCode: 1,
    });
    expect(observe("bash", { command: "pnpm test" }, outcome({ isError: true, executed: false }))).toMatchObject({
      executed: false,
      ok: false,
    });
  });

  it("counts only successful executed file mutations as edits", () => {
    const observations: GateToolObservation[] = [
      { name: "edit", path: "a.ts", executed: true, ok: true },
      { name: "write_file", path: "b.ts", executed: true, ok: true },
      { name: "edit", path: "c.ts", executed: true, ok: false },
      { name: "edit", path: "d.ts", executed: false, ok: false },
      { name: "bash", command: "ls", executed: true, ok: true, exitCode: 0 },
    ];
    expect(gateEditCount(observations)).toBe(2);
  });
});

describe("check command matching", () => {
  const checks = [
    "pnpm test",
    "pnpm run test:e2e",
    "npm run typecheck",
    "yarn build",
    "bun run lint",
    "tsc --noEmit",
    "npx vitest run",
    "pytest -x",
    "cargo test --all",
    "cargo clippy",
    "go test ./...",
    "go vet ./...",
    "make test",
    "make check",
    "pnpm run verify",
    "eslint src/",
  ];
  for (const command of checks) {
    it(`recognizes ${command}`, () => {
      expect(isCheckCommand(command)).toBe(true);
    });
  }

  const notChecks = ["ls -la", "pnpm run dev", "npm start", "echo hello", "git status", "cat file.txt", "node script.js"];
  for (const command of notChecks) {
    it(`ignores ${command}`, () => {
      expect(isCheckCommand(command)).toBe(false);
    });
  }

  it("classifies check kinds", () => {
    expect(checkKindsForCommand("pnpm test")).toEqual(["test"]);
    expect(checkKindsForCommand("tsc --noEmit")).toEqual(["typecheck"]);
    expect(checkKindsForCommand("tsc -p .")).toEqual(expect.arrayContaining(["typecheck", "build"]));
    expect(checkKindsForCommand("cargo build")).toEqual(["build"]);
    expect(checkKindsForCommand("eslint src/")).toEqual(["lint"]);
    expect(checkKindsForCommand("pnpm run verify")).toEqual([]);
  });

  it("collects only executed check invocations", () => {
    const observations: GateToolObservation[] = [
      { name: "bash", command: "pnpm test", executed: true, ok: true, exitCode: 0 },
      { name: "bash", command: "pnpm run typecheck", executed: true, ok: false, exitCode: 2 },
      { name: "bash", command: "pnpm build", executed: false, ok: false, exitCode: null },
      { name: "bash", command: "ls", executed: true, ok: true, exitCode: 0 },
    ];
    expect(ranChecks(observations)).toEqual([
      { command: "pnpm test", passed: true },
      { command: "pnpm run typecheck", passed: false },
    ]);
  });
});

describe("claim and section parsing", () => {
  it("detects explicit passing claims per kind", () => {
    expect(claimedCheckKinds("All tests pass.").kinds).toEqual(["test"]);
    expect(claimedCheckKinds("Typecheck is clean.").kinds).toEqual(["typecheck"]);
    expect(claimedCheckKinds("Build succeeded.").kinds).toEqual(["build"]);
    expect(claimedCheckKinds("Everything passes.").generic).not.toBeNull();
    expect(claimedCheckKinds("No tests failed.").generic).not.toBeNull();
  });

  it("ignores negated claims", () => {
    expect(claimedCheckKinds("Tests did not pass yet.").kinds).toEqual([]);
    expect(claimedCheckKinds("Tests did not pass yet.").generic).toBeNull();
    expect(claimedCheckKinds("The build failed.").kinds).toEqual([]);
    expect(claimedCheckKinds("Clean up the tests tomorrow.").snippet).toBeNull();
    expect(claimedCheckKinds("No tests passed yet.").kinds).toEqual([]);
    expect(claimedCheckKinds("Done. See above.").snippet).toBeNull();
  });

  it("parses the checks section state", () => {
    expect(checksSectionState("## What changed\n- x\n")).toBe("absent");
    expect(checksSectionState("## Checks\n\n## Remaining\n- y\n")).toBe("empty");
    expect(checksSectionState("## Checks\n- pnpm test (pass)\n")).toBe("present");
    expect(checksSectionState("## Checks\nn/a\n")).toBe("empty");
  });
});

describe("settleGateVerdict", () => {
  const edit: GateToolObservation = { name: "edit", path: "a.ts", executed: true, ok: true };
  const passingCheck: GateToolObservation = {
    name: "bash",
    command: "pnpm test",
    executed: true,
    ok: true,
    exitCode: 0,
  };

  it("passes clean runs (edits + observed passing checks)", () => {
    const verdict = settleGateVerdict(
      { observations: [edit, passingCheck], finalText: "## Checks\n- pnpm test (pass)\n" },
      false,
    );
    expect(verdict.decision).toBe("pass");
  });

  it("bypasses read-only runs", () => {
    const verdict = settleGateVerdict(
      {
        observations: [
          { name: "read_file", path: "a.ts", executed: true, ok: true },
          { name: "bash", command: "ls", executed: true, ok: true, exitCode: 0 },
        ],
        finalText: "No changes needed.",
      },
      false,
    );
    expect(verdict.decision).toBe("pass");
  });

  it("nudges once, then fails, when no checks were observed", () => {
    const input = { observations: [edit], finalText: "Done." };
    const first = settleGateVerdict(input, false);
    expect(first.decision).toBe("nudge");
    if (first.decision !== "nudge") throw new Error("expected nudge");
    expect(first.reason).toBe("no-checks");
    expect(first.nudge).toContain("Settle gate");
    const second = settleGateVerdict(input, true);
    expect(second.decision).toBe("fail");
    if (second.decision !== "fail") throw new Error("expected fail");
    expect(second.reason).toBe("no-checks");
  });

  it("confronts claimed-but-unobserved verification", () => {
    const input = { observations: [edit], finalText: "All tests pass." };
    const first = settleGateVerdict(input, false);
    expect(first.decision).toBe("nudge");
    if (first.decision !== "nudge") throw new Error("expected nudge");
    expect(first.reason).toBe("false-claim");
    expect(settleGateVerdict(input, true).decision).toBe("fail");
  });

  it("rejects kind-mismatched claims (typecheck ran, tests claimed)", () => {
    const verdict = settleGateVerdict(
      {
        observations: [
          edit,
          { name: "bash", command: "pnpm run typecheck", executed: true, ok: true, exitCode: 0 },
        ],
        finalText: "All tests pass.",
      },
      false,
    );
    expect(verdict.decision).toBe("nudge");
    if (verdict.decision !== "nudge") throw new Error("expected nudge");
    expect(verdict.reason).toBe("false-claim");
  });

  it("trips when every observed check failed", () => {
    const verdict = settleGateVerdict(
      {
        observations: [edit, { name: "bash", command: "pnpm test", executed: true, ok: false, exitCode: 1 }],
        finalText: "Done.",
      },
      false,
    );
    expect(verdict.decision).toBe("nudge");
    if (verdict.decision !== "nudge") throw new Error("expected nudge");
    expect(verdict.reason).toBe("failing-checks");
  });

  it("does not count denied or failed mutations as edits", () => {
    const verdict = settleGateVerdict(
      {
        observations: [
          { name: "edit", path: "a.ts", executed: false, ok: false },
          { name: "write_file", path: "b.ts", executed: true, ok: false },
        ],
        finalText: "Done.",
      },
      false,
    );
    expect(verdict.decision).toBe("pass");
  });
});
