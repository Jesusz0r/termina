import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installResumedSubagentHistory } from "../../../agent-core/main.ts";
import { SessionWriter, replaySessionBundle } from "../../../agent-core/session.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function seedBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagent-resume-"));
  roots.push(dir);
  const sessionFile = join(dir, "core-test", "current", "session.jsonl");
  const opened = SessionWriter.open(sessionFile, 0);
  if (!opened.ok) throw new Error(`seed open failed: ${opened.error}`);
  const writer = opened.writer;
  try {
    for (const [sseq, message] of [
      [1, { role: "user", content: "do the thing" }],
      [2, { role: "assistant", content: [{ type: "text", text: "on it" }] }],
    ] as const) {
      const appended = writer.appendRecord({ storageSeq: sseq, type: "message", message });
      if (!appended.ok) throw new Error(`seed append failed: ${appended.error}`);
    }
  } finally {
    writer.close();
  }
  return sessionFile;
}

describe("resumed subagent history", () => {
  it("installs a replayed prior bundle without throwing", async () => {
    const replayed = await replaySessionBundle(seedBundle());
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.messages.length).toBe(2);
    expect(replayed.maxSeq).toBe(2);
    expect(() => installResumedSubagentHistory(replayed)).not.toThrow();
    // Idempotent: a second install over the same bundle is a clean replace.
    expect(() => installResumedSubagentHistory(replayed)).not.toThrow();
  });

  it("installs an empty replay as a clean slate", () => {
    expect(() => installResumedSubagentHistory({ messages: [], maxSeq: 0 })).not.toThrow();
  });
});
