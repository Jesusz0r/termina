/**
 * Request-shape checks for privileged IPC. TerminaApp still registers
 * handlers and calls these before any fs/pty/snapshot work.
 */
import { isRecord } from "../../shared/guards.js";
import { CHALLENGE_PROFILES, type ChallengeProfile, type RendererIpcCapability } from "../../shared/types.js";

export function isChallengeProfile(value: unknown): value is ChallengeProfile {
  return typeof value === "string" && (CHALLENGE_PROFILES as readonly string[]).includes(value);
}

export function isFlushResult(value: unknown): value is { ok: boolean; failed: string[] } {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as { ok?: unknown; failed?: unknown };
  return typeof rec.ok === "boolean" && Array.isArray(rec.failed) && rec.failed.every((item) => typeof item === "string");
}

export function isUnsavedConfirmResult(value: unknown): value is { ok: boolean; cancelled?: boolean; error?: string } {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as { ok?: unknown; cancelled?: unknown; error?: unknown };
  if (typeof rec.ok !== "boolean") return false;
  if (rec.cancelled !== undefined && typeof rec.cancelled !== "boolean") return false;
  if (rec.error !== undefined && typeof rec.error !== "string") return false;
  return true;
}

export function isWorldlineLabel(label: unknown): label is "A" | "B" {
  return label === "A" || label === "B";
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Validate the shape of a renderer capability before comparing it. */
export function parseRendererCapability(value: unknown): RendererIpcCapability | null {
  if (!isRecord(value)) return null;
  const windowGeneration = isPositiveSafeInt(value.windowGeneration) ? value.windowGeneration : null;
  const rendererGeneration = isPositiveSafeInt(value.rendererGeneration) ? value.rendererGeneration : null;
  const loadGeneration = isPositiveSafeInt(value.loadGeneration) ? value.loadGeneration : null;
  const processId = isPositiveSafeInt(value.processId) ? value.processId : null;
  const frameRoutingId = isPositiveSafeInt(value.frameRoutingId) ? value.frameRoutingId : null;
  const nonce = value.nonce;
  if (
    windowGeneration === null
    || rendererGeneration === null
    || loadGeneration === null
    || processId === null
    || frameRoutingId === null
    || typeof nonce !== "string"
    || nonce.length < 16
    || nonce.length > 128
  ) return null;
  return { windowGeneration, rendererGeneration, loadGeneration, nonce, processId, frameRoutingId };
}

export type TerminalCreateRequest = {
  type?: "agent" | "shell";
  shell?: string;
  engine?: "core";
  fromTerminalId?: string;
  projectId?: string;
};

/** Shape-check terminals:create options. Shell existence stays in the handler. */
export function parseTerminalCreateOptions(opts: unknown):
  | { ok: true; value: TerminalCreateRequest }
  | { ok: false; error: string } {
  if (opts === undefined) return { ok: true, value: {} };
  if (typeof opts !== "object" || opts === null) return { ok: false, error: "invalid terminal options" };
  const rec = opts as { type?: unknown; shell?: unknown; engine?: unknown; fromTerminalId?: unknown; projectId?: unknown };
  if (rec.type !== undefined && rec.type !== "agent" && rec.type !== "shell") {
    return { ok: false, error: "invalid terminal type" };
  }
  if (rec.engine !== undefined && rec.engine !== "core") {
    return { ok: false, error: "invalid agent engine" };
  }
  if (rec.shell !== undefined && typeof rec.shell !== "string") return { ok: false, error: "invalid shell" };
  let fromTerminalId: string | undefined;
  let projectId: string | undefined;
  if (rec.fromTerminalId != null) {
    if (typeof rec.fromTerminalId !== "string" || rec.fromTerminalId.length > 64) {
      return { ok: false, error: "invalid source terminal" };
    }
    const id = rec.fromTerminalId.trim();
    if (id) fromTerminalId = id;
  }
  if (rec.projectId != null) {
    if (typeof rec.projectId !== "string" || rec.projectId.length > 64) {
      return { ok: false, error: "invalid project" };
    }
    const pid = rec.projectId.trim();
    if (pid) projectId = pid;
  }
  return {
    ok: true,
    value: {
      type: rec.type,
      shell: rec.shell,
      engine: rec.engine,
      fromTerminalId,
      projectId,
    },
  };
}

export type PtyAckPayload = {
  id: string;
  generation: number;
  windowGeneration: number;
  rendererGeneration: number;
  sequence: number;
};

export function parsePtyAckPayload(payload: unknown): PtyAckPayload | null {
  if (!isRecord(payload)) return null;
  if (
    typeof payload.id !== "string"
    || !isPositiveSafeInt(payload.generation)
    || !isPositiveSafeInt(payload.windowGeneration)
    || !isPositiveSafeInt(payload.rendererGeneration)
    || !isPositiveSafeInt(payload.sequence)
  ) return null;
  return {
    id: payload.id,
    generation: payload.generation,
    windowGeneration: payload.windowGeneration,
    rendererGeneration: payload.rendererGeneration,
    sequence: payload.sequence,
  };
}
