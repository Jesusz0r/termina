import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import ts from "typescript";
import { invalidateVerify, isVerifySourceCurrent, verifyOutputTail } from "../../../electron/main/verify-source.ts";
import type { VerifyInfo, VerifySource } from "../../../shared/types.ts";

// Execute main's actual orchestration with a controlled capture-cleanup await.
// No Electron, shell, git process, timer sleep, or production test hook is needed.
const sourceFile = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const methods = new Map<string, string>();
let outputLimit = "";
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === "MAX_VERIFY_OUTPUT") outputLimit = node.getText(sourceFile);
  if (ts.isMethodDeclaration(node) && ["runVerify", "releaseVerifyAdmission"].includes(node.name.getText(sourceFile))) {
    methods.set(node.name.getText(sourceFile), node.getText(sourceFile));
  }
  ts.forEachChild(node, visit);
}
visit(sourceFile);
if (methods.size !== 2 || !outputLimit) throw new Error("main Verify orchestration is missing");
const compiled = ts.transpile(`const ${outputLimit};\nclass TerminaApp { ${[...methods.values()].join("\n")} }\nreturn new TerminaApp();`, { target: ts.ScriptTarget.ES2022 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const captured: VerifySource = { root: "/project", workspaceId: "ws-1", tree: "a".repeat(40), revision: 3, observationEpoch: 1, generation: 4 };
  let version: { revision: number; observationEpoch: number } | null = { revision: 3, observationEpoch: 1 };
  const watcher = { sourceVersion: () => version };
  const workspace = { id: "ws-1", root: "/project", generation: 4, watcher };
  let liveWorkspace = workspace;
  const owner = { id: "term-1", cwd: "/project", closed: false, verify: { state: "untested", command: null, summary: null } as VerifyInfo, verifyOutput: null as string | null };
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const cleanupStarted = deferred<void>();
  const releaseCleanup = deferred<void>();
  const settled = deferred<VerifyInfo>();
  const main = new Function(
    "detectTestCommand", "detectShells", "quoteShellArg", "verifyEnv", "spawn", "terminateSandboxProcessGroup",
    "invalidateVerify", "isVerifySourceCurrent", "verifyOutputTail", compiled,
  )(
    async () => ({ command: "runner", args: [], label: "runner" }), async () => [{ path: "/bin/sh", name: "sh" }],
    (arg: string) => arg, () => ({}), () => child, async () => true,
    invalidateVerify, isVerifySourceCurrent, verifyOutputTail,
  );
  let captures = 0;
  Object.assign(main, {
    runtime: new Map([[owner.id, owner]]), disposed: false,
    verifyRuns: new Map(), verifyJobs: new Map(), autoVerifyTasks: new Map(), autoVerifyFailures: new Map(),
    captureRendererSendTarget: () => null, projectOfTerminal: () => ({ id: "project-1" }), projectIsSwitching: () => false,
    workspaceOfTerminal: () => liveWorkspace,
    captureVerifySource: async () => {
      const descriptor = { ...captured };
      if (++captures === 2) {
        // Descriptor already validated; real captureVerifySource now awaits unref.
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      }
      return descriptor;
    },
    trackRecordingTask: (task: Promise<unknown>) => { void task.catch((error) => { throw error; }); },
    savePlanRoster: () => {}, writeVerifyContext: () => {}, appendMailboxNote: () => {},
    send: (_channel: string, payload: { verify: VerifyInfo }) => {
      if (payload.verify.state !== "running") settled.resolve(payload.verify);
    },
  });
  return {
    main, owner, workspace, captured, child, cleanupStarted, releaseCleanup, settled,
    setVersion: (next: typeof version) => { version = next; },
    replaceWorkspace: () => { liveWorkspace = { ...workspace, id: "ws-2", root: "/other" }; },
  };
}

describe("Verify completion publication fence", () => {
  for (const change of ["source revision", "observation loss", "observation epoch", "workspace generation", "watcher replacement", "workspace replacement"] as const) {
    it(`retains a historical pass as stale when ${change} occurs during final capture cleanup`, async () => {
      const f = fixture();
      try {
        expect(await f.main.runVerify("term-1")).toEqual({ ok: true });
        f.child.stdout.emit("data", "historical output\n");
        f.child.emit("close", 0);
        await f.cleanupStarted.promise;
        expect(f.owner.verify.state).toBe("running");
        if (change === "source revision") f.setVersion({ revision: 4, observationEpoch: 1 });
        if (change === "observation loss") f.setVersion(null);
        if (change === "observation epoch") f.setVersion({ revision: 3, observationEpoch: 2 });
        if (change === "workspace generation") f.workspace.generation++;
        if (change === "watcher replacement") f.workspace.watcher = { sourceVersion: () => ({ revision: 3, observationEpoch: 1 }) };
        if (change === "workspace replacement") f.replaceWorkspace();
        // Watcher invalidation intentionally cannot settle an active child.
        f.owner.verify = invalidateVerify(f.owner.verify, "activity during cleanup");
        expect(f.owner.verify.state).toBe("running");
        f.releaseCleanup.resolve();
        const verdict = await f.settled.promise;
        expect(verdict.state).toBe("stale");
        expect(verdict.result).toMatchObject({ state: "pass", exitCode: 0 });
        expect(verdict.source).toEqual(f.captured);
        expect(f.owner.verifyOutput).toBe("historical output");
      } finally {
        f.releaseCleanup.resolve();
        f.child.emit("close", 0);
        f.child.stdout.destroy();
        f.child.stderr.destroy();
      }
    });
  }

  it("still certifies the matching live source after final cleanup", async () => {
    const f = fixture();
    try {
      expect(await f.main.runVerify("term-1")).toEqual({ ok: true });
      f.child.stdout.emit("data", "x".repeat(300_000));
      f.child.stdout.emit("data", "\nfinal execution output");
      f.child.emit("close", 0);
      await f.cleanupStarted.promise;
      f.releaseCleanup.resolve();
      expect((await f.settled.promise).state).toBe("pass");
      expect(f.owner.verifyOutput).toMatch(/final execution output$/);
      expect(Buffer.byteLength(f.owner.verifyOutput!)).toBeLessThanOrEqual(6000);
    } finally {
      f.releaseCleanup.resolve();
      f.child.emit("close", 0);
      f.child.stdout.destroy();
      f.child.stderr.destroy();
    }
  });
});
