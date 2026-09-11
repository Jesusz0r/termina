import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build } from "esbuild";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

describe("Electron Session Fork Worker & Multi-Process Isolation", () => {
  let work: string;
  let client: any;
  let SessionWriter: any;
  let coreSessionFile: any;
  let replaySessionBundle: any;
  let nativeCoreAvailable: boolean;

  function destinationSession(projectName: string, sessionId: string) {
    const project = join(work, projectName);
    mkdirSync(project, { recursive: false, mode: 0o700 });
    return coreSessionFile(project, sessionId);
  }

  beforeAll(async () => {
    process.env.TERMINA_CORE_TEST = "1";
    work = mkdtempSync(join(tmpdir(), "termina-session-fork-worker-"));

    const sessionMod = await import("../../../agent-core/session.ts");
    SessionWriter = sessionMod.SessionWriter;
    coreSessionFile = sessionMod.coreSessionFile;
    replaySessionBundle = sessionMod.replaySessionBundle;

    nativeCoreAvailable = [
      process.env.TERMINA_CORE_BIN,
      join(process.cwd(), "core", "target", "release", "termina-core"),
      join(process.cwd(), "core", "target", "debug", "termina-core"),
    ].some((candidate) => candidate && existsSync(candidate));

    const bundleBanner = {
      js: 'import { createRequire as __sessionForkRequire } from "node:module"; const require = __sessionForkRequire(import.meta.url);',
    };
    await Promise.all([
      build({
        entryPoints: ["electron/session-fork.ts"],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: join(work, "session-fork.mjs"),
        logLevel: "silent",
      }),
      build({
        entryPoints: ["electron/session-worker.ts"],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: join(work, "session-worker.mjs"),
        banner: bundleBanner,
        logLevel: "silent",
      }),
    ]);

    const { SessionForkClient } = await import(pathToFileURL(join(work, "session-fork.mjs")).href);
    client = new SessionForkClient();
  });

  afterAll(async () => {
    await client?.dispose();
    rmSync(work, { recursive: true, force: true });
  });

  it("discards empty core sessions via native identity-bound cleanup", async () => {
    const emptyCore = destinationSession("empty-core-project", "empty-core");
    const emptyCoreOpened = SessionWriter.open(emptyCore, 0);
    expect(emptyCoreOpened.ok).toBe(true);
    emptyCoreOpened.writer.close();

    const emptyCoreDiscard = await client.discardEmptyCoreSession(emptyCore);
    expect(emptyCoreDiscard.ok && emptyCoreDiscard.removed).toBe(true);
    expect(existsSync(join(work, "empty-core-project", "empty-core"))).toBe(false);
  });

  it("forks core session bundles and keeps main event loop responsive", async () => {
    const source = coreSessionFile(join(work, "source-project"), "source");
    const opened = SessionWriter.open(source, 0);
    expect(opened.ok).toBe(true);
    const recordBytes = 512 * 1024;
    const recordCount = 24;
    for (let index = 1; index <= recordCount; index++) {
      const appended = opened.writer.appendRecord({
        storageSeq: index,
        type: "message",
        message: { role: index % 2 === 0 ? "assistant" : "user", content: "x".repeat(recordBytes) },
      });
      expect(appended.ok).toBe(true);
    }
    opened.writer.close();

    const preAborted = new AbortController();
    preAborted.abort();
    let preAbortedRejected = false;
    try {
      await client.forkCore(
        { sourceSessionFile: source, destinationSessionFile: destinationSession("pre-aborted-project", "pre-aborted") },
        { signal: preAborted.signal },
      );
    } catch (error: any) {
      preAbortedRejected = error instanceof Error && error.name === "AbortError";
    }
    expect(preAbortedRejected).toBe(true);

    const destination = destinationSession("destination-project", "destination");
    let timerTicks = 0;
    const heartbeat = setInterval(() => {
      timerTicks += 1;
    }, 1);
    const result = await client.forkCore({ sourceSessionFile: source, destinationSessionFile: destination });
    clearInterval(heartbeat);

    expect(result.ok && result.kept === recordCount).toBe(true);
    expect(timerTicks).toBeGreaterThanOrEqual(2);

    const replayed = await replaySessionBundle(destination);
    expect(replayed.ok && replayed.messages.length === recordCount).toBe(true);
  });

  it("builds export patches off the main thread", async () => {
    const lines = (n: number, tag: string): string =>
      Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join("\n") + "\n";
    const files = Array.from({ length: 30 }, (_, i) => {
      const before = lines(1200, `f${i}`);
      return { relPath: `file-${i}.ts`, before, after: before.replace(`f${i} line 600`, `f${i} line 600 CHANGED`) };
    });
    let timerTicks = 0;
    const heartbeat = setInterval(() => {
      timerTicks += 1;
    }, 1);
    const result = await client.exportPatch({ files });
    clearInterval(heartbeat);

    expect(result.ok).toBe(true);
    expect(result.patch.match(/diff --git/g)?.length).toBe(30);
    expect(result.patch).toContain("CHANGED");
    expect(timerTicks).toBeGreaterThanOrEqual(2);
  });

  it("bounds export-patch input by count and shape", async () => {
    const files: any[] = Array.from({ length: 205 }, (_, i) => ({ relPath: `f-${i}.ts`, before: null, after: "x\n" }));
    files.push({ relPath: 42, before: null, after: "x\n" }, null, "nope");
    const result = await client.exportPatch({ files });
    expect(result.ok).toBe(true);
    expect(result.patch.match(/diff --git/g)?.length).toBe(200);

    expect((await client.exportPatch({ files: "nope" as any })).ok).toBe(true);
  });
});
