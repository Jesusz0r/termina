# Provider Auth for agent-core

Status: implemented in `agent-core/auth.ts` and `agent-core/openai-compat.ts`.
Scope: Termina's agent-core engine only.

Pi terminals keep Pi's own login. Shell terminals have no model auth.
Agent-core does not read Pi's files, does not write Pi's `auth.json`, and
does not share Pi's OAuth client. The user picks an engine per tab;
credentials do not leak across engines.

Public OAuth endpoints and client ids below are the same registrations Pi
and OpenCode use (Claude Code, Codex CLI, xAI Grok-CLI, OpenRouter PKCE).
This engine still owns the store, the headers, and the API translators.

## Current state

`agent-core/main.ts` routes by model to one of three protocols:

- Anthropic Messages (`anthropic`)
- OpenAI Chat Completions (`openai`, `xai`, `google`, `openrouter`)
- ChatGPT Codex Responses (`openai-codex`)

Credentials live in `~/.termina/agent/auth.json`. `/login` / `/logout`
take a provider id. `TERMINA_CORE_MODEL` and `TERMINA_CORE_PROVIDER`
select which credential and protocol a run uses.

## Design

**One store, owned by this engine:** `~/.termina/agent/auth.json` (mode `0600`).
Override with `TERMINA_AUTH_PATH` for tests. Do not read `~/.pi/`,
`~/.claude/`, or any other product's credential file.

Root shape (unknown keys are preserved):

```json
{
  "anthropic": { "type": "oauth", "access": "…", "refresh": "…", "expires": 0 },
  "xai": { "type": "oauth", "access": "…", "refresh": "…", "expires": 0 },
  "openai": { "type": "api_key", "key": "…" },
  "openai-codex": { "type": "oauth", "access": "…", "refresh": "…", "expires": 0, "accountId": "…" },
  "google": { "type": "api_key", "key": "…" },
  "openrouter": { "type": "api_key", "key": "…" }
}
```

A corrupt file is never overwritten.

**Providers**

| Id | Login | Env | Protocol | Base URL |
|---|---|---|---|---|
| `anthropic` | Claude Pro/Max PKCE, or `/login key anthropic` | `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN` | Anthropic Messages | `ANTHROPIC_BASE_URL` or `https://api.anthropic.com` |
| `openai` | paste key | `OPENAI_API_KEY` | Chat Completions | `OPENAI_BASE_URL` or `https://api.openai.com/v1` |
| `openai-codex` | ChatGPT Plus/Pro PKCE | none | Codex Responses | `https://chatgpt.com/backend-api` |
| `xai` | SuperGrok / X Premium device code, or `/login key xai` | `XAI_API_KEY` | Chat Completions | `XAI_BASE_URL` or `https://api.x.ai/v1` |
| `github-copilot` | GitHub device code, then Copilot session token | none | Chat Completions | token `endpoints.api` or `https://api.individual.githubcopilot.com` |
| `google` | paste key | `GEMINI_API_KEY`, then `GOOGLE_API_KEY` | Chat Completions (OpenAI-compat) | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `openrouter` | PKCE-minted key, or `/login key openrouter` | `OPENROUTER_API_KEY` | Chat Completions | `OPENROUTER_BASE_URL` or `https://openrouter.ai/api/v1` |

`/login` opens a TUI picker. OAuth is the provider name (`OpenAI`); API
key is `OpenAI (key)`. Both exist when the provider supports both.
`/login openai oauth` stores ChatGPT Codex; `/login openai key` stores
an OpenAI API key. Google is API key only.
Radius, Bedrock, and Azure stay out of this engine.

**Resolution order** (first hit wins, per provider):

1. Stored entry for that provider
2. Else env for that provider

A stored entry owns the provider. Do not fall back to env after a failed
refresh. Ambient env is only for machines with no file.

**Model routing**

`TERMINA_CORE_PROVIDER` wins when it is a supported id. Else a
`provider/model` prefix (`xai/grok-4.3`, `openai-codex/gpt-5.4`). Else
infer: `claude*` → anthropic, `grok*` → xai, `gemini*`/`gemma*` → google,
`gpt-*`/`o1`/`o3`/`o4` → openai. Else anthropic.

When a credential exists, the kernel GET-lists that provider's models
(`agent-core/models.ts`) and uses that list. It does not use a baked-in
catalog as the source of truth. `TERMINA_CORE_MODEL` still pins an id
when set; a live id that only adds a date suffix may replace the pin
(`claude-sonnet-4-5` → `claude-sonnet-4-5-20250929`). If the env does
not pin a provider, startup picks the first **stored** credential in
`anthropic`, `openai-codex`, `openai`, `xai`, `google`, `openrouter`
order, then ambient env. A leftover `ANTHROPIC_API_KEY` does not hide a
stored xAI or ChatGPT login. The GET has a 10 s timeout and a failed
fetch does not invent a fake list.

`/models` prints the live list. `/models refresh` fetches again.
`/model <id>` switches. After `/login`, the kernel loads that provider's
list and adopts it unless the env pinned a different provider.

Embeddings, TTS, image, and similar ids are dropped. The list caps at
200. Tests skip the live GET unless `TERMINA_TEST_MODELS_URL` is set.

Summarization uses `TERMINA_CORE_SUMMARY_MODEL` when set, otherwise the
cheap default on the same provider.

**Anthropic request headers** follow the token string:

- Token contains `sk-ant-oat`: `Authorization: Bearer`, plus
  `anthropic-beta: claude-code-20250219,oauth-2025-04-20`,
  `user-agent: termina-agent-core/1`, `x-app: cli`
- Anything else: `x-api-key` and no Claude Code betas

`anthropic-version: 2023-06-01` and `content-type: application/json` on
every Anthropic request.

**Other providers** send `Authorization: Bearer`. Codex also sends
`chatgpt-account-id` (from the stored field or the JWT) and
`originator: termina-agent-core`. OpenRouter also sends `HTTP-Referer`
and `X-Title`.

**Anthropic OAuth** (Claude Pro/Max). Public client used by Anthropic's CLI:

- Client id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Authorize `https://claude.ai/oauth/authorize`
- Token `https://platform.claude.com/v1/oauth/token`
- Redirect `http://127.0.0.1:53692/callback`
- PKCE S256
- Scopes `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`

**OpenAI Codex OAuth** (ChatGPT Plus/Pro). Same public client as Codex CLI
and OpenCode:

- Client id `app_EMoamEEZ73f0CkXaXp7hrann`
- Authorize `https://auth.openai.com/oauth/authorize`
- Token `https://auth.openai.com/oauth/token` (form-urlencoded)
- Redirect `http://localhost:1455/auth/callback`
- PKCE S256
- Scopes `openid profile email offline_access`
- Extra authorize params: `id_token_add_organizations=true`,
  `codex_cli_simplified_flow=true`, `originator=termina-agent-core`
- Store `accountId` from the JWT claim `https://api.openai.com/auth`
- API `POST {base}/codex/responses`

**xAI SuperGrok OAuth**. Same public Grok-CLI client as Pi and OpenCode.
Device code, not loopback PKCE:

- Client id `b1a00492-073a-47ea-816f-4c329264a828`
- Device `https://auth.x.ai/oauth2/device/code`
- Token `https://auth.x.ai/oauth2/token` (form-urlencoded)
- Scope `openid profile email offline_access grok-cli:access api:access`
- `referrer=termina`
- RFC 8628 `authorization_pending` / `slow_down`; refresh may omit a new
  refresh token (keep the previous one); missing `expires_in` defaults to
  3600 seconds

**OpenRouter OAuth**. PKCE that mints a permanent user-controlled API key
(no refresh). Stored as `api_key`. Redirect
`http://127.0.0.1:53693/callback`. Token
`https://openrouter.ai/api/v1/auth/keys`.

Store `expires = Date.now() + expires_in * 1000 - 300_000` (five-minute
margin at write time). A credential needs refresh when
`expires <= Date.now()`. One rule. No second skew constant.

Refresh is single-flight per provider and uses a lockfile around the
read-modify-write so two agent-core processes cannot rotate the same
refresh token twice. Persist the new refresh token before replaying a
request. A crash between a successful exchange and the disk write loses
the rotation and forces `/login` again. Accepted.

Tests may point authorize, token, device, redirect, and models GET at
loopback with `TERMINA_TEST_AUTHORIZE_URL`, `TERMINA_TEST_TOKEN_URL`,
`TERMINA_TEST_DEVICE_URL`, `TERMINA_TEST_REDIRECT_PORT`, and
`TERMINA_TEST_MODELS_URL`. Production constants stay in
`agent-core/auth.ts` and `agent-core/models.ts`. Harness runs set
`TERMINA_CORE_TEST=1` so startup does not call a real models endpoint.

**No tokens in sidecars, traces, or error text.** Status lines show a
masked suffix only (last four characters).

**web_search** stays the Anthropic server tool. Completions providers do
not get a second search implementation.

## Edge cases

- Port 53692 / 1455 / 53693 bound: fail `port N busy — another login may be running`.
  No ephemeral port. Registered redirect URIs are fixed.
- CSRF: random `state` on Anthropic and Codex authorize; callback rejects
  mismatches. OpenRouter does not echo state. IdP `error` query param
  becomes a readable failure, not a hang. `access_denied` is
  `login cancelled`. Closing the authorize tab cannot be observed, so
  the wait times out after 3 minutes with
  `login cancelled — browser closed or timed out`. Ctrl+C cancels sooner.
- Parallel writer: `resolveAuth` stats the file and reloads on mtime
  change (one stat per turn).
- Corrupt `auth.json`: warn, env-only, never write.
- Writes are whole-object read-modify-write.
- 401 + oauth: refresh once, replay once, then `(auth expired — run /login)`.
- 401 + api key: no replay; `invalid API key`.
- Token response missing required fields: reject. Do not store a half credential.
- Ctrl+C during login: abort the wait and close the callback server.
- `/login` while a run is active: blocked. `/login` with an unknown
  provider: list supported ids.
- No display / no `open`: `/login` does not spawn a browser and tells
  the user to use `/login code`.
- `/login code`: print the authorize URL, wait for the next line as the
  authorization code or redirect URL, exchange in-process (PKCE verifier
  never leaves the process).
- `/login key [provider]`: paste an API key onto the next line.
- `/login xai`: device code. Prints the verification URL and user code,
  then polls. `/login key xai` stores `XAI_API_KEY`.
- Windows browser-open is out of scope (macOS-first).
- xAI `verification_uri` must be https, except when tests override the
  device URL.

## Slash commands

- `/login` — TUI picker of providers (`OpenAI`, `OpenAI (key)`, …).
- `/login [provider]` — default login for that provider.
- `/login code [provider]` — paste-the-code variant (PKCE providers).
- `/login key [provider]` — paste an API key.
- `/logout [provider]` — delete the stored entry and confirm.
- Banner replaces `key ok` with the resolved source, for example
  `auth: oauth (…abcd)` / `auth: xai oauth (…abcd)` /
  `auth: api_key (auth.json)` / `auth: env ANTHROPIC_API_KEY` /
  `auth: none`.

## Files

| File | Change |
|---|---|
| `agent-core/auth.ts` | Store, resolve, refresh, login, logout, header pick, model routing |
| `agent-core/openai-compat.ts` | Completions and Codex Responses translators |
| `agent-core/models.ts` | Live GET `/models`, parse, pick default, `/models` `/model` helpers |
| `agent-core/main.ts` | Provider post, 401 retry-once, protocol switch, `/login` `/logout`, banner, catalog |
| `docs/AGENT-CORE.md` | Commands and precedence |
| `scripts/agent-core-harness-test.mjs` | auth and translator cases via `TERMINA_AUTH_PATH` |
| `docs/AUTH-PLAN.md` | this file |

No Electron, preload, renderer, or Pi package changes. The kernel process
reads its own file. The host env already passes provider keys through
`cleanEnv()`.

## Tests

Focused gate already imports `agent-core/main.ts`. Import `agent-core/auth.ts`
and `agent-core/openai-compat.ts` the same way. `TERMINA_AUTH_PATH` points
at a temp file. No network to real providers.

- `pickHeaders`: `sk-ant-oat` → Bearer + betas; other tokens → `x-api-key`
- Precedence: stored api_key beats env; stored oauth beats env; missing
  file uses `ANTHROPIC_API_KEY` then `ANTHROPIC_AUTH_TOKEN`
- `OPENAI_API_KEY` / `XAI_API_KEY` resolve when no stored entry
- `needsRefresh`: `expires` in the past is true; future is false
- `parseTokenResponse`: missing fields fail; complete payload computes
  back-dated `expires`
- xAI refresh keeps the previous refresh token when the response omits one
- `modifyProvider` preserves unrelated root keys and extra fields on the
  entry
- Masked status never contains the raw token
- Login against loopback token URL stores oauth and builds Bearer headers
- 401 + oauth refreshes once and persists the new refresh token
- xAI device login against loopback stores oauth
- Codex headers include `chatgpt-account-id` from the JWT
- Completions translator maps `tool_use` / `tool_result` to tool calls
- `parseModelRef` reads prefixes and `TERMINA_CORE_PROVIDER`

## Out of scope

- GitHub Copilot, Radius, Bedrock, Azure, and every other catalog id
- A settings UI (slash commands while the engine is experimental)
- Windows `open`
- Reading or writing Pi credential files
- Syncing login between Pi tabs and Agent (core) tabs
- A second web_search implementation for Completions providers
