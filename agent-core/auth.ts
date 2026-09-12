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

// Split into ./auth/ modules (issue #38). This entry re-exports the public surface.
export type { ProviderId, ProviderProtocol, LoginMode } from "./auth/providers/types.ts";
export { protocolEndpoint } from "./auth/providers/endpoints.ts";
export { isOAuthToken, pickHeaders } from "./auth/providers/anthropic.ts";
export { extractAccountId } from "./auth/providers/openai-codex.ts";
export { zenWireProtocol } from "./auth/providers/opencode-zen.ts";
export { AUTH_PROVIDER_ORDER, authPath, defaultLoginMode, googleNativeHeaders, isSupportedProvider, maskSecret, needsRefresh, openaiCodexClientVersion, providerProtocol, providerProtocolHeaders, redirectPort, requestHeaders, usesResponsesApi, validateCopilotApiUrl } from "./auth/endpoints.ts";
export { CACHE_CAPABILITY_FEATURE, CACHE_POLICY_PROVENANCE, documentedCacheCapability, usesAnthropicCacheMarkers, usesOpenAIExplicitCache, usesPromptCacheKey, usesPromptCacheOptions } from "./auth/cache-policy.ts";
export type { CacheCapabilityFeature, CacheCapabilityObservation, CacheCapabilityProvenance, CacheCapabilityScope, CacheCapabilitySource, CacheCapabilityStatus } from "./auth/cache-policy.ts";
export { CACHE_KEY_MAX_LENGTH, cacheIdentityFor, cacheRouteDomain, cacheSessionHeaders, cacheSessionSeed, deriveCacheIdentityKey } from "./auth/cache-identity.ts";
export type { CacheIdentity, CacheIdentityInputs, CacheRole } from "./auth/cache-identity.ts";
export { modifyProvider, readAuth, resetAuthCache } from "./auth/store.ts";
export { exchangeGithubCopilotToken, parseOauthToken, parseTokenResponse, pollGithubDeviceToken, pollXaiDeviceToken, refreshOauth, requestGithubDeviceCode, requestXaiDeviceCode } from "./auth/oauth.ts";
export { DEFAULT_MODELS, authBanner, firstAuthenticatedProvider, hasEnvCredential, hasStoredCredential, parseModelRef, resolveAuth } from "./auth/resolve.ts";
export type { ResolvedAuth } from "./auth/resolve.ts";
export { browserOpenArgs, canOpenBrowser, loginPickerItems, parseAuthCommand, runLogin, runLogout } from "./auth/login.ts";
export type { LoginIo, LoginKind, LoginPickerItem } from "./auth/login.ts";
