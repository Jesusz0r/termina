import { afterAll, describe, expect, it } from "vitest";
process.env.TERMINA_CORE_TEST = "1";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  MAX_SESSION_BUNDLE_BYTES,
  MAX_SESSION_RECORD_BYTES,
  SessionWriter,
  coreSessionFile,
  replaySessionBundle,
  type SessionWriter as SessionWriterType,
} from "../../../agent-core/session.ts";
import { testOnlyResumeSessionBody, testOnlyResumeState } from "../../../agent-core/main.ts";

const roots: string[] = [];
const writers: SessionWriterType[] = [];
afterAll(() => {
  for (const w of writers) {
    try {
      w.close();
    } catch {
      /* best effort */
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function bundle(id: string): { sessionFile: string; bundleDir: string; currentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "session-admission-"));
  roots.push(root);
  const sessionFile = coreSessionFile(root, id);
  return { sessionFile, bundleDir: dirname(dirname(sessionFile)), currentDir: dirname(sessionFile) };
}

/** Message record whose encoded JSONL line is exactly targetBytes. */
function recordWithEncodedSize(sseq: number, targetBytes: number): Record<string, unknown> {
  const rec: { storageSeq: number; type: string; message: { role: string; content: string } } = {
    storageSeq: sseq,
    type: "message",
    message: { role: "user", content: "" },
  };
  const overhead = Buffer.byteLength(`${JSON.stringify(rec)}\n`);
  rec.message.content = "x".repeat(Math.max(0, targetBytes - overhead));
  let line = Buffer.from(`${JSON.stringify(rec)}\n`);
  while (line.length > targetBytes && rec.message.content.length > 0) {
    rec.message.content = rec.message.content.slice(0, -(line.length - targetBytes));
    line = Buffer.from(`${JSON.stringify(rec)}\n`);
  }
  while (line.length < targetBytes) {
    rec.message.content += "x";
    line = Buffer.from(`${JSON.stringify(rec)}\n`);
  }
  return rec as unknown as Record<string, unknown>;
}

function openWriter(
  sessionFile: string,
  lastStorageSeq: number,
  testOnlyMaxBundleBytes?: number,
): SessionWriterType {
  // Session admission locks are transient under parallel workers; retry
  // like resume-quarantine.test.ts before failing.
  const deadline = Date.now() + 5000;
  for (;;) {
    const opened = SessionWriter.open(
      sessionFile,
      lastStorageSeq,
      testOnlyMaxBundleBytes === undefined ? undefined : { testOnlyMaxBundleBytes },
    );
    if (opened.ok) {
      writers.push(opened.writer);
      return opened.writer;
    }
    if (!/busy|admission lock is unreadable/i.test(opened.error || "") || Date.now() >= deadline) {
      throw new Error(opened.error);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function bundleBytes(currentDir: string): number {
  return readdirSync(currentDir)
    .filter((n) => n.endsWith(".jsonl"))
    .reduce((sum, n) => sum + statSync(join(currentDir, n)).size, 0);
}

describe("session writer aggregate admission (#161)", () => {
  it("accepts the exact byte boundary and rejects the next record", async () => {
    const limit = 32 * 1024;
    const { sessionFile, currentDir } = bundle("admission-boundary");
    const writer = openWriter(sessionFile, 0, limit);
    const first = writer.appendRecord(recordWithEncodedSize(1, limit / 2));
    const second = writer.appendRecord(recordWithEncodedSize(2, limit / 2));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(writer.aggregateSize).toBe(limit);
    expect(bundleBytes(currentDir)).toBe(limit);
    const rejected = writer.appendRecord(recordWithEncodedSize(3, 128));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.error).toMatch(/MAX_SESSION_BUNDLE_BYTES/);
    expect(rejected.error).toMatch(/rejected before mutation/);
    expect(bundleBytes(currentDir)).toBe(limit);
    const replayed = await replaySessionBundle(sessionFile, { testOnlyMaxBundleBytes: limit });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error(replayed.error);
    expect(replayed.maxSeq).toBe(2);
    expect(replayed.messages).toHaveLength(2);
  });

  it("leaves the writer usable after a rejection without advancing the sequence", async () => {
    const limit = 4096;
    const { sessionFile } = bundle("admission-retry");
    const writer = openWriter(sessionFile, 0, limit);
    expect(writer.appendRecord(recordWithEncodedSize(1, 3000)).ok).toBe(true);
    const rejected = writer.appendRecord(recordWithEncodedSize(2, 1500));
    expect(rejected.ok).toBe(false);
    // The rejected sequence was never acknowledged, so seq 2 stays available.
    const retry = writer.appendRecord(recordWithEncodedSize(2, 1000));
    expect(retry.ok).toBe(true);
    expect(writer.aggregateSize).toBe(4000);
    const replayed = await replaySessionBundle(sessionFile, { testOnlyMaxBundleBytes: limit });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error(replayed.error);
    expect(replayed.messages.map((m) => m.sseq)).toEqual([1, 2]);
  });

  it("reopens the accepted prefix with admission intact", async () => {
    const limit = 4096;
    const { sessionFile, currentDir } = bundle("admission-reopen");
    const writer = openWriter(sessionFile, 0, limit);
    expect(writer.appendRecord(recordWithEncodedSize(1, 3000)).ok).toBe(true);
    expect(writer.appendRecord(recordWithEncodedSize(2, 1000)).ok).toBe(true);
    writer.close();
    const reopened = openWriter(sessionFile, 2, limit);
    expect(reopened.aggregateSize).toBe(4000);
    expect(bundleBytes(currentDir)).toBe(4000);
    const rejected = reopened.appendRecord(recordWithEncodedSize(3, 128));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.error).toMatch(/MAX_SESSION_BUNDLE_BYTES/);
    const replayed = await replaySessionBundle(sessionFile, { testOnlyMaxBundleBytes: limit });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error(replayed.error);
    expect(replayed.maxSeq).toBe(2);
  });

  it("accounts sealed parts across rollovers at the production cap", async () => {
    const { sessionFile, currentDir } = bundle("admission-rolls");
    const writer = openWriter(sessionFile, 0);
    let accepted = 0;
    for (let sseq = 1; sseq <= 70; sseq++) {
      const result = writer.appendRecord(
        recordWithEncodedSize(sseq, MAX_SESSION_RECORD_BYTES - 256),
      );
      if (!result.ok) {
        expect(result.error).toMatch(/MAX_SESSION_BUNDLE_BYTES/);
        break;
      }
      accepted = sseq;
    }
    // ~1 MiB records cross 64 MiB only after several 8 MiB segment rolls.
    expect(accepted).toBeGreaterThan(60);
    const parts = readdirSync(currentDir).filter((n) => n.startsWith("part-"));
    expect(parts.length).toBeGreaterThan(1);
    expect(writer.aggregateSize).toBeLessThanOrEqual(MAX_SESSION_BUNDLE_BYTES);
    expect(bundleBytes(currentDir)).toBe(writer.aggregateSize);
    const replayed = await replaySessionBundle(sessionFile);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error(replayed.error);
    expect(replayed.maxSeq).toBe(accepted);
    // Headroom below the cap still admits a small record after a rejection.
    const headroom = MAX_SESSION_BUNDLE_BYTES - writer.aggregateSize;
    expect(headroom).toBeGreaterThan(512);
    const small = writer.appendRecord(recordWithEncodedSize(accepted + 1, 256));
    expect(small.ok).toBe(true);
    const replayedAgain = await replaySessionBundle(sessionFile);
    expect(replayedAgain.ok).toBe(true);
    if (!replayedAgain.ok) throw new Error(replayedAgain.error);
    expect(replayedAgain.maxSeq).toBe(accepted + 1);
  }, 120_000);

  it("resume keeps an over-capacity bundle instead of quarantining it", async () => {
    const { sessionFile, bundleDir, currentDir } = bundle("admission-resume");
    const writer = openWriter(sessionFile, 0);
    expect(writer.appendRecord(recordWithEncodedSize(1, 1024)).ok).toBe(true);
    expect(writer.appendRecord(recordWithEncodedSize(2, 1024)).ok).toBe(true);
    writer.close();
    // The 2 KiB bundle is valid production data but over the 1 KiB test cap,
    // exercising the capacity path without writing 64 MiB of fixture.
    for (let attempt = 0; attempt < 2; attempt++) {
      const resumed = await testOnlyResumeSessionBody({ sessionFile, testOnlyMaxBundleBytes: 1024 });
      expect(resumed.ok).toBe(false);
      if (resumed.ok) throw new Error("expected resume failure");
      expect(resumed.error).toMatch(/MAX_SESSION_BUNDLE_BYTES/);
      expect(readdirSync(bundleDir).filter((n) => n.startsWith("bad-"))).toEqual([]);
      expect(bundleBytes(currentDir)).toBe(2048);
    }
    const state = testOnlyResumeState();
    expect(state).toEqual({ historyLength: 0, storageSeq: 0, streamPrepared: false });
  });
});
