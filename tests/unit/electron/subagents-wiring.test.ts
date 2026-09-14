import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for the background-subagent integration seams.
 * The spawn/dispatch/clear/close wiring lives in TerminaApp, which has
 * no unit harness (it needs a live Electron app), so these probes pin
 * the seams textually the way ipc-project-flow does for IPC fences:
 * if a seam is deleted or rerouted, the probe fails and the author must
 * consciously update the contract, not silently drop it.
 */
describe("Subagent Wiring Invariants", () => {
  const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
  const host = readFileSync(new URL("../../../electron/subagents.ts", import.meta.url), "utf8");
  const kernel = readFileSync(new URL("../../../agent-core/subagents.ts", import.meta.url), "utf8");
  const agentMain = readFileSync(new URL("../../../agent-core/main.ts", import.meta.url), "utf8");
  const manager = readFileSync(new URL("../../../electron/worldlines/manager.ts", import.meta.url), "utf8");

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

  it("shutdown terminates owner runs before killing PTYs (refs #211)", () => {
    const disposeAt = main.indexOf("async dispose()");
    const shutdownAt = main.indexOf("private stopPaintWatchdog", disposeAt);
    assert.ok(disposeAt >= 0 && shutdownAt > disposeAt);
    const dispose = main.slice(disposeAt, shutdownAt);
    // Per live terminal id, and strictly before the PTY kill loop: the
    // PTY-exit cascade is best-effort after forced termination, so shutdown
    // cannot rely on it to reap headless children.
    assert.match(dispose, /for \(const id of \[\.\.\.this\.terminals\.keys\(\)\]\) \{\s*this\.subagents\.killOwner\(id, "app shutdown"\);/);
    assert.ok(dispose.indexOf('killOwner(id, "app shutdown")') < dispose.indexOf('inst.pty.killGroup("SIGTERM")'));
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

  it("worldline candidates cannot spawn host children (issue #39)", () => {
    // The candidate launch marks its core; the core hides the tool and fails
    // the call; the host refuses the sidecar spawn without reading the file.
    assert.match(manager, /TERMINA_WORLDLINE_CANDIDATE: "1"/);
    assert.match(kernel, /isWorldlineCandidateEnv/);
    assert.match(agentMain, /spawn_subagent is disabled in worldline candidates/);
    assert.match(agentMain, /IS_WORLDLINE_CANDIDATE && def\.name === "spawn_subagent"/);
    assert.match(host, /isWorldlineTerminal\(sourceTerminalId\)/);
    assert.match(host, /subagents are disabled in worldline candidates/);
    assert.match(main, /isWorldlineTerminal: \(terminalId\)/);
  });

  it("host re-validates handoff identity, cwd, and permission mode (issue #39)", () => {
    assert.match(host, /subagentTaskFileName\(sourceTerminalId, runId\)/);
    assert.match(host, /task\.runId !== runId/);
    assert.match(host, /workspaceRootFor\(sourceTerminalId\)/);
    assert.match(host, /outside parent workspace/);
    assert.match(host, /autoApproveAllowedFor\(run\.parentTerminalId\)/);
    assert.match(main, /workspaceRootFor: \(terminalId\)/);
    assert.match(main, /autoApproveAllowedFor: \(terminalId\)/);
  });
});
