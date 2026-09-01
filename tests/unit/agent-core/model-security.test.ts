import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAuthCache } from "../../../agent-core/auth.ts";
import { catalogFetchAllowed, loadProviderModels, modelsUrl } from "../../../agent-core/models.ts";

describe("Agent Core Model Security & Catalog Hardening", () => {
  let fixtureRoot: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "termina-model-security-"));
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "TERMINA_AUTH_PATH",
      "TERMINA_CORE_TEST",
      "TERMINA_TEST_MODELS_URL",
      "TERMINA_TEST_TOKEN_URL",
    ]) {
      savedEnv.set(name, process.env[name]);
    }

    process.env.TERMINA_AUTH_PATH = join(fixtureRoot, "auth.json");
    process.env.ANTHROPIC_API_KEY = "model-security-secret";
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  afterAll(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetAuthCache();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  async function listen(handler: RequestListener) {
    const server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    expect(address && typeof address === "object").toBe(true);
    return {
      origin: `http://127.0.0.1:${(address as any).port}`,
      async close() {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  async function withCatalogEnv<T>(url: string, run: () => Promise<T>): Promise<T> {
    process.env.TERMINA_CORE_TEST = "1";
    process.env.TERMINA_TEST_MODELS_URL = url;
    delete process.env.ANTHROPIC_BASE_URL;
    resetAuthCache();
    return run();
  }

  function malformedUtf8Catalog() {
    return Buffer.concat([
      Buffer.from('{"data":[{"id":"claude-'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}]}'),
    ]);
  }

  function writeAnthropicOauth(access: string, expires: number) {
    writeFileSync(
      process.env.TERMINA_AUTH_PATH!,
      `${JSON.stringify({
        anthropic: {
          type: "oauth",
          access,
          refresh: "sk-ant-oat-refresh",
          expires,
        },
      })}\n`,
      { mode: 0o600 },
    );
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    resetAuthCache();
  }

  it("production ignores TERMINA_TEST_MODELS_URL", () => {
    delete process.env.TERMINA_CORE_TEST;
    process.env.TERMINA_TEST_MODELS_URL = "https://attacker.invalid/collect";
    expect(catalogFetchAllowed()).toBe(true);
    expect(modelsUrl("anthropic", "https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/models?limit=100");
  });

  it("test override accepts loopback fixtures and rejects remote destinations", () => {
    process.env.TERMINA_CORE_TEST = "1";
    process.env.TERMINA_TEST_MODELS_URL = "http://127.0.0.1:43199/catalog";
    expect(catalogFetchAllowed()).toBe(true);
    expect(modelsUrl("anthropic", "https://api.anthropic.com")).toBe("http://127.0.0.1:43199/catalog");

    process.env.TERMINA_TEST_MODELS_URL = "https://attacker.invalid/collect";
    expect(catalogFetchAllowed()).toBe(false);
    expect(modelsUrl("anthropic", "https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/models?limit=100");
  });

  it("rejects authenticated cross-origin redirects before target request", async () => {
    let targetRequests = 0;
    let targetCredential = "";
    const target = await listen((req, res) => {
      targetRequests += 1;
      targetCredential = String(req.headers["x-api-key"] ?? req.headers.authorization ?? "");
      res.setHeader("content-type", "application/json");
      res.end('{"data":[{"id":"claude-target"}],"has_more":false}');
    });
    const origin = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `${target.origin}/private-models`);
      res.end();
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = origin.origin;
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      expect(result).toEqual({ ok: false, error: "models redirect changed origin" });
      expect(targetRequests).toBe(0);
      expect(targetCredential).toBe("");
    } finally {
      await origin.close();
      await target.close();
    }
  });

  it("preserves authenticated custom provider catalogs across same-origin redirects", async () => {
    let redirectedCredential = "";
    const fixture = await listen((req, res) => {
      if (req.url?.startsWith("/v1/models")) {
        res.statusCode = 307;
        res.setHeader("location", "/catalog");
        res.end();
        return;
      }
      redirectedCredential = String(req.headers["x-api-key"] ?? "");
      res.setHeader("content-type", "application/json");
      res.end('{"data":[{"id":"claude-custom"}],"has_more":false}');
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = fixture.origin;
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      expect(result).toEqual({ ok: true, models: [{ id: "claude-custom" }] });
      expect(redirectedCredential).toBe("model-security-secret");
    } finally {
      await fixture.close();
    }
  });

  it("caps same-origin redirect hops", async () => {
    let requests = 0;
    const fixture = await listen((_req, res) => {
      requests += 1;
      res.statusCode = 302;
      res.setHeader("location", `/hop-${requests}`);
      res.end();
    });
    try {
      const result = await withCatalogEnv(`${fixture.origin}/start`, () => loadProviderModels("anthropic"));
      expect(result).toEqual({ ok: false, error: "models redirect limit exceeded" });
      expect(requests).toBe(4);
    } finally {
      await fixture.close();
    }
  });

  for (const fixture of [
    { name: "401", status: 401, declared: true },
    { name: "successful primary", status: 200, declared: true },
    { name: "error", status: 503, declared: false },
  ] as const) {
    it(`cancels oversized ${fixture.name} body with a stable error`, async () => {
      let endedNaturally = false;
      let cancelledEarly = false;
      let markClosed = () => {};
      const closed = new Promise<void>((resolve) => {
        markClosed = resolve;
      });
      const server = await listen((_req, res) => {
        res.statusCode = fixture.status;
        res.setHeader("content-type", "application/json");
        if (fixture.declared) {
          const body = "x".repeat(1_048_577);
          res.setHeader("content-length", String(Buffer.byteLength(body)));
          res.end(body);
          endedNaturally = true;
          return;
        }
        let sent = 0;
        const chunk = Buffer.alloc(65_536, 120);
        res.on("close", () => {
          cancelledEarly = !endedNaturally;
          markClosed();
        });
        const pump = () => {
          if (res.destroyed) return;
          if (sent >= 3_145_728) {
            endedNaturally = true;
            res.end();
            return;
          }
          sent += chunk.length;
          res.write(chunk);
          setImmediate(pump);
        };
        pump();
      });
      try {
        const result = await withCatalogEnv(`${server.origin}/models`, () => loadProviderModels("anthropic"));
        expect(result).toEqual({ ok: false, error: "models response too large" });
        if (!fixture.declared) {
          await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
          expect(cancelledEarly).toBe(true);
        }
      } finally {
        await server.close();
      }
    });
  }

  it("rejects whole catalog on oversized Anthropic pagination body", async () => {
    let pageRequests = 0;
    const fixture = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("after_id=")) {
        pageRequests += 1;
        const body = "x".repeat(1_048_577);
        res.setHeader("content-length", String(Buffer.byteLength(body)));
        res.end(body);
        return;
      }
      res.end('{"data":[{"id":"claude-first"}],"has_more":true,"last_id":"claude-first"}');
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = fixture.origin;
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      expect(result).toEqual({ ok: false, error: "models response too large" });
      expect(pageRequests).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  for (const fixture of [
    { name: "successful primary", status: 200 },
    { name: "401", status: 401 },
    { name: "error", status: 503 },
  ] as const) {
    it(`rejects malformed UTF-8 ${fixture.name} body`, async () => {
      const server = await listen((_req, res) => {
        res.statusCode = fixture.status;
        res.setHeader("content-type", "application/json");
        res.end(malformedUtf8Catalog());
      });
      try {
        const result = await withCatalogEnv(`${server.origin}/models`, () => loadProviderModels("anthropic"));
        expect(result).toEqual({ ok: false, error: "models response is not valid UTF-8" });
      } finally {
        await server.close();
      }
    });
  }

  const invalidAnthropicEnvelopes = [
    { name: "non-object", body: "[]" },
    { name: "empty object", body: "{}" },
    { name: "non-array data", body: '{"data":"invalid","has_more":false}' },
    { name: "missing has_more", body: '{"data":[{"id":"claude-invalid"}]}' },
    { name: "non-boolean has_more", body: '{"data":[{"id":"claude-invalid"}],"has_more":"false"}' },
  ] as const;

  for (const fixture of invalidAnthropicEnvelopes) {
    it(`rejects Anthropic primary ${fixture.name} envelope`, async () => {
      const server = await listen((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(fixture.body);
      });
      try {
        const result = await withCatalogEnv(`${server.origin}/models`, () => loadProviderModels("anthropic"));
        expect(result).toEqual({ ok: false, error: "models: invalid response" });
      } finally {
        await server.close();
      }
    });
  }

  it("detects Anthropic cursor cycles and stops before repeating requests", async () => {
    let pageRequests = 0;
    const server = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if (!req.url?.includes("after_id=")) {
        res.end('{"data":[{"id":"claude-primary"}],"has_more":true,"last_id":"cursor-a"}');
        return;
      }
      pageRequests += 1;
      if (req.url.includes("after_id=cursor-a")) {
        res.end('{"data":[{"id":"claude-page-a"}],"has_more":true,"last_id":"cursor-b"}');
        return;
      }
      res.end('{"data":[{"id":"claude-page-b"}],"has_more":true,"last_id":"cursor-a"}');
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = server.origin;
      process.env.ANTHROPIC_API_KEY = "model-security-secret";
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      expect(result).toEqual({ ok: false, error: "models: invalid pagination" });
      expect(pageRequests).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("multi-page Anthropic pagination returns complete catalog", async () => {
    let pageRequests = 0;
    const server = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if (!req.url?.includes("after_id=")) {
        res.end('{"data":[{"id":"claude-primary"}],"has_more":true,"last_id":"cursor-a"}');
        return;
      }
      pageRequests += 1;
      if (req.url.includes("after_id=cursor-a")) {
        res.end('{"data":[{"id":"claude-page-a"}],"has_more":true,"last_id":"cursor-b"}');
        return;
      }
      res.end('{"data":[{"id":"claude-page-b"}],"has_more":false,"last_id":"cursor-c"}');
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = server.origin;
      process.env.ANTHROPIC_API_KEY = "model-security-secret";
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      expect(result).toEqual({
        ok: true,
        models: [{ id: "claude-primary" }, { id: "claude-page-a" }, { id: "claude-page-b" }],
      });
      expect(pageRequests).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("shares 401 refresh flight while one catalog caller cancels", async () => {
    let tokenRequests = 0;
    let releaseToken = () => {};
    let markTokenStarted = () => {};
    const tokenStarted = new Promise<void>((resolve) => {
      markTokenStarted = resolve;
    });
    const token = await listen((_req, res) => {
      tokenRequests += 1;
      markTokenStarted();
      releaseToken = () => {
        res.setHeader("content-type", "application/json");
        res.end('{"access_token":"sk-ant-oat-new","refresh_token":"sk-ant-oat-new-refresh","expires_in":3600}');
      };
    });
    let oldCatalogRequests = 0;
    let markTwoOldRequests = () => {};
    const twoOldRequests = new Promise<void>((resolve) => {
      markTwoOldRequests = resolve;
    });
    const catalog = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization === "Bearer sk-ant-oat-old") {
        oldCatalogRequests += 1;
        if (oldCatalogRequests === 2) markTwoOldRequests();
        res.statusCode = 401;
        res.end('{"error":"expired"}');
        return;
      }
      res.end('{"data":[{"id":"claude-refreshed"}],"has_more":false}');
    });
    try {
      process.env.TERMINA_CORE_TEST = "1";
      process.env.TERMINA_TEST_MODELS_URL = `${catalog.origin}/models`;
      process.env.TERMINA_TEST_TOKEN_URL = `${token.origin}/token`;
      writeAnthropicOauth("sk-ant-oat-old", Date.now() + 3_600_000);
      const firstController = new AbortController();
      const first = loadProviderModels("anthropic", firstController.signal);
      await tokenStarted;
      const second = loadProviderModels("anthropic");
      await twoOldRequests;
      firstController.abort();
      const firstResult = await first;
      expect(firstResult).toEqual({ ok: false, error: "models request cancelled" });
      expect(tokenRequests).toBe(1);
      releaseToken();
      const secondResult = await second;
      expect(secondResult).toEqual({ ok: true, models: [{ id: "claude-refreshed" }] });
      expect(tokenRequests).toBe(1);
    } finally {
      await catalog.close();
      await token.close();
    }
  });
});
