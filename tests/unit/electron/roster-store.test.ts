import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TerminalRosterStore, loadRosterFile, type RosterTerminal } from "../../../electron/roster-store.ts";
import { syncParentDir } from "../../../shared/fsync.ts";

/**
 * Crash-consistency for TerminalRosterStore.save, asserted against the real
 * store (not a source-string pin):
 * 1. handle.sync() precedes rename: the temp's bytes are durable before the
 *    directory entry flips, so a crash after rename always finds complete JSON.
 * 2. syncParentDir(path) follows rename: the new directory entry itself is
 *    durable, so restart recovery cannot miss the commit.
 * 3. One rename flips the entry atomically: readers see the old roster or the
 *    new roster, never a torn write.
 */

const probes = vi.hoisted(() => ({
  events: [] as string[],
  openArgs: [] as Array<{ path: string; flags: unknown; mode: unknown }>,
  openError: null as Error | null,
  renameError: null as Error | null,
  parentSyncError: null as Error | null,
}));

vi.mock("../../../shared/fsync.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/fsync.ts")>();
  return {
    ...actual,
    syncParentDir: vi.fn((path: string) => {
      probes.events.push("syncParentDir");
      if (probes.parentSyncError) throw probes.parentSyncError;
      return actual.syncParentDir(path);
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const [path, flags, mode] = args;
      probes.openArgs.push({ path: String(path), flags, mode });
      if (probes.openError) throw probes.openError;
      const handle = await actual.open(...args);
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        probes.events.push("sync");
        return originalSync();
      };
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      probes.events.push("rename");
      if (probes.renameError) throw probes.renameError;
      return actual.rename(...args);
    },
  };
});

function agent(id: string, model = "anthropic/claude-opus-4-6"): RosterTerminal {
  return {
    id,
    type: "agent",
    sessionId: null,
    sessionFile: null,
    model,
    plan: [],
    verify: { state: "untested", command: null, summary: null },
  };
}

function openStore(): TerminalRosterStore {
  return new TerminalRosterStore({ usableModel: (model) => model ?? null });
}

describe("TerminalRosterStore durable save", () => {
  let root = "";
  let filePath = "";

  afterEach(async () => {
    probes.events.length = 0;
    probes.openArgs.length = 0;
    probes.openError = null;
    probes.renameError = null;
    probes.parentSyncError = null;
    vi.mocked(syncParentDir).mockClear();
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
    filePath = "";
  });

  async function preparePath(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), "termina-roster-"));
    filePath = join(root, "terminal-rosters", "session.json");
    return filePath;
  }

  it("fsyncs the temp file, renames, then fsyncs the parent dir, in order", async () => {
    const path = await preparePath();
    const store = openStore();
    store.save(path, [agent("term-1")], []);
    await store.drain();

    expect(probes.events).toEqual(["sync", "rename", "syncParentDir"]);
    expect(probes.openArgs).toHaveLength(1);
    expect(probes.openArgs[0]?.flags).toBe("wx");
    expect(probes.openArgs[0]?.mode).toBe(0o600);
    expect(dirname(probes.openArgs[0]!.path)).toBe(dirname(path));
    expect(probes.openArgs[0]!.path.startsWith(`${path}.`)).toBe(true);
    expect(probes.openArgs[0]!.path.endsWith(".tmp")).toBe(true);
    expect(vi.mocked(syncParentDir)).toHaveBeenCalledWith(path);
  });

  it("writes a complete roster, preserves modes, and leaves no temp behind", async () => {
    const path = await preparePath();
    const store = openStore();
    store.save(path, [agent("term-1")], []);
    await store.drain();

    const loaded = await loadRosterFile(path);
    expect(loaded).toEqual({
      exists: true,
      entries: [{ id: "term-1", type: "agent", engine: "core", model: "anthropic/claude-opus-4-6" }],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(path))).toEqual(["session.json"]);
    expect(await readFile(path, "utf8")).toMatch(/}\n$/);
  });

  it("replaces an existing roster with complete new JSON, never a mix", async () => {
    const path = await preparePath();
    const store = openStore();
    store.save(path, [agent("term-1")], []);
    await store.drain();
    probes.events.length = 0;
    probes.openArgs.length = 0;

    store.save(path, [agent("term-2")], []);
    await store.drain();

    expect(probes.events).toEqual(["sync", "rename", "syncParentDir"]);
    const loaded = await loadRosterFile(path);
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["term-2"]);
    expect(readdirSync(dirname(path))).toEqual(["session.json"]);
  });

  it("chains per-roster commits so the last save wins", async () => {
    const path = await preparePath();
    const store = openStore();
    store.save(path, [agent("term-1")], []);
    store.save(path, [agent("term-1"), agent("term-2")], []);
    await store.drain();

    const loaded = await loadRosterFile(path);
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["term-1", "term-2"]);
  });

  it("cleans the temp file and keeps the old roster when rename fails", async () => {
    const path = await preparePath();
    const store = openStore();
    store.save(path, [agent("term-1")], []);
    await store.drain();
    probes.events.length = 0;
    probes.openArgs.length = 0;
    vi.mocked(syncParentDir).mockClear();
    probes.renameError = new Error("rename blew up");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    store.save(path, [agent("term-2")], []);
    await store.drain();

    expect(probes.events).toEqual(["sync", "rename"]);
    expect(vi.mocked(syncParentDir)).not.toHaveBeenCalled();
    expect(readdirSync(dirname(path))).toEqual(["session.json"]);
    const loaded = await loadRosterFile(path);
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["term-1"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not save terminal roster"));
    warn.mockRestore();
  });

  it("renames nothing when the temp cannot be created", async () => {
    const path = await preparePath();
    const store = openStore();
    store.save(path, [agent("term-1")], []);
    await store.drain();
    probes.events.length = 0;
    probes.openArgs.length = 0;
    vi.mocked(syncParentDir).mockClear();
    probes.openError = new Error("EACCES");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    store.save(path, [agent("term-2")], []);
    await store.drain();

    expect(probes.events).toEqual([]);
    expect(probes.openArgs[0]).toMatchObject({ flags: "wx", mode: 0o600 });
    expect(vi.mocked(syncParentDir)).not.toHaveBeenCalled();
    const loaded = await loadRosterFile(path);
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["term-1"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not save terminal roster"));
    warn.mockRestore();
  });

  it("keeps the renamed roster when parent sync fails after a successful rename", async () => {
    const path = await preparePath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify({ terminals: [{ id: "term-1", type: "agent", engine: "core" }] })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const store = openStore();
    probes.parentSyncError = new Error("parent sync failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store.save(path, [agent("term-2")], []);
    await store.drain();

    expect(probes.events).toEqual(["sync", "rename", "syncParentDir"]);
    const loaded = await loadRosterFile(path);
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["term-2"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not save terminal roster"));
    warn.mockRestore();
  });
});
