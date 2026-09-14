import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { fetchUrl, fetchUrlError } from "../../../agent-core/main.ts";
import { policyRequest } from "../../../agent-core/main/policy-fetch.ts";
import { mcpHttpUrlError, parseMcpConfig, startMcp } from "../../../agent-core/mcp.ts";
import { resolvedHostError } from "../../../agent-core/main/url.ts";

const { lookupMock, dialMock } = vi.hoisted(() => ({ lookupMock: vi.fn(), dialMock: vi.fn() as any }));
vi.mock("node:dns/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:dns/promises")>();
  return { ...orig, lookup: lookupMock };
});
vi.mock("node:dns", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:dns")>();
  dialMock.realLookup = orig.lookup;
  return { ...orig, lookup: dialMock };
});

const originalTestFlag = process.env.TERMINA_CORE_TEST;

beforeEach(() => {
  lookupMock.mockReset();
  dialMock.mockReset();
  // Dial lookups run the real resolver unless a test overrides them.
  dialMock.mockImplementation((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    dialMock.realLookup(hostname, options, callback);
  });
});

afterEach(() => {
  if (originalTestFlag === undefined) delete process.env.TERMINA_CORE_TEST;
  else process.env.TERMINA_CORE_TEST = originalTestFlag;
  lookupMock.mockReset();
  dialMock.mockReset();
});

function expectBlocked(url: string): void {
  const fetchErr = fetchUrlError(url);
  const mcpErr = mcpHttpUrlError(url);
  expect(fetchErr, url).toMatch(/not allowed/);
  expect(mcpErr, url).toBe(fetchErr);
}

function expectAllowed(url: string): void {
  expect(fetchUrlError(url), url).toBeNull();
  expect(mcpHttpUrlError(url), url).toBeNull();
}

describe("fetch and MCP outbound URL policy", () => {
  it("rejects https loopback, link-local, and RFC1918 hosts", () => {
    process.env.TERMINA_CORE_TEST = "1";
    expectBlocked("https://127.0.0.1");
    expectBlocked("https://127.0.0.1/secret");
    expectBlocked("https://localhost/");
    expectBlocked("https://[::1]/");
    expectBlocked("https://169.254.169.254");
    expectBlocked("https://10.0.0.1");
    expectBlocked("https://192.168.1.50");
    expectBlocked("https://172.16.0.1");
    expectBlocked("https://0.0.0.0/");
    expectBlocked("https://[::]/");
    expectBlocked("https://100.64.1.1/");
    expectBlocked("https://[::ffff:0.0.0.0]/");
    expectBlocked("https://[::ffff:100.64.1.1]/");
  });

  it("rejects https multicast, ULA, and IPv4-mapped private hosts", () => {
    process.env.TERMINA_CORE_TEST = "1";
    expectBlocked("https://224.0.0.1");
    expectBlocked("https://[ff02::1]/");
    expectBlocked("https://[fc00::1]/");
    expectBlocked("https://[fe80::1]/");
    expectBlocked("https://[::ffff:127.0.0.1]/");
    expectBlocked("https://[::ffff:169.254.169.254]/");
    expectBlocked("https://[::ffff:10.1.2.3]/");
  });

  it("allows public https hosts", () => {
    process.env.TERMINA_CORE_TEST = "1";
    expectAllowed("https://example.com/x");
    expectAllowed("https://8.8.8.8/");
    expectAllowed("https://[2001:4860:4860::8888]/");
  });

  it("keeps test-only http loopback and rejects other http hosts", () => {
    process.env.TERMINA_CORE_TEST = "1";
    expectAllowed("http://127.0.0.1:9/");
    expectAllowed("http://localhost/");
    expectAllowed("http://[::1]/");
    expect(fetchUrlError("http://10.0.0.1/")).toMatch(/https/);
    expect(mcpHttpUrlError("http://169.254.169.254/")).toMatch(/https/);

    delete process.env.TERMINA_CORE_TEST;
    expect(fetchUrlError("http://127.0.0.1/")).toMatch(/https/);
    expect(mcpHttpUrlError("http://localhost/")).toMatch(/https/);
  });

  it("fails closed for fetch https to private hosts without opening a socket", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    for (const url of ["https://127.0.0.1", "https://169.254.169.254", "https://10.0.0.1"]) {
      const result = await fetchUrl(url);
      expect(result.isError, url).toBe(true);
      expect(result.content, url).toMatch(/not allowed/);
    }
    // Literal blocks return before any transport work; nothing dials.
    expect(dialMock).not.toHaveBeenCalled();
  });

  it("re-checks redirect hops and fails closed on a private https location", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    let hops = 0;
    const server = createServer((_req, res) => {
      hops += 1;
      res.writeHead(302, { location: "https://127.0.0.1/secret" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback server did not bind");
      const result = await fetchUrl(`http://127.0.0.1:${address.port}/go`);
      expect(hops).toBe(1);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/not allowed/);
    } finally {
      server.close();
    }
  });

  it("still fetches test-only http loopback", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("loopback-ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback server did not bind");
      const result = await fetchUrl(`http://127.0.0.1:${address.port}/`);
      expect(result.isError).toBe(false);
      expect(result.content).toBe("loopback-ok");
    } finally {
      server.close();
    }
  });

  it("drops MCP HTTPS servers on blocked hosts", () => {
    process.env.TERMINA_CORE_TEST = "1";
    expect(
      parseMcpConfig({ mcpServers: { web: { type: "http", url: "https://127.0.0.1/mcp" } } }),
    ).toEqual([]);
    expect(
      parseMcpConfig({ mcpServers: { web: { type: "http", url: "https://169.254.169.254/mcp" } } }),
    ).toEqual([]);
    expect(
      parseMcpConfig({ mcpServers: { web: { type: "http", url: "https://192.168.0.9/mcp" } } }),
    ).toEqual([]);
    expect(
      parseMcpConfig({ mcpServers: { web: { type: "http", url: "https://example.com/mcp" } } }).map((s) => s.name),
    ).toEqual(["web"]);
  });

  it("does not resolve hosts while parsing MCP config", () => {
    process.env.TERMINA_CORE_TEST = "1";
    const parsed = parseMcpConfig({ mcpServers: { web: { type: "http", url: "https://example.com/mcp" } } });
    expect(parsed.map((s) => s.name)).toEqual(["web"]);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("fails closed when a public name resolves to a private address", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    expect(await resolvedHostError("private.test")).toMatch(/not allowed/);
    const result = await fetchUrl("https://private.test/secret");
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not allowed/);
    expect(lookupMock).toHaveBeenCalled();
    // The precheck blocked first; the dial path never resolved.
    expect(dialMock).not.toHaveBeenCalled();
  });

  it("still fetches a public name whose dial answers are public", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("public-ok");
    });
    // Dual-stack bind: localhost may resolve to ::1 or 127.0.0.1 first.
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback server did not bind");
      // Localhost exercises the real dial path offline; the test bypass
      // covers loopback in both the precheck and the dial lookup.
      expect(await resolvedHostError("example.com")).toBeNull();
      const result = await fetchUrl(`http://localhost:${address.port}/x`);
      expect(result.isError).toBe(false);
      expect(result.content).toBe("public-ok");
      expect(lookupMock).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("rejects MCP HTTP connect when the name resolves private", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    lookupMock.mockResolvedValue([{ address: "10.0.0.9", family: 4 }]);
    const session = await startMcp(
      [{ name: "web", url: "https://private.test/mcp", args: [], env: {} }],
      { projectRoot: ".", confineCwd: () => "." },
    );
    expect(session.tools).toEqual([]);
    expect(session.notes.some((note) => note.includes("not allowed"))).toBe(true);
    expect(dialMock).not.toHaveBeenCalled();
    session.shutdown();
  });

  it("binds the dial to validated answers when DNS flips public to private", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    // Precheck sees a public answer and passes; the dial lookup then answers
    // private (rebinding). The connection must be refused at dial time.
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    dialMock.mockImplementation((_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
      callback(null, [{ address: "10.0.0.9", family: 4 }], 4);
    });
    const result = await fetchUrl("https://rebind.test/secret", { timeoutMs: 5000 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not allowed/);
    expect(lookupMock).toHaveBeenCalled();
    expect(dialMock).toHaveBeenCalled();
  });

  it("binds MCP dials to validated answers on reconnect", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    dialMock.mockImplementation((_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
      callback(null, [{ address: "169.254.169.254", family: 4 }], 4);
    });
    const session = await startMcp(
      [{ name: "web", url: "https://rebind.test/mcp", args: [], env: {} }],
      { projectRoot: ".", confineCwd: () => "." },
    );
    expect(session.tools).toEqual([]);
    expect(session.notes.some((note) => note.includes("not allowed"))).toBe(true);
    session.shutdown();
  });

  it("covers DNS in the operation deadline and ignores late answers", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    lookupMock.mockReturnValue(gate);
    const started = Date.now();
    const result = await fetchUrl("https://slow.test/x", { timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timed out/);
    // The late answer lands after the deadline and must be safely ignored.
    release([{ address: "93.184.216.34", family: 4 }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("fails fast on an already-requested stop before DNS", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    lookupMock.mockReturnValue(new Promise(() => {}));
    const result = await fetchUrl("https://slow.test/x", { timeoutMs: 5000, shouldStop: () => true });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/interrupted/);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("fails closed when DNS fails", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    lookupMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND missing.test"));
    const result = await fetchUrl("https://missing.test/x", { timeoutMs: 2000 });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/could not resolve/);
    expect(dialMock).not.toHaveBeenCalled();
  });

  it("applies one total deadline across redirect hops", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    const server = createServer((req, res) => {
      const hop = Number(new URL(req.url ?? "/", "http://x").pathname.slice(2) || 0);
      setTimeout(() => {
        if (hop >= 5) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("done");
        } else {
          res.writeHead(302, { location: `/r${hop + 1}` });
          res.end();
        }
      }, 60);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback server did not bind");
      const result = await fetchUrl(`http://127.0.0.1:${address.port}/r0`, { timeoutMs: 150 });
      // Six 60ms hops would succeed under per-hop deadlines; the single
      // operation deadline fires mid-chain instead.
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/timed out/);
    } finally {
      server.close();
    }
  });

  it("still rejects untrusted TLS through the policy transport", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    if (spawnSync("openssl", ["version"]).status !== 0) {
      console.warn("skipping TLS test: openssl unavailable");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "termina-tls-"));
    try {
      const key = join(dir, "key.pem");
      const cert = join(dir, "cert.pem");
      const made = spawnSync("openssl", [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
        "-nodes", "-keyout", key, "-out", cert, "-days", "1",
        "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      ]);
      expect(made.status).toBe(0);
      const { createServer: createHttpsServer } = await import("node:https");
      const { readFileSync } = await import("node:fs");
      const server = createHttpsServer(
        { key: readFileSync(key), cert: readFileSync(cert) },
        (_req, res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("tls-ok");
        },
      );
      await new Promise<void>((resolve) => server.listen(0, resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("TLS server did not bind");
        // Localhost keeps the dial offline; the self-signed + mismatched
        // certificate must still be rejected (verification is never off).
        await expect(policyRequest({ url: `https://localhost:${address.port}/`, method: "GET", headers: {} })).rejects.toThrow(
          /self-signed|certificate|unable to verify/i,
        );
      } finally {
        server.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
