import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Refs #208: a corrupt auth.json must not brick /login and /logout.
describe("auth corrupt-file recovery", () => {
  let root: string;
  let authFile: string;
  let store: typeof import("../../../agent-core/auth/store.ts");
  let login: typeof import("../../../agent-core/auth/login.ts");

  beforeAll(async () => {
    process.env.TERMINA_CORE_TEST = "1";
    root = mkdtempSync(join(tmpdir(), "termina-auth-corrupt-"));
    authFile = join(root, "auth.json");
    process.env.TERMINA_AUTH_PATH = authFile;
    store = await import("../../../agent-core/auth/store.ts");
    login = await import("../../../agent-core/auth/login.ts");
  });

  afterAll(() => {
    delete process.env.TERMINA_AUTH_PATH;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.TERMINA_AUTH_PATH = authFile;
    store.resetAuthCache();
  });

  function writeCorrupt(): Buffer {
    const garbage = Buffer.from('{"openai": {"type": "api_key", "key": "tru');
    writeFileSync(authFile, garbage, { mode: 0o600 });
    store.resetAuthCache();
    return garbage;
  }

  it("keeps refusing blind overwrites and preserves the bytes", () => {
    const before = writeCorrupt();
    expect(store.readAuth()).toEqual({ ok: false, reason: "corrupt" });
    expect(() => store.modifyProvider("openai", () => ({ type: "api_key", key: "new" }))).toThrow(
      /unreadable — refusing to write/,
    );
    expect(readFileSync(authFile)).toEqual(before);
  });

  it("repairs the store when the caller explicitly discards", () => {
    writeCorrupt();
    const result = store.modifyProvider("openai", () => ({ type: "api_key", key: "new" }), { discardCorrupt: true });
    expect(result).toEqual({ discardedCorrupt: true });
    const got = store.readAuth();
    expect(got.ok).toBe(true);
  });

  it("recovers via logout with a recovery summary", () => {
    writeCorrupt();
    const result = login.runLogout("openai");
    expect(result.ok).toBe(true);
    expect(result.ok && result.summary).toMatch(/discarded unreadable auth file/);
    expect(store.readAuth()).toEqual({ ok: true, data: {} });
  });

  it("recovers via confirmed key login and stores the key", async () => {
    writeCorrupt();
    const inputs = ["DISCARD", "sk-test-key"];
    const written: string[] = [];
    const waitOpts: Array<{ secret?: boolean } | undefined> = [];
    const result = await login.runLogin("openai", "key", {
      write: (text) => written.push(text),
      waitForCode: async (opts) => {
        waitOpts.push(opts);
        return inputs.shift() ?? "";
      },
    });
    expect(result.ok).toBe(true);
    expect(waitOpts).toEqual([undefined, { secret: true }]);
    expect(written.join("")).toContain(authFile);
    const got = store.readAuth();
    expect(got.ok && (got.data.openai as { key?: string }).key).toBe("sk-test-key");
  });

  it("aborts login on a non-confirming answer and preserves the bytes", async () => {
    const before = writeCorrupt();
    const result = await login.runLogin("openai", "key", {
      write: () => {},
      waitForCode: async () => "no",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/left untouched/);
    expect(readFileSync(authFile)).toEqual(before);
  });

  it("names the file and points at /logout when no input is available", async () => {
    writeCorrupt();
    const result = await login.runLogin("openai", "key", { write: () => {} });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(authFile);
    expect(result.ok === false && result.error).toMatch(/\/logout/);
  });

  it("does not prompt when the store is healthy", async () => {
    writeFileSync(authFile, "{}\n", { mode: 0o600 });
    store.resetAuthCache();
    let prompts = 0;
    const result = await login.runLogin("openai", "key", {
      write: () => {},
      waitForCode: async () => {
        prompts += 1;
        return "sk-test-key";
      },
    });
    expect(result.ok).toBe(true);
    expect(prompts).toBe(1);
  });
});
