import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fixtureRoot = mkdtempSync(join(tmpdir(), "termina-auth-http-"));
const savedEnv = new Map();
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

const {
  exchangeGithubCopilotToken,
  modifyProvider,
  readAuth,
  requestGithubDeviceCode,
  requestXaiDeviceCode,
  refreshOauth,
  resetAuthCache,
  resolveAuth,
  runLogin,
} = await import("../agent-core/auth.ts");

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

function sendDelayedOversize(res, body, declared) {
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

const server = createServer((req, res) => {
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
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

function useAuthFile(name) {
  process.env.TERMINA_AUTH_PATH = join(fixtureRoot, name, "auth.json");
  delete process.env.TERMINA_TEST_AUTH_HTTP_TIMEOUT_MS;
  delete process.env.TERMINA_TEST_COPILOT_TOKEN_URL;
  delete process.env.TERMINA_TEST_TOKEN_URL;
  resetAuthCache();
}

function storedProvider(providerId) {
  const got = readAuth();
  return got.ok ? got.data[providerId] : undefined;
}

async function loginWithTokenEndpoint(providerId, path, signal) {
  process.env.TERMINA_TEST_TOKEN_URL = `${origin}${path}`;
  return runLogin(providerId, "code", {
    write: () => {},
    waitForCode: async () => "fixture-code",
    signal,
  });
}

async function loginCopilot(path, signal) {
  process.env.TERMINA_TEST_COPILOT_TOKEN_URL = `${origin}${path}`;
  return runLogin("github-copilot", "key", {
    write: () => {},
    waitForCode: async () => "github-token",
    signal,
  });
}

async function settlesWithin(promise, timeoutMs) {
  const marker = Symbol("timeout");
  const result = await Promise.race([
    promise.catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })),
    new Promise((resolve) => setTimeout(() => resolve(marker), timeoutMs)),
  ]);
  return result === marker ? null : result;
}

function restore() {
  server.closeAllConnections();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetAuthCache();
  rmSync(fixtureRoot, { recursive: true, force: true });
}

test("auth HTTP responses are bounded and cancellable", async (t) => {
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    restore();
  });

  await t.test("production ignores auth test hooks and test URLs stay loopback-only", async () => {
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
    const seen = [];
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
        assert.deepEqual(refreshed, { ok: true }, `refresh must ignore remote token hook in mode ${mode ?? "production"}`);
        assert.equal(seen.at(-1)?.url, "https://platform.claude.com/v1/oauth/token");

        const device = await requestGithubDeviceCode();
        assert.equal(device.deviceCode, "canonical-device");
        assert.equal(seen.at(-1)?.url, "https://github.com/login/device/code");

        const xaiDevice = await requestXaiDeviceCode();
        assert.equal(xaiDevice.deviceCode, "canonical-xai-device");
        assert.equal(xaiDevice.intervalMs, 1_000, `remote device hook must not disable xAI polling floor in mode ${mode ?? "production"}`);
        assert.equal(seen.at(-1)?.url, "https://auth.x.ai/oauth2/device/code");

        const copilot = await exchangeGithubCopilotToken("github-token");
        assert.equal(copilot.ok, true);
        assert.equal(seen.at(-1)?.url, "https://api.github.com/copilot_internal/v2/token");

        let authorize = "";
        const codeResult = await runLogin("anthropic", "code", {
          write: (text) => { authorize += text; },
          waitForCode: async () => "",
        });
        assert.deepEqual(codeResult, { ok: false, error: "login failed: empty code" });
        const authUrl = (authorize.match(/authorize: (\S+)/) || [])[1];
        assert.equal(new URL(authUrl).origin, "https://claude.ai");

        const controller = new AbortController();
        const browser = runLogin("anthropic", "browser", { write: () => {}, openUrl: () => {}, signal: controller.signal });
        await new Promise((resolve) => setTimeout(resolve, 25));
        controller.abort();
        assert.deepEqual(
          await browser,
          {
            ok: false,
            error: mode === undefined ? "login cancelled" : "login cancelled — browser closed or timed out",
          },
          `login timeout override must require explicit test mode (${mode ?? "production"})`,
        );
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

  await t.test("normal bounded JSON login succeeds", async () => {
    useAuthFile("normal");
    const result = await loginWithTokenEndpoint("anthropic", "/normal");
    assert.equal(result.ok, true);
    assert.equal(storedProvider("anthropic")?.access, "normal-access");
  });

  for (const [name, providerId, path] of [
    ["postJson rejects a declared oversized response", "anthropic", "/declared-oauth"],
    ["postJson rejects a chunked oversized response", "anthropic", "/chunked-oauth"],
    ["postForm rejects a declared oversized response", "openai-codex", "/declared-oauth"],
    ["postForm rejects a chunked oversized response", "openai-codex", "/chunked-oauth"],
  ]) {
    await t.test(name, async () => {
      useAuthFile(name.replaceAll(" ", "-"));
      const started = performance.now();
      const result = await loginWithTokenEndpoint(providerId, path);
      assert.ok(performance.now() - started < 250, "oversized response should be cancelled before its delayed tail");
      assert.deepEqual(result, { ok: false, error: "auth response too large" });
      assert.equal(storedProvider(providerId), undefined);
    });
  }

  for (const [name, path] of [
    ["Copilot GET rejects a declared oversized response", "/declared-copilot"],
    ["Copilot GET rejects a chunked oversized response", "/chunked-copilot"],
  ]) {
    await t.test(name, async () => {
      useAuthFile(name.replaceAll(" ", "-"));
      const started = performance.now();
      const result = await loginCopilot(path);
      assert.ok(performance.now() - started < 250, "oversized response should be cancelled before its delayed tail");
      assert.deepEqual(result, { ok: false, error: "auth response too large" });
      assert.equal(storedProvider("github-copilot"), undefined);
    });
  }

  await t.test("strict UTF-8 rejects replacement-decoded credentials", async () => {
    useAuthFile("invalid-utf8");
    const result = await loginWithTokenEndpoint("anthropic", "/invalid-utf8");
    assert.deepEqual(result, { ok: false, error: "auth response is not valid UTF-8" });
    assert.equal(storedProvider("anthropic"), undefined);
  });

  for (const providerId of ["anthropic", "openai-codex"]) {
    await t.test(`${providerId} token exchange stops when LoginIo is cancelled`, async () => {
      useAuthFile(`cancel-${providerId}`);
      const controller = new AbortController();
      const started = hangingRequests;
      const login = loginWithTokenEndpoint(providerId, "/hang", controller.signal);
      while (hangingRequests === started) await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      const result = await settlesWithin(login, 500);
      if (result === null) server.closeAllConnections();
      assert.deepEqual(result, { ok: false, error: "auth request cancelled" });
      assert.equal(storedProvider(providerId), undefined);
    });
  }

  await t.test("an auth exchange has a finite internal timeout", async () => {
    useAuthFile("timeout");
    process.env.TERMINA_TEST_AUTH_HTTP_TIMEOUT_MS = "50";
    const result = await settlesWithin(loginWithTokenEndpoint("anthropic", "/timeout"), 500);
    if (result === null) server.closeAllConnections();
    assert.deepEqual(result, { ok: false, error: "auth request timed out" });
    assert.equal(storedProvider("anthropic"), undefined);
  });

  await t.test("an already-cancelled refresh does not start a credential-writing flight", async () => {
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
    assert.deepEqual(await refreshOauth("anthropic", controller.signal), {
      ok: false,
      error: "auth request cancelled",
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(sharedRefreshRequests, before);
    assert.equal(storedProvider("anthropic")?.access, "expired-access");
  });

  await t.test("one cancelled refresh waiter does not cancel the shared refresh", async () => {
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
    assert.deepEqual(await cancelledWaiter, { ok: false, error: "auth request cancelled" });
    assert.deepEqual(await successfulWaiter, { ok: true });
    assert.equal(sharedRefreshRequests, before + 1);
    assert.equal(storedProvider("anthropic")?.access, "shared-access");
  });

  await t.test("resolveAuth waiter cancellation is independent from a shared refresh", async () => {
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
    assert.deepEqual(await cancelledWaiter, { ok: false, error: "auth request cancelled" });
    const auth = await successfulWaiter;
    assert.equal(auth.ok && auth.token, "shared-access");
    assert.ok(existsSync(process.env.TERMINA_AUTH_PATH));
    assert.equal(JSON.parse(readFileSync(process.env.TERMINA_AUTH_PATH, "utf8")).anthropic.access, "shared-access");
  });
});
