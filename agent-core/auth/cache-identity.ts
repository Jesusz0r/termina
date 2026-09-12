/**
 * Cache identity keys and session headers.
 *
 * Owns cache session seeds, identity derivation, and routing headers.
 * Split from agent-core/auth.ts (issue #38).
 */
import { type ProviderId, type ProviderProtocol } from "./providers/types.ts";
import { createHash, randomBytes } from "node:crypto";
import { isSupportedProvider } from "./endpoints.ts";


export type CacheRole = "main" | "summary";


/**
 * Inputs shared by every cache-key and provider-session serializer.
 *
 * `sessionSeed` is intentionally an internal seed, not a value that can be
 * sent to a provider. Call `cacheSessionSeed` once at a logical session/run
 * boundary and retain its result for that boundary.
 */
export interface CacheIdentityInputs {
  sessionSeed: string;
  role: CacheRole;
  provider: ProviderId;
  protocol: ProviderProtocol;
  /** A stable route/domain, never a turn prompt or working-set hash. */
  route: string;
}


/** OpenRouter documents a 256-character session id; all emitted keys stay below it. */
export const CACHE_KEY_MAX_LENGTH = 64;

const CACHE_KEY_PREFIX = "tc1_";

const CACHE_IDENTITY_DOMAIN = "termina-cache-identity-v1";

const CACHE_CONTROL_RE = /\p{Cc}/u;


function normalizedCacheText(value: unknown): string | null {
  if (typeof value !== "string" || CACHE_CONTROL_RE.test(value)) return null;
  const normalized = value.trim().normalize("NFC");
  return normalized || null;
}


/**
 * Create the stable seed for one logical session/run boundary.
 *
 * Durable identifiers are retained only in memory and are always hashed by
 * `deriveCacheIdentityKey`. Missing/whitespace identifiers receive a fresh
 * process-local seed; callers must reuse it for the lifetime of the boundary
 * and call this again after `/clear` or another new-session transition.
 * Invalid control-bearing identifiers fail closed with an empty seed.
 */
export function cacheSessionSeed(session: string | null | undefined): string {
  if (typeof session === "string" && CACHE_CONTROL_RE.test(session)) return "";
  const normalized = typeof session === "string" ? normalizedCacheText(session) : null;
  if (!normalized) return `ephemeral:${randomBytes(32).toString("hex")}`;
  return `durable:${normalized}`;
}


function cacheIdentityField(label: string, value: string): string | null {
  const normalized = normalizedCacheText(value);
  if (!normalized) return null;
  // Length-prefix each field so concatenation cannot create ambiguous inputs.
  return `${label.length}:${label}${normalized.length}:${normalized}`;
}


/**
 * Normalize a route to its non-secret domain. URL paths are intentionally not
 * part of the value because protocol is already a separate identity field.
 */
export function cacheRouteDomain(route: string): string {
  const normalized = normalizedCacheText(route);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    if (url.hostname) return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
  } catch {
    /* A named route such as "openrouter-responses" is already a domain. */
  }
  return normalized.toLowerCase();
}


/**
 * Derive the sole provider-facing cache identity. The output is printable
 * ASCII, bounded, and contains no raw session, terminal, or filesystem id.
 */
export function deriveCacheIdentityKey(input: CacheIdentityInputs): string | null {
  if (input.role !== "main" && input.role !== "summary") return null;
  if (!isSupportedProvider(input.provider)) return null;
  const seed = cacheIdentityField("seed", input.sessionSeed);
  const provider = cacheIdentityField("provider", input.provider);
  const protocol = cacheIdentityField("protocol", input.protocol);
  const role = cacheIdentityField("role", input.role);
  const route = cacheIdentityField("route", cacheRouteDomain(input.route));
  if (!seed || !provider || !protocol || !role || !route) return null;
  const material = [CACHE_IDENTITY_DOMAIN, seed, provider, protocol, role, route].join("\0");
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return `${CACHE_KEY_PREFIX}${digest}`.slice(0, CACHE_KEY_MAX_LENGTH);
}


export interface CacheIdentity {
  sessionSeed: string;
  key: string;
  role: CacheRole;
  provider: ProviderId;
  protocol: ProviderProtocol;
  route: string;
}


/** Build the identity object consumed by both headers and request bodies. */
export function cacheIdentityFor(input: CacheIdentityInputs): CacheIdentity | null {
  const route = cacheRouteDomain(input.route);
  const key = deriveCacheIdentityKey({ ...input, route });
  if (!key) return null;
  // Keep the raw seed available for key verification without making it
  // enumerable in logs, JSON, or a spread into a provider request.
  const identity = { key, role: input.role, provider: input.provider, protocol: input.protocol, route } as CacheIdentity;
  Object.defineProperty(identity, "sessionSeed", {
    value: input.sessionSeed,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return identity;
}


/**
 * Host-specific session pin. Verify every canonical identity input before
 * emitting a header so a key cannot be copied across route domains.
 */
export function cacheSessionHeaders(identity: CacheIdentity | null): Record<string, string> {
  if (!identity || typeof identity.key !== "string" || !identity.key || !/^[\x21-\x7e]+$/.test(identity.key) || identity.key.length > CACHE_KEY_MAX_LENGTH) return {};
  if (deriveCacheIdentityKey(identity) !== identity.key) return {};
  if (identity.provider === "openrouter") return { "x-session-id": identity.key };
  if (identity.provider === "opencode-go" || identity.provider === "opencode-zen") {
    return { "x-opencode-session": identity.key };
  }
  // x-grok-conv-id is documented for xAI Chat Completions, not Responses.
  if (identity.provider === "xai" && identity.protocol === "openai-completions") return { "x-grok-conv-id": identity.key };
  // Live codex-cache-probe evidence (gpt-6-astra): the Codex relay accepts
  // these session headers and routes repeated prefixes to warm machines
  // (aligned arms hit 6/8 warm reads vs 1/4 without). The headers carry
  // only the derived identity key and cannot alter the cached prefix.
  if (identity.provider === "openai-codex") return { "session-id": identity.key, "x-client-request-id": identity.key };
  return {};
}
