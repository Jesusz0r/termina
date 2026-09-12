import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { filterVerifyEnvironment } from "../../../electron/sandbox.ts";

const execFileAsync = promisify(execFile);

/**
 * Primary Verify and diagnostics run project-controlled commands (a repo's
 * test script, the project's own tsc). They must inherit a minted minimal
 * env — PATH plus locale/terminal variables — and never ambient provider
 * tokens, SSH_*, or proxy variables. Candidate Verify already mints its
 * env; this covers the primary side (issue #43).
 */
describe("Verify/diagnostics environment isolation", () => {
  /** A hostile host env: every secret namespace must be dropped. */
  function hostileEnv(): NodeJS.Dict<string | undefined> {
    return {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      HOME: "/Users/tester",
      TMPDIR: "/tmp/verify-test",
      ANTHROPIC_API_KEY: "sk-ant-verify-canary-1",
      ANTHROPIC_AUTH_TOKEN: "ant-auth-verify-canary-1",
      OPENAI_API_KEY: "sk-openai-verify-canary-1",
      GEMINI_API_KEY: "gemini-verify-canary-1",
      XAI_API_KEY: "xai-verify-canary-1",
      OPENROUTER_API_KEY: "or-verify-canary-1",
      AWS_ACCESS_KEY_ID: "AKIAVERIFYCANARY1",
      AWS_SECRET_ACCESS_KEY: "aws-secret-verify-canary-1",
      AWS_SESSION_TOKEN: "aws-token-verify-canary-1",
      SSH_AUTH_SOCK: "/tmp/ssh-verify-canary/agent.sock",
      SSH_AGENT_PID: "424242",
      SSH_CONNECTION: "ssh-verify-canary",
      HTTP_PROXY: "http://proxy.verify-canary:8080",
      HTTPS_PROXY: "http://proxy.verify-canary:8080",
      http_proxy: "http://proxy.verify-canary:8080",
      https_proxy: "http://proxy.verify-canary:8080",
      ALL_PROXY: "socks5://proxy.verify-canary:1080",
      TERMINA_EVENTS_DIR: "/tmp/termina-verify-canary",
      TERMINA_CORE_SESSION_FILE: "/tmp/core-verify-canary.json",
      PI_SESSION_FILE: "/tmp/pi-verify-canary.json",
      FOO_BAR_SECRET: "junk-verify-canary-1",
    };
  }

  it("mints PATH + locale/TERM + home/tmp and drops every secret namespace", () => {
    const env = filterVerifyEnvironment(hostileEnv(), []);

    // Kept: executable search, locale/terminal, home/tmp toolchains need.
    assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(env.LANG, "en_US.UTF-8");
    assert.equal(env.LC_ALL, "en_US.UTF-8");
    assert.equal(env.TERM, "xterm-256color");
    assert.equal(env.HOME, "/Users/tester");
    assert.equal(env.TMPDIR, "/tmp/verify-test");

    // Dropped: provider tokens, cloud credentials, SSH, proxies, app config, junk.
    for (const key of [
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY",
      "XAI_API_KEY", "OPENROUTER_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_CONNECTION",
      "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY",
      "TERMINA_EVENTS_DIR", "TERMINA_CORE_SESSION_FILE", "PI_SESSION_FILE", "FOO_BAR_SECRET",
    ]) {
      assert.equal(env[key], undefined, `${key} must not cross into project commands`);
    }
    for (const value of Object.values(env)) {
      assert.equal(value?.includes("verify-canary"), false, "no canary value may survive filtering");
    }
  });

  it("prepends path prefixes and rejects control characters", () => {
    const env = filterVerifyEnvironment(
      { PATH: "relative/bin:/usr/bin", HOME: "bad\nhome", TMPDIR: undefined, LANG: "ok\nnope", TERM: "xterm" },
      ["/opt/bundled/bin"],
    );
    assert.equal(env.PATH, "/opt/bundled/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin");
    assert.equal(env.HOME, undefined);
    assert.equal(env.TMPDIR, undefined);
    assert.equal(env.LANG, undefined);
    assert.equal(env.TERM, "xterm");
  });

  it.skipIf(process.platform === "win32")("a spawned env-printing fixture sees no provider keys, SSH, or proxy vars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "termina-verify-env-"));
    const fixture = join(dir, "print-env.sh");
    writeFileSync(fixture, "#!/bin/sh\nenv\n", "utf8");
    chmodSync(fixture, 0o755);

    // Same spawn shape as Primary Verify: sh -c "<project command>".
    const { stdout } = await execFileAsync("sh", ["-c", fixture], {
      cwd: dir,
      env: filterVerifyEnvironment(hostileEnv(), []) as NodeJS.ProcessEnv,
      timeout: 30_000,
    });

    expect(stdout).toContain("PATH=");
    expect(stdout).toContain("HOME=/Users/tester");
    expect(stdout).toContain("TERM=xterm-256color");
    expect(stdout).not.toContain("verify-canary");
    expect(stdout).not.toMatch(/^(ANTHROPIC|OPENAI|GEMINI|XAI|OPENROUTER|AWS_|SSH_|.*_PROXY=)/m);
  });

  it("wires Primary Verify and diagnostics to the minted env, not cleanEnv", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const diagnostics = readFileSync(new URL("../../../electron/diagnostics.ts", import.meta.url), "utf8");
    const checks: string[] = [];
    function check(name: string, value: unknown) {
      assert.equal(Boolean(value), true, name);
      checks.push(name);
    }

    // Primary Verify: the non-candidate branch mints verifyEnv().
    check("primary verify mints verifyEnv", main.includes(": { ...verifyEnv() };"));
    check("primary verify no longer inherits cleanEnv", !main.includes(": { ...cleanEnv() };"));
    // Diagnostics: the host seam supplies verifyEnv to the project tsc spawn.
    check("diagnostics seam supplies verifyEnv",
      diagnostics.includes("verifyEnv(): Record<string, string | undefined>;")
      && diagnostics.includes("env: { ...this.host.verifyEnv() },"));
    check("diagnostics host drops cleanEnv", !diagnostics.includes("cleanEnv"));
    check("main supplies verifyEnv to diagnostics", main.includes("verifyEnv: () => verifyEnv(),"));
    // Scope boundary (issue #44 owns these): cleanEnv itself is untouched
    // and still feeds the primary-agent and subagent spawns.
    check("cleanEnv still feeds agent and subagent spawns",
      main.includes("function cleanEnv(): Record<string, string | undefined> {")
      && main.includes("baseEnv: () => cleanEnv(),")
      && main.includes("...cleanEnv(),"));
    assert.ok(checks.length >= 6);
  });
});
