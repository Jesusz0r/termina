import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for the background-subagent integration seams.
 * The spawn/dispatch/clear/close wiring lives in PiEditorApp, which has
 * no unit harness (it needs a live Electron app), so these probes pin
 * the seams textually the way ipc-project-flow does for IPC fences:
 * if a seam is deleted or rerouted, the probe fails and the author must
 * consciously update the contract, not silently drop it.
 */
describe("Subagent Wiring Invariants", () => {
  const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
  const host = readFileSync(new URL("../../../electron/subagents.ts", import.meta.url), "utf8");
  const kernel = readFileSync(new URL("../../../agent-core/subagents.ts", import.meta.url), "utf8");

  it("spawns delegate to the single host owner", () => {
    assert.match(main, /this\.subagents\.handleSpawn\(terminalId, runId, taskFile\)/);
    assert.equal((main.match(/new SubagentHost/g) ?? []).length, 1);
  });

  it("dispatch and subagents share one claim surface", () => {
    assert.match(main, /this\.subagents\.claimsForOwner\(ownerId\)/);
    assert.match(host, /dispatchKeysFor/);
  });

  it("child streams route to the host, never to a terminal", () => {
    assert.match(main, /this\.subagents\.hasStream\(terminalId\)/);
    assert.match(main, /this\.subagents\.noteChildEvent\(terminalId, event\.t/);
  });

  it("clear and close terminate owner runs", () => {
    assert.match(main, /this\.subagents\.killOwner\(terminalId, "terminal cleared"\)/);
    assert.match(main, /this\.subagents\.killOwner\(inst\.id, "terminal closed"\)/);
  });

  it("startup sweep covers subagent-managed files", () => {
    assert.match(main, /isSubagentManagedFile\(name\)/);
  });

  it("children never get a pty", () => {
    // No pty import is possible to use without (the word survives only in
    // the header comment stating the prohibition); detached group-kill is
    // the process-management primitive instead.
    assert.doesNotMatch(host, /^import .*pty/m);
    assert.match(host, /detached/);
  });

  it("depth stays 1 with no child-to-child channels", () => {
    assert.match(kernel, /MAX_SUBAGENT_DEPTH = 1/);
    assert.match(kernel, /visibleSubagentTools/);
  });
});
