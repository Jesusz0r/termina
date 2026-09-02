import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

describe("Agent Core Auth Atomic Writes & Security", () => {
  let root: string;
  let authPath: string;
  let authModule: string;
  let modifyProvider: any;

  beforeAll(async () => {
    process.env.TERMINA_CORE_TEST = "1";
    root = mkdtempSync(join(tmpdir(), "termina-auth-write-"));
    authPath = join(root, "auth.json");
    authModule = pathToFileURL(resolve("agent-core/auth.ts")).href;
    process.env.TERMINA_AUTH_PATH = authPath;
    const mod = await import(authModule);
    modifyProvider = mod.modifyProvider;
  });

  afterAll(() => {
    delete process.env.TERMINA_AUTH_PATH;
    rmSync(root, { recursive: true, force: true });
  });

  function resetAuth() {
    for (const name of readdirSync(root)) {
      if (name !== "auth.json" && name !== "outside.txt") {
        rmSync(join(root, name), { recursive: true, force: true });
      }
    }
    rmSync(authPath, { force: true });
    rmSync(`${authPath}.lock`, { recursive: true, force: true });
    writeFileSync(authPath, "{}\n", { mode: 0o600 });
  }

  function waitFor(checkFn: () => boolean, message: string) {
    const deadline = Date.now() + 5_000;
    while (!checkFn()) {
      if (Date.now() >= deadline) throw new Error(message);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }

  beforeEach(() => {
    process.env.TERMINA_AUTH_PATH = authPath;
    resetAuth();
  });

  it("does not follow or delete predictable temp symlinks", () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "untouched\n", { mode: 0o600 });
    const legacyTemp = `${authPath}.${process.pid}.tmp`;
    symlinkSync(outside, legacyTemp);
    modifyProvider("anthropic", () => ({ type: "api_key", key: "must-not-leak" }));

    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
    expect(lstatSync(legacyTemp).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(authPath, "utf8")).anthropic.key).toBe("must-not-leak");
  });

  it("replaces destination auth symlink without touching its target", () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "{}\n", { mode: 0o600 });
    rmSync(authPath, { force: true });
    symlinkSync(outside, authPath);
    modifyProvider("anthropic", () => ({ type: "api_key", key: "published" }));

    expect(readFileSync(outside, "utf8")).toBe("{}\n");
    expect(lstatSync(authPath).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(authPath, "utf8")).anthropic.key).toBe("published");
  });

  it("rejects ancestor/parent symlink before credential write", () => {
    const outsideDir = join(root, "outside-dir");
    const alias = join(root, "alias");
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, alias, "dir");
    const aliasedAuth = join(alias, "auth.json");
    process.env.TERMINA_AUTH_PATH = aliasedAuth;

    expect(() => modifyProvider("anthropic", () => ({ type: "api_key", key: "must-not-write" }))).toThrow(
      /auth|parent|directory|symlink|path/i,
    );
    expect(existsSync(join(outsideDir, "auth.json"))).toBe(false);
  });

  it("rejects parent ABA before temp creation using initial binding", () => {
    const parent = join(root, "pre-write-parent");
    const movedParent = join(root, "pre-write-parent-old");
    mkdirSync(parent);
    const path = join(parent, "auth.json");
    writeFileSync(path, "{}\n", { mode: 0o600 });
    process.env.TERMINA_AUTH_PATH = path;

    expect(() =>
      modifyProvider("anthropic", () => {
        renameSync(parent, movedParent);
        mkdirSync(parent);
        return { type: "api_key", key: "must-not-escape" };
      }),
    ).toThrow(/auth path parent changed/i);

    expect(existsSync(join(parent, "auth.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(movedParent, "auth.json"), "utf8")).anthropic).toBeUndefined();
  });

  it("rejects parent ABA race after temp creation and truncates old-parent bytes", async () => {
    const parent = join(root, "parent");
    const oldParent = join(root, "parent-old");
    const marker = join(root, "write-paused");
    const resume = join(root, "write-resume");
    mkdirSync(parent);

    const childCode = `
      const { modifyProvider } = await import(${JSON.stringify(authModule)});
      try {
        modifyProvider("anthropic", () => ({ type: "api_key", key: "must-not-escape" }));
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", childCode], {
      env: {
        ...process.env,
        TERMINA_CORE_TEST: "1",
        TERMINA_AUTH_PATH: join(parent, "auth.json"),
        TERMINA_AUTH_WRITE_PAUSE: "after-temp",
        TERMINA_AUTH_WRITE_PAUSED: marker,
        TERMINA_AUTH_WRITE_RESUME: resume,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    waitFor(() => existsSync(marker), "auth writer did not reach its parent-identity pause");
    renameSync(parent, oldParent);
    mkdirSync(parent);
    writeFileSync(resume, "resume\n", { mode: 0o600 });

    const [code] = await once(child, "close");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.ok).toBe(false);
    expect(existsSync(join(parent, "auth.json"))).toBe(false);

    const oldTemps = readdirSync(oldParent).filter((name) => name.startsWith(".auth.json.tmp-"));
    // On Linux, /proc/self/fd allows cleanup through the parent descriptor even after rename.
    // On macOS, fdescfs cannot traverse descriptors, leaving the truncated 0-byte residue in place.
    if (process.platform === "linux") {
      expect(oldTemps.length).toBe(0);
    } else {
      expect(oldTemps.length).toBe(1);
      expect(readFileSync(join(oldParent, oldTemps[0]), "utf8")).toBe("");
    }
  });

  it("handles concurrent writers safely without transaction theft or corruption", async () => {
    const childCode = `
      const { modifyProvider } = await import(${JSON.stringify(authModule)});
      try {
        modifyProvider(process.env.PROVIDER, () => ({ type: "api_key", key: process.env.KEY }));
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const marker = join(root, "concurrent-paused");
    const resume = join(root, "concurrent-resume");
    const first = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", childCode], {
      env: {
        ...process.env,
        TERMINA_CORE_TEST: "1",
        TERMINA_AUTH_PATH: authPath,
        PROVIDER: "anthropic",
        KEY: "concurrent-a",
        TERMINA_AUTH_WRITE_PAUSE: "after-temp",
        TERMINA_AUTH_WRITE_PAUSED: marker,
        TERMINA_AUTH_WRITE_RESUME: resume,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let firstStdout = "";
    first.stdout.on("data", (chunk) => { firstStdout += chunk; });
    waitFor(() => existsSync(marker), "first concurrent writer did not reach its temp pause");

    const second = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", childCode], {
      env: { ...process.env, TERMINA_CORE_TEST: "1", TERMINA_AUTH_PATH: authPath, PROVIDER: "openai", KEY: "concurrent-b" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let secondStdout = "";
    second.stdout.on("data", (chunk) => { secondStdout += chunk; });
    const [secondCode] = await once(second, "close");
    expect(secondCode).toBe(0);

    writeFileSync(resume, "resume\n", { mode: 0o600 });
    const [firstCode] = await once(first, "close");
    expect(firstCode).toBe(0);

    expect(JSON.parse(firstStdout)).toEqual({ ok: true });
    expect(JSON.parse(secondStdout)).toEqual({ ok: false, error: "auth file busy" });

    const concurrent = JSON.parse(readFileSync(authPath, "utf8"));
    expect(concurrent.anthropic.key).toBe("concurrent-a");
    expect(concurrent.openai).toBeUndefined();
  });

  it("detects temp hardlinks and truncates all linked credential bytes", async () => {
    const marker = join(root, "hardlink-paused");
    const resume = join(root, "hardlink-resume");
    const outside = join(root, "outside-hardlink");
    const childCode = `
      const { modifyProvider } = await import(${JSON.stringify(authModule)});
      try {
        modifyProvider("anthropic", () => ({ type: "api_key", key: "hardlink-secret" }));
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", childCode], {
      env: {
        ...process.env,
        TERMINA_CORE_TEST: "1",
        TERMINA_AUTH_PATH: authPath,
        TERMINA_AUTH_WRITE_PAUSE: "after-temp",
        TERMINA_AUTH_WRITE_PAUSED: marker,
        TERMINA_AUTH_WRITE_RESUME: resume,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    waitFor(() => existsSync(marker), "hardlink writer did not reach its temp pause");

    const temp = readdirSync(root).find((name) => name.startsWith(".auth.json.tmp-"));
    expect(temp).toBeTruthy();
    linkSync(join(root, temp!), outside);
    writeFileSync(resume, "resume\n", { mode: 0o600 });

    const [code] = await once(child, "close");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: false, error: "auth temp has unexpected hard links" });
    expect(readFileSync(outside, "utf8")).toBe("");
    expect(readFileSync(authPath, "utf8")).toBe("{}\n");
  });

  it("leaves only private owned temp if crash occurs before publish", () => {
    const probe = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", `
      const { modifyProvider } = await import(${JSON.stringify(authModule)});
      modifyProvider("anthropic", () => ({ type: "api_key", key: "crash-secret" }));
    `], {
      env: { ...process.env, TERMINA_CORE_TEST: "1", TERMINA_AUTH_PATH: authPath, TERMINA_AUTH_WRITE_CRASH: "after-fsync" },
      encoding: "utf8",
    });

    expect(probe.status).toBeNull();
    expect(probe.signal).toBe("SIGKILL");

    const leaked = readdirSync(root).filter((name) => name.startsWith(".auth.json.tmp-"));
    expect(leaked.length).toBe(1);
    expect(lstatSync(join(root, leaked[0])).mode & 0o777).toBe(0o600);
    expect(readFileSync(authPath, "utf8")).toBe("{}\n");
  });
});
