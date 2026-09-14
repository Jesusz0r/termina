import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Refs #220: auth writes must fsync the parent directory after the rename so
// the directory entry survives a crash. No power-loss harness exists, so the
// test spies the syscalls instead.
const spy = vi.hoisted(() => ({
  openCalls: [] as Array<{ path: string; flags: unknown }>,
  fsyncCalls: 0,
  failDirSync: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((path: string, flags?: unknown, mode?: unknown) => {
      spy.openCalls.push({ path: String(path), flags });
      return (actual.openSync as (p: string, f?: unknown, m?: unknown) => number)(path, flags, mode);
    }) as typeof actual.openSync,
    fsyncSync: (fd: number): void => {
      spy.fsyncCalls += 1;
      if (spy.failDirSync && spy.fsyncCalls === 2) throw new Error("injected dir-sync failure");
      actual.fsyncSync(fd);
    },
  };
});

describe("auth parent-directory fsync", () => {
  let root: string;
  let authFile: string;
  let store: typeof import("../../../agent-core/auth/store.ts");

  beforeAll(async () => {
    process.env.TERMINA_CORE_TEST = "1";
    root = mkdtempSync(join(tmpdir(), "termina-auth-fsync-"));
    authFile = join(root, "auth.json");
    process.env.TERMINA_AUTH_PATH = authFile;
    store = await import("../../../agent-core/auth/store.ts");
  });

  afterAll(() => {
    delete process.env.TERMINA_AUTH_PATH;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.TERMINA_AUTH_PATH = authFile;
    store.resetAuthCache();
    spy.openCalls.length = 0;
    spy.fsyncCalls = 0;
    spy.failDirSync = false;
    writeFileSync(authFile, "{}\n", { mode: 0o600 });
    store.resetAuthCache();
    // Ignore setup syscalls; the write under test starts here.
    spy.openCalls.length = 0;
    spy.fsyncCalls = 0;
  });

  it("fsyncs the temp file and the parent directory on write", () => {
    store.modifyProvider("openai", () => ({ type: "api_key", key: "k" }));
    expect(spy.fsyncCalls).toBeGreaterThanOrEqual(2);
    // syncParentDir opens the containing dir read-only; anchor opens use
    // numeric O_DIRECTORY flags, so the "r" open identifies the dir sync.
    expect(spy.openCalls).toContainEqual({ path: dirname(authFile), flags: "r" });
    expect(store.readAuth()).toEqual({ ok: true, data: { openai: { type: "api_key", key: "k" } } });
  });

  it("surfaces a dir-sync failure without destroying the published write", () => {
    spy.failDirSync = true;
    expect(() => store.modifyProvider("openai", () => ({ type: "api_key", key: "k" }))).toThrow(
      /injected dir-sync failure/,
    );
    spy.failDirSync = false;
    store.resetAuthCache();
    expect(store.readAuth()).toEqual({ ok: true, data: { openai: { type: "api_key", key: "k" } } });
  });
});
