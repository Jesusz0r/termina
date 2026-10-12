import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { parseTerminalTarget } from "../../../electron/main/ipc-validate.ts";
import { chooseProjectTerminal } from "../../../electron/main/project-entry.ts";
import { emptyActivityInput, type AgentActivityInput } from "../../../electron/agent-activity.ts";
import { isPtyRendererSendTargetCurrent, type PtyRendererSendTarget } from "../../../electron/pty-egress.ts";
import type { FolderOpenedPayload, ProjectActivateResult, ProjectWorkspaceRef, ExplorerEntry, ContentHit } from "../../../shared/types.ts";
import { ProjectPathIndex, SearchGenerations, searchProjectFiles } from "../../../electron/quick-open.ts";
import { searchProjectContent } from "../../../electron/content-search.ts";
import { validateGrepPattern } from "../../../shared/grep-pattern.ts";

// Exercise production orchestration without importing Electron or touching host sessions.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = ["selectTerminal", "selectedTerminal", "activateProject", "displayedWorkspace", "sendFolderOpened", "projectNavigationTerminal", "projectOfTerminal", "workspaceOfTerminal", "projectIsSwitching", "beginProjectSelectionAction", "nextProjectActivationGeneration", "projectWorkspace", "explorerWorkspace", "writableProjectWorkspace", "explorerWorkspaceIsLive", "mutateExplorer", "listDir", "searchProjectFiles", "searchProjectContent"];
const methods = new Map<string, string>();
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(source))) methods.set(node.name.getText(source), node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
if (methods.size !== names.length) throw new Error("workspace-selection main methods are missing");
const compiled = ts.transpile(`class Main { ${[...methods.values()].join("\n")} } return new Main();`, { target: ts.ScriptTarget.ES2022 });
interface Workspace { id: string; root: string; primary: boolean; writerId?: string | null }
interface Terminal { id: string; generation: number; projectId: string; workspaceId: string; closed: boolean; type: "agent" | "shell"; pty: { hasExited: boolean } }
interface Project { id: string; cwd: string; activationGeneration: number; workspaces: Map<string, Workspace>; lastTerminal?: { id: string; generation: number } }
interface Harness {
  projects: Map<string, Project>; runtime: Map<string, Terminal>; workspaceOwners: Map<string, string>;
  switchingProjects: Set<string>; projectClosePromises: Map<string, Promise<unknown>>;
  activeProjectId: string; disposed: boolean; projectActivationGeneration: number;
  selectTerminal(id: unknown, generation: unknown): Promise<ProjectActivateResult>;
  selectedTerminal(): Terminal | null;
  activityInputs: Map<string, AgentActivityInput>;
  activateProject(id: string, target?: PtyRendererSendTarget | null, action?: number, workspace?: string, selection?: { id: string; generation: number }, intent?: "entry" | "context"): Promise<FolderOpenedPayload | null>;
  agentNeedsLogin(): Promise<boolean>; captureRendererSendTarget(): PtyRendererSendTarget | null;
  send: ReturnType<typeof vi.fn>; persistOpenProjects: ReturnType<typeof vi.fn>;
  listDir(owner: unknown, path: string): Promise<{ entries: ExplorerEntry[]; error?: string }>;
  mutateExplorer(owner: unknown, callback: (workspace: Workspace, live: () => boolean) => Promise<{ ok: boolean }>): Promise<{ ok: boolean; error?: string }>;
  acquireWriteLease: ReturnType<typeof vi.fn>; releaseWriteLease: ReturnType<typeof vi.fn>;
  searchProjectFiles(query: string, lane: string): Promise<{ entries: Array<{ relPath: string }> }>;
  searchProjectContent(pattern: string, lane: string): Promise<{ hits: ContentHit[] }>;
  canonicalPath(path: string): Promise<string>;
}
function renderer(): PtyRendererSendTarget {
  return { window: { isDestroyed: () => false }, webContents: { isDestroyed: () => false, isCrashed: () => false, send: vi.fn() }, windowGeneration: 1, rendererGeneration: 1, nonce: "document-1" };
}
function fixture() {
  const primary: Workspace = { id: "primary", root: "/source", primary: true };
  const candidate: Workspace = { id: "candidate", root: "/worlds/cmp-1/A", primary: false };
  const project: Project = { id: "project", cwd: primary.root, activationGeneration: 0, workspaces: new Map([[primary.id, primary], [candidate.id, candidate]]) };
  const worker: Terminal = { id: "term-worker", generation: 7, projectId: project.id, workspaceId: candidate.id, closed: false, type: "agent", pty: { hasExited: false } };
  const owner: Terminal = { ...worker, id: "term-owner", workspaceId: primary.id };
  const bindings = {
    parseTerminalTarget, isPtyRendererSendTargetCurrent, chooseProjectTerminal, randomUUID, readdir,
    fsRealpath: realpath, relative, isAbsolute, join, IGNORED_SEGMENTS: new Set(), MAX_EXPLORER_ENTRIES: 1000,
    searchProjectFiles, validateGrepPattern,
    searchProjectContent: (root: string, pattern: string, options: Parameters<typeof searchProjectContent>[2]) =>
      searchProjectContent(root, pattern, { ...options, rg: null }),
  };
  const main = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings)) as Harness;
  let target: PtyRendererSendTarget | null = renderer();
  Object.assign(main, {
    projects: new Map([[project.id, project]]), runtime: new Map([[worker.id, worker], [owner.id, owner]]), activityInputs: new Map(),
    workspaceOwners: new Map([[primary.id, project.id], [candidate.id, project.id]]),
    switchingProjects: new Set(), projectClosePromises: new Map(), disposed: false,
    activeProjectId: project.id, projectSelectionAction: 0, projectSelectionActionSeq: 0, projectActivationGeneration: 0,
    primaryWorkspace: (p: Project) => [...p.workspaces.values()].find((w) => w.primary),
    captureRendererSendTarget: () => target, agentNeedsLogin: vi.fn(async () => false),
    send: vi.fn(), persistOpenProjects: vi.fn(), canonicalPath: realpath, hasDanglingSymlink: async () => false,
    project: () => main.projects.get(main.activeProjectId), pathIndex: new ProjectPathIndex(), preferences: {},
    fileSearchSeq: new SearchGenerations(["quick-open", "filter"], "quick-open"),
    contentSearchSeq: new SearchGenerations(["quick-open", "explorer"], "quick-open"),
    acquireWriteLease: vi.fn(async (id: string, requester: string) => { project.workspaces.get(id)!.writerId = requester; return { ok: true }; }),
    releaseWriteLease: vi.fn((id: string) => { project.workspaces.get(id)!.writerId = null; }),
  });
  return { main, project, primary, candidate, worker, owner, replaceRenderer: () => { target = renderer(); } };
}
function pendingAuth(main: Harness) {
  const releases: Array<(value: boolean) => void> = [];
  main.agentNeedsLogin = vi.fn(() => new Promise<boolean>((resolve) => releases.push(resolve)));
  return releases;
}
const ref = (project: Project, workspace: Workspace): ProjectWorkspaceRef => ({ projectId: project.id, workspaceId: workspace.id });

describe("main canonical workspace selection", () => {
  it("coalesces repeated selection during auth and returns candidate root without changing source identity", async () => {
    const { main, project, primary, candidate, worker } = fixture();
    const releases = pendingAuth(main);
    const first = main.selectTerminal(worker.id, worker.generation);
    const second = main.selectTerminal(worker.id, worker.generation);
    expect(main.agentNeedsLogin).toHaveBeenCalledOnce();
    expect(main.projectActivationGeneration).toBe(1);
    expect(main.send).not.toHaveBeenCalled();
    releases[0]!(false);
    const result = await first;
    expect(await second).toEqual(result);
    expect(result).toEqual({ ok: true, folder: { cwd: candidate.root, projectRoot: primary.root, primaryWorkspaceId: primary.id, projectId: project.id, workspaceId: candidate.id, activationGeneration: 1, terminal: { id: worker.id, generation: worker.generation }, needsLogin: false } });
    expect(main.selectedTerminal()).toBe(worker);
    expect(project.cwd).toBe(primary.root);
    expect(primary.primary).toBe(true);
    expect(candidate.primary).toBe(false);
    expect(main.send).toHaveBeenCalledOnce();
    main.agentNeedsLogin = async () => false;
    expect((await main.activateProject(project.id))?.workspaceId).toBe(candidate.id);
  });

  it("supersedes pending candidate selection with a distinct workspace", async () => {
    const { main, worker, owner, primary } = fixture();
    const releases = pendingAuth(main);
    const old = main.selectTerminal(worker.id, worker.generation);
    const newer = main.selectTerminal(owner.id, owner.generation);
    releases[1]!(false);
    expect(await newer).toMatchObject({ ok: true, folder: { workspaceId: primary.id } });
    releases[0]!(false);
    expect(await old).toEqual({ ok: false });
    expect(main.selectedTerminal()).toBe(owner);
    expect(main.send).toHaveBeenCalledOnce();
  });

  it("does not fall back to source when the displayed candidate workspace disappears", async () => {
    const { main, project, candidate, worker } = fixture();
    expect((await main.selectTerminal(worker.id, worker.generation)).ok).toBe(true);
    main.send.mockClear();
    project.workspaces.delete(candidate.id);
    expect(await main.activateProject(project.id)).toBeNull();
    expect(main.send).not.toHaveBeenCalled();
    expect(main.selectedTerminal()).toBeNull();
  });

  it("does not reuse a pending activation after its actor closes, even for another actor in the same workspace", async () => {
    const { main, worker } = fixture();
    const releases = pendingAuth(main);
    const old = main.selectTerminal(worker.id, worker.generation);
    worker.closed = true;
    const replacement = { ...worker, id: "term-replacement", closed: false };
    main.runtime.set(replacement.id, replacement);
    const newer = main.selectTerminal(replacement.id, replacement.generation);
    expect(main.agentNeedsLogin).toHaveBeenCalledTimes(2);
    releases[0]!(false);
    expect(await old).toEqual({ ok: false });
    expect(main.send).not.toHaveBeenCalled();
    releases[1]!(false);
    expect(await newer).toMatchObject({ ok: true, folder: { workspaceId: worker.workspaceId } });
    expect(main.selectedTerminal()).toBe(replacement);
    expect(main.send).toHaveBeenCalledOnce();
  });

  it.each(["old-generation", "closed", "recycled", "switching", "disposed", "foreign-project"] as const)("refuses %s before auth", async (kind) => {
    const { main, worker, project } = fixture();
    if (kind === "closed") worker.closed = true;
    if (kind === "recycled") main.runtime.set(worker.id, { ...worker, generation: 8 });
    if (kind === "switching") main.switchingProjects.add(project.id);
    if (kind === "disposed") main.disposed = true;
    if (kind === "foreign-project") worker.projectId = "missing";
    expect(await main.selectTerminal(worker.id, kind === "old-generation" ? 6 : 7)).toEqual({ ok: false });
    expect(main.agentNeedsLogin).not.toHaveBeenCalled();
    expect(main.selectedTerminal()).toBeNull();
    expect(main.send).not.toHaveBeenCalled();
  });

  it.each(["removed-workspace", "replaced-workspace", "moved-root", "renderer-replaced", "closed", "recycled"] as const)("refuses %s during auth without publishing folder", async (kind) => {
    const state = fixture();
    const { main, project, candidate, worker } = state;
    const releases = pendingAuth(main);
    const selection = main.selectTerminal(worker.id, worker.generation);
    if (kind === "removed-workspace") project.workspaces.delete(candidate.id);
    if (kind === "replaced-workspace") project.workspaces.set(candidate.id, { ...candidate });
    if (kind === "moved-root") candidate.root = "/replacement";
    if (kind === "renderer-replaced") state.replaceRenderer();
    if (kind === "closed") worker.closed = true;
    if (kind === "recycled") main.runtime.set(worker.id, { ...worker, generation: 8 });
    releases[0]!(false);
    expect(await selection).toEqual({ ok: false });
    expect(main.send).not.toHaveBeenCalled();
    if (kind === "renderer-replaced" || kind === "closed" || kind === "recycled") expect(main.selectedTerminal()).toBeNull();
  });
});

function intervention(main: Harness, terminal: Terminal, since: number): void {
  main.activityInputs.set(terminal.id, { ...emptyActivityInput(),
    intervention: { requestId: `approval-${terminal.id}`, kind: "permission", since } });
}
const enter = (main: Harness, project: Project) => main.activateProject(project.id, undefined, undefined, undefined, undefined, "entry");

describe("main terminal-first project entry", () => {
  it("selects the oldest real permission across workspaces, but explicit tabs still open exactly their target", async () => {
    const { main, project, owner, worker, candidate, primary } = fixture();
    await main.selectTerminal(owner.id, owner.generation);
    intervention(main, owner, 2000); intervention(main, worker, 1000);
    expect(await enter(main, project)).toMatchObject({ cwd: candidate.root, workspaceId: candidate.id,
      terminal: { id: worker.id, generation: worker.generation } });
    expect(main.selectedTerminal()).toBe(worker);
    expect((await main.selectTerminal(owner.id, owner.generation))).toMatchObject({ ok: true,
      folder: { workspaceId: primary.id, terminal: { id: owner.id, generation: owner.generation } } });
    expect(main.selectedTerminal()).toBe(owner);
  });

  it("restores the remembered terminal rather than any non-human blocked state", async () => {
    const { main, project, owner, worker } = fixture();
    await main.selectTerminal(owner.id, owner.generation);
    main.activityInputs.set(worker.id, { ...emptyActivityInput(), lastBoundary: "agent_start", errorStreak: 3, errorStreakTarget: "failed-tool" });
    expect((await enter(main, project))?.terminal?.id).toBe(owner.id);
    expect(main.selectedTerminal()).toBe(owner);
  });

  it("uses current permissions after auth, not a resolved permission observed when entry started", async () => {
    const { main, project, owner, worker } = fixture();
    await main.selectTerminal(owner.id, owner.generation);
    intervention(main, worker, 1000);
    const releases = pendingAuth(main);
    const pending = enter(main, project);
    main.activityInputs.get(worker.id)!.intervention = null;
    releases[0]!(false);
    expect((await pending)?.terminal?.id).toBe(owner.id);
  });

  it("includes a newly requested permission before admission but never changes selection just for a notification", async () => {
    const { main, project, owner, worker } = fixture();
    await main.selectTerminal(owner.id, owner.generation);
    const before = main.send.mock.calls.length;
    intervention(main, worker, 1000);
    expect(main.selectedTerminal()).toBe(owner);
    expect(main.send.mock.calls).toHaveLength(before);
    const releases = pendingAuth(main); const pending = enter(main, project);
    intervention(main, owner, 500);
    releases[0]!(false);
    expect((await pending)?.terminal?.id).toBe(owner.id);
  });

  it.each(["closed", "exited", "missing workspace", "foreign project", "shell"] as const)("does not prioritize an unavailable %s permission", async (reason) => {
    const { main, project, owner, worker, candidate } = fixture();
    await main.selectTerminal(owner.id, owner.generation);
    intervention(main, worker, 1000);
    if (reason === "closed") worker.closed = true;
    if (reason === "exited") worker.pty = { hasExited: true };
    if (reason === "missing workspace") project.workspaces.delete(candidate.id);
    if (reason === "foreign project") worker.projectId = "another";
    if (reason === "shell") worker.type = "shell";
    expect((await enter(main, project))?.terminal?.id).toBe(owner.id);
  });

  it("breaks equal ages by stable terminal order, not recency", async () => {
    const { main, project, owner, worker } = fixture();
    await main.selectTerminal(owner.id, owner.generation);
    intervention(main, owner, 1000); intervention(main, worker, 1000);
    expect((await enter(main, project))?.terminal?.id).toBe(worker.id);
  });

  it("falls back from a recycled remembered generation to the first available terminal", async () => {
    const { main, project, owner, worker } = fixture();
    await main.selectTerminal(owner.id, owner.generation);
    main.runtime.set(owner.id, { ...owner, generation: 8 });
    expect((await enter(main, project))?.terminal?.id).toBe(worker.id);
  });

  it("publishes an empty project without creating a terminal", async () => {
    const { main, project, primary } = fixture(); main.runtime.clear();
    expect(await enter(main, project)).toMatchObject({ workspaceId: primary.id, terminal: null });
    expect(main.selectedTerminal()).toBeNull();
    expect(main.runtime.size).toBe(0);
  });

  it("does not let a late entry override a newer explicit terminal selection", async () => {
    const { main, project, owner, worker } = fixture();
    intervention(main, worker, 1000);
    const releases = pendingAuth(main);
    const old = enter(main, project);
    const newer = main.selectTerminal(owner.id, owner.generation);
    releases[1]!(false); expect((await newer).ok).toBe(true);
    releases[0]!(false); expect(await old).toBeNull();
    expect(main.selectedTerminal()).toBe(owner); expect(main.send).toHaveBeenCalledOnce();
  });
});

describe("main search follows the displayed workspace", () => {
  it("searches candidate files and bytes, returns to source explicitly, and never falls back from a missing candidate", async () => {
    const { main, project, primary, candidate, worker, owner } = fixture();
    const root = await mkdtemp(join(tmpdir(), "termina-workspace-search-"));
    try {
      primary.root = join(root, "source"); candidate.root = join(root, "candidate"); project.cwd = primary.root;
      await mkdir(primary.root); await mkdir(candidate.root);
      await writeFile(join(primary.root, "source.txt"), "source-only content");
      await writeFile(join(candidate.root, "candidate.txt"), "candidate-only content");
      await main.selectTerminal(worker.id, worker.generation);
      expect((await main.searchProjectFiles("", "quick-open")).entries.map((entry) => entry.relPath)).toEqual(["candidate.txt"]);
      expect((await main.searchProjectContent("candidate-only", "quick-open")).hits.map((hit) => hit.relPath)).toEqual(["candidate.txt"]);
      expect((await main.searchProjectContent("source-only", "explorer")).hits).toEqual([]);
      await main.selectTerminal(owner.id, owner.generation);
      expect((await main.searchProjectFiles("", "filter")).entries.map((entry) => entry.relPath)).toEqual(["source.txt"]);
      expect((await main.searchProjectContent("source-only", "explorer")).hits.map((hit) => hit.relPath)).toEqual(["source.txt"]);
      await main.selectTerminal(worker.id, worker.generation);
      project.workspaces.delete(candidate.id);
      expect((await main.searchProjectFiles("", "quick-open")).entries).toEqual([]);
      expect((await main.searchProjectContent("source-only", "quick-open")).hits).toEqual([]);
      expect(project.cwd).toBe(primary.root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["files", "content"] as const)("discards a stale %s search when its displayed workspace changes", async (kind) => {
    const { main, worker, owner, candidate } = fixture();
    await main.selectTerminal(worker.id, worker.generation);
    let release!: (root: string) => void;
    main.canonicalPath = () => new Promise<string>((resolve) => { release = resolve; });
    const pending = kind === "files" ? main.searchProjectFiles("hello", "quick-open") : main.searchProjectContent("hello", "quick-open");
    await main.selectTerminal(owner.id, owner.generation);
    release(candidate.root);
    expect(await pending).toEqual(kind === "files" ? { entries: [] } : { hits: [] });
  });
});

describe("main explicit explorer workspace ownership", () => {
  it("reads candidate and source independently and rejects cross-root paths", async () => {
    const { main, project, primary, candidate } = fixture();
    const root = await mkdtemp(join(tmpdir(), "termina-workspace-selection-"));
    try {
      primary.root = join(root, "source"); candidate.root = join(root, "candidate");
      await mkdir(primary.root); await mkdir(candidate.root);
      await writeFile(join(primary.root, "source.txt"), "source");
      await writeFile(join(candidate.root, "candidate.txt"), "candidate");
      expect((await main.listDir(ref(project, primary), primary.root)).entries.map((entry) => entry.name)).toEqual(["source.txt"]);
      expect((await main.listDir(ref(project, candidate), candidate.root)).entries.map((entry) => entry.name)).toEqual(["candidate.txt"]);
      expect(await main.listDir(ref(project, primary), candidate.root)).toMatchObject({ entries: [], error: "path outside the project workspace" });
      expect(await main.listDir(ref(project, candidate), primary.root)).toMatchObject({ entries: [], error: "path outside the project workspace" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([null, "project", {}, { projectId: "missing", workspaceId: "candidate" }, { projectId: "project", workspaceId: "missing" }])("rejects invalid owner %j before filesystem access", async (owner) => {
    const { main } = fixture();
    expect(await main.listDir(owner, "/not-read")).toMatchObject({ entries: [], error: "invalid project workspace" });
  });

  it.each(["mismatched", "closed", "switching"] as const)("rejects %s explorer ownership", async (kind) => {
    const { main, project, candidate } = fixture();
    if (kind === "mismatched") main.workspaceOwners.set(candidate.id, "other");
    if (kind === "closed") main.projects.delete(project.id);
    if (kind === "switching") main.switchingProjects.add(project.id);
    expect((await main.listDir(ref(project, candidate), "/not-read")).error).toBeDefined();
  });

  it("refuses candidate mutations before leasing or callback and retains source lease lifecycle", async () => {
    const { main, project, candidate, primary } = fixture();
    const mutation = vi.fn(async (workspace: Workspace, live: () => boolean) => { expect(workspace).toBe(primary); expect(live()).toBe(true); return { ok: true }; });
    expect(await main.mutateExplorer(ref(project, candidate), mutation)).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    expect(main.acquireWriteLease).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
    expect(await main.mutateExplorer(ref(project, primary), mutation)).toEqual({ ok: true });
    expect(main.acquireWriteLease).toHaveBeenCalledWith(primary.id, expect.stringContaining(`explorer:${project.id}:`), 5000);
    expect(mutation).toHaveBeenCalledOnce();
    expect(main.releaseWriteLease).toHaveBeenCalledWith(primary.id, expect.any(String));
    expect(primary.writerId).toBeNull();
  });
});
