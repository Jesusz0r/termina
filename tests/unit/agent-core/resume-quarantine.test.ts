import { describe, it, expect, afterAll } from "vitest";
process.env.TERMINA_CORE_TEST = "1";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SessionWriter,
  coreSessionFile,
  sessionBundleExists,
  sessionBundleHasContent,
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

function trackWriter(w: SessionWriterType): void {
  writers.push(w);
}

function listBadDirs(bundleDir: string): string[] {
  if (!existsSync(bundleDir)) return [];
  return readdirSync(bundleDir).filter((n) => n.startsWith("bad-"));
}

function openWriterWithRetry(sessionFile: string, lastStorageSeq: number): SessionWriterType {
  // Session admission locks are transient under parallel workers; retry
  // like session-segmented.test.ts before failing.
  const deadline = Date.now() + 2000;
  for (;;) {
    const opened = SessionWriter.open(sessionFile, lastStorageSeq);
    if (opened.ok) return opened.writer;
    if (!/busy|admission lock is unreadable/i.test(opened.error || "") || Date.now() >= deadline) {
      throw new Error(opened.error);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function seedValidBundle(id: string): { sessionFile: string; bundleDir: string; currentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "resume-quarantine-"));
  roots.push(root);
  const sessionFile = coreSessionFile(root, id);
  const writer = openWriterWithRetry(sessionFile, 0);
  try {
    for (const [sseq, message] of [
      [1, { role: "user", content: "hello" }],
      [2, { role: "assistant", content: [{ type: "text", text: "hi" }] }],
    ] as const) {
      const appended = writer.appendRecord({ storageSeq: sseq, type: "message", message });
      if (!appended.ok) throw new Error(`seed append failed: ${appended.error}`);
    }
  } finally {
    writer.close();
  }
  return { sessionFile, bundleDir: join(root, id), currentDir: dirname(sessionFile) };
}

describe("resume quarantine scope", () => {
  it("writer failure keeps the bundle and retry succeeds", async () => {
    const { sessionFile, bundleDir, currentDir } = seedValidBundle("keep-1");

    const first = await testOnlyResumeSessionBody({
      sessionFile,
      openWriter: () => {
        throw new Error("injected writer failure");
      },
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toContain("injected writer failure");
    expect(sessionBundleExists(sessionFile)).toBe(true);
    expect(sessionBundleHasContent(sessionFile)).toBe(true);
    expect(existsSync(currentDir)).toBe(true);
    expect(listBadDirs(bundleDir)).toEqual([]);
    const afterFailure = testOnlyResumeState();
    expect(afterFailure.historyLength).toBe(0);
    expect(afterFailure.storageSeq).toBe(0);
    expect(afterFailure.streamPrepared).toBe(false);

    const retry = await testOnlyResumeSessionBody({
      sessionFile,
      openWriter: () => {
        trackWriter(openWriterWithRetry(sessionFile, 2));
      },
    });
    expect(retry.ok).toBe(true);
    expect(sessionBundleExists(sessionFile)).toBe(true);
    expect(sessionBundleHasContent(sessionFile)).toBe(true);
    expect(existsSync(currentDir)).toBe(true);
    expect(listBadDirs(bundleDir)).toEqual([]);
    const afterRetry = testOnlyResumeState();
    expect(afterRetry.historyLength).toBe(2);
    expect(afterRetry.storageSeq).toBe(2);
    expect(afterRetry.streamPrepared).toBe(true);
  });

  it("parse failure still quarantines", async () => {
    const root = mkdtempSync(join(tmpdir(), "resume-quarantine-"));
    roots.push(root);
    const sessionFile = coreSessionFile(root, "bad-1");
    const bundleDir = join(root, "bad-1");
    const currentDir = dirname(sessionFile);
    mkdirSync(currentDir, { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile, "not-json\n", { mode: 0o600 });

    const result = await testOnlyResumeSessionBody({
      sessionFile,
      openWriter: () => {
        trackWriter(openWriterWithRetry(sessionFile, 0));
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("malformed");
    expect(existsSync(currentDir)).toBe(false);
    expect(listBadDirs(bundleDir).length).toBe(1);
    const afterQuarantine = testOnlyResumeState();
    expect(afterQuarantine.historyLength).toBe(0);
    expect(afterQuarantine.storageSeq).toBe(0);
    expect(afterQuarantine.streamPrepared).toBe(false);
  });
});
