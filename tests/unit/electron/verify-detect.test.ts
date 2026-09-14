import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  benchmarkConfigFrom,
  detectTestFromFiles,
  detectTestFromPkg,
  detectTestFromState,
} from "../../../electron/verify-detect.ts";

const pkg = (scripts: Record<string, string>): string => JSON.stringify({ scripts });

describe("verify-detect package scripts (refs #152)", () => {
  it("preserves quoted arguments verbatim through sh", () => {
    expect(detectTestFromPkg(pkg({ test: 'runner --grep "two words"' }))).toEqual({
      command: "sh",
      args: ["-c", 'runner --grep "two words"'],
      label: "npm run test",
    });
  });

  it("preserves quoted executable paths, escapes, and wildcards", () => {
    expect(detectTestFromPkg(pkg({ test: '"/opt/my tools/runner" --fast' }))?.args).toEqual([
      "-c",
      '"/opt/my tools/runner" --fast',
    ]);
    expect(detectTestFromPkg(pkg({ test: "echo a\\ b" }))?.args).toEqual(["-c", "echo a\\ b"]);
    expect(detectTestFromPkg(pkg({ test: "mocha 'test/**/*.spec.js'" }))?.args).toEqual([
      "-c",
      "mocha 'test/**/*.spec.js'",
    ]);
  });

  it("runs ordinary commands through the same shell form", () => {
    expect(detectTestFromPkg(pkg({ test: "vitest run" }))).toEqual({
      command: "sh",
      args: ["-c", "vitest run"],
      label: "npm run test",
    });
    expect(detectTestFromPkg(pkg({ test: "a && b | c" }))?.args).toEqual(["-c", "a && b | c"]);
  });

  it("prefers test, falls back to test:*, and rejects empty bodies", () => {
    expect(detectTestFromPkg(pkg({ "test:unit": "u", test: "t" }))?.label).toBe("npm run test");
    expect(detectTestFromPkg(pkg({ "test:unit": "u" }))?.label).toBe("npm run test:unit");
    expect(detectTestFromPkg(pkg({ test: "   " }))).toBeNull();
    expect(detectTestFromPkg(pkg({ build: "x" }))).toBeNull();
    expect(detectTestFromPkg("not json")).toBeNull();
  });

  it.runIf(process.platform !== "win32")("groups shell arguments when executed as argv", () => {
    const tc = detectTestFromPkg(pkg({ test: 'printf "%s|" one "two words" three' }))!;
    // The sandboxed evidence executor runs [command, ...args] directly.
    const argv = [tc.command, ...tc.args];
    expect(argv).toEqual(["sh", "-c", 'printf "%s|" one "two words" three']);
    const run = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("one|two words|three|");
  });

  it.runIf(process.platform !== "win32")("survives the verify shell-command construction", () => {
    const tc = detectTestFromPkg(pkg({ test: 'printf "%s|" one "two words" three' }))!;
    // runVerify builds `command + quoted args` and runs it under `shell -c`.
    const quoteShellArg = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`;
    const cmdline = `${tc.command} ${tc.args.map(quoteShellArg).join(" ")}`;
    const run = spawnSync("sh", ["-c", cmdline], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("one|two words|three|");
  });

  it("reads the immutable snapshot body, not the live tree", async () => {
    const store = {
      readBlob: async (_stateId: string, path: string) =>
        path === "package.json" ? Buffer.from(pkg({ test: 'runner --grep "two words"' })) : null,
    };
    expect(await detectTestFromState(store as never, "base-state")).toEqual({
      command: "sh",
      args: ["-c", 'runner --grep "two words"'],
      label: "npm run test",
    });
    const empty = { readBlob: async () => null };
    expect(await detectTestFromState(empty as never, "base-state")).toBeNull();
  });

  it("keeps non-npm detection as direct argv", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "termina-verify-detect-"));
    try {
      expect(await detectTestFromFiles(root)).toBeNull();
      writeFileSync(join(root, "pytest.ini"), "[pytest]\n");
      expect(await detectTestFromFiles(root)).toEqual({ command: "pytest", args: [], label: "pytest" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const cargo = mkdtempSync(join(tmpdir(), "termina-verify-cargo-"));
    try {
      writeFileSync(join(cargo, "Cargo.toml"), "[package]\n");
      expect(await detectTestFromFiles(cargo)).toEqual({ command: "cargo", args: ["test"], label: "cargo test" });
    } finally {
      rmSync(cargo, { recursive: true, force: true });
    }
    const gom = mkdtempSync(join(tmpdir(), "termina-verify-go-"));
    try {
      writeFileSync(join(gom, "go.mod"), "module x\n");
      expect(await detectTestFromFiles(gom)).toEqual({ command: "go", args: ["test", "./..."], label: "go test ./..." });
    } finally {
      rmSync(gom, { recursive: true, force: true });
    }
  });
});

describe("verify-detect benchmark config (refs #152)", () => {
  const bench = (command: string): { readBlob: (stateId: string, path: string) => Promise<Buffer | null> } => ({
    readBlob: async (_stateId, path) =>
      path === "package.json" ? Buffer.from(JSON.stringify({ termina: { benchmark: { command, unit: "ms" } } })) : null,
  });

  it("preserves the harness command verbatim through sh", async () => {
    const cfg = await benchmarkConfigFrom(bench('node bench.js --filter "two words"') as never, "base-state");
    expect(cfg?.command).toEqual(["sh", "-c", 'node bench.js --filter "two words"']);
    expect(cfg?.unit).toBe("ms");
  });

  it("rejects missing and empty harness commands", async () => {
    expect(await benchmarkConfigFrom(bench("") as never, "base-state")).toBeNull();
    expect(await benchmarkConfigFrom({ readBlob: async () => null } as never, "base-state")).toBeNull();
    const bad = { readBlob: async () => Buffer.from("not json") };
    expect(await benchmarkConfigFrom(bad as never, "base-state")).toBeNull();
  });
});
