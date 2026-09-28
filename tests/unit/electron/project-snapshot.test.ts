import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatProjectSnapshot, MAX_PROJECT_SNAPSHOT_BYTES } from "../../../electron/main/project-snapshot.ts";

/**
 * Source-level probes for the per-turn project snapshot: main writes a
 * bounded tree inventory per agent terminal at creation and refreshes it on
 * debounced watcher bursts. The host reads it before diagnostics in the
 * bounded context channel. Formatting is tested behaviorally below; the
 * Electron project-context suite covers publication and refresh.
 */
describe("Project Snapshot Invariants", () => {
  it("wires snapshot write, debounced refresh, and bounded context reads", () => {
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
    const snapshotFn = main.slice(
      main.indexOf("private async writeProjectSnapshot"),
      main.indexOf("private scheduleProjectSnapshot"),
    );
    check("snapshot uses the bounded formatter and skips unchanged writes",
      snapshotFn.includes("formatProjectSnapshot(root, snapshot)")
      && snapshotFn.includes("maxBytes: MAX_PROJECT_SNAPSHOT_BYTES")
      && snapshotFn.includes("skipIfUnchanged: true"));
    check("empty snapshots remove the previous context",
      snapshotFn.includes("if (!content)")
      && snapshotFn.includes("await this.removeEventLeaf(inst, `project-${inst.id}.md`);"));
    // Snapshot stays ahead of diagnostics in the shared bounded channel.
    check("host reads the snapshot before diagnostics",
      host.includes('const CONTEXT_FILES = ["verify", "edits", "mailbox", "project", "diagnostics"] as const;'));
    assert.ok(checks.length >= 5);
  });
});

describe("project snapshot formatting", () => {
  const root = "/projects/example";

  it("keeps the hint and complete paths without adding a clock", () => {
    const snapshot = { entries: ["README.md", "src/", "src/index.ts"], truncated: false };
    const content = formatProjectSnapshot(root, snapshot)!;
    expect(content.toString()).toBe(
      "## Project snapshot — `example`\n\n" +
      "Top-level tree first; `…(truncated)` means the listing hit a bound.\n" +
      "A hint only — file tools see live state.\n\n" +
      "```text\nREADME.md\nsrc/\nsrc/index.ts\n```\n",
    );
    expect(formatProjectSnapshot(root, snapshot)).toEqual(content);
    expect(formatProjectSnapshot(root, { ...snapshot, entries: [...snapshot.entries, "added.ts"] })).not.toEqual(content);
  });

  it.each([false, true])("returns no context for an empty listing (truncated: %s)", (truncated) => {
    expect(formatProjectSnapshot(root, { entries: [], truncated })).toBeNull();
  });

  it("preserves a walker's truncation marker even when the text fits", () => {
    expect(formatProjectSnapshot(root, { entries: ["a.txt"], truncated: true })!.toString()).toContain("a.txt\n…(truncated)\n```\n");
  });

  it("accepts a snapshot at exactly the byte limit without truncation", () => {
    const overhead = formatProjectSnapshot(root, { entries: ["x"], truncated: false })!.byteLength - 1;
    const content = formatProjectSnapshot(root, { entries: ["x".repeat(MAX_PROJECT_SNAPSHOT_BYTES - overhead)], truncated: false })!;
    expect(content.byteLength).toBe(MAX_PROJECT_SNAPSHOT_BYTES);
    expect(content.toString()).not.toContain("\n…(truncated)\n");
  });

  it.each(["x", "界", "🧪"])("retains the largest complete prefix of long paths: %s", (character) => {
    const entries = ["top.txt", ...Array.from({ length: 25 }, (_, index) => `${character.repeat(650)}/file-${index}.txt`)];
    const content = formatProjectSnapshot(root, { entries, truncated: false })!;
    const text = content.toString();
    const retained = text.split("```text\n")[1]!.split("\n…(truncated)\n")[0]!.split("\n");
    expect(retained.length).toBeGreaterThan(1);
    expect(retained).toEqual(entries.slice(0, retained.length));
    expect(content.byteLength).toBeLessThanOrEqual(MAX_PROJECT_SNAPSHOT_BYTES);
    expect(content.byteLength + Buffer.byteLength(entries[retained.length]! + "\n")).toBeGreaterThan(MAX_PROJECT_SNAPSHOT_BYTES);
    expect(text.endsWith("…(truncated)\n```\n")).toBe(true);
    expect(text).not.toContain("\uFFFD");
  });

  it("returns no context when even the first path cannot fit", () => {
    expect(formatProjectSnapshot(root, { entries: ["x".repeat(MAX_PROJECT_SNAPSHOT_BYTES)], truncated: false })).toBeNull();
  });
});
