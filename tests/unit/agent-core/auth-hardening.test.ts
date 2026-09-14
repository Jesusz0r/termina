import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Refs #225: auth hardening batch (item 4 deferred — see the PR notes).
describe("auth hardening batch", () => {
  let root: string;
  let authFile: string;
  let store: typeof import("../../../agent-core/auth/store.ts");
  let lock: typeof import("../../../agent-core/auth/lock.ts");
  let http: typeof import("../../../agent-core/auth/http.ts");
  let oauth: typeof import("../../../agent-core/auth/oauth.ts");
  let resolveMod: typeof import("../../../agent-core/auth/resolve.ts");
  let login: typeof import("../../../agent-core/auth/login.ts");
  let endpoints: typeof import("../../../agent-core/auth/endpoints.ts");
  let anthropic: typeof import("../../../agent-core/auth/providers/anthropic.ts");

  beforeAll(async () => {
    process.env.TERMINA_CORE_TEST = "1";
    root = mkdtempSync(join(tmpdir(), "termina-auth-harden-"));
    authFile = join(root, "auth.json");
    process.env.TERMINA_AUTH_PATH = authFile;
    store = await import("../../../agent-core/auth/store.ts");
    lock = await import("../../../agent-core/auth/lock.ts");
    http = await import("../../../agent-core/auth/http.ts");
    oauth = await import("../../../agent-core/auth/oauth.ts");
    resolveMod = await import("../../../agent-core/auth/resolve.ts");
    login = await import("../../../agent-core/auth/login.ts");
    endpoints = await import("../../../agent-core/auth/endpoints.ts");
    anthropic = await import("../../../agent-core/auth/providers/anthropic.ts");
  });

  afterAll(() => {
    delete process.env.TERMINA_AUTH_PATH;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.TERMINA_AUTH_PATH = authFile;
    store.resetAuthCache();
    for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
    writeFileSync(authFile, "{}\n", { mode: 0o600 });
    store.resetAuthCache();
  });

  it("item 1: credential posts never follow redirects", async () => {
    let landed = 0;
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/redir") {
        res.writeHead(307, { location: "/landed" });
        res.end();
        return;
      }
      if (path === "/landed") {
        landed += 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no bind");
      const origin = `http://127.0.0.1:${address.port}`;
      await expect(http.postJson(`${origin}/redir`, { secret: "s" })).rejects.toThrow();
      await expect(http.authFetch(`${origin}/redir`, { method: "GET" })).rejects.toThrow();
      expect(landed).toBe(0);
      const direct = await http.postJson(`${origin}/echo`, { secret: "s" });
      expect(direct.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it("item 2: xai verification host is pinned like github", async () => {
    const realFetch = globalThis.fetch;
    const prevDevice = process.env.TERMINA_TEST_DEVICE_URL;
    const prevToken = process.env.TERMINA_TEST_TOKEN_URL;
    delete process.env.TERMINA_TEST_DEVICE_URL;
    delete process.env.TERMINA_TEST_TOKEN_URL;
    const stub = (verificationUri: string) => {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        device_code: "d",
        user_code: "u",
        verification_uri: verificationUri,
        interval: 5,
        expires_in: 60,
      }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    };
    try {
      stub("https://evil.example/verify");
      await expect(oauth.requestXaiDeviceCode()).rejects.toThrow(/Untrusted verification URI/);
      stub("https://auth.x.ai/device");
      const pinned = await oauth.requestXaiDeviceCode();
      expect(pinned.verificationUri).toBe("https://auth.x.ai/device");
      stub("https://evil.example/verify");
      await expect(oauth.requestGithubDeviceCode()).rejects.toThrow(/Untrusted verification URI/);
      stub("https://github.com/login/device");
      const github = await oauth.requestGithubDeviceCode();
      expect(github.verificationUri).toBe("https://github.com/login/device");
    } finally {
      globalThis.fetch = realFetch;
      if (prevDevice === undefined) delete process.env.TERMINA_TEST_DEVICE_URL;
      else process.env.TERMINA_TEST_DEVICE_URL = prevDevice;
      if (prevToken === undefined) delete process.env.TERMINA_TEST_TOKEN_URL;
      else process.env.TERMINA_TEST_TOKEN_URL = prevToken;
    }
  });

  it("item 3: readAuth returns a copy callers cannot mutate", () => {
    writeFileSync(authFile, JSON.stringify({ openai: { type: "api_key", key: "k" } }), { mode: 0o600 });
    store.resetAuthCache();
    const first = store.readAuth();
    expect(first.ok).toBe(true);
    if (first.ok) (first.data.openai as Record<string, unknown>).key = "mutated";
    const second = store.readAuth();
    expect(second).toEqual({ ok: true, data: { openai: { type: "api_key", key: "k" } } });
    if (second.ok) (second.data.openai as Record<string, unknown>).key = "mutated-again";
    expect(store.readAuth()).toEqual({ ok: true, data: { openai: { type: "api_key", key: "k" } } });
  });

  it("item 6: stale lock candidates and temp files are swept, live ones kept", () => {
    const deadPid = Number(spawnSync(process.execPath, ["--version"]).pid);
    expect(Number.isSafeInteger(deadPid)).toBe(true);
    // Stale temp file holding credentials.
    const staleTmp = join(root, `.auth.json.tmp-${deadPid}-sweepme`);
    writeFileSync(staleTmp, JSON.stringify({ openai: { type: "api_key", key: "orphan" } }), { mode: 0o600 });
    // Live temp file (own pid) and a wrong-mode decoy are preserved.
    const liveTmp = join(root, `.auth.json.tmp-${process.pid}-live`);
    writeFileSync(liveTmp, "{}", { mode: 0o600 });
    const looseTmp = join(root, `.auth.json.tmp-${deadPid}-loose`);
    writeFileSync(looseTmp, "{}", { mode: 0o644 });
    // Stale candidate with an owner record and an empty guard.
    const token = "sweepcandidate";
    const staleCandidate = join(root, `.auth-lock-candidate-${deadPid}-candidate`);
    mkdirSync(staleCandidate, { mode: 0o700 });
    const st = lstatSync(staleCandidate);
    writeFileSync(
      join(staleCandidate, `.record-${token}-${st.dev}-${st.ino}`),
      JSON.stringify({ pid: deadPid, token, startedAt: Date.now(), processIdentity: "test", dev: st.dev, ino: st.ino }),
      { mode: 0o600 },
    );
    mkdirSync(join(staleCandidate, `.owner-${token}-${st.dev}-${st.ino}`), { mode: 0o700 });
    // Empty stale candidate (crashed before writing the record).
    const emptyCandidate = join(root, `.auth-lock-candidate-${deadPid}-empty`);
    mkdirSync(emptyCandidate, { mode: 0o700 });
    // Live candidate (own pid) is preserved.
    const liveCandidate = join(root, `.auth-lock-candidate-${process.pid}-live`);
    mkdirSync(liveCandidate, { mode: 0o700 });

    store.modifyProvider("openai", () => ({ type: "api_key", key: "k" }));

    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(staleCandidate)).toBe(false);
    expect(existsSync(emptyCandidate)).toBe(false);
    expect(existsSync(liveTmp)).toBe(true);
    expect(existsSync(looseTmp)).toBe(true);
    expect(existsSync(liveCandidate)).toBe(true);
  });

  it("item 7: empty provider/ model refs take the provider default", () => {
    expect(resolveMod.parseModelRef("openai/")).toEqual({ provider: "openai", model: resolveMod.DEFAULT_MODELS.openai.main });
    expect(resolveMod.parseModelRef("anthropic/")).toEqual({ provider: "anthropic", model: resolveMod.DEFAULT_MODELS.anthropic.main });
    expect(resolveMod.parseModelRef("openai/gpt-5")).toEqual({ provider: "openai", model: "gpt-5" });
    expect(resolveMod.parseModelRef("mystery-model")).toBeNull();
    expect(resolveMod.parseModelRef("vendor/unknown-id")).toBeNull();
    expect(resolveMod.parseModelRef("")).toBeNull();
  });

  it("item 8: mismatched login modes are rejected at parse time", () => {
    for (const line of [
      "/login anthropic device",
      "/login xai browser",
      "/login xai code",
      "/login google code",
      "/login openai device",
      "/login openrouter device",
      "/login openai-codex device",
      "/login google browser",
    ]) {
      const parsed = login.parseAuthCommand(line);
      expect("error" in parsed, line).toBe(true);
    }
    expect(login.parseAuthCommand("/login xai device")).toEqual({ cmd: "login", mode: "device", provider: "xai" });
    expect(login.parseAuthCommand("/login anthropic code")).toEqual({ cmd: "login", mode: "code", provider: "anthropic" });
    expect(login.parseAuthCommand("/login anthropic browser")).toEqual({ cmd: "login", mode: "browser", provider: "anthropic" });
    expect(login.parseAuthCommand("/login github-copilot device")).toEqual({ cmd: "login", mode: "device", provider: "github-copilot" });
    expect(login.parseAuthCommand("/login openai oauth")).toEqual({ cmd: "login", mode: "browser", provider: "openai-codex" });
  });

  it("item 9: base-url overrides need scheme and host, else the default wins", () => {
    const prev = process.env.OPENAI_BASE_URL;
    try {
      const def = endpoints.baseUrl("openai");
      expect(def).toBe("https://api.openai.com/v1");
      process.env.OPENAI_BASE_URL = "file:///etc/passwd";
      expect(endpoints.baseUrl("openai")).toBe(def);
      process.env.OPENAI_BASE_URL = "not a url";
      expect(endpoints.baseUrl("openai")).toBe(def);
      process.env.OPENAI_BASE_URL = "https://";
      expect(endpoints.baseUrl("openai")).toBe(def);
      process.env.OPENAI_BASE_URL = "gopher://proxy.example/v1";
      expect(endpoints.baseUrl("openai")).toBe(def);
      process.env.OPENAI_BASE_URL = "https://proxy.example/v1/";
      expect(endpoints.baseUrl("openai")).toBe("https://proxy.example/v1");
      process.env.OPENAI_BASE_URL = "http://127.0.0.1:9999/v1";
      expect(endpoints.baseUrl("openai")).toBe("http://127.0.0.1:9999/v1");
      expect(endpoints.validateBaseUrlOverride(undefined)).toBeNull();
      expect(endpoints.validateBaseUrlOverride("  ")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prev;
    }
  });

  it("item 10: a self-owned witness-dead lock self-heals once", () => {
    const binding = lock.authPathBinding(authFile);
    const handle = lock.tryAcquireAuthLock(`${authFile}.lock`, binding);
    expect(handle).not.toBeNull();
    // Simulate the abandoned publish: the owner record stays, the witness
    // reader goes away, and no handle is ever released.
    closeSync(handle!.witnessFd!);
    store.modifyProvider("openai", () => ({ type: "api_key", key: "healed" }));
    expect(store.readAuth()).toEqual({ ok: true, data: { openai: { type: "api_key", key: "healed" } } });
    expect(existsSync(`${authFile}.lock`)).toBe(false);
  });

  it("item 11: anthropic headers follow the credential source", () => {
    expect(anthropic.pickHeaders("plain-key", { type: "api_key" })["x-api-key"]).toBe("plain-key");
    // Source wins over the substring marker in both directions.
    expect(anthropic.pickHeaders("sk-ant-oat-xyz", { type: "api_key" })["x-api-key"]).toBe("sk-ant-oat-xyz");
    const oauth = anthropic.pickHeaders("no-marker-here", { type: "oauth" });
    expect(oauth.authorization).toBe("Bearer no-marker-here");
    expect(oauth["anthropic-beta"]).toContain("oauth");
    const envBearer = anthropic.pickHeaders("gateway-token", { envName: "ANTHROPIC_AUTH_TOKEN" });
    expect(envBearer.authorization).toBe("Bearer gateway-token");
    expect(anthropic.pickHeaders("console-key", { envName: "ANTHROPIC_API_KEY" })["x-api-key"]).toBe("console-key");
    // Unsourced tokens fail closed to x-api-key; header keys off source, not a marker.
    expect(anthropic.pickHeaders("sk-ant-oat-legacy")["x-api-key"]).toBe("sk-ant-oat-legacy");
    expect(anthropic.pickHeaders("sk-ant-oat-legacy").authorization).toBeUndefined();
    expect(anthropic.pickHeaders("bare-key")["x-api-key"]).toBe("bare-key");
  });

  it("item 11: ANTHROPIC_AUTH_TOKEN resolves to bearer without any marker", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevTok = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = "gateway-token-no-marker";
    try {
      store.resetAuthCache();
      const resolved = await resolveMod.resolveAuth("anthropic");
      expect(resolved.ok && resolved.envName).toBe("ANTHROPIC_AUTH_TOKEN");
      expect(resolved.ok && resolved.headers.authorization).toBe("Bearer gateway-token-no-marker");
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevTok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = prevTok;
    }
  });

  it("item 12: browser callbacks complete and free the port twice in a row", async () => {
    const prevPort = process.env.TERMINA_TEST_REDIRECT_PORT;
    const prevTimeout = process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS;
    const probe = createServer(() => {});
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("no bind");
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    process.env.TERMINA_TEST_REDIRECT_PORT = String(port);
    process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS = "0";
    const hit = async (): Promise<void> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`);
          await res.text();
          return;
        } catch {
          if (Date.now() >= deadline) throw new Error("callback server never listened");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    };
    try {
      for (let round = 0; round < 2; round++) {
        let opened = 0;
        const pending = login.runLogin("anthropic", "browser", {
          write: () => {},
          openUrl: () => { opened += 1; },
        });
        await hit();
        const result = await pending;
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/login cancelled/);
        expect(opened).toBe(1);
      }
    } finally {
      if (prevPort === undefined) delete process.env.TERMINA_TEST_REDIRECT_PORT;
      else process.env.TERMINA_TEST_REDIRECT_PORT = prevPort;
      if (prevTimeout === undefined) delete process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS;
      else process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS = prevTimeout;
    }
  });

  it("item 5: lock acquire and release still round-trip", () => {
    store.modifyProvider("openai", () => ({ type: "api_key", key: "k" }));
    store.modifyProvider("openai", () => null);
    expect(store.readAuth()).toEqual({ ok: true, data: {} });
    expect(existsSync(`${authFile}.lock`)).toBe(false);
  });
});
