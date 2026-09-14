import { afterAll, describe, expect, it } from "vitest";
process.env.TERMINA_CORE_TEST = "1";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
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
  const root = mkdtempSync(join(tmpdir(), "session-crash-tail-"));
  roots.push(root);
  const sessionFile = coreSessionFile(root, id);
  return { sessionFile, bundleDir: join(root, id), currentDir: dirname(sessionFile) };
}

function openWriter(sessionFile: string, lastStorageSeq: number): SessionWriterType {
  // Session admission locks are transient under parallel workers; retry
  // like resume-quarantine.test.ts before failing.
  const deadline = Date.now() + 5000;
  for (;;) {
    const opened = SessionWriter.open(sessionFile, lastStorageSeq);
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

function seedDurable(sessionFile: string): void {
  const writer = openWriter(sessionFile, 0);
  try {
    const appended = writer.appendRecord({
      storageSeq: 1,
      type: "message",
      message: { role: "user", content: "previously durable" },
    });
    if (!appended.ok) throw new Error(appended.error);
  } finally {
    writer.close();
  }
}

/** Crash image: valid record 1 plus an unterminated record-2 prefix. */
function crashImage(sessionFile: string, tail: Buffer): void {
  seedDurable(sessionFile);
  const prefix = Buffer.from(`{"storageSeq":2,"type":"message","message":{"role":"user","content":"crash-`, "utf8");
  appendFileSync(sessionFile, Buffer.concat([prefix, tail]));
}

describe("crash-truncated session tails (#163)", () => {
  it.each([
    ["two-byte tail split after 1 byte", Buffer.from([0xc3])],
    ["three-byte tail split after 1 byte", Buffer.from([0xe2])],
    ["three-byte tail split after 2 bytes", Buffer.from([0xe2, 0x82])],
    ["four-byte tail split after 1 byte", Buffer.from([0xf0])],
    ["four-byte tail split after 2 bytes", Buffer.from([0xf0, 0x9f])],
    ["four-byte tail split after 3 bytes", Buffer.from([0xf0, 0x9f, 0x98])],
  ])("replays the acknowledged prefix past a %s", async (_label, tail) => {
    const { sessionFile } = bundle(`tail-${tail.length}-${tail[0]}`);
    crashImage(sessionFile, tail);
    const replayed = await replaySessionBundle(sessionFile);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error(replayed.error);
    expect(replayed.maxSeq).toBe(1);
    expect(replayed.messages).toHaveLength(1);
    expect(replayed.messages[0]).toMatchObject({ role: "user", sseq: 1, content: "previously durable" });
  });

  it("still rejects the same incomplete bytes in a numbered immutable part", async () => {
    const { sessionFile, currentDir } = bundle("tail-part");
    seedDurable(sessionFile);
    const partBytes = Buffer.concat([
      Buffer.from(`{"storageSeq":2,"type":"message","message":{"role":"user","content":"part-`, "utf8"),
      Buffer.from([0xc3]),
    ]);
    writeFileSync(join(currentDir, "part-000001.jsonl"), partBytes, { mode: 0o600 });
    const replayed = await replaySessionBundle(sessionFile);
    expect(replayed.ok).toBe(false);
    if (replayed.ok) throw new Error("expected rejection");
    expect(replayed.error).toMatch(/invalid UTF-8 session record/);
  });

  it("still rejects well-formed unterminated bytes in a numbered immutable part", async () => {
    const { sessionFile, currentDir } = bundle("tail-part-clean");
    seedDurable(sessionFile);
    writeFileSync(
      join(currentDir, "part-000001.jsonl"),
      `{"storageSeq":2,"type":"message","message":{"role":"user","content":"part-clean`,
      { mode: 0o600 },
    );
    const replayed = await replaySessionBundle(sessionFile);
    expect(replayed.ok).toBe(false);
    if (replayed.ok) throw new Error("expected rejection");
    expect(replayed.error).toMatch(/truncated session record/);
  });

  it("still rejects a newline-terminated malformed UTF-8 record", async () => {
    const { sessionFile } = bundle("tail-malformed");
    seedDurable(sessionFile);
    appendFileSync(sessionFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(" not utf-8\n", "utf8")]));
    const replayed = await replaySessionBundle(sessionFile);
    expect(replayed.ok).toBe(false);
    if (replayed.ok) throw new Error("expected rejection");
    expect(replayed.error).toMatch(/invalid UTF-8 session record/);
  });

  it("writer repair still truncates the tail and replays clean", async () => {
    const { sessionFile } = bundle("tail-repair");
    crashImage(sessionFile, Buffer.from([0xc3]));
    const writer = openWriter(sessionFile, 1);
    writer.close();
    expect(readFileSync(sessionFile, "utf8").endsWith("\n")).toBe(true);
    const replayed = await replaySessionBundle(sessionFile);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error(replayed.error);
    expect(replayed.maxSeq).toBe(1);
  });

  it("resume restores the acknowledged prefix without quarantining it", async () => {
    const { sessionFile, bundleDir, currentDir } = bundle("tail-resume");
    crashImage(sessionFile, Buffer.from([0xc3]));
    const resumed = await testOnlyResumeSessionBody({
      sessionFile,
      openWriter: () => {
        openWriter(sessionFile, 1);
      },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error(resumed.error);
    expect(readdirSync(bundleDir).filter((n) => n.startsWith("bad-"))).toEqual([]);
    expect(existsSync(currentDir)).toBe(true);
    const state = testOnlyResumeState();
    expect(state.historyLength).toBe(1);
    expect(state.storageSeq).toBe(1);
    expect(state.streamPrepared).toBe(true);
  });
});
