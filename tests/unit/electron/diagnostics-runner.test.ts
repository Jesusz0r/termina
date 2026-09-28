import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticsRunner, type DiagnosticsHost } from "../../../electron/diagnostics.ts";
import { writeBoundOwnedFile } from "../../../electron/worldline-git.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
vi.mock("../../../electron/worldline-git.ts", () => ({ writeBoundOwnedFile: vi.fn().mockResolvedValue({}) }));
vi.mock("../../../electron/sandbox.ts", () => ({ terminateSandboxProcessGroup: vi.fn() }));

function fakeCompiler() {
  return Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
}

describe("diagnostics context publication", () => {
  let root: string;
  let workspace: { id: string; root: string; primary: boolean; generation: number };
  let terminal: { id: string; workspaceId: string; closed: boolean };
  let runner: DiagnosticsRunner;
  let children: ReturnType<typeof fakeCompiler>[];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    root = await mkdtemp(join(tmpdir(), "termina-diagnostics-runner-"));
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), "{}");
    await writeFile(join(root, "node_modules", ".bin", "tsc"), "fixture");
    workspace = { id: "ws", root, primary: true, generation: 1 };
    terminal = { id: "term-1", workspaceId: "ws", closed: false };
    children = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = fakeCompiler();
      children.push(child);
      return child;
    });
    const binding = { dev: "1", ino: "2" };
    const host: DiagnosticsHost = {
      workspaceById: () => workspace,
      isProjectSwitching: () => false,
      isDisposed: () => false,
      isTerminalCurrent: (inst) => inst === terminal && !terminal.closed,
      eventsTarget: () => ({ dir: root, binding }),
      verifyEnv: () => ({}),
    };
    runner = new DiagnosticsRunner(host);
  });

  afterEach(async () => {
    for (const child of children) child.emit("close", null);
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  async function complete(code: number, output = "") {
    await runner.run(terminal);
    const child = children.at(-1)!;
    child.stderr.end(Buffer.from(output));
    child.emit("close", code);
    return vi.mocked(writeBoundOwnedFile).mock.calls.at(-1)![0];
  }

  function nextGeneration() {
    workspace.generation += 1;
    vi.advanceTimersByTime(60_001);
  }

  it("publishes byte-identical clean results across clocks and generations", async () => {
    const first = await complete(0, "ignored successful compiler output");
    nextGeneration();
    const second = await complete(0);
    expect(second.content).toEqual(first.content);
    expect(second.content.toString()).toBe("## Diagnostics — `tsc --noEmit`\n\n**Status:** ✅ clean\n\n");
    expect(second.skipIfUnchanged).toBe(true);
  });

  it("keeps identical failures stable but publishes changes and recovery", async () => {
    const first = await complete(1, "first error");
    nextGeneration();
    expect((await complete(1, "first error")).content).toEqual(first.content);
    nextGeneration();
    expect((await complete(1, "second error")).content.toString()).toContain("second error");
    nextGeneration();
    const clean = (await complete(0)).content.toString();
    expect(clean).toContain("✅ clean");
    expect(clean).not.toContain("error");
  });

  it.each(["界", "🧪"])("bounds multibyte diagnostics without splitting characters: %s", async (character) => {
    const result = await complete(1, `${character.repeat(8_000)} final compiler error`);
    const text = result.content.toString("utf8");
    expect(result.content.byteLength).toBeLessThanOrEqual(result.maxBytes!);
    expect(text).toContain("final compiler error");
    expect(text).not.toContain("\uFFFD");
  });

  it.each(["stdout", "stderr"] as const)("decodes split UTF-8 output from %s", async (stream) => {
    await runner.run(terminal);
    const child = children[0]!;
    const bytes = Buffer.from("診断 🧪 final error");
    child[stream].write(bytes.subarray(0, 1));
    child[stream].write(bytes.subarray(1, 8));
    child[stream].end(bytes.subarray(8));
    child.emit("close", 1);
    const text = vi.mocked(writeBoundOwnedFile).mock.calls[0]![0].content.toString();
    expect(text).toContain("診断 🧪 final error");
    expect(text).not.toContain("\uFFFD");
  });

  it("does not split a character at the captured output limit", async () => {
    const result = await complete(1, `${"x".repeat(32 * 1024 - 1)}🧪 ignored tail`);
    expect(result.content.toString()).not.toContain("\uFFFD");
    expect(result.content.byteLength).toBeLessThanOrEqual(result.maxBytes!);
  });

  it("admits only one run while asynchronous compiler detection is pending", async () => {
    await Promise.all([runner.run(terminal), runner.run(terminal)]);
    expect(children).toHaveLength(1);
  });

  it("releases an unsuccessful detection so a later settle can retry", async () => {
    await rm(join(root, "tsconfig.json"));
    await runner.run(terminal);
    expect(children).toHaveLength(0);
    await writeFile(join(root, "tsconfig.json"), "{}");
    await complete(0);
    expect(children).toHaveLength(1);
    expect(writeBoundOwnedFile).toHaveBeenCalledOnce();
  });

  it("releases a detection abandoned by a closed terminal", async () => {
    const pending = runner.run(terminal);
    terminal.closed = true;
    await pending;
    expect(children).toHaveLength(0);
    terminal.closed = false;
    await complete(0);
    expect(children).toHaveLength(1);
  });

  it("does not publish after the terminal closes", async () => {
    await runner.run(terminal);
    terminal.closed = true;
    children[0]!.emit("close", 0);
    expect(writeBoundOwnedFile).not.toHaveBeenCalled();
  });
});
