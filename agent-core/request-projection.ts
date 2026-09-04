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
const INVENTORY_CAP = 40;
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

type Inventory = {
  read: string[];
  modified: string[];
};

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function stripXmlControls(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function xmlSafe(value: string): string {
  return stripXmlControls(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inventoryPathSafe(value: string): string {
  // Newlines in a filename must not create extra inventory rows or inject
  // closing/opening tags.  Remove CR/LF at the inventory boundary; the
  // surrounding overlay framing retains its own deterministic newlines.
  return xmlSafe(value.replace(/[\r\n]/g, ""));
}

function hostContextSafe(value: string): string {
  // Preserve markdown line structure while removing XML-invalid C0/C1
  // controls. CR/LF remain valid host-context content and are part of the
  // exact overlay bytes that are hashed and sent.
  return stripXmlControls(value).trim();
}

function hashUtf8(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function overlayFromText(text: string): RequestOverlay {
  const bytes = Buffer.byteLength(text, "utf8");
  return { text, bytes, hash: hashUtf8(text) };
}

function overlayByteCap(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : DEFAULT_OVERLAY_BYTES;
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const source = Buffer.from(text, "utf8");
  if (source.length <= maxBytes) return text;
  let end = maxBytes;
  // Back up over a partial multi-byte sequence.  Buffer#toString replaces an
  // incomplete sequence with U+FFFD, which would make the overlay bytes differ
  // from the source prefix and could leak a misleading replacement character.
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
  return source.subarray(0, end).toString("utf8");
}

function blockInput(block: ProjectionBlock): Record<string, unknown> | null {
  const input = block.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function fileInventories(messages: readonly ProjectionMessage[]): Inventory {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
      const input = blockInput(block);
      const path = input?.path;
      if (typeof path !== "string" || path.length === 0) continue;
      const framedPath = stripXmlControls(path).replace(/[\r\n]/g, "");
      if (!framedPath) continue;
      if (block.name === "read_file") read.add(framedPath);
      if (block.name === "write_file" || block.name === "edit") modified.add(framedPath);
    }
  }
  return {
    read: [...read].sort(compareUtf8),
    modified: [...modified].sort(compareUtf8),
  };
}

function sectionText(tag: string, paths: readonly string[], limit = INVENTORY_CAP): string {
  const shown = paths.slice(0, limit).map(inventoryPathSafe);
  const omitted = paths.length - shown.length;
  if (omitted > 0) shown.push(`<!-- ${omitted} paths omitted -->`);
  return `<${tag}>\n${shown.join("\n")}\n</${tag}>`;
}

function fullOverlayText(inventory: Inventory, hostContext: string): string {
  const sections: string[] = [];
  if (inventory.read.length > 0) sections.push(sectionText("read-files", inventory.read));
  if (inventory.modified.length > 0) sections.push(sectionText("modified-files", inventory.modified));
  const host = hostContextSafe(hostContext);
  if (host) sections.push(host);
  if (sections.length === 0) return "";
  return `<working-set>\n${sections.join("\n")}\n</working-set>`;
}

function minimalOverlayText(): string {
  return "<working-set>\n<!-- context omitted: request overlay byte cap -->\n</working-set>";
}

function truncateHostOverlay(inventory: Inventory, hostContext: string, maxBytes: number): string | null {
  const minimum = minimalOverlayText();
  if (Buffer.byteLength(minimum, "utf8") > maxBytes) return null;

  // Keep inventory structure and deterministic entries first.  Host context is
  // the least stable part of the overlay, so it is the first part reduced.
  const sections: string[] = [];
  if (inventory.read.length > 0) sections.push(sectionText("read-files", inventory.read));
  if (inventory.modified.length > 0) sections.push(sectionText("modified-files", inventory.modified));
  const inventoryOnly = sections.length > 0 ? `<working-set>\n${sections.join("\n")}\n</working-set>` : "";
  const hostMarker = "<!-- host context omitted -->";

  const withHost = (host: string): string => {
    const body = [...sections, host].filter(Boolean).join("\n");
    return `<working-set>\n${body}\n</working-set>`;
  };

  if (sections.length === 0) {
    const host = hostContextSafe(hostContext);
    const opening = "<working-set>\n";
    const closing = `\n${hostMarker}\n</working-set>`;
    const fixed = `${opening}${hostMarker}\n</working-set>`;
    const remaining = maxBytes - Buffer.byteLength(opening + closing, "utf8");
    if (remaining <= 0) return fixed;
    const prefix = takeUtf8Prefix(host, remaining);
    const text = prefix ? `${opening}${prefix}${closing}` : fixed;
    return Buffer.byteLength(text, "utf8") <= maxBytes ? text : fixed;
  }

  if (inventoryOnly && Buffer.byteLength(inventoryOnly, "utf8") <= maxBytes) {
    const markerText = withHost(hostMarker);
    if (Buffer.byteLength(markerText, "utf8") <= maxBytes) {
      const remaining = maxBytes - Buffer.byteLength(markerText, "utf8");
      const host = takeUtf8Prefix(hostContextSafe(hostContext), remaining);
      const text = withHost(host ? `${host}\n${hostMarker}` : hostMarker);
      if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
    }
    return inventoryOnly;
  }

  // The inventory itself can exceed the cap.  Reduce entries in sorted order,
  // retaining an explicit omission marker and complete XML framing.
  const all = [
    ...(inventory.read.length > 0 ? [{ tag: "read-files", paths: inventory.read }] : []),
    ...(inventory.modified.length > 0 ? [{ tag: "modified-files", paths: inventory.modified }] : []),
  ];
  for (let visible = INVENTORY_CAP; visible >= 0; visible--) {
    const reduced: string[] = [];
    for (const item of all) {
      const shown = item.paths.slice(0, visible).map(inventoryPathSafe);
      const omitted = item.paths.length - shown.length;
      if (omitted > 0) shown.push(`<!-- ${omitted} paths omitted -->`);
      reduced.push(`<${item.tag}>\n${shown.join("\n")}\n</${item.tag}>`);
    }
    const body = reduced.join("\n");
    const text = `<working-set>\n${body}\n${hostMarker}\n</working-set>`;
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  }
  return minimum;
}

/**
 * Build the volatile working-set overlay.  The cap is applied to the fully
 * wrapped, escaped UTF-8 representation, and the returned hash is over those
 * exact bytes rather than over an unescaped inventory or an estimate.
 */
export function buildRequestOverlay(opts: BuildRequestOverlayOptions): RequestOverlay | null {
  const maxBytes = overlayByteCap(opts.maxBytes);
  const inventory = fileInventories(opts.messages);
  const host = opts.hostContext ?? "";
  const full = fullOverlayText(inventory, host);
  if (!full) return null;
  const text = Buffer.byteLength(full, "utf8") <= maxBytes
    ? full
    : truncateHostOverlay(inventory, host, maxBytes);
  return text ? overlayFromText(text) : null;
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
export const REQUEST_INVENTORY_CAP = INVENTORY_CAP;
