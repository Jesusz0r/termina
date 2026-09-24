import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { policyRequest, type PolicyHttpResponse } from "../../../agent-core/main/policy-fetch.ts";

describe("policy HTTP decoding lifecycle", () => {
  let server: Server;
  let response: PolicyHttpResponse | undefined;
  let oldTest: string | undefined;

  beforeEach(() => {
    oldTest = process.env.TERMINA_CORE_TEST;
    process.env.TERMINA_CORE_TEST = "1";
  });

  afterEach(async () => {
    response?.cancel();
    response = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (oldTest === undefined) delete process.env.TERMINA_CORE_TEST;
    else process.env.TERMINA_CORE_TEST = oldTest;
  });

  async function request(send: (res: ServerResponse) => void, signal?: AbortSignal) {
    server = createServer((_req, res) => send(res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    response = await policyRequest({
      url: `http://127.0.0.1:${address.port}/`, method: "GET", headers: {}, signal,
    });
    return response;
  }

  async function readBody(res: PolicyHttpResponse): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }

  async function expectClosed() {
    await expect.poll(() => new Promise<number>((resolve, reject) => {
      server.getConnections((error, count) => error ? reject(error) : resolve(count));
    })).toBe(0);
  }

  it("decodes stacked encodings in reverse order", async () => {
    const res = await request((out) => {
      out.writeHead(200, { "content-encoding": "gzip, br" });
      out.end(brotliCompressSync(gzipSync("stacked body")));
    });
    expect(await readBody(res)).toBe("stacked body");
  });

  for (const encoding of ["identity", "unknown", "constructor", "__proto__"]) {
    it(`passes through unsupported or identity encoding: ${encoding}`, async () => {
      const res = await request((out) => {
        out.writeHead(200, { "content-encoding": encoding });
        out.end("unmodified body");
      });
      expect(await readBody(res)).toBe("unmodified body");
    });
  }

  it("retains decoder errors until a delayed consumer starts reading", async () => {
    const res = await request((out) => {
      out.writeHead(200, { "content-encoding": "gzip, br" });
      out.end("not compressed");
    });
    await expect.poll(() => res.body.destroyed).toBe(true);
    await expect(readBody(res)).rejects.toThrow();
  });

  for (const layer of ["outer", "inner"] as const) {
    it(`propagates ${layer} decoder errors to the body consumer`, async () => {
      const res = await request((out) => {
        out.writeHead(200, { "content-encoding": "gzip, br" });
        const invalid = Buffer.from("not compressed data");
        out.end(layer === "outer" ? invalid : brotliCompressSync(invalid));
      });
      await expect(readBody(res)).rejects.toThrow();
      res.cancel();
      await expectClosed();
    });
  }

  it("propagates an interrupted wire response through the decoders", async () => {
    const res = await request((out) => {
      out.writeHead(200, { "content-encoding": "gzip, br", "content-length": "10000" });
      out.write(brotliCompressSync(gzipSync("partial")));
    });
    const reading = readBody(res);
    const rejected = expect(reading).rejects.toThrow();
    server.closeAllConnections();
    await rejected;
    await expectClosed();
  });

  it("propagates caller abort through the decoders", async () => {
    const controller = new AbortController();
    const res = await request((out) => {
      out.writeHead(200, { "content-encoding": "gzip, br" });
      out.flushHeaders();
    }, controller.signal);
    const rejected = expect(readBody(res)).rejects.toThrow();
    controller.abort();
    await rejected;
    await expectClosed();
  });

  it("cancels the decoding chain even without a body consumer", async () => {
    const res = await request((out) => {
      out.writeHead(200, { "content-encoding": "gzip, br" });
      out.flushHeaders();
    });
    res.cancel();
    await expectClosed();
    expect(res.body.destroyed).toBe(true);
  });
});
