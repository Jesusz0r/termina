import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exchangeGithubCopilotToken,
  modifyProvider,
  readAuth,
  requestGithubDeviceCode,
  requestXaiDeviceCode,
  refreshOauth,
  resetAuthCache,
  resolveAuth,
  runLogin,
} from "../../../agent-core/auth.ts";

describe("Agent Core Auth HTTP Bounding & Cancellation", () => {
  let fixtureRoot: string;
  let server: Server;
  let origin: string;
  const savedEnv = new Map<string, string | undefined>();

  const largePadding = "x".repeat(300_000);
  const oauthBody = JSON.stringify({
    access_token: "access-next",
    refresh_token: "refresh-next",
    expires_in: 3_600,
    padding: largePadding,
  });
  const copilotBody = JSON.stringify({
    token: "copilot-next",
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    endpoints: { api: "https://api.individual.githubcopilot.com" },
    padding: largePadding,
  });

  let sharedRefreshRequests = 0;
  let hangingRequests = 0;

  function sendDelayedOversize(res: any, body: string, declared: boolean) {
    if (declared) {
      res.setHeader("content-length", Buffer.byteLength(body));
      res.flushHeaders();
      res.write(body.slice(0, 1_024));
      setTimeout(() => {
        if (!res.destroyed) res.end(body.slice(1_024));
      }, 500).unref();
      return;
    }
    res.flushHeaders();
    res.write(body.slice(0, 150_000));
    setTimeout(() => {
      if (!res.destroyed) res.write(body.slice(150_000));
    }, 20).unref();
    setTimeout(() => {
      if (!res.destroyed) res.end();
    }, 500).unref();
  }

  beforeAll(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "termina-auth-http-"));
    for (const name of [
      "TERMINA_AUTH_PATH",
      "TERMINA_CORE_TEST",
      "TERMINA_TEST_AUTH_HTTP_TIMEOUT_MS",
      "TERMINA_TEST_AUTHORIZE_URL",
      "TERMINA_TEST_COPILOT_TOKEN_URL",
      "TERMINA_TEST_DEVICE_URL",
      "TERMINA_TEST_LOGIN_TIMEOUT_MS",
      "TERMINA_TEST_REDIRECT_PORT",
      "TERMINA_TEST_TOKEN_URL",
    ]) {
      savedEnv.set(name, process.env[name]);
    }
    process.env.TERMINA_CORE_TEST = "1";
    process.env.TERMINA_TEST_REDIRECT_PORT = "27641";

    server = createServer((req, res) => {
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      res.setHeader("content-type", "application/json");
      if (path === "/normal") {
        res.end(JSON.stringify({ access_token: "normal-access", refresh_token: "normal-refresh", expires_in: 3_600 }));
        return;
      }
      if (path === "/declared-oauth") {
        sendDelayedOversize(res, oauthBody, true);
        return;
      }
      if (path === "/chunked-oauth") {
        sendDelayedOversize(res, oauthBody, false);
        return;
      }
      if (path === "/declared-copilot") {
        sendDelayedOversize(res, copilotBody, true);
        return;
      }
      if (path === "/chunked-copilot") {
        sendDelayedOversize(res, copilotBody, false);
        return;
      }
      if (path === "/invalid-utf8") {
        res.end(Buffer.concat([
          Buffer.from('{"access_token":"'),
          Buffer.from([0xff]),
          Buffer.from('","refresh_token":"refresh","expires_in":3600}'),
        ]));
        return;
      }
      if (path === "/hang" || path === "/timeout") {
        hangingRequests += 1;
        res.flushHeaders();
        res.write('{"access_token":"pending');
        return;
      }
      if (path === "/shared-refresh") {
        sharedRefreshRequests += 1;
        setTimeout(() => {
          if (!res.destroyed) {
            res.end(JSON.stringify({ access_token: "shared-access", refresh_token: "shared-refresh-2", expires_in: 3_600 }));
          }
        }, 120);
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    expect(address && typeof address === "object").toBe(true);
    origin = `http://127.0.0.1:${(address as any).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetAuthCache();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function useAuthFile(name: string) {
    process.env.TERMINA_AUTH_PATH = join(fixtureRoot, name, "auth.json");
    delete process.env.TERMINA_TEST_AUTH_HTTP_TIMEOUT_MS;
    delete process.env.TERMINA_TEST_COPILOT_TOKEN_URL;
    delete process.env.TERMINA_TEST_TOKEN_URL;
    resetAuthCache();
  }

  function storedProvider(providerId: string) {
    const got = readAuth();
    return got.ok ? (got.data as any)[providerId] : undefined;
  }

  async function loginWithTokenEndpoint(providerId: any, path: string, signal?: AbortSignal) {
    process.env.TERMINA_TEST_TOKEN_URL = `${origin}${path}`;
    return runLogin(providerId, "code", {
      write: () => {},
      waitForCode: async () => "fixture-code",
      signal,
    });
  }

  async function loginCopilot(path: string, signal?: AbortSignal) {
    process.env.TERMINA_TEST_COPILOT_TOKEN_URL = `${origin}${path}`;
    return runLogin("github-copilot", "key", {
      write: () => {},
      waitForCode: async () => "github-token",
      signal,
    });
  }

  async function settlesWithin(promise: Promise<any>, timeoutMs: number) {
    const marker = Symbol("timeout");
    const result = await Promise.race([
      promise.catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })),
      new Promise((resolve) => setTimeout(() => resolve(marker), timeoutMs)),
    ]);
    return result === marker ? null : result;
  }

  it("ensures production ignores auth test hooks and test URLs stay loopback-only", async () => {
    useAuthFile("production-test-hooks");
    const previousFetch = globalThis.fetch;
    const hookNames = [
      "TERMINA_CORE_TEST",
      "TERMINA_TEST_AUTHORIZE_URL",
      "TERMINA_TEST_TOKEN_URL",
      "TERMINA_TEST_DEVICE_URL",
      "TERMINA_TEST_COPILOT_TOKEN_URL",
      "TERMINA_TEST_REDIRECT_PORT",
      "TERMINA_TEST_LOGIN_TIMEOUT_MS",
    ];
    const previousHooks = new Map(hookNames.map((name) => [name, process.env[name]]));
    const seen: any[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, init });
      if (url === "https://platform.claude.com/v1/oauth/token") {
        return new Response(JSON.stringify({ access_token: "canonical-access", refresh_token: "canonical-refresh", expires_in: 3_600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://github.com/login/device/code") {
        return new Response(JSON.stringify({
          device_code: "canonical-device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 60,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://auth.x.ai/oauth2/device/code") {
        return new Response(JSON.stringify({
          device_code: "canonical-xai-device",
          user_code: "XAI-1234",
          verification_uri: "https://x.ai/device",
          interval: 0,
          expires_in: 60,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.github.com/copilot_internal/v2/token") {
        return new Response(JSON.stringify({
          token: "copilot-access",
          expires_at: Math.floor(Date.now() / 1_000) + 3_600,
          endpoints: { api: "https://api.individual.githubcopilot.com" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    process.env.TERMINA_TEST_AUTHORIZE_URL = "https://attacker.invalid/authorize";
    process.env.TERMINA_TEST_TOKEN_URL = "https://attacker.invalid/token";
    process.env.TERMINA_TEST_DEVICE_URL = "https://attacker.invalid/device";
    process.env.TERMINA_TEST_COPILOT_TOKEN_URL = "https://attacker.invalid/copilot";
    process.env.TERMINA_TEST_REDIRECT_PORT = "12345";
    process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS = "1";

    try {
      for (const mode of [undefined, "1"]) {
        if (mode === undefined) delete process.env.TERMINA_CORE_TEST;
        else process.env.TERMINA_CORE_TEST = mode;
        modifyProvider("anthropic", () => ({
          type: "oauth",
          access: "expired-access",
          refresh: "refresh-old",
          expires: Date.now() - 1,
        }));
        const refreshed = await refreshOauth("anthropic");
        expect(refreshed).toEqual({ ok: true });
        expect(seen.at(-1)?.url).toBe("https://platform.claude.com/v1/oauth/token");

        const device = await requestGithubDeviceCode();
        expect(device.deviceCode).toBe("canonical-device");
        expect(seen.at(-1)?.url).toBe("https://github.com/login/device/code");

        const xaiDevice = await requestXaiDeviceCode();
        expect(xaiDevice.deviceCode).toBe("canonical-xai-device");
        expect(xaiDevice.intervalMs).toBe(1_000);
        expect(seen.at(-1)?.url).toBe("https://auth.x.ai/oauth2/device/code");

        const copilot = await exchangeGithubCopilotToken("github-token");
        expect(copilot.ok).toBe(true);
        expect(seen.at(-1)?.url).toBe("https://api.github.com/copilot_internal/v2/token");

        let authorize = "";
        const codeResult = await runLogin("anthropic", "code", {
          write: (text) => { authorize += text; },
          waitForCode: async () => "",
        });
        expect(codeResult).toEqual({ ok: false, error: "login failed: empty code" });
        const authUrl = (authorize.match(/authorize: (\S+)/) || [])[1];
        expect(new URL(authUrl).origin).toBe("https://claude.ai");

        const controller = new AbortController();
        const browser = runLogin("anthropic", "browser", { write: () => {}, openUrl: () => {}, signal: controller.signal });
        await new Promise((resolve) => setTimeout(resolve, 25));
        controller.abort();
        expect(await browser).toEqual({
          ok: false,
          error: mode === undefined ? "login cancelled" : "login cancelled — browser closed or timed out",
        });
      }
    } finally {
      globalThis.fetch = previousFetch;
      for (const [name, value] of previousHooks) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      resetAuthCache();
    }
  });

  it("handles normal bounded JSON login", async () => {
    useAuthFile("normal");
    const result = await loginWithTokenEndpoint("anthropic", "/normal");
    expect(result.ok).toBe(true);
    expect(storedProvider("anthropic")?.access).toBe("normal-access");
  });

  for (const [name, providerId, path] of [
    ["postJson rejects a declared oversized response", "anthropic", "/declared-oauth"],
    ["postJson rejects a chunked oversized response", "anthropic", "/chunked-oauth"],
    ["postForm rejects a declared oversized response", "openai-codex", "/declared-oauth"],
    ["postForm rejects a chunked oversized response", "openai-codex", "/chunked-oauth"],
  ] as const) {
    it(name, async () => {
      useAuthFile(name.replaceAll(" ", "-"));
      const started = performance.now();
      const result = await loginWithTokenEndpoint(providerId, path);
      expect(performance.now() - started).toBeLessThan(350);
      expect(result).toEqual({ ok: false, error: "auth response too large" });
      expect(storedProvider(providerId)).toBeUndefined();
    });
  }

  for (const [name, path] of [
    ["Copilot GET rejects a declared oversized response", "/declared-copilot"],
    ["Copilot GET rejects a chunked oversized response", "/chunked-copilot"],
  ] as const) {
    it(name, async () => {
      useAuthFile(name.replaceAll(" ", "-"));
      const started = performance.now();
      const result = await loginCopilot(path);
      expect(performance.now() - started).toBeLessThan(350);
      expect(result).toEqual({ ok: false, error: "auth response too large" });
      expect(storedProvider("github-copilot")).toBeUndefined();
    });
  }

  it("rejects invalid UTF-8 responses", async () => {
    useAuthFile("invalid-utf8");
    const result = await loginWithTokenEndpoint("anthropic", "/invalid-utf8");
    expect(result).toEqual({ ok: false, error: "auth response is not valid UTF-8" });
    expect(storedProvider("anthropic")).toBeUndefined();
  });

  for (const providerId of ["anthropic", "openai-codex"] as const) {
    it(`${providerId} token exchange stops when LoginIo is cancelled`, async () => {
      useAuthFile(`cancel-${providerId}`);
      const controller = new AbortController();
      const started = hangingRequests;
      const login = loginWithTokenEndpoint(providerId, "/hang", controller.signal);
      while (hangingRequests === started) await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      const result = await settlesWithin(login, 500);
      if (result === null) server.closeAllConnections();
      expect(result).toEqual({ ok: false, error: "auth request cancelled" });
      expect(storedProvider(providerId)).toBeUndefined();
    });
  }

  it("times out within internal timeout limit", async () => {
    useAuthFile("timeout");
    process.env.TERMINA_TEST_AUTH_HTTP_TIMEOUT_MS = "50";
    const result = await settlesWithin(loginWithTokenEndpoint("anthropic", "/timeout"), 500);
    if (result === null) server.closeAllConnections();
    expect(result).toEqual({ ok: false, error: "auth request timed out" });
    expect(storedProvider("anthropic")).toBeUndefined();
  });

  it("does not start a flight if already cancelled before refresh", async () => {
    useAuthFile("cancelled-before-refresh");
    process.env.TERMINA_TEST_TOKEN_URL = `${origin}/shared-refresh`;
    modifyProvider("anthropic", () => ({
      type: "oauth",
      access: "expired-access",
      refresh: "shared-refresh-1",
      expires: Date.now() - 1,
    }));
    const controller = new AbortController();
    controller.abort();
    const before = sharedRefreshRequests;
    expect(await refreshOauth("anthropic", controller.signal)).toEqual({
      ok: false,
      error: "auth request cancelled",
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(sharedRefreshRequests).toBe(before);
    expect(storedProvider("anthropic")?.access).toBe("expired-access");
  });

  it("does not cancel shared refresh when one waiter cancels", async () => {
    useAuthFile("shared-refresh");
    process.env.TERMINA_TEST_TOKEN_URL = `${origin}/shared-refresh`;
    modifyProvider("anthropic", () => ({
      type: "oauth",
      access: "expired-access",
      refresh: "shared-refresh-1",
      expires: Date.now() - 1,
    }));
    const first = new AbortController();
    const second = new AbortController();
    const before = sharedRefreshRequests;
    const cancelledWaiter = refreshOauth("anthropic", first.signal);
    const successfulWaiter = refreshOauth("anthropic", second.signal);
    first.abort();
    expect(await cancelledWaiter).toEqual({ ok: false, error: "auth request cancelled" });
    expect(await successfulWaiter).toEqual({ ok: true });
    expect(sharedRefreshRequests).toBe(before + 1);
    expect(storedProvider("anthropic")?.access).toBe("shared-access");
  });

  it("keeps resolveAuth cancellation independent from shared refresh", async () => {
    useAuthFile("shared-resolve");
    process.env.TERMINA_TEST_TOKEN_URL = `${origin}/shared-refresh`;
    modifyProvider("anthropic", () => ({
      type: "oauth",
      access: "expired-access",
      refresh: "shared-refresh-1",
      expires: Date.now() - 1,
    }));
    const first = new AbortController();
    const second = new AbortController();
    const cancelledWaiter = resolveAuth("anthropic", first.signal);
    const successfulWaiter = resolveAuth("anthropic", second.signal);
    first.abort();
    expect(await cancelledWaiter).toEqual({ ok: false, error: "auth request cancelled" });
    const auth = await successfulWaiter;
    expect(auth.ok && auth.token).toBe("shared-access");
    expect(existsSync(process.env.TERMINA_AUTH_PATH!)).toBe(true);
    expect(JSON.parse(readFileSync(process.env.TERMINA_AUTH_PATH!, "utf8")).anthropic.access).toBe("shared-access");
  });
});
