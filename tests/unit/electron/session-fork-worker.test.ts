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
import { SessionManager } from "@earendil-works/pi-coding-agent";

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

  it("handles Pi session forks, pre-aborted cancellations, and scratch release", async () => {
    const piSourceDir = join(work, "pi-source");
    const piSource = SessionManager.create(join(work, "pi-primary"), piSourceDir);
    piSource.appendMessage({ role: "user", content: "keep the existing Pi fork path", timestamp: Date.now() });
    piSource.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Pi fork ready." }],
      api: "anthropic",
      provider: "anthropic",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const preAbortedPi = new AbortController();
    preAbortedPi.abort();
    let preAbortedPiRejected = false;
    try {
      await client.fork(
        {
          sourceSessionFile: piSource.getSessionFile(),
          entryId: null,
          sessionWorkspaceDir: join(work, "pre-aborted-pi-workspace"),
          candidateRoot: join(work, "pre-aborted-pi-candidate"),
          candidateSessionDir: join(work, "pre-aborted-pi-sessions"),
        },
        { signal: preAbortedPi.signal },
      );
    } catch (error: any) {
      preAbortedPiRejected = error instanceof Error && error.name === "AbortError";
    }
    expect(preAbortedPiRejected).toBe(true);

    const piFork = await client.fork({
      sourceSessionFile: piSource.getSessionFile(),
      entryId: null,
      sessionWorkspaceDir: join(work, "pi-workspace"),
      candidateRoot: join(work, "pi-candidate"),
      candidateSessionDir: join(work, "pi-candidate-sessions"),
    });
    expect(piFork.ok && piFork.entryCount === 2 && !!piFork.sessionFile).toBe(true);
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
});
