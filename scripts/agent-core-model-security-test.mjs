import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fixtureRoot = mkdtempSync(join(tmpdir(), "termina-model-security-"));
const savedEnv = new Map();
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

const { resetAuthCache } = await import("../agent-core/auth.ts");
const { catalogFetchAllowed, loadProviderModels, modelsUrl } = await import("../agent-core/models.ts");

function restoreEnv() {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetAuthCache();
  rmSync(fixtureRoot, { recursive: true, force: true });
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withCatalogEnv(url, run) {
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

function writeAnthropicOauth(access, expires) {
  writeFileSync(
    process.env.TERMINA_AUTH_PATH,
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

test("model catalog request hardening", async (t) => {
  t.after(restoreEnv);

  await t.test("production ignores TERMINA_TEST_MODELS_URL", () => {
    delete process.env.TERMINA_CORE_TEST;
    process.env.TERMINA_TEST_MODELS_URL = "https://attacker.invalid/collect";
    assert.equal(catalogFetchAllowed(), true);
    assert.equal(modelsUrl("anthropic", "https://api.anthropic.com"), "https://api.anthropic.com/v1/models?limit=100");
  });

  await t.test("test override accepts loopback fixtures and rejects remote destinations", () => {
    process.env.TERMINA_CORE_TEST = "1";
    process.env.TERMINA_TEST_MODELS_URL = "http://127.0.0.1:43199/catalog";
    assert.equal(catalogFetchAllowed(), true);
    assert.equal(modelsUrl("anthropic", "https://api.anthropic.com"), "http://127.0.0.1:43199/catalog");

    process.env.TERMINA_TEST_MODELS_URL = "https://attacker.invalid/collect";
    assert.equal(catalogFetchAllowed(), false);
    assert.equal(modelsUrl("anthropic", "https://api.anthropic.com"), "https://api.anthropic.com/v1/models?limit=100");
  });

  await t.test("authenticated cross-origin redirects are rejected before the target request", async () => {
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
      assert.deepEqual(result, { ok: false, error: "models redirect changed origin" });
      assert.equal(targetRequests, 0);
      assert.equal(targetCredential, "");
    } finally {
      await origin.close();
      await target.close();
    }
  });

  await t.test("same-origin redirects preserve authenticated custom provider catalogs", async () => {
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
      assert.deepEqual(result, { ok: true, models: [{ id: "claude-custom" }] });
      assert.equal(redirectedCredential, "model-security-secret");
    } finally {
      await fixture.close();
    }
  });

  await t.test("same-origin redirect hops are capped", async () => {
    let requests = 0;
    const fixture = await listen((_req, res) => {
      requests += 1;
      res.statusCode = 302;
      res.setHeader("location", `/hop-${requests}`);
      res.end();
    });
    try {
      const result = await withCatalogEnv(`${fixture.origin}/start`, () => loadProviderModels("anthropic"));
      assert.deepEqual(result, { ok: false, error: "models redirect limit exceeded" });
      assert.equal(requests, 4);
    } finally {
      await fixture.close();
    }
  });

  for (const fixture of [
    { name: "401", status: 401, declared: true },
    { name: "successful primary", status: 200, declared: true },
    { name: "error", status: 503, declared: false },
  ]) {
    await t.test(`oversized ${fixture.name} body is cancelled with a stable error`, async () => {
      let endedNaturally = false;
      let cancelledEarly = false;
      let markClosed = () => {};
      const closed = new Promise((resolve) => {
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
        assert.deepEqual(result, { ok: false, error: "models response too large" });
        if (!fixture.declared) {
          await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
          assert.equal(cancelledEarly, true);
        }
      } finally {
        await server.close();
      }
    });
  }

  await t.test("oversized Anthropic pagination body rejects the whole catalog", async () => {
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
      assert.deepEqual(result, { ok: false, error: "models response too large" });
      assert.equal(pageRequests, 1);
    } finally {
      await fixture.close();
    }
  });

  for (const fixture of [
    { name: "successful primary", status: 200 },
    { name: "401", status: 401 },
    { name: "error", status: 503 },
  ]) {
    await t.test(`malformed UTF-8 ${fixture.name} body is rejected`, async () => {
      const server = await listen((_req, res) => {
        res.statusCode = fixture.status;
        res.setHeader("content-type", "application/json");
        res.end(malformedUtf8Catalog());
      });
      try {
        const result = await withCatalogEnv(`${server.origin}/models`, () => loadProviderModels("anthropic"));
        assert.deepEqual(result, { ok: false, error: "models response is not valid UTF-8" });
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
  ];

  for (const fixture of invalidAnthropicEnvelopes) {
    await t.test(`Anthropic primary ${fixture.name} envelope is rejected`, async () => {
      const server = await listen((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(fixture.body);
      });
      try {
        const result = await withCatalogEnv(`${server.origin}/models`, () => loadProviderModels("anthropic"));
        assert.deepEqual(result, { ok: false, error: "models: invalid response" });
      } finally {
        await server.close();
      }
    });
  }

  for (const fixture of invalidAnthropicEnvelopes) {
    await t.test(`Anthropic follow-up ${fixture.name} envelope rejects the whole catalog`, async () => {
      let pageRequests = 0;
      const server = await listen((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url?.includes("after_id=")) {
          pageRequests += 1;
          res.end(fixture.body);
          return;
        }
        res.end('{"data":[{"id":"claude-primary"}],"has_more":true,"last_id":"cursor-a"}');
      });
      try {
        delete process.env.TERMINA_CORE_TEST;
        delete process.env.TERMINA_TEST_MODELS_URL;
        process.env.ANTHROPIC_BASE_URL = server.origin;
        process.env.ANTHROPIC_API_KEY = "model-security-secret";
        resetAuthCache();
        const result = await loadProviderModels("anthropic");
        assert.deepEqual(result, { ok: false, error: "models: invalid response" });
        assert.equal(pageRequests, 1);
      } finally {
        await server.close();
      }
    });
  }

  for (const fixture of [
    { name: "401", status: 401, body: '{"error":"expired"}', error: 'models HTTP 401: {"error":"expired"}' },
    { name: "503", status: 503, body: '{"error":"unavailable"}', error: 'models HTTP 503: {"error":"unavailable"}' },
    { name: "malformed JSON", status: 200, body: "{", error: "models: invalid JSON" },
    {
      name: "missing continuation",
      status: 200,
      body: '{"data":[{"id":"claude-second"}],"has_more":true}',
      error: "models: invalid pagination",
    },
    {
      name: "blank continuation",
      status: 200,
      body: '{"data":[{"id":"claude-second"}],"has_more":true,"last_id":"   "}',
      error: "models: invalid pagination",
    },
  ]) {
    await t.test(`Anthropic page ${fixture.name} rejects the whole catalog`, async () => {
      let pageRequests = 0;
      const server = await listen((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url?.includes("after_id=")) {
          pageRequests += 1;
          res.statusCode = fixture.status;
          res.end(fixture.body);
          return;
        }
        res.end('{"data":[{"id":"claude-first"}],"has_more":true,"last_id":"claude-first"}');
      });
      try {
        delete process.env.TERMINA_CORE_TEST;
        delete process.env.TERMINA_TEST_MODELS_URL;
        process.env.ANTHROPIC_BASE_URL = server.origin;
        process.env.ANTHROPIC_API_KEY = "model-security-secret";
        resetAuthCache();
        const result = await loadProviderModels("anthropic");
        assert.deepEqual(result, { ok: false, error: fixture.error });
        assert.equal(pageRequests, 1);
      } finally {
        await server.close();
      }
    });
  }

  await t.test("malformed UTF-8 Anthropic page rejects the whole catalog", async () => {
    const server = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("after_id=")) {
        res.end(malformedUtf8Catalog());
        return;
      }
      res.end('{"data":[{"id":"claude-first"}],"has_more":true,"last_id":"claude-first"}');
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = server.origin;
      process.env.ANTHROPIC_API_KEY = "model-security-secret";
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      assert.deepEqual(result, { ok: false, error: "models response is not valid UTF-8" });
    } finally {
      await server.close();
    }
  });

  await t.test("Anthropic page redirect-hop exhaustion rejects the whole catalog", async () => {
    let redirectRequests = 0;
    const server = await listen((req, res) => {
      if (!req.url?.includes("after_id=") && !req.url?.startsWith("/page-hop-")) {
        res.setHeader("content-type", "application/json");
        res.end('{"data":[{"id":"claude-first"}],"has_more":true,"last_id":"claude-first"}');
        return;
      }
      redirectRequests += 1;
      res.statusCode = 302;
      res.setHeader("location", `/page-hop-${redirectRequests}`);
      res.end();
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = server.origin;
      process.env.ANTHROPIC_API_KEY = "model-security-secret";
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      assert.deepEqual(result, { ok: false, error: "models redirect limit exceeded" });
      assert.equal(redirectRequests, 4);
    } finally {
      await server.close();
    }
  });

  await t.test("missing initial Anthropic continuation rejects a partial catalog", async () => {
    const server = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"data":[{"id":"claude-first"}],"has_more":true}');
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = server.origin;
      process.env.ANTHROPIC_API_KEY = "model-security-secret";
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      assert.deepEqual(result, { ok: false, error: "models: invalid pagination" });
    } finally {
      await server.close();
    }
  });

  await t.test("Anthropic cursor cycles reject before repeating a request", async () => {
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
      assert.deepEqual(result, { ok: false, error: "models: invalid pagination" });
      assert.equal(pageRequests, 2);
    } finally {
      await server.close();
    }
  });

  await t.test("global model cap stops Anthropic pagination before another upstream request", async () => {
    const primary = Array.from({ length: 100 }, (_, i) => ({ id: `claude-primary-${i}` }));
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `claude-page-${i}` }));
    let pageRequests = 0;
    const server = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if (!req.url?.includes("after_id=")) {
        res.end(JSON.stringify({ data: primary, has_more: true, last_id: "cursor-a" }));
        return;
      }
      pageRequests += 1;
      if (pageRequests === 1) {
        res.end(JSON.stringify({ data: page, has_more: true, last_id: "cursor-b" }));
        return;
      }
      res.statusCode = 503;
      res.end('{"error":"page two must not be requested"}');
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = server.origin;
      process.env.ANTHROPIC_API_KEY = "model-security-secret";
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.models.length, 200);
      assert.equal(result.models[0]?.id, "claude-primary-0");
      assert.equal(result.models[199]?.id, "claude-page-99");
      assert.equal(pageRequests, 1);
    } finally {
      await server.close();
    }
  });

  await t.test("Anthropic page-cap exhaustion rejects the whole partial catalog", async () => {
    let pageRequests = 0;
    const server = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if (!req.url?.includes("after_id=")) {
        res.end('{"data":[{"id":"claude-primary"}],"has_more":true,"last_id":"cursor-0"}');
        return;
      }
      pageRequests += 1;
      res.end(
        JSON.stringify({
          data: [{ id: `claude-page-${pageRequests}` }],
          has_more: true,
          last_id: `cursor-${pageRequests}`,
        }),
      );
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = server.origin;
      process.env.ANTHROPIC_API_KEY = "model-security-secret";
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      assert.deepEqual(result, { ok: false, error: "models: pagination limit exceeded" });
      assert.equal(pageRequests, 4);
    } finally {
      await server.close();
    }
  });

  await t.test("duplicate Anthropic rows do not consume global model capacity", async () => {
    const primary = Array.from({ length: 198 }, (_, i) => ({ id: `claude-primary-${i}` }));
    let pageRequests = 0;
    const server = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      if (!req.url?.includes("after_id=")) {
        res.end(JSON.stringify({ data: primary, has_more: true, last_id: "cursor-a" }));
        return;
      }
      pageRequests += 1;
      if (req.url.includes("after_id=cursor-a")) {
        res.end(
          '{"data":[{"id":"claude-primary-0"},{"id":"claude-new-1"}],"has_more":true,"last_id":"cursor-b"}',
        );
        return;
      }
      if (req.url.includes("after_id=cursor-b")) {
        res.end(
          '{"data":[{"id":"claude-new-1"},{"id":"claude-new-2"}],"has_more":true,"last_id":"cursor-c"}',
        );
        return;
      }
      res.statusCode = 503;
      res.end('{"error":"page three must not be requested"}');
    });
    try {
      delete process.env.TERMINA_CORE_TEST;
      delete process.env.TERMINA_TEST_MODELS_URL;
      process.env.ANTHROPIC_BASE_URL = server.origin;
      process.env.ANTHROPIC_API_KEY = "model-security-secret";
      resetAuthCache();
      const result = await loadProviderModels("anthropic");
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.models.length, 200);
      assert.equal(result.models.filter((model) => model.id === "claude-new-1").length, 1);
      assert.equal(result.models.filter((model) => model.id === "claude-new-2").length, 1);
      assert.equal(pageRequests, 2);
    } finally {
      await server.close();
    }
  });

  await t.test("normal multi-page Anthropic pagination returns one complete catalog", async () => {
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
      assert.deepEqual(result, {
        ok: true,
        models: [{ id: "claude-primary" }, { id: "claude-page-a" }, { id: "claude-page-b" }],
      });
      assert.equal(pageRequests, 2);
    } finally {
      await server.close();
    }
  });

  await t.test("caller cancellation stops an expired-credential catalog wait before fetch", async () => {
    let tokenRequests = 0;
    let startToken = () => {};
    const tokenStarted = new Promise((resolve) => {
      startToken = resolve;
    });
    const token = await listen((_req, _res) => {
      tokenRequests += 1;
      startToken();
    });
    try {
      process.env.TERMINA_CORE_TEST = "1";
      process.env.TERMINA_TEST_MODELS_URL = "http://127.0.0.1:43199/catalog";
      process.env.TERMINA_TEST_TOKEN_URL = `${token.origin}/token`;
      writeAnthropicOauth("sk-ant-oat-expired", Date.now() - 1_000);
      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = loadProviderModels("anthropic", controller.signal);
      await tokenStarted;
      controller.abort();
      const result = await pending;
      assert.deepEqual(result, { ok: false, error: "models request cancelled" });
      assert.ok(Date.now() - startedAt < 500, "catalog cancellation waited for the shared token request");
      assert.equal(tokenRequests, 1);
    } finally {
      await token.close();
    }
  });

  await t.test("401 refresh shares one flight while one catalog caller cancels", async () => {
    let tokenRequests = 0;
    let releaseToken = () => {};
    let markTokenStarted = () => {};
    const tokenStarted = new Promise((resolve) => {
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
    const twoOldRequests = new Promise((resolve) => {
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
      assert.deepEqual(firstResult, { ok: false, error: "models request cancelled" });
      assert.equal(tokenRequests, 1);
      releaseToken();
      const secondResult = await second;
      assert.deepEqual(secondResult, { ok: true, models: [{ id: "claude-refreshed" }] });
      assert.equal(tokenRequests, 1);
    } finally {
      await catalog.close();
      await token.close();
    }
  });
});
