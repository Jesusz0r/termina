/**
 * Login pickers and interactive login flows.
 *
 * Owns login/logout pickers, callback handling, browser launch, and the
 * login/logout commands. Split from agent-core/auth.ts (issue #38).
 */
import { providerDefinition } from "./providers/index.ts";
import { OPENAI_CODEX_ORIGINATOR } from "./providers/openai-codex.ts";
import { SUPPORTED_PROVIDERS, type LoginMode, type ProviderId } from "./providers/types.ts";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ANTHROPIC_CLIENT_ID, ANTHROPIC_SCOPES, OPENAI_CODEX_CLIENT_ID, OPENAI_CODEX_SCOPES, authorizeUrl, defaultLoginMode, isSupportedProvider, redirectPath, redirectPort, redirectUri } from "./endpoints.ts";
import { exchangeAnthropic, exchangeCodex, exchangeGithubCopilotToken, exchangeOpenRouter, persistApiKey, persistOauth, pollGithubDeviceToken, pollXaiDeviceToken, requestGithubDeviceCode, requestXaiDeviceCode } from "./oauth.ts";
import { authBanner, resolveAuth } from "./resolve.ts";
import { modifyProvider } from "./store.ts";


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


function callbackStateMatches(path: string, expectedState: string, returnedState: string | null): boolean {
  if (!expectedState) return false;
  if (returnedState === expectedState) return true;
  // OpenRouter redirects with `code` only. A one-time path token is the CSRF
  // secret when the provider does not echo `state`.
  return returnedState === null && path.endsWith(`/${expectedState}`);
}


function waitForCallback(
  port: number,
  path: string,
  expectedState: string,
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
      if (!callbackStateMatches(path, expectedState, state)) {
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
    const waited = await waitForCallback(port, redirectPath(providerId, state), state, ac.signal);
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


async function loginKey(providerId: ProviderId, io: LoginIo): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!io.waitForCode) return { ok: false, error: "login failed: no key input" };
  const env = providerDefinition(providerId).envKeys[0] ?? "API_KEY";
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
    const url = buildOpenRouterAuthorizeUrl(challenge, redirectUri(providerId, port, state));
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
