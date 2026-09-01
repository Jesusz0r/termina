import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

describe("Agent Core Auth Empty Lock Regression", () => {
  let root: string;
  let authPath: string;
  let lockPath: string;
  let authModule: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "termina-auth-empty-lock-"));
    authPath = join(root, "auth.json");
    lockPath = `${authPath}.lock`;
    authModule = pathToFileURL(resolve("agent-core/auth.ts")).href;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function waitFor(checkFn: () => boolean, message: string) {
    const deadline = Date.now() + 15_000;
    while (!checkFn()) {
      if (Date.now() >= deadline) throw new Error(message);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }

  function startWriter(options: Record<string, string>) {
    const code = `
      const { modifyProvider } = await import(${JSON.stringify(authModule)});
      try {
        modifyProvider(process.env.PROVIDER, () => ({ type: "api_key", key: process.env.KEY }));
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", code], {
      cwd: resolve("."),
      env: { ...process.env, TERMINA_CORE_TEST: "1", TERMINA_AUTH_PATH: authPath, ...options },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
  }

  it("ensures concurrent candidate publication never exposes or recovers an empty canonical lock", async () => {
    writeFileSync(authPath, "{}\n", { mode: 0o600 });
    const firstMarker = join(root, "first-before-publish");
    const firstResume = join(root, "first-resume");
    const secondMarker = join(root, "second-after-temp");
    const secondResume = join(root, "second-resume");

    const first = startWriter({
      PROVIDER: "anthropic",
      KEY: "first",
      TERMINA_AUTH_LOCK_PAUSE: "before-publish",
      TERMINA_AUTH_LOCK_PAUSED: firstMarker,
      TERMINA_AUTH_LOCK_RESUME: firstResume,
    });
    waitFor(() => existsSync(firstMarker), "first writer did not pause before generation publish");
    expect(existsSync(lockPath)).toBe(false);

    const second = startWriter({
      PROVIDER: "openai",
      KEY: "second",
      TERMINA_AUTH_WRITE_PAUSE: "after-temp",
      TERMINA_AUTH_WRITE_PAUSED: secondMarker,
      TERMINA_AUTH_WRITE_RESUME: secondResume,
    });
    waitFor(() => existsSync(secondMarker), "second writer did not hold the published generation");
    expect(readdirSync(lockPath).some((name) => name.startsWith(".record-"))).toBe(true);

    writeFileSync(firstResume, "resume\n", { mode: 0o600 });
    const [firstCode, firstSignal] = await once(first.child, "close");
    expect(firstCode).toBe(0);
    expect(firstSignal).toBeNull();
    expect(JSON.parse(first.stdout)).toEqual({ ok: false, error: "auth file busy" });

    writeFileSync(secondResume, "resume\n", { mode: 0o600 });
    const [secondCode, secondSignal] = await once(second.child, "close");
    expect(secondCode).toBe(0);
    expect(secondSignal).toBeNull();
    expect(JSON.parse(second.stdout)).toEqual({ ok: true });

    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    expect(auth.anthropic).toBeUndefined();
    expect(auth.openai.key).toBe("second");
    expect(existsSync(lockPath)).toBe(false);
  });
});
