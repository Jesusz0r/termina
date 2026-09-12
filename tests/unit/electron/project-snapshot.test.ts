import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for the per-turn project snapshot: main writes a
 * bounded tree inventory per agent terminal at creation and refreshes it on
 * debounced watcher bursts, and the agent host reads it last (lowest
 * priority) in the bounded context channel. The Electron suite covers the
 * visible terminal flow; this probe covers the wiring without a display.
 */
describe("Project Snapshot Invariants", () => {
  it("wires snapshot write, debounced refresh, and lowest-priority read", async () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const host = readFileSync(new URL("../../../agent-core/host/context.ts", import.meta.url), "utf8");
    const checks: string[] = [];
    function check(name: string, value: unknown) {
      assert.equal(Boolean(value), true, name);
      checks.push(name);
    }

    // Written at agent creation; refreshes follow watcher bursts only.
    check("agent creation writes a snapshot",
      main.includes("if (type === \"agent\") void this.writeProjectSnapshot(inst);"));
    check("watcher bursts schedule one debounced refresh",
      main.includes("this.scheduleProjectSnapshot(ws.id);")
      && main.includes("PROJECT_SNAPSHOT_DEBOUNCE_MS"));
    // Bounded output with a staleness warning, skipped without a binding.
    check("snapshot is bounded and stamped as a hint",
      main.includes("MAX_PROJECT_SNAPSHOT_BYTES")
      && main.includes("A hint only — file tools see live state."));
    // Oversize trees shrink to fit instead of skipping the write; an empty
    // tree removes the stale file.
    check("oversize snapshots shrink, empty trees clear",
      main.includes("Shrink from the deepest levels until the file fits its byte bound")
      && main.includes("await this.removeEventLeaf(inst, `project-${inst.id}.md`);"));
    // Snapshot stays ahead of diagnostics in the shared bounded channel.
    check("host reads the snapshot before diagnostics",
      host.includes('const CONTEXT_FILES = ["verify", "edits", "mailbox", "project", "diagnostics"] as const;'));
    assert.ok(checks.length >= 5);
  });
});
