import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AgentTui } from "../../../agent-core/tui.ts";
import { shouldAutoOpenLogin } from "../../../agent-core/main/login-hint.ts";

const base = {
  hasSurface: true,
  historyLength: 0,
  startupPrefilled: false,
  hasStructuredPrompt: false,
  isSubagent: false,
  isPrintMode: false,
  hasAuthenticatedProvider: false,
};

describe("first-run /login auto-open", () => {
  it("opens on a fresh TUI with no provider", () => {
    expect(shouldAutoOpenLogin(base)).toBe(true);
  });

  it("stays shut when a provider is authenticated", () => {
    expect(shouldAutoOpenLogin({ ...base, hasAuthenticatedProvider: true })).toBe(false);
  });

  it("stays shut without a TUI surface", () => {
    expect(shouldAutoOpenLogin({ ...base, hasSurface: false })).toBe(false);
  });

  it("stays shut for resumed sessions", () => {
    expect(shouldAutoOpenLogin({ ...base, historyLength: 2 })).toBe(false);
  });

  it("never clobbers a startup prefill or structured prompt", () => {
    expect(shouldAutoOpenLogin({ ...base, startupPrefilled: true })).toBe(false);
    expect(shouldAutoOpenLogin({ ...base, hasStructuredPrompt: true })).toBe(false);
  });

  it("stays shut for headless subagent and print runs", () => {
    expect(shouldAutoOpenLogin({ ...base, isSubagent: true })).toBe(false);
    expect(shouldAutoOpenLogin({ ...base, isPrintMode: true })).toBe(false);
  });

  it("setDraft('/login') renders the provider picker", () => {
    const tui = new AgentTui({
      stdout: { write: () => true, columns: 80, rows: 24, isTTY: false },
      stdin: { isTTY: false },
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    });
    tui.setDraft("/login");
    const frame = tui.frame();
    expect(frame).toContain("OpenAI (key)");
    expect(frame).toContain("Anthropic");
    expect(frame).not.toContain("/login openai oauth");
  });

  it("wires the gate into the engine startup path", () => {
    const main = readFileSync(new URL("../../../agent-core/main.ts", import.meta.url), "utf8");
    expect(main).toContain("shouldAutoOpenLogin");
    expect(main).toContain('surface?.setDraft("/login")');
    expect(main).toContain("firstAuthenticatedProvider()");
    expect(main).toContain("startupPrefilled");
  });
});
