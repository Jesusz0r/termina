import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filterAgentEnvironment } from "../../../electron/agent-env.ts";

describe("filterAgentEnvironment", () => {
  it("strips Node and loader injection variables", () => {
    const env = filterAgentEnvironment({
      PATH: "/usr/bin:/bin",
      NODE_OPTIONS: "--require /tmp/inject.js",
      NODE_PATH: "/tmp/evil-modules",
      LD_PRELOAD: "/tmp/evil.so",
      LD_LIBRARY_PATH: "/tmp/evil-lib",
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
  });

  it("strips DYLD_* and ELECTRON_* by prefix", () => {
    const env = filterAgentEnvironment({
      PATH: "/usr/bin:/bin",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      DYLD_LIBRARY_PATH: "/tmp/evil-lib",
      DYLD_FUTURE_VAR: "x",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_FUTURE_FLAG: "x",
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    for (const key of Object.keys(env)) {
      expect(key.startsWith("DYLD_")).toBe(false);
      expect(key.startsWith("ELECTRON_")).toBe(false);
    }
  });

  it("strips PI_* by prefix, beyond the old fixed session set", () => {
    const env = filterAgentEnvironment({
      PATH: "/usr/bin:/bin",
      PI_SESSION_FILE: "/tmp/pinned-session",
      PI_SESSION_ID: "pinned",
      PI_MODEL: "pinned-model",
      PI_PROVIDER: "pinned-provider",
      PI_FUTURE_VAR: "x",
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    for (const key of Object.keys(env)) expect(key.startsWith("PI_")).toBe(false);
  });

  it("strips TERMINA_CORE_SESSION_* by prefix plus launch-only TERMINA_CORE_RESUME", () => {
    const env = filterAgentEnvironment({
      PATH: "/usr/bin:/bin",
      TERMINA_CORE_SESSION_FILE: "/tmp/pinned-core-session",
      TERMINA_CORE_SESSION_ID: "pinned-core",
      TERMINA_CORE_SESSION_FUTURE: "x",
      TERMINA_CORE_RESUME: "1",
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    for (const key of Object.keys(env)) expect(key.startsWith("TERMINA_CORE_SESSION_")).toBe(false);
    expect(env.TERMINA_CORE_RESUME).toBeUndefined();
  });

  it("keeps the toolchain, credentials, and host opt-ins the agent needs", () => {
    const host = {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/test-home",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-openai-test",
      TERMINA_AUTH_PATH: "/tmp/auth.json",
      TERMINA_CORE_BIN: "/custom/core",
      TERMINA_CORE_APPROVE: "all",
      TERMINA_CORE_PROVIDER: "openai",
      TERMINA_CORE_MODEL: "gpt-x",
      TERMINA_EVENTS_DIR: "/tmp/events",
    };
    expect(filterAgentEnvironment(host)).toEqual(host);
  });

  it("does not mutate its input", () => {
    const host = { PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/inject.js", PI_FUTURE: "x" };
    filterAgentEnvironment(host);
    expect(host).toEqual({ PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/inject.js", PI_FUTURE: "x" });
  });

  it("a hostile NODE_OPTIONS does not reach a child spawned with the filtered env", () => {
    const dir = mkdtempSync(join(tmpdir(), "termina-agent-env-"));
    try {
      const inject = join(dir, "inject.js");
      writeFileSync(inject, `process.env.TERMINA_INJECT_PROBE = "pwned";\n`);
      const probe = `console.log(process.env.TERMINA_INJECT_PROBE ?? "clean");`;
      const hostile = { ...process.env, NODE_OPTIONS: `--require ${inject}` };
      const filtered = filterAgentEnvironment(hostile);
      expect(filtered.NODE_OPTIONS).toBeUndefined();
      const clean = execFileSync(process.execPath, ["-e", probe], {
        env: filtered,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(clean.trim()).toBe("clean");
      const control = execFileSync(process.execPath, ["-e", probe], {
        env: hostile,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(control.trim()).toBe("pwned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
