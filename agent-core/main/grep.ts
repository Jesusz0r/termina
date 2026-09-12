/**
 * Grep tool: ripgrep fast path plus a bounded JS fallback over the file
 * walk, with hit grouping/paging for the model. Stateless between calls.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { relative, sep } from "node:path";
import { IGNORED_SEGMENTS } from "../../shared/gitignore.ts";
import { validateGrepPattern } from "../../shared/grep-pattern.ts";
import { GREP_NO_MATCHES_PREFIX } from "../stall.ts";
import {
  GREP_BYTE_CAP,
  BoundedTextAccumulator,
  boundedToolResult,
  logicalToolText,
  type CompletionState,
  type ToolTextResult,
} from "../tool-output.ts";
import { resolveTrustedBin } from "./env.ts";
import {
  GREP_BUDGET_MS,
  GREP_VISIT_CAP,
  collectFiles,
  confinePath,
  freezeCwd,
  matchGlob,
  posixRel,
  shellQuote,
  yieldEventLoop,
} from "./files.ts";

const GREP_HIT_CAP = 50;
const GREP_SHOW_PER_FILE = 8;
const GREP_SHOW_HITS = 20;
const GREP_SHOW_FILES = 8;
const GREP_SHOW_LINE_CHARS = 240;
const GREP_COLLECT_FILES = 40;
const GREP_LINE_CHARS = 8_192;
const GREP_ROW = /^(.+):(\d+):(.*)$/;

const GREP_LINE_BYTE_CAP = GREP_LINE_CHARS * 4;

function decodeGrepLine(value: Uint8Array): { text: string; truncated: boolean } {
  const bounded = new BoundedTextAccumulator({
    maxBytes: GREP_LINE_BYTE_CAP,
    direction: "head",
    // The surrounding grep result carries the actionable continuation.  A
    // marker on every clipped line would consume the page budget and obscure
    // the line number.
    marker: "",
  });
  bounded.push(value);
  const result = bounded.finish();
  return { text: result.text, truncated: result.truncated };
}

type LineScanResult = { state: CompletionState; truncated: boolean };

function forEachGrepLine(
  abs: string,
  fn: (lineNo: number, line: string) => boolean,
  shouldStop?: () => boolean,
  budgetMs = GREP_BUDGET_MS,
): LineScanResult {
  let fd: number | undefined;
  const started = Date.now();
  let truncated = false;
  const result = (state: CompletionState): LineScanResult => ({ state, truncated });
  try {
    fd = openSync(abs, "r");
    const chunk = Buffer.alloc(64 * 1024);
    let leftover = Buffer.alloc(0);
    let skipUntilNl = false;
    let lineNo = 1;
    let pos = 0;
    for (;;) {
      if (shouldStop?.()) return result("interrupted");
      if (budgetMs <= 0 || Date.now() - started >= budgetMs) return result("timeout");
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      let data = leftover.length > 0 ? Buffer.concat([leftover, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      leftover = Buffer.alloc(0);
      let start = 0;
      if (skipUntilNl) {
        const nl = data.indexOf(10);
        if (nl < 0) continue;
        skipUntilNl = false;
        start = nl + 1;
      }
      for (let i = start; i < data.length; i++) {
        if (data[i] !== 10) continue;
        let end = i;
        if (end > start && data[end - 1] === 13) end--;
        const raw = data.subarray(start, end);
        if (raw.length > GREP_LINE_BYTE_CAP) truncated = true;
        const line = decodeGrepLine(raw.subarray(0, GREP_LINE_BYTE_CAP));
        truncated ||= line.truncated;
        if (!fn(lineNo, line.text)) return result("complete");
        lineNo++;
        start = i + 1;
      }
      leftover = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
      if (leftover.length > GREP_LINE_BYTE_CAP) {
        truncated = true;
        const line = decodeGrepLine(leftover.subarray(0, GREP_LINE_BYTE_CAP));
        truncated ||= line.truncated;
        if (!fn(lineNo, line.text)) return result("complete");
        lineNo++;
        leftover = Buffer.alloc(0);
        skipUntilNl = true;
      }
    }
    if (!skipUntilNl && leftover.length > 0) {
      if (leftover.length > GREP_LINE_BYTE_CAP) truncated = true;
      const line = decodeGrepLine(leftover.subarray(0, GREP_LINE_BYTE_CAP));
      truncated ||= line.truncated;
      fn(lineNo, line.text);
    }
    return result("complete");
  } catch {
    return result("unreadable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseGrepRow(row: string): { file: string; line: number; text: string } | null {
  const m = GREP_ROW.exec(row.endsWith("\r") ? row.slice(0, -1) : row);
  if (!m) return null;
  const line = Number(m[2]);
  if (!Number.isInteger(line) || line < 1) return null;
  return { file: m[1]!, line, text: m[3]! };
}

function cmpUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function clipGrepText(text: string): string {
  if (text.length <= GREP_SHOW_LINE_CHARS) return text;
  return `${text.slice(0, GREP_SHOW_LINE_CHARS)}...`;
}

function countLabel(count: number, capped: boolean): string {
  return capped ? `${GREP_HIT_CAP}+` : String(count);
}

/** Drop a trailing incomplete line when ripgrep stdout hit the byte cap. */
export function completeGrepStdout(text: string, truncated: boolean): string {
  if (!truncated) return text.replace(/\n+$/, "");
  const cut = text.endsWith("\n") ? text : text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  return cut.replace(/\n+$/, "");
}

/** Ripgrep's per-file --max-count cannot distinguish exactly-cap hits from a
 * file with additional matches, so reaching the cap is always an incomplete
 * result and must carry a continuation. */
function grepHitCapReached(raw: string): boolean {
  const counts = new Map<string, number>();
  for (const row of raw.split("\n")) {
    const hit = parseGrepRow(row);
    if (!hit) continue;
    const count = (counts.get(hit.file) ?? 0) + 1;
    counts.set(hit.file, count);
    if (count >= GREP_HIT_CAP) return true;
  }
  return false;
}

/** Group hits by file, put sparse files first, and cap the page the model sees. */
export function formatGrepHits(raw: string): string {
  if (!raw) return raw;

  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const row of raw.split("\n")) {
    if (!row) continue;
    const hit = parseGrepRow(row);
    if (!hit) continue;
    const list = byFile.get(hit.file);
    if (list) list.push({ line: hit.line, text: hit.text });
    else byFile.set(hit.file, [{ line: hit.line, text: hit.text }]);
  }
  if (byFile.size === 0) return raw;

  const files = [...byFile.entries()].sort((a, b) => {
    if (a[1].length !== b[1].length) return a[1].length - b[1].length;
    return cmpUtf8(a[0], b[0]);
  });

  let total = 0;
  let totalCapped = false;
  for (const [, hits] of files) {
    total += hits.length;
    if (hits.length >= GREP_HIT_CAP) totalCapped = true;
  }

  const body: string[] = [];
  let shownHits = 0;
  let shownFiles = 0;
  const partials: Array<{ file: string; left: number }> = [];
  const omitted: Array<{ file: string; count: number; capped: boolean }> = [];

  for (const [file, hits] of files) {
    const capped = hits.length >= GREP_HIT_CAP;
    const label = countLabel(hits.length, capped);
    if (shownFiles >= GREP_SHOW_FILES || shownHits >= GREP_SHOW_HITS) {
      omitted.push({ file, count: hits.length, capped });
      continue;
    }
    const take = Math.min(GREP_SHOW_PER_FILE, hits.length, GREP_SHOW_HITS - shownHits);
    if (take <= 0) {
      omitted.push({ file, count: hits.length, capped });
      continue;
    }
    const left = hits.length - take;
    if (left > 0) {
      body.push(`${file} (${label} hits, showing ${take})`);
      partials.push({ file, left });
    } else {
      body.push(`${file} (${label} ${hits.length === 1 && !capped ? "hit" : "hits"})`);
    }
    for (let i = 0; i < take; i++) {
      const h = hits[i]!;
      body.push(`  ${h.line}:${clipGrepText(h.text)}`);
    }
    shownHits += take;
    shownFiles += 1;
  }

  const hitWord = total === 1 && !totalCapped ? "hit" : "hits";
  const fileWord = files.length === 1 ? "file" : "files";
  const out = [
    `${total}${totalCapped ? "+" : ""} ${hitWord} in ${files.length} ${fileWord}, showing ${shownHits}`,
    ...body,
  ];
  const footer = grepContinueFooter(partials, omitted);
  if (footer) out.push(footer);
  return out.join("\n");
}

function grepContinueFooter(
  partials: Array<{ file: string; left: number }>,
  omitted: Array<{ file: string; count: number; capped: boolean }>,
): string | undefined {
  if (partials.length === 0 && omitted.length === 0) return undefined;

  let bestFile = "";
  let bestScore = -1;
  for (const p of partials) {
    if (p.left > bestScore) {
      bestScore = p.left;
      bestFile = p.file;
    }
  }
  for (const o of omitted) {
    if (o.count > bestScore) {
      bestScore = o.count;
      bestFile = o.file;
    }
  }

  const parts: string[] = [];
  if (partials.length > 0) {
    let dense = partials[0]!;
    for (const p of partials) {
      if (p.left > dense.left) dense = p;
    }
    parts.push(`${dense.left} more in ${dense.file}`);
  }
  if (omitted.length > 0) {
    let largest = omitted[0]!;
    for (const item of omitted) {
      if (item.count > largest.count) largest = item;
    }
    if (bestFile === largest.file) {
      parts.push(
        `${omitted.length} more files (largest: ${largest.file} ${countLabel(largest.count, largest.capped)} hits)`,
      );
    } else {
      parts.push(`${omitted.length} more files`);
    }
  }
  parts.push(`Grep again with path=${JSON.stringify(bestFile)} or a tighter glob.`);
  return parts.join(". ");
}

function grepRipgrep(
  rg: string,
  root: string,
  searchAbs: string,
  pattern: string,
  glob: string | undefined,
  opts: { shouldStop?: () => boolean; budgetMs?: number },
): Promise<ToolTextResult> {
  const budgetMs = opts.budgetMs ?? GREP_BUDGET_MS;
  const repro = `grep ${shellQuote(pattern)}${glob ? ` --glob ${shellQuote(glob)}` : ""}`;
  const continuation = `Grep again with path=${JSON.stringify(searchAbs === root ? "." : posixRel(root, searchAbs))}${glob ? ` or a tighter glob than ${JSON.stringify(glob)}` : " or a tighter glob"}.`;
  let stopCallbackFailed = false;
  const shouldStop = (): boolean => {
    try {
      return opts.shouldStop?.() === true;
    } catch {
      stopCallbackFailed = true;
      return true;
    }
  };
  if (budgetMs <= 0) {
    return Promise.resolve(boundedToolResult("(grep timed out after 0 files)", {
      maxBytes: GREP_BYTE_CAP,
      marker: continuation,
      state: "timeout",
      isError: true,
    }));
  }
  const relSearch = searchAbs === root ? "." : posixRel(root, searchAbs);
  const args = [
    "--color=never",
    "-n",
    "--no-heading",
    "--with-filename",
    "--hidden",
    "--no-require-git",
    `--max-count=${GREP_HIT_CAP}`,
  ];
  for (const name of IGNORED_SEGMENTS) args.push("-g", `!**/${name}`, "-g", `!**/${name}/**`);
  if (glob) args.push("-g", glob);
  args.push("--", pattern, relSearch);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(rg, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve(boundedToolResult(`error: ${(err as Error).message}`, {
        maxBytes: GREP_BYTE_CAP,
        marker: "",
        state: "failed",
        isError: true,
      }));
      return;
    }
    const stdout = new BoundedTextAccumulator({ maxBytes: GREP_BYTE_CAP, direction: "head", marker: "" });
    const stderr = new BoundedTextAccumulator({ maxBytes: 8 * 1024, direction: "head", marker: "" });
    let stdoutSeen = 0;
    let outputTruncated = false;
    let killedForOutput = false;
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutSeen += chunk.byteLength;
      if (stdoutSeen > GREP_BYTE_CAP) {
        outputTruncated = true;
        killedForOutput = true;
        kill();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    let settled = false;
    let timedOut = false;
    let interruptedByUser = false;
    let spawnFailed = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      const stdoutResult = stdout.finish();
      const stderrResult = stderr.finish();
      const stderrTruncated = stderrResult.truncated;
      const text = completeGrepStdout(stdoutResult.text, outputTruncated || stdoutResult.truncated);
      const hitCap = grepHitCapReached(text);
      let state: CompletionState = "complete";
      let isError = false;
      let body = "";
      if (timedOut) {
        state = "timeout";
        isError = true;
        body = text ? `${formatGrepHits(text)}\n(grep timed out)` : "(grep timed out)";
      } else if (stopCallbackFailed) {
        state = "failed";
        isError = true;
        body = text ? `${formatGrepHits(text)}\n(grep stop callback failed)` : "error: grep stop callback failed";
      } else if (interruptedByUser) {
        state = "interrupted";
        isError = true;
        body = text ? `${formatGrepHits(text)}\n(grep interrupted)` : "(grep interrupted)";
      } else if (spawnFailed) {
        state = "failed";
        isError = true;
        body = `error: ${stderrResult.text || "could not start ripgrep"}`;
      } else if (killedForOutput) {
        // The process was stopped only because its display stream reached the
        // output cap; this is a complete search with an intentionally clipped
        // page, not a provider/tool failure.
        state = "complete";
        body = text
          ? `${formatGrepHits(text)}\n(more matching files not listed)`
          : "(output clipped before results arrived)";
      } else if (code === 2) {
        // ripgrep exit codes are a stable documented contract: 0 = match,
        // 1 = no match, 2 = error. Keep partial hits like the timeout and
        // interrupt branches do so the model keeps whatever matched.
        state = "failed";
        isError = true;
        const err = stderrResult.text.trim().slice(0, 300);
        const note = err ? `error: ${err}` : "error: invalid regular expression";
        body = text ? `${formatGrepHits(text)}\n${note}` : note;
      } else if (!text) {
        body = GREP_NO_MATCHES_PREFIX;
      } else {
        const formatted = formatGrepHits(text);
        body = outputTruncated || hitCap
          ? `${formatted}\n(more matching files not listed)`
          : formatted;
      }
      const marker = state === "complete" && !outputTruncated && !stderrTruncated && !hitCap ? "" : continuation;
      const result = logicalToolText(body, {
        maxBytes: GREP_BYTE_CAP,
        state,
        isError,
        forceMarker: Boolean(marker),
        marker,
        continuation: marker || null,
        repro,
      });
      resolve(Object.freeze({
        ...result,
        repro,
        stdout: stdoutResult,
        stderr: stderrResult,
      }));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, budgetMs);
    const poll = setInterval(() => {
      if (shouldStop()) {
        interruptedByUser = true;
        kill();
      }
    }, 50);
    if (shouldStop()) {
      interruptedByUser = true;
      kill();
    }
    child.on("error", () => {
      spawnFailed = true;
      if (!settled) finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

export async function grepFiles(
  cwd: string,
  input: { pattern?: string; path?: string; glob?: string },
  opts?: { shouldStop?: () => boolean; budgetMs?: number; jsOnly?: boolean },
): Promise<ToolTextResult> {
  const pattern = input.pattern ?? "";
  const repro = `grep ${shellQuote(pattern)}${input.glob ? ` --glob ${shellQuote(input.glob)}` : ""}`;
  const continuation = `Grep again with path=${JSON.stringify(input.path ?? ".")}${input.glob ? ` or a tighter glob than ${JSON.stringify(input.glob)}` : " or a tighter glob"}.`;
  let stopCallbackFailed = false;
  const shouldStop = (): boolean => {
    try {
      return opts?.shouldStop?.() === true;
    } catch {
      stopCallbackFailed = true;
      return true;
    }
  };
  const fail = (content: string): ToolTextResult => Object.freeze({
    ...boundedToolResult(content, { maxBytes: GREP_BYTE_CAP, marker: "", state: "failed", isError: true }),
    continuation: null,
    repro,
  });
  const unsafe = validateGrepPattern(pattern);
  const root = freezeCwd(cwd);
  const confined = confinePath(cwd, input.path ?? ".", { mustExist: true });
  if (!confined.ok) return fail(confined.error);
  if (input.glob) {
    if (input.glob.length < 1 || input.glob.length > 256) return fail("error: glob pattern length must be 1–256");
    if (/[\[\]{}]/.test(input.glob)) return fail("error: glob only supports * ** ?");
  }
  if (!opts?.jsOnly) {
    const rg = resolveTrustedBin("rg", root);
    if (rg) {
      if (pattern.length < 1 || pattern.length > 256) return fail(unsafe ?? "error: pattern length must be 1–256");
      return grepRipgrep(rg, root, confined.abs, pattern, input.glob, { ...opts, shouldStop });
    }
  }
  if (unsafe) return fail(unsafe);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return fail("error: invalid regular expression");
  }
  const budgetMs = opts?.budgetMs ?? GREP_BUDGET_MS;
  const started = Date.now();
  const collected = await collectFiles(confined.abs, root, GREP_VISIT_CAP, {
    shouldStop,
    budgetMs,
  });
  const hits: string[] = [];
  let filesWithHits = 0;
  let scanned = 0;
  let state: CompletionState = collected.state;
  let fileCap = false;
  let hitCap = false;
  let lineTruncated = false;
  for (const abs of collected.files) {
    if (shouldStop()) {
      state = stopCallbackFailed ? "failed" : "interrupted";
      break;
    }
    if (Date.now() - started >= budgetMs) {
      state = "timeout";
      break;
    }
    scanned++;
    if (scanned % 25 === 0) await yieldEventLoop();
    const rel = relative(root, abs).split(sep).join("/");
    if (input.glob && !matchGlob(input.glob, rel)) continue;
    if (filesWithHits >= GREP_COLLECT_FILES) {
      fileCap = true;
      break;
    }
    let fileHits = 0;
    const lineState = forEachGrepLine(
      abs,
      (lineNo, line) => {
        if (Date.now() - started >= budgetMs) {
          return false;
        }
        if (!regex.test(line)) return true;
        fileHits++;
        if (fileHits <= GREP_HIT_CAP) hits.push(`${rel}:${lineNo}:${line}`);
        return fileHits < GREP_HIT_CAP;
      },
      shouldStop,
      Math.max(1, budgetMs - (Date.now() - started)),
    );
    if (fileHits > 0) filesWithHits++;
    if (fileHits >= GREP_HIT_CAP) hitCap = true;
    lineTruncated ||= lineState.truncated;
    if (lineState.state === "interrupted" || shouldStop()) {
      state = stopCallbackFailed ? "failed" : "interrupted";
      break;
    }
    if (lineState.state === "timeout") {
      state = "timeout";
      break;
    }
    if (Date.now() - started >= budgetMs && lineState.state === "complete") {
      state = "timeout";
      break;
    }
    if (lineState.state === "unreadable" && state === "complete") state = "unreadable";
  }
  const stateError = state !== "complete";
  if (hits.length === 0) {
    const stateDesc = state === "timeout" ? "timed out" : state;
    const body = state === "complete"
      ? lineTruncated ? "(no matches in retained line prefixes; some lines were truncated)" : GREP_NO_MATCHES_PREFIX
      : `(grep ${stateDesc} after ${scanned} files)`;
    const needsContinuation = stateError || lineTruncated;
    const result = logicalToolText(body, {
      maxBytes: GREP_BYTE_CAP,
      state,
      isError: stateError,
      forceMarker: needsContinuation,
      marker: needsContinuation ? continuation : "",
      continuation: needsContinuation ? continuation : null,
      repro,
    });
    return result;
  }
  const formatted = formatGrepHits(hits.join("\n"));
  const extra: string[] = [];
  if (fileCap) extra.push("(more matching files not listed. Grep again with path or glob.)");
  if (hitCap) extra.push("(grep hit cap; more matching lines may be omitted)");
  if (state !== "complete") extra.push(`(grep ${state === "timeout" ? "timed out" : state} after ${scanned} files)`);
  if (lineTruncated) extra.push("(some matching lines were truncated)");
  const body = extra.length > 0 ? `${formatted}\n${extra.join("\n")}` : formatted;
  const needsContinuation = stateError || fileCap || hitCap || lineTruncated;
  const result = logicalToolText(body, {
    maxBytes: GREP_BYTE_CAP,
    state,
    isError: stateError,
    forceMarker: needsContinuation,
    marker: needsContinuation ? continuation : "",
    continuation: needsContinuation ? continuation : null,
    repro,
  });
  return result;
}
