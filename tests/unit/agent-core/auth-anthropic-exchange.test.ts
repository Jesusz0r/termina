import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAuthCache } from "../../../agent-core/auth.ts";

describe("Anthropic authorization-code exchange", () => {
  let root: string;
  let login: typeof import("../../../agent-core/auth/login.ts");
  const saved = new Map<string, string | undefined>();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "termina-anthropic-exchange-"));
    for (const name of ["TERMINA_AUTH_PATH", "TERMINA_CORE_TEST", "TERMINA_TEST_TOKEN_URL"]) {
      saved.set(name, process.env[name]);
    }
    process.env.TERMINA_CORE_TEST = "1";
    process.env.TERMINA_AUTH_PATH = join(root, "auth.json");
    process.env.TERMINA_TEST_TOKEN_URL = "http://127.0.0.1:9/oauth/token";
    resetAuthCache();
    login = await import("../../../agent-core/auth/login.ts");
  });

  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetAuthCache();
    rmSync(root, { recursive: true, force: true });
  });

  it("sends the authorize state and surfaces a token-endpoint error", async () => {
    let authorize = "";
    const previous = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:9/oauth/token");
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "Invalid request format" },
      }), { status: 400, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await login.runLogin("anthropic", "code", {
        write: (text) => { authorize += text; },
        waitForCode: async () => "pasted-code",
      });
      const state = new URL((authorize.match(/authorize: (\S+)/) || [])[1] ?? "http://invalid").searchParams.get("state");
      expect(state).toBeTruthy();
      expect(bodies).toEqual([expect.objectContaining({
        grant_type: "authorization_code",
        code: "pasted-code",
        state,
        code_verifier: expect.any(String),
      })]);
      expect(result).toEqual({
        ok: false,
        error: "login failed: invalid_request_error: Invalid request format",
      });
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("stores tokens when the exchange includes state", async () => {
    let authorize = "";
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { state?: string };
      const state = new URL((authorize.match(/authorize: (\S+)/) || [])[1] ?? "http://invalid").searchParams.get("state");
      expect(String(input)).toBe("http://127.0.0.1:9/oauth/token");
      expect(body.state).toBe(state);
      return new Response(JSON.stringify({
        access_token: "sk-ant-oat-login",
        refresh_token: "refresh-1",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await login.runLogin("anthropic", "code", {
        write: (text) => { authorize += text; },
        waitForCode: async () => "pasted-code",
      });
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
