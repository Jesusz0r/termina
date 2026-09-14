import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceEngine, type EvidenceDeps } from "../../../electron/evidence.ts";
import type { SnapshotStore } from "../../../electron/worldline-git.ts";

describe("undeclared-dependency specifier matrix (issue #190)", () => {
  let root = "";

  async function dependenciesOf(content: string, relPath = "index.ts"): Promise<{ status: string; undeclared: string[] }> {
    root = await mkdtemp(join(tmpdir(), "termina-evidence-deps-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    const store = {
      readBlob: async (_stateId: string, relPath: string): Promise<Buffer | null> =>
        relPath === "package.json" ? Buffer.from(JSON.stringify({ dependencies: {} })) : null,
      diffTree: async (): Promise<Array<{ relPath: string; status: "created" | "modified" | "deleted" }>> => [],
    } as unknown as SnapshotStore;
    const deps: EvidenceDeps = {
      store,
      baseStateId: "base",
      primaryRoot: root,
      mineFiles: new Set(),
      captureHead: async () => ({ commit: "head", tree: "tree" }),
      runSandboxed: async () => {
        throw new Error("no sandboxed run expected");
      },
      baseTestCommand: () => null,
      benchmarkConfig: () => null,
      sourceFilesOf: async () => [{ relPath, content }],
    };
    const engine = new EvidenceEngine(deps);
    try {
      const records = await engine.measure("A", {
        root,
        profilePath: join(root, "p.sb"),
        homeDir: root,
        tmpDir: root,
        shell: "/bin/sh",
        eventsDir: "",
        terminalId: null,
      });
      const dependencies = records.find((r) => r.kind === "dependencies")!;
      return { status: dependencies.status, undeclared: [...(dependencies.result.undeclared as string[])] };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("flags every specifier form as undeclared", async () => {
    const { status, undeclared } = await dependenciesOf([
      `import x from "evil-from";`,
      `import y from "@scope/evil-from-scoped";`,
      `const a = require("evil-require");`,
      `const b = require("@scope/evil-require-scoped");`,
      "const c = require(`evil-backtick`);",
      `const d = await import("evil-dynamic");`,
      `const e = await import("@scope/evil-dynamic-scoped");`,
      `import "evil-side-effect";`,
      `import "@scope/evil-side-effect-scoped";`,
    ].join("\n"));
    expect(status).toBe("fail");
    expect(undeclared).toEqual([
      "@scope/evil-dynamic-scoped",
      "@scope/evil-from-scoped",
      "@scope/evil-require-scoped",
      "@scope/evil-side-effect-scoped",
      "evil-backtick",
      "evil-dynamic",
      "evil-from",
      "evil-require",
      "evil-side-effect",
    ]);
  });

  it("passes builtins, relative imports, and dynamic templates", async () => {
    const { status, undeclared } = await dependenciesOf([
      `import fs from "node:fs";`,
      `import x from "./local";`,
      "const c = require(`pkg-${name}`);",
    ].join("\n"));
    expect(undeclared).toEqual([]);
    expect(status).toBe("pass");
  });

  it("ignores non-source files", async () => {
    const { status, undeclared } = await dependenciesOf(`require("evil-json");`, "data.json");
    expect(undeclared).toEqual([]);
    expect(status).toBe("pass");
  });
});
