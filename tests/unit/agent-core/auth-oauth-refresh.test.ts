import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
