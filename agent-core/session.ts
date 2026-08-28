/**
 * Segmented append-only agent-core session bundle.
 *
 * Layout:
 *   <project-session-dir>/<session-id>/
 *     current/{part-NNNNNN.jsonl, session.jsonl, images}
 *     archive-<stamp>/
 *     bad-<stamp>/
 *
 * sessionFile is the stable address of the active JSONL segment:
 *   .../<session-id>/current/session.jsonl
 *
 * Worldlines and Session Search call these helpers. They do not read or
 * copy core session JSONL themselves.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const MAX_SESSION_SEGMENT_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_RECORD_BYTES = 1 * 1024 * 1024;

const CORE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PART_NAME = /^part-([0-9]{6})\.jsonl$/;
const ARCHIVE_PREFIX = "archive-";
const BAD_PREFIX = "bad-";
const ACTIVE_NAME = "session.jsonl";
const CURRENT_DIR = "current";
const STORED_IMAGE_NAME = /^[A-Za-z0-9._-]+-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/;
const READ_CHUNK = 64 * 1024;
const YIELD_EVERY_BYTES = 256 * 1024;
const YIELD_EVERY_RECORDS = 64;

export type SessionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export type ReplayContent = string | Array<Record<string, unknown>>;

export type ReplayMessage = {
  role: "user" | "assistant";
  content: ReplayContent;
  sseq: number;
};

export type ReplayState = {
  messages: ReplayMessage[];
  bySeq: Map<number, ReplayMessage>;
  lastSeq: number;
  maxSeq: number;
};

export type LogicalSessionEntry = {
  path: string;
  name: string;
  mtimeMs: number;
  kind: "current" | "archive";
  sessionId: string;
  segments: string[];
};

export type SessionBundlePaths = {
  sessionFile: string;
  currentDir: string;
  bundleDir: string;
  projectDir: string;
  sessionId: string;
};

/** Session ids that are safe as a single path segment. */
export function isCoreSessionId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && CORE_SESSION_ID.test(value);
}

/** Filesystem-safe stamp for archive and quarantine directory names. */
export function sessionRotateStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function formatStub(opts: { chars: number; tool: string; sseq: number; repro?: string }): string {
  const repro = opts.repro ? ` — reproduce: ${opts.repro}` : "";
  return `[cleared: ${opts.chars} chars of ${opts.tool} — storageSeq ${opts.sseq}${repro}]`;
}

export function coreSessionFile(projectDir: string, sessionId: string): string {
  return join(projectDir, sessionId, CURRENT_DIR, ACTIVE_NAME);
}

/**
 * Derive the active segment path from a project directory and session id.
 * Ignore an old flat roster path. Accept a valid bundle path only when it
 * matches this session id.
 */
export function resolveSessionFile(projectDir: string, sessionId: string, override?: string): string | null {
  if (!isCoreSessionId(sessionId)) return null;
  const explicit = override?.trim() || "";
  if (explicit) {
    const parsed = parseSessionBundlePath(explicit);
    if (parsed && parsed.sessionId === sessionId) return parsed.sessionFile;
  }
  const root = projectDir.trim();
  if (!root) return null;
  return coreSessionFile(root, sessionId);
}

/** True when path is .../<session-id>/current/session.jsonl. */
export function isCoreSessionBundleFile(path: string): boolean {
  return parseSessionBundlePath(path) !== null;
}

export function parseSessionBundlePath(sessionFile: string): SessionBundlePaths | null {
  if (!sessionFile || basename(sessionFile) !== ACTIVE_NAME) return null;
  const currentDir = dirname(sessionFile);
  if (basename(currentDir) !== CURRENT_DIR) return null;
  const bundleDir = dirname(currentDir);
  const sessionId = basename(bundleDir);
  if (!isCoreSessionId(sessionId)) return null;
  return {
    sessionFile,
    currentDir,
    bundleDir,
    projectDir: dirname(bundleDir),
    sessionId,
  };
}

function partNumber(name: string): number | null {
  const m = PART_NAME.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function partFileName(n: number): string {
  return `part-${String(n).padStart(6, "0")}.jsonl`;
}

function isSafeImageName(name: string): boolean {
  if (!STORED_IMAGE_NAME.test(name)) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name.includes("..")) return false;
  return true;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function inspectEntry(path: string): { kind: "file" | "dir" | "symlink" | "other"; size: number } | null {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return { kind: "symlink", size: info.size };
    if (info.isFile()) return { kind: "file", size: info.size };
    if (info.isDirectory()) return { kind: "dir", size: info.size };
    return { kind: "other", size: info.size };
  } catch {
    return null;
  }
}

type CurrentListing = {
  parts: Array<{ n: number; path: string; size: number }>;
  active: { path: string; size: number } | null;
  images: string[];
};

export function listCurrentSegments(currentDir: string): SessionResult<CurrentListing> {
  const current = inspectEntry(currentDir);
  if (!current) return { ok: false, error: "current directory is missing" };
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  let names: string[];
  try {
    names = readdirSync(currentDir);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  const parts: CurrentListing["parts"] = [];
  const seen = new Set<number>();
  let active: CurrentListing["active"] = null;
  const images: string[] = [];
  for (const name of names) {
    const path = join(currentDir, name);
    const info = inspectEntry(path);
    if (!info) continue;
    if (name.endsWith(".jsonl")) {
      if (info.kind === "symlink") return { ok: false, error: `jsonl is a symlink: ${name}` };
      if (info.kind !== "file") return { ok: false, error: `jsonl is not a file: ${name}` };
      if (name === ACTIVE_NAME) {
        active = { path, size: info.size };
        continue;
      }
      const n = partNumber(name);
      if (n === null) return { ok: false, error: `unexpected jsonl name: ${name}` };
      if (seen.has(n)) return { ok: false, error: `duplicate part number: ${name}` };
      seen.add(n);
      parts.push({ n, path, size: info.size });
      continue;
    }
    if (info.kind === "file" && isSafeImageName(name)) images.push(name);
  }
  parts.sort((a, b) => a.n - b.n);
  return { ok: true, parts, active, images };
}

function currentHasContent(listing: CurrentListing): boolean {
  if (listing.images.length > 0) return true;
  if (listing.active && listing.active.size > 0) return true;
  return listing.parts.some((p) => p.size > 0);
}

export function sessionBundleExists(sessionFile: string): boolean {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return false;
  const info = inspectEntry(parsed.currentDir);
  return info !== null && info.kind === "dir";
}

export function sessionBundleHasContent(sessionFile: string): boolean {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return false;
  const listing = listCurrentSegments(parsed.currentDir);
  if (!listing.ok) return false;
  return currentHasContent(listing);
}

function uniqueSiblingDir(parent: string, prefix: string, stamp: string): string {
  let dest = join(parent, `${prefix}${stamp}`);
  let n = 0;
  while (existsSync(dest)) {
    n += 1;
    dest = join(parent, `${prefix}${stamp}-${n}`);
  }
  return dest;
}

function renameCurrentUnique(currentDir: string, prefix: string, now = Date.now()): SessionResult<{ aside: string }> {
  const parent = dirname(currentDir);
  const stamp = sessionRotateStamp(now);
  let dest = uniqueSiblingDir(parent, prefix, stamp);
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } catch {
    /* rename still tries */
  }
  for (;;) {
    try {
      renameSync(currentDir, dest);
      return { ok: true, aside: dest };
    } catch (err) {
      if (existsSync(dest)) {
        dest = uniqueSiblingDir(parent, prefix, stamp);
        continue;
      }
      return { ok: false, error: errMsg(err) };
    }
  }
}

function createCurrentDir(currentDir: string, sessionFile: string): SessionResult<Record<string, never>> {
  try {
    mkdirSync(dirname(currentDir), { recursive: true, mode: 0o700 });
    mkdirSync(currentDir, { recursive: true, mode: 0o700 });
    const fd = openSync(sessionFile, "wx", 0o600);
    closeSync(fd);
    return { ok: true };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code === "EEXIST") {
      const info = inspectEntry(sessionFile);
      if (info && info.kind === "file") return { ok: true };
      if (!info) {
        try {
          const fd = openSync(sessionFile, "wx", 0o600);
          closeSync(fd);
          return { ok: true };
        } catch (inner) {
          return { ok: false, error: errMsg(inner) };
        }
      }
    }
    return { ok: false, error: errMsg(err) };
  }
}

function recoverActiveSegment(currentDir: string, sessionFile: string): SessionResult<CurrentListing> {
  const listing = listCurrentSegments(currentDir);
  if (!listing.ok) return listing;
  if (listing.active) return listing;
  const created = createCurrentDir(currentDir, sessionFile);
  if (!created.ok) return created;
  const again = listCurrentSegments(currentDir);
  if (!again.ok) return again;
  if (!again.active) return { ok: false, error: "could not create the active segment" };
  return again;
}

export function ensureSessionBundle(sessionFile: string): SessionResult<SessionBundlePaths> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const current = inspectEntry(parsed.currentDir);
  if (!current) {
    const created = createCurrentDir(parsed.currentDir, parsed.sessionFile);
    if (!created.ok) return created;
    return { ok: true, ...parsed };
  }
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  const recovered = recoverActiveSegment(parsed.currentDir, parsed.sessionFile);
  if (!recovered.ok) return recovered;
  return { ok: true, ...parsed };
}

export function prepareFreshSession(sessionFile: string, now = Date.now()): SessionResult<{ archived: string | null }> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const current = inspectEntry(parsed.currentDir);
  if (!current) {
    const created = createCurrentDir(parsed.currentDir, parsed.sessionFile);
    if (!created.ok) return created;
    return { ok: true, archived: null };
  }
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  const listing = listCurrentSegments(parsed.currentDir);
  if (!listing.ok) return listing;
  if (!currentHasContent(listing)) {
    if (!listing.active) {
      const created = createCurrentDir(parsed.currentDir, parsed.sessionFile);
      if (!created.ok) return created;
    }
    return { ok: true, archived: null };
  }
  const rotated = renameCurrentUnique(parsed.currentDir, ARCHIVE_PREFIX, now);
  if (!rotated.ok) return rotated;
  const created = createCurrentDir(parsed.currentDir, parsed.sessionFile);
  if (!created.ok) return created;
  return { ok: true, archived: rotated.aside };
}

export function clearSessionBundle(sessionFile: string, now = Date.now()): SessionResult<{ archived: string | null }> {
  return prepareFreshSession(sessionFile, now);
}

export function quarantineSessionBundle(sessionFile: string, now = Date.now()): SessionResult<{ aside: string }> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const current = inspectEntry(parsed.currentDir);
  if (!current) return { ok: false, error: "current directory is missing" };
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  return renameCurrentUnique(parsed.currentDir, BAD_PREFIX, now);
}

export function removeSessionBundle(sessionFile: string): SessionResult<Record<string, never>> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  try {
    rmSync(parsed.bundleDir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

export async function listLogicalSessions(projectDir: string): Promise<LogicalSessionEntry[]> {
  let names: string[];
  try {
    names = await readdir(projectDir);
  } catch {
    return [];
  }
  const out: LogicalSessionEntry[] = [];
  for (const name of names) {
    if (!isCoreSessionId(name)) continue;
    const bundleDir = join(projectDir, name);
    const info = inspectEntry(bundleDir);
    if (!info || info.kind !== "dir") continue;
    let children: string[];
    try {
      children = await readdir(bundleDir);
    } catch {
      continue;
    }
    for (const child of children) {
      if (child !== CURRENT_DIR && !child.startsWith(ARCHIVE_PREFIX)) continue;
      const dir = join(bundleDir, child);
      const dirInfo = inspectEntry(dir);
      if (!dirInfo || dirInfo.kind !== "dir") continue;
      const listing = listCurrentSegments(dir);
      if (!listing.ok) continue;
      const segments: string[] = listing.parts.map((p) => p.path);
      if (listing.active) segments.push(listing.active.path);
      let mtimeMs = 0;
      for (const path of segments) {
        try {
          const st = await stat(path);
          if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
        } catch {
          /* skip one segment */
        }
      }
      if (mtimeMs === 0) {
        try {
          const st = await stat(dir);
          mtimeMs = st.mtimeMs;
        } catch {
          continue;
        }
      }
      const sessionFile = join(dir, ACTIVE_NAME);
      out.push({
        path: sessionFile,
        name: child === CURRENT_DIR ? `${name}/${CURRENT_DIR}/${ACTIVE_NAME}` : `${name}/${child}/${ACTIVE_NAME}`,
        mtimeMs,
        kind: child === CURRENT_DIR ? "current" : "archive",
        sessionId: name,
        segments,
      });
    }
    await yieldToEventLoop();
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function isReplayContent(content: unknown): content is ReplayContent {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.every((block) => {
    return Boolean(block) && typeof block === "object" && !Array.isArray(block) && typeof (block as { type?: unknown }).type === "string";
  });
}

function isThinkingBlock(b: { type?: string }): boolean {
  return b.type === "thinking" || b.type === "redacted_thinking";
}

function blockChars(b: Record<string, unknown>): number {
  if (typeof b.chars === "number") return b.chars;
  if (b.type === "text") return String(b.text ?? "").length;
  if (b.type === "tool_result") return String(b.content ?? "").length;
  if (b.type === "tool_use") return JSON.stringify(b.input ?? {}).length;
  if (b.type === "thinking" || b.type === "redacted_thinking") {
    return String(b.thinking ?? JSON.stringify(b)).length;
  }
  if (b.type === "image") return 8_000;
  return 0;
}

function dropIndexedMessage(state: ReplayState, message: ReplayMessage): void {
  state.bySeq.delete(message.sseq);
}

export function createReplayState(): ReplayState {
  return { messages: [], bySeq: new Map(), lastSeq: 0, maxSeq: 0 };
}

export function applySessionRecord(state: ReplayState, rec: unknown): SessionResult<Record<string, never>> {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { ok: false, error: "malformed session record" };
  const e = rec as {
    storageSeq?: unknown;
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
    kind?: unknown;
    targets?: unknown;
    dropped?: unknown;
    evicted?: unknown;
    summarySseq?: unknown;
  };
  if (typeof e.storageSeq !== "number" || !Number.isInteger(e.storageSeq) || e.storageSeq < 1) {
    return { ok: false, error: "invalid storageSeq" };
  }
  if (e.storageSeq <= state.lastSeq) {
    return { ok: false, error: e.storageSeq === state.lastSeq ? "duplicate storageSeq" : "decreasing storageSeq" };
  }
  state.lastSeq = e.storageSeq;
  state.maxSeq = e.storageSeq;
  if (e.type === "checkpoint") return { ok: true };
  if (e.type === "message") {
    const role = e.message?.role;
    if (role !== "user" && role !== "assistant") return { ok: false, error: "invalid message role" };
    if (!e.message || !isReplayContent(e.message.content)) return { ok: false, error: "invalid message content" };
    const m: ReplayMessage = { role, content: e.message.content, sseq: e.storageSeq };
    state.messages.push(m);
    state.bySeq.set(m.sseq, m);
    return { ok: true };
  }
  if (e.type === "revision" && e.kind === "prune" && Array.isArray(e.targets)) {
    const ordered = e.targets.slice().sort((a, b) => {
      const as = (a as { sseq?: number })?.sseq ?? 0;
      const bs = (b as { sseq?: number })?.sseq ?? 0;
      if (as !== bs) return as - bs;
      return ((b as { blockIndex?: number })?.blockIndex ?? 0) - ((a as { blockIndex?: number })?.blockIndex ?? 0);
    });
    for (const raw of ordered) {
      const t = raw as { sseq?: unknown; blockIndex?: unknown; action?: unknown };
      if (!t || !Number.isInteger(t.sseq) || (t.sseq as number) < 1 || !Number.isInteger(t.blockIndex) || (t.blockIndex as number) < 0) {
        return { ok: false, error: "invalid prune target" };
      }
      const m = state.bySeq.get(t.sseq as number);
      if (!m || typeof m.content === "string") continue;
      const action = t.action === "drop" ? "drop" : "stub";
      if (action === "drop") {
        const b = m.content[t.blockIndex as number] as Record<string, unknown> | undefined;
        if (!b || !isThinkingBlock(b)) continue;
        if (m.content.filter((x) => !isThinkingBlock(x as { type?: string })).length === 0) continue;
        m.content.splice(t.blockIndex as number, 1);
        continue;
      }
      const b = m.content[t.blockIndex as number] as Record<string, unknown> | undefined;
      if (!b || b.type !== "tool_result" || b.stubbed) continue;
      const stub = formatStub({
        chars: blockChars(b),
        tool: String(b.tool ?? "tool"),
        sseq: m.sseq,
        repro: typeof b.repro === "string" ? b.repro : undefined,
      });
      b.content = stub;
      b.stubbed = true;
    }
    return { ok: true };
  }
  if (e.type === "revision" && e.kind === "truncate" && typeof e.dropped === "number") {
    if (!Number.isInteger(e.dropped) || e.dropped < 0 || e.dropped > state.messages.length) {
      return { ok: false, error: "invalid truncate revision" };
    }
    const removed = state.messages.splice(0, e.dropped);
    for (const m of removed) dropIndexedMessage(state, m);
    return { ok: true };
  }
  if (e.type === "revision" && e.kind === "summarize") {
    if (typeof e.summarySseq !== "number" || !Number.isInteger(e.summarySseq) || e.summarySseq < 1) {
      return { ok: false, error: "invalid summarize revision" };
    }
    if (typeof e.evicted !== "number" || !Number.isInteger(e.evicted) || e.evicted < 0) {
      return { ok: false, error: "invalid summarize revision" };
    }
    const idx = state.messages.findIndex((m) => m.sseq === e.summarySseq);
    if (idx < 0) return { ok: false, error: "summarize handoff missing" };
    if (idx < e.evicted) return { ok: false, error: "summarize handoff inside evicted span" };
    const handoff = state.messages.splice(idx, 1)[0]!;
    const removed = state.messages.splice(0, e.evicted);
    for (const m of removed) dropIndexedMessage(state, m);
    state.messages.unshift(handoff);
    return { ok: true };
  }
  return { ok: false, error: "unknown session record type" };
}

type FramedRecord =
  | { ok: true; rec: unknown; bytes: number }
  | { ok: true; skip: true; bytes: number }
  | { ok: false; error: string };

function takeFramedLine(
  pending: Buffer,
  atEnd: boolean,
  allowTruncatedTail: boolean,
): { line: Buffer | null; rest: Buffer; done?: FramedRecord } {
  const nl = pending.indexOf(0x0a);
  if (nl < 0) {
    if (pending.length > MAX_SESSION_RECORD_BYTES) {
      return { line: null, rest: pending, done: { ok: false, error: "oversized session record" } };
    }
    if (atEnd) {
      if (pending.length === 0) return { line: null, rest: pending };
      const parsed = parseFramedLine(pending);
      if (parsed.ok && !("skip" in parsed && parsed.skip)) {
        return { line: null, rest: Buffer.alloc(0), done: parsed };
      }
      if (allowTruncatedTail) return { line: null, rest: Buffer.alloc(0), done: { ok: true, skip: true, bytes: pending.length } };
      return { line: null, rest: pending, done: { ok: false, error: "truncated session record" } };
    }
    return { line: null, rest: pending };
  }
  if (nl + 1 > MAX_SESSION_RECORD_BYTES) {
    return { line: null, rest: pending, done: { ok: false, error: "oversized session record" } };
  }
  const line = pending.subarray(0, nl + 1);
  const rest = pending.subarray(nl + 1);
  return { line, rest };
}

function parseFramedLine(line: Buffer): FramedRecord {
  const text = line.toString("utf8");
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.trim() === "") return { ok: true, skip: true, bytes: line.length };
  try {
    return { ok: true, rec: JSON.parse(body) as unknown, bytes: line.length };
  } catch {
    return { ok: false, error: "malformed session record" };
  }
}

async function readSegmentIntoState(
  path: string,
  state: ReplayState,
  allowTruncatedTail: boolean,
  throughSeq?: number,
): Promise<SessionResult<{ bytes: number; records: number; stop: boolean }>> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  let pending = Buffer.alloc(0);
  const chunk = Buffer.alloc(READ_CHUNK);
  let bytes = 0;
  let records = 0;
  let sinceYieldBytes = 0;
  let sinceYieldRecords = 0;
  let stop = false;
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      const atEnd = n === 0;
      if (n > 0) pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      for (;;) {
        const nl = pending.indexOf(0x0a);
        const taken = takeFramedLine(pending, atEnd && nl < 0, allowTruncatedTail);
        pending = taken.rest;
        const parsed = taken.done ?? (taken.line ? parseFramedLine(taken.line) : null);
        if (taken.done && !taken.done.ok) return taken.done;
        if (!parsed) break;
        if (!parsed.ok) return parsed;
        bytes += parsed.bytes;
        sinceYieldBytes += parsed.bytes;
        if ("skip" in parsed && parsed.skip) {
          if (taken.done) break;
          continue;
        }
        const rec = (parsed as { rec: unknown }).rec;
        const seq = rec && typeof rec === "object" && !Array.isArray(rec) ? (rec as { storageSeq?: unknown }).storageSeq : undefined;
        if (typeof throughSeq === "number" && typeof seq === "number" && seq > throughSeq) {
          stop = true;
          break;
        }
        const applied = applySessionRecord(state, rec);
        if (!applied.ok) return applied;
        records += 1;
        sinceYieldRecords += 1;
        if (sinceYieldBytes >= YIELD_EVERY_BYTES || sinceYieldRecords >= YIELD_EVERY_RECORDS) {
          sinceYieldBytes = 0;
          sinceYieldRecords = 0;
          await yieldToEventLoop();
        }
        if (taken.done) break;
      }
      if (stop || atEnd) break;
    }
    return { ok: true, bytes, records, stop };
  } finally {
    closeSync(fd);
  }
}

function applyFramed(state: ReplayState, framed: FramedRecord): SessionResult<Record<string, never>> | "skip" {
  if (!framed.ok) return framed;
  if ("skip" in framed && framed.skip) return "skip";
  if (!("rec" in framed)) return "skip";
  return applySessionRecord(state, framed.rec);
}

export function replaySessionRecords(text: string): SessionResult<{ messages: ReplayMessage[]; maxSeq: number }> {
  const state = createReplayState();
  const buf = Buffer.from(text, "utf8");
  let pending = buf;
  for (;;) {
    const nl = pending.indexOf(0x0a);
    const taken = takeFramedLine(pending, nl < 0, true);
    pending = taken.rest;
    if (taken.done) {
      const applied = applyFramed(state, taken.done);
      if (applied !== "skip" && !applied.ok) return applied;
      break;
    }
    if (!taken.line) break;
    const parsed = parseFramedLine(taken.line);
    const applied = applyFramed(state, parsed);
    if (applied !== "skip" && !applied.ok) return applied;
  }
  return { ok: true, messages: state.messages, maxSeq: state.maxSeq };
}

export async function replaySessionBundle(
  sessionFile: string,
  opts?: { throughSeq?: number },
): Promise<SessionResult<{ messages: ReplayMessage[]; maxSeq: number; state: ReplayState }>> {
  const parsed = parseSessionBundlePath(sessionFile);
  if (!parsed) return { ok: false, error: "session path is not a core session bundle" };
  const current = inspectEntry(parsed.currentDir);
  if (!current) return { ok: false, error: "current directory is missing" };
  if (current.kind === "symlink") return { ok: false, error: "current directory is a symlink" };
  if (current.kind !== "dir") return { ok: false, error: "current is not a directory" };
  const listing = listCurrentSegments(parsed.currentDir);
  if (!listing.ok) return listing;
  const recovered = listing.active ? listing : recoverActiveSegment(parsed.currentDir, parsed.sessionFile);
  if (!recovered.ok) return recovered;
  const state = createReplayState();
  for (const part of recovered.parts) {
    const got = await readSegmentIntoState(part.path, state, false, opts?.throughSeq);
    if (!got.ok) return got;
    if (got.stop) return { ok: true, messages: state.messages, maxSeq: state.maxSeq, state };
  }
  if (recovered.active) {
    const got = await readSegmentIntoState(recovered.active.path, state, true, opts?.throughSeq);
    if (!got.ok) return got;
  }
  return { ok: true, messages: state.messages, maxSeq: state.maxSeq, state };
}

function encodeRecord(record: Record<string, unknown>): SessionResult<{ line: Buffer }> {
  let json: string;
  try {
    json = JSON.stringify(record);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  const line = Buffer.from(`${json}\n`, "utf8");
  if (line.length > MAX_SESSION_RECORD_BYTES) return { ok: false, error: "record exceeds MAX_SESSION_RECORD_BYTES" };
  return { ok: true, line };
}

export class SessionWriter {
  readonly sessionFile: string;
  readonly currentDir: string;
  private fd: number | null = null;
  private activeBytes = 0;
  private nextPart = 1;

  private constructor(sessionFile: string, currentDir: string) {
    this.sessionFile = sessionFile;
    this.currentDir = currentDir;
  }

  static open(sessionFile: string): SessionResult<{ writer: SessionWriter }> {
    const ensured = ensureSessionBundle(sessionFile);
    if (!ensured.ok) return ensured;
    const listing = listCurrentSegments(ensured.currentDir);
    if (!listing.ok) return listing;
    const recovered = listing.active ? listing : recoverActiveSegment(ensured.currentDir, ensured.sessionFile);
    if (!recovered.ok) return recovered;
    if (!recovered.active) return { ok: false, error: "active segment is missing" };
    const writer = new SessionWriter(ensured.sessionFile, ensured.currentDir);
    writer.activeBytes = recovered.active.size;
    writer.nextPart = recovered.parts.length > 0 ? recovered.parts[recovered.parts.length - 1]!.n + 1 : 1;
    try {
      writer.fd = openSync(ensured.sessionFile, "a", 0o600);
      const info = fstatSync(writer.fd);
      writer.activeBytes = info.size;
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    return { ok: true, writer };
  }

  get activeSize(): number {
    return this.activeBytes;
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
  }

  private reopenActive(): SessionResult<Record<string, never>> {
    this.close();
    try {
      this.fd = openSync(this.sessionFile, "a", 0o600);
      this.activeBytes = fstatSync(this.fd).size;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  private roll(): SessionResult<Record<string, never>> {
    this.close();
    const partPath = join(this.currentDir, partFileName(this.nextPart));
    try {
      const claim = openSync(partPath, "wx", 0o600);
      closeSync(claim);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    try {
      renameSync(this.sessionFile, partPath);
    } catch (err) {
      try {
        unlinkSync(partPath);
      } catch {
        /* the exclusive part name stays claimed */
      }
      return { ok: false, error: errMsg(err) };
    }
    try {
      const fd = openSync(this.sessionFile, "wx", 0o600);
      closeSync(fd);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
    this.nextPart += 1;
    this.activeBytes = 0;
    return this.reopenActive();
  }

  appendRecord(record: Record<string, unknown>): SessionResult<{ storageSeq: number }> {
    if (typeof record.storageSeq !== "number" || !Number.isInteger(record.storageSeq) || record.storageSeq < 1) {
      return { ok: false, error: "invalid storageSeq" };
    }
    const encoded = encodeRecord(record);
    if (!encoded.ok) return encoded;
    if (this.activeBytes + encoded.line.length > MAX_SESSION_SEGMENT_BYTES) {
      const rolled = this.roll();
      if (!rolled.ok) return rolled;
    }
    if (this.fd === null) {
      const opened = this.reopenActive();
      if (!opened.ok) return opened;
    }
    try {
      writeSync(this.fd!, encoded.line);
      this.activeBytes += encoded.line.length;
      return { ok: true, storageSeq: record.storageSeq };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
}

function referencedImageNames(messages: ReplayMessage[]): SessionResult<{ names: string[] }> {
  const names = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "image" || !block.source || typeof block.source !== "object" || Array.isArray(block.source)) continue;
      const src = block.source as { type?: unknown; name?: unknown };
      if (src.type !== "file" || typeof src.name !== "string") continue;
      if (!isSafeImageName(src.name)) return { ok: false, error: `unsafe image name: ${src.name}` };
      names.add(src.name);
    }
  }
  return { ok: true, names: [...names] };
}

async function copyReferencedImages(sourceCurrent: string, destCurrent: string, names: string[]): Promise<SessionResult<Record<string, never>>> {
  for (const name of names) {
    const src = join(sourceCurrent, name);
    const info = inspectEntry(src);
    if (!info) return { ok: false, error: `missing referenced image: ${name}` };
    if (info.kind === "symlink") return { ok: false, error: `referenced image is a symlink: ${name}` };
    if (info.kind !== "file") return { ok: false, error: `referenced image is not a file: ${name}` };
    try {
      await copyFile(src, join(destCurrent, name));
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
  return { ok: true };
}

export async function writeForkedSession(
  sourcePath: string,
  destPath: string,
  throughSeq: number,
): Promise<SessionResult<{ kept: number }>> {
  if (!Number.isInteger(throughSeq) || throughSeq < 0) return { ok: false, error: "invalid throughSeq" };
  const source = parseSessionBundlePath(sourcePath);
  const dest = parseSessionBundlePath(destPath);
  if (!source) return { ok: false, error: "source path is not a core session bundle" };
  if (!dest) return { ok: false, error: "destination path is not a core session bundle" };
  if (throughSeq === 0) {
    return materializeEmptyFork(dest);
  }
  const replayed = await replaySessionBundle(source.sessionFile, { throughSeq });
  if (!replayed.ok) return replayed;
  if (throughSeq > replayed.maxSeq) return { ok: false, error: "fork point is beyond the source maximum" };
  const images = referencedImageNames(replayed.messages);
  if (!images.ok) return images;
  return materializeVisibleFork(source, dest, replayed.messages, throughSeq, images.names);
}

async function materializeEmptyFork(dest: SessionBundlePaths): Promise<SessionResult<{ kept: number }>> {
  const tmp = uniqueSiblingDir(dest.projectDir, `${dest.sessionId}.tmp-`, sessionRotateStamp(Date.now()));
  try {
    await mkdir(join(tmp, CURRENT_DIR), { recursive: true, mode: 0o700 });
    const fd = openSync(join(tmp, CURRENT_DIR, ACTIVE_NAME), "wx", 0o600);
    closeSync(fd);
    await installTempBundle(tmp, dest.bundleDir);
    return { ok: true, kept: 0 };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: errMsg(err) };
  }
}

async function materializeVisibleFork(
  source: SessionBundlePaths,
  dest: SessionBundlePaths,
  messages: ReplayMessage[],
  throughSeq: number,
  imageNames: string[],
): Promise<SessionResult<{ kept: number }>> {
  const tmp = uniqueSiblingDir(dest.projectDir, `${dest.sessionId}.tmp-`, sessionRotateStamp(Date.now()));
  const tmpCurrent = join(tmp, CURRENT_DIR);
  const tmpFile = join(tmpCurrent, ACTIVE_NAME);
  try {
    await mkdir(tmpCurrent, { recursive: true, mode: 0o700 });
    const opened = SessionWriter.open(tmpFile);
    if (!opened.ok) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      return opened;
    }
    try {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        const written = opened.writer.appendRecord({
          storageSeq: i + 1,
          type: "message",
          message: { role: m.role, content: m.content },
        });
        if (!written.ok) {
          opened.writer.close();
          await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
          return written;
        }
        if (i % YIELD_EVERY_RECORDS === YIELD_EVERY_RECORDS - 1) await yieldToEventLoop();
      }
      if (throughSeq > messages.length) {
        const written = opened.writer.appendRecord({ storageSeq: throughSeq, type: "checkpoint" });
        if (!written.ok) {
          opened.writer.close();
          await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
          return written;
        }
      }
    } finally {
      opened.writer.close();
    }
    const copied = await copyReferencedImages(source.currentDir, tmpCurrent, imageNames);
    if (!copied.ok) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      return copied;
    }
    await installTempBundle(tmp, dest.bundleDir);
    return { ok: true, kept: messages.length };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: errMsg(err) };
  }
}

async function installTempBundle(tmpDir: string, destBundle: string): Promise<void> {
  if (existsSync(destBundle)) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("destination session bundle already exists");
  }
  await rename(tmpDir, destBundle);
}

export { CURRENT_DIR as SESSION_CURRENT_DIR, ACTIVE_NAME as SESSION_ACTIVE_NAME };
