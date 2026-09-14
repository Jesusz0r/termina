import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

/**
 * Harness regression for the navigation-isolation E2E spec (refs #146).
 *
 * Executes the actual checked-in spec callback (transpiled with the repo's
 * esbuild, fixture import stripped) against controlled page adapters — the
 * same technique that exposed the original catch-all. A spec that swallows
 * its own failed security assertion resolves here and fails this test.
 */

type SpecCallback = (ctx: { page: FakePage }) => Promise<void>;

interface FakePage {
  goto(url: string, opts?: unknown): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  locator(sel: string): object;
  isClosed(): boolean;
  url(): string;
}

function strictEqual(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`);
  }
}

/** The spec's test callback by name, loaded from the checked-in spec file. */
function loadNavigationCallback(): SpecCallback {
  const file = new URL("../../../tests/e2e/ipc-navigation.spec.ts", import.meta.url);
  const src = readFileSync(file, "utf8");
  const stripped = src
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n");
  const { code } = transformSync(stripped, { loader: "ts" });
  const collected = new Map<string, SpecCallback>();
  const testFn = Object.assign(
    (name: string, fn: SpecCallback): void => {
      collected.set(name, fn);
    },
    { describe: (_name: string, fn: () => void): void => fn() },
  );
  const fakeExpect = (actual: unknown): {
    toBe(expected: unknown): void;
    toBeHidden(opts?: unknown): Promise<void>;
    toContain(expected: string): void;
    not: { toContain(expected: string): void };
  } => ({
    toBe: (expected: unknown): void => strictEqual(actual, expected),
    toBeHidden: async (_opts?: unknown): Promise<void> => {},
    toContain: (expected: string): void => {
      if (typeof actual !== "string" || !actual.includes(expected)) {
        throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
      }
    },
    not: {
      toContain: (expected: string): void => {
        if (typeof actual === "string" && actual.includes(expected)) {
          throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(expected)}`);
        }
      },
    },
  });
  new Function("test", "expect", code)(testFn, fakeExpect);
  const callback = collected.get("foreign page navigation cannot invoke privileged IPC");
  if (!callback) throw new Error("navigation spec callback not found");
  return callback;
}

function fakePage(adapter: { goto(): Promise<void>; foreign(): { loaded: boolean; bridge: string } }): FakePage {
  return {
    goto: async (_url: string) => adapter.goto(),
    evaluate: async <T>(_fn: () => T): Promise<T> => adapter.foreign() as unknown as T,
    locator: (_sel: string) => ({}),
    isClosed: () => false,
    url: () => "file:///app/dist-renderer/index.html",
  };
}

describe("navigation spec harness (refs #146)", () => {
  it("fails when navigation succeeds and a privileged bridge remains", async () => {
    const callback = loadNavigationCallback();
    const exposedPage = fakePage({
      goto: async () => {},
      foreign: () => ({ loaded: true, bridge: "object" }),
    });
    await expect(callback({ page: exposedPage })).rejects.toThrow();
  });

  it("passes when navigation succeeds and the foreign page has no bridge", async () => {
    const callback = loadNavigationCallback();
    const isolatedPage = fakePage({
      goto: async () => {},
      foreign: () => ({ loaded: true, bridge: "undefined" }),
    });
    await expect(callback({ page: isolatedPage })).resolves.toBeUndefined();
  });

  it("passes when navigation is blocked and the app window is intact", async () => {
    const callback = loadNavigationCallback();
    const blockedPage = fakePage({
      goto: async () => {
        throw new Error("page.goto: net::ERR_ABORTED at data:text/html");
      },
      foreign: () => ({ loaded: false, bridge: "undefined" }),
    });
    await expect(callback({ page: blockedPage })).resolves.toBeUndefined();
  });

  it("fails when navigation fails in an unexpected way", async () => {
    const callback = loadNavigationCallback();
    const crashedPage = fakePage({
      goto: async () => {
        throw new Error("page.goto: Timeout 3000ms exceeded");
      },
      foreign: () => ({ loaded: false, bridge: "undefined" }),
    });
    await expect(callback({ page: crashedPage })).rejects.toThrow();
  });
});
