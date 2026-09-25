import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readdir, readdir as fsReaddir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isErrno } from "../../../shared/guards.ts";
import { normalizeAppPreferences } from "../../../shared/preferences.ts";
import { emptyActivityInput } from "../../../electron/agent-activity.ts";
import { HIDE_THINKING_CSI, SHOW_THINKING_CSI } from "../../../shared/terminal-control.ts";
import { CHALLENGE_PROFILES, DEFAULT_SHORTCUTS, defaultAppPreferences } from "../../../shared/types.ts";
import { isChallengeProfile, isWorldlineLabel } from "../../../electron/main/ipc-validate.ts";
import ts from "typescript";

/**
 * Main hardening batch (refs #219): fourteen items, all in electron/main.ts.
 *
 * Real methods/handlers are extracted and transpiled (the save-revert-lease
 * suite's pattern: main imports Electron and cannot be imported here).
 * Behavioral coverage where the seam allows it, structural pinning for
 * one-line guards.
 */

const root = process.cwd();
const main = readFileSync(join(root, "electron", "main.ts"), "utf8");
const projectWorkspace = readFileSync(join(root, "electron", "main", "project-workspace.ts"), "utf8");

function extractMethod(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing method ${signature}`);
  const paramsEnd = source.indexOf(")", start + signature.length) + 1;
  let angle = 0;
  let brace = -1;
  for (let i = paramsEnd; i < source.length; i++) {
    const ch = source[i];
    if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
    else if (ch === "{" && angle === 0) {
      brace = i;
      break;
    }
  }
  if (brace < 0) throw new Error(`unclosed method ${signature}`);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed method ${signature}`);
}

function loadMethod(factoryName: string, signature: string, names: string[], values: unknown[]): unknown {
  const methodSource = extractMethod(main, signature).replace(/^private /, "");
  const factory = ts.transpileModule(`return ({ ${methodSource} }).${factoryName};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const construct = new Function(...names, factory) as unknown as (...args: unknown[]) => unknown;
  return construct(...values);
}

function loadHandler(channel: string, paramNames: string, names: string[], values: unknown[]): unknown {
  const handleAt = main.indexOf(`ipcMain.handle("${channel}"`);
  if (handleAt < 0) throw new Error(`missing handler ${channel}`);
  const arrow = main.indexOf("=>", handleAt);
  const bodyStart = main.indexOf("{", arrow);
  let depth = 0;
  for (let i = bodyStart; i < main.length; i++) {
    const ch = main[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const body = main.slice(bodyStart, i + 1);
        const factory = ts.transpileModule(`return (async function handler(${paramNames}) ${body});`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const construct = new Function(...names, factory) as unknown as (...args: unknown[]) => unknown;
        return construct(...values);
      }
    }
  }
  throw new Error(`unclosed handler ${channel}`);
}

describe("main hardening batch (refs #219)", () => {
  it("item 1: recorder display follows index completion, not a live promise", () => {
    expect(projectWorkspace).toContain("indexDone: false");
    expect(main.match(/ws\.indexDone = true/g) ?? []).toHaveLength(2);
    expect(main).toContain('startWs2 && !startWs2.indexDone ? "indexing" : "ready"');
    expect(main).toContain("!s || startWs2?.recordError");
    expect(main).not.toContain('indexReady ? "indexing" : "ready"');
  });

  it("item 2: every label-taking worldline handler validates its candidate", async () => {
    expect(isWorldlineLabel("A")).toBe(true);
    expect(isWorldlineLabel("B")).toBe(true);
    for (const bad of ["C", "a", "", null, undefined, 0, ["A"]]) expect(isWorldlineLabel(bad)).toBe(false);

    // Promote (this-shaped): invalid labels never reach the manager.
    const promote = loadHandler("worldline:promote", "_e, comparisonId, label, force", ["isWorldlineLabel"], [isWorldlineLabel]) as (
      event: unknown,
      comparisonId: string,
      label: unknown,
      force?: unknown,
    ) => Promise<{ ok: boolean; error?: string }>;
    const promoted: unknown[] = [];
    const promoteThis = {
      projectOfComparison: () => ({ worldlines: { promote: (...args: unknown[]) => { promoted.push(args); return { ok: true }; } } }),
    };
    for (const bad of ["C", "", null]) {
      expect(await promote.call(promoteThis, {}, "cmp-1", bad, true)).toEqual({ ok: false, error: "invalid candidate" });
    }
    expect(promoted).toHaveLength(0);
    expect(await promote.call(promoteThis, {}, "cmp-1", "A", true)).toEqual({ ok: true });
    expect(promoted).toHaveLength(1);

    // Details/file/open-terminal (wlOf-shaped): same gate, shared predicate.
    for (const channel of ["worldline:details", "worldline:file", "worldline:open-terminal"] as const) {
      const params = channel === "worldline:file" ? "_e, comparisonId, label, relPath" : "_e, comparisonId, label";
      const handler = loadHandler(channel, params, ["wlOf", "isWorldlineLabel"], [
        () => ({ details: () => ({ ok: true }), fileOf: () => ({ ok: true }), openTerminal: () => ({ ok: true }) }),
        isWorldlineLabel,
      ]) as (...args: unknown[]) => Promise<{ ok: boolean; error?: string }>;
      const args = channel === "worldline:file" ? [{}, "cmp-1", "Z", "a.ts"] : [{}, "cmp-1", "Z"];
      expect(await handler.call({}, ...args)).toEqual({ ok: false, error: "invalid candidate" });
      const goodArgs = channel === "worldline:file" ? [{}, "cmp-1", "B", "a.ts"] : [{}, "cmp-1", "B"];
      expect(await handler.call({}, ...goodArgs)).toEqual({ ok: true });
    }

    // Challenge-candidate: the label gate runs before profile validation.
    const challenge = loadHandler(
      "worldline:challenge-candidate",
      "_e, comparisonId, label, profile",
      ["wlOf", "isWorldlineLabel", "isChallengeProfile"],
      [() => ({ challengeFromCandidate: () => ({ ok: true }) }), isWorldlineLabel, isChallengeProfile],
    ) as (...args: unknown[]) => Promise<{ ok: boolean; error?: string }>;
    expect(await challenge.call({}, {}, "cmp-1", "Z", "garbage-profile")).toEqual({ ok: false, error: "invalid candidate" });
    expect(await challenge.call({}, {}, "cmp-1", "A", "garbage-profile")).toEqual({
      ok: false,
      error: "invalid challenge profile",
    });
    expect(await challenge.call({}, {}, "cmp-1", "A", CHALLENGE_PROFILES[0])).toEqual({ ok: true });

    // Base-file takes no label at all: nothing to validate there.
    expect(main).toContain('ipcMain.handle("worldline:base-file", (_e, comparisonId: string, relPath: string)');
  });

  it("item 4: write and resize ignore closed terminals", async () => {
    const write = loadHandler("terminals:write", "_e, id, data", [], []) as (
      event: unknown,
      id: unknown,
      data: unknown,
    ) => Promise<void>;
    const resize = loadHandler("terminals:resize", "_e, id, cols, rows", ["MAX_TERMINAL_DIMENSION"], [1024]) as (
      event: unknown,
      id: unknown,
      cols: unknown,
      rows: unknown,
    ) => Promise<void>;
    const calls: string[] = [];
    const terminals = new Map([
      ["open", { id: "open", type: "shell", closed: false, pty: { write: (d: string) => calls.push(`write:${d}`), interrupt: () => calls.push("interrupt"), resize: (c: number, r: number) => calls.push(`resize:${c}x${r}`) } }],
      ["shut", { id: "shut", type: "shell", closed: true, pty: { write: (d: string) => calls.push(`write:${d}`), interrupt: () => calls.push("interrupt"), resize: (c: number, r: number) => calls.push(`resize:${c}x${r}`) } }],
    ]);
    const app = { terminals, runtime: { get: (id: string) => terminals.get(id) }, trackNewCommandInput: () => undefined };
    await write.call(app, {}, "open", "hello");
    await write.call(app, {}, "open", "\x03");
    await write.call(app, {}, "shut", "hello");
    await write.call(app, {}, "shut", "\x03");
    await resize.call(app, {}, "shut", 80, 24);
    await resize.call(app, {}, "open", 2000, 1);
    await resize.call(app, {}, "open", 80, 24);
    expect(calls).toEqual(["write:hello", "interrupt", "resize:1024x2", "resize:80x24"]);
  });

  it("item 5: /clear drops the staged prompt and the stale verdict", async () => {
    const clear = loadMethod("clearForNewSession", "private async clearForNewSession(", ["readdir", "emptyActivityInput"], [readdir, emptyActivityInput]) as (
      terminalId: string,
      expected?: unknown,
    ) => Promise<void>;
    const dir = mkdtempSync(join(tmpdir(), "termina-clear-"));
    try {
      const sent: Array<{ channel: string; payload: unknown }> = [];
      const inst = {
        id: "term-1",
        timeline: [],
        momentDots: [],
        captureTimer: null,
        pendingHints: new Set<string>(),
        lastToolAt: new Map<string, number>(),
        runSnapshots: new Map<string, string>(),
        runSnapshotBytes: 0,
        lastTimelinePrefixKey: "",
        plan: [],
        touched: new Set<string>(),
        pendingFileTools: new Map<string, string>(),
        toolOutcomes: new Map<string, string>(),
        currentRun: null,
        pendingPrompt: { file: "prompt-term-1-x.json", text: "staged prompt", images: 0 },
        verify: { state: "fail", command: "npm run test", summary: "failing" },
      };
      const terminals = new Map([["term-1", inst]]);
      const app = {
        terminals,
        runtime: { get: (id: string) => terminals.get(id) },
        activityInputs: new Map(),
        lastActivityKey: new Map(),
        subagents: { killOwner: () => 0 },
        eventsDirOf: () => dir,
        removeEventLeaf: async () => undefined,
        releaseStateIfUnused: async () => undefined,
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
        sendTimelinePrefix: () => undefined,
        sendInstances: () => undefined,
        sendPlan: () => undefined,
        workspaceOfTerminal: () => null,
        clearUserEdits: () => undefined,
        clearMailbox: () => undefined,
        projectOfTerminal: () => null,
      };
      await clear.call(app, "term-1", null);
      expect(inst.pendingPrompt).toBeNull();
      expect(inst.verify).toEqual({ state: "untested", command: null, summary: null });
      expect(sent).toContainEqual({
        channel: "verify:state",
        payload: { terminalId: "term-1", verify: { state: "untested", command: null, summary: null } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("item 6: flush requests carry random per-request ids", async () => {
    const flush = loadMethod("flushDirtyModels", "private flushDirtyModels(", ["randomUUID"], [randomUUID]) as (
      writerId: string,
      workspaceId: string,
      timeoutMs?: number,
      expected?: unknown,
    ) => Promise<{ ok: boolean; failed: string[] }>;
    const sent: Array<{ requestId: string }> = [];
    const app = {
      projectOfWorkspace: () => ({ project: { id: "proj-1" }, workspace: { id: "ws-1" } }),
      flushWaiters: new Map(),
      send: (_channel: string, payload: { requestId: string }) => {
        sent.push(payload);
        return true;
      },
    };
    const [first, second] = await Promise.all([
      flush.call(app, "holder", "ws-1", 30),
      flush.call(app, "holder", "ws-1", 30),
    ]);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.requestId).toMatch(/^flush-[0-9a-f-]{36}$/);
    expect(sent[1]!.requestId).toMatch(/^flush-[0-9a-f-]{36}$/);
    expect(sent[0]!.requestId).not.toBe(sent[1]!.requestId);
    expect(app.flushWaiters.size).toBe(0);
    expect(main).not.toContain("flushSeq");
  });

  it("item 7: file open enforces the budget on bytes read, not bytes stated", async () => {
    const openFile = loadMethod(
      "openFileInEditor",
      "private async openFileInEditor(",
      ["stat", "readFile", "MAX_OPEN_FILE_SIZE", "previewKind", "MAX_PREVIEW_FILE_SIZE"],
      [
        async () => ({ isFile: () => true, size: 10 }),
        async () => "x".repeat(3 * 1024 * 1024),
        2 * 1024 * 1024,
        (path: string) => path.endsWith(".pdf") || /\.(png|jpe?g|gif|webp|svg)$/i.test(path) ? "image" : null,
        32 * 1024 * 1024,
      ],
    ) as (absPath: string, owner: unknown) => Promise<{ ok: boolean; error?: string }>;
    const app = {
      projectWorkspace: () => ({ project: {}, workspace: { id: "ws-1", changeLines: new Map() } }),
      managedPath: async (abs: string) => ({ path: abs, workspace: { id: "ws-1", changeLines: new Map() } }),
    };
    const grown = await openFile.call(app, "/proj/grown.txt", {});
    expect(grown.ok).toBe(false);
    expect(grown.error).toContain(`${3 * 1024 * 1024} bytes`);
    const smallOpen = loadMethod(
      "openFileInEditor",
      "private async openFileInEditor(",
      ["stat", "readFile", "MAX_OPEN_FILE_SIZE", "previewKind", "MAX_PREVIEW_FILE_SIZE"],
      [
        async () => ({ isFile: () => true, size: 5, mtimeMs: 1 }),
        async () => "small",
        2 * 1024 * 1024,
        () => null,
        32 * 1024 * 1024,
      ],
    ) as (absPath: string, owner: unknown) => Promise<{ ok: boolean; content?: string }>;
    expect(await smallOpen.call(app, "/proj/small.txt", {})).toMatchObject({ ok: true, content: "small" });
  });

  it("item 8: successful writes reap dead-pid temps and keep everything else", async () => {
    const sweep = loadMethod(
      "sweepReplaceTemps",
      "private async sweepReplaceTemps(",
      ["dirname", "basename", "readdir", "rm", "join", "isErrno"],
      [dirname, basename, fsReaddir, rm, join, isErrno],
    ) as (path: string) => Promise<void>;
    const dir = mkdtempSync(join(tmpdir(), "termina-sweep-"));
    try {
      const deadPid = spawnSync("true").pid!;
      const litter = join(dir, `note.txt.${deadPid}.${randomUUID()}.tmp`);
      const livePid = join(dir, `note.txt.${process.ppid}.${randomUUID()}.tmp`);
      const ownPid = join(dir, `note.txt.${process.pid}.${randomUUID()}.tmp`);
      writeFileSync(join(dir, "note.txt"), "content");
      writeFileSync(litter, "litter");
      writeFileSync(livePid, "live");
      writeFileSync(ownPid, "own");
      writeFileSync(join(dir, "note.txt.junk.tmp"), "user file");
      writeFileSync(join(dir, "note.txt.12345.not-a-uuid.tmp"), "user file");
      writeFileSync(join(dir, `other.txt.${deadPid}.${randomUUID()}.tmp`), "other base");
      await sweep(join(dir, "note.txt"));
      const names = readdirSync(dir).sort();
      expect(names).not.toContain(basename(litter));
      expect(names).toContain(basename(livePid));
      expect(names).toContain(basename(ownPid));
      expect(names).toContain("note.txt.junk.tmp");
      expect(names).toContain("note.txt.12345.not-a-uuid.tmp");
      expect(names).toContain("note.txt");
      expect(names).toHaveLength(6);
      // A missing directory never fails the write path.
      await sweep(join(dir, "nope", "f.txt"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("item 9: state unref targets the owning project", async () => {
    const release = loadMethod("releaseStateIfUnused", "private async releaseStateIfUnused(", [], []) as (
      stateId: string,
      ignoredTerminalId: string | undefined,
      ignoredSeq: number | undefined,
      owner: { id: string; storePromise: Promise<{ unref: (id: string) => Promise<void> }> } | null,
    ) => Promise<void>;
    const unrefA: string[] = [];
    const unrefB: string[] = [];
    const projectA = { id: "a", storePromise: Promise.resolve({ unref: async (id: string) => { unrefA.push(id); } }) };
    const projectB = { id: "b", storePromise: Promise.resolve({ unref: async (id: string) => { unrefB.push(id); } }) };
    let referenced = false;
    const app = {
      stateIsReferenced: () => referenced,
      projects: new Map([["a", projectA], ["b", projectB]]),
    };
    await release.call(app, "state-1", undefined, undefined, projectA);
    expect(unrefA).toEqual(["state-1"]);
    expect(unrefB).toEqual([]);
    referenced = true;
    await release.call(app, "state-2", undefined, undefined, projectA);
    expect(unrefA).toEqual(["state-1"]);
    referenced = false;
    await release.call(app, "state-3", undefined, undefined, null);
    expect(unrefA).toEqual(["state-1", "state-3"]);
    expect(unrefB).toEqual(["state-3"]);
  });

  it("item 10: paste moves without replacing and narrows copy collisions", () => {
    const start = main.indexOf("// Explorer clipboard paste");
    const end = main.indexOf("private async openFileInEditor", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const span = main.slice(start, end);
    expect(span).toContain("renameBoundEntry(workspace.root, src, dest)");
    expect(span).toContain("errorOnExist: true");
    expect(span).toContain("Residual race");
  });

  it("item 11: lease waiters grant in FIFO order without starving", async () => {
    const acquire = loadMethod("acquireWriteLease", "private async acquireWriteLease(", [], []) as (
      wsId: string,
      requesterId: string,
      timeoutMs?: number,
    ) => Promise<{ ok: boolean; generation: number; error?: string }>;
    const release = loadMethod("releaseWriteLease", "private releaseWriteLease(", [], []) as (
      wsId: string,
      requesterId: string,
    ) => void;
    const grant = loadMethod("grantLeaseWaiter", "private grantLeaseWaiter(", [], []) as (ws: {
      id: string;
      writerId: string | null;
      leaseDepth?: number;
      generation: number;
    }) => void;
    const ws = { id: "ws-1", writerId: null as string | null, leaseDepth: 0, generation: 7 };
    const app: {
      workspaceById: (id: string) => typeof ws | null;
      leaseWaiters: Map<string, Array<{ requesterId: string; settled: boolean; timer: ReturnType<typeof setTimeout> }>>;
      grantLeaseWaiter: (target: typeof ws) => void;
      kickWorkspaceMomentCapture: () => void;
    } = {
      workspaceById: (id: string) => (id === ws.id ? ws : null),
      leaseWaiters: new Map(),
      grantLeaseWaiter: (target) => grant.call(app, target),
      kickWorkspaceMomentCapture: () => undefined,
    };
    // FIFO order across three waiters.
    expect(await acquire.call(app, ws.id, "holder", 100)).toEqual({ ok: true, generation: 7 });
    const order: string[] = [];
    const waitA = acquire.call(app, ws.id, "a", 5000).then((r) => { order.push("a"); return r; });
    const waitB = acquire.call(app, ws.id, "b", 5000).then((r) => { order.push("b"); return r; });
    const waitC = acquire.call(app, ws.id, "c", 5000).then((r) => { order.push("c"); return r; });
    release.call(app, ws.id, "holder");
    expect(await waitA).toEqual({ ok: true, generation: 7 });
    release.call(app, ws.id, "a");
    expect(await waitB).toEqual({ ok: true, generation: 7 });
    release.call(app, ws.id, "b");
    expect(await waitC).toEqual({ ok: true, generation: 7 });
    expect(order).toEqual(["a", "b", "c"]);
    release.call(app, ws.id, "c");
    expect(ws.writerId).toBeNull();
    expect(app.leaseWaiters.size).toBe(0);
    // Re-entrancy: the holder never queues behind itself.
    expect(await acquire.call(app, ws.id, "holder", 100)).toEqual({ ok: true, generation: 7 });
    expect(await acquire.call(app, ws.id, "holder", 100)).toEqual({ ok: true, generation: 7 });
    expect(ws.leaseDepth).toBe(2);
    const waiter = acquire.call(app, ws.id, "w", 5000);
    expect(await acquire.call(app, ws.id, "holder", 0)).toEqual({ ok: true, generation: 7 });
    release.call(app, ws.id, "holder");
    release.call(app, ws.id, "holder");
    release.call(app, ws.id, "holder");
    expect(await waiter).toEqual({ ok: true, generation: 7 });
    release.call(app, ws.id, "w");
    // A release by a non-holder changes nothing.
    expect(await acquire.call(app, ws.id, "holder", 100)).toEqual({ ok: true, generation: 7 });
    release.call(app, ws.id, "impostor");
    expect(ws.writerId).toBe("holder");
    // Timeouts fail with the busy error and leave no queue behind.
    const timedOut = await acquire.call(app, ws.id, "impatient", 20);
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toMatch(/another writer holds the lease: holder/);
    expect(app.leaseWaiters.size).toBe(0);
    // A timed-out waiter is skipped when the lease frees.
    const doomed = acquire.call(app, ws.id, "doomed", 20);
    const survivor = acquire.call(app, ws.id, "survivor", 5000);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await doomed).ok).toBe(false);
    release.call(app, ws.id, "holder");
    expect(await survivor).toEqual({ ok: true, generation: 7 });
    release.call(app, ws.id, "survivor");
    // Unknown workspaces and zero budgets fail fast.
    expect(await acquire.call(app, "ws-missing", "x", 100)).toEqual({
      ok: false,
      generation: 0,
      error: "workspace not found",
    });
    expect(await acquire.call(app, ws.id, "fast", 0)).toEqual({ ok: true, generation: 7 });
    release.call(app, ws.id, "fast");
  });

  it("item 12: checkpoint capture has an overall deadline", async () => {
    expect(main).toContain("CHECKPOINT_CAPTURE_TIMEOUT_MS = 30_000");
    const checkpoint = loadMethod(
      "handleCheckpointRequest",
      "private async handleCheckpointRequest(",
      ["CHECKPOINT_CAPTURE_TIMEOUT_MS"],
      [30],
    ) as (
      inst: { id: string; currentRun: null },
      requestId: string,
      kind: string,
      entryId: string,
      expected?: unknown,
    ) => Promise<void>;
    const makeApp = (capture: () => Promise<{ commit: string }>) => {
      const acks: Array<{ requestId: string; body: unknown }> = [];
      const releases: string[] = [];
      const tracked: Array<Promise<unknown>> = [];
      const app = {
        workspaceOfTerminal: () => ({ id: "ws-1", primary: true, lastStateCommit: "s0" }),
        projectOfTerminal: () => ({ storePromise: Promise.resolve({}) }),
        acquireWriteLease: async () => ({ ok: true, generation: 1 }),
        captureStable: capture,
        setWorkspaceState: () => undefined,
        writeAck: (_terminalId: string, requestId: string, body: unknown) => {
          acks.push({ requestId, body });
        },
        trackRecordingTask: (task: Promise<unknown>) => {
          tracked.push(task);
        },
        releaseWriteLease: (_wsId: string, requester: string) => {
          releases.push(requester);
        },
      };
      return { app, acks, releases, tracked };
    };
    // A wedged capture answers on the deadline and releases when it lands.
    let releaseCapture!: (state: { commit: string }) => void;
    const hung = new Promise<{ commit: string }>((resolve) => {
      releaseCapture = resolve;
    });
    const wedged = makeApp(() => hung);
    await checkpoint.call(wedged.app, { id: "term-1", currentRun: null }, "req-1", "checkpoint", "entry-1", null);
    expect(wedged.acks).toEqual([{ requestId: "req-1", body: { ok: false, error: "checkpoint capture timed out" } }]);
    expect(wedged.releases).toEqual([]);
    expect(wedged.tracked).toHaveLength(1);
    releaseCapture({ commit: "late" });
    await wedged.tracked[0];
    expect(wedged.releases).toEqual(["checkpoint:term-1:req-1"]);
    // A fast capture keeps the immediate path: ack, state, release.
    const states: string[] = [];
    const fast = makeApp(async () => ({ commit: "s1" }));
    (fast.app as { setWorkspaceState: (ws: unknown, state: string) => void }).setWorkspaceState = (_ws, state) => {
      states.push(state);
    };
    await checkpoint.call(fast.app, { id: "term-1", currentRun: null }, "req-2", "checkpoint", "entry-2", null);
    expect(fast.acks).toEqual([{ requestId: "req-2", body: { ok: true, stateId: "s1" } }]);
    expect(states).toEqual(["s1"]);
    expect(fast.releases).toEqual(["checkpoint:term-1:req-2"]);
  });

  it("item 13: preference patches rebuild the menu only for menu state", async () => {
    const commit = loadMethod(
      "commitPreferencePatch",
      "private async commitPreferencePatch(",
      ["normalizeAppPreferences", "nativeTheme", "SHOW_THINKING_CSI", "HIDE_THINKING_CSI"],
      [normalizeAppPreferences, { themeSource: "" }, SHOW_THINKING_CSI, HIDE_THINKING_CSI],
    ) as (
      patch: Record<string, unknown>,
      activateShortcuts: boolean,
      confirmReset?: boolean,
    ) => Promise<unknown>;
    const makeApp = () => {
      const menus: number[] = [];
      const app = {
        preferenceCommits: Promise.resolve(),
        preferences: defaultAppPreferences(),
        preferencesStore: { save: async () => undefined },
        shortcutMap: { ...DEFAULT_SHORTCUTS },
        terminals: new Map(),
        runtime: { values: () => new Map().values() },
        buildMenu: () => {
          menus.push(1);
        },
      };
      return { app, menus };
    };
    const themed = makeApp();
    await commit.call(themed.app, { theme: "light" }, false);
    expect(themed.menus).toHaveLength(0);
    const recents = makeApp();
    await commit.call(recents.app, { recentFiles: [{ projectId: "p", relPath: "a.ts" }] }, false);
    expect(recents.menus).toHaveLength(0);
    const thinking = makeApp();
    await commit.call(thinking.app, { showThinking: false }, false);
    expect(thinking.menus).toHaveLength(1);
    const keys = Object.keys(DEFAULT_SHORTCUTS) as Array<keyof typeof DEFAULT_SHORTCUTS>;
    const first = keys[0]!;
    const second = keys[1]!;
    const swapped = { ...DEFAULT_SHORTCUTS, [first]: DEFAULT_SHORTCUTS[second] };
    const activated = makeApp();
    await commit.call(activated.app, { shortcuts: swapped }, true);
    expect(activated.menus).toHaveLength(1);
    const stored = makeApp();
    await commit.call(stored.app, { shortcuts: swapped }, false);
    expect(stored.menus).toHaveLength(0);
  });

  it("item 14: prompt payloads must carry the terminal's prompt prefix", () => {
    const start = main.indexOf('case "prompt":');
    const end = main.indexOf('case "steer_input":', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(main.slice(start, end)).toContain("`prompt-${terminalId}-`");
  });
});
