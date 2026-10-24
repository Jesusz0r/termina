import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { observeHookWire } from "../../../electron/external-cli/activity.ts";
import { externalCliResumeArgs, hookSessionId } from "../../../electron/external-cli/session.ts";
import { parseTerminalRoster } from "../../../electron/terminal-roster.ts";

describe("external CLI conversation resume", () => {
  it("reads each verified CLI's own hook field", () => {
    expect(hookSessionId("claude", { hook_event_name: "SessionStart", session_id: "8f2c-41" })).toBe("8f2c-41");
    expect(hookSessionId("codex", { hook_event_name: "SessionStart", session_id: "0199a-b2" })).toBe("0199a-b2");
    expect(hookSessionId("grok", { hookEventName: "SessionStart", sessionId: "g-7" })).toBe("g-7");
    expect(hookSessionId("grok", { session_id: "wrong-field" })).toBeNull();
  });

  it("keeps the conversation id through hook wire normalization, whole or split", () => {
    const body = JSON.stringify({ hook_event_name: "SessionStart", session_id: "0199a-b2", source: "startup" });
    expect(hookSessionId("codex", observeHookWire({ payload: body }))).toBe("0199a-b2");
    const grok = JSON.stringify({ hookEventName: "PreToolUse", sessionId: "g-7", toolName: "bash", toolInput: { x: "y".repeat(10) } });
    expect(hookSessionId("grok", observeHookWire({ head: grok.slice(0, 60), tail: grok.slice(-20) }))).toBe("g-7");
  });

  it("does not guess for CLIs without a verified resume path", () => {
    expect(hookSessionId("gemini", { session_id: "x1", conversationId: "x1" })).toBeNull();
    expect(hookSessionId("muse", { session_id: "x1" })).toBeNull();
    expect(externalCliResumeArgs("gemini", "x1")).toEqual([]);
  });

  it("builds each CLI's resume args", () => {
    expect(externalCliResumeArgs("claude", "abc")).toEqual(["--resume", "abc"]);
    expect(externalCliResumeArgs("codex", "abc")).toEqual(["resume", "abc"]);
    expect(externalCliResumeArgs("grok", "abc")).toEqual(["--resume", "abc"]);
    expect(externalCliResumeArgs("codex", undefined)).toEqual([]);
  });

  it("never turns a saved id into a flag or a second argument", () => {
    expect(hookSessionId("claude", { session_id: "--dangerously-skip-permissions" })).toBeNull();
    expect(hookSessionId("claude", { session_id: "abc def" })).toBeNull();
    expect(externalCliResumeArgs("codex", "-c")).toEqual([]);
    expect(parseTerminalRoster({ terminals: [
      { id: "term-1", type: "shell", cli: "codex", cliSession: "0199a-b2" },
      { id: "term-2", type: "shell", cli: "claude", cliSession: "--yolo" },
    ] })).toEqual([
      { id: "term-1", type: "shell", cli: "codex", cliSession: "0199a-b2" },
      { id: "term-2", type: "shell", cli: "claude" },
    ]);
  });
});

const mainSource = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
const ingestMethod = mainSource.match(/  private ingestExternalHook\([\s\S]*?\n  \}/)?.[0];
if (!ingestMethod) throw new Error("missing ingestExternalHook");
const ingest = new Function("observeHookWire", "hookActivitySignals", "hookSessionId", ts.transpileModule(
  `return ({ ${ingestMethod.replace(/^  private /, "")} }).ingestExternalHook;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText)(observeHookWire, () => [], hookSessionId);

describe("recording a CLI tab's conversation", () => {
  function host() {
    const inst = { id: "term-2", generation: 1, externalCli: "claude", observesExternalHooks: true, closed: false,
      pty: { hasExited: false }, persist: true, externalSessionId: "claude-tab-1", externalActivitySeq: 0 };
    const project = { id: "p1" };
    return { inst, project, app: { runtime: { get: () => inst }, foldActivity: vi.fn(), projectOfTerminal: () => project,
      projectIsSwitching: () => false, saveTerminalRoster: vi.fn() } };
  }
  const wire = (cli: string, id: string) => ({ terminalId: "term-2", generation: 1, token: "t", cli,
    payload: JSON.stringify({ hook_event_name: "SessionStart", session_id: id }) });

  it("records the tab's own CLI conversation", () => {
    const h = host();
    ingest.call(h.app, wire("claude", "claude-tab-2"));
    expect(h.inst.externalSessionId).toBe("claude-tab-2");
    expect(h.app.saveTerminalRoster).toHaveBeenCalledWith(h.project);
  });

  it("ignores another CLI run as a tool inside the tab", () => {
    const h = host();
    ingest.call(h.app, wire("codex", "codex-child-1"));
    expect(h.inst.externalSessionId).toBe("claude-tab-1");
    expect(h.app.saveTerminalRoster).not.toHaveBeenCalled();
  });
});
