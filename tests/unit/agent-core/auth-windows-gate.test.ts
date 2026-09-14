import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Refs #223: stored auth needs POSIX file semantics. On Windows the write
// path must fail fast with one explicit error — before any browser flow —
// while reads keep working.
describe("stored auth requires POSIX", () => {
  let root: string;
  let authFile: string;
  let store: typeof import("../../../agent-core/auth/store.ts");
  let login: typeof import("../../../agent-core/auth/login.ts");
  const realPlatform = process.platform;

  function asWindows<T>(fn: () => T): T {
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
    }
  }

  async function asWindowsAsync<T>(fn: () => Promise<T>): Promise<T> {
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      return await fn();
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
    }
  }

  beforeAll(async () => {
    process.env.TERMINA_CORE_TEST = "1";
    root = mkdtempSync(join(tmpdir(), "termina-auth-win32-"));
    authFile = join(root, "auth.json");
    process.env.TERMINA_AUTH_PATH = authFile;
    store = await import("../../../agent-core/auth/store.ts");
    login = await import("../../../agent-core/auth/login.ts");
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
    delete process.env.TERMINA_AUTH_PATH;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.TERMINA_AUTH_PATH = authFile;
    store.resetAuthCache();
    writeFileSync(authFile, "{}\n", { mode: 0o600 });
    store.resetAuthCache();
  });

  it("refuses stored writes with the POSIX error", () => {
    asWindows(() => {
      expect(() => store.modifyProvider("openai", () => ({ type: "api_key", key: "k" }))).toThrow(
        /stored auth requires POSIX/,
      );
      const logout = login.runLogout("openai");
      expect(logout.ok).toBe(false);
      expect(logout.ok === false && logout.error).toMatch(/stored auth requires POSIX/);
    });
  });

  it("fails login before any browser or input flow", async () => {
    await asWindowsAsync(async () => {
      let opened = 0;
      let prompted = 0;
      const result = await login.runLogin("anthropic", "browser", {
        write: () => {},
        openUrl: () => { opened += 1; },
        waitForCode: async () => {
          prompted += 1;
          return "code";
        },
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/stored auth requires POSIX/);
      expect(opened).toBe(0);
      expect(prompted).toBe(0);
    });
  });

  it("keeps reads working", () => {
    writeFileSync(authFile, JSON.stringify({ openai: { type: "api_key", key: "k" } }), { mode: 0o600 });
    store.resetAuthCache();
    asWindows(() => {
      const got = store.readAuth();
      expect(got.ok).toBe(true);
    });
  });
});
