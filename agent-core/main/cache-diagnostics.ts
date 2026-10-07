/**
 * Request-body cache diagnostics.
 *
 * Walks a provider request for markers/TTL/policy, memoizes exact tools
 * JSON, and forwards the privacy-preserving snapshot to cache.ts. This is
 * not a second catalog or protocol mapper.
 * Extracted from agent-core/main.ts (issue #324).
 */
import { createHash } from "node:crypto";
import { cacheSessionHeaders, type CacheIdentity, type ProviderId } from "../auth.ts";
import {
  cacheRequestDiagnostics,
  type CachePolicyDiagnostics,
  type CacheRequestDiagnostics,
} from "../cache.ts";
import type { RequestOverlay } from "../request-projection.ts";
import type { ContextFilesResult } from "../host.ts";
import type { BoundedText } from "../tool-output.ts";
import type { TraceCacheInput } from "../trace.ts";

export type HostContextTrace = Pick<
  BoundedText,
  "state" | "direction" | "limitBytes" | "inputBytes" | "retainedBytes" | "omittedBytes" | "outputBytes" | "truncated"
> & Pick<ContextFilesResult, "files">;

export interface TraceCacheDiagnostics extends CacheRequestDiagnostics {
  /** Hash and exact byte count of the volatile overlay, if one was sent. */
  overlayHash: string | null;
  overlayBytes: number | null;
  /** Bounded host-reader metadata retained without exposing host content. */
  hostContext: HostContextTrace | null;
  retryPromptIdentical: boolean | null;
  codexTurnStateUsed: boolean;
  /** Exact UTF-8 serialization metadata for the provider tool schema. */
  serializedToolsHash: string | null;
  serializedToolsBytes: number | null;
  /** Full local miss evidence; null fields mean the provider did not expose enough data. */
  missAttribution: NonNullable<TraceCacheInput["missAttribution"]>;
}

type CacheMarkerDetails = { count: number; positions: number[]; ttlMs: number | null };

export function cacheMarkerDetails(value: unknown): CacheMarkerDetails {
  const details: CacheMarkerDetails = { count: 0, positions: [], ttlMs: null };
  const walk = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) walk(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (key === "cache_control" || key === "prompt_cache_breakpoint") {
        details.count++;
        if (details.positions.length < 64) details.positions.push(details.count - 1);
        if (
          child &&
          typeof child === "object" &&
          !Array.isArray(child) &&
          (child as Record<string, unknown>).ttl === "1h"
        ) {
          details.ttlMs = 60 * 60 * 1000;
        }
      }
      walk(child);
    }
  };
  walk(value);
  return details;
}

export function cachePolicyFromBody(
  body: Record<string, unknown>,
  identity: { provider: ProviderId; protocol: string; model: string },
  prior: CachePolicyDiagnostics | null,
  fallbackReason: string | null,
  hasHeaderIdentity = false,
): { policy: CachePolicyDiagnostics; markers: CacheMarkerDetails } {
  const markers = cacheMarkerDetails(body);
  const options = body.prompt_cache_options;
  const hasExplicitOptions = Boolean(options && typeof options === "object" && !Array.isArray(options));
  const hasCacheKey = typeof body.prompt_cache_key === "string" && body.prompt_cache_key.length > 0;
  const hasSessionId = typeof body.session_id === "string" && body.session_id.length > 0;
  const requestedMode = hasExplicitOptions
    ? "explicit"
    : hasCacheKey || hasSessionId || hasHeaderIdentity
      ? "implicit"
        : markers.count > 0
          ? identity.protocol === "anthropic-messages"
            ? "markers"
            : "explicit"
          : "none";
  // A rejected explicit field may be removed while a supported implicit key
  // remains in the same body. Derive the effective policy from that actual
  // body instead of collapsing every fallback to "none".
  const effectiveMode = requestedMode;
  let requestedTtlMs: number | null = null;
  if (hasExplicitOptions && (options as Record<string, unknown>).ttl === "30m") requestedTtlMs = 30 * 60 * 1000;
  else if (identity.provider === "anthropic" && markers.count > 0) requestedTtlMs = markers.ttlMs ?? 5 * 60 * 1000;
  else if (markers.ttlMs !== null) requestedTtlMs = markers.ttlMs;
  const effectiveTtlMs = fallbackReason ? null : requestedTtlMs;
  const retentionKnown =
    identity.provider === "anthropic" && markers.count > 0
      ? true
      : identity.provider === "openai" && hasExplicitOptions
        ? true
        : requestedMode === "none"
          ? true
          : null;
  return {
    markers,
    policy: {
      provider: identity.provider,
      protocol: identity.protocol,
      model: identity.model,
      requestedMode: prior?.requestedMode ?? requestedMode,
      effectiveMode,
      requestedTtlMs: prior?.requestedTtlMs ?? requestedTtlMs,
      effectiveTtlMs,
      retentionKnown,
      fallbackReason,
    },
  };
}

/** Exact tools serialization memoized by array identity. One turn diagnoses
 * the same `body.tools` array up to three times (initial attempt, rejected
 * cache-field trace, fallback retry); serialize it once. Entries are
 * identity-keyed so they drop with the array — no size cap needed. */
const serializedToolsMemo = new WeakMap<object, { text: string; hash: string; bytes: number } | null>();

function memoizedSerializedTools(tools: unknown): { text: string; hash: string; bytes: number } | null {
  try {
    const serialized = JSON.stringify(tools);
    if (typeof serialized !== "string") return null;
    const encoded = Buffer.from(serialized, "utf8");
    return {
      text: serialized,
      hash: createHash("sha256").update(encoded).digest("hex"),
      bytes: encoded.length,
    };
  } catch {
    return null;
  }
}

function memoizedSerializedToolsFor(tools: unknown): { text: string; hash: string; bytes: number } | null {
  if (typeof tools !== "object" || tools === null) return memoizedSerializedTools(tools);
  const hit = serializedToolsMemo.get(tools);
  if (hit !== undefined) return hit;
  const result = memoizedSerializedTools(tools);
  serializedToolsMemo.set(tools, result);
  return result;
}

export function buildCacheRequestDiagnostics(input: {
  body: Record<string, unknown>;
  identity: { provider: ProviderId; protocol: string; model: string };
  cacheIdentity: CacheIdentity | null;
  overlay: RequestOverlay | null;
  hostContext: HostContextTrace | null;
  fallbackReason?: string | null;
  priorPolicy?: CachePolicyDiagnostics | null;
  retryPromptIdentical?: boolean | null;
  previousDiagnostics?: CacheRequestDiagnostics | null;
  cacheKeySupported: boolean;
  codexTurnStateUsed: boolean;
  noiseFloorTokens: number;
}): TraceCacheDiagnostics {
  const {
    body,
    identity,
    cacheIdentity,
    overlay,
    hostContext,
    cacheKeySupported,
    codexTurnStateUsed,
    noiseFloorTokens,
  } = input;
  const fallbackReason = input.fallbackReason ?? null;
  const priorPolicy = input.priorPolicy ?? null;
  const retryPromptIdentical = input.retryPromptIdentical ?? null;
  const settings = { ...body };
  const tools = settings.tools ?? [];
  const memoizedTools = memoizedSerializedToolsFor(tools);
  const serializedToolsHash = memoizedTools ? memoizedTools.hash.slice(0, 16) : null;
  const serializedToolsBytes = memoizedTools ? memoizedTools.bytes : null;
  delete settings.tools;
  let stableSystem = settings.instructions ?? settings.system ?? settings.systemInstruction ?? null;
  delete settings.instructions;
  delete settings.system;
  delete settings.systemInstruction;
  let messages = settings.input ?? settings.messages ?? settings.contents ?? [];
  delete settings.input;
  delete settings.messages;
  delete settings.contents;
  if (stableSystem === null && Array.isArray(messages) && messages[0]?.role === "system") {
    stableSystem = messages[0];
    messages = messages.slice(1);
  }
  delete settings.prompt_cache_key;
  delete settings.session_id;
  const modelSettings = { ...identity, request: settings };
  // Report only identities actually emitted in the body or by the canonical
  // header owner. This includes Codex session headers without claiming they
  // are a documented prompt-cache key or guaranteed cache retention.
  const hasHeaderIdentity = cacheIdentity !== null &&
    Object.values(cacheSessionHeaders(cacheIdentity)).includes(cacheIdentity.key);
  const diagnosticIdentity = cacheIdentity && (
    hasHeaderIdentity ||
    (cacheKeySupported && body.prompt_cache_key === cacheIdentity.key) ||
    body.session_id === cacheIdentity.key
  ) ? cacheIdentity : null;
  const policyDetails = cachePolicyFromBody(body, identity, priorPolicy, fallbackReason, hasHeaderIdentity);
  const base = cacheRequestDiagnostics({
    identity: diagnosticIdentity,
    policy: policyDetails.policy,
    modelSettings,
    tools,
    serializedToolsText: memoizedTools?.text ?? null,
    stablePrefix: { system: stableSystem, tools, settings: modelSettings },
    // Hash the complete post-protocol wire sequence, including all snapshots.
    // Google coalescing can grow the last item, making this evidence
    // conservative; item equality does not promise provider cache reuse.
    reusablePrefix: messages,
    previous: cacheIdentity?.role === "main" ? input.previousDiagnostics ?? null : null,
    // Prefix evidence takes one bounded pass and checkpoints the previous
    // request's boundary. Do not compute a second whole-history diagnostic.
    // The latest capture is telemetry, distinct from complete wire-prefix
    // evidence. An absent latest capture hashes to a stable null sentinel;
    // earlier snapshots can still remain in the wire sequence.
    workingSet: overlay ? overlay.text : null,
    markerCount: policyDetails.markers.count,
    markerPositions: policyDetails.markers.positions,
  });
  return {
    ...base,
    overlayHash: overlay?.hash ?? null,
    overlayBytes: overlay?.bytes ?? null,
    hostContext: hostContext ? { ...hostContext } : null,
    retryPromptIdentical,
    codexTurnStateUsed,
    serializedToolsHash,
    serializedToolsBytes,
    missAttribution: {
      attributed: null,
      primary: null,
      contributing: [],
      missedTokens: null,
      gapMs: null,
      missingFields: ["previous-attempt"],
      noiseFloorTokens,
    },
  };
}
