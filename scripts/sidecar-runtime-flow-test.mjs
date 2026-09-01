import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "termina-sidecar-runtime-flow-"));
const sidecarBundle = join(root, "sidecar.mjs");
const bridgeBundle = join(root, "bridge-bundle.mjs");
await build({ entryPoints: ["electron/sidecar.ts"], bundle: true, platform: "node", format: "esm", outfile: sidecarBundle, logLevel: "silent" });
await build({ entryPoints: ["electron/bridge-extension.ts"], bundle: true, platform: "node", format: "esm", outfile: bridgeBundle, logLevel: "silent" });
const { SidecarTailer } = await import(`${pathToFileURL(sidecarBundle).href}?${Date.now()}`);
const { BRIDGE_EXTENSION } = await import(`${pathToFileURL(bridgeBundle).href}?${Date.now()}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  assert.equal(predicate(), true, "timed out waiting for sidecar flow");
};
const record = (bridgeId, seq, t, extra = {}) => ({ bridgeId, seq, t, generation: `generation-${bridgeId}`, ...extra });
const fakeWatch = () => ({ close() {} });

try {
  // Keep the production candidate handshake order explicit: the candidate
  // tailer and terminal mapping must exist before PTY spawn / ps() can yield.
  const mainSource = await readFile("electron/main.ts", "utf8");
  const candidateStart = mainSource.indexOf("private async createCandidate");
  const candidateTailerReady = mainSource.indexOf("await tailer.watchReady(terminalId)", candidateStart);
  const candidateSpawn = mainSource.indexOf("await this.createTerminal(opts.root", candidateStart);
  assert.equal(candidateStart >= 0 && candidateTailerReady > candidateStart && candidateTailerReady < candidateSpawn, true);
  assert.match(mainSource.slice(candidateSpawn, candidateSpawn + 500), /skipSidecarWatch: true/);
  const worldlinesSource = await readFile("electron/worldlines.ts", "utf8");
  const launchStart = worldlinesSource.indexOf("private async launchCandidate");
  const mapping = worldlinesSource.indexOf("this.terminalToComparison.set(terminalId", launchStart);
  const processLookup = worldlinesSource.indexOf("cand.lstart = await readProcessStart(pid)", launchStart);
  assert.equal(launchStart >= 0 && mapping > launchStart && mapping < processLookup, true);
  const coreSource = await readFile("agent-core/main.ts", "utf8");
  const coreAppend = coreSource.indexOf("appendDurable(activeSidecarPath, pending.line)");
  const coreCommit = coreSource.indexOf("seq = pending.seq", coreAppend);
  assert.equal(coreAppend >= 0 && coreCommit > coreAppend, true);

  // A candidate tailer is watched before the first process write. The
  // immediate startup handshake must be delivered from the new active file.
  const immediateDir = join(root, "immediate");
  await mkdir(immediateDir, { mode: 0o700 });
  const immediateFile = join(immediateDir, "term-immediate.jsonl");
  const immediateEvents = [];
  const immediateTailer = new SidecarTailer(immediateDir, fakeWatch);
  immediateTailer.onEvent = (_id, event) => { immediateEvents.push(event); return true; };
  immediateTailer.start();
  const immediateReady = immediateTailer.watchReady("term-immediate");
  await appendFile(immediateFile, `${JSON.stringify(record("immediate", 1, "session_ready", { opId: "boot" }))}\n${JSON.stringify(record("immediate", 2, "agent_settings", { model: "test/model" }))}\n`);
  assert.equal(await immediateReady, true);
  await waitFor(() => immediateEvents.length === 2);
  assert.deepEqual(immediateEvents.map((event) => event.t), ["session_ready", "agent_settings"]);
  assert.deepEqual(immediateEvents.map((event) => event.seq), [1, 2]);
  immediateTailer.stop();

  // A failed append reserves its sequence. Later startup records queue behind
  // that exact identity and are committed only after the retry succeeds.
  const writerDir = join(root, "writer");
  await mkdir(writerDir, { mode: 0o700 });
  const writerFile = join(writerDir, "term-writer.jsonl");
  const writerEvents = [];
  const writerTailer = new SidecarTailer(writerDir, fakeWatch);
  writerTailer.onEvent = (_id, event) => { writerEvents.push(event); return true; };
  writerTailer.start();
  writerTailer.watch("term-writer");
  const extensionSource = BRIDGE_EXTENSION.replace('import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";', "");
  const extensionFile = join(root, "bridge.ts");
  await writeFile(extensionFile, extensionSource);
  process.env.TERMINA_EVENTS_DIR = writerDir;
  process.env.TERMINA_TERMINAL_ID = "term-writer";
  const handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); }, appendEntry() {} };
  const extension = await import(`${pathToFileURL(extensionFile).href}?${Date.now()}`);
  extension.default(pi);
  await mkdir(writerFile);
  handlers.get("session_start")({}, { model: { id: "model", provider: "test" }, thinkingLevel: "low" });
  await rm(writerFile, { recursive: true, force: true });
  await writeFile(writerFile, "", { mode: 0o600 });
  await waitFor(() => writerEvents.length === 2);
  assert.deepEqual(writerEvents.map((event) => event.seq), [1, 2]);
  assert.deepEqual(writerEvents.map((event) => event.t), ["session_ready", "agent_settings"]);
  assert.equal(new Set(writerEvents.map((event) => `${event.bridgeId}:${event.seq}:${event.generation}`)).size, 2);
  writerTailer.stop();

  // An unacknowledged record survives tailer teardown and is delivered once
  // after restart; the next record follows its committed cursor.
  const restartDir = join(root, "restart");
  await mkdir(restartDir, { mode: 0o700 });
  const restartFile = join(restartDir, "term-restart.jsonl");
  await writeFile(restartFile, "");
  const beforeRestart = [];
  const firstTailer = new SidecarTailer(restartDir, fakeWatch);
  firstTailer.onEvent = (_id, event) => { beforeRestart.push(event.seq); return false; };
  firstTailer.start();
  firstTailer.watch("term-restart");
  await appendFile(restartFile, `${JSON.stringify(record("restart", 1, "session_ready"))}\n`);
  await waitFor(() => firstTailer.isPaused("term-restart"));
  firstTailer.stop();
  const afterRestart = [];
  const secondTailer = new SidecarTailer(restartDir, fakeWatch);
  secondTailer.onEvent = (_id, event) => { afterRestart.push(event.seq); return true; };
  secondTailer.start();
  secondTailer.watch("term-restart");
  await waitFor(() => afterRestart.length === 1);
  await appendFile(restartFile, `${JSON.stringify(record("restart", 2, "agent_settled"))}\n`);
  await waitFor(() => afterRestart.length === 2);
  assert.deepEqual(beforeRestart, [1]);
  assert.deepEqual(afterRestart, [1, 2]);
  secondTailer.stop();

  // Concurrent O_APPEND writers must leave complete, identity-distinct JSONL
  // records. This is a raw-file check because each writer owns its bridge id.
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
  assert.equal(concurrentLines.length, 128);
  assert.equal(new Set(concurrentLines.map((event) => `${event.bridgeId}:${event.seq}`)).size, 128);

  // A late legacy seq1 must close the gap before active seq2. A duplicate
  // active seq2 is skipped and seq3 is delivered exactly once.
  const gapDir = join(root, "gap");
  await mkdir(gapDir, { mode: 0o700 });
  const gapFile = join(gapDir, "term-gap.jsonl");
  const legacyFile = join(gapDir, ".term-gap.jsonl.segment");
  await writeFile(legacyFile, `${JSON.stringify(record("gap", 1, "agent_start"))}\n`);
  await writeFile(gapFile, `${JSON.stringify(record("gap", 2, "agent_settled"))}\n${JSON.stringify(record("gap", 2, "agent_settled"))}\n${JSON.stringify(record("gap", 3, "checkpoint_result", { ok: true }))}\n`);
  const gapEvents = [];
  const gapTailer = new SidecarTailer(gapDir, fakeWatch);
  gapTailer.onEvent = (_id, event) => { gapEvents.push(event.seq); return true; };
  gapTailer.start();
  gapTailer.watch("term-gap");
  await waitFor(() => gapEvents.length === 3);
  assert.deepEqual(gapEvents, [1, 2, 3]);
  assert.equal(gapTailer.isPaused("term-gap"), false);
  gapTailer.stop();

  console.log(JSON.stringify({ immediate: immediateEvents.map((event) => event.seq), writer: writerEvents.map((event) => event.seq), restart: afterRestart, concurrent: concurrentLines.length, gap: gapEvents }));
} finally {
  await rm(root, { recursive: true, force: true });
}
