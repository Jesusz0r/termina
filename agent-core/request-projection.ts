/**
 * Provider-neutral request projection.
 *
 * Session records are the durable source of truth.  This module makes the
 * provider request view from those records and inserts immutable working-set
 * snapshots at admitted prompt boundaries. Snapshots remain in memory only.
 * Provider-specific marker and protocol work
 * remains in openai-compat.ts (and the Anthropic request owner).
 */
import { createHash } from "node:crypto";

import { expandFileImageSource } from "./host.ts";
import { utf8BytePrefix } from "./tool-output.ts";

const DEFAULT_OVERLAY_BYTES = 64 * 1024;
const VIEW_KEYS = new Set(["chars", "tool", "repro", "stubbed"]);
const TOOL_USE_TYPES = new Set(["tool_use", "server_tool_use"]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "web_search_tool_result"]);

type PromptImage = { name: string; mediaType: string };

type ProjectionBlock = Record<string, unknown> & { type: string };

type ProjectionMessage = {
  role: "user" | "assistant";
  content: string | readonly ProjectionBlock[];
  sseq?: number;
  tokens?: number;
};

export type RequestMessage = {
  role: "user" | "assistant";
  content: unknown;
};

export type RequestOverlay = {
  text: string;
  bytes: number;
  hash: string;
};

type BuildRequestOverlayOptions = {
  hostContext?: string;
  maxBytes?: number;
};

type ProjectRequestOptions = {
  messages: readonly ProjectionMessage[];
  overlays?: RequestOverlays;
  imageRoots?: readonly string[];
  /** Opt in only when the active provider/protocol supports tool-result images. */
  allowToolResultImages?: boolean;
  /** Claude continues server calls itself; client calls must always be paired. */
  allowPendingServerTools?: boolean;
};

type ProjectRequestResult =
  | {
      ok: true;
      /** Complete request, including retained request-only snapshots. */
      messages: RequestMessage[];
      /** Provider-ready durable history, without host snapshots. */
      persistedMessages: RequestMessage[];
    }
  | { ok: false; error: string };

type ProjectPersistedResult =
  | { ok: true; messages: RequestMessage[] }
  | { ok: false; error: string };

function stripXmlControls(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function hostContextSafe(value: string): string {
  // Preserve markdown line structure while removing XML-invalid C0/C1
  // controls. CR/LF remain valid host-context content and are part of the
  // exact overlay bytes that are hashed and sent.
  return stripXmlControls(value).trim();
}

function overlayFromEncoded(text: string, encoded: Buffer): RequestOverlay {
  return { text, bytes: encoded.length, hash: createHash("sha256").update(encoded).digest("hex") };
}

function overlayFromText(text: string): RequestOverlay {
  return overlayFromEncoded(text, Buffer.from(text, "utf8"));
}

function overlayByteCap(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : DEFAULT_OVERLAY_BYTES;
}

/** Clamp already-encoded bytes to a UTF-8 boundary. Single-encode core: callers
 * holding the encoded form slice without re-encoding the string. */
function clampUtf8PrefixBytes(source: Buffer, maxBytes: number): Buffer {
  if (source.length <= maxBytes) return source;
  return utf8BytePrefix(source, maxBytes);
}

const OVERLAY_OPENING_TEXT = "<working-set>\n";
const OVERLAY_CLOSING_TEXT = "\n</working-set>";
const OVERLAY_OMITTED_TEXT = "<!-- host context omitted -->";

/** Truncate pre-encoded host bytes to the overlay budget. Owns the framing math
 * so callers encode the host string once instead of re-encoding per check. */
function truncateHostOverlayBytes(hostBytes: Buffer, maxBytes: number): Buffer | null {
  const opening = Buffer.from(OVERLAY_OPENING_TEXT, "utf8");
  const omitted = Buffer.from(OVERLAY_OMITTED_TEXT, "utf8");
  const tail = Buffer.from(OVERLAY_CLOSING_TEXT, "utf8");
  const closing = Buffer.concat([Buffer.from("\n", "utf8"), omitted, tail]);
  const fixed = Buffer.concat([opening, omitted, tail]);
  if (fixed.length > maxBytes) return null;
  const remaining = maxBytes - opening.length - closing.length;
  if (remaining <= 0) return fixed;
  const prefix = clampUtf8PrefixBytes(hostBytes, remaining);
  if (prefix.length === 0) return fixed;
  return Buffer.concat([opening, prefix, closing]);
}

/**
 * Build the volatile host-context overlay. Tool history already records every
 * file operation, so request overlays never duplicate read/modified paths.
 */
export function buildRequestOverlay(opts: BuildRequestOverlayOptions): RequestOverlay | null {
  const maxBytes = overlayByteCap(opts.maxBytes);
  const safe = hostContextSafe(opts.hostContext ?? "");
  if (!safe) return null;
  // Encode once: the full fast path reuses these bytes, and the truncate path
  // slices them instead of re-encoding the host string per length check.
  const safeBytes = Buffer.from(safe, "utf8");
  const fullBytes = Buffer.concat([
    Buffer.from(OVERLAY_OPENING_TEXT, "utf8"),
    safeBytes,
    Buffer.from(OVERLAY_CLOSING_TEXT, "utf8"),
  ]);
  if (fullBytes.length <= maxBytes) {
    return overlayFromEncoded(fullBytes.toString("utf8"), fullBytes);
  }
  const truncated = truncateHostOverlayBytes(safeBytes, maxBytes);
  if (!truncated) return null;
  return overlayFromEncoded(truncated.toString("utf8"), truncated);
}

function toolId(block: ProjectionBlock): string | null {
  const id = block.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function resultToolId(block: ProjectionBlock): string | null {
  const id = block.tool_use_id ?? block.toolUseId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function validateToolSequences(messages: readonly ProjectionMessage[], allowPendingServerTools = false): string | null {
  const active = new Map<string, boolean>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    if (message.role === "user" && [...active.values()].some(server => server)) {
      const hasNonResultContent = typeof message.content === "string"
        ? message.content.length > 0
        : message.content.some(block => block.type !== "tool_result");
      if (hasNonResultContent) return "user content interrupts an unfinished server tool";
    }
    if (typeof message.content === "string" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object" || typeof block.type !== "string") continue;
      if (block.type === "context") return `persisted context block at message ${messageIndex} is unsupported`;
      if (TOOL_USE_TYPES.has(block.type)) {
        const id = toolId(block);
        if (!id) return `tool call at message ${messageIndex} has no id`;
        if (active.has(id)) return `duplicate active tool call id: ${id}`;
        active.set(id, block.type === "server_tool_use");
        continue;
      }
      if (!TOOL_RESULT_TYPES.has(block.type)) continue;
      const id = resultToolId(block);
      if (!id) return `tool result at message ${messageIndex} has no tool_use_id`;
      if (!active.has(id)) return `tool result has no matching call: ${id}`;
      active.delete(id);
    }
  }
  for (const [id, server] of active) {
    if (!server || !allowPendingServerTools) return `incomplete tool-call sequence: ${id}`;
  }
  return null;
}

function providerBlock(
  block: ProjectionBlock,
  imageRoots: readonly string[],
  allowToolResultImages: boolean,
  observationCallId?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { type: block.type };
  for (const [key, value] of Object.entries(block)) {
    if (key === "type" || VIEW_KEYS.has(key) || value === undefined) continue;
    out[key] = value;
  }
  if (block.type === "tool_result" && Array.isArray(block.content)) {
    const callId = resultToolId(block) ?? "unknown";
    out.content = block.content.map(part => {
      if (!part || typeof part !== "object" || Array.isArray(part) || typeof part.type !== "string") return part;
      return providerBlock(part as ProjectionBlock, imageRoots, allowToolResultImages, callId);
    });
  }
  if (block.type === "image") {
    if (observationCallId && !allowToolResultImages) {
      throw new Error(`tool result ${observationCallId}: observation images are not supported by the active provider route`);
    }
    const source = out.source;
    const expanded = source && typeof source === "object" && !Array.isArray(source)
      ? expandFileImageSource(source as Record<string, unknown>, [...imageRoots])
      : null;
    if (expanded) out.source = expanded;
    else if (observationCallId) throw new Error(`tool result ${observationCallId}: observation image is missing or invalid`);
    else if (source && typeof source === "object" && !Array.isArray(source)) return { type: "text", text: "[image missing]" };
  }
  return out;
}

/** Providers reject thinking without a signature. Keep the text so the next
 *  turn still sees plans that the TUI already showed. */
function projectContentBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  if (block.type !== "thinking") return block;
  if (typeof block.signature === "string" && block.signature) return block;
  const thinking = typeof block.thinking === "string" ? block.thinking : "";
  if (!thinking) return null;
  return { type: "text", text: thinking.endsWith("\n") ? thinking : `${thinking}\n` };
}

function projectMessages(
  messages: readonly ProjectionMessage[],
  imageRoots: readonly string[],
  allowToolResultImages: boolean,
): RequestMessage[] {
  return messages.map((message) => {
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    const content = message.content
      .map((block) => projectContentBlock(providerBlock(block, imageRoots, allowToolResultImages)))
      .filter((block): block is Record<string, unknown> => block !== null);
    return { role: message.role, content };
  });
}

function normalizeOverlay(
  overlay: unknown,
  maxBytes: number,
): { ok: true; overlay: RequestOverlay } | { ok: false; error: string } {
  if (!overlay || typeof overlay !== "object") return { ok: false, error: "invalid request overlay" };
  const candidate = overlay as Partial<RequestOverlay>;
  if (typeof candidate.text !== "string") return { ok: false, error: "invalid request overlay" };
  const normalized = overlayFromText(candidate.text);
  if (candidate.bytes !== normalized.bytes || candidate.hash !== normalized.hash) {
    return { ok: false, error: "request overlay bytes/hash do not match its text" };
  }
  if (normalized.bytes > maxBytes) {
    return { ok: false, error: `request overlay exceeds ${maxBytes} byte cap` };
  }
  return { ok: true, overlay: normalized };
}

/** Project only durable session content without changing session records. */
export function projectPersistedMessages(
  opts: Pick<ProjectRequestOptions, "messages" | "imageRoots" | "allowPendingServerTools" | "allowToolResultImages">,
): ProjectPersistedResult {
  const sequenceError = validateToolSequences(opts.messages, opts.allowPendingServerTools);
  if (sequenceError) return { ok: false, error: sequenceError };
  try {
    return { ok: true, messages: projectMessages(opts.messages, opts.imageRoots ?? [], opts.allowToolResultImages === true) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "request image projection failed" };
  }
}

/** In-memory snapshots follow their durable prompt anchors, not request tails.
 * History revisions evict them; model changes and settlement do not. */
export class RequestOverlays {
  private readonly snapshots = new Map<number, RequestOverlay>();

  capture(sseq: number, overlay: RequestOverlay | null): RequestOverlay | null {
    if (!Number.isSafeInteger(sseq) || sseq <= 0) throw new Error("invalid overlay storage sequence");
    if (this.snapshots.has(sseq)) throw new Error(`overlay already captured at storage sequence ${sseq}`);
    // A confirmed empty host read supersedes historical snapshots. Missing
    // host integration does not call capture and makes no such claim.
    const candidate = overlay ?? (this.snapshots.size > 0
      ? buildRequestOverlay({ hostContext: "No current host context." })
      : null);
    if (!candidate) return null;
    const normalized = normalizeOverlay(candidate, DEFAULT_OVERLAY_BYTES);
    if (!normalized.ok) throw new Error(normalized.error);
    const snapshot = Object.freeze(normalized.overlay);
    this.snapshots.set(sseq, snapshot);
    return snapshot;
  }

  get(sseq: number | undefined): RequestOverlay | undefined {
    return sseq === undefined ? undefined : this.snapshots.get(sseq);
  }

  retain(messages: readonly Pick<ProjectionMessage, "sseq">[]): void {
    const retained = new Set(messages.map(message => message.sseq));
    for (const sseq of this.snapshots.keys()) {
      if (!retained.has(sseq)) this.snapshots.delete(sseq);
    }
  }

  tokens(messages: readonly Pick<ProjectionMessage, "sseq">[], estimate: (text: string) => number): number {
    let total = 0;
    for (const message of messages) {
      const snapshot = this.get(message.sseq);
      if (snapshot) total += estimate(snapshot.text);
    }
    return total;
  }

  clear(): void {
    this.snapshots.clear();
  }
}

/** Assemble snapshots before provider marker stamping. No source message or
 * snapshot is changed, so tool turns and retries retain the same old prefix. */
export function projectRequest(opts: ProjectRequestOptions): ProjectRequestResult {
  const persistedResult = projectPersistedMessages(opts);
  if (!persistedResult.ok) return persistedResult;
  const persistedMessages = persistedResult.messages;
  const messages: RequestMessage[] = [];
  for (let index = 0; index < opts.messages.length; index++) {
    const source = opts.messages[index]!;
    const snapshot = opts.overlays?.get(source.sseq);
    if (snapshot) {
      if (source.role !== "user" || (Array.isArray(source.content) &&
          source.content.some(block => TOOL_RESULT_TYPES.has(block.type)))) {
        return { ok: false, error: `overlay at storage sequence ${source.sseq} is not a prompt boundary` };
      }
      messages.push({ role: "user", content: snapshot.text });
    }
    messages.push(persistedMessages[index]!);
  }
  return { ok: true, messages, persistedMessages };
}

/** Persist exactly the submitted prompt and image references, never the host overlay. */
export function userPromptContent(prompt: string, images: readonly PromptImage[]): string | ProjectionBlock[] {
  if (images.length === 0) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({
      type: "image",
      source: { type: "file", name: image.name, media_type: image.mediaType },
    })),
  ];
}

