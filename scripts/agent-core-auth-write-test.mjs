/** Regression tests for atomic, no-follow credential writes. */
import assert from "node:assert/strict";
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
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.TERMINA_CORE_TEST = "1";
const root = mkdtempSync(join(tmpdir(), "termina-auth-write-"));
const authPath = join(root, "auth.json");
const authModule = pathToFileURL(resolve("agent-core/auth.ts")).href;

function resetAuth() {
  for (const name of readdirSync(root)) {
    if (name !== "auth.json" && name !== "outside.txt") rmSync(join(root, name), { recursive: true, force: true });
  }
  rmSync(authPath, { force: true });
  rmSync(`${authPath}.lock`, { recursive: true, force: true });
  writeFileSync(authPath, "{}\n", { mode: 0o600 });
}

function authFiles() {
  return readdirSync(root).filter((name) => name !== "auth.json" && name !== "outside.txt");
}

function waitFor(check, message) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

async function loadAuth() {
  process.env.TERMINA_AUTH_PATH = authPath;
  return import(authModule);
}

try {
  const { modifyProvider } = await loadAuth();

  {
    resetAuth();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "untouched\n", { mode: 0o600 });
    const legacyTemp = `${authPath}.${process.pid}.tmp`;
    symlinkSync(outside, legacyTemp);
    modifyProvider("anthropic", () => ({ type: "api_key", key: "must-not-leak" }));
    assert.equal(readFileSync(outside, "utf8"), "untouched\n", "legacy temp symlink target must remain untouched");
    assert.equal(lstatSync(legacyTemp).isSymbolicLink(), true, "unowned temp symlink must not be removed");
    assert.equal(JSON.parse(readFileSync(authPath, "utf8")).anthropic.key, "must-not-leak");
    console.log("PASS predictable temp symlink is not followed or deleted");
  }

  {
    resetAuth();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "{}\n", { mode: 0o600 });
    rmSync(authPath, { force: true });
    symlinkSync(outside, authPath);
    modifyProvider("anthropic", () => ({ type: "api_key", key: "published" }));
    assert.equal(readFileSync(outside, "utf8"), "{}\n", "destination symlink target must never be followed");
    assert.equal(lstatSync(authPath).isSymbolicLink(), false, "atomic publish must replace a destination symlink with a regular file");
    assert.equal(JSON.parse(readFileSync(authPath, "utf8")).anthropic.key, "published");
    console.log("PASS destination auth symlink is replaced without touching its target");
  }

  {
    resetAuth();
    const outsideDir = join(root, "outside-dir");
    const alias = join(root, "alias");
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, alias, "dir");
    const aliasedAuth = join(alias, "auth.json");
    process.env.TERMINA_AUTH_PATH = aliasedAuth;
    assert.throws(
      () => modifyProvider("anthropic", () => ({ type: "api_key", key: "must-not-write" })),
      /auth|parent|directory|symlink|path/i,
      "an ancestor/parent swap or symlink must fail closed",
    );
    assert.equal(existsSync(join(outsideDir, "auth.json")), false, "aliased parent must not receive credentials");
    console.log("PASS ancestor/parent symlink is rejected before credential write");
  }

  {
    resetAuth();
    const parent = join(root, "pre-write-parent");
    const movedParent = join(root, "pre-write-parent-old");
    mkdirSync(parent);
    const path = join(parent, "auth.json");
    writeFileSync(path, "{}\n", { mode: 0o600 });
    process.env.TERMINA_AUTH_PATH = path;
    assert.throws(
      () => modifyProvider("anthropic", () => {
        renameSync(parent, movedParent);
        mkdirSync(parent);
        return { type: "api_key", key: "must-not-escape" };
      }),
      /auth path parent changed/i,
      "a parent replacement between read and publish must fail closed",
    );
    assert.equal(existsSync(join(parent, "auth.json")), false, "replacement parent must remain credential-free");
    assert.equal(JSON.parse(readFileSync(join(movedParent, "auth.json"), "utf8")).anthropic, undefined);
    console.log("PASS parent ABA before temp creation is rejected using the initial binding");
  }

  {
    resetAuth();
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
    assert.equal(code, 0, `parent ABA writer exited ${code}: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false, "parent replacement must fail closed");
    assert.equal(existsSync(join(parent, "auth.json")), false, "replacement parent must not receive credentials");
    const oldTemps = readdirSync(oldParent).filter((name) => name.startsWith(".auth.json.tmp-"));
    assert.equal(oldTemps.length, 1, "the opened temp must remain uniquely identifiable after the parent ABA mismatch");
    assert.equal(readFileSync(join(oldParent, oldTemps[0]), "utf8"), "", "the opened temp must be truncated before cleanup becomes unreachable");
    console.log("PASS parent ABA is rejected and old-parent credential bytes are truncated");
  }

  {
    resetAuth();
    const parent = join(root, "post-open-parent");
    const oldParent = join(root, "post-open-parent-old");
    const marker = join(root, "post-open-paused");
    const resume = join(root, "post-open-resume");
    mkdirSync(parent);
    const childCode = `
      const { modifyProvider } = await import(${JSON.stringify(authModule)});
      try {
        modifyProvider("anthropic", () => ({ type: "api_key", key: "must-not-escape-open" }));
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
        TERMINA_AUTH_WRITE_PAUSE: "after-open",
        TERMINA_AUTH_WRITE_PAUSED: marker,
        TERMINA_AUTH_WRITE_RESUME: resume,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    waitFor(() => existsSync(marker), "post-open writer did not reach its descriptor pause");
    renameSync(parent, oldParent);
    mkdirSync(parent);
    writeFileSync(resume, "resume\n", { mode: 0o600 });
    const [code] = await once(child, "close");
    assert.equal(code, 0, `post-open parent ABA writer exited ${code}: ${stderr}`);
    assert.deepEqual(JSON.parse(stdout), { ok: false, error: "auth path parent changed while writing" });
    assert.equal(existsSync(join(parent, "auth.json")), false, "replacement parent must remain credential-free");
    const oldTemps = readdirSync(oldParent).filter((name) => name.startsWith(".auth.json.tmp-"));
    assert.equal(oldTemps.length, 1);
    assert.equal(readFileSync(join(oldParent, oldTemps[0]), "utf8"), "", "post-open mismatch must not leave credential bytes");
    console.log("PASS post-open parent ABA is rejected before credential bytes are written");
  }

  {
    resetAuth();
    process.env.TERMINA_AUTH_PATH = authPath;
    const stale = `${authPath}.${process.pid}.tmp`;
    writeFileSync(stale, "crash residue\n", { mode: 0o600 });
    modifyProvider("google", () => ({ type: "api_key", key: "fresh" }));
    assert.equal(readFileSync(stale, "utf8"), "crash residue\n", "a later writer must not claim another process's temp residue");
    assert.equal(lstatSync(stale).mode & 0o777, 0o600, "crash residue must remain private");
    console.log("PASS crash residue remains exact-owned and private");
  }

  {
    process.env.TERMINA_AUTH_PATH = authPath;
    const content = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(content.google.key, "fresh");
    const tempNames = authFiles().filter((name) => name.includes(".tmp"));
    assert.equal(tempNames.length, 1, "only the pre-existing residue may remain after a successful write");
    assert.equal(readFileSync(join(root, tempNames[0]), "utf8"), "crash residue\n");
    console.log("PASS successful write leaves no secret in unrelated temp files");
  }

  {
    resetAuth();
    process.env.TERMINA_AUTH_PATH = authPath;
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
    let firstStderr = "";
    first.stdout.on("data", (chunk) => { firstStdout += chunk; });
    first.stderr.on("data", (chunk) => { firstStderr += chunk; });
    waitFor(() => existsSync(marker), "first concurrent writer did not reach its temp pause");
    const second = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", childCode], {
      env: { ...process.env, TERMINA_CORE_TEST: "1", TERMINA_AUTH_PATH: authPath, PROVIDER: "openai", KEY: "concurrent-b" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let secondStdout = "";
    let secondStderr = "";
    second.stdout.on("data", (chunk) => { secondStdout += chunk; });
    second.stderr.on("data", (chunk) => { secondStderr += chunk; });
    const [secondCode, secondSignal] = await once(second, "close");
    assert.equal(secondCode, 0, `concurrent contender exited ${secondCode}: ${secondStderr}`);
    assert.equal(secondSignal, null);
    writeFileSync(resume, "resume\n", { mode: 0o600 });
    const [firstCode, firstSignal] = await once(first, "close");
    assert.equal(firstCode, 0, `first concurrent writer exited ${firstCode}: ${firstStderr}`);
    assert.equal(firstSignal, null);
    assert.deepEqual(JSON.parse(firstStdout), { ok: true });
    assert.deepEqual(JSON.parse(secondStdout), { ok: false, error: "auth file busy" });
    const concurrent = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(concurrent.anthropic.key, "concurrent-a");
    assert.equal(concurrent.openai, undefined);
    console.log("PASS concurrent writers cannot corrupt or steal the held auth transaction");
  }

  {
    resetAuth();
    process.env.TERMINA_AUTH_PATH = authPath;
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
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    waitFor(() => existsSync(marker), "hardlink writer did not reach its temp pause");
    const temp = readdirSync(root).find((name) => name.startsWith(".auth.json.tmp-"));
    assert.ok(temp, "hardlink writer did not expose its randomized temp");
    linkSync(join(root, temp), outside);
    writeFileSync(resume, "resume\n", { mode: 0o600 });
    const [code] = await once(child, "close");
    assert.equal(code, 0, `hardlink writer exited ${code}: ${stderr}`);
    assert.deepEqual(JSON.parse(stdout), { ok: false, error: "auth temp has unexpected hard links" });
    assert.equal(readFileSync(outside, "utf8"), "", "a hard-linked residue must be truncated before cleanup");
    assert.equal(readFileSync(authPath, "utf8"), "{}\n", "hardlink detection must not publish credentials");
    console.log("PASS temp hardlink is detected and all linked credential bytes are truncated");
  }

  {
    resetAuth();
    process.env.TERMINA_AUTH_PATH = authPath;
    const probe = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", `
      const { modifyProvider } = await import(${JSON.stringify(authModule)});
      modifyProvider("anthropic", () => ({ type: "api_key", key: "crash-secret" }));
    `], {
      env: { ...process.env, TERMINA_CORE_TEST: "1", TERMINA_AUTH_PATH: authPath, TERMINA_AUTH_WRITE_CRASH: "after-fsync" },
      encoding: "utf8",
    });
    assert.equal(probe.status, null, "the crash fixture must terminate by signal");
    assert.equal(probe.signal, "SIGKILL", "the crash fixture must die after temp fsync");
    const leaked = readdirSync(root).filter((name) => name.startsWith(".auth.json.tmp-"));
    assert.equal(leaked.length, 1, "a crash residue must be uniquely owned and discoverable");
    assert.equal(lstatSync(join(root, leaked[0])).mode & 0o777, 0o600, "crash residue must be mode 0600");
    assert.equal(readFileSync(authPath, "utf8"), "{}\n", "a crash before publish must not update auth.json");
    console.log("PASS crash before publish leaves only a private owned temp");
  }
} finally {
  delete process.env.TERMINA_AUTH_PATH;
  rmSync(root, { recursive: true, force: true });
}

console.log("agent-core auth write contract passed");
