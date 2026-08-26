# Provider Auth for agent-core — Implementation Plan

Status: draft v2 (audited against pi-ai source). Scope: the experimental
in-house engine (`agent-core/`). The pi terminals already have full auth;
they run pi, which owns its own flows. This plan covers only what the core
engine needs.

## Current state (contrast)

| Concern | Today (agent-core/main.ts) | pi (verified in source) | opencode |
|---|---|---|---|
| Providers | Anthropic only (`API_BASE`) | catalog of many | many |
| API keys | `ANTHROPIC_API_KEY` env only | env checked only when nothing stored | env vars, then `auth.json` |
| OAuth | none | PKCE/device per provider, `pi-ai/dist/auth/oauth/` | plugin-owned hooks |
| Storage | none | `~/.pi/agent/auth.json`, `{type:"api_key"\|"oauth"}`, 0600 | `~/.local/share/opencode/auth.json`, 0600 |
| Precedence | n/a | stored credential wins over env | similar |
| Refresh | none (401 = dead end) | serialized `modify()` under file lock | single-flight promise in fetch wrapper |

Hardcoded today: `API_BASE = ANTHROPIC_BASE_URL ?? https://api.anthropic.com`
and `"x-api-key": ANTHROPIC_API_KEY` in both `callModel()` and `summarize()`.

## Verified facts this plan relies on

All checked in pi's shipped code, not assumed:

- Storage key for Claude OAuth is `"anthropic"`
  (`createProvider({id:"anthropic", auth:{apiKey, oauth:{...isSubscription:true}}})`).
- Credential shape after login:
  `{type:"oauth", refresh, access, expires}` where
  `expires = Date.now() + expires_in*1000 - 300_000`. The 5-minute margin
  is baked in at store time; consumers treat `expires <= Date.now()` as
  expired (`minOAuthValidityMs` default 300 s).
- Precedence (`auth/resolve.js`): "A stored credential owns the provider:
  ambient/env is consulted only when nothing is stored." No silent env
  fallback after a failed refresh.
- Request shape depends on the token string itself, not its origin
  (`isOAuthToken`): tokens containing `sk-ant-oat` go as
  `Authorization: Bearer` plus `anthropic-beta:
  claude-code-20250219,oauth-2025-04-20`, `user-agent: claude-cli/<ver>`,
  `x-app: cli`; everything else goes as `x-api-key` with no Claude Code
  betas. Base URL stays `https://api.anthropic.com` unless
  `ANTHROPIC_BASE_URL` overrides it.

## Design decisions

1. **One credential store on the machine: `~/.pi/agent/auth.json`.**
   Same file pi uses, same shapes. Users run pi and core side by side;
   logging into one logs into both. We are a narrow client of pi's
   on-disk format — no second store, no migration machinery.
2. **Phase 1 supports two auth kinds for Anthropic** (OAuth subscription,
   API key). Every function takes `providerId` so adding OpenRouter
   (key-paste only) later is additive, not structural.
3. **Header selection by token sniffing, matching pi**: if the resolved
   token contains `sk-ant-oat` use Bearer + beta headers + UA; otherwise
   `x-api-key`. This stays correct no matter which slot the token came
   from (stored, env, or a future proxy).
4. **Login flow = pi's exact constants**: client id
   `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, authorize
   `https://claude.ai/oauth/authorize`, token URL
   `https://platform.claude.com/v1/oauth/token`, redirect
   `http://127.0.0.1:53692/callback`, PKCE S256, scopes
   `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`.
   Store `expires` back-dated 300 s like pi does.
5. **Refresh correctness**:
   - Single rule: a stored oauth credential with `expires <= Date.now()`
     needs a refresh. No second skew constant anywhere.
   - Single-flight per process (`refreshPromise` dedupe) plus a lockfile
     around the auth.json read-modify-write so a concurrent pi process
     cannot double-refresh a rotated token.
   - Persist the rotated refresh token BEFORE replaying any request.
     Known residual risk: a crash between successful exchange and disk
     write loses the rotation and forces re-login. Accepted; unavoidable
     without transactional storage.
6. **No tokens in sidecars or error messages.** Usage/log events never
   carry credentials; status lines show masked ids only.

## Edge cases handled

- **Port 53692 already bound** (another pi/core login in progress):
  fail with "port 53692 busy — another login may be running". No
  ephemeral-port fallback: redirect_uri is fixed by the client
  registration.
- **CSRF / forged callbacks**: the authorize request carries a random
  `state`; the callback server rejects mismatches, and surfaces an IdP
  `error` query param as a readable failure instead of hanging.
- **Stale view of auth.json**: a parallel pi process may login/logout or
  refresh while we run. Resolve stats the file and reloads when mtime
  changed (one stat per turn — free).
- **Corrupt or unparseable auth.json**: warn and run env-only, and never
  write. A blind rewrite could destroy other providers' credentials.
- **Write shape**: every write is a whole-object read-modify-write that
  preserves unknown root keys and unknown fields inside the credential
  entry (pi may add `accountId` etc. later).
- **401 handling**: with an oauth credential, refresh once and replay the
  request once; then surface `(auth expired — run /login)`. With an api
  key, never replay — surface "invalid API key".
- **Missing fields in token response**: validate `access_token`,
  `refresh_token`, `expires_in` exist; fail loudly rather than storing a
  half credential.
- **Ctrl+C during login**: aborts the wait and closes the callback server.
- **`/login` while a run is active**: blocked like other commands.
  `/login bogus-provider`: lists supported providers.
- **Env chain**: `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN` (common
  in proxy setups alongside `ANTHROPIC_BASE_URL`). Consulted only when no
  stored credential exists.
- **Headless machines**: `/login` skips spawning a browser when no
  display/browser opener exists and points at `/login code` (paste the
  authorization code back; verifier lives in the same process).

## Slash commands

- `/login [provider]` — PKCE flow rendered in the terminal: start loopback
  server → print authorize URL → try `open`/`xdg-open` (Windows support
  deliberately out of scope while the app is macOS-first) → wait →
  exchange → store → print masked summary.
- `/login code [provider]` — paste-the-code variant for headless/SSH.
- `/logout [provider]` — delete the entry, confirm.
- Banner shows resolved auth source, e.g.
  `auth: oauth (claude.ai)` / `auth: api_key (auth.json)` /
  `auth: env ANTHROPIC_API_KEY` — replacing today's bare `key ok`.

## File changes

- `agent-core/auth.ts` (new, bundled automatically via import):
  `readAuth()` / `modifyProvider(id, fn)` (lockfile, atomic tmp+rename,
  0600), `resolveAuth()` (mtime reload + precedence), `refreshOauth()`,
  `runLogin(io)` / `runLogout(io)`, and pure helpers (`pickHeaders`,
  `needsRefresh`, `parseTokenResponse`) exported for the self-check.
  Test hooks: `TERMINA_AUTH_PATH` overrides the file path; the authorize
  and token URLs honor `TERMINA_TEST_AUTHORIZE_URL` /
  `TERMINA_TEST_TOKEN_URL` so the login flow can be exercised against a
  local mock without touching production constants elsewhere.
- `agent-core/main.ts`: delete the `API_BASE`/`x-api-key` literals; route
  `callModel` and `summarize` through `resolveAuth()` + header builder;
  401 retry-once logic; register `/login`, `/logout`, banner change.
- `docs/AGENT-CORE.md`: document commands and precedence.
- No electron/, preload, or renderer changes.

## Test plan

- Self-check (pattern exists: `toRequest` is exported for this): assert
  `pickHeaders` sniffs `sk-ant-oat` correctly from all three sources,
  precedence order, `needsRefresh` math against back-dated expiries,
  `parseTokenResponse` rejecting incomplete payloads, and that
  `modifyProvider` preserves unrelated keys and survives a concurrent-
  writer simulation.
- One pty smoke test reusing the mock-API harness: boot with
  `TERMINA_TEST_*_URL` pointing at a local mock, verify login end-to-end
  (callback → stored credential → request carries Bearer + betas), then
  401 → refresh → replay.

## Explicitly out of scope

- OpenRouter/OpenAI/xAI/Copilot OAuth — add when the routing map points
  at them; `providerId` plumbing already exists.
- A settings UI for auth — slash commands are the product surface while
  the engine is experimental.
- Windows browser-open support.
