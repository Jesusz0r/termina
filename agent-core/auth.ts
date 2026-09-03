/**
 * Agent-core provider credentials.
 *
 * Own file: ~/.termina/agent/auth.json. This engine does not read or write
 * another product's credential store.
 *
 * Login shapes match the providers' public authentication flows
 * (Claude Code PKCE, Codex CLI PKCE, xAI Grok-CLI device code,
 * OpenRouter PKCE-minted key). This file is the only credential owner.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { readSystemProcessIdentity } from "../shared/process-identity.js";

const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "openai-codex",
  "github-copilot",
  "xai",
  "google",
  "openrouter",
  "opencode-go",
  "opencode-zen",
] as const;
export type ProviderId = (typeof SUPPORTED_PROVIDERS)[number];
export type ProviderProtocol =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-codex-responses"
  | "openai-responses"
  | "google-generate";
export type LoginMode = "browser" | "code" | "key" | "device";

const ANTHROPIC_AUTHORIZE = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const ANTHROPIC_REDIRECT_PORT = 53692;

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTHORIZE = "https://auth.openai.com/oauth/authorize";
const OPENAI_CODEX_TOKEN = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_SCOPES = "openid profile email offline_access";
const OPENAI_CODEX_REDIRECT_PORT = 1455;
const OPENAI_CODEX_REDIRECT_PATH = "/auth/callback";
/** ChatGPT's Codex backend gates on this originator. */
const OPENAI_CODEX_ORIGINATOR = "codex_cli_rs";
const OPENAI_CODEX_CLIENT_VERSION = "1.0.0";
const OPENAI_JWT_AUTH = "https://api.openai.com/auth";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const XAI_DEFAULT_INTERVAL_MS = 5_000;
const XAI_MIN_INTERVAL_MS = 1_000;
const XAI_SLOW_DOWN_MS = 5_000;
const XAI_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const XAI_POLL_MARGIN_MS = 3_000;

const OPENROUTER_AUTHORIZE = "https://openrouter.ai/auth";
const OPENROUTER_TOKEN = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_REDIRECT_PORT = 53693;

/** Public GitHub Copilot OAuth app for VS Code Copilot clients. */
const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const COPILOT_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "GitHubCopilotChat/0.35.0",
  "editor-version": "vscode/1.107.0",
  "editor-plugin-version": "copilot-chat/0.35.0",
  "copilot-integration-id": "vscode-chat",
} as const;

const EXPIRE_MARGIN_MS = 300_000;
const OAT_MARK = "sk-ant-oat";
const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com";

/** Token responses are normally only a few KiB; 256 KiB leaves ample room
 * for provider metadata and error details without permitting unbounded reads. */
const AUTH_HTTP_MAX_RESPONSE_BYTES = 256 * 1024;
const AUTH_HTTP_TIMEOUT_MS = 30_000;
const AUTH_REQUEST_CANCELLED = "auth request cancelled";
const AUTH_REQUEST_TIMED_OUT = "auth request timed out";
const AUTH_RESPONSE_TOO_LARGE = "auth response too large";
const AUTH_RESPONSE_INVALID_UTF8 = "auth response is not valid UTF-8";

export function isSupportedProvider(id: string): id is ProviderId {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(id);
}

/** Probe order when no model/provider is pinned. ChatGPT OAuth beats an OpenAI API key. */
export const AUTH_PROVIDER_ORDER: ProviderId[] = [
  "anthropic",
  "openai-codex",
  "github-copilot",
  "openai",
  "xai",
  "google",
  "openrouter",
  "opencode-go",
  "opencode-zen",
];

export type LoginKind = "oauth" | "key";

/** One row per login method. `/login openai oauth` is Codex; `/login openai key` is the API key. */
const LOGIN_METHODS: {
  group: string;
  id: ProviderId;
  kind: LoginKind;
  mode: LoginMode;
  name: string;
  hint: string;
}[] = [
  { group: "anthropic", id: "anthropic", kind: "oauth", mode: "browser", name: "Anthropic", hint: "Claude Pro/Max" },
  { group: "anthropic", id: "anthropic", kind: "key", mode: "key", name: "Anthropic", hint: "API key" },
  { group: "openai", id: "openai-codex", kind: "oauth", mode: "browser", name: "OpenAI", hint: "ChatGPT Plus/Pro (Codex)" },
  { group: "openai", id: "openai", kind: "key", mode: "key", name: "OpenAI", hint: "API key" },
  { group: "github-copilot", id: "github-copilot", kind: "oauth", mode: "device", name: "GitHub Copilot", hint: "Copilot subscription" },
  { group: "github-copilot", id: "github-copilot", kind: "key", mode: "key", name: "GitHub Copilot", hint: "GitHub token" },
  { group: "xai", id: "xai", kind: "oauth", mode: "device", name: "xAI", hint: "Grok/X subscription" },
  { group: "xai", id: "xai", kind: "key", mode: "key", name: "xAI", hint: "API key" },
  { group: "openrouter", id: "openrouter", kind: "oauth", mode: "browser", name: "OpenRouter", hint: "sign-in mints an API key" },
  { group: "openrouter", id: "openrouter", kind: "key", mode: "key", name: "OpenRouter", hint: "API key" },
  { group: "google", id: "google", kind: "key", mode: "key", name: "Google Gemini", hint: "API key" },
  { group: "opencode-go", id: "opencode-go", kind: "key", mode: "key", name: "OpenCode Go", hint: "subscription API key" },
  { group: "opencode-zen", id: "opencode-zen", kind: "key", mode: "key", name: "OpenCode Zen", hint: "pay-as-you-go API key" },
];

/** OAuth rows use the provider name. API-key rows add (key). */
function loginPickerLabel(method: { name: string; kind: LoginKind }): string {
  return method.kind === "key" ? `${method.name} (key)` : method.name;
}

export type LoginPickerItem = {
  label: string;
  hint: string;
  command: string;
};

export function loginPickerItems(cmd: "/login" | "/logout"): LoginPickerItem[] {
  return LOGIN_METHODS.map((m) => ({
    label: loginPickerLabel(m),
    hint: m.hint,
    command: `${cmd} ${m.group} ${m.kind}`,
  }));
}

const LOGIN_KIND_WORDS = new Set(["key", "oauth", "code", "device", "browser"]);

function loginKindFromWord(word: string): LoginKind | null {
  if (word === "key") return "key";
  if (word === "oauth" || word === "code" || word === "device" || word === "browser") return "oauth";
  return null;
}

function resolveLoginPick(
  groupOrId: string,
  kindWord?: string,
): { provider: ProviderId; mode: LoginMode } | { error: string } {
  const byId = LOGIN_METHODS.filter((m) => m.id === groupOrId);
  const byGroup = LOGIN_METHODS.filter((m) => m.group === groupOrId);
  const methods = kindWord ? (byGroup.length > 0 ? byGroup : byId) : byId.length > 0 ? byId : byGroup;
  if (methods.length === 0) {
    if (!isSupportedProvider(groupOrId)) {
      return { error: `unsupported provider: ${groupOrId} (supported: ${[...new Set(LOGIN_METHODS.map((m) => m.group))].join(", ")})` };
    }
    const mode =
      kindWord && loginKindFromWord(kindWord) === "key"
        ? "key"
        : kindWord === "code"
          ? "code"
          : kindWord === "device"
            ? "device"
            : kindWord === "browser" || kindWord === "oauth"
              ? "browser"
              : defaultLoginMode(groupOrId);
    return { provider: groupOrId, mode };
  }
  const kind = kindWord ? loginKindFromWord(kindWord) : null;
  const picked =
    kind != null
      ? methods.find((m) => m.kind === kind)
      : methods.find((m) => m.mode === defaultLoginMode(m.id)) ?? methods[0];
  if (!picked) return { error: `${groupOrId} has no ${kindWord} login` };
  if (kindWord === "code") return { provider: picked.id, mode: "code" };
  if (kindWord === "device") return { provider: picked.id, mode: "device" };
  if (kindWord === "browser") return { provider: picked.id, mode: "browser" };
  return { provider: picked.id, mode: picked.mode };
}

/** Last path segment of a vendor/model id. */
export function modelLeaf(model: string): string {
  const n = model.trim().toLowerCase();
  const slash = n.lastIndexOf("/");
  return slash >= 0 ? n.slice(slash + 1) : n;
}

function modelLooksClaude(model: string): boolean {
  const n = model.toLowerCase();
  return modelLeaf(model).includes("claude") || n.includes("claude");
}

function modelLooksQwen(model: string): boolean {
  const leaf = modelLeaf(model);
  const n = model.toLowerCase();
  return leaf.startsWith("qwen") || n.includes("/qwen");
}

function modelLooksGemini(model: string): boolean {
  const leaf = modelLeaf(model);
  const n = model.toLowerCase();
  return leaf.startsWith("gemini") || n.includes("/gemini");
}

/**
 * OpenCode Zen picks an existing kernel protocol from the model id.
 * Claude and Qwen use Messages. GPT, Codex, Grok, and Muse Spark use Responses.
 * Gemini uses Google generateContent on /models/{id}.
 */
export function zenWireProtocol(model: string): ProviderProtocol {
  const leaf = modelLeaf(model);
  if (modelLooksClaude(model) || modelLooksQwen(model)) return "anthropic-messages";
  if (modelLooksGemini(model)) return "google-generate";
  if (
    /^(gpt-|o[0-9]|chatgpt)/.test(leaf) ||
    leaf.includes("codex") ||
    leaf.startsWith("grok") ||
    leaf.startsWith("muse-spark")
  ) {
    return "openai-responses";
  }
  return "openai-completions";
}

export const CACHE_CAPABILITY_FEATURE = {
  anthropicCacheControl: "anthropic-cache-control",
  promptCacheKey: "prompt_cache_key",
  promptCacheOptions: "prompt_cache_options",
  promptCacheBreakpoint: "prompt_cache_breakpoint",
  xaiConversationHeader: "x-grok-conv-id",
  googleCachedContent: "google-cached-content",
  ttl: "cache-ttl",
  lookback: "cache-lookback",
} as const;

export type CacheCapabilityFeature = string;

export interface CacheCapabilityScope {
  provider: ProviderId;
  protocol: ProviderProtocol;
  route: string;
  model: string;
  feature: CacheCapabilityFeature;
}

export type CacheCapabilityStatus = "supported" | "rejected" | "unknown";
export type CacheCapabilitySource = "provider-docs" | "probe" | "unknown";

export interface CacheCapabilityProvenance {
  url: string;
  /** Retrieval date supplied by the implementation/audit, not provider data. */
  retrievedAt: string;
}

export interface CacheCapabilityObservation {
  supported: boolean | null;
  status: CacheCapabilityStatus;
  source: CacheCapabilitySource;
  reason: string | null;
  provenance: CacheCapabilityProvenance | null;
}

/** Primary documentation used for direct-route capability defaults. */
export const CACHE_POLICY_PROVENANCE = {
  anthropicPromptCaching: {
    url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    retrievedAt: "2026-08-30",
  },
  openaiPromptCaching: {
    url: "https://developers.openai.com/api/docs/guides/prompt-caching",
    retrievedAt: "2026-08-30",
  },
  openaiResponses: {
    url: "https://developers.openai.com/api/reference/cli/resources/responses/methods/create",
    retrievedAt: "2026-08-30",
  },
  xaiPromptCaching: {
    url: "https://docs.x.ai/developers/advanced-api-usage/prompt-caching",
    retrievedAt: "2026-08-30",
  },
  googleContextCaching: {
    url: "https://ai.google.dev/gemini-api/docs/generate-content/caching",
    retrievedAt: "2026-08-30",
  },
} as const;

function unknownCapability(reason: string, provenance: CacheCapabilityProvenance | null = null): CacheCapabilityObservation {
  return { supported: null, status: "unknown", source: provenance ? "provider-docs" : "unknown", reason, provenance };
}

function documentedCapability(provenance: CacheCapabilityProvenance, reason: string): CacheCapabilityObservation {
  return {
    supported: true,
    status: "supported",
    source: "provider-docs",
    reason,
    provenance: { ...provenance },
  };
}

function documentedUnknown(provenance: CacheCapabilityProvenance, reason: string): CacheCapabilityObservation {
  return unknownCapability(reason, { ...provenance });
}

function isDirectDocumentedRoute(provider: ProviderId, route: string): boolean {
  const domain = cacheRouteDomain(route);
  if (provider === "anthropic") return domain === "api.anthropic.com";
  if (provider === "openai") return domain === "api.openai.com";
  if (provider === "xai") return domain === "api.x.ai";
  if (provider === "google") return domain === "generativelanguage.googleapis.com";
  return false;
}

function isGpt56Model(model: string): boolean {
  if (typeof model !== "string") return false;
  const leaf = modelLeaf(model);
  return leaf.startsWith("gpt-5.6");
}

/**
 * Return only documentation-backed defaults. Relay, Zen, and compatibility
 * routes intentionally remain unknown regardless of their model name.
 */
export function documentedCacheCapability(scope: CacheCapabilityScope): CacheCapabilityObservation {
  if (!scope || typeof scope !== "object") return unknownCapability("invalid-capability-scope");
  if (!isDirectDocumentedRoute(scope.provider, scope.route)) return unknownCapability("route-not-directly-documented");
  const feature = scope.feature;
  if (scope.provider === "anthropic" && scope.protocol === "anthropic-messages") {
    if (feature === CACHE_CAPABILITY_FEATURE.anthropicCacheControl) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.anthropicPromptCaching, "Anthropic Messages cache_control is documented");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.ttl) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.anthropicPromptCaching, "Anthropic cache duration field is documented; value remains policy data");
    }
  }
  if (scope.provider === "openai" && scope.protocol === "openai-responses") {
    if (feature === CACHE_CAPABILITY_FEATURE.promptCacheKey && typeof scope.model === "string" && scope.model.trim()) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.openaiPromptCaching, "OpenAI Responses prompt_cache_key is documented");
    }
    if (
      (feature === CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint || feature === CACHE_CAPABILITY_FEATURE.promptCacheOptions) &&
      isGpt56Model(scope.model)
    ) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.openaiPromptCaching, "OpenAI GPT-5.6 explicit cache field is documented");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.ttl && isGpt56Model(scope.model)) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.openaiPromptCaching, "OpenAI GPT-5.6 cache TTL field is documented; value remains policy data");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.promptCacheKey || feature === CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint || feature === CACHE_CAPABILITY_FEATURE.promptCacheOptions) {
      return documentedUnknown(CACHE_POLICY_PROVENANCE.openaiPromptCaching, "model-specific support is not established");
    }
  }
  if (scope.provider === "xai") {
    if (scope.protocol === "openai-responses" && feature === CACHE_CAPABILITY_FEATURE.promptCacheKey) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.xaiPromptCaching, "xAI Responses prompt_cache_key is documented");
    }
    if (scope.protocol === "openai-completions" && feature === CACHE_CAPABILITY_FEATURE.xaiConversationHeader) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.xaiPromptCaching, "xAI Chat conversation header is documented");
    }
  }
  if (scope.provider === "google" && scope.protocol === "google-generate" && feature === CACHE_CAPABILITY_FEATURE.googleCachedContent) {
    return documentedCapability(CACHE_POLICY_PROVENANCE.googleContextCaching, "Gemini native cached content is documented");
  }
  if (scope.provider === "google" && scope.protocol === "google-generate" && feature === CACHE_CAPABILITY_FEATURE.ttl) {
    return documentedCapability(CACHE_POLICY_PROVENANCE.googleContextCaching, "Gemini native cache duration is documented; value remains policy data");
  }
  return unknownCapability("feature-not-documented-for-route");
}

/** Direct Anthropic Messages only; relays must prove marker support first. */
export function usesAnthropicCacheMarkers(provider: ProviderId, model: string, route: string): boolean {
  return documentedCacheCapability({ provider, protocol: providerProtocol(provider, model), route, model, feature: CACHE_CAPABILITY_FEATURE.anthropicCacheControl }).supported === true;
}

/** Direct documented OpenAI Responses and xAI Responses routes only. Relays probe. */
export function usesPromptCacheKey(provider: ProviderId, model: string, route: string): boolean {
  return documentedCacheCapability({ provider, protocol: providerProtocol(provider, model), route, model, feature: CACHE_CAPABILITY_FEATURE.promptCacheKey }).supported === true;
}

/**
 * GPT-5.6 Sol/Terra/Luna accept explicit prompt_cache_breakpoint.
 * Copilot and Codex do not support that field (Codex returns 400
 * "prompt_cache_breakpoint is not supported on this model").
 */
export function usesOpenAIExplicitCache(model: string, provider: ProviderId, route: string): boolean {
  return documentedCacheCapability({ provider, protocol: providerProtocol(provider, model), route, model, feature: CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint }).supported === true;
}

/**
 * Top-level prompt_cache_options on the direct OpenAI Responses route.
 * Relays and subscription gateways must feature-probe at their route owner.
 */
export function usesPromptCacheOptions(provider: ProviderId, model: string, route: string): boolean {
  return documentedCacheCapability({ provider, protocol: providerProtocol(provider, model), route, model, feature: CACHE_CAPABILITY_FEATURE.promptCacheOptions }).supported === true;
}

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
  return {};
}

export function providerProtocol(id: ProviderId, model = ""): ProviderProtocol {
  if (id === "anthropic") return "anthropic-messages";
  if (id === "openai-codex") return "openai-codex-responses";
  if (id === "google" || id === "opencode-go") return "openai-completions";
  if (id === "opencode-zen") return zenWireProtocol(model);
  return "openai-responses";
}

export function usesResponsesApi(id: ProviderId, model = ""): boolean {
  const proto = providerProtocol(id, model);
  return proto === "openai-codex-responses" || proto === "openai-responses";
}

export function defaultLoginMode(id: ProviderId): LoginMode {
  if (id === "xai" || id === "github-copilot") return "device";
  if (id === "openai" || id === "google" || id === "opencode-go" || id === "opencode-zen") return "key";
  return "browser";
}

export function authPath(): string {
  const override = process.env.TERMINA_AUTH_PATH;
  if (override) return override;
  return join(homedir(), ".termina", "agent", "auth.json");
}

function testOverride(name: string): string | undefined {
  if (process.env.TERMINA_CORE_TEST !== "1") return undefined;
  const raw = process.env[name]?.trim();
  return raw || undefined;
}

function testLoopbackOverride(name: string): string | undefined {
  const raw = testOverride(name);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const octets = host.split(".");
    const loopback = host === "::1" || (
      octets.length === 4 &&
      octets[0] === "127" &&
      octets.slice(1).every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    );
    if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function authorizeUrl(id: ProviderId): string {
  const test = testLoopbackOverride("TERMINA_TEST_AUTHORIZE_URL");
  if (test) return test;
  if (id === "openai-codex") return OPENAI_CODEX_AUTHORIZE;
  if (id === "openrouter") return OPENROUTER_AUTHORIZE;
  return ANTHROPIC_AUTHORIZE;
}

function tokenUrl(id: ProviderId): string {
  const test = testLoopbackOverride("TERMINA_TEST_TOKEN_URL");
  if (test) return test;
  if (id === "openai-codex") return OPENAI_CODEX_TOKEN;
  if (id === "xai") return XAI_TOKEN_URL;
  if (id === "openrouter") return OPENROUTER_TOKEN;
  return ANTHROPIC_TOKEN;
}

function deviceUrl(): string {
  return testLoopbackOverride("TERMINA_TEST_DEVICE_URL") || XAI_DEVICE_URL;
}

export function redirectPort(id: ProviderId = "anthropic"): number {
  const raw = process.env.TERMINA_CORE_TEST === "1" ? process.env.TERMINA_TEST_REDIRECT_PORT : undefined;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  if (id === "openai-codex") return OPENAI_CODEX_REDIRECT_PORT;
  if (id === "openrouter") return OPENROUTER_REDIRECT_PORT;
  return ANTHROPIC_REDIRECT_PORT;
}

function redirectPath(id: ProviderId): string {
  return id === "openai-codex" ? OPENAI_CODEX_REDIRECT_PATH : "/callback";
}

function redirectHost(id: ProviderId): string {
  return id === "openai-codex" ? "localhost" : "127.0.0.1";
}

function redirectUri(id: ProviderId, port: number): string {
  return `http://${redirectHost(id)}:${port}${redirectPath(id)}`;
}

export function isOAuthToken(token: string): boolean {
  return token.includes(OAT_MARK);
}

export function pickHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (isOAuthToken(token)) {
    headers.authorization = `Bearer ${token}`;
    headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
    headers["user-agent"] = "termina-agent-core/1";
    headers["x-app"] = "cli";
  } else {
    headers["x-api-key"] = token;
  }
  return headers;
}

export function openaiCodexClientVersion(): string {
  return OPENAI_CODEX_CLIENT_VERSION;
}

export function extractAccountId(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
    const nested = payload[OPENAI_JWT_AUTH];
    const fromNested =
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? (nested as { chatgpt_account_id?: unknown }).chatgpt_account_id
        : undefined;
    const raw = fromNested ?? payload.chatgpt_account_id;
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

export function requestHeaders(
  providerId: ProviderId,
  token: string,
  extra?: Record<string, unknown>,
): Record<string, string> {
  if (providerId === "anthropic") return pickHeaders(token);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": "termina-agent-core/1",
  };
  if (providerId === "openai-codex") {
    const account =
      (typeof extra?.accountId === "string" && extra.accountId) || extractAccountId(token) || "";
    if (account) headers["chatgpt-account-id"] = account;
    headers.originator = OPENAI_CODEX_ORIGINATOR;
    headers["user-agent"] = `codex_cli_rs/${OPENAI_CODEX_CLIENT_VERSION}`;
    headers["openai-beta"] = "responses=experimental";
  }
  if (providerId === "openrouter") {
    headers["http-referer"] = "https://termina.local";
    headers["x-title"] = "Termina agent-core";
  }
  if (providerId === "github-copilot") {
    headers["editor-version"] = COPILOT_HEADERS["editor-version"];
    headers["editor-plugin-version"] = COPILOT_HEADERS["editor-plugin-version"];
    headers["copilot-integration-id"] = COPILOT_HEADERS["copilot-integration-id"];
    headers["user-agent"] = COPILOT_HEADERS["user-agent"];
  }
  if (providerId === "opencode-go" || providerId === "opencode-zen") {
    headers["x-api-key"] = token;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

/** Zen Gemini generateContent forwards Bearer to Vertex and 401s. Use only the Google key header. */
export function googleNativeHeaders(headers: Record<string, string>): Record<string, string> {
  const token = (headers.authorization?.replace(/^Bearer\s+/i, "") || headers["x-api-key"] || "").trim();
  const next = { ...headers };
  delete next.authorization;
  delete next["x-api-key"];
  delete next["anthropic-version"];
  if (token) next["x-goog-api-key"] = token;
  return next;
}

export function needsRefresh(expires: unknown, now = Date.now()): boolean {
  return typeof expires === "number" && Number.isFinite(expires) && expires <= now;
}

export function maskSecret(token: string): string {
  const t = token.trim();
  if (t.length <= 4) return "…";
  return `…${t.slice(-4)}`;
}

export function parseOauthToken(
  payload: unknown,
  now = Date.now(),
  opts: { requireRefresh?: boolean; previousRefresh?: string; defaultExpiresIn?: number } = {},
): { ok: true; access: string; refresh: string; expires: number } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") return { ok: false, error: "invalid token response" };
  const rec = payload as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof rec.access_token !== "string" || !rec.access_token) return { ok: false, error: "token response missing access_token" };
  const refresh =
    typeof rec.refresh_token === "string" && rec.refresh_token
      ? rec.refresh_token
      : opts.previousRefresh ?? "";
  if (!refresh && opts.requireRefresh !== false) return { ok: false, error: "token response missing refresh_token" };
  let expiresIn = typeof rec.expires_in === "number" ? rec.expires_in : Number(rec.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    if (opts.defaultExpiresIn && opts.defaultExpiresIn > 0) expiresIn = opts.defaultExpiresIn;
    else return { ok: false, error: "token response missing expires_in" };
  }
  return {
    ok: true,
    access: rec.access_token,
    refresh,
    expires: now + expiresIn * 1000 - EXPIRE_MARGIN_MS,
  };
}

export function parseTokenResponse(
  payload: unknown,
  now = Date.now(),
): { ok: true; access: string; refresh: string; expires: number } | { ok: false; error: string } {
  return parseOauthToken(payload, now, { requireRefresh: true });
}

type AuthFile = Record<string, unknown>;

let cached: { path: string; mtimeMs: number; data: AuthFile } | null = null;
const refreshFlights = new Map<string, Promise<{ ok: true } | { ok: false; error: string }>>();

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function extraApiUrl(entry: Record<string, unknown>): string | null {
  const raw = typeof entry.apiUrl === "string" ? entry.apiUrl.trim() : "";
  return raw ? validateCopilotApiUrl(raw) : null;
}

export function validateCopilotApiUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (testLoopbackOverride("TERMINA_TEST_COPILOT_TOKEN_URL")) return `${url.origin}${url.pathname}`.replace(/\/$/, "");
    if (url.protocol !== "https:") return null;
    const host = url.hostname;
    if (host !== "api.githubcopilot.com" && !host.endsWith(".githubcopilot.com")) return null;
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function sleepAsync(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("login cancelled"));
      return;
    }
    const onDone = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const t = setTimeout(onDone, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const MAX_AUTH_LOCK_BYTES = 1024;
const AUTH_LOCK_EMPTY_GRACE_MS = 250;
const AUTH_LOCK_CANDIDATE_PREFIX = ".auth-lock-candidate-";

const CURRENT_AUTH_PROCESS_IDENTITY = readSystemProcessIdentity(process.pid)
  ?? `self:${randomBytes(16).toString("hex")}`;

function observedAuthProcessIdentity(pid: number): string | null {
  return pid === process.pid ? CURRENT_AUTH_PROCESS_IDENTITY : readSystemProcessIdentity(pid);
}

type AuthLockOwner = {
  pid: number;
  token: string;
  startedAt: number;
  processIdentity: string;
  dev: number;
  ino: number;
};

type AuthLockDirectory = {
  dev: number;
  ino: number;
};

type AuthLockHandle = {
  owner: AuthLockOwner;
  directory: AuthLockDirectory;
  ownerPath: string;
  guardPath: string;
  witnessFd: number | null;
  guardPresent: boolean;
};

type AuthLockTransitionPhase = "released" | "recovered";

type AuthLockTransition = {
  phase: AuthLockTransitionPhase;
  owner: AuthLockOwner;
  directory: AuthLockDirectory;
  recordPath: string;
  guardPath: string;
  guardPresent: boolean;
};

function lockErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function authLockOwner(value: unknown): AuthLockOwner | null {
  if (!isObject(value)) return null;
  const pid = value.pid;
  const token = value.token;
  const startedAt = value.startedAt;
  const processIdentity = value.processIdentity;
  const dev = value.dev;
  const ino = value.ino;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) return null;
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0) return null;
  if (typeof processIdentity !== "string" || !/^[\x20-\x7e]{1,256}$/.test(processIdentity)) return null;
  if (typeof dev !== "number" || !Number.isSafeInteger(dev) || dev < 0) return null;
  if (typeof ino !== "number" || !Number.isSafeInteger(ino) || ino < 0) return null;
  return { pid, token, startedAt, processIdentity, dev, ino };
}

function authLockOwnerEntry(owner: Pick<AuthLockOwner, "token" | "dev" | "ino">): string {
  return `.record-${owner.token}-${owner.dev}-${owner.ino}`;
}

function authLockOwnerPath(lock: string, owner: Pick<AuthLockOwner, "token" | "dev" | "ino">): string {
  return join(lock, authLockOwnerEntry(owner));
}

function authLockGuardPath(lock: string, owner: Pick<AuthLockOwner, "token" | "dev" | "ino">): string {
  return join(lock, `.owner-${owner.token}-${owner.dev}-${owner.ino}`);
}

function authLockWitnessPath(lock: string, owner: Pick<AuthLockOwner, "token" | "dev" | "ino">): string {
  return join(authLockGuardPath(lock, owner), "witness");
}

function authLockCandidatePath(lock: string, token: string): string {
  return join(dirname(lock), `${AUTH_LOCK_CANDIDATE_PREFIX}${process.pid}-${token}`);
}

function authLockNoFollowFlags(base: number): number {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("auth lock requires O_NOFOLLOW support");
  return base | noFollow;
}

function authDirectoryOpenFlags(): number {
  const directory = fsConstants.O_DIRECTORY;
  if (typeof directory !== "number") throw new Error("auth lock requires directory descriptor support");
  return authLockNoFollowFlags(fsConstants.O_RDONLY | directory);
}

type AuthLockGuardState = "missing" | "empty" | "present" | "invalid";

function authLockGuardState(path: string): AuthLockGuardState {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "invalid";
    const entries = readdirSync(path);
    if (entries.length === 0) return "empty";
    if (entries.length !== 1 || entries[0] !== "witness") return "invalid";
    const witness = lstatSync(join(path, "witness"));
    if (
      !witness.isFIFO()
      || witness.isSymbolicLink()
      || witness.nlink !== 1
      || (witness.mode & 0o777) !== 0o600
    ) return "invalid";
    return "present";
  } catch (error) {
    return lockErrorCode(error) === "ENOENT" || lockErrorCode(error) === "ENOTDIR" ? "missing" : "invalid";
  }
}

function authLockTransitionGuardPath(
  lock: string,
  phase: AuthLockTransitionPhase,
  owner: Pick<AuthLockOwner, "token" | "dev" | "ino">,
): string {
  return join(lock, `.${phase}-holder-${owner.token}-${owner.dev}-${owner.ino}`);
}

function removeAuthLockWitness(guardPath: string): void {
  const witnessPath = join(guardPath, "witness");
  const witness = lstatSync(witnessPath);
  if (
    !witness.isFIFO()
    || witness.isSymbolicLink()
    || witness.nlink !== 1
    || (witness.mode & 0o777) !== 0o600
  ) throw new Error("auth lock witness changed while releasing");
  unlinkSync(witnessPath);
}

function createAuthLockWitness(path: string): number {
  execFileSync("/usr/bin/mkfifo", ["-m", "0600", path], { stdio: "ignore" });
  let fd: number | null = null;
  let keep = false;
  try {
    fd = openSync(path, authLockNoFollowFlags(fsConstants.O_RDONLY | fsConstants.O_NONBLOCK));
    const descriptor = fstatSync(fd);
    const entry = lstatSync(path);
    if (
      !descriptor.isFIFO()
      || !entry.isFIFO()
      || entry.isSymbolicLink()
      || (descriptor.mode & 0o777) !== 0o600
      || (entry.mode & 0o777) !== 0o600
      || descriptor.dev !== entry.dev
      || descriptor.ino !== entry.ino
    ) throw new Error("auth lock witness is not a private FIFO");
    const result = fd;
    fd = null;
    keep = true;
    return result;
  } finally {
    if (fd !== null) closeSync(fd);
    if (!keep) {
      try {
        const entry = lstatSync(path);
        if (entry.isFIFO() && entry.nlink === 1 && (entry.mode & 0o777) === 0o600) unlinkSync(path);
      } catch {
        /* Leave an unproven witness in place rather than unlinking another object. */
      }
    }
  }
}

function probeAuthLockWitnessPath(path: string): boolean | null {
  try {
    const entry = lstatSync(path);
    if (
      !entry.isFIFO()
      || entry.isSymbolicLink()
      || entry.nlink !== 1
      || (entry.mode & 0o777) !== 0o600
    ) return null;
    const fd = openSync(path, authLockNoFollowFlags(fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
    try {
      const descriptor = fstatSync(fd);
      return descriptor.isFIFO() && descriptor.dev === entry.dev && descriptor.ino === entry.ino;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = lockErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ENXIO") return false;
    return null;
  }
}

function probeAuthLockWitness(
  lock: string,
  owner: AuthLockOwner,
  guardPath = authLockGuardPath(lock, owner),
): boolean | null {
  return probeAuthLockWitnessPath(join(guardPath, "witness"));
}

function authLockTransitionEntry(
  phase: AuthLockTransitionPhase,
  owner: Pick<AuthLockOwner, "token" | "dev" | "ino">,
): string {
  return `.${phase}-${owner.token}-${owner.dev}-${owner.ino}`;
}

function authLockTransitionPath(
  lock: string,
  phase: AuthLockTransitionPhase,
  owner: Pick<AuthLockOwner, "token" | "dev" | "ino">,
): string {
  return join(lock, authLockTransitionEntry(phase, owner));
}

function parseAuthLockOwnerEntry(name: string): Pick<AuthLockOwner, "token" | "dev" | "ino"> | null {
  const match = /^\.record-([A-Za-z0-9_-]{1,128})-(\d+)-(\d+)$/.exec(name);
  if (match === null) return null;
  const dev = Number(match[2]);
  const ino = Number(match[3]);
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0) return null;
  return { token: match[1], dev, ino };
}

function parseAuthLockTransitionEntry(name: string): {
  phase: AuthLockTransitionPhase;
  token: string | null;
  dev: number | null;
  ino: number | null;
  entry: string;
} | null {
  if (name.startsWith(".released-holder-") || name.startsWith(".recovered-holder-")) return null;
  const generation = /^\.(released|recovered)-([A-Za-z0-9_-]{1,128})-(\d+)-(\d+)$/.exec(name);
  if (generation !== null) {
    const dev = Number(generation[3]);
    const ino = Number(generation[4]);
    if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0) return null;
    return { phase: generation[1] as AuthLockTransitionPhase, token: generation[2], dev, ino, entry: name };
  }
  // Older interrupted releases used a random suffix; accept only that exact
  // shape and still bind the recovered owner to the record and directory.
  const legacy = /^\.(released|recovered)-([0-9a-f]{32})$/.exec(name);
  if (legacy === null) return null;
  return { phase: legacy[1] as AuthLockTransitionPhase, token: null, dev: null, ino: null, entry: name };
}

function authLockDirectory(lock: string): AuthLockDirectory | null {
  try {
    const stat = lstatSync(lock);
    return stat.isDirectory() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

function readAuthLockOwner(path: string): AuthLockOwner | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUTH_LOCK_BYTES) return null;
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_AUTH_LOCK_BYTES) return null;
    return authLockOwner(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function inspectAuthLock(lock: string): AuthLockHandle | null {
  const directory = authLockDirectory(lock);
  if (directory === null) return null;
  try {
    const entries = readdirSync(lock).sort();
    const ownerEntries = entries.map(parseAuthLockOwnerEntry).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (ownerEntries.length !== 1) return null;
    const ownerEntry = ownerEntries[0];
    const ownerPath = authLockOwnerPath(lock, ownerEntry);
    const owner = readAuthLockOwner(ownerPath);
    const guardPath = authLockGuardPath(lock, ownerEntry);
    const guardEntry = guardPath.slice(lock.length + 1);
    const guardPresent =
      entries.length === 2
      && entries.includes(guardEntry)
      && authLockGuardState(guardPath) === "present";
    if (
      owner === null
      || owner.token !== ownerEntry.token
      || owner.dev !== ownerEntry.dev
      || owner.ino !== ownerEntry.ino
      || owner.dev !== directory.dev
      || owner.ino !== directory.ino
      || !guardPresent
    ) return null;
    return { owner, directory, ownerPath, guardPath, witnessFd: null, guardPresent };
  } catch {
    return null;
  }
}

function inspectAuthLockTransition(lock: string): AuthLockTransition | null {
  const directory = authLockDirectory(lock);
  if (directory === null) return null;
  try {
    const entries = readdirSync(lock).sort();
    const transitions = entries.map(parseAuthLockTransitionEntry).filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null,
    );
    if (transitions.length !== 1) return null;
    const transition = transitions[0];
    const recordPath = join(lock, transition.entry);
    const owner = readAuthLockOwner(recordPath);
    if (owner === null || owner.dev !== directory.dev || owner.ino !== directory.ino) return null;
    if (
      transition.token !== null
      && (owner.token !== transition.token || owner.dev !== transition.dev || owner.ino !== transition.ino)
    ) return null;
    const guardPath = authLockGuardPath(lock, owner);
    const holderPath = authLockTransitionGuardPath(lock, transition.phase, owner);
    const guardCandidates = [guardPath, holderPath].filter((candidate) => entries.includes(candidate.slice(lock.length + 1)));
    if (entries.length === 1) {
      return { phase: transition.phase, owner, directory, recordPath, guardPath, guardPresent: false };
    }
    if (entries.length !== 2 || guardCandidates.length !== 1) return null;
    const actualGuardPath = guardCandidates[0];
    const guardState = authLockGuardState(actualGuardPath);
    if (guardState !== "present" && guardState !== "empty") return null;
    return {
      phase: transition.phase,
      owner,
      directory,
      recordPath,
      guardPath: actualGuardPath,
      guardPresent: guardState === "present",
    };
  } catch {
    return null;
  }
}

function sameAuthLockOwner(left: AuthLockOwner, right: AuthLockOwner): boolean {
  return (
    left.pid === right.pid
    && left.token === right.token
    && left.startedAt === right.startedAt
    && left.processIdentity === right.processIdentity
    && left.dev === right.dev
    && left.ino === right.ino
  );
}

function sameAuthLockDirectory(left: AuthLockDirectory, right: AuthLockDirectory): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function authLockOwnerAlive(
  lock: string,
  owner: AuthLockOwner,
  guardPath = authLockGuardPath(lock, owner),
): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return lockErrorCode(error) !== "ESRCH";
  }
  const actualIdentity = observedAuthProcessIdentity(owner.pid);
  // An unreadable birth identity is uncertainty, not proof of death.
  if (actualIdentity === null) return true;
  if (actualIdentity !== owner.processIdentity) return false;
  // The process-birth token is only a coarse fallback on macOS (ps lstart has
  // one-second resolution). A holder FIFO is the generation-bound proof that
  // this process still owns this exact lock; a reused PID cannot satisfy it.
  const witness = probeAuthLockWitness(lock, owner, guardPath);
  return witness !== false;
}

type AuthLockCrashStage =
  | "release-before-guard-removal"
  | "release-after-guard-removal"
  | "recover-before-guard-removal"
  | "recover-after-guard-removal";

function maybeCrashAuthLock(stage: AuthLockCrashStage): void {
  if (process.env.TERMINA_CORE_TEST !== "1" || process.env.TERMINA_AUTH_LOCK_CRASH !== stage) return;
  process.kill(process.pid, "SIGKILL");
}

function maybePauseAuthLock(stage: "before-publish"): void {
  if (process.env.TERMINA_CORE_TEST !== "1" || process.env.TERMINA_AUTH_LOCK_PAUSE !== stage) return;
  const marker = process.env.TERMINA_AUTH_LOCK_PAUSED?.trim();
  const resume = process.env.TERMINA_AUTH_LOCK_RESUME?.trim();
  if (!marker || !resume) throw new Error("auth lock pause requires marker and resume paths");
  writeFileSync(marker, "paused\n", { mode: 0o600, flag: "wx" });
  while (!existsSync(resume)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

function removeEmptyAuthLock(lock: string, directory: AuthLockDirectory): boolean {
  const currentDirectory = authLockDirectory(lock);
  if (currentDirectory === null) return true;
  if (!sameAuthLockDirectory(currentDirectory, directory)) return false;
  try {
    if (readdirSync(lock).length !== 0) return false;
    rmdirSync(lock);
    return true;
  } catch (error) {
    return lockErrorCode(error) === "ENOENT";
  }
}

function recoverEmptyAuthLock(lock: string): boolean {
  const directory = authLockDirectory(lock);
  if (directory === null) return false;
  let birthtimeMs: number;
  let ctimeMs: number;
  try {
    const initial = lstatSync(lock);
    if (!initial.isDirectory() || initial.isSymbolicLink() || readdirSync(lock).length !== 0) return false;
    birthtimeMs = initial.birthtimeMs;
    ctimeMs = initial.ctimeMs;
    if (!Number.isFinite(birthtimeMs) || !Number.isFinite(ctimeMs)) return false;
    const age = Date.now() - Math.max(birthtimeMs, ctimeMs);
    if (age < AUTH_LOCK_EMPTY_GRACE_MS) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, AUTH_LOCK_EMPTY_GRACE_MS - Math.max(0, age));
    }
  } catch {
    return false;
  }
  try {
    const current = lstatSync(lock);
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== directory.dev
      || current.ino !== directory.ino
      || current.birthtimeMs !== birthtimeMs
      || current.ctimeMs !== ctimeMs
      || readdirSync(lock).length !== 0
    ) return false;
  } catch {
    return false;
  }
  return removeEmptyAuthLock(lock, directory);
}

function cleanupAuthLockTransition(lock: string, expected: AuthLockTransition, witnessFd: number | null = null): boolean {
  const current = inspectAuthLockTransition(lock);
  if (
    current === null
    || current.phase !== expected.phase
    || !sameAuthLockDirectory(current.directory, expected.directory)
    || !sameAuthLockOwner(current.owner, expected.owner)
    || current.recordPath !== expected.recordPath
  ) return false;
  let heldWitnessFd = witnessFd;
  try {
    const guardState = authLockGuardState(current.guardPath);
    if (guardState === "present") {
      removeAuthLockWitness(current.guardPath);
      if (heldWitnessFd !== null) {
        closeSync(heldWitnessFd);
        heldWitnessFd = null;
      }
      rmdirSync(current.guardPath);
    } else if (guardState === "empty") {
      if (heldWitnessFd !== null) {
        closeSync(heldWitnessFd);
        heldWitnessFd = null;
      }
      rmdirSync(current.guardPath);
    } else if (guardState !== "missing") {
      return false;
    }
    const afterGuard = inspectAuthLockTransition(lock);
    if (afterGuard === null) return removeEmptyAuthLock(lock, expected.directory);
    if (
      afterGuard.guardPresent
      || authLockGuardState(afterGuard.guardPath) !== "missing"
      || afterGuard.phase !== expected.phase
      || !sameAuthLockDirectory(afterGuard.directory, expected.directory)
      || !sameAuthLockOwner(afterGuard.owner, expected.owner)
      || afterGuard.recordPath !== expected.recordPath
    ) return false;
    unlinkSync(afterGuard.recordPath);
    return removeEmptyAuthLock(lock, expected.directory);
  } catch (error) {
    return lockErrorCode(error) === "ENOENT" && removeEmptyAuthLock(lock, expected.directory);
  } finally {
    if (heldWitnessFd !== null) {
      try { closeSync(heldWitnessFd); } catch { /* best effort after a failed cleanup */ }
    }
  }
}

function resumeAuthLock(lock: string): boolean {
  const transition = inspectAuthLockTransition(lock);
  if (transition !== null) {
    if (authLockOwnerAlive(lock, transition.owner, transition.guardPath)) return false;
    return cleanupAuthLockTransition(lock, transition);
  }
  return recoverEmptyAuthLock(lock);
}

function releaseAuthLock(lock: string, handle: AuthLockHandle): void {
  const { owner, directory } = handle;
  try {
    const current = inspectAuthLock(lock);
    if (
      current === null
      || !sameAuthLockDirectory(current.directory, directory)
      || !sameAuthLockOwner(current.owner, owner)
      || current.ownerPath !== handle.ownerPath
    ) return;
    if (!current.guardPresent) {
      unlinkSync(current.ownerPath);
      removeEmptyAuthLock(lock, directory);
      return;
    }
    const releasedOwner = authLockTransitionPath(lock, "released", owner);
    renameSync(current.ownerPath, releasedOwner);
    const moved = readAuthLockOwner(releasedOwner);
    if (moved === null || !sameAuthLockOwner(moved, owner)) return;
    const transition: AuthLockTransition = {
      phase: "released",
      owner,
      directory,
      recordPath: releasedOwner,
      guardPath: authLockTransitionGuardPath(lock, "released", owner),
      guardPresent: true,
    };
    maybeCrashAuthLock("release-before-guard-removal");
    renameSync(current.guardPath, transition.guardPath);
    maybeCrashAuthLock("release-after-guard-removal");
    handle.guardPresent = true;
    cleanupAuthLockTransition(lock, transition, handle.witnessFd);
    handle.witnessFd = null;
  } catch {
    /* A replacement or extra entry leaves the lock in place. */
  }
}

function recoverAuthLock(lock: string, stale: AuthLockHandle): boolean {
  if (!sameAuthLockDirectory(authLockDirectory(lock) ?? { dev: -1, ino: -1 }, stale.directory)) return false;
  const recoveredOwner = authLockTransitionPath(lock, "recovered", stale.owner);
  try {
    renameSync(stale.ownerPath, recoveredOwner);
  } catch (error) {
    return lockErrorCode(error) === "ENOENT";
  }
  const moved = readAuthLockOwner(recoveredOwner);
  const currentDirectory = authLockDirectory(lock);
  if (
    moved === null
    || !sameAuthLockOwner(moved, stale.owner)
    || currentDirectory === null
    || !sameAuthLockDirectory(currentDirectory, stale.directory)
  ) return false;
  const transition: AuthLockTransition = {
    phase: "recovered",
    owner: stale.owner,
    directory: stale.directory,
    recordPath: recoveredOwner,
    guardPath: authLockTransitionGuardPath(lock, "recovered", stale.owner),
    guardPresent: stale.guardPresent,
  };
  try {
    maybeCrashAuthLock("recover-before-guard-removal");
    if (stale.guardPresent) renameSync(stale.guardPath, transition.guardPath);
    maybeCrashAuthLock("recover-after-guard-removal");
  } catch {
    return false;
  }
  return cleanupAuthLockTransition(lock, transition);
}

function cleanupAuthLockCandidate(
  candidate: string,
  directory: AuthLockDirectory,
  owner: AuthLockOwner,
  witnessFd: number | null,
): void {
  if (witnessFd !== null) {
    try { closeSync(witnessFd); } catch { /* best effort before exact path cleanup */ }
  }
  try {
    const currentDirectory = authLockDirectory(candidate);
    if (currentDirectory === null || !sameAuthLockDirectory(currentDirectory, directory)) return;
    const guardPath = authLockGuardPath(candidate, owner);
    const guardState = authLockGuardState(guardPath);
    if (guardState === "present") removeAuthLockWitness(guardPath);
    if (guardState === "present" || guardState === "empty") rmdirSync(guardPath);
    const ownerPath = authLockOwnerPath(candidate, owner);
    const currentOwner = readAuthLockOwner(ownerPath);
    if (currentOwner !== null && sameAuthLockOwner(currentOwner, owner)) unlinkSync(ownerPath);
    removeEmptyAuthLock(candidate, directory);
  } catch {
    /* Never remove a path whose ownership cannot be proven. */
  }
}

function tryAcquireAuthLock(lock: string, binding: AuthPathBinding): AuthLockHandle | null {
  let candidate: string;
  let candidateToken: string;
  for (;;) {
    candidateToken = randomBytes(16).toString("hex");
    candidate = authLockCandidatePath(lock, candidateToken);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      break;
    } catch (error) {
      if (lockErrorCode(error) === "EEXIST") continue;
      throw error;
    }
  }

  const directory = authLockDirectory(candidate);
  if (directory === null) throw new Error("auth file busy");
  const owner: AuthLockOwner = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    startedAt: Date.now(),
    processIdentity: CURRENT_AUTH_PROCESS_IDENTITY,
    dev: directory.dev,
    ino: directory.ino,
  };
  const ownerPath = authLockOwnerPath(candidate, owner);
  const guardPath = authLockGuardPath(candidate, owner);
  let witnessFd: number | null = null;
  let published = false;
  let handedOff = false;
  try {
    validateAuthPathBinding(binding);
    writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    mkdirSync(guardPath, { mode: 0o700 });
    witnessFd = createAuthLockWitness(authLockWitnessPath(candidate, owner));
    maybePauseAuthLock("before-publish");
    validateAuthPathBinding(binding);
    try {
      renameSync(candidate, lock);
    } catch (error) {
      const code = lockErrorCode(error);
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "ENOTDIR") return null;
      throw error;
    }
    published = true;
    const inspected = inspectAuthLock(lock);
    if (
      inspected === null
      || !sameAuthLockDirectory(inspected.directory, directory)
      || !sameAuthLockOwner(inspected.owner, owner)
    ) throw new Error("auth file busy");
    handedOff = true;
    return {
      owner,
      directory,
      ownerPath: authLockOwnerPath(lock, owner),
      guardPath: authLockGuardPath(lock, owner),
      witnessFd,
      guardPresent: true,
    };
  } finally {
    if (!handedOff) {
      if (!published) {
        cleanupAuthLockCandidate(candidate, directory, owner, witnessFd);
      } else if (witnessFd !== null) {
        try { closeSync(witnessFd); } catch { /* leave the published generation fail-closed */ }
      }
      witnessFd = null;
    }
  }
}

function withLock<T>(fn: (binding: AuthPathBinding) => T): T {
  const path = resolve(authPath());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const binding = authPathBinding(path);
  const lock = `${path}.lock`;
  for (;;) {
    try {
      validateAuthPathBinding(binding);
      const acquired = tryAcquireAuthLock(lock, binding);
      if (acquired !== null) {
        try {
          return fn(binding);
        } finally {
          releaseAuthLock(lock, acquired);
        }
      }
    } catch (error) {
      if (lockErrorCode(error) !== null || error instanceof Error) {
        if (!(error instanceof Error) || error.message !== "auth file busy") throw error;
      } else {
        throw error;
      }
    }
    const inspected = inspectAuthLock(lock);
    if (inspected === null) {
      if (resumeAuthLock(lock)) continue;
      throw new Error("auth file busy");
    }
    if (inspected.owner.pid === process.pid || authLockOwnerAlive(lock, inspected.owner)) {
      throw new Error("auth file busy");
    }
    if (!recoverAuthLock(lock, inspected)) throw new Error("auth file busy");
  }
}

export function readAuth(): { ok: true; data: AuthFile } | { ok: false; reason: "missing" | "corrupt" } {
  const path = resolve(authPath());
  if (!existsSync(path)) {
    cached = null;
    return { ok: false, reason: "missing" };
  }
  try {
    const st = statSync(path);
    if (cached && cached.path === path && cached.mtimeMs === st.mtimeMs) return { ok: true, data: cached.data };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isObject(parsed)) {
      cached = null;
      return { ok: false, reason: "corrupt" };
    }
    cached = { path, mtimeMs: st.mtimeMs, data: parsed };
    return { ok: true, data: parsed };
  } catch {
    cached = null;
    return { ok: false, reason: "corrupt" };
  }
}

type AuthPathIdentity = {
  dev: number;
  ino: number;
};

type AuthPathBinding = {
  path: string;
  parent: string;
  root: string;
  parentIdentity: AuthPathIdentity;
  rootIdentity: AuthPathIdentity;
};

function authPathDirectoryIdentity(path: string, label: string): AuthPathIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`auth ${label} must be a real directory`);
  return { dev: stat.dev, ino: stat.ino };
}

function sameAuthPathIdentity(left: AuthPathIdentity, right: AuthPathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function authPathBinding(path: string): AuthPathBinding {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const root = dirname(parent);
  return {
    path: absolute,
    parent,
    root,
    parentIdentity: authPathDirectoryIdentity(parent, "parent"),
    rootIdentity: authPathDirectoryIdentity(root, "root"),
  };
}

function validateAuthPathBinding(binding: AuthPathBinding): void {
  const parentIdentity = authPathDirectoryIdentity(binding.parent, "parent");
  const rootIdentity = authPathDirectoryIdentity(binding.root, "root");
  if (
    !sameAuthPathIdentity(parentIdentity, binding.parentIdentity)
    || !sameAuthPathIdentity(rootIdentity, binding.rootIdentity)
  ) throw new Error("auth path parent changed while writing");
}

type AuthPathAnchors = {
  rootFd: number;
  parentFd: number;
  rootIdentity: AuthPathIdentity;
  parentIdentity: AuthPathIdentity;
};

function authDescriptorPath(fd: number): string {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  throw new Error("auth path descriptor anchoring is unavailable");
}

function authAnchoredChildPath(fd: number, child: string): string {
  const directory = authDescriptorPath(fd);
  return child ? join(directory, child) : directory;
}

function authChildPath(binding: AuthPathBinding, anchors: AuthPathAnchors, child: string): string {
  // Linux exposes a traversable procfs descriptor namespace. macOS's fdescfs
  // permits duplicating /dev/fd/N but does not permit traversing it, so retain
  // the parent descriptor and revalidate the pathname around each operation.
  return process.platform === "linux"
    ? authAnchoredChildPath(anchors.parentFd, child)
    : join(binding.parent, child);
}

function authDirectoryDescriptorIdentity(fd: number, label: string): AuthPathIdentity {
  const stat = fstatSync(fd);
  if (!stat.isDirectory()) throw new Error(`auth ${label} descriptor is not a directory`);
  return { dev: stat.dev, ino: stat.ino };
}

function validateAuthPathAnchors(binding: AuthPathBinding, anchors: AuthPathAnchors): void {
  const rootDescriptor = authDirectoryDescriptorIdentity(anchors.rootFd, "root");
  const parentDescriptor = authDirectoryDescriptorIdentity(anchors.parentFd, "parent");
  const rootPath = authPathDirectoryIdentity(binding.root, "root");
  const parentPath = authPathDirectoryIdentity(binding.parent, "parent");
  const parentFromRootStat = lstatSync(
    process.platform === "linux"
      ? authAnchoredChildPath(anchors.rootFd, basename(binding.parent))
      : binding.parent,
  );
  if (
    !sameAuthPathIdentity(rootDescriptor, binding.rootIdentity)
    || !sameAuthPathIdentity(parentDescriptor, binding.parentIdentity)
    || !sameAuthPathIdentity(rootPath, binding.rootIdentity)
    || !sameAuthPathIdentity(parentPath, binding.parentIdentity)
    || !parentFromRootStat.isDirectory()
    || parentFromRootStat.isSymbolicLink()
    || parentFromRootStat.dev !== binding.parentIdentity.dev
    || parentFromRootStat.ino !== binding.parentIdentity.ino
  ) throw new Error("auth path parent changed while writing");
}

function openAuthPathAnchors(binding: AuthPathBinding): AuthPathAnchors {
  let rootFd: number | null = null;
  let parentFd: number | null = null;
  try {
    rootFd = openSync(binding.root, authDirectoryOpenFlags());
    const rootIdentity = authDirectoryDescriptorIdentity(rootFd, "root");
    parentFd = openSync(
      process.platform === "linux"
        ? authAnchoredChildPath(rootFd, basename(binding.parent))
        : binding.parent,
      authDirectoryOpenFlags(),
    );
    const parentIdentity = authDirectoryDescriptorIdentity(parentFd, "parent");
    const anchors = { rootFd, parentFd, rootIdentity, parentIdentity };
    validateAuthPathAnchors(binding, anchors);
    return anchors;
  } catch (error) {
    if (parentFd !== null) closeSync(parentFd);
    if (rootFd !== null) closeSync(rootFd);
    throw error;
  }
}

function closeAuthPathAnchors(anchors: AuthPathAnchors): void {
  try { closeSync(anchors.parentFd); } finally { closeSync(anchors.rootFd); }
}

function validateAuthTempDescriptor(
  fd: number,
  tempPath: string,
  binding: AuthPathBinding,
  anchors: AuthPathAnchors,
  expected: AuthPathIdentity | null,
): AuthPathIdentity {
  validateAuthPathAnchors(binding, anchors);
  const descriptor = fstatSync(fd);
  if (!descriptor.isFile()) throw new Error("auth temporary file is not regular");
  if (descriptor.nlink !== 1) throw new Error("auth temp has unexpected hard links");
  if ((descriptor.mode & 0o777) !== 0o600) throw new Error("auth temporary file permissions changed");
  const identity = { dev: descriptor.dev, ino: descriptor.ino };
  if (expected !== null && !sameAuthPathIdentity(identity, expected)) {
    throw new Error("auth temporary file changed while writing");
  }
  const entry = lstatSync(tempPath);
  if (
    !entry.isFile()
    || entry.isSymbolicLink()
    || entry.nlink !== 1
    || (entry.mode & 0o777) !== 0o600
    || entry.dev !== identity.dev
    || entry.ino !== identity.ino
  ) throw new Error("auth temporary file changed while writing");
  return identity;
}

function truncateAuthDescriptor(fd: number): void {
  try {
    ftruncateSync(fd, 0);
    fsyncSync(fd);
  } catch {
    /* Keep the original descriptor open for exact cleanup; callers fail closed. */
  }
}

type AuthWriteTestStage = "after-open" | "after-fsync" | "after-temp";

function maybeCrashAuthWrite(stage: AuthWriteTestStage): void {
  if (process.env.TERMINA_CORE_TEST !== "1" || process.env.TERMINA_AUTH_WRITE_CRASH !== stage) return;
  process.kill(process.pid, "SIGKILL");
}

function maybePauseAuthWrite(stage: AuthWriteTestStage): void {
  if (process.env.TERMINA_CORE_TEST !== "1" || process.env.TERMINA_AUTH_WRITE_PAUSE !== stage) return;
  const marker = process.env.TERMINA_AUTH_WRITE_PAUSED?.trim();
  const resume = process.env.TERMINA_AUTH_WRITE_RESUME?.trim();
  if (!marker || !resume) throw new Error("auth write pause requires marker and resume paths");
  writeFileSync(marker, "paused\n", { mode: 0o600, flag: "wx" });
  while (!existsSync(resume)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

function writeAuth(data: AuthFile, binding: AuthPathBinding): void {
  const path = binding.path;
  validateAuthPathBinding(binding);
  const tmp = join(binding.parent, `.${basename(path)}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`);
  const anchoredTempName = basename(tmp);
  const anchoredDestinationName = basename(path);
  const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8");
  const anchors = openAuthPathAnchors(binding);
  const tempPath = authChildPath(binding, anchors, anchoredTempName);
  const destinationPath = authChildPath(binding, anchors, anchoredDestinationName);
  let fd: number | null = null;
  let tempCreated = false;
  let tempIdentity: AuthPathIdentity | null = null;
  let published = false;
  try {
    fd = openSync(
      tempPath,
      authLockNoFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    tempCreated = true;
    tempIdentity = validateAuthTempDescriptor(fd, tempPath, binding, anchors, null);
    maybePauseAuthWrite("after-open");
    tempIdentity = validateAuthTempDescriptor(fd, tempPath, binding, anchors, tempIdentity);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("auth temporary file write made no progress");
      offset += written;
    }
    fsyncSync(fd);
    maybeCrashAuthWrite("after-fsync");
    maybePauseAuthWrite("after-temp");
    validateAuthTempDescriptor(fd, tempPath, binding, anchors, tempIdentity);
    renameSync(tempPath, destinationPath);
    validateAuthPathAnchors(binding, anchors);
    const destination = lstatSync(destinationPath);
    const afterPublish = fstatSync(fd);
    if (
      !destination.isFile()
      || destination.isSymbolicLink()
      || destination.nlink !== 1
      || (destination.mode & 0o777) !== 0o600
      || tempIdentity === null
      || destination.dev !== tempIdentity.dev
      || destination.ino !== tempIdentity.ino
      || !afterPublish.isFile()
      || afterPublish.nlink !== 1
      || afterPublish.dev !== tempIdentity.dev
      || afterPublish.ino !== tempIdentity.ino
    ) throw new Error("auth published file identity changed");
    published = true;
  } finally {
    if (fd !== null && !published) truncateAuthDescriptor(fd);
    if (tempCreated && !published && tempIdentity !== null) {
      try {
        const current = lstatSync(tempPath);
        if (
          current.isFile()
          && !current.isSymbolicLink()
          && current.dev === tempIdentity.dev
          && current.ino === tempIdentity.ino
        ) unlinkSync(tempPath);
      } catch {
        /* Leave an unproven residue in place rather than unlinking another object. */
      }
    }
    if (fd !== null) closeSync(fd);
    closeAuthPathAnchors(anchors);
  }
  try {
    const st = statSync(path);
    cached = { path, mtimeMs: st.mtimeMs, data };
  } catch {
    cached = { path, mtimeMs: Date.now(), data };
  }
}

export function modifyProvider(id: string, fn: (current: unknown) => unknown | null): void {
  withLock((binding) => {
    const got = readAuth();
    if (!got.ok && got.reason === "corrupt") {
      throw new Error("auth.json is unreadable — refusing to write");
    }
    const data: AuthFile = got.ok ? { ...got.data } : {};
    const next = fn(data[id]);
    if (next === null) delete data[id];
    else data[id] = next;
    writeAuth(data, binding);
  });
}

export type ResolvedAuth =
  | {
      ok: true;
      providerId: ProviderId;
      token: string;
      kind: "oauth" | "api_key";
      source: "oauth" | "api_key" | "env";
      envName?: string;
      baseUrl: string;
      headers: Record<string, string>;
    }
  | { ok: false; error: string };

const DEFAULT_BASE: Record<ProviderId, string> = {
  anthropic: DEFAULT_ANTHROPIC_BASE,
  openai: "https://api.openai.com/v1",
  "openai-codex": "https://chatgpt.com/backend-api",
  "github-copilot": "https://api.individual.githubcopilot.com",
  xai: "https://api.x.ai/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
  "opencode-zen": "https://opencode.ai/zen/v1",
};

const BASE_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  xai: "XAI_BASE_URL",
  openrouter: "OPENROUTER_BASE_URL",
};

const ENV_KEYS: Record<ProviderId, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  "openai-codex": [],
  "github-copilot": [],
  xai: ["XAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "opencode-go": ["OPENCODE_GO_API_KEY"],
  "opencode-zen": ["OPENCODE_API_KEY"],
};

export const DEFAULT_MODELS: Record<ProviderId, { main: string; summary: string }> = {
  anthropic: { main: "claude-sonnet-5", summary: "claude-haiku-4-5" },
  openai: { main: "gpt-5.6-sol", summary: "gpt-5.6-luna" },
  "openai-codex": { main: "gpt-5.6-sol", summary: "gpt-5.6-luna" },
  "github-copilot": { main: "gpt-5.6-terra", summary: "gpt-5.6-luna" },
  xai: { main: "grok-4.6", summary: "grok-4.6" },
  google: { main: "gemini-3.7-flash", summary: "gemini-3.5-flash-lite" },
  openrouter: { main: "openai/gpt-5.6-terra", summary: "openai/gpt-5.6-luna" },
  "opencode-go": { main: "glm-5.1", summary: "glm-5.1" },
  "opencode-zen": { main: "gpt-5.6-sol", summary: "gpt-5.6-luna" },
};

export function parseModelRef(
  raw: string,
  override?: string,
): { provider: ProviderId; model: string } {
  const trimmed = raw.trim();
  if (override && isSupportedProvider(override)) {
    const prefix = `${override}/`;
    const model = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
    return { provider: override, model: model || DEFAULT_MODELS[override].main };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const head = trimmed.slice(0, slash);
    if (isSupportedProvider(head)) {
      return { provider: head, model: trimmed.slice(slash + 1) };
    }
  }
  if (trimmed.startsWith("claude") || trimmed.startsWith("haiku")) return { provider: "anthropic", model: trimmed };
  if (trimmed.startsWith("grok")) return { provider: "xai", model: trimmed };
  if (trimmed.startsWith("gemini") || trimmed.startsWith("gemma")) return { provider: "google", model: trimmed };
  if (/^(gpt-|o1|o3|o4|chatgpt)/.test(trimmed)) return { provider: "openai", model: trimmed };
  return { provider: "anthropic", model: trimmed || DEFAULT_MODELS.anthropic.main };
}

function baseUrl(id: ProviderId): string {
  const envName = BASE_ENV[id];
  if (envName) {
    const raw = process.env[envName]?.trim();
    if (raw) return raw.replace(/\/$/, "");
  }
  return DEFAULT_BASE[id];
}

function envToken(id: ProviderId): { token: string; envName: string } | null {
  for (const name of ENV_KEYS[id]) {
    const value = process.env[name]?.trim();
    if (value) return { token: value, envName: name };
  }
  return null;
}

/** Stored entry exists. Does not refresh and does not consult env. */
export function hasStoredCredential(id: string): boolean {
  if (!isSupportedProvider(id)) return false;
  const got = readAuth();
  if (!got.ok) return false;
  const stored = fromStored(id, got.data[id]);
  if (!stored) return false;
  if ("needsOauthRefresh" in stored) return true;
  return stored.ok;
}

export function hasEnvCredential(id: string): boolean {
  if (!isSupportedProvider(id)) return false;
  return envToken(id) !== null;
}

/** Stored credentials win over ambient env so a leftover ANTHROPIC_API_KEY
 *  does not hide a stored xAI or OpenAI login. */
export function firstAuthenticatedProvider(): ProviderId | null {
  for (const id of AUTH_PROVIDER_ORDER) {
    if (hasStoredCredential(id)) return id;
  }
  for (const id of AUTH_PROVIDER_ORDER) {
    if (hasEnvCredential(id)) return id;
  }
  return null;
}

function fromStored(
  id: ProviderId,
  entry: unknown,
): ResolvedAuth | { needsOauthRefresh: true; refresh: string; extra: Record<string, unknown> } | null {
  if (!isObject(entry) || typeof entry.type !== "string") return null;
  if (entry.type === "api_key") {
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key) return null;
    return {
      ok: true,
      providerId: id,
      token: key,
      kind: "api_key",
      source: "api_key",
      baseUrl: baseUrl(id),
      headers: requestHeaders(id, key, entry),
    };
  }
  if (entry.type === "oauth") {
    const access = typeof entry.access === "string" ? entry.access : "";
    const refresh = typeof entry.refresh === "string" ? entry.refresh : "";
    if (!access || !refresh) return null;
    if (needsRefresh(entry.expires)) return { needsOauthRefresh: true, refresh, extra: entry };
    const storedBase = extraApiUrl(entry);
    return {
      ok: true,
      providerId: id,
      token: access,
      kind: "oauth",
      source: "oauth",
      baseUrl: storedBase || baseUrl(id),
      headers: requestHeaders(id, access, entry),
    };
  }
  return null;
}

export function authBanner(auth: ResolvedAuth): string {
  if (!auth.ok) return "auth: none";
  const who = auth.providerId === "anthropic" ? "" : `${auth.providerId} `;
  if (auth.source === "env") return `auth: ${who}env ${auth.envName ?? ENV_KEYS[auth.providerId][0] ?? "API_KEY"}`.replace("  ", " ");
  if (auth.source === "oauth") return `auth: ${who}oauth (${maskSecret(auth.token)})`.replace("  ", " ");
  return `auth: ${who}api_key (auth.json)`.replace("  ", " ");
}

function missingCredentialError(id: ProviderId): string {
  const env = ENV_KEYS[id][0];
  if (env) return `no ${id} credential — run /login ${id} or set ${env}`;
  return `no ${id} credential — run /login ${id}`;
}

class AuthHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthHttpError";
  }
}

function authHttpError(error: unknown): string | null {
  return error instanceof AuthHttpError ? error.message : null;
}

function isAuthHttpFailure(message: string): boolean {
  return (
    message === AUTH_REQUEST_CANCELLED ||
    message === AUTH_REQUEST_TIMED_OUT ||
    message === AUTH_RESPONSE_TOO_LARGE ||
    message === AUTH_RESPONSE_INVALID_UTF8
  );
}

function authHttpTimeoutMs(): number {
  if (process.env.TERMINA_CORE_TEST === "1") {
    const raw = process.env.TERMINA_TEST_AUTH_HTTP_TIMEOUT_MS?.trim();
    const parsed = raw ? Number(raw) : Number.NaN;
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return AUTH_HTTP_TIMEOUT_MS;
}

type AuthRequestSignal = {
  signal: AbortSignal;
  abortError: () => AuthHttpError | null;
  cleanup: () => void;
};

function authRequestSignal(callerSignal?: AbortSignal): AuthRequestSignal {
  const controller = new AbortController();
  let reason: "cancelled" | "timed-out" | null = null;
  const abortForCaller = () => {
    if (reason !== null) return;
    reason = "cancelled";
    controller.abort();
  };
  if (callerSignal?.aborted) abortForCaller();
  else callerSignal?.addEventListener("abort", abortForCaller, { once: true });
  const timer = setTimeout(() => {
    if (reason !== null) return;
    reason = "timed-out";
    controller.abort();
  }, authHttpTimeoutMs());
  timer.unref?.();
  return {
    signal: controller.signal,
    abortError: () =>
      reason === "cancelled"
        ? new AuthHttpError(AUTH_REQUEST_CANCELLED)
        : reason === "timed-out"
          ? new AuthHttpError(AUTH_REQUEST_TIMED_OUT)
          : null,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortForCaller);
    },
  };
}

async function cancelAuthBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel(AUTH_RESPONSE_TOO_LARGE);
  } catch {
    /* The request may already have closed while cancellation was delivered. */
  }
}

async function readAuthResponse(
  response: Response,
): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  const declaredRaw = response.headers.get("content-length")?.trim() ?? "";
  const declared = /^\d+$/.test(declaredRaw) ? Number(declaredRaw) : Number.NaN;
  if (Number.isSafeInteger(declared) && declared > AUTH_HTTP_MAX_RESPONSE_BYTES) {
    await cancelAuthBody(response.body);
    throw new AuthHttpError(AUTH_RESPONSE_TOO_LARGE);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > AUTH_HTTP_MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel(AUTH_RESPONSE_TOO_LARGE);
          } catch {
            /* The stream may already have closed while cancellation was delivered. */
          }
          throw new AuthHttpError(AUTH_RESPONSE_TOO_LARGE);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AuthHttpError(AUTH_RESPONSE_INVALID_UTF8);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  return { ok: response.ok, status: response.status, payload, raw };
}

async function authFetch(
  url: string,
  init: Omit<RequestInit, "signal">,
  callerSignal?: AbortSignal,
): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  const request = authRequestSignal(callerSignal);
  try {
    const response = await fetch(url, { ...init, signal: request.signal });
    const result = await readAuthResponse(response);
    const aborted = request.abortError();
    if (aborted) throw aborted;
    return result;
  } catch (error) {
    const aborted = request.abortError();
    if (aborted) throw aborted;
    throw error;
  } finally {
    request.cleanup();
  }
}

async function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  return authFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    },
    signal,
  );
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  return authFetch(
    url,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    },
    signal,
  );
}

function persistOauth(
  providerId: ProviderId,
  parsed: { access: string; refresh: string; expires: number },
  extra: Record<string, unknown> = {},
): { ok: true } | { ok: false; error: string } {
  try {
    modifyProvider(providerId, (current) => {
      const cur = isObject(current) ? current : {};
      const accountId =
        providerId === "openai-codex"
          ? extractAccountId(parsed.access) ?? (typeof extra.accountId === "string" ? extra.accountId : undefined)
          : undefined;
      return {
        ...cur,
        ...extra,
        type: "oauth",
        access: parsed.access,
        refresh: parsed.refresh,
        expires: parsed.expires,
        ...(accountId ? { accountId } : {}),
      };
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}

function persistApiKey(providerId: ProviderId, key: string): { ok: true } | { ok: false; error: string } {
  try {
    modifyProvider(providerId, (current) => {
      const cur = isObject(current) ? current : {};
      return { ...cur, type: "api_key", key };
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}

type RefreshResult = { ok: true } | { ok: false; error: string };

async function runRefreshOauth(providerId: ProviderId): Promise<RefreshResult> {
  try {
    const got = readAuth();
    if (!got.ok) return { ok: false, error: "auth expired — run /login" };
    const entry = got.data[providerId];
    if (!isObject(entry) || entry.type !== "oauth" || typeof entry.refresh !== "string") {
      return { ok: false, error: "auth expired — run /login" };
    }
    let parsed: ReturnType<typeof parseOauthToken>;
    let extra: Record<string, unknown> = entry;
    if (providerId === "anthropic") {
      const res = await postJson(tokenUrl(providerId), {
        grant_type: "refresh_token",
        refresh_token: entry.refresh,
        client_id: ANTHROPIC_CLIENT_ID,
      });
      parsed = parseTokenResponse(res.payload);
    } else if (providerId === "openai-codex") {
      const res = await postForm(tokenUrl(providerId), {
        grant_type: "refresh_token",
        refresh_token: entry.refresh,
        client_id: OPENAI_CODEX_CLIENT_ID,
      });
      parsed = parseTokenResponse(res.payload);
    } else if (providerId === "xai") {
      const res = await postForm(tokenUrl(providerId), {
        grant_type: "refresh_token",
        refresh_token: entry.refresh,
        client_id: XAI_CLIENT_ID,
      });
      parsed = parseOauthToken(res.payload, Date.now(), {
        requireRefresh: false,
        previousRefresh: entry.refresh,
        defaultExpiresIn: 3600,
      });
    } else if (providerId === "github-copilot") {
      const session = await exchangeGithubCopilotToken(entry.refresh);
      if (!session.ok) {
        return isAuthHttpFailure(session.error) ? session : { ok: false, error: "auth expired — run /login" };
      }
      parsed = {
        ok: true,
        access: session.access,
        refresh: entry.refresh,
        expires: session.expires,
      };
      extra = { ...entry, apiUrl: session.apiUrl };
    } else {
      return { ok: true };
    }
    if (!parsed.ok) return { ok: false, error: "auth expired — run /login" };
    const stored = persistOauth(providerId, parsed, extra);
    if (!stored.ok) return { ok: false, error: "auth expired — run /login" };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: authHttpError(error) ?? "auth expired — run /login" };
  }
}

function waitForRefresh(flight: Promise<RefreshResult>, signal?: AbortSignal): Promise<RefreshResult> {
  if (!signal) return flight;
  if (signal.aborted) return Promise.resolve({ ok: false, error: AUTH_REQUEST_CANCELLED });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RefreshResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, error: AUTH_REQUEST_CANCELLED });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void flight.then(finish, () => finish({ ok: false, error: "auth expired — run /login" }));
  });
}

/** A caller signal cancels only that wait. The provider-keyed refresh remains
 * internally time-bounded so another caller can safely share the same flight. */
export async function refreshOauth(providerId: string, signal?: AbortSignal): Promise<RefreshResult> {
  if (!isSupportedProvider(providerId)) return { ok: false, error: `unsupported provider: ${providerId}` };
  if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
  let flight = refreshFlights.get(providerId);
  if (!flight) {
    flight = runRefreshOauth(providerId);
    refreshFlights.set(providerId, flight);
    const cleanup = () => {
      if (refreshFlights.get(providerId) === flight) refreshFlights.delete(providerId);
    };
    void flight.then(cleanup, cleanup);
  }
  return waitForRefresh(flight, signal);
}

/** Resolve stored/env credentials, allowing the caller to stop waiting for a
 * required shared OAuth refresh without cancelling other callers. */
export async function resolveAuth(providerId: string = "anthropic", signal?: AbortSignal): Promise<ResolvedAuth> {
  if (!isSupportedProvider(providerId)) return { ok: false, error: `unsupported provider: ${providerId}` };
  if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
  const got = readAuth();
  if (got.ok) {
    const stored = fromStored(providerId, got.data[providerId]);
    if (stored && "needsOauthRefresh" in stored) {
      const refreshed = await refreshOauth(providerId, signal);
      if (!refreshed.ok) return { ok: false, error: refreshed.error };
      const again = readAuth();
      if (again.ok) {
        const next = fromStored(providerId, again.data[providerId]);
        if (next && !("needsOauthRefresh" in next) && next.ok) return next;
      }
      return { ok: false, error: "auth expired — run /login" };
    }
    if (stored && stored.ok) return stored;
  } else if (got.reason === "corrupt") {
    process.stderr.write("agent-core: auth.json is unreadable — using env only\n");
  }
  const env = envToken(providerId);
  if (env) {
    return {
      ok: true,
      providerId,
      token: env.token,
      kind: "api_key",
      source: "env",
      envName: env.envName,
      baseUrl: baseUrl(providerId),
      headers: requestHeaders(providerId, env.token),
    };
  }
  return { ok: false, error: missingCredentialError(providerId) };
}

function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  return { verifier, challenge, state };
}

function buildAnthropicAuthorizeUrl(challenge: string, state: string, port: number): string {
  const u = new URL(authorizeUrl("anthropic"));
  u.searchParams.set("client_id", ANTHROPIC_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri("anthropic", port));
  u.searchParams.set("scope", ANTHROPIC_SCOPES);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

function buildCodexAuthorizeUrl(challenge: string, state: string, port: number): string {
  const u = new URL(authorizeUrl("openai-codex"));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri("openai-codex", port));
  u.searchParams.set("scope", OPENAI_CODEX_SCOPES);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("id_token_add_organizations", "true");
  u.searchParams.set("codex_cli_simplified_flow", "true");
  u.searchParams.set("originator", OPENAI_CODEX_ORIGINATOR);
  return u.toString();
}

function buildOpenRouterAuthorizeUrl(challenge: string, callback: string): string {
  const u = new URL(authorizeUrl("openrouter"));
  u.searchParams.set("callback_url", callback);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

async function exchangeAnthropic(
  code: string,
  verifier: string,
  port: number,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await postJson(
      tokenUrl("anthropic"),
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri("anthropic", port),
        client_id: ANTHROPIC_CLIENT_ID,
        code_verifier: verifier,
      },
      signal,
    );
    const parsed = parseTokenResponse(res.payload);
    if (!parsed.ok) return { ok: false, error: `login failed: ${parsed.error}` };
    if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
    return persistOauth("anthropic", parsed);
  } catch (error) {
    return { ok: false, error: authHttpError(error) ?? "login failed: Anthropic token exchange failed" };
  }
}

async function exchangeCodex(
  code: string,
  verifier: string,
  port: number,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await postForm(
      tokenUrl("openai-codex"),
      {
        grant_type: "authorization_code",
        client_id: OPENAI_CODEX_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri("openai-codex", port),
      },
      signal,
    );
    const parsed = parseTokenResponse(res.payload);
    if (!parsed.ok) return { ok: false, error: `login failed: ${parsed.error}` };
    if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
    const rec = isObject(res.payload) ? res.payload : {};
    const idToken = typeof rec.id_token === "string" ? rec.id_token : "";
    const accountId = extractAccountId(parsed.access) || extractAccountId(idToken) || undefined;
    return persistOauth("openai-codex", parsed, accountId ? { accountId } : {});
  } catch (error) {
    return { ok: false, error: authHttpError(error) ?? "login failed: OpenAI token exchange failed" };
  }
}

async function exchangeOpenRouter(
  code: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await postJson(
      tokenUrl("openrouter"),
      { code, code_verifier: verifier, code_challenge_method: "S256" },
      signal,
    );
    const rec = isObject(res.payload) ? res.payload : {};
    const key = typeof rec.key === "string" ? rec.key : "";
    if (!res.ok || !key) return { ok: false, error: "login failed: OpenRouter key exchange failed" };
    if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
    return persistApiKey("openrouter", key);
  } catch (error) {
    return { ok: false, error: authHttpError(error) ?? "login failed: OpenRouter key exchange failed" };
  }
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    /* not a URL */
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

function isOauthCancelError(err: string): boolean {
  return err === "access_denied" || err === "login_cancelled" || err === "user_cancelled";
}

function loginCallbackTimeoutMs(): number | null {
  if (process.env.TERMINA_CORE_TEST === "1") {
    const raw = process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS?.trim();
    if (raw === "0") return null;
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }
  return 3 * 60 * 1000;
}

function waitForCallback(
  port: number,
  path: string,
  expectedState: string | null,
  signal?: AbortSignal,
): Promise<{ code: string } | { error: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: { code: string } | { error: string }) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      server.close();
      resolve(result);
    };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== path) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const err = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (err) {
        const cancelled = isOauthCancelError(err);
        res.end(cancelled ? "<p>Login cancelled. You can close this tab.</p>" : "<p>Login failed. You can close this tab.</p>");
        finish({ error: cancelled ? "login cancelled" : `login failed: ${err}` });
        return;
      }
      if (expectedState && state !== expectedState) {
        res.end("<p>Login failed (state mismatch). You can close this tab.</p>");
        finish({ error: "login failed: state mismatch" });
        return;
      }
      if (!code) {
        res.end("<p>Login failed (missing code). You can close this tab.</p>");
        finish({ error: "login failed: missing code" });
        return;
      }
      res.end("<p>Termina agent-core is signed in. You can close this tab.</p>");
      finish({ code });
    });
    const onAbort = () => finish({ error: "login cancelled" });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    server.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") finish({ error: `port ${port} busy — another login may be running` });
      else finish({ error: `login failed: ${(err as Error).message}` });
    });
    server.listen(port, "127.0.0.1", () => {
      if (done) server.close();
    });
  });
}

export function canOpenBrowser(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === "darwin") return true;
  if (platform === "win32") return !env.SSH_CONNECTION;
  if (platform === "linux") {
    if (env.SSH_CONNECTION) return false;
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  }
  return false;
}

/** Spawn argv for the platform browser. HTTPS URLs only. */
export function browserOpenArgs(
  url: string,
  platform = process.platform,
): {
  cmd: string;
  args: string[];
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
} | null {
  if (!/^https:\/\//i.test(url) || /[\0\r\n"]/.test(url)) return null;
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "linux") return { cmd: "xdg-open", args: [url] };
  if (platform === "win32") {
    // cmd /c start treats & as a command break. Quote the URL and pass
    // the command line as-is so Node does not re-quote the quotes.
    return {
      cmd: "cmd",
      args: ["/c", "start", '""', `"${url}"`],
      windowsHide: true,
      windowsVerbatimArguments: true,
    };
  }
  return null;
}

function openBrowser(url: string): void {
  const spec = browserOpenArgs(url);
  if (!spec) return;
  try {
    spawn(spec.cmd, spec.args, {
      stdio: "ignore",
      detached: true,
      windowsHide: spec.windowsHide === true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
    }).unref();
  } catch {
    /* ignore */
  }
}

export type LoginIo = {
  write: (text: string) => void;
  waitForCode?: () => Promise<string>;
  openUrl?: (url: string) => void;
  signal?: AbortSignal;
};

function openAuthorize(url: string, io: LoginIo): void {
  if (io.openUrl) io.openUrl(url);
  else if (canOpenBrowser()) openBrowser(url);
}

async function collectCode(
  providerId: ProviderId,
  mode: LoginMode,
  url: string,
  state: string,
  io: LoginIo,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const port = redirectPort(providerId);
  io.write(`authorize: ${url}\n`);
  if (mode === "code") {
    if (!io.waitForCode) return { ok: false, error: "login failed: no code input" };
    io.write("paste the authorization code or redirect URL, then press enter\n");
    const parsed = parseAuthorizationInput(await io.waitForCode());
    if (parsed.state && parsed.state !== state) return { ok: false, error: "login failed: state mismatch" };
    if (!parsed.code) return { ok: false, error: "login failed: empty code" };
    return { ok: true, code: parsed.code };
  }
  if (!io.openUrl && !canOpenBrowser()) return { ok: false, error: "no browser — use /login code" };
  if (io.signal?.aborted) return { ok: false, error: "login cancelled" };
  openAuthorize(url, io);
  io.write("waiting for browser — finish sign-in or Ctrl+C to cancel\n");
  const timeoutMs = loginCallbackTimeoutMs();
  const ac = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onUserAbort = () => ac.abort();
  if (timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
  }
  io.signal?.addEventListener("abort", onUserAbort, { once: true });
  if (io.signal?.aborted) ac.abort();
  try {
    const expectedState = providerId === "openrouter" ? null : state;
    const waited = await waitForCallback(port, redirectPath(providerId), expectedState, ac.signal);
    if ("error" in waited) {
      if (timedOut && !io.signal?.aborted) {
        return { ok: false, error: "login cancelled — browser closed or timed out" };
      }
      return { ok: false, error: waited.error };
    }
    return { ok: true, code: waited.code };
  } finally {
    if (timer) clearTimeout(timer);
    io.signal?.removeEventListener("abort", onUserAbort);
  }
}

function validateVerificationUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  if (url.protocol !== "https:" && !testLoopbackOverride("TERMINA_TEST_DEVICE_URL")) {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  return url.href;
}

function intervalMs(value: unknown, fallback: number, min: number): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return Math.max(fallback, min);
  return Math.max(seconds * 1000, min);
}

function positiveMs(value: unknown, fallback: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
}

export async function requestXaiDeviceCode(signal?: AbortSignal): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresMs: number;
}> {
  const res = await postForm(
    deviceUrl(),
    { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: "termina" },
    signal,
  );
  if (!res.ok || !isObject(res.payload)) {
    throw new Error(`xAI device authorization failed (HTTP ${res.status})`);
  }
  const deviceCode = typeof res.payload.device_code === "string" ? res.payload.device_code : "";
  const userCode = typeof res.payload.user_code === "string" ? res.payload.user_code : "";
  const verification =
    typeof res.payload.verification_uri_complete === "string" && res.payload.verification_uri_complete
      ? res.payload.verification_uri_complete
      : typeof res.payload.verification_uri === "string"
        ? res.payload.verification_uri
        : "";
  if (!deviceCode || !userCode || !verification) {
    throw new Error("xAI device code response is missing fields");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: validateVerificationUri(verification),
    intervalMs: intervalMs(
      res.payload.interval,
      XAI_DEFAULT_INTERVAL_MS,
      testLoopbackOverride("TERMINA_TEST_DEVICE_URL") ? 0 : XAI_MIN_INTERVAL_MS,
    ),
    expiresMs: positiveMs(res.payload.expires_in, XAI_DEFAULT_EXPIRES_MS),
  };
}

export async function pollXaiDeviceToken(
  device: { deviceCode: string; intervalMs: number; expiresMs: number },
  signal?: AbortSignal,
): Promise<{ ok: true; access: string; refresh: string; expires: number } | { ok: false; error: string }> {
  const deadline = Date.now() + device.expiresMs;
  let intervalMs = device.intervalMs;
  while (Date.now() < deadline) {
    const wait = Math.min(intervalMs + (testLoopbackOverride("TERMINA_TEST_DEVICE_URL") ? 0 : XAI_POLL_MARGIN_MS), Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleepAsync(wait, signal);
    const res = await postForm(
      tokenUrl("xai"),
      {
        grant_type: XAI_DEVICE_GRANT,
        client_id: XAI_CLIENT_ID,
        device_code: device.deviceCode,
      },
      signal,
    );
    if (res.ok) {
      const parsed = parseOauthToken(res.payload, Date.now(), { requireRefresh: true, defaultExpiresIn: 3600 });
      if (!parsed.ok) return { ok: false, error: `login failed: ${parsed.error}` };
      return parsed;
    }
    const err = isObject(res.payload) && typeof res.payload.error === "string" ? res.payload.error : "";
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      intervalMs += XAI_SLOW_DOWN_MS;
      continue;
    }
    if (err === "access_denied" || err === "authorization_denied") return { ok: false, error: "xAI device authorization was denied" };
    if (err === "expired_token") return { ok: false, error: "xAI device code expired" };
    return { ok: false, error: `xAI device token exchange failed (HTTP ${res.status})` };
  }
  return { ok: false, error: "xAI device authorization timed out" };
}

async function loginKey(providerId: ProviderId, io: LoginIo): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!io.waitForCode) return { ok: false, error: "login failed: no key input" };
  const env = ENV_KEYS[providerId][0] ?? "API_KEY";
  io.write(`paste the ${providerId} API key (${env}), then press enter\n`);
  const key = (await io.waitForCode()).trim();
  if (!key) return { ok: false, error: "login failed: empty key" };
  return persistApiKey(providerId, key);
}

async function loginXaiDevice(io: LoginIo): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const device = await requestXaiDeviceCode(io.signal);
    io.write(`Open ${device.verificationUri} and enter code: ${device.userCode}\n`);
    openAuthorize(device.verificationUri, io);
    const tokens = await pollXaiDeviceToken(device, io.signal);
    if (!tokens.ok) return tokens;
    return persistOauth("xai", tokens);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function githubDeviceUrl(): string {
  return testLoopbackOverride("TERMINA_TEST_DEVICE_URL") || GITHUB_DEVICE_URL;
}

function githubAccessUrl(): string {
  return testLoopbackOverride("TERMINA_TEST_TOKEN_URL") || GITHUB_ACCESS_TOKEN_URL;
}

function copilotSessionUrl(): string {
  return testLoopbackOverride("TERMINA_TEST_COPILOT_TOKEN_URL") || GITHUB_COPILOT_TOKEN_URL;
}

function validateGithubVerificationUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Untrusted verification URI in GitHub OAuth response");
  }
  if (url.protocol !== "https:" && !testLoopbackOverride("TERMINA_TEST_DEVICE_URL")) {
    throw new Error("Untrusted verification URI in GitHub OAuth response");
  }
  if (!testLoopbackOverride("TERMINA_TEST_DEVICE_URL") && url.hostname !== "github.com" && !url.hostname.endsWith(".github.com")) {
    throw new Error("Untrusted verification URI in GitHub OAuth response");
  }
  return url.href;
}

export async function requestGithubDeviceCode(signal?: AbortSignal): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresMs: number;
}> {
  const res = await postJson(
    githubDeviceUrl(),
    { client_id: GITHUB_COPILOT_CLIENT_ID, scope: "read:user" },
    signal,
    { accept: "application/json", "user-agent": COPILOT_HEADERS["user-agent"] },
  );
  if (!res.ok || !isObject(res.payload)) {
    throw new Error(`GitHub device authorization failed (HTTP ${res.status})`);
  }
  const deviceCode = typeof res.payload.device_code === "string" ? res.payload.device_code : "";
  const userCode = typeof res.payload.user_code === "string" ? res.payload.user_code : "";
  const verification = typeof res.payload.verification_uri === "string" ? res.payload.verification_uri : "";
  if (!deviceCode || !userCode || !verification) {
    throw new Error("GitHub device code response is missing fields");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: validateGithubVerificationUri(verification),
    intervalMs: intervalMs(res.payload.interval, 5_000, testLoopbackOverride("TERMINA_TEST_DEVICE_URL") ? 0 : 1_000),
    expiresMs: positiveMs(res.payload.expires_in, 15 * 60 * 1000),
  };
}

export async function pollGithubDeviceToken(
  device: { deviceCode: string; intervalMs: number; expiresMs: number },
  signal?: AbortSignal,
): Promise<{ ok: true; githubToken: string } | { ok: false; error: string }> {
  const deadline = Date.now() + device.expiresMs;
  let waitMs = device.intervalMs;
  while (Date.now() < deadline) {
    const res = await postJson(
      githubAccessUrl(),
      {
        client_id: GITHUB_COPILOT_CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: GITHUB_DEVICE_GRANT,
      },
      signal,
      { accept: "application/json", "user-agent": COPILOT_HEADERS["user-agent"] },
    );
    if (isObject(res.payload) && typeof res.payload.access_token === "string" && res.payload.access_token) {
      return { ok: true, githubToken: res.payload.access_token };
    }
    const err = isObject(res.payload) && typeof res.payload.error === "string" ? res.payload.error : "";
    if (err === "access_denied") return { ok: false, error: "GitHub device authorization was denied" };
    if (err === "expired_token") return { ok: false, error: "GitHub device code expired" };
    if (err === "slow_down") waitMs += 5_000;
    else if (err && err !== "authorization_pending") {
      return { ok: false, error: `GitHub device token exchange failed (HTTP ${res.status})` };
    } else if (!res.ok && err !== "authorization_pending") {
      return { ok: false, error: `GitHub device token exchange failed (HTTP ${res.status})` };
    }
    const wait = Math.min(waitMs, Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleepAsync(wait, signal);
  }
  return { ok: false, error: "GitHub device authorization timed out" };
}

export async function exchangeGithubCopilotToken(
  githubToken: string,
  signal?: AbortSignal,
): Promise<{ ok: true; access: string; expires: number; apiUrl: string } | { ok: false; error: string }> {
  try {
    const res = await authFetch(
      copilotSessionUrl(),
      {
        method: "GET",
        headers: {
          ...COPILOT_HEADERS,
          authorization: `Bearer ${githubToken}`,
        },
      },
      signal,
    );
    const payload = res.payload;
    if (!res.ok || !isObject(payload) || typeof payload.token !== "string" || !payload.token) {
      return { ok: false, error: `Copilot session token failed (HTTP ${res.status})` };
    }
    if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
    const endpoints = isObject(payload.endpoints) ? payload.endpoints : {};
    const reported = typeof endpoints.api === "string" ? endpoints.api : "";
    const apiUrl = validateCopilotApiUrl(reported) || DEFAULT_BASE["github-copilot"];
    let expires = Date.now() + 25 * 60 * 1000;
    const expiresAt = payload.expires_at;
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
      expires = (expiresAt > 1_000_000_000_000 ? expiresAt : expiresAt * 1000) - EXPIRE_MARGIN_MS;
    } else if (typeof payload.refresh_in === "number" && payload.refresh_in > 0) {
      expires = Date.now() + payload.refresh_in * 1000 - EXPIRE_MARGIN_MS;
    }
    return { ok: true, access: payload.token, expires, apiUrl };
  } catch (error) {
    return { ok: false, error: authHttpError(error) ?? "Copilot session token failed" };
  }
}

async function loginGithubCopilot(io: LoginIo): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const device = await requestGithubDeviceCode(io.signal);
    io.write(`Open ${device.verificationUri} and enter code: ${device.userCode}\n`);
    openAuthorize(device.verificationUri, io);
    const github = await pollGithubDeviceToken(device, io.signal);
    if (!github.ok) return github;
    const session = await exchangeGithubCopilotToken(github.githubToken, io.signal);
    if (!session.ok) return session;
    return persistOauth(
      "github-copilot",
      { access: session.access, refresh: github.githubToken, expires: session.expires },
      { apiUrl: session.apiUrl },
    );
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function loginGithubCopilotKey(io: LoginIo): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!io.waitForCode) return { ok: false, error: "login failed: no token input" };
  io.write("paste a GitHub token with Copilot access, then press enter\n");
  const githubToken = (await io.waitForCode()).trim();
  if (!githubToken) return { ok: false, error: "login failed: empty token" };
  const session = await exchangeGithubCopilotToken(githubToken, io.signal);
  if (!session.ok) return session;
  return persistOauth(
    "github-copilot",
    { access: session.access, refresh: githubToken, expires: session.expires },
    { apiUrl: session.apiUrl },
  );
}

async function finishResolved(
  providerId: ProviderId,
  signal?: AbortSignal,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const resolved = await resolveAuth(providerId, signal);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, summary: authBanner(resolved) };
}

export async function runLogin(
  providerId: string,
  mode: LoginMode,
  io: LoginIo,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  if (!isSupportedProvider(providerId)) {
    return { ok: false, error: `unsupported provider: ${providerId} (supported: ${SUPPORTED_PROVIDERS.join(", ")})` };
  }
  const chosen = mode;
  if (providerId === "github-copilot") {
    const stored = chosen === "key" ? await loginGithubCopilotKey(io) : await loginGithubCopilot(io);
    if (!stored.ok) return stored;
    return finishResolved(providerId, io.signal);
  }
  if (chosen === "key" || (chosen === "browser" && defaultLoginMode(providerId) === "key")) {
    const stored = await loginKey(providerId, io);
    if (!stored.ok) return stored;
    return finishResolved(providerId, io.signal);
  }
  if (providerId === "xai") {
    const stored = await loginXaiDevice(io);
    if (!stored.ok) return stored;
    return finishResolved(providerId, io.signal);
  }
  if (providerId === "openai" || providerId === "google") {
    const stored = await loginKey(providerId, io);
    if (!stored.ok) return stored;
    return finishResolved(providerId, io.signal);
  }
  const port = redirectPort(providerId);
  const { verifier, challenge, state } = pkce();
  if (providerId === "openrouter") {
    const url = buildOpenRouterAuthorizeUrl(challenge, redirectUri(providerId, port));
    const code = await collectCode(providerId, chosen === "code" ? "code" : "browser", url, state, io);
    if (!code.ok) return code;
    const exchanged = await exchangeOpenRouter(code.code, verifier, io.signal);
    if (!exchanged.ok) return exchanged;
    return finishResolved(providerId, io.signal);
  }
  if (providerId === "openai-codex") {
    const url = buildCodexAuthorizeUrl(challenge, state, port);
    const code = await collectCode(providerId, chosen === "code" ? "code" : "browser", url, state, io);
    if (!code.ok) return code;
    const exchanged = await exchangeCodex(code.code, verifier, port, io.signal);
    if (!exchanged.ok) return exchanged;
    return finishResolved(providerId, io.signal);
  }
  const url = buildAnthropicAuthorizeUrl(challenge, state, port);
  const code = await collectCode("anthropic", chosen === "code" ? "code" : "browser", url, state, io);
  if (!code.ok) return code;
  const exchanged = await exchangeAnthropic(code.code, verifier, port, io.signal);
  if (!exchanged.ok) return exchanged;
  return finishResolved(providerId, io.signal);
}

export function runLogout(providerId: string): { ok: true; summary: string } | { ok: false; error: string } {
  if (!isSupportedProvider(providerId)) {
    return { ok: false, error: `unsupported provider: ${providerId} (supported: ${SUPPORTED_PROVIDERS.join(", ")})` };
  }
  try {
    modifyProvider(providerId, () => null);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, summary: `logged out ${providerId}` };
}

export function parseAuthCommand(line: string):
  | { cmd: "login"; mode: LoginMode; provider: string }
  | { cmd: "logout"; provider: string }
  | { error: string } {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0];
  const first = parts[1]?.toLowerCase();
  const second = parts[2]?.toLowerCase();
  if (cmd === "/logout") {
    if (!first) return { error: "pick a provider" };
    let picked: ReturnType<typeof resolveLoginPick>;
    if (LOGIN_KIND_WORDS.has(first) && second) picked = resolveLoginPick(second, first);
    else if (second && LOGIN_KIND_WORDS.has(second)) picked = resolveLoginPick(first, second);
    else if (isSupportedProvider(first)) return { cmd: "logout", provider: first };
    else picked = resolveLoginPick(first);
    if ("error" in picked) return picked;
    return { cmd: "logout", provider: picked.provider };
  }
  if (cmd === "/login") {
    if (!first) return { error: "pick a provider" };
    let picked: ReturnType<typeof resolveLoginPick>;
    if (LOGIN_KIND_WORDS.has(first)) picked = resolveLoginPick(second ?? "anthropic", first);
    else picked = resolveLoginPick(first, second);
    if ("error" in picked) return picked;
    return { cmd: "login", mode: picked.mode, provider: picked.provider };
  }
  return { error: `unknown command: ${line}` };
}

/** Test helper: drop the in-memory file cache. */
export function resetAuthCache(): void {
  cached = null;
  refreshFlights.clear();
}
