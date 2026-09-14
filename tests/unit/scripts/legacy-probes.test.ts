/**
 * Legacy provider-probe regressions (issue #136).
 *
 * Importing a probe, passing --help, or invoking it without --live performs
 * no credential access or live inference. Live paths use explicit request
 * deadlines and response-byte limits, parse SSE with the canonical reader,
 * and redact failures. All live paths run against deterministic fake
 * transports; no provider quota or host credentials are touched.
 */
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheIdentityFor, cacheSessionHeaders, resolveAuth } from "../../../agent-core/auth.ts";

vi.mock("../../../agent-core/auth.ts", () => ({
  authPath: vi.fn(() => "/tmp/probe-test-auth.json"),
  cacheIdentityFor: vi.fn(() => null),
  cacheSessionHeaders: vi.fn(() => ({})),
  resolveAuth: vi.fn(),
}));

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const USAGE_SSE =
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}}\n\n' +
  "data: [DONE]\n\n";
const okSse = (bytes: string = USAGE_SSE, status = 200): Response =>
  new Response(bytes, { status, headers: { "content-type": "text/event-stream" } });

let breakpointProbe!: typeof import("../../../scripts/codex-breakpoint-probe.ts");
let opencodeProbe!: typeof import("../../../scripts/opencode-cache-probe.ts");
let xaiProbe!: typeof import("../../../scripts/xai-cache-probe.ts");

function mockAuth() {
  return {
    resolveAuth: resolveAuth as Mock,
    cacheIdentityFor: cacheIdentityFor as Mock,
    cacheSessionHeaders: cacheSessionHeaders as Mock,
  };
}

function authed() {
  mockAuth().resolveAuth.mockResolvedValue({ ok: true, baseUrl: "https://probe.test", headers: {} });
}

let logged: () => string;

beforeAll(async () => {
  // Arm throwing stubs BEFORE the first import: module top levels must not
  // touch credentials or the network.
  const auth = mockAuth();
  auth.resolveAuth.mockRejectedValue(new Error("auth must not be touched on import"));
  const fetchSpy = vi.fn(() => {
    throw new Error("fetch must not be touched on import");
  });
  vi.stubGlobal("fetch", fetchSpy);
  [breakpointProbe, opencodeProbe, xaiProbe] = await Promise.all([
    import("../../../scripts/codex-breakpoint-probe.ts"),
    import("../../../scripts/opencode-cache-probe.ts"),
    import("../../../scripts/xai-cache-probe.ts"),
  ]);
  expect(auth.resolveAuth).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const auth = mockAuth();
  auth.resolveAuth.mockReset();
  auth.cacheIdentityFor.mockReset().mockReturnValue(null);
  auth.cacheSessionHeaders.mockReset().mockReturnValue({});
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  logged = () => logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
  // Tests that reach the network install their own fetch stub; anything else
  // must fail loudly instead of touching a provider.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("fetch used without a fake transport");
    }),
  );
  return () => {
    logSpy.mockRestore();
    (console.error as Mock).mockRestore();
  };
});

describe("legacy provider probes (#136)", () => {
  it("is import-safe: no credential or network access on import", () => {
    // Asserted in beforeAll by the armed throwing stubs; the modules are
    // already loaded here, so re-assert the stubs stayed quiet.
    expect(mockAuth().resolveAuth).not.toHaveBeenCalled();
  });

  it.each([
    ["breakpoint", () => breakpointProbe.runBreakpointProbe(["--help"])],
    ["opencode", () => opencodeProbe.runOpencodeProbe(["--help"])],
    ["xai", () => xaiProbe.runXaiProbe(["--help"])],
  ])("%s --help performs no credential or network access", async (_name, run) => {
    const code = await run();
    expect(code).toBe(0);
    expect(logged()).toMatch(/Usage:/);
    expect(mockAuth().resolveAuth).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it.each([
    ["breakpoint", () => breakpointProbe.runBreakpointProbe([])],
    ["opencode", () => opencodeProbe.runOpencodeProbe([])],
    ["xai", () => xaiProbe.runXaiProbe([])],
  ])("%s without --live is a dry run", async (_name, run) => {
    const code = await run();
    expect(code).toBe(0);
    expect(logged()).toMatch(/"live":false/);
    expect(mockAuth().resolveAuth).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("reports unavailable credentials without sending requests", async () => {
    mockAuth().resolveAuth.mockResolvedValue({ ok: false, error: "no credential" });
    const code = await opencodeProbe.runOpencodeProbe(["--live"]);
    expect(code).toBe(2);
    expect(logged()).toContain("credentials unavailable");
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("runs the opencode acceptance flow against a fake transport", async () => {
    authed();
    const fetchSpy = vi.fn(async (_url: unknown, _init?: { signal?: AbortSignal; body?: unknown }) => okSse());
    vi.stubGlobal("fetch", fetchSpy);
    const code = await opencodeProbe.runOpencodeProbe(["--live"]);
    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // Every request carries an abort deadline and streams its response.
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as { signal?: AbortSignal; body?: string } | undefined;
      expect(init?.signal?.aborted).toBe(false);
      expect(String(init?.body)).toContain('"stream":true');
    }
    expect(logged()).toMatch(/ACCEPTED/);
    expect(logged()).toMatch(/usage=.*"input":100/);
    expect(logged()).toMatch(/verdict: compare input\/cache fields/);
  });

  it("runs the xai retention flow with a stubbed idle gap", async () => {
    authed();
    mockAuth().cacheIdentityFor.mockReturnValue({ key: "probe" });
    mockAuth().cacheSessionHeaders.mockReturnValue({ "x-test-session": "probe" });
    vi.stubEnv("XAI_PROBE_GAP_MS", "25");
    const fetchSpy = vi.fn(async () => okSse());
    vi.stubGlobal("fetch", fetchSpy);
    const started = Date.now();
    const code = await xaiProbe.runXaiProbe(["--live"]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(logged()).toMatch(/third {2}usage=/);
  });

  it("refuses an xai run with no derived session header before inferring", async () => {
    authed();
    const code = await xaiProbe.runXaiProbe(["--live"]);
    expect(code).toBe(1);
    expect(logged()).toContain("no session header derived");
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("runs the breakpoint boundary scan against a fake transport", async () => {
    authed();
    const fetchSpy = vi.fn(async () => okSse('data: {"ok":true}\n\n'));
    vi.stubGlobal("fetch", fetchSpy);
    const code = await breakpointProbe.runBreakpointProbe(["--live"]);
    expect(code).toBe(0);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);
    expect(logged()).toMatch(/verdict: /);
  });

  it("bounds a hung provider with the request deadline", async () => {
    authed();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
    );
    const started = Date.now();
    const code = await opencodeProbe.runOpencodeProbe(["--live"], { timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(code).toBe(1);
    expect(logged()).toContain("request-deadline");
  });

  it("rejects oversized responses without consuming them", async () => {
    authed();
    const big = `data: {"choices":[{"delta":{"content":"${"x".repeat(4096)}"}}]}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => okSse(big)));
    const code = await opencodeProbe.runOpencodeProbe(["--live"], { maxBytes: 1024 });
    expect(code).toBe(1);
    expect(logged()).toContain("response-size-limit");
  });

  it("redacts provider error bodies and stream failures", async () => {
    authed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sk-marker-secret-12345", { status: 500 })));
    const code = await opencodeProbe.runOpencodeProbe(["--live"]);
    expect(code).toBe(1);
    expect(logged()).toContain("HTTP 500");
    expect(logged()).not.toContain("sk-marker-secret-12345");

    vi.stubGlobal("fetch", vi.fn(async () => okSse("data: {oops\n\n")));
    const malformed = await opencodeProbe.runOpencodeProbe(["--live"]);
    expect(malformed).toBe(1);
    expect(logged()).toContain("invalid-response-stream");
  });

  it("adopts the shared opt-in and bounded-transport pattern", () => {
    for (const probe of ["codex-breakpoint-probe", "opencode-cache-probe", "xai-cache-probe"]) {
      const source = read(`scripts/${probe}.ts`);
      expect(source, `${probe} must gate on --live`).toContain('args.includes("--live")');
      expect(source, `${probe} must support --help`).toContain('"--help"');
      expect(source, `${probe} must guard its entry point`).toContain("import.meta.url === pathToFileURL(resolve(process.argv[1])).href");
      expect(source, `${probe} must bound requests`).toContain("AbortSignal.timeout(");
      expect(source, `${probe} must refuse foreign auth trees`).toContain("assertProbeAuthPath()");
      expect(source, `${probe} must redact failures`).toContain("ProbeFailure");
      expect(source, `${probe} must not resolve credentials at module top level`).not.toMatch(/^const auth = await resolveAuth/m);
    }
    for (const probe of ["opencode-cache-probe", "xai-cache-probe"]) {
      const source = read(`scripts/${probe}.ts`);
      expect(source, `${probe} must not duplicate SSE parsing`).not.toContain("function sseEvents(");
      expect(source, `${probe} must use the canonical SSE reader`).toContain("readSseJson(");
    }
  });
});
