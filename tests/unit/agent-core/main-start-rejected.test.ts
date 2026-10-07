import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { sidecarEventFromRecord } from "../../../electron/sidecar.ts";

// Execute the real early-abort producer without importing the interactive entrypoint.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../agent-core/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.ES2022, true);
const abort = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "abortPromptStart");
if (!abort) throw new Error("missing prompt startup abort");
const body = ts.transpileModule(`
  let lastRunOutcome = null, running = true, currentAbort = {};
  ${abort.getText(source)}
  abortPromptStart(message, draft);
  return { lastRunOutcome, running, currentAbort };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

describe("prompt startup rejection", () => {
  it.each([undefined, "retain my prompt"])("publishes the failure before returning to the prompt (draft=%s)", (draft) => {
    const records: Record<string, unknown>[] = [];
    const surface = { setDraft: vi.fn() };
    const out = vi.fn();
    const flushMcpTools = vi.fn();
    const showPrompt = vi.fn();
    const result = new Function("sidecar", "surface", "out", "flushMcpTools", "showPrompt", "message", "draft", body)(
      { logEvent: (event: Record<string, unknown>) => records.push(event) }, surface, out, flushMcpTools, showPrompt, "startup unavailable", draft,
    );
    expect(records).toEqual([{ t: "agent_start_rejected", error: "startup unavailable" }]);
    expect(result).toEqual({ lastRunOutcome: { status: "failure", failure: "startup unavailable" }, running: false, currentAbort: null });
    expect(showPrompt).toHaveBeenCalledOnce();
    expect(flushMcpTools).toHaveBeenCalledOnce();
    if (draft === undefined) expect(surface.setDraft).not.toHaveBeenCalled();
    else expect(surface.setDraft).toHaveBeenCalledWith(draft);
    expect(sidecarEventFromRecord({ ...records[0], bridgeId: "owned-bridge", seq: 1 })).toEqual({
      bridgeId: "owned-bridge", seq: 1, t: "agent_start_rejected", error: "startup unavailable",
    });
  });
});
