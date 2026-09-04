/**
 * Cache-policy diagnostics owned by agent-core.
 *
 * This module never serializes provider requests. It records bounded,
 * privacy-preserving metadata for the protocol owners and classifies misses
 * only when the response contains enough evidence to do so.
 */
import { createHash } from "node:crypto";
import { cacheRouteDomain } from "./auth.ts";
import type {
  CacheCapabilityObservation,
  CacheCapabilityProvenance,
  CacheCapabilityScope,
  CacheCapabilitySource,
  CacheCapabilityStatus,
  CacheIdentity,
  ProviderId,
  ProviderProtocol,
} from "./auth.ts";

const DIAGNOSTIC_INLINE_STRING_CHARS = 16_384;
const DIAGNOSTIC_ARRAY_ITEMS = 512;
const DIAGNOSTIC_DEPTH = 12;
const CAPABILITY_SCOPE_PART_CHARS = 512;
const CAPABILITY_KEY_PREFIX = "cap1_";

/** Maximum number of route/model/feature observations retained in memory. */
export const CAPABILITY_CACHE_MAX_ENTRIES = 256;

export interface CapabilityCacheRecord extends CacheCapabilityScope, CacheCapabilityObservation {
  key: string | null;
  observedAtMs: number | null;
  expiresAtMs: number | null;
}

export interface CapabilityCache {
  readonly maxEntries: number;
  readonly entries: Map<string, CapabilityCacheRecord>;
}

export interface RecordCapabilityInput {
  scope: CacheCapabilityScope;
  supported?: boolean | null;
  status?: CacheCapabilityStatus;
  source?: CacheCapabilitySource;
  reason?: string | null;
  provenance?: CacheCapabilityProvenance | null;
  observedAtMs?: number | null;
  expiresAtMs?: number | null;
}

export interface CachePolicyDiagnostics {
  provider: ProviderId | string;
  protocol: ProviderProtocol | string;
  model: string;
  requestedMode: string | null;
  effectiveMode: string | null;
  requestedTtlMs: number | null;
  effectiveTtlMs: number | null;
  /** True only when the route's retention semantics are known. */
  retentionKnown: boolean | null;
  fallbackReason: string | null;
}

export interface CacheRequestDiagnostics {
  cacheKeyHash: string | null;
  modelSettingsHash: string | null;
  toolsHash: string | null;
  /** SHA-256 of the exact provider-visible JSON tools array, when supplied. */
  serializedToolsHash: string | null;
  /** UTF-8 byte length of the exact provider-visible JSON tools array. */
  serializedToolsBytes: number | null;
  stablePrefixHash: string | null;
  /** Hash of the exact reusable prefix, excluding append-only history/tail. */
  reusablePrefixHash: string | null;
  /** Optional whole-history diagnostic; never use this to infer cache misses. */
  messagePrefixHash: string | null;
  workingSetHash: string | null;
  workingSetChanged: boolean | null;
  markerCount: number | null;
  markerPositions: number[] | null;
  policy: CachePolicyDiagnostics;
}

export interface CacheRequestDiagnosticsInput {
  identity: Pick<CacheIdentity, "key"> | null;
  policy: CachePolicyDiagnostics;
  modelSettings?: unknown;
  tools?: unknown;
  /** Exact post-protocol `body.tools` array; never canonicalize or reorder it. */
  serializedTools?: unknown;
  stablePrefix?: unknown;
  reusablePrefix?: unknown;
  messagePrefix?: unknown;
  workingSet?: unknown;
  markerCount?: number | null;
  markerPositions?: readonly number[] | null;
  workingSetChanged?: boolean | null;
}

function finiteNonnegative(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function finiteTime(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizedCapabilityPart(value: unknown): string | null {
  const text = nullableText(value);
  if (!text || /\p{Cc}/u.test(text) || text.length > CAPABILITY_SCOPE_PART_CHARS) return null;
  return text.normalize("NFC");
}

function normalizedCapabilityScope(scope: CacheCapabilityScope): CacheCapabilityScope | null {
  if (!scope || typeof scope !== "object") return null;
  const provider = normalizedCapabilityPart(scope.provider);
  const protocol = normalizedCapabilityPart(scope.protocol);
  const route = normalizedCapabilityPart(cacheRouteDomain(scope.route));
  const model = normalizedCapabilityPart(scope.model);
  const feature = normalizedCapabilityPart(scope.feature);
  if (!provider || !protocol || !route || !model || !feature) return null;
  return {
    provider: provider as ProviderId,
    protocol: protocol as ProviderProtocol,
    route,
    model,
    feature,
  };
}

function capabilityField(label: string, value: string): string {
  return `${label.length}:${label}${value.length}:${value}`;
}

/** Stable bounded map key for one provider/protocol/route/model/feature tuple. */
export function capabilityCacheKey(scope: CacheCapabilityScope): string | null {
  const normalized = normalizedCapabilityScope(scope);
  if (!normalized) return null;
  const material = [
    "termina-capability-v1",
    capabilityField("provider", normalized.provider),
    capabilityField("protocol", normalized.protocol),
    capabilityField("route", normalized.route),
    capabilityField("model", normalized.model),
    capabilityField("feature", normalized.feature),
  ].join("\0");
  return `${CAPABILITY_KEY_PREFIX}${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

function normalizeProvenance(value: CacheCapabilityProvenance | null | undefined): CacheCapabilityProvenance | null {
  if (!value || typeof value.url !== "string" || typeof value.retrievedAt !== "string") return null;
  const url = value.url.trim();
  const retrievedAt = value.retrievedAt.trim();
  if (
    !url ||
    !retrievedAt ||
    url.length > CAPABILITY_SCOPE_PART_CHARS ||
    retrievedAt.length > CAPABILITY_SCOPE_PART_CHARS ||
    !/^https:\/\//i.test(url) ||
    /\p{Cc}/u.test(url) ||
    /\p{Cc}/u.test(retrievedAt)
  ) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname) return null;
    return { url: `${parsed.origin}${parsed.pathname}`, retrievedAt };
  } catch {
    return null;
  }
}

function observationFor(
  supported: boolean | null | undefined,
  statusHint: CacheCapabilityStatus | undefined,
  source: CacheCapabilitySource | undefined,
  reason: string | null | undefined,
  provenance: CacheCapabilityProvenance | null | undefined,
): CacheCapabilityObservation {
  const known = typeof supported === "boolean" ? supported : statusHint === "supported" ? true : statusHint === "rejected" ? false : null;
  const status: CacheCapabilityStatus = known === true ? "supported" : known === false ? "rejected" : "unknown";
  const rawReason = nullableText(reason);
  const normalizedReason = rawReason && rawReason.length <= CAPABILITY_SCOPE_PART_CHARS ? rawReason : rawReason ? "reason-too-long" : null;
  const normalizedProvenance = normalizeProvenance(provenance);
  const normalizedSource: CacheCapabilitySource =
    source === "provider-docs" && normalizedProvenance === null
      ? "unknown"
      : source === "provider-docs" || source === "probe"
        ? source
        : "unknown";
  return {
    supported: known,
    status,
    source: normalizedSource,
    reason: normalizedReason,
    provenance: normalizedProvenance,
  };
}

function unknownCapabilityRecord(scope: CacheCapabilityScope, reason: string, key: string | null = null): CapabilityCacheRecord {
  return {
    key,
    ...scope,
    ...observationFor(null, undefined, undefined, reason, null),
    observedAtMs: null,
    expiresAtMs: null,
  };
}

/** Create a bounded, deterministic capability observation cache. */
export function createCapabilityCache(maxEntries = CAPABILITY_CACHE_MAX_ENTRIES): CapabilityCache {
  const requested = finiteTime(maxEntries);
  const bounded = requested === null ? CAPABILITY_CACHE_MAX_ENTRIES : Math.max(1, Math.min(1024, Math.floor(requested)));
  return { maxEntries: bounded, entries: new Map() };
}

/** Record one probe or documented default; no clock is read implicitly. */
export function recordCapability(cache: CapabilityCache, input: RecordCapabilityInput): CapabilityCacheRecord | null {
  const scope = normalizedCapabilityScope(input.scope);
  const key = scope ? capabilityCacheKey(scope) : null;
  if (!scope || !key) return null;
  const record: CapabilityCacheRecord = {
    key,
    ...scope,
    ...observationFor(input.supported, input.status, input.source, input.reason, input.provenance),
    observedAtMs: finiteTime(input.observedAtMs),
    expiresAtMs: finiteTime(input.expiresAtMs),
  };
  cache.entries.delete(key);
  cache.entries.set(key, record);
  while (cache.entries.size > cache.maxEntries) {
    const oldest = cache.entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.entries.delete(oldest);
  }
  return { ...record, provenance: record.provenance ? { ...record.provenance } : null };
}

/**
 * Query using a caller-supplied clock. A missing or expired observation is an
 * explicit nullable unknown, so the caller can send one optional field and
 * record exactly one rejected/supported probe result.
 */
export function queryCapability(cache: CapabilityCache, input: CacheCapabilityScope, nowMs: number): CapabilityCacheRecord {
  const scope = normalizedCapabilityScope(input);
  const key = scope ? capabilityCacheKey(scope) : null;
  if (!scope || !key) return unknownCapabilityRecord(input, "invalid-scope");
  const found = cache.entries.get(key);
  if (!found) return unknownCapabilityRecord(scope, "not-observed", key);
  const now = finiteTime(nowMs);
  if (now === null) return unknownCapabilityRecord(scope, "invalid-clock", key);
  if (found.expiresAtMs !== null && now >= found.expiresAtMs) {
    const expired = unknownCapabilityRecord(scope, "expired", key);
    cache.entries.delete(key);
    cache.entries.set(key, expired);
    return expired;
  }
  // Touch the entry so the bounded cache retains active routes.
  cache.entries.delete(key);
  cache.entries.set(key, found);
  return { ...found, provenance: found.provenance ? { ...found.provenance } : null };
}

/** Invalidate exactly one route/model/feature observation. */
export function invalidateCapability(cache: CapabilityCache, input: CacheCapabilityScope): boolean {
  const key = capabilityCacheKey(input);
  return key !== null ? cache.entries.delete(key) : false;
}

function canonicalDiagnosticValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > DIAGNOSTIC_DEPTH) return "[depth-limit]";
  if (typeof value === "string") {
    if (value.length <= DIAGNOSTIC_INLINE_STRING_CHARS) return value;
    return { chars: value.length, hash: shortHash(value) };
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, DIAGNOSTIC_ARRAY_ITEMS)
        .map((item) => canonicalDiagnosticValue(item, depth + 1, seen));
      return value.length > DIAGNOSTIC_ARRAY_ITEMS ? { length: value.length, items } : items;
    }
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalDiagnosticValue(record[key], depth + 1, seen);
    return sorted;
  } finally {
    seen.delete(value);
  }
}

function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Hash diagnostic content without retaining prompt, path, or tool text. */
export function hashCacheDiagnostic(value: unknown): string {
  const canonical = canonicalDiagnosticValue(value, 0, new WeakSet<object>());
  return shortHash(JSON.stringify(canonical) ?? "undefined");
}

function exactSerializedTools(value: unknown): { hash: string; bytes: number } | null {
  if (!Array.isArray(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return null;
    return {
      hash: createHash("sha256").update(serialized, "utf8").digest("hex"),
      bytes: Buffer.byteLength(serialized, "utf8"),
    };
  } catch {
    return null;
  }
}

function normalizePolicy(policy: CachePolicyDiagnostics): CachePolicyDiagnostics {
  return {
    provider: nullableText(policy.provider) ?? "",
    protocol: nullableText(policy.protocol) ?? "",
    model: nullableText(policy.model) ?? "",
    requestedMode: nullableText(policy.requestedMode),
    effectiveMode: nullableText(policy.effectiveMode),
    requestedTtlMs: finiteNonnegative(policy.requestedTtlMs),
    effectiveTtlMs: finiteNonnegative(policy.effectiveTtlMs),
    retentionKnown: typeof policy.retentionKnown === "boolean" ? policy.retentionKnown : null,
    fallbackReason: nullableText(policy.fallbackReason),
  };
}

function normalizeMarkerPositions(value: readonly number[] | null | undefined): number[] | null {
  if (!Array.isArray(value)) return null;
  const positions = value.filter((n) => Number.isInteger(n) && n >= 0).slice(0, 64);
  return positions.length ? positions : [];
}

/** Build bounded, nullable diagnostics for one exact provider request. */
export function cacheRequestDiagnostics(input: CacheRequestDiagnosticsInput): CacheRequestDiagnostics {
  const hashOptional = (value: unknown): string | null => (value === undefined ? null : hashCacheDiagnostic(value));
  const serializedTools = exactSerializedTools(input.serializedTools);
  const markerCount = finiteNonnegative(input.markerCount);
  return {
    cacheKeyHash: input.identity?.key ? hashCacheDiagnostic(input.identity.key) : null,
    modelSettingsHash: hashOptional(input.modelSettings),
    toolsHash: hashOptional(input.tools),
    serializedToolsHash: serializedTools?.hash ?? null,
    serializedToolsBytes: serializedTools?.bytes ?? null,
    stablePrefixHash: hashOptional(input.stablePrefix),
    reusablePrefixHash: hashOptional(input.reusablePrefix),
    messagePrefixHash: hashOptional(input.messagePrefix),
    workingSetHash: hashOptional(input.workingSet),
    workingSetChanged: typeof input.workingSetChanged === "boolean" ? input.workingSetChanged : null,
    markerCount,
    markerPositions: normalizeMarkerPositions(input.markerPositions),
    policy: normalizePolicy(input.policy),
  };
}

export interface CacheUsageSnapshot {
  /** Uncached input tokens as reported by the provider. */
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface CacheAttemptSnapshot {
  atMs: number;
  usage: CacheUsageSnapshot;
  diagnostics: CacheRequestDiagnostics;
  postRevision: boolean;
}

export type CacheMissCause =
  | "cache-policy-fallback"
  | "cache-policy-changed"
  | "cache-key-changed"
  | "model-settings-changed"
  | "tool-schema-changed"
  | "stable-prefix-changed"
  | "message-prefix-changed"
  | "working-set-changed"
  | "post-revision"
  | "idle-expired"
  | "possible-idle-expiry"
  | "backend-or-unknown"
  | "unknown";

export interface CacheMissClassification {
  /** False for a hit, an unknown response, or an unproven backend miss. */
  attributed: boolean;
  primary: CacheMissCause | null;
  contributing: CacheMissCause[];
  missedTokens: number | null;
  gapMs: number | null;
  /** Missing usage/metadata fields that kept a conclusion from being exact. */
  missingFields: string[];
}

function missingUsageFields(usage: CacheUsageSnapshot): string[] {
  const missing: string[] = [];
  if (finiteNonnegative(usage.inputTokens) === null) missing.push("inputTokens");
  if (finiteNonnegative(usage.cacheReadTokens) === null) missing.push("cacheReadTokens");
  if (finiteNonnegative(usage.cacheWriteTokens) === null) missing.push("cacheWriteTokens");
  return missing;
}

function totalUsage(usage: CacheUsageSnapshot): number | null {
  const missing = missingUsageFields(usage);
  if (missing.length) return null;
  return (
    finiteNonnegative(usage.inputTokens) as number
  ) + (finiteNonnegative(usage.cacheReadTokens) as number) + (finiteNonnegative(usage.cacheWriteTokens) as number);
}

function metadataMissing(previous: CacheRequestDiagnostics, current: CacheRequestDiagnostics): string[] {
  const missing: string[] = [];
  const fields: Array<keyof CacheRequestDiagnostics> = [
    "cacheKeyHash",
    "modelSettingsHash",
    "toolsHash",
    "stablePrefixHash",
    "reusablePrefixHash",
    "workingSetHash",
  ];
  for (const field of fields) {
    if (previous[field] === null || current[field] === null) missing.push(field);
  }
  return missing;
}

function policyFieldChanged(previous: CachePolicyDiagnostics, current: CachePolicyDiagnostics): boolean {
  const before = normalizePolicy(previous);
  const after = normalizePolicy(current);
  return (
    before.requestedMode !== after.requestedMode ||
    before.effectiveMode !== after.effectiveMode ||
    before.requestedTtlMs !== after.requestedTtlMs ||
    before.effectiveTtlMs !== after.effectiveTtlMs ||
    before.retentionKnown !== after.retentionKnown ||
    before.provider !== after.provider ||
    before.protocol !== after.protocol
  );
}

function changed(
  previous: CacheRequestDiagnostics,
  current: CacheRequestDiagnostics,
  field: keyof CacheRequestDiagnostics,
): boolean {
  const before = previous[field];
  const after = current[field];
  return typeof before === "string" && typeof after === "string" && before !== after;
}

function uniqueInPriorityOrder(causes: CacheMissCause[]): CacheMissCause[] {
  const priority: CacheMissCause[] = [
    "cache-policy-fallback",
    "cache-key-changed",
    "model-settings-changed",
    "tool-schema-changed",
    "stable-prefix-changed",
    "message-prefix-changed",
    "working-set-changed",
    "post-revision",
    "idle-expired",
    "possible-idle-expiry",
    "cache-policy-changed",
    "backend-or-unknown",
    "unknown",
  ];
  const set = new Set(causes);
  return priority.filter((cause) => set.has(cause));
}

/**
 * Attribute a lower-cache-read attempt using only local evidence and the
 * effective route policy. A missing usage component never becomes a zero.
 */
export function classifyCacheMiss(input: {
  previous: CacheAttemptSnapshot | null;
  current: CacheAttemptSnapshot;
  noiseFloorTokens?: number;
}): CacheMissClassification {
  if (!input.previous) {
    return { attributed: false, primary: null, contributing: [], missedTokens: 0, gapMs: null, missingFields: [] };
  }

  const currentAtMs = finiteNonnegative(input.current.atMs);
  const previousAtMs = finiteNonnegative(input.previous.atMs);
  const gapMs = currentAtMs !== null && previousAtMs !== null
    ? Math.max(0, currentAtMs - previousAtMs)
    : null;
  const missingFields = [
    ...missingUsageFields(input.previous.usage).map((field) => `previous.${field}`),
    ...missingUsageFields(input.current.usage).map((field) => `current.${field}`),
    ...metadataMissing(input.previous.diagnostics, input.current.diagnostics),
  ];
  const previousTotal = totalUsage(input.previous.usage);
  const currentTotal = totalUsage(input.current.usage);
  if (previousTotal === null || currentTotal === null) {
    return { attributed: false, primary: "unknown", contributing: [], missedTokens: null, gapMs, missingFields };
  }

  const read = finiteNonnegative(input.current.usage.cacheReadTokens) as number;
  if (read > currentTotal) {
    return {
      attributed: false,
      primary: "unknown",
      contributing: [],
      missedTokens: null,
      gapMs,
      missingFields: [...missingFields, "cacheReadTokens>totalTokens"],
    };
  }

  const missedTokens = Math.max(0, Math.min(previousTotal, currentTotal) - read);
  const noiseFloor = finiteNonnegative(input.noiseFloorTokens) ?? 0;
  if (missedTokens <= noiseFloor) {
    return { attributed: false, primary: null, contributing: [], missedTokens, gapMs, missingFields };
  }

  const causes: CacheMissCause[] = [];
  if (input.current.diagnostics.policy.fallbackReason) causes.push("cache-policy-fallback");
  if (policyFieldChanged(input.previous.diagnostics.policy, input.current.diagnostics.policy)) causes.push("cache-policy-changed");
  if (changed(input.previous.diagnostics, input.current.diagnostics, "cacheKeyHash")) causes.push("cache-key-changed");
  if (
    changed(input.previous.diagnostics, input.current.diagnostics, "modelSettingsHash") ||
    input.previous.diagnostics.policy.model !== input.current.diagnostics.policy.model
  ) {
    causes.push("model-settings-changed");
  }
  if (changed(input.previous.diagnostics, input.current.diagnostics, "toolsHash")) causes.push("tool-schema-changed");
  if (changed(input.previous.diagnostics, input.current.diagnostics, "stablePrefixHash")) causes.push("stable-prefix-changed");
  // `messagePrefixHash` may represent the entire growing transcript. Only
  // compare the explicit reusable-prefix hash for cache continuity.
  if (changed(input.previous.diagnostics, input.current.diagnostics, "reusablePrefixHash")) causes.push("stable-prefix-changed");
  if (
    input.current.diagnostics.workingSetChanged === true ||
    changed(input.previous.diagnostics, input.current.diagnostics, "workingSetHash")
  ) {
    causes.push("working-set-changed");
  }
  if (input.current.postRevision) causes.push("post-revision");

  const effectiveTtl = finiteNonnegative(input.current.diagnostics.policy.effectiveTtlMs);
  const requestedTtl = finiteNonnegative(input.current.diagnostics.policy.requestedTtlMs);
  if (gapMs !== null) {
    if (effectiveTtl !== null && gapMs > effectiveTtl) {
      causes.push(input.current.diagnostics.policy.retentionKnown === true ? "idle-expired" : "possible-idle-expiry");
    } else if (effectiveTtl === null && requestedTtl !== null && gapMs > requestedTtl) {
      causes.push("possible-idle-expiry");
    }
  }

  const ordered = uniqueInPriorityOrder(causes);
  if (!ordered.length) ordered.push("backend-or-unknown");
  const primary = ordered[0];
  return {
    attributed: primary !== "backend-or-unknown" && primary !== "unknown" && primary !== "possible-idle-expiry",
    primary,
    contributing: ordered.slice(1),
    missedTokens,
    gapMs,
    missingFields,
  };
}
