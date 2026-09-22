import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Watchdog / race contracts for #252–#255 and the #259 main mapping.
 * Main cannot be imported here (Electron); methods and handlers are extracted.
 */

const root = process.cwd();
const main = readFileSync(join(root, "electron", "main.ts"), "utf8");
const bootstrap = readFileSync(join(root, "electron", "worldlines", "bootstrap.ts"), "utf8");
const timelinePane = readFileSync(join(root, "src", "main", "timeline-pane.ts"), "utf8");

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
  return (new Function(...names, factory) as (...args: unknown[]) => unknown)(...values);
}

function loadHandler(
  channel: string,
  paramNames: string,
  names: string[] = [],
  values: unknown[] = [],
): (this: object, ...args: unknown[]) => Promise<unknown> {
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
        return (new Function(...names, factory) as (...args: unknown[]) => (this: object, ...args: unknown[]) => Promise<unknown>)(...values);
      }
    }
  }
  throw new Error(`unclosed handler ${channel}`);
}

describe("paint watchdog (refs #252)", () => {
  it("does not treat capture failure or an empty image as a blank frame", () => {
    const method = extractMethod(main, "private startPaintWatchdog(");
    expect(method).toContain("paint watchdog: capture failed");
    expect(method).toContain("capture returned an empty image");
    expect(method).not.toContain("uniform = img === null");
    expect(method).not.toMatch(/catch\s*\{\s*img\s*=\s*null/);
    // A failed capture returns before blankCount / reload.
    const catchAt = method.indexOf("paint watchdog: capture failed");
    const returnAt = method.indexOf("return;", catchAt);
    const blankAt = method.indexOf("blankCount++", catchAt);
    expect(returnAt).toBeGreaterThan(catchAt);
    expect(blankAt).toBeGreaterThan(returnAt);
  });

  it("does not bilinear-downscale a dark UI into a false blank, and ignores native fill", () => {
    const method = extractMethod(main, "private startPaintWatchdog(");
    expect(method).toContain("nativeImageLooksUnpainted");
    expect(method).toContain("nativeImageSolidHex");
    expect(method).toContain("this.rendererReady");
    expect(method).toContain("getBackgroundColor");
    expect(method).not.toContain("img.resize");
    expect(method).not.toContain("0.98");
  });
});

describe("timeline content ready path (refs #253)", () => {
  it("fills write snapshots from watcher or tool_end, not a 400ms timeout", () => {
    const snapshot = extractMethod(main, "private async toolSnapshot(");
    expect(snapshot).toContain("this.beginTimelineContentFill(ev)");
    expect(snapshot).not.toContain("setTimeout(");
    expect(snapshot).not.toContain(", 400)");
    expect(main).toContain("private beginTimelineContentFill(");
    expect(main).toContain("private async finishTimelineWriteSnapshot(");
    expect(extractMethod(main, "private async finishTimelineWriteSnapshot(")).toContain("this.readSnapshotFile(path)");
    expect(extractMethod(main, "private async readSnapshotFile(")).toContain("st.size > MAX_SNAPSHOT_SIZE");
    expect(main).toContain("const TIMELINE_CONTENT_WAIT_MS = 2500");
    expect(extractMethod(main, "private beginTimelineContentFill(")).toContain("setTimeout(() => this.expireTimelineContentFill(ev), TIMELINE_CONTENT_WAIT_MS)");
    expect(extractMethod(main, "private expireTimelineContentFill(")).not.toContain("this.timelineContentFills.delete(ev)");
    expect(extractMethod(main, "private resolveTimelineContentFill(")).toContain("this.timelineContentFills.delete(ev)");
    expect(extractMethod(main, "private scheduleMomentCapture(")).toContain("finishUnmatchedTimelineWriteSnapshots");
  });

  it("awaits the pending fill in timeline:content and drops the renderer jump-poll", () => {
    const handler = extractMethod(main, 'ipcMain.handle("timeline:content"');
    expect(handler).toContain("await Promise.race([");
    expect(handler).toContain("pending.promise");
    expect(handler).toContain("TIMELINE_CONTENT_WAIT_MS");
    expect(timelinePane).toContain("res = await window.termina.getTimelineContent(pane.instanceId, ev.seq);");
    expect(timelinePane).not.toContain("for (let i = 0; i < 5 && !res.ok; i++)");
    expect(timelinePane).not.toContain("setTimeout(resolve, 250)");
    expect(timelinePane).not.toContain("400 milliseconds");
  });

  it("waits for the fill promise instead of returning a false no-snapshot", async () => {
    const handler = loadHandler("timeline:content", "_e, terminalId, seq", ["TIMELINE_CONTENT_WAIT_MS"], [5_000]);
    const ev: { seq: number; path: string; relPath: string; content?: string; ts: number; toolName: string } = {
      seq: 3,
      path: "/proj/a.ts",
      relPath: "a.ts",
      ts: 1,
      toolName: "write",
    };
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    const fills = new WeakMap<object, { promise: Promise<void>; resolve: () => void }>();
    fills.set(ev, { promise, resolve });
    const terminals = new Map([["term-1", { timeline: [ev] }]]);
    const app = {
      terminals,
      runtime: { get: (id: string) => terminals.get(id) },
      timelineContentFills: fills,
    };
    const pending = handler.call(app, {}, "term-1", 3);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    ev.content = "after-write";
    resolve();
    await expect(pending).resolves.toEqual({
      ok: true,
      seq: 3,
      path: "/proj/a.ts",
      relPath: "a.ts",
      content: "after-write",
      ts: 1,
      toolName: "write",
    });
  });

  it("does not hang forever when the fill never resolves", async () => {
    vi.useFakeTimers();
    try {
      const handler = loadHandler("timeline:content", "_e, terminalId, seq", ["TIMELINE_CONTENT_WAIT_MS"], [40]);
      const ev: { seq: number; path: string; relPath: string; content?: string } = {
        seq: 4,
        path: "/proj/b.ts",
        relPath: "b.ts",
      };
      const fills = new WeakMap<object, { promise: Promise<void>; resolve: () => void }>();
      fills.set(ev, { promise: new Promise<void>(() => {}), resolve: () => {} });
      const terminals = new Map([["term-1", { timeline: [ev] }]]);
      const app = {
        terminals,
        runtime: { get: (id: string) => terminals.get(id) },
        timelineContentFills: fills,
      };
      const pending = handler.call(app, {}, "term-1", 4);
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(39);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({
        ok: false,
        seq: 4,
        path: "/proj/b.ts",
        relPath: "b.ts",
      });
      expect(ev.content).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not assign snapshot content over MAX_SNAPSHOT_SIZE", async () => {
    const finish = loadMethod("finishTimelineWriteSnapshot", "private async finishTimelineWriteSnapshot(", [], []) as (
      inst: object,
      ev: { path: string; content?: string },
    ) => Promise<void>;
    const ev = { path: "/proj/huge.ts", content: undefined as string | undefined };
    const fills = new WeakMap<object, { promise: Promise<void>; resolve: () => void; timer: ReturnType<typeof setTimeout> }>();
    fills.set(ev, { promise: Promise.resolve(), resolve: () => {}, timer: setTimeout(() => {}, 0) });
    const assigned: string[] = [];
    const reads: string[] = [];
    await finish.call(
      {
        timelineContentFills: fills,
        workspaceOfTerminal: () => ({ watcher: { lastContents: new Map([["/proj/huge.ts", "x".repeat(100_001)]]) } }),
        contentSizeOk: (content: string | undefined) =>
          content !== undefined && Buffer.byteLength(content, "utf8") <= 100_000,
        readSnapshotFile: async (path: string) => {
          reads.push(path);
          return undefined;
        },
        setRunSnapshot: (_inst: object, _path: string, content: string) => {
          assigned.push(content);
        },
        resolveTimelineContentFill(target: object) {
          fills.delete(target);
        },
      },
      {},
      ev,
    );
    expect(ev.content).toBeUndefined();
    expect(assigned).toEqual([]);
    expect(reads).toEqual(["/proj/huge.ts"]);
  });

  it("keeps the fill after the 2.5s expire so a late finish can still read", async () => {
    vi.useFakeTimers();
    try {
      const begin = loadMethod("beginTimelineContentFill", "private beginTimelineContentFill(", ["TIMELINE_CONTENT_WAIT_MS"], [2500]) as (ev: object) => void;
      const expire = loadMethod("expireTimelineContentFill", "private expireTimelineContentFill(", [], []) as (ev: object) => void;
      const resolve = loadMethod("resolveTimelineContentFill", "private resolveTimelineContentFill(", [], []) as (ev: object) => void;
      const finish = loadMethod("finishTimelineWriteSnapshot", "private async finishTimelineWriteSnapshot(", [], []) as (
        inst: object,
        ev: { path: string; content?: string },
      ) => Promise<void>;
      const ev = { path: "/proj/late.ts", content: undefined as string | undefined };
      const reads: string[] = [];
      const app = {
        timelineContentFills: new WeakMap<object, { promise: Promise<void>; resolve: () => void; timer: ReturnType<typeof setTimeout> }>(),
        beginTimelineContentFill: begin,
        expireTimelineContentFill: expire,
        resolveTimelineContentFill: resolve,
        finishTimelineWriteSnapshot: finish,
        workspaceOfTerminal: () => ({ watcher: { lastContents: new Map() } }),
        contentSizeOk: (content: string | undefined) => content !== undefined,
        readSnapshotFile: async (path: string) => {
          reads.push(path);
          return "late-write";
        },
        setRunSnapshot() {},
      };
      begin.call(app, ev);
      expect(app.timelineContentFills.has(ev)).toBe(true);
      const waiter = app.timelineContentFills.get(ev)!.promise;
      let unblocked = false;
      void waiter.then(() => { unblocked = true; });
      await vi.advanceTimersByTimeAsync(2499);
      expect(unblocked).toBe(false);
      expect(app.timelineContentFills.has(ev)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await waiter;
      expect(unblocked).toBe(true);
      expect(app.timelineContentFills.has(ev)).toBe(true);
      await finish.call(app, {}, ev);
      expect(reads).toEqual(["/proj/late.ts"]);
      expect(ev.content).toBe("late-write");
      expect(app.timelineContentFills.has(ev)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips reading a file that is already over the snapshot cap", async () => {
    const reads: string[] = [];
    const read = loadMethod("readSnapshotFile", "private async readSnapshotFile(", ["stat", "readFile"], [
      async () => ({ isFile: () => true, size: 100_001 }),
      async (path: string) => {
        reads.push(path);
        return "should-not-read";
      },
    ]) as (path: string) => Promise<string | undefined>;
    await expect(read.call({
      contentSizeOk: (content: string | undefined) =>
        content !== undefined && Buffer.byteLength(content, "utf8") <= 100_000,
    }, "/proj/huge.ts")).resolves.toBeUndefined();
    expect(reads).toEqual([]);
  });
});

describe("SIGKILL watchdog (refs #254)", () => {
  it("logs kill failures and marks synthesized 137 as forced cleanup", () => {
    const method = extractMethod(main, "private closeTerminal(");
    expect(method).not.toMatch(/catch\s*\{\s*\}/);
    expect(method).toContain("SIGKILL process-group failed");
    expect(method).toContain("SIGKILL failed");
    expect(method).toContain('existingOnExit(137, "forced")');
    expect(method).not.toMatch(/existingOnExit\(137\)\s*;/);
    expect(main).toContain('origin === "forced" ? " (forced cleanup)"');
  });
});

describe("Change Review baseline and revert (refs #255)", () => {
  it("awaits the real baseline fill instead of a 2s race", () => {
    const handler = extractMethod(main, 'ipcMain.handle("review:baseline"');
    expect(handler).toContain("if (pending) await pending;");
    expect(handler).not.toContain("Promise.race");
    expect(handler).not.toContain("setTimeout(r, 2000)");
    expect(extractMethod(main, "private fillBaseline(")).toContain("baseline fill failed");
  });

  it("does not return an empty baseline while the fill is still in flight", async () => {
    const handler = loadHandler("review:baseline", "_e, terminalId, path");
    const path = "/proj/a.ts";
    let resolveFill!: () => void;
    const pending = new Promise<void>((r) => { resolveFill = r; });
    const inst = {
      workspaceId: "ws-1",
      baselines: new Map<string, string | null>(),
      baselineFills: new Map<string, Promise<void>>([[path, pending]]),
      modified: new Map([[path, { status: "modified" }]]),
    };
    const terminals = new Map([["term-1", inst]]);
    const app = {
      terminals,
      runtime: { get: (id: string) => terminals.get(id) },
      managedPath: async () => ({ path, workspace: { id: "ws-1" } }),
    };
    const request = handler.call(app, {}, "term-1", path);
    let settled = false;
    void request.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    inst.baselines.set(path, "before");
    resolveFill();
    await expect(request).resolves.toEqual({ status: "modified", baseline: "before" });
  });

  it("logs revert blob-read failures instead of swallowing them", () => {
    const method = extractMethod(main, "private async revertReviewFile(");
    expect(method).toContain("review revert: blob read failed");
    expect(method).toContain("anchor ${anchor}");
    expect(method).not.toMatch(/catch\s*\{\s*\/\/ Fall through to the stored string\./);
  });
});

describe("corrupt-repo mapping (refs #259)", () => {
  it("uses classifyOpenedGitRoot in bootstrap and initRecording", () => {
    expect(bootstrap).toContain("export async function classifyOpenedGitRoot(");
    expect(bootstrap).toContain("GIT_UNREADABLE_REASON");
    expect(bootstrap).not.toContain(".catch(() => null)");
    expect(main).toContain("const classified = await classifyOpenedGitRoot(ws.root)");
    expect(main).toContain("ws.recordError = classified.reason");
    const recording = extractMethod(main, "private initRecording(");
    expect(recording).not.toMatch(/const top = await gitTopLevel\(ws\.root\);\s*if \(!top\) \{\s*ws\.recordError = "the opened folder is not inside a Git repository"/);
  });
});
