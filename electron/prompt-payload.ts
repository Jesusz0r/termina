/**
 * Prompt payload file reading (issue #60).
 *
 * One canonical reader for the `prompt` sidecar payload (`{prompt, images,
 * context}`), shared by the main-process prompt handler and the worldline
 * manager. The worker stats, reads, and parses the file so the main thread
 * never holds the 20 MB string; a sync fallback preserves identical output
 * when the worker is unavailable. Missing/oversize/malformed payloads fail
 * closed; callers that need the reason use `readPromptPayloadResult`.
 */
import { stat, readFile } from "node:fs/promises";
import { isErrno } from "../shared/guards.js";
import type { ReadPromptResult } from "./session-fork.js";

export interface PromptPayload {
  text: string;
  images: unknown[];
  context: string;
}

const PROMPT_TEXT_CAP = 64_000;
const PROMPT_CONTEXT_CAP = 16_000;

type PromptPayloadFailureReason = "missing" | "not-a-file" | "oversize" | "malformed" | "unreadable";

type PromptPayloadRead =
  | { ok: true; payload: PromptPayload }
  | { ok: false; reason: PromptPayloadFailureReason };

/**
 * User-facing copy for a fail-closed payload read. Worldline Challenge/fork
 * gates use this instead of collapsing every failure to an empty task.
 */
export function describePromptPayloadFailure(reason: PromptPayloadFailureReason): string {
  switch (reason) {
    case "missing":
      return "the prompt payload is unavailable";
    case "oversize":
      return "the prompt payload exceeds the 20 MB budget";
    case "malformed":
    case "not-a-file":
    case "unreadable":
      return "the prompt payload is unreadable";
  }
}

/**
 * Pure parse + slice, identical to the pre-#60 `JSON.parse` + `String(...).slice`.
 * Throws on malformed JSON and on a null payload (a null property access throws,
 * exactly as before) — the caller fails closed.
 */
export function parsePromptPayload(
  raw: string,
  textCap: number = PROMPT_TEXT_CAP,
  contextCap: number = PROMPT_CONTEXT_CAP,
): PromptPayload {
  const payload = JSON.parse(raw) as { prompt?: unknown; images?: unknown; context?: unknown };
  return {
    text: String(payload.prompt ?? "").slice(0, textCap),
    images: Array.isArray(payload.images) ? payload.images : [],
    context: String(payload.context ?? "").slice(0, contextCap),
  };
}

/**
 * Read one validated absolute prompt payload path with an explicit failure
 * reason. The offload runs first; only an unexpected worker rejection falls
 * back to the identical sync read.
 */
export async function readPromptPayloadResult(
  absPath: string,
  opts: {
    maxBytes: number;
    textCap?: number;
    contextCap?: number;
    offload: (path: string, maxBytes: number, textCap: number, contextCap: number) => Promise<ReadPromptResult>;
  },
): Promise<PromptPayloadRead> {
  const textCap = opts.textCap ?? PROMPT_TEXT_CAP;
  const contextCap = opts.contextCap ?? PROMPT_CONTEXT_CAP;
  try {
    const res = await opts.offload(absPath, opts.maxBytes, textCap, contextCap);
    if (res.ok && res.found) return { ok: true, payload: { text: res.text, images: res.images, context: res.context } };
    if (res.ok) return { ok: false, reason: "unreadable" };
  } catch {
    /* Worker disposed/crashed; fall through to the identical sync read. */
  }
  try {
    const info = await stat(absPath);
    if (!info.isFile()) return { ok: false, reason: "not-a-file" };
    if (info.size > opts.maxBytes) return { ok: false, reason: "oversize" };
    const raw = await readFile(absPath, "utf8");
    try {
      return { ok: true, payload: parsePromptPayload(raw, textCap, contextCap) };
    } catch {
      return { ok: false, reason: "malformed" };
    }
  } catch (error) {
    return { ok: false, reason: isErrno(error, "ENOENT") ? "missing" : "unreadable" };
  }
}

/**
 * Read one validated absolute prompt payload path. Returns null when the payload
 * is missing, not a file, oversize, or malformed (fail-closed). The offload runs
 * first; only an unexpected worker rejection falls back to the identical sync read.
 */
export async function readPromptPayloadFile(
  absPath: string,
  opts: {
    maxBytes: number;
    textCap?: number;
    contextCap?: number;
    offload: (path: string, maxBytes: number, textCap: number, contextCap: number) => Promise<ReadPromptResult>;
  },
): Promise<PromptPayload | null> {
  const result = await readPromptPayloadResult(absPath, opts);
  return result.ok ? result.payload : null;
}
