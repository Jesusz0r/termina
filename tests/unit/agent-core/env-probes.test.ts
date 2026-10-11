import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { formatEnvironment } from "../../../agent-core/main/env.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));

function processResult(stdout = "", stderr = "", status: number | null = 0): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null };
}

describe("environment toolchain probes", () => {
  let fixture: string;
  let cwd: string;
  let binDir: string;

  beforeEach(() => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), "agent-core-env-probes-")));
    cwd = join(fixture, "cwd");
    binDir = join(fixture, "bin");
    mkdirSync(cwd);
    mkdirSync(binDir);
    // Keep binary lookup real and prevent fallback to host toolchains. Only
    // process results and the clock are controlled: launching fresh scripts
    // can exhaust the shared probe deadline before javac starts on macOS.
    for (const bin of ["python3", "rustc", "go", "gcc", "javac", "clang", "npm", "pnpm"]) {
      writeFileSync(join(binDir, bin), "fixture");
    }
    vi.stubEnv("PATH", binDir);
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawnSync).mockReturnValue(processResult());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  });

  function toolchain(): string[] {
    const environment = formatEnvironment(cwd, { probes: true });
    const line = environment.split("\n").find((entry) => entry.startsWith("toolchain: "));
    expect(line).toBeDefined();
    return line!.slice("toolchain: ".length).split("; ");
  }

  it("reports a trusted pnpm version from stdout", () => {
    vi.mocked(spawnSync).mockImplementation((command) => basename(command) === "pnpm"
      ? processResult("9.0.0-test\n", "ignored stderr\n")
      : processResult());

    expect(toolchain()).toContain("pnpm 9.0.0-test");
  });

  it("reports a javac version written only to stderr", () => {
    vi.mocked(spawnSync).mockImplementation((command) => basename(command) === "javac"
      ? processResult("", "javac 21.0.0-test\n")
      : processResult());

    expect(toolchain()).toContain("javac javac 21.0.0-test");
  });

  it("names failed tools without reporting their error output as a version", () => {
    vi.mocked(spawnSync).mockImplementation((command) => basename(command) === "gcc"
      ? processResult("", "flag provided but not defined: -version\n", 2)
      : processResult());

    const tools = toolchain();
    expect(tools).toContain("gcc");
    expect(tools.join("; ")).not.toContain("flag provided but not defined");
  });

  it("keeps timed-out pnpm named without reporting partial output as a version", () => {
    vi.mocked(spawnSync).mockImplementation((command) => basename(command) === "pnpm"
      ? { ...processResult("too-late\n", "", null), signal: "SIGKILL", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }
      : processResult());

    const tools = toolchain();
    expect(tools).toContain("pnpm");
    expect(tools.join("; ")).not.toContain("too-late");
  });

  it("stops launching probes when their shared deadline expires and still names later tools", () => {
    vi.mocked(spawnSync).mockImplementation(() => {
      vi.mocked(Date.now).mockReturnValue(1_500);
      return processResult("Python 3.13.0\n");
    });

    const tools = toolchain();
    expect(tools).toContain("python3 Python 3.13.0");
    expect(tools).toContain("javac");
    expect(tools).toContain("pnpm");
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith(join(binDir, "python3"), ["--version"], {
      timeout: 500,
      killSignal: "SIGKILL",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});
