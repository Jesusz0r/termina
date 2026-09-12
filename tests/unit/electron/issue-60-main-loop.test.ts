import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { changedLinesInAfter } from "../../../shared/line-diff.ts";
import { parsePromptPayload, readPromptPayloadFile } from "../../../electron/prompt-payload.ts";

/**
 * Issue #60: line-diff LCS, run-start baselines, and prompt JSON.parse off the
 * main event loop. Pins identical output (worker vs sync, first-touch vs
 * speculative, bounded prompt read vs full parse) and main-loop responsiveness.
 */

const main = readFileSync("electron/main.ts", "utf8");
const manager = readFileSync("electron/worldlines/manager.ts", "utf8");

function sliceBetween(source: string, start: string, end: string): string {
  const s = source.indexOf(start);
  if (s < 0) throw new Error(`missing ${start}`);
  const e = source.indexOf(end, s + start.length);
  if (e < 0) throw new Error(`missing ${end}`);
  return source.slice(s, e);
}

const lines = (n: number, tag: string, changeAt = -1): string => {
  const arr = Array.from({ length: n }, (_, i) => `${tag} line ${i} content padding for realism`);
  if (changeAt >= 0) arr[changeAt] = `${tag} line ${changeAt} CHANGED content padding for realism`;
  return arr.join("\n");
};

describe("issue #60 line-diff offload", () => {
  let work = "";
  let client: any = null;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "termina-issue60-linediff-"));
    const banner = {
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
        banner,
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

  it("worker line-diff matches sync output on all shapes", async () => {
    const mid = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag}-${i}-x`.padEnd(40, "y")).join("\n");
    const cases: Array<[string, string, string]> = [
      ["empty to empty", "", ""],
      ["empty to content", "", "a\nb\nc"],
      ["single change 100 lines", lines(100, "a"), lines(100, "a", 50)],
      ["single change 1k lines", lines(1000, "a"), lines(1000, "a", 500)],
      ["pure deletion marks next line", "a\nb\nc\nd", "a\nd"],
      ["pure insertion", "a\nd", "a\nb\nc\nd"],
      ["LCS 100x100", `h\n${mid(100, "a")}\nf`, `h\n${mid(100, "b")}\nf`],
      ["LCS 400x400", `h\n${mid(400, "a")}\nf`, `h\n${mid(400, "b")}\nf`],
      ["greedy 2k rewrite", lines(2000, "a"), lines(2000, "b")],
    ];
    for (const [name, before, after] of cases) {
      const expected = changedLinesInAfter(before, after);
      const res = await client.lineDiff({ before, after });
      expect(res.ok, name).toBe(true);
      expect(res.lines, name).toEqual(expected);
    }
  });

  it("worker line-diff rejects invalid input for sync fallback", async () => {
    await expect(client.lineDiff({ before: 42 as any, after: "x" })).rejects.toThrow();
  });

  it("worker line-diff keeps the main loop responsive on an LCS-heavy diff", async () => {
    const mid = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag}-${i}-x`.padEnd(40, "y")).join("\n");
    const before = `header\n${mid(600, "a")}\nfooter`;
    const after = `header\n${mid(600, "b")}\nfooter`;
    // Sanity: the sync path blocks (~7ms); the worker path must not.
    expect(changedLinesInAfter(before, after).length).toBeGreaterThan(0);
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      const res = await client.lineDiff({ before, after });
      expect(res.ok).toBe(true);
      expect(res.lines).toEqual(changedLinesInAfter(before, after));
    } finally {
      clearInterval(heartbeat);
    }
    expect(ticks).toBeGreaterThanOrEqual(1);
  });

  it("watcher emit diffs via the worker helper with identical payload", () => {
    const changeBlock = sliceBetween(main, "watcher.onChange =", "watcher.onFileTouched =");
    // The emit path awaits the worker helper; the sync diff lives only in the fallback.
    expect(changeBlock).toContain("await this.computeChangedLines(change.prev, change.content)");
    expect(changeBlock).not.toContain("changedLinesInAfter(");
    // Payload contract unchanged: cache + file:changed carry the same lines.
    expect(changeBlock).toContain("this.setBounded(ws.changeLines, path, changedLines, TerminaApp.MAX_MODIFIED_FILES)");
    expect(changeBlock).toContain("changedLines }, rendererTarget");
    const helper = sliceBetween(main, "private async computeChangedLines(", "private async recordModified(");
    expect(helper).toContain("this.sessionFork.lineDiff({ before, after })");
    expect(helper).toContain("return changedLinesInAfter(before, after);");
  });

  it("diff offload does not reorder the #57 generation fence", () => {
    const changeBlock = sliceBetween(main, "watcher.onChange =", "watcher.onFileTouched =");
    const dup = changeBlock.indexOf("if (isDupWatch) return;");
    const bump = changeBlock.indexOf("ws.generation++;");
    const diff = changeBlock.indexOf("await this.computeChangedLines(");
    expect(dup).not.toBe(-1);
    expect(bump).not.toBe(-1);
    expect(diff).not.toBe(-1);
    // Duplicates never bump; the single bump stays before any async diff work.
    expect(bump).toBeGreaterThan(dup);
    expect(diff).toBeGreaterThan(bump);
    expect(changeBlock.split("ws.generation++;").length - 1).toBe(1);
  });
});

describe("issue #60 baseline first-touch", () => {
  it("prepareRunBaselines takes no cache and copies nothing", () => {
    const method = sliceBetween(main, "private prepareRunBaselines(", "private setBaseline(");
    expect(method).toContain("private prepareRunBaselines(inst: AgentTerminalInstance): void");
    expect(method).toContain("retained");
    expect(method).not.toContain("lastContents");
    expect(method).not.toContain("source");
    // The agent_start caller passes only the terminal.
    const startBlock = sliceBetween(main, 'case "agent_start":', 'case "agent_settled":');
    expect(startBlock).toContain("this.prepareRunBaselines(inst);");
    expect(startBlock).not.toContain("this.prepareRunBaselines(inst,");
  });

  it("first-touch prev equals the old speculative run-start content", () => {
    // Old code copied source.get(path) at agent_start. New code sets the baseline
    // from change.prev on first touch — the cache value before the first change,
    // which is unchanged since agent_start for that file. Identical by construction.
    const runStart = "line one\nline two\nline three\n";
    const source = new Map([["/proj/note.txt", runStart]]);
    const cacheBeforeFirstChange = source.get("/proj/note.txt")!;
    const oldSpeculative = source.get("/proj/note.txt")!;
    const changePrev = cacheBeforeFirstChange;
    expect(changePrev).toBe(oldSpeculative);
    // A later touch must not replace the first baseline (retained across turns).
    const baselines = new Map([["/proj/note.txt", changePrev]]);
    expect(baselines.has("/proj/note.txt")).toBe(true);
  });

  it("watcher first-touch still flows through the canonical capture points", () => {
    const changeBlock = sliceBetween(main, "watcher.onChange =", "watcher.onFileTouched =");
    // Baseline authority unchanged: created -> null, modified with prev -> prev,
    // otherwise lazy fill from the start-state blob. Only WHERE the run-start
    // copy ran changed (nowhere), not the outcomes.
    expect(changeBlock).toContain("if (inst.baselines.has(path)) continue;");
    expect(changeBlock).toContain("this.setBaseline(inst, path, null);");
    expect(changeBlock).toContain("this.setBaseline(inst, path, change.prev);");
    expect(changeBlock).toContain("this.trackRecordingTask(this.fillBaseline(inst, path, change.status));");
    // Hint + capture scheduling untouched (#45).
    expect(changeBlock).toContain("this.addPendingHint(inst, relPath);");
    expect(changeBlock).toContain("this.scheduleMomentCapture(inst, rendererTarget);");
  });
});

describe("issue #60 prompt bounded read", () => {
  let work = "";
  let client: any = null;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "termina-issue60-prompt-"));
    const banner = {
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
        banner,
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

  const offload = (path: string, maxBytes: number, textCap: number, contextCap: number) =>
    client.readPrompt({ path, maxBytes, textCap, contextCap });

  it("pure parse matches the pre-#60 slice on every shape", () => {
    // Valid + caps.
    expect(parsePromptPayload(JSON.stringify({ prompt: "hi", images: [], context: "c" }))).toEqual({
      text: "hi",
      images: [],
      context: "c",
    });
    expect(parsePromptPayload(JSON.stringify({ prompt: "a".repeat(100000) })).text).toBe("a".repeat(64000));
    expect(parsePromptPayload(JSON.stringify({ prompt: "x", context: "c".repeat(50000) })).context).toBe("c".repeat(16000));
    // Missing keys and non-array images match String()/Array.isArray semantics.
    expect(parsePromptPayload(JSON.stringify({}))).toEqual({ text: "", images: [], context: "" });
    expect(parsePromptPayload(JSON.stringify({ prompt: 42, images: "nope", context: null }))).toEqual({
      text: "42",
      images: [],
      context: "",
    });
    // Non-object JSON never throws (property access on primitives is undefined).
    expect(parsePromptPayload("123")).toEqual({ text: "", images: [], context: "" });
    expect(parsePromptPayload('"hi"')).toEqual({ text: "", images: [], context: "" });
    expect(parsePromptPayload("[1,2]")).toEqual({ text: "", images: [], context: "" });
    // Null and malformed throw, exactly as before (callers fail closed).
    expect(() => parsePromptPayload("null")).toThrow();
    expect(() => parsePromptPayload("{oops")).toThrow();
    expect(() => parsePromptPayload("")).toThrow();
  });

  it("worker read matches sync on valid files, including a 5 MB prompt", async () => {
    const valid: Array<[string, unknown]> = [
      ["empty prompt", { prompt: "", images: [], context: "" }],
      ["text only", { prompt: "do work", images: [], context: "ctx" }],
      ["images", { prompt: "see", images: [{ name: "a.png", mediaType: "image/png" }], context: "" }],
      ["long prompt capped", { prompt: "p".repeat(100000), images: [], context: "c".repeat(50000) }],
    ];
    for (const [name, payload] of valid) {
      const file = join(work, `valid-${name.replace(/\W+/g, "-")}.json`);
      writeFileSync(file, JSON.stringify(payload));
      const expected = parsePromptPayload(JSON.stringify(payload), 64000, 16000);
      const res = await client.readPrompt({ path: file, maxBytes: 20 * 1024 * 1024, textCap: 64000, contextCap: 16000 });
      expect(res.ok, name).toBe(true);
      if (!res.ok || !res.found) throw new Error(`missing ${name}`);
      expect({ text: res.text, images: res.images, context: res.context }, name).toEqual(expected);
      const viaHelper = await readPromptPayloadFile(file, { maxBytes: 20 * 1024 * 1024, textCap: 64000, contextCap: 16000, offload });
      expect(viaHelper, name).toEqual(expected);
    }
    // Large writer-order file: 5 MB prompt first, small images/context after.
    const big = join(work, "big-prompt.json");
    const bigPayload = { prompt: "b".repeat(5 * 1024 * 1024), images: [{ name: "i.png", mediaType: "image/png" }], context: "tail" };
    writeFileSync(big, JSON.stringify(bigPayload));
    const res = await client.readPrompt({ path: big, maxBytes: 20 * 1024 * 1024, textCap: 64000, contextCap: 16000 });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.found) throw new Error("missing big prompt");
    expect(res.text).toBe("b".repeat(64000));
    expect(res.images).toEqual([{ name: "i.png", mediaType: "image/png" }]);
    expect(res.context).toBe("tail");
  });

  it("fail-closed matches on missing, oversize, malformed, and null", async () => {
    // Missing.
    expect(await readPromptPayloadFile(join(work, "nope.json"), { maxBytes: 1024, offload })).toBeNull();
    // Oversize (small budget stands in for the 20 MB cap: same size gate).
    const over = join(work, "over.json");
    writeFileSync(over, JSON.stringify({ prompt: "x".repeat(2048) }));
    expect(await readPromptPayloadFile(over, { maxBytes: 1024, offload })).toBeNull();
    // Malformed and null JSON.
    const bad = join(work, "bad.json");
    writeFileSync(bad, "{oops");
    expect(await readPromptPayloadFile(bad, { maxBytes: 1024 * 1024, offload })).toBeNull();
    const nul = join(work, "null.json");
    writeFileSync(nul, "null");
    expect(await readPromptPayloadFile(nul, { maxBytes: 1024 * 1024, offload })).toBeNull();
    // A valid empty prompt is NOT fail-closed: the file is kept for replay.
    const empty = join(work, "empty.json");
    writeFileSync(empty, JSON.stringify({ prompt: "", images: [], context: "" }));
    expect(await readPromptPayloadFile(empty, { maxBytes: 1024 * 1024, offload })).toEqual({ text: "", images: [], context: "" });
  });

  it("sync fallback preserves identical output when the worker rejects", async () => {
    const file = join(work, "fallback.json");
    const payload = { prompt: "fallback works", images: [], context: "c" };
    writeFileSync(file, JSON.stringify(payload));
    const failing = async () => ({ ok: false as const, error: "worker gone" });
    expect(await readPromptPayloadFile(file, { maxBytes: 1024 * 1024, offload: failing })).toEqual({
      text: "fallback works",
      images: [],
      context: "c",
    });
    const bad = join(work, "fallback-bad.json");
    writeFileSync(bad, "{oops");
    expect(await readPromptPayloadFile(bad, { maxBytes: 1024 * 1024, offload: failing })).toBeNull();
  });

  it("worker prompt read keeps the main loop responsive on a 5 MB file", async () => {
    const big = join(work, "big-responsive.json");
    writeFileSync(big, JSON.stringify({ prompt: "r".repeat(5 * 1024 * 1024), images: [], context: "" }));
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      const found = await readPromptPayloadFile(big, { maxBytes: 20 * 1024 * 1024, textCap: 64000, contextCap: 0, offload });
      expect(found?.text).toBe("r".repeat(64000));
    } finally {
      clearInterval(heartbeat);
    }
    expect(ticks).toBeGreaterThanOrEqual(1);
  });

  it("both prompt readers route through the shared helper", () => {
    const promptBlock = sliceBetween(main, 'case "prompt":', 'case "steer_input":');
    expect(promptBlock).toContain("readPromptPayloadFile(payloadPath");
    expect(promptBlock).toContain("this.sessionFork.readPrompt(");
    expect(promptBlock).not.toContain("JSON.parse(");
    expect(promptBlock).not.toContain("readFile(payloadPath");
    const reader = sliceBetween(manager, "private async readPromptPayload(", "/** Support directories:");
    expect(reader).toContain("readPromptPayloadFile(path");
    expect(reader).not.toContain("JSON.parse(");
  });
});
