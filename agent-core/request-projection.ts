/**
 * Provider-neutral request projection.
 *
 * Session records are the durable source of truth.  This module makes the
 * provider request view from those records and appends the host working-set
 * only for that one request.  Provider-specific marker and protocol work
 * remains in openai-compat.ts (and the Anthropic request owner).
 */
import { createHash } from "node:crypto";

import { expandFileImageSource } from "./host.ts";

const DEFAULT_OVERLAY_BYTES = 64 * 1024;
const VIEW_KEYS = new Set(["chars", "tool", "repro", "stubbed"]);
const TOOL_USE_TYPES = new Set(["tool_use", "server_tool_use"]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "web_search_tool_result"]);

export type PromptImage = { name: string; mediaType: string };

export type ProjectionBlock = Record<string, unknown> & { type: string };

export type ProjectionMessage = {
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

export type BuildRequestOverlayOptions = {
  messages: readonly ProjectionMessage[];
  hostContext?: string;
  maxBytes?: number;
};

export type ProjectRequestOptions = {
  messages: readonly ProjectionMessage[];
  overlay?: RequestOverlay | null;
  imageRoots?: readonly string[];
  maxBytes?: number;
};

export type ProjectRequestResult =
  | {
      ok: true;
      /** Complete request, including the volatile overlay when present. */
      messages: RequestMessage[];
      /** Provider-ready persisted history before the overlay is appended. */
      persistedMessages: RequestMessage[];
      overlay: RequestOverlay | null;
      overlayMessage: RequestMessage | null;
      overlayIndex: number | null;
    }
  | { ok: false; error: string };

export type ProjectPersistedResult =
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
  let end = maxBytes;
  // Back up over a partial multi-byte sequence. Truncating mid-sequence would
  // decode to U+FFFD, which would make the overlay bytes differ from the
  // source prefix and could leak a misleading replacement character.
  let continuationBytes = 0;
  while (end > 0 && (source[end - 1]! & 0xc0) === 0x80) {
    continuationBytes++;
    end--;
  }
  if (continuationBytes > 0 && end > 0) {
    const lead = source[end - 1]!;
    const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (expected > continuationBytes + 1) end--;
    else end = maxBytes;
  } else if (end > 0) {
    const lead = source[end - 1]!;
    if (lead >= 0xc0) end--;
  }
  return source.subarray(0, end);
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const source = Buffer.from(text, "utf8");
  if (source.length <= maxBytes) return text;
  return clampUtf8PrefixBytes(source, maxBytes).toString("utf8");
}

function fullOverlayText(hostContext: string): string {
  const host = hostContextSafe(hostContext);
  return host ? `<working-set>\n${host}\n</working-set>` : "";
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

function truncateHostOverlay(hostContext: string, maxBytes: number): string | null {
  const host = hostContextSafe(hostContext);
  if (!host) return null;
  const bytes = truncateHostOverlayBytes(Buffer.from(host, "utf8"), maxBytes);
  return bytes ? bytes.toString("utf8") : null;
}

/**
 * Build the volatile host-context overlay. Tool history already records every
 * file operation, so request overlays never duplicate read/modified paths.
 */
export function buildRequestOverlay(opts: BuildRequestOverlayOptions): RequestOverlay | null {
  void opts.messages;
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

function validateToolSequences(messages: readonly ProjectionMessage[]): string | null {
  const active = new Map<string, number>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    if (typeof message.content === "string" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object" || typeof block.type !== "string") continue;
      if (block.type === "context") return `persisted context block at message ${messageIndex} is unsupported`;
      if (TOOL_USE_TYPES.has(block.type)) {
        const id = toolId(block);
        if (!id) return `tool call at message ${messageIndex} has no id`;
        if (active.has(id)) return `duplicate active tool call id: ${id}`;
        active.set(id, messageIndex);
        continue;
      }
      if (!TOOL_RESULT_TYPES.has(block.type)) continue;
      const id = resultToolId(block);
      if (!id) return `tool result at message ${messageIndex} has no tool_use_id`;
      if (!active.has(id)) return `tool result has no matching call: ${id}`;
      active.delete(id);
    }
  }
  if (active.size > 0) {
    const [id] = active.keys();
    return `incomplete tool-call sequence: ${id}`;
  }
  return null;
}

function providerBlock(block: ProjectionBlock, imageRoots: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { type: block.type };
  for (const [key, value] of Object.entries(block)) {
    if (key === "type" || VIEW_KEYS.has(key) || value === undefined) continue;
    out[key] = value;
  }
  if (block.type === "image" && out.source && typeof out.source === "object" && !Array.isArray(out.source)) {
    const expanded = expandFileImageSource(out.source as Record<string, unknown>, [...imageRoots]);
    if (expanded) out.source = expanded;
    else return { type: "text", text: "[image missing]" };
  }
  return out;
}

function projectMessages(
  messages: readonly ProjectionMessage[],
  imageRoots: readonly string[],
): RequestMessage[] {
  return messages.map((message) => {
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    const content = message.content
      .map((block) => providerBlock(block, imageRoots))
      .filter((block) => block.type !== "thinking" || typeof block.signature === "string");
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

/**
 * Project only durable session content.  Main can stamp this returned array
 * for a provider-specific reusable prefix before calling appendRequestOverlay
 * with the already-snapshotted overlay.
 */
export function projectPersistedMessages(
  opts: Pick<ProjectRequestOptions, "messages" | "imageRoots">,
): ProjectPersistedResult {
  const sequenceError = validateToolSequences(opts.messages);
  if (sequenceError) return { ok: false, error: sequenceError };
  return { ok: true, messages: projectMessages(opts.messages, opts.imageRoots ?? []) };
}

/** Append a previously built overlay after provider-specific prefix stamping. */
export function appendRequestOverlay(
  persistedMessages: readonly RequestMessage[],
  overlay: RequestOverlay | null | undefined,
): RequestMessage[] {
  const messages = persistedMessages.slice();
  if (!overlay || typeof overlay.text !== "string" || overlay.text.length === 0) return messages;
  messages.push({ role: "user", content: overlay.text });
  return messages;
}

/**
 * Project persisted messages into a request and append one immutable overlay
 * message after the complete history.  The input messages and overlay are
 * never mutated, so retries can reuse this exact request projection.
 */
export function projectRequest(opts: ProjectRequestOptions): ProjectRequestResult {
  const persistedResult = projectPersistedMessages(opts);
  if (!persistedResult.ok) return persistedResult;
  const persistedMessages = persistedResult.messages;
  if (!opts.overlay) {
    return {
      ok: true,
      messages: persistedMessages.slice(),
      persistedMessages,
      overlay: null,
      overlayMessage: null,
      overlayIndex: null,
    };
  }
  const normalizedResult = normalizeOverlay(opts.overlay, overlayByteCap(opts.maxBytes));
  if (!normalizedResult.ok) return normalizedResult;
  const overlay = normalizedResult.overlay;
  if (!overlay.text) {
    return {
      ok: true,
      messages: persistedMessages.slice(),
      persistedMessages,
      overlay: null,
      overlayMessage: null,
      overlayIndex: null,
    };
  }
  const messages = appendRequestOverlay(persistedMessages, overlay);
  return {
    ok: true,
    messages,
    persistedMessages,
    overlay,
    overlayMessage: messages[messages.length - 1] ?? null,
    overlayIndex: messages.length - 1,
  };
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

export const REQUEST_OVERLAY_BYTES = DEFAULT_OVERLAY_BYTES;
