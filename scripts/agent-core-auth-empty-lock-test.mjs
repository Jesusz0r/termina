/** Regression test for generation-bound auth-lock publication. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "termina-auth-empty-lock-"));
const authPath = join(root, "auth.json");
const lockPath = `${authPath}.lock`;
const authModule = pathToFileURL(resolve("agent-core/auth.ts")).href;

function waitFor(check, message) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function startWriter(options) {
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

try {
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
  assert.equal(existsSync(lockPath), false, "a candidate must not expose an empty canonical lock");
  const second = startWriter({
    PROVIDER: "openai",
    KEY: "second",
    TERMINA_AUTH_WRITE_PAUSE: "after-temp",
    TERMINA_AUTH_WRITE_PAUSED: secondMarker,
    TERMINA_AUTH_WRITE_RESUME: secondResume,
  });
  waitFor(() => existsSync(secondMarker), "second writer did not hold the published generation");
  assert.equal(readdirSync(lockPath).some((name) => name.startsWith(".record-")), true);
  writeFileSync(firstResume, "resume\n", { mode: 0o600 });
  const [firstCode, firstSignal] = await once(first.child, "close");
  assert.equal(firstCode, 0, `first writer exited ${firstCode}: ${first.stderr}`);
  assert.equal(firstSignal, null);
  assert.deepEqual(JSON.parse(first.stdout), { ok: false, error: "auth file busy" });
  writeFileSync(secondResume, "resume\n", { mode: 0o600 });
  const [secondCode, secondSignal] = await once(second.child, "close");
  assert.equal(secondCode, 0, `second writer exited ${secondCode}: ${second.stderr}`);
  assert.equal(secondSignal, null);
  assert.deepEqual(JSON.parse(second.stdout), { ok: true });
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  assert.equal(auth.anthropic, undefined, "the losing candidate must not publish its credentials");
  assert.equal(auth.openai.key, "second");
  assert.equal(existsSync(lockPath), false, "the winning generation must release its canonical lock");
  console.log("PASS concurrent candidate publication never exposes or recovers an empty canonical lock");
} finally {
  rmSync(root, { recursive: true, force: true });
}
