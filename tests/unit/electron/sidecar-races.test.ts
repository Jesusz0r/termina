import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

describe("Sidecar Concurrency & Race Condition Invariants", () => {
  it("passes sidecar sealed rotation race tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-sidecar-rotation-race-"));
    const eventsDir = join(root, "events");
    const bundle = join(root, "sidecar.mjs");
    const virtualPath = "termina-delayed-sealed-unlink";
    const virtualSource = `
    import { link as realLink, open as realOpen, readdir as realReaddir, rename as realRename, stat as realStat, unlink as realUnlink } from "node:fs/promises";
    export const link = realLink;
    export const open = realOpen;
    export const readdir = realReaddir;
    export const rename = realRename;
    export const stat = realStat;
    export async function unlink(path) {
      if (String(path).endsWith(".sealed")) {
        const signal = String(path) + ".unlink-window";
        const { writeFileSync } = await import("node:fs");
        writeFileSync(signal, "ready");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return realUnlink(path);
    }
    `;

    await build({
      entryPoints: ["electron/sidecar.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      logLevel: "silent",
      plugins: [{
        name: "delay-sealed-unlink",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^node:fs\/promises$/ }, (args) => {
            if (args.namespace === "delay-fs") return { path: args.path, external: true };
            return { path: virtualPath, namespace: "delay-fs" };
          });
          pluginBuild.onLoad({ filter: /.*/, namespace: "delay-fs" }, () => ({ contents: virtualSource, loader: "js" }));
        },
      }],
    });

    await mkdir(eventsDir);
    const active = join(eventsDir, "term-race.jsonl");
    const sealed = join(eventsDir, ".term-race.jsonl.manual-1.sealed");
    await writeFile(active, "");
    const { SidecarTailer } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);
    const tailer = new SidecarTailer(eventsDir, () => ({ close() {} }), { maxBacklogBytes: 64 * 1024 * 1024 });
    const received: number[] = [];
    tailer.onEvent = (_id: string, event: any) => {
      received.push(event.seq);
      return true;
    };
    tailer.start();
    tailer.watch("term-race");
    const descriptor = await open(active, "a");

    const waitFor = async (predicate: () => boolean, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(predicate()).toBe(true);
    };

    try {
      const prefix = "x".repeat(8 * 1024 * 1024 - 1) + "\n";
      await appendFile(active, prefix + [
        { bridgeId: "race", seq: 1, t: "agent_start" },
        { bridgeId: "race", seq: 2, t: "agent_settled" },
      ].map((record) => `${JSON.stringify(record)}\n`).join(""));
      await rename(active, sealed);
      await writeFile(active, "");
      await waitFor(() => existsSync(sealed + ".unlink-window"));

      await descriptor.write(`${JSON.stringify({ bridgeId: "race", seq: 3, t: "checkpoint_result", ok: true })}\n`);
      await appendFile(active, `${JSON.stringify({ bridgeId: "race", seq: 4, t: "agent_settled" })}\n`);
      await waitFor(() => received.length >= 4);
      expect(received).toEqual([1, 2, 3, 4]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const cursor = JSON.parse(await readFile(join(eventsDir, ".cursor-term-race.json"), "utf8"));
      expect(cursor.sequence).toBe(4);
    } finally {
      await descriptor.close();
      tailer.stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("passes sidecar shutdown marker race tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-sidecar-shutdown-race-"));
    const eventsDir = join(root, "events");
    const bundle = join(root, "sidecar.mjs");
    const ready = join(root, "marker-rename.ready");
    const release = join(root, "marker-rename.release");
    process.env.TERMINA_MARKER_RENAME_READY = ready;
    process.env.TERMINA_MARKER_RENAME_RELEASE = release;
    const virtualPath = "termina-delayed-marker-rename";
    const virtualSource = `
    import { link, open, readdir, stat, unlink } from "node:fs/promises";
    import { existsSync, writeFileSync } from "node:fs";
    import { rename as realRename } from "node:fs/promises";
    export { link, open, readdir, stat, unlink };
    export async function rename(from, to) {
      if (String(to).includes(".backpressure-")) {
        writeFileSync(process.env.TERMINA_MARKER_RENAME_READY, "ready");
        while (!existsSync(process.env.TERMINA_MARKER_RENAME_RELEASE)) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return realRename(from, to);
    }
    `;

    await build({
      entryPoints: ["electron/sidecar.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      logLevel: "silent",
      plugins: [{
        name: "delay-marker-rename",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^node:fs\/promises$/ }, (args) => {
            if (args.namespace === "delay-fs") return { path: args.path, external: true };
            return { path: virtualPath, namespace: "delay-fs" };
          });
          pluginBuild.onLoad({ filter: /.*/, namespace: "delay-fs" }, () => ({ contents: virtualSource, loader: "js" }));
        },
      }],
    });

    await mkdir(eventsDir);
    const file = join(eventsDir, "term-stop.jsonl");
    await writeFile(file, "");
    const { SidecarTailer } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);
    const tailer = new SidecarTailer(eventsDir, () => ({ close() {} }));
    tailer.onEvent = () => false;
    tailer.start();
    tailer.watch("term-stop");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(" "));

    const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(predicate()).toBe(true);
    };

    try {
      await appendFile(file, `${JSON.stringify({ bridgeId: "stop", seq: 1, t: "agent_start" })}\n`);
      await waitFor(() => existsSync(ready));
      tailer.stop();
      await rm(eventsDir, { recursive: true, force: true });
      writeFileSync(release, "release");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(existsSync(join(eventsDir, ".backpressure-term-stop"))).toBe(false);
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("passes sidecar runtime flow tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-sidecar-runtime-flow-"));
    const sidecarBundle = join(root, "sidecar.mjs");
    const bridgeBundle = join(root, "bridge-bundle.mjs");
    await build({ entryPoints: ["electron/sidecar.ts"], bundle: true, platform: "node", format: "esm", outfile: sidecarBundle, logLevel: "silent" });
    await build({ entryPoints: ["electron/bridge-extension.ts"], bundle: true, platform: "node", format: "esm", outfile: bridgeBundle, logLevel: "silent" });
    const { SidecarTailer } = await import(`${pathToFileURL(sidecarBundle).href}?${Date.now()}`);
    const { BRIDGE_EXTENSION } = await import(`${pathToFileURL(bridgeBundle).href}?${Date.now()}`);

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) await sleep(10);
      expect(predicate()).toBe(true);
    };
    const record = (bridgeId: string, seq: number, t: string, extra: Record<string, any> = {}) => ({ bridgeId, seq, t, generation: `generation-${bridgeId}`, ...extra });
    const fakeWatch = () => ({ close() {} });

    try {
      const mainSource = await readFile("electron/main.ts", "utf8");
      const candidateStart = mainSource.indexOf("private async createCandidate");
      const candidateTailerReady = mainSource.indexOf("await tailer.watchReady(terminalId)", candidateStart);
      const candidateSpawn = mainSource.indexOf("await this.createTerminal(opts.root", candidateStart);
      expect(candidateStart >= 0 && candidateTailerReady > candidateStart && candidateTailerReady < candidateSpawn).toBe(true);
      expect(mainSource.slice(candidateSpawn, candidateSpawn + 500)).toMatch(/skipSidecarWatch: true/);
      const worldlinesSource = await readFile("electron/worldlines.ts", "utf8");
      const launchStart = worldlinesSource.indexOf("private async launchCandidate");
      const mapping = worldlinesSource.indexOf("this.terminalToComparison.set(terminalId", launchStart);
      const processLookup = worldlinesSource.indexOf("cand.lstart = await readProcessStart(pid)", launchStart);
      expect(launchStart >= 0 && mapping > launchStart && mapping < processLookup).toBe(true);
      const coreSource = await readFile("agent-core/main.ts", "utf8");
      const coreAppend = coreSource.indexOf("appendDurable(activeSidecarPath, pending.line)");
      const coreCommit = coreSource.indexOf("seq = pending.seq", coreAppend);
      expect(coreAppend >= 0 && coreCommit > coreAppend).toBe(true);

      const immediateDir = join(root, "immediate");
      await mkdir(immediateDir, { mode: 0o700 });
      const immediateFile = join(immediateDir, "term-immediate.jsonl");
      const immediateEvents: any[] = [];
      const immediateTailer = new SidecarTailer(immediateDir, fakeWatch);
      immediateTailer.onEvent = (_id: string, event: any) => { immediateEvents.push(event); return true; };
      immediateTailer.start();
      const immediateReady = immediateTailer.watchReady("term-immediate");
      await appendFile(immediateFile, `${JSON.stringify(record("immediate", 1, "session_ready", { opId: "boot" }))}\n${JSON.stringify(record("immediate", 2, "agent_settings", { model: "test/model" }))}\n`);
      expect(await immediateReady).toBe(true);
      await waitFor(() => immediateEvents.length === 2);
      expect(immediateEvents.map((event) => event.t)).toEqual(["session_ready", "agent_settings"]);
      expect(immediateEvents.map((event) => event.seq)).toEqual([1, 2]);
      immediateTailer.stop();

      const writerDir = join(root, "writer");
      await mkdir(writerDir, { mode: 0o700 });
      const writerFile = join(writerDir, "term-writer.jsonl");
      const writerEvents: any[] = [];
      const writerTailer = new SidecarTailer(writerDir, fakeWatch);
      writerTailer.onEvent = (_id: string, event: any) => { writerEvents.push(event); return true; };
      writerTailer.start();
      writerTailer.watch("term-writer");
      const extensionSource = BRIDGE_EXTENSION.replace('import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";', "");
      const extensionFile = join(root, "bridge.ts");
      await writeFile(extensionFile, extensionSource);
      process.env.TERMINA_EVENTS_DIR = writerDir;
      process.env.TERMINA_TERMINAL_ID = "term-writer";
      const handlers = new Map<string, Function>();
      const pi = { on(name: string, handler: Function) { handlers.set(name, handler); }, appendEntry() {} };
      const extension = await import(`${pathToFileURL(extensionFile).href}?${Date.now()}`);
      extension.default(pi);

      const protectedFile = join(writerDir, "protected.ts");
      await writeFile(join(writerDir, "mine-term-writer.json"), JSON.stringify([protectedFile]));
      let confirmResolve: ((approved: boolean) => void) | undefined;
      let confirmCalls = 0;
      const toolContext = {
        cwd: writerDir,
        ui: {
          confirm: () => {
            confirmCalls++;
            return new Promise<boolean>((resolve) => { confirmResolve = resolve; });
          },
        },
      };
      let approvalSettled = false;
      const approval = handlers.get("tool_call")!({ toolName: "write", input: { path: protectedFile } }, toolContext)
        .then((result: unknown) => { approvalSettled = true; return result; });
      await sleep(25);
      expect(approvalSettled).toBe(false);
      confirmResolve!(true);
      expect(await approval).toBeUndefined();
      expect(confirmCalls).toBe(1);
      expect(await handlers.get("tool_call")!({ toolName: "edit", input: { path: protectedFile } }, toolContext)).toBeUndefined();
      expect(confirmCalls).toBe(1);

      await mkdir(writerFile);
      handlers.get("session_start")!({}, { model: { id: "model", provider: "test" }, thinkingLevel: "low" });
      await rm(writerFile, { recursive: true, force: true });
      await writeFile(writerFile, "", { mode: 0o600 });
      await waitFor(() => writerEvents.length === 2);
      expect(writerEvents.map((event) => event.seq)).toEqual([1, 2]);
      expect(writerEvents.map((event) => event.t)).toEqual(["session_ready", "agent_settings"]);
      expect(new Set(writerEvents.map((event) => `${event.bridgeId}:${event.seq}:${event.generation}`)).size).toBe(2);
      writerTailer.stop();

      const restartDir = join(root, "restart");
      await mkdir(restartDir, { mode: 0o700 });
      const restartFile = join(restartDir, "term-restart.jsonl");
      await writeFile(restartFile, "");
      const beforeRestart: number[] = [];
      const firstTailer = new SidecarTailer(restartDir, fakeWatch);
      firstTailer.onEvent = (_id: string, event: any) => { beforeRestart.push(event.seq); return false; };
      firstTailer.start();
      firstTailer.watch("term-restart");
      await appendFile(restartFile, `${JSON.stringify(record("restart", 1, "session_ready"))}\n`);
      await waitFor(() => firstTailer.isPaused("term-restart"));
      firstTailer.stop();
      const afterRestart: number[] = [];
      const secondTailer = new SidecarTailer(restartDir, fakeWatch);
      secondTailer.onEvent = (_id: string, event: any) => { afterRestart.push(event.seq); return true; };
      secondTailer.start();
      secondTailer.watch("term-restart");
      await waitFor(() => afterRestart.length === 1);
      await appendFile(restartFile, `${JSON.stringify(record("restart", 2, "agent_settled"))}\n`);
      await waitFor(() => afterRestart.length === 2);
      expect(beforeRestart).toEqual([1]);
      expect(afterRestart).toEqual([1, 2]);
      secondTailer.stop();

      const concurrentDir = join(root, "concurrent");
      await mkdir(concurrentDir, { mode: 0o700 });
      const concurrentFile = join(concurrentDir, "term-concurrent.jsonl");
      await writeFile(concurrentFile, "");
      const handles = await Promise.all([open(concurrentFile, "a"), open(concurrentFile, "a")]);
      await Promise.all(handles.map(async (handle, writer) => {
        for (let seq = 1; seq <= 64; seq++) {
          await handle.write(`${JSON.stringify(record(`writer-${writer}`, seq, "agent_start"))}\n`);
        }
      }));
      await Promise.all(handles.map((handle) => handle.close()));
      const concurrentLines = (await readFile(concurrentFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(concurrentLines.length).toBe(128);
      expect(new Set(concurrentLines.map((event) => `${event.bridgeId}:${event.seq}`)).size).toBe(128);

    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
