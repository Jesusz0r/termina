/**
 * Prompt payload file reading (issue #60).
 *
 * One canonical reader for the `prompt` sidecar payload (`{prompt, images,
 * context}`), shared by the main-process prompt handler and the worldline
 * manager. The worker stats, reads, and parses the file so the main thread
 * never holds the 20 MB string; a sync fallback preserves identical output
 * when the worker is unavailable. Missing/oversize/malformed payloads fail
 * closed to null, matching the pre-#60 observable behavior.
 */
import { stat, readFile } from "node:fs/promises";
import type { ReadPromptResult } from "./session-fork.js";

export interface PromptPayload {
  text: string;
  images: unknown[];
  context: string;
}

export const PROMPT_TEXT_CAP = 64_000;
export const PROMPT_CONTEXT_CAP = 16_000;

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
  const textCap = opts.textCap ?? PROMPT_TEXT_CAP;
  const contextCap = opts.contextCap ?? PROMPT_CONTEXT_CAP;
  try {
    const res = await opts.offload(absPath, opts.maxBytes, textCap, contextCap);
    if (res.ok && res.found) return { text: res.text, images: res.images, context: res.context };
    if (res.ok) return null;
  } catch {
    /* Worker disposed/crashed; fall through to the identical sync read. */
  }
  try {
    const info = await stat(absPath);
    if (!info.isFile() || info.size > opts.maxBytes) return null;
    const raw = await readFile(absPath, "utf8");
    return parsePromptPayload(raw, textCap, contextCap);
  } catch {
    return null;
  }
}
