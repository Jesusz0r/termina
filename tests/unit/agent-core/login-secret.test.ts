import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type LoginIo = Parameters<typeof import("../../../agent-core/auth/login.ts").runLogin>[2];
type LoginInputOpts = Parameters<NonNullable<LoginIo["waitForCode"]>>[0];

describe("login secret contract (refs #212)", () => {
  let root: string;
  let login: typeof import("../../../agent-core/auth/login.ts");

  beforeAll(async () => {
    process.env.TERMINA_CORE_TEST = "1";
    root = mkdtempSync(join(tmpdir(), "termina-login-secret-"));
    process.env.TERMINA_AUTH_PATH = join(root, "auth.json");
    login = await import("../../../agent-core/auth/login.ts");
  });

  afterAll(() => {
    delete process.env.TERMINA_AUTH_PATH;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.TERMINA_AUTH_PATH = join(root, "auth.json");
  });

  function captureWait(answer = ""): { opts: Array<LoginInputOpts | undefined>; io: { write: () => void; waitForCode: (opts?: LoginInputOpts) => Promise<string> } } {
    const opts: Array<LoginInputOpts | undefined> = [];
    return {
      opts,
      io: {
        write: () => {},
        waitForCode: async (next) => {
          opts.push(next);
          return answer;
        },
      },
    };
  }

  it("asks waitForCode for a secret on API key login", async () => {
    const { opts, io } = captureWait();
    const result = await login.runLogin("openai", "key", io);
    expect(result.ok).toBe(false);
    expect(opts).toEqual([{ secret: true }]);
  });

  it("asks waitForCode for a secret on Copilot token login", async () => {
    const { opts, io } = captureWait();
    const result = await login.runLogin("github-copilot", "key", io);
    expect(result.ok).toBe(false);
    expect(opts).toEqual([{ secret: true }]);
  });

  it("asks waitForCode for a secret on OAuth code paste", async () => {
    const { opts, io } = captureWait();
    const result = await login.runLogin("anthropic", "code", io);
    expect(result.ok).toBe(false);
    expect(opts).toEqual([{ secret: true }]);
  });
});
