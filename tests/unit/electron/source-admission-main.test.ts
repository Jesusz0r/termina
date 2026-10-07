import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, realpath as fsRealpath } from "node:fs/promises";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { SourceAdmissions, sourceTreesOverlap, type SourceClaim } from "../../../electron/main/source-admission.ts";
import { findTaskByText, settleDispatchTask } from "../../../electron/plan-board.ts";

// Exercise main's real admission methods without importing Electron or launching a PTY.
const source = ts.createSourceFile("main.ts", readFileSync(join(process.cwd(), "electron/main.ts"), "utf8"), ts.ScriptTarget.ES2022, true);
const names = ["admitSource", "sourceWorkspaceWriter", "sourceConflictText", "expireSourceAdmission", "rejectDispatchStart"];
const members = source.statements.filter(ts.isClassDeclaration).flatMap((node) => [...node.members]);
const methods = names.map((name) => {
  const member = members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  if (!member) throw new Error(`missing main method ${name}`);
  return member.getText(source);
});
const body = ts.transpileModule(`return new (class { ${methods.join("\n")} })();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

interface Workspace {
  id: string;
  root: string;
  canonicalRoot: string;
  primary: boolean;
  writerId: string | null;
}
interface Actor {
  id: string;
  generation: number;
  busy: boolean;
  closed: boolean;
  projectId: string;
  pty: { hasExited: boolean; interrupt: ReturnType<typeof vi.fn> };
}
interface Project {
  id: string;
  canonicalRoot: string;
  primaryRootIdentity: { dev: string; ino: string };
  workspaces: Map<string, Workspace>;
}
interface MainMethods {
  disposed: boolean;
  projects: Map<string, Project>;
  runtime: { get(id: string): Actor | undefined };
  workspaceOfTerminal(actor: Actor): Workspace | undefined;
  projectOfTerminal(id: string): Project | undefined;
  sourceAdmissions: SourceAdmissions;
  dispatchRuns: Map<string, unknown>;
  pendingPreflights: Map<string, { terminalId: string }>;
  expirePreflight: ReturnType<typeof vi.fn>;
  admitSource(actor: Actor): Promise<{ ok: boolean; error?: string }>;
  expireSourceAdmission(claim: SourceClaim): void;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

function harness() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "termina-admission-main-")));
  const root = join(dir, "project");
  mkdirSync(root);
  const main = new Function("fsRealpath", "lstat", "sourceTreesOverlap", "findTaskByText", "settleDispatchTask", body)(
    fsRealpath, lstat, sourceTreesOverlap, findTaskByText, settleDispatchTask,
  ) as MainMethods;
  const actors = new Map<string, Actor>();
  const workspaces = new Map<string, Workspace>();
  const children = new Set<string>();
  main.disposed = false;
  main.projects = new Map();
  main.runtime = { get: (id) => actors.get(id) };
  main.workspaceOfTerminal = (actor) => workspaces.get(actor.id);
  main.projectOfTerminal = (id) => main.projects.get(actors.get(id)?.projectId ?? "");
  main.dispatchRuns = new Map();
  main.pendingPreflights = new Map();
  main.expirePreflight = vi.fn((token: string) => { main.pendingPreflights.delete(token); });
  main.sourceAdmissions = new SourceAdmissions((id) => children.has(id), (claim) => main.expireSourceAdmission(claim));
  cleanups.push(() => { main.sourceAdmissions.dispose(); rmSync(dir, { recursive: true, force: true }); });
  async function actor(id: string, displayRoot = root): Promise<Actor> {
    const canonicalRoot = await fsRealpath(displayRoot);
    const stat = await lstat(canonicalRoot, { bigint: true });
    const ws: Workspace = { id: `ws-${id}`, root: displayRoot, canonicalRoot, primary: true, writerId: null };
    const value: Actor = { id, generation: 1, busy: false, closed: false, projectId: `project-${id}`, pty: { hasExited: false, interrupt: vi.fn() } };
    main.projects.set(value.projectId, {
      id: value.projectId, canonicalRoot, primaryRootIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, workspaces: new Map([[ws.id, ws]]),
    });
    actors.set(id, value);
    workspaces.set(id, ws);
    return value;
  }
  const competing = (): SourceClaim => ({ id: "other", generation: 1, root, groupId: "other", kind: "agent" });
  return { main, dir, root, actor, actors, competing };
}

describe("main source admission wiring", () => {
  it("resolves aliases physically and rejects independent nested roots", async () => {
    const h = harness();
    const alias = join(h.dir, "alias");
    const nested = join(h.root, "nested");
    symlinkSync(h.root, alias);
    mkdirSync(nested);
    const owner = await h.actor("owner", alias);
    expect(await h.main.admitSource(owner)).toEqual({ ok: true });
    for (const [id, root] of [["alias-writer", h.root], ["nested-writer", nested]]) {
      const other = await h.actor(id!, root!);
      expect(await h.main.admitSource(other)).toMatchObject({ ok: false, error: expect.stringContaining("owner") });
    }
  });

  it("does not reserve a stale terminal after filesystem preparation", async () => {
    const h = harness();
    const actor = await h.actor("owner");
    const preparation = h.main.admitSource(actor);
    h.actors.delete(actor.id);
    expect(await preparation).toMatchObject({ ok: false });
    expect(h.main.sourceAdmissions.admit(h.competing())).toEqual({ ok: true });
  });

  it("rejects a replaced primary folder rather than silently admitting its new contents", async () => {
    const h = harness();
    const actor = await h.actor("owner");
    renameSync(h.root, join(h.dir, "retired"));
    mkdirSync(h.root);
    expect(await h.main.admitSource(actor)).toMatchObject({ ok: false, error: expect.stringContaining("replaced") });
    expect(h.main.sourceAdmissions.admit(h.competing())).toEqual({ ok: true });
  });

  it("interrupts unconfirmed startup but holds its scope until settlement or exit", async () => {
    vi.useFakeTimers();
    const h = harness();
    const actor = await h.actor("owner");
    expect(await h.main.admitSource(actor)).toEqual({ ok: true });
    h.main.pendingPreflights.set("token", { terminalId: actor.id });
    vi.advanceTimersByTime(60_000);
    expect(actor.pty.interrupt).toHaveBeenCalledOnce();
    expect(h.main.expirePreflight).toHaveBeenCalledWith("token", "timeout");
    expect(h.main.sourceAdmissions.admit(h.competing()).ok).toBe(false);
    actor.pty.hasExited = true;
    h.main.sourceAdmissions.finish(actor.id, actor.generation);
    expect(h.main.sourceAdmissions.admit(h.competing())).toEqual({ ok: true });
  });

  it("does not interrupt a prior live run when its new preparation expires", async () => {
    vi.useFakeTimers();
    const h = harness();
    const actor = await h.actor("owner");
    await h.main.admitSource(actor);
    h.main.sourceAdmissions.start(actor.id, actor.generation);
    actor.busy = true;
    await h.main.admitSource(actor);
    vi.advanceTimersByTime(60_000);
    expect(actor.pty.interrupt).not.toHaveBeenCalled();
    expect(h.main.sourceAdmissions.admit(h.competing()).ok).toBe(false);
  });
});
