/**
 * Policy-bound HTTP transport for the fetch tool and MCP HTTP (#158, #159).
 *
 * Single-hop http(s) requests over node:http(s) with the validated dial-path
 * lookup, a caller-owned abort (one operation deadline covers DNS, connect,
 * TLS, and body), and content-decoding. Redirect policy stays with the
 * callers: the fetch tool follows, MCP rejects. TLS uses node:https
 * defaults; verification is never weakened.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { createValidatedLookup, type CallbackDnsLookup } from "./url.ts";

/** Case-insensitive response-header view over an IncomingMessage. */
class PolicyHeaders {
  private readonly raw: Record<string, string | string[] | undefined>;

  constructor(headers: Record<string, string | string[] | undefined>) {
    this.raw = headers;
  }

  get(name: string): string | null {
    const value = this.raw[name.toLowerCase()];
    if (value === undefined) return null;
    return Array.isArray(value) ? value.join(", ") : value;
  }
}

interface PolicyRequestInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Test-only dial resolver; production always uses the shared validator. */
  dns?: CallbackDnsLookup;
}

export interface PolicyHttpResponse {
  status: number;
  headers: PolicyHeaders;
  /** Decoded body stream; the caller drains or cancels it. */
  body: Readable;
  cancel: () => void;
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason as Error | undefined;
  if (reason instanceof Error && (reason.name === "AbortError" || reason.name === "TimeoutError")) return reason;
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

const DECODERS: Record<string, () => Transform> = {
  gzip: createGunzip,
  "x-gzip": createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
};

/**
 * Pipe content-decoding over the wire stream. Unknown encodings pass
 * through untouched, matching fetch; stacked encodings decode innermost
 * last, as sent.
 */
function decodeHttpBody(res: IncomingMessage, headers: PolicyHeaders): Readable {
  const tokens = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0 && token !== "identity");
  let stream: Readable = res;
  for (const token of tokens.reverse()) {
    const make = DECODERS[token];
    if (!make) continue;
    stream = stream.pipe(make());
  }
  return stream;
}

export function policyRequest(input: PolicyRequestInput): Promise<PolicyHttpResponse> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return Promise.reject(new Error("error: invalid URL"));
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return Promise.reject(new Error(`error: URL scheme not allowed: ${parsed.protocol}`));
  }
  if (input.signal?.aborted) return Promise.reject(abortError(input.signal));
  const lookup = createValidatedLookup(input.dns);
  const impl = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<PolicyHttpResponse>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    // Track the socket so cancel releases the connection even after the
    // response completed into the keep-alive pool (destroying req/res/body
    // alone leaves a pooled socket open until its idle timeout).
    let sock: { destroy: () => void } | null = null;
    const req = impl(
      input.url,
      {
        method: input.method,
        headers: { ...input.headers, "accept-encoding": "gzip, deflate, br" },
        signal: input.signal,
        lookup,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (!status) {
          res.destroy();
          fail(input.signal?.aborted ? abortError(input.signal) : new Error("error: HTTP response had no status"));
          return;
        }
        const headers = new PolicyHeaders(res.headers as Record<string, string | string[] | undefined>);
        let body: Readable;
        try {
          body = decodeHttpBody(res, headers);
        } catch (err) {
          res.destroy();
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        settled = true;
        resolve({
          status,
          headers,
          body,
          cancel: () => {
            try {
              sock?.destroy();
            } catch {
              /* best effort */
            }
            try {
              body.destroy();
            } catch {
              /* best effort */
            }
            try {
              res.destroy();
            } catch {
              /* best effort */
            }
            try {
              req.destroy();
            } catch {
              /* best effort */
            }
          },
        });
      },
    );
    req.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    req.on("socket", (s) => {
      sock = s;
    });
    if (input.body !== undefined && input.body.length > 0) req.write(input.body);
    req.end();
  });
}
