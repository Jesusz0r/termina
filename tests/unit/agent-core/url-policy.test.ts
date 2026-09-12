import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { fetchUrl, fetchUrlError } from "../../../agent-core/main.ts";
import { mcpHttpUrlError, parseMcpConfig } from "../../../agent-core/mcp.ts";

const originalTestFlag = process.env.TERMINA_CORE_TEST;

afterEach(() => {
  if (originalTestFlag === undefined) delete process.env.TERMINA_CORE_TEST;
  else process.env.TERMINA_CORE_TEST = originalTestFlag;
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
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fetch should not run for a blocked host");
    };
    try {
      for (const url of ["https://127.0.0.1", "https://169.254.169.254", "https://10.0.0.1"]) {
        const result = await fetchUrl(url);
        expect(result.isError, url).toBe(true);
        expect(result.content, url).toMatch(/not allowed/);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("re-checks redirect hops and fails closed on a private https location", async () => {
    process.env.TERMINA_CORE_TEST = "1";
    const originalFetch = globalThis.fetch;
    let hops = 0;
    globalThis.fetch = async (input) => {
      hops += 1;
      const url = String(input);
      if (url.includes("example.com")) {
        return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } });
      }
      throw new Error(`fetch followed a blocked redirect: ${url}`);
    };
    try {
      const result = await fetchUrl("https://example.com/go");
      expect(hops).toBe(1);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/not allowed/);
    } finally {
      globalThis.fetch = originalFetch;
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
});
