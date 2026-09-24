import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modifyProvider, readAuth, refreshOauth, resetAuthCache } from "../../../agent-core/auth.ts";

describe("Agent Core OAuth refresh fail-closed (refs #351)", () => {
  let fixtureRoot: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "termina-auth-oauth-refresh-"));
    for (const name of ["TERMINA_AUTH_PATH", "TERMINA_CORE_TEST"]) {
      savedEnv.set(name, process.env[name]);
    }
    process.env.TERMINA_CORE_TEST = "1";
  });

  afterAll(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetAuthCache();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function useAuthFile(name: string) {
    process.env.TERMINA_AUTH_PATH = join(fixtureRoot, name, "auth.json");
    resetAuthCache();
  }

  function storedProvider(providerId: string) {
    const got = readAuth();
    return got.ok ? (got.data as Record<string, unknown>)[providerId] : undefined;
  }

  for (const external of [false, true]) {
    for (const replacement of [null, { type: "api_key", key: "new-key" }, {
      type: "oauth", access: "new-account", refresh: "new-refresh", expires: 123,
    }]) {
      it(`does not overwrite ${external ? "external" : "local"} credential changes: ${replacement?.type ?? "logout"}`, async () => {
        useAuthFile(`superseded-${external}-${replacement?.type ?? "logout"}`);
        modifyProvider("anthropic", () => ({
          type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0,
        }));
        if (external) utimesSync(process.env.TERMINA_AUTH_PATH!, 1, 1);
        const previousFetch = globalThis.fetch;
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        let started!: () => void;
        const requested = new Promise<void>((resolve) => { started = resolve; });
        globalThis.fetch = async () => {
          started();
          await pending;
          return new Response(JSON.stringify({
            access_token: "refreshed-access", refresh_token: "rotated-refresh", expires_in: 3600,
          }));
        };
        const flight = refreshOauth("anthropic");
        try {
          await requested;
          if (external) {
            // Simulate another process publishing while this process has a cached read.
            const path = process.env.TERMINA_AUTH_PATH!;
            const stat = statSync(path);
            writeFileSync(path, JSON.stringify(replacement === null ? {} : { anthropic: replacement }));
            utimesSync(path, stat.atime, stat.mtime);
          } else {
            modifyProvider("anthropic", () => replacement);
          }
          const before = readFileSync(process.env.TERMINA_AUTH_PATH!, "utf8");
          release();
          expect(await flight).toEqual({
            ok: false, error: "auth refresh persist failed: auth refresh superseded by a credential change",
          });
          expect(storedProvider("anthropic")).toEqual(replacement ?? undefined);
          expect(readFileSync(process.env.TERMINA_AUTH_PATH!, "utf8")).toBe(before);
        } finally {
          release();
          await flight;
          globalThis.fetch = previousFetch;
        }
      });
    }
  }

  it("allows unrelated provider changes while preserving both credentials", async () => {
    useAuthFile("unrelated-provider-change");
    modifyProvider("anthropic", () => ({
      type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0,
      metadata: { label: "keep" },
    }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      modifyProvider("openai", () => ({ type: "api_key", key: "other-provider-key" }));
      return new Response(JSON.stringify({
        access_token: "refreshed-access", refresh_token: "rotated-refresh", expires_in: 3600,
      }));
    };
    try {
      expect(await refreshOauth("anthropic")).toEqual({ ok: true });
      expect(storedProvider("anthropic")).toMatchObject({
        access: "refreshed-access", refresh: "rotated-refresh", metadata: { label: "keep" },
      });
      expect(storedProvider("openai")).toEqual({ type: "api_key", key: "other-provider-key" });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  for (const providerId of ["google", "opencode-zen", "opencode-go"] as const) {
    it(`fails closed for stored oauth on ${providerId} with no refresh arm`, async () => {
      useAuthFile(`oauth-${providerId}`);
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error(`unexpected fetch for ${providerId}`);
      };
      try {
        modifyProvider(providerId, () => ({
          type: "oauth",
          access: "expired-access",
          refresh: "refresh-stale",
          expires: Date.now() - 1,
        }));
        expect(await refreshOauth(providerId)).toEqual({
          ok: false,
          error: "auth expired — run /login",
        });
        expect(storedProvider(providerId)).toEqual(expect.objectContaining({
          type: "oauth",
          access: "expired-access",
          refresh: "refresh-stale",
        }));
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  }
});
