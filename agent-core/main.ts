/**
 * Termina agent-core v1 — experimental in-house engine.
 *
 * A drop-in candidate for the pi terminal: same pty surface, same sidecar
 * contract (TERMINA_TERMINAL_ID + TERMINA_EVENTS_DIR, agent_start/tool/
 * tool_end/agent_settled records), so timeline and modified list work
 * unchanged. Line-based stdin prompts; streamed plain-text stdout.
 *
 * - Frozen deterministic front matter; append-only session storage;
 *       revisions change the view, never the stored bytes; /resume replay
 * - Reclamation with high-water/low-water hysteresis; chained
 *       summarization on the cheap lane; emergency overflow revision
 *       mid-turn; last-resort truncate at prompt boundaries
 * - Stubs carry the reproducing command; structured file inventories
 *       survive summarization as data
 * - Per-turn usage records with waste attribution and models.dev pricing
 * - Two-role routing map (main + summary), env-overridable
 * - Streaming always; tool calls run concurrently behind a small bound
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

/** Example starting values from docs/AGENT-CORE.md; never spec constants. */
const MODEL = process.env.TERMINA_CORE_MODEL ?? "claude-sonnet-4-5";
/** Routing map, role → model. Mechanical work rides the cheap lane. */
const SUMMARY_MODEL = process.env.TERMINA_CORE_SUMMARY_MODEL ?? "claude-haiku-4-5";
const API_BASE = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const CONTEXT_WINDOW = Number(process.env.TERMINA_CORE_CONTEXT ?? 200_000);
const OUTPUT_RESERVE = 16_384;
const USABLE = Math.max(8_000, CONTEXT_WINDOW - OUTPUT_RESERVE);
const HIGH_WATER = 0.8;
const LOW_WATER = 0.6;
/** Trailing tool-output span never reclaimed (fraction of usable, clamped). */
const PROTECT_MIN = 4_000;
const PROTECT_MAX = 40_000;
const PROTECT_TOKENS = Math.min(PROTECT_MAX, Math.max(PROTECT_MIN, Math.floor(USABLE * 0.25)));
/** Newest user turns whose messages are never touched. */
const PROTECT_TURNS = 2;
/** Tool results below this size are never worth a stub. */
const PRUNE_MIN_CHARS = 2_048;
const READ_CAP_BYTES = 40 * 1024;
const BASH_CAP_BYTES = 20 * 1024;
const BASH_TIMEOUT_MS = 60_000;
const MAX_TURNS = 15;
const TOOL_CONCURRENCY = 4;
const NOISE_FLOOR_TOKENS = 1_024;
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Chars-per-token estimate. Good enough for water marks; never billing. */
function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---- sidecar (the bridge contract) ----

const eventsDir = process.env.TERMINA_EVENTS_DIR ?? "";
const terminalId = process.env.TERMINA_TERMINAL_ID ?? "";
const bridgeId = `core-${randomUUID()}`;
let seq = 0;

function logEvent(body: Record<string, unknown>): void {
  if (!eventsDir || !terminalId) return;
  try {
    mkdirSync(eventsDir, { recursive: true });
    const line = JSON.stringify({ bridgeId, seq: ++seq, ...body }) + "\n";
    appendFileSync(join(eventsDir, terminalId + ".jsonl"), line, { mode: 0o600 });
  } catch {
    /* the tailer tolerates gaps; never crash the loop on log failure */
  }
}

// ---- append-only session storage ----

const sessionFile = eventsDir && terminalId ? join(eventsDir, `${terminalId}.session.jsonl`) : null;
let storageSeq = 0;

/** Storage takes originals only. Revisions append records; they never
 *  rewrite these lines. Returns the entry's stable sequence address. */
function store(entry: Record<string, unknown>): number {
  const sseq = ++storageSeq;
  if (!sessionFile) return sseq;
  try {
    appendFileSync(sessionFile, JSON.stringify({ storageSeq: sseq, ...entry }) + "\n", { mode: 0o600 });
  } catch {
    /* storage failure degrades to in-memory only */
  }
  return sseq;
}

// ---- frozen deterministic front matter ----

let frozenSystem: string | null = null;

/** Built once per process, fixed order: identity, project instructions,
 *  environment. Same inputs must give byte-identical output. */
function systemPrompt(): string {
  if (frozenSystem !== null) return frozenSystem;
  const parts = [
    "You are the Termina agent-core. Be terse. Use tools to do real work in the user's project.",
  ];
  const agentsPath = resolve(process.cwd(), "AGENTS.md");
  if (existsSync(agentsPath)) {
    try {
      const md = readFileSync(agentsPath, "utf8");
      parts.push(`<project-instructions>\n${md.slice(0, 24_576)}\n</project-instructions>`);
    } catch {
      /* unreadable instructions degrade to identity only */
    }
  }
  parts.push(`<environment>\ncwd: ${process.cwd()}\nplatform: ${process.platform}\n</environment>`);
  frozenSystem = parts.join("\n\n");
  return frozenSystem;
}

// ---- tools ----

interface ToolUse {
  id: string;
  name: string;
  input: { path?: string; command?: string; content?: string };
}

interface ToolOutcome {
  result: Record<string, unknown>;
  isError: boolean;
}

function toolResult(use: ToolUse, content: string): Record<string, unknown> {
  return { type: "tool_result", tool_use_id: use.id, content };
}

function done(use: ToolUse, content: string, isError: boolean): ToolOutcome {
  return { result: toolResult(use, content), isError };
}

function capHead(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const cut = text.slice(0, maxBytes);
  return `${cut}\n[truncated at ${maxBytes} bytes — re-read with an offset to fetch more]`;
}

function capTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return `[...early output dropped...]\n${text.slice(-maxBytes)}`;
}

function executeTool(use: ToolUse): Promise<ToolOutcome> {
  const cwd = process.cwd();
  if (use.name === "read_file") {
    const abs = resolve(cwd, use.input.path ?? "");
    try {
      return Promise.resolve(done(use, capHead(readFileSync(abs, "utf8"), READ_CAP_BYTES), false));
    } catch (err) {
      return Promise.resolve(done(use, `error: ${(err as Error).message}`, true));
    }
  }
  if (use.name === "write_file") {
    const abs = resolve(cwd, use.input.path ?? "");
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, use.input.content ?? "");
      return Promise.resolve(done(use, `ok: wrote ${abs}`, false));
    } catch (err) {
      return Promise.resolve(done(use, `error: ${(err as Error).message}`, true));
    }
  }
  if (use.name === "bash") {
    return new Promise((res) => {
      execFile(
        "/bin/bash",
        ["-c", use.input.command ?? ""],
        { cwd, timeout: BASH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          const parts = [stdout, stderr];
          let failed = false;
          if (err) {
            // A nonzero exit or a signal/timeout is a failed command. The
            // timeline error counts must see it.
            failed = true;
            parts.push(`[exit ${typeof err.code === "number" ? err.code : err.signal ?? "error"}]`);
          }
          res(done(use, capTail(parts.filter(Boolean).join("\n") || "(no output)", BASH_CAP_BYTES), failed));
        },
      );
    });
  }
  return Promise.resolve(done(use, `error: unknown tool ${use.name}`, true));
}

const TOOLS = [
  {
    name: "read_file",
    description: "Read a file relative to the working directory. Output caps near 40 KB.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file relative to the working directory. Parent directories are created.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "bash",
    description: "Run one bash command in the working directory. 60 s timeout. Combined output caps near 20 KB.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
];

// ---- history: in-memory view over the append-only storage ----

type ContentBlock = Record<string, unknown> & {
  type: string;
  /** View metadata. Stripped before any request leaves the process. */
  chars?: number;
  tool?: string;
  repro?: string;
};

interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  tokens: number;
  /** Stable storage address. Revision records point here, never at
   *  shifting array indices. */
  sseq: number;
}

function blockChars(b: ContentBlock): number {
  if (typeof b.chars === "number") return b.chars;
  if (b.type === "text") return String((b as { text?: string }).text ?? "").length;
  if (b.type === "tool_result") return String((b as { content?: string }).content ?? "").length;
  if (b.type === "tool_use") return JSON.stringify((b as { input?: unknown }).input ?? {}).length;
  return 0;
}

function estimate(m: Message): number {
  if (typeof m.content === "string") return tokenEstimate(m.content) + 4;
  let sum = 4;
  for (const b of m.content) {
    sum += tokenEstimate(
      b.type === "tool_use"
        ? JSON.stringify((b as { input?: unknown }).input ?? {})
        : String((b as { text?: string; content?: string }).text ?? (b as { content?: string }).content ?? ""),
    ) + 10;
  }
  return sum;
}

/** Strip view metadata. Whitelist provider fields: any extra key on a
 *  content block (stubbed flags included) makes the provider reject the
 *  whole request. Exported for the self-check. */
export function toRequest(messages: Message[]): Array<{ role: string; content: unknown }> {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const blocks = m.content.map((b) => {
      if (b.type === "tool_result") {
        return { type: b.type, tool_use_id: (b as { tool_use_id?: string }).tool_use_id, content: (b as { content?: string }).content };
      }
      if (b.type === "tool_use") {
        return { type: b.type, id: (b as { id?: string }).id, name: (b as { name?: string }).name, input: (b as { input?: unknown }).input };
      }
      return { type: b.type, text: (b as { text?: string }).text };
    });
    return { role: m.role, content: blocks };
  });
}

function pushMessage(role: Message["role"], content: Message["content"]): Message {
  const m: Message = { role, content, tokens: 0, sseq: 0 };
  m.tokens = estimate(m);
  history.push(m);
  m.sseq = store({ type: "message", message: { role, content } });
  return m;
}

// ---- reclamation with hysteresis ----

/** Pure planner: pick the oldest prunable tool results outside the protected
 *  recency window until the projected total falls under the low-water mark. */
export function planPruneStubs(
  messages: Array<{ role: string; content: unknown; tokens: number }>,
  opts: { systemTokens: number; usable: number; protectTokens: number },
): Array<{ msgIndex: number }> {
  const total =
    opts.systemTokens +
    messages.reduce((sum, m) => sum + m.tokens, 0);
  // Hysteresis lives on the fill level: act at the high-water mark, reclaim
  // down to the low-water mark. Between the marks: do nothing.
  if (total < opts.usable * HIGH_WATER) return [];
  const quota = total - opts.usable * LOW_WATER;

  // Walk from the newest message backwards marking the protected span: the
  // last PROTECT_TURNS user prompts plus PROTECT_TOKENS of context.
  const protectedIdx = new Set<number>();
  let seen = 0;
  let guarded = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    protectedIdx.add(i);
    guarded += m.tokens;
    if (m.role === "user" && typeof m.content === "string") {
      seen++;
      if (seen >= PROTECT_TURNS) break;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (guarded >= opts.protectTokens) break;
    if (!protectedIdx.has(i)) {
      protectedIdx.add(i);
      guarded += messages[i]!.tokens;
    }
  }

  // Oldest-first selection among unprotected bulky tool results.
  const picks: Array<{ msgIndex: number }> = [];
  let reclaimed = 0;
  for (let i = 0; i < messages.length && reclaimed < quota; i++) {
    if (protectedIdx.has(i)) continue;
    const m = messages[i]!;
    if (typeof m.content === "string") continue;
    for (const b of m.content as ContentBlock[]) {
      if (reclaimed >= quota) break;
      if (b.type !== "tool_result") continue;
      const chars = blockChars(b as ContentBlock);
      if (chars < PRUNE_MIN_CHARS) continue;
      if ((b as ContentBlock).stubbed) continue;
      picks.push({ msgIndex: i });
      reclaimed += tokenEstimate("x".repeat(chars));
    }
  }
  return picks;
}

let postRevision = false;

/** Apply the planner to the live view. Storage already holds the originals. */
function reclaim(): number {
  const plan = planPruneStubs(
    history.map((m) => ({ role: m.role, content: m.content, tokens: m.tokens })),
    {
      systemTokens: tokenEstimate(systemPrompt()),
      usable: USABLE,
      protectTokens: PROTECT_TOKENS,
    },
  );
  let chars = 0;
  let stubbedCount = 0;
  const targets: Array<{ sseq: number; blockIndex: number }> = [];
  for (const pick of plan) {
    const m = history[pick.msgIndex]!;
    if (typeof m.content === "string") continue;
    const blocks = m.content as ContentBlock[];
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi]!;
      if (b.type !== "tool_result" || b.stubbed) continue;
      const c = blockChars(b);
      if (c < PRUNE_MIN_CHARS) continue;
      const stub = `[cleared by context maintenance: ${c} chars of ${b.tool ?? "tool"} output${b.repro ? ` — reproduce: ${b.repro}` : ""}]`;
      (b as unknown as { content: string }).content = stub;
      b.chars = stub.length;
      b.stubbed = true;
      chars += c;
      stubbedCount++;
      targets.push({ sseq: m.sseq, blockIndex: bi });
    }
    m.tokens = estimate(m);
  }
  if (stubbedCount > 0) {
    postRevision = true;
    revisions++;
    store({ type: "revision", kind: "prune", targets });
  }
  return stubbedCount;
}

/** Last resort when reclamation alone cannot fit the window: drop whole old
 *  turns, cutting only at real prompts. Storage keeps every dropped byte. */
function truncate(): boolean {
  let total = totalTokens();
  if (total < USABLE) return false;
  let cut = 0;
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === "user" && typeof m.content === "string") cut = i;
    total -= m.tokens;
    if (i === cut && total < USABLE * LOW_WATER) break;
  }
  if (cut <= 0) return false;
  history.splice(0, cut);
  postRevision = true;
  revisions++;
  store({ type: "revision", kind: "truncate", dropped: cut });
  return true;
}

// ---- summarization ----

/** The chained handoff. Each summary folds the previous one in. */
let lastHandoff: string | null = null;

function totalTokens(): number {
  return tokenEstimate(systemPrompt()) + history.reduce((s, m) => s + m.tokens, 0);
}

/** Newest-first protected span, mirroring the planner's window. Returns the
 *  index where the evicted span ends, adjusted back to a prompt boundary so
 *  the surviving tail starts a clean turn. */
function evictionBoundary(): number {
  let guarded = 0;
  let seen = 0;
  let boundary = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    boundary = i;
    guarded += history[i]!.tokens;
    if (history[i]!.role === "user" && typeof history[i]!.content === "string") {
      seen++;
      if (seen >= PROTECT_TURNS && guarded >= Math.min(PROTECT_TOKENS, USABLE / 4)) break;
    }
  }
  // The tail must start at a real prompt; walk forward past orphan results.
  while (
    boundary < history.length &&
    !(history[boundary]!.role === "user" && typeof history[boundary]!.content === "string")
  ) {
    boundary++;
  }
  return boundary;
}

function serializeForSummary(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      parts.push(`[User]: ${m.content.slice(0, 2_000)}`);
      continue;
    }
    for (const b of m.content as ContentBlock[]) {
      if (b.type === "text") parts.push(`[Assistant]: ${String(b.text ?? "").slice(0, 2_000)}`);
      else if (b.type === "tool_use")
        parts.push(`[Tool call]: ${b.name}(${JSON.stringify(b.input).slice(0, 300)})`);
      else if (b.type === "tool_result" && !b.stubbed)
        parts.push(`[Tool result]: ${String(b.content ?? "").slice(0, 500)}`);
    }
  }
  return parts.join("\n").slice(0, 60_000);
}

/** Structured inventories extracted from tool calls, not prose hope. */
function fileInventories(messages: Message[]): string {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content as ContentBlock[]) {
      if (b.type !== "tool_use") continue;
      const input = (b as { input?: { path?: string } }).input;
      if (!input?.path) continue;
      if (b.name === "read_file") read.add(input.path);
      if (b.name === "write_file") modified.add(input.path);
    }
  }
  const sections: string[] = [];
  if (read.size > 0) sections.push(`<read-files>\n${[...read].join("\n")}\n</read-files>`);
  if (modified.size > 0) sections.push(`<modified-files>\n${[...modified].join("\n")}\n</modified-files>`);
  return sections.join("\n");
}

/** Collapse old turns into one handoff message. Runs on the cheap lane.
 *  Returns false when there is nothing safely evictable or the call fails;
 *  callers fall back to truncate. */
async function summarize(): Promise<boolean> {
  const boundary = evictionBoundary();
  if (boundary <= 0) return false;
  const evicted = history.slice(0, boundary);
  const prior = lastHandoff ? `<previous-handoff>\n${lastHandoff}\n</previous-handoff>\n\n` : "";
  const prompt = `${prior}<session-to-compress>\n${serializeForSummary(evicted)}\n</session-to-compress>\n\nProduce the context handoff for continuing this session: task state, decisions made, files touched, open threads. Only output the handoff.`;
  const started = Date.now();
  currentAbort ??= new AbortController();
  try {
    const res = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
      signal: currentAbort.signal,
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: 2048,
        system: "You compress coding-agent session history. Only output the structured handoff.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = (await res.json()) as { usage?: Record<string, number>; content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? []).map((c) => c.text ?? "").join("").trim();
    if (!text) return false;
    const u = data.usage;
    logEvent({
      t: "usage",
      role: "summary",
      model: SUMMARY_MODEL,
      in: u?.input_tokens ?? null,
      inCached: u?.cache_read_input_tokens ?? null,
      out: u?.output_tokens ?? null,
      turnMs: Date.now() - started,
    });
    const inventories = fileInventories(evicted);
    const handoff = `<context-handoff>\n${text}${inventories ? `\n\n${inventories}` : ""}\n</context-handoff>`;
    lastHandoff = text;
    history.splice(0, boundary);
    const m: Message = { role: "user", content: handoff, tokens: estimate({ role: "user", content: handoff, tokens: 0, sseq: 0 }), sseq: 0 };
    history.unshift(m);
    m.sseq = store({ type: "message", message: { role: "user", content: handoff } });
    postRevision = true;
    revisions++;
    store({ type: "revision", kind: "summarize", evicted: boundary, summarySseq: m.sseq });
    process.stdout.write(`[context summarized: ${boundary} messages folded]\n`);
    return true;
  } catch (err) {
    if (!interrupted) process.stdout.write(`\n(summarization failed: ${(err as Error).message})\n`);
    return false;
  }
}

// ---- provider call (minimal SSE stream with usage capture) ----

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: ToolUse["input"] };

interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface CallResult {
  blocks: Block[];
  usage: Usage | null;
  ttftMs: number | null;
}

let currentAbort: AbortController | null = null;

async function callModel(messages: Message[]): Promise<CallResult> {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  const started = Date.now();
  const res = await fetch(`${API_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    signal: currentAbort?.signal,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      stream: true,
      system: systemPrompt(),
      tools: TOOLS,
      messages: toRequest(messages),
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const blocks: Block[] = [];
  const jsonParts = new Map<number, string>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | null = null;
  let ttftMs: number | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      switch (ev.type) {
        case "message_start": {
          const msg = (ev.message ?? {}) as { usage?: Record<string, number> };
          const u = msg.usage ?? {};
          usage = {
            input: u.input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            output: u.output_tokens ?? 0,
          };
          break;
        }
        case "content_block_start": {
          const cb = ev.content_block as Block;
          if (cb.type === "tool_use") {
            blocks.push({ type: "tool_use", id: cb.id, name: cb.name, input: {} });
            jsonParts.set(blocks.length - 1, "");
          } else if (cb.type === "text") {
            blocks.push({ type: "text", text: "" });
          }
          break;
        }
        case "content_block_delta": {
          const d = ev.delta as { type: string; text?: string; partial_json?: string };
          const idx = Number(ev.index);
          const target = blocks[idx];
          if (!target) break;
          if (d.type === "text_delta" && target.type === "text") {
            if (ttftMs === null) ttftMs = Date.now() - started;
            target.text += d.text ?? "";
            process.stdout.write(d.text ?? "");
          } else if (d.type === "input_json_delta" && target.type === "tool_use") {
            jsonParts.set(idx, (jsonParts.get(idx) ?? "") + (d.partial_json ?? ""));
          }
          break;
        }
        case "message_delta": {
          const u = (ev.usage ?? {}) as Record<string, number>;
          if (usage && typeof u.output_tokens === "number") usage.output = u.output_tokens;
          break;
        }
        default:
          break;
      }
    }
  }
  for (const [idx, part] of jsonParts) {
    const target = blocks[idx];
    if (target?.type === "tool_use") {
      try {
        target.input = JSON.parse(part || "{}");
      } catch {
        target.input = {};
      }
    }
  }
  return { blocks, usage, ttftMs };
}

// ---- waste attribution ----

let prevPrompt: { total: number; ts: number } | null = null;
let revisions = 0;

// Providers bill tokens; prices come from a local catalog (models.dev),
// not from the API response. Rates are USD per token once divided.
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

let rateLookup: ((model: string) => Rates | null) | null = null;

async function loadRates(): Promise<void> {
  try {
    const res = await fetch("https://models.dev/api.json");
    const db = (await res.json()) as Record<string, { models?: Record<string, { cost?: Record<string, number> }> }>;
    const models = db.anthropic?.models ?? {};
    const per = 1_000_000;
    const parse = (model: string): Rates | null => {
      const entry = models[model] ?? models[Object.keys(models).find((k) => k.startsWith(model + "-")) ?? ""];
      const c = entry?.cost;
      if (!c) return null;
      return {
        input: (c.input ?? 0) / per,
        output: (c.output ?? 0) / per,
        cacheRead: (c.cache_read ?? c.input ?? 0) / per,
        cacheWrite: (c.cache_write ?? c.input ?? 0) / per,
      };
    };
    rateLookup = parse;
  } catch {
    /* offline or catalog gone: usage records carry tokens without usd */
  }
}

function reportUsage(usage: Usage, ttftMs: number | null, turnStarted: number): void {
  const cur = usage.input + usage.cacheRead + usage.cacheWrite;
  let waste: { tokens: number; cause: string } | null = null;
  if (prevPrompt) {
    const missed = Math.min(prevPrompt.total, cur) - usage.cacheRead;
    if (missed > NOISE_FLOOR_TOKENS) {
      const gap = Date.now() - prevPrompt.ts;
      const cause = postRevision
        ? "post-revision"
        : gap > CACHE_TTL_MS
          ? "idle-expired"
          : "unexplained";
      waste = { tokens: missed, cause };
    }
  }
  postRevision = false;
  prevPrompt = { total: cur, ts: Date.now() };
  const rates = rateLookup?.(MODEL) ?? null;
  let usd: number | null = null;
  let wasteUsd: number | null = null;
  if (rates) {
    usd =
      usage.input * rates.input +
      usage.output * rates.output +
      usage.cacheRead * rates.cacheRead +
      usage.cacheWrite * rates.cacheWrite;
    if (waste) {
      // Missed tokens were billed at the paid rate (input or cache write),
      // never at the cache-read rate they should have enjoyed.
      const paidPerTok = usage.input + usage.cacheWrite > 0
        ? (usage.input * rates.input + usage.cacheWrite * rates.cacheWrite) / (usage.input + usage.cacheWrite)
        : rates.input;
      wasteUsd = waste.tokens * Math.max(0, paidPerTok - rates.cacheRead);
    }
  }
  logEvent({
    t: "usage",
    model: MODEL,
    in: usage.input,
    inCached: usage.cacheRead,
    inCacheWrite: usage.cacheWrite,
    out: usage.output,
    usd,
    ttftMs: ttftMs ?? null,
    turnMs: Date.now() - turnStarted,
    revisions,
    waste: waste ? { ...waste, usd: wasteUsd } : null,
  });
  revisions = 0;
}

// ---- agent loop ----

let interrupted = false;

async function runPrompt(prompt: string): Promise<void> {
  pushMessage("user", prompt);
  logEvent({ t: "agent_start", model: MODEL });
  running = true;
  interrupted = false;
  currentAbort = new AbortController();
  if (!rateLookup && !ratesFailed) void loadRates().then(() => { ratesFailed = true; });
  let retriedOverflow = false;
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (interrupted) break;
      reclaim();
      // Maintenance order: reclaim first; summarize only when reclamation cannot
      // hold the high-water line; truncate is the last resort.
      if (totalTokens() >= USABLE * HIGH_WATER && !(await summarize()) && totalTokens() >= USABLE) {
        truncate();
      }
      let result: CallResult;
      const callStarted = Date.now();
      try {
        result = await callModel(history);
      } catch (err) {
        // Emergency mid-turn revision: the provider
        // rejected the window; reclaim hard and retry exactly once.
        if (!retriedOverflow && /prompt is too long|maximum context|context_length/i.test(String((err as Error).message))) {
          retriedOverflow = true;
          reclaim();
          await summarize();
          truncate();
          result = await callModel(history);
        } else {
          throw err;
        }
      }
      if (result.usage) reportUsage(result.usage, result.ttftMs, callStarted);
      const assistantMsg: Message = { role: "assistant", content: result.blocks as ContentBlock[], tokens: 0, sseq: 0 };
      assistantMsg.tokens = estimate(assistantMsg);
      history.push(assistantMsg);
      assistantMsg.sseq = store({ type: "message", message: { role: "assistant", content: result.blocks } });
      const uses = (result.blocks.filter((b) => b.type === "tool_use") as Extract<Block, { type: "tool_use" }>[]).map(
        (b): ToolUse => ({ id: b.id, name: b.name, input: b.input }),
      );
      if (uses.length === 0) break;
      const outcomes: ToolOutcome[] = [];
      for (let i = 0; i < uses.length; i += TOOL_CONCURRENCY) {
        if (interrupted) break;
        const chunk = uses.slice(i, i + TOOL_CONCURRENCY);
        for (const use of chunk) {
          logEvent({ t: "tool", toolName: use.name, path: use.input.path, toolCallId: use.id });
          process.stdout.write(`\n[${use.name}]\n`);
        }
        const chunkOutcomes = await Promise.all(chunk.map(executeTool));
        outcomes.push(...chunkOutcomes);
      }
      // An interrupted turn must still answer the open tool calls, or the
      // stored pair breaks the next request.
      const answered = outcomes.length;
      for (let i = answered; i < uses.length; i++) {
        outcomes.push({ result: toolResult(uses[i]!, "(interrupted by user)"), isError: false });
      }
      const resultBlocks = outcomes.map((o, i): ContentBlock => {
        const b = o.result as ContentBlock;
        b.chars = undefined;
        b.tool = uses[i]!.name;
        b.repro = reproFor(uses[i]!);
        return b;
      });
      pushMessage("user", resultBlocks);
      process.stdout.write("\n");
    }
  } catch (err) {
    if (interrupted) process.stdout.write("\n(interrupted)\n");
    else process.stdout.write(`\nerror: ${(err as Error).message}\n`);
  } finally {
    running = false;
    currentAbort = null;
  }
  logEvent({ t: "agent_settled" });
  printPromptLine();
}

/** The durable half of a stub: how the model reproduces this output. */
function reproFor(use: ToolUse): string | undefined {
  if (use.name === "bash") return `bash '${(use.input.command ?? "").slice(0, 80)}'`;
  if (use.name === "read_file") return `read_file('${use.input.path ?? ""}')`;
  return undefined;
}

// ---- session resume: replay the append-only log into a fresh view ----

/** Rebuild the context view from storage. Revision records address messages
 *  by stable sseq, so replay is order-independent and exact. */
function resumeSession(): void {
  if (!sessionFile || !existsSync(sessionFile)) {
    process.stdout.write("(no stored session)\n");
    printPromptLine();
    return;
  }
  const bySeq = new Map<number, Message>();
  let revisions = 0;
  let maxSeq = 0;
  try {
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let e: { storageSeq?: number; type?: string; message?: { role: string; content: Message["content"] }; kind?: string; targets?: Array<{ sseq: number; blockIndex: number }>; dropped?: number; evicted?: number; summarySseq?: number };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof e.storageSeq === "number") maxSeq = Math.max(maxSeq, e.storageSeq);
      if (e.type === "message" && e.message && (e.message.role === "user" || e.message.role === "assistant")) {
        const m: Message = { role: e.message.role, content: e.message.content, tokens: 0, sseq: 0 };
        m.tokens = estimate(m);
        history.push(m);
        if (typeof e.storageSeq === "number") {
          m.sseq = e.storageSeq;
          bySeq.set(m.sseq, m);
        }
      } else if (e.type === "revision" && e.kind === "prune" && Array.isArray(e.targets)) {
        for (const t of e.targets) {
          const m = typeof t.sseq === "number" ? bySeq.get(t.sseq) : undefined;
          if (!m || typeof m.content === "string") continue;
          const b = (m.content as ContentBlock[])[t.blockIndex] as ContentBlock | undefined;
          if (!b || b.type !== "tool_result" || b.stubbed) continue;
          const stub = `[cleared by context maintenance: ${blockChars(b)} chars of ${b.tool ?? "tool"} output${b.repro ? ` — reproduce: ${b.repro}` : ""}]`;
          (b as unknown as { content: string }).content = stub;
          b.stubbed = true;
          m.tokens = estimate(m);
        }
        revisions++;
      } else if (e.type === "revision" && e.kind === "truncate" && typeof e.dropped === "number") {
        history.splice(0, e.dropped);
        revisions++;
      } else if (e.type === "revision" && e.kind === "summarize") {
        // The handoff message itself was stored as a normal message entry
        // before this record; only the evicted span needs dropping.
        history.splice(0, typeof e.evicted === "number" ? e.evicted : 0);
        revisions++;
      }
    }
  } catch (err) {
    process.stdout.write(`(resume failed: ${(err as Error).message})\n`);
    history.length = 0;
    printPromptLine();
    return;
  }
  if (history.length === 0) {
    process.stdout.write("(stored session is empty)\n");
    printPromptLine();
    return;
  }
  // Re-anchor the chain: find the newest stored handoff for future folds.
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i]!.content;
    if (typeof c === "string" && c.startsWith("<context-handoff>")) {
      lastHandoff = c.replace(/<\/?context-handoff>/g, "").trim();
      break;
    }
  }
  // Continue the storage sequence past everything already in the file.
  storageSeq = Math.max(storageSeq, maxSeq);
  prevPrompt = null; // first call after resume is exempt from waste attribution
  process.stdout.write(`resumed ${history.length} messages, ${revisions} revisions\n`);
}

// ---- terminal surface: raw-mode line input ----

let inputLine = "";

function printPromptLine(): void {
  process.stdout.write("\n> ");
}

const history: Message[] = [];
let running = false;
let queuedLine: string | null = null;
let ratesFailed = false;

function submit(line: string): void {
  if (running) {
    // Keep one typed-ahead prompt. More than one has no consumer yet.
    queuedLine = line;
    process.stdout.write("(queued — runs after the current task)\n");
    return;
  }
  // A rejected prompt promise must never kill the engine: the pty would
  // close and the terminal looks like it quit on the user.
  void runPrompt(line)
    .catch((err: unknown) => {
      process.stdout.write(`\nengine error: ${(err as Error).message}\n`);
      printPromptLine();
    })
    .then(() => {
    if (queuedLine !== null) {
      const next = queuedLine;
      queuedLine = null;
      submit(next);
    }
  });
}

function main(): void {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  process.stdout.write(`termina agent-core v1 · model ${MODEL} · ${hasKey ? "key ok" : "no ANTHROPIC_API_KEY"} · Ctrl+C interrupts · /exit quits\n`);
  printPromptLine();
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    // The handler owns the echo writes. One failed write must not take
    // down the engine; Node exits the process on an uncaught throw.
    try {
      handleInput(chunk);
    } catch (err) {
      process.stderr.write(`input error: ${(err as Error).message}\n`);
    }
  });
}

function handleInput(chunk: Buffer): void {
  for (const ch of chunk.toString("utf8")) {
      if (ch === "\r" || ch === "\n") {
        process.stdout.write("\n");
        const line = inputLine.trim();
        inputLine = "";
        if (!line) {
          printPromptLine();
          continue;
        }
        if (line === "/exit" || line === "/quit") {
          currentAbort?.abort();
          process.exit(0);
        }
        if (line.startsWith("/") && line !== "/resume") {
          process.stdout.write(`(unknown command: ${line})\n`);
          printPromptLine();
          continue;
        }
        if (line === "/resume") {
          if (running) {
            process.stdout.write("(engine busy)\n");
          } else if (history.length > 0) {
            process.stdout.write("(session already live — /resume only on a fresh engine)\n");
          } else {
            resumeSession();
          }
          printPromptLine();
          continue;
        }
        submit(line);
        if (!running) printPromptLine();
      } else if (ch === "\x7f") {
        if (inputLine.length > 0) {
          inputLine = inputLine.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (ch === "\x03") {
        // Interrupt the run, never kill the engine. The app's abort button
        // and Cmd+C send \x03 into the pty.
        if (running) {
          interrupted = true;
          currentAbort?.abort();
        } else {
          inputLine = "";
          process.stdout.write("^C\n");
          printPromptLine();
        }
      } else {
        inputLine += ch;
        process.stdout.write(ch);
      }
  }
}

main();
