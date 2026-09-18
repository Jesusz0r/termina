import { afterAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const fixtureRoot = mkdtempSync(join(tmpdir(), "session-clear-"));
const brokenSessionFile = join(fixtureRoot, "clear-broken", "current", "session.jsonl");
process.env.TERMINA_CORE_TEST = "1";
process.env.TERMINA_CORE_SESSION_ID = "clear-broken";
process.env.TERMINA_CORE_SESSION_FILE = brokenSessionFile;

import {
  SessionWriter,
  coreSessionFile,
  type SessionWriter as SessionWriterType,
} from "../../../agent-core/session.ts";

const roots: string[] = [fixtureRoot];
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

function seedBundle(id: string, messages: Array<{ role: string; content: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "session-clear-seed-"));
  roots.push(root);
  const sessionFile = coreSessionFile(root, id);
  // Session admission locks are transient under parallel workers; retry
  // like resume-quarantine.test.ts before failing.
  const deadline = Date.now() + 5000;
  let opened = SessionWriter.open(sessionFile, 0);
  while (!opened.ok && /busy|admission lock is unreadable/i.test(opened.error || "") && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    opened = SessionWriter.open(sessionFile, 0);
  }
  if (!opened.ok) throw new Error(opened.error);
  writers.push(opened.writer);
  try {
    messages.forEach((message, index) => {
      const appended = opened.writer.appendRecord({ storageSeq: index + 1, type: "message", message });
      if (!appended.ok) throw new Error(appended.error);
    });
  } finally {
    opened.writer.close();
  }
  return sessionFile;
}

describe("/clear writer-open failure (#222)", () => {
  it("resets to a coherent not-prepared state instead of keeping orphaned history", async () => {
    const main = await import("../../../agent-core/main.ts");
    // Seed the /clear target with content so the archive path runs.
    const seeded = seedBundle("clear-broken-seed", [{ role: "user", content: "old live view" }]);
    // Point the module session at a real bundle: copy the seed into place.
    mkdirSync(dirname(brokenSessionFile), { recursive: true, mode: 0o700 });
    copyFileSync(seeded, brokenSessionFile);

    // Dirty the live view through a valid resume first.
    const liveFile = seedBundle("clear-live", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    const resumed = await main.testOnlyResumeSessionBody({
      sessionFile: liveFile,
      openWriter: () => {},
    });
    expect(resumed.ok).toBe(true);
    expect(main.testOnlyResumeState()).toMatchObject({ historyLength: 2, storageSeq: 2, streamPrepared: true });

    main.testOnlySetOpenSessionWriterOverride(() => {
      throw new Error("injected open failure");
    });
    try {
      main.testOnlyDispatchLine("/clear");
    } finally {
      main.testOnlySetOpenSessionWriterOverride(null);
    }
    // The old view is archived aside; the live view is coherently empty and
    // not prepared, so the next prompt re-prepares instead of running
    // writerless with reused sequence numbers.
    expect(main.testOnlyResumeState()).toEqual({ historyLength: 0, storageSeq: 0, streamPrepared: false });
    const bundleDir = dirname(dirname(brokenSessionFile));
    expect(readdirSync(bundleDir).some((n) => n.startsWith("archive-"))).toBe(true);
  });

  it("still clears cleanly when the writer opens", async () => {
    const main = await import("../../../agent-core/main.ts");
    const liveFile = seedBundle("clear-live-ok", [{ role: "user", content: "hello" }]);
    const resumed = await testOnlyResume(main, liveFile);
    expect(resumed.ok).toBe(true);
    withTempHome(() => {
      main.testOnlyDispatchLine("/clear");
    });
    expect(main.testOnlyResumeState()).toEqual({ historyLength: 0, storageSeq: 0, streamPrepared: true });
  });

  it("keeps bash permission policy across /clear", async () => {
    const main = await import("../../../agent-core/main.ts");
    const liveFile = seedBundle("clear-keep-permissions", [{ role: "user", content: "hello" }]);
    const resumed = await testOnlyResume(main, liveFile);
    expect(resumed.ok).toBe(true);
    expect(main.testOnlyResumeState().historyLength).toBe(1);
    main.testOnlyDispatchLine("/permissions always");
    expect(main.testOnlyPermissionMode()).toBe("always");
    withTempHome(() => {
      main.testOnlyDispatchLine("/clear");
    });
    expect(main.testOnlyResumeState()).toMatchObject({ historyLength: 0, streamPrepared: true });
    expect(main.testOnlyPermissionMode()).toBe("always");
  });

  it("starts the next persist at storageSeq 1 after a live session", async () => {
    const main = await import("../../../agent-core/main.ts");
    const liveFile = seedBundle("clear-live-seq", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    const resumed = await testOnlyResume(main, liveFile);
    expect(resumed.ok).toBe(true);
    expect(main.testOnlyResumeState().storageSeq).toBe(2);
    withTempHome(() => {
      main.testOnlyDispatchLine("/clear");
    });
    expect(main.testOnlyResumeState()).toEqual({ historyLength: 0, storageSeq: 0, streamPrepared: true });
    expect(main.testOnlyPersist()).toEqual({ ok: true, storageSeq: 1 });
  });
});

async function testOnlyResume(main: typeof import("../../../agent-core/main.ts"), sessionFile: string) {
  return main.testOnlyResumeSessionBody({ sessionFile, openWriter: () => {} });
}

function withTempHome(fn: () => void): void {
  const originalHome = process.env.HOME;
  const homeRoot = mkdtempSync(join(tmpdir(), "session-clear-home-"));
  roots.push(homeRoot);
  process.env.HOME = homeRoot;
  try {
    fn();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
}
