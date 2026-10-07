import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorDraftStore, MAX_EDITOR_DRAFT_BYTES, MAX_EDITOR_DRAFTS } from "../../../electron/editor-drafts.ts";
import { durableAtomicWrite } from "../../../shared/durable-write.ts";
import { syncDirectoryAsync } from "../../../shared/fsync.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), opendir: vi.fn(actual.opendir), lstat: vi.fn(actual.lstat) };
});

vi.mock("../../../shared/durable-write.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/durable-write.ts")>();
  return { ...actual, durableAtomicWrite: vi.fn(actual.durableAtomicWrite) };
});
vi.mock("../../../shared/fsync.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/fsync.ts")>();
  return { ...actual, syncDirectoryAsync: vi.fn(actual.syncDirectoryAsync) };
});

const root = "/project";
const path = "/project/file.ts";
let temporary = "";
let directory = "";
let store: EditorDraftStore;

function recordPath(project = root, file = path): string {
  return join(directory, `${createHash("sha256").update(`${project}\0${file}`).digest("hex")}.json`);
}

beforeEach(async () => {
  vi.clearAllMocks();
  temporary = await mkdtemp(join(tmpdir(), "termina-editor-drafts-"));
  directory = join(temporary, "private", "drafts");
  store = new EditorDraftStore(directory);
});

afterEach(async () => {
  await store.flush().catch(() => undefined);
  vi.mocked(durableAtomicWrite).mockReset();
  const actual = await vi.importActual<typeof import("../../../shared/durable-write.ts")>("../../../shared/durable-write.ts");
  vi.mocked(durableAtomicWrite).mockImplementation(actual.durableAtomicWrite);
  await rm(temporary, { recursive: true, force: true });
});

describe("EditorDraftStore", () => {
  it("recovers complete drafts in a new instance without reading or saving project files", async () => {
    expect(await store.get(root, path)).toBeNull();
    expect(await store.list(root)).toEqual({ paths: [], unreadable: 0 });
    await store.put(root, path, "unsaved π\n");
    const recovered = new EditorDraftStore(directory);
    expect(await recovered.get(root, path)).toEqual({ root, path, content: "unsaved π\n" });
    expect(await recovered.list(root)).toEqual({ paths: [path], unreadable: 0 });
    expect(await readdir(directory)).toEqual([recordPath().split("/").at(-1)]);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(recordPath())).mode & 0o777).toBe(0o600);
    expect(vi.mocked(syncDirectoryAsync)).toHaveBeenCalledWith(temporary);
    expect(vi.mocked(syncDirectoryAsync)).toHaveBeenCalledWith(join(temporary, "private"));
  });

  it("scopes get and path-only lists by root, even for the same absolute file", async () => {
    await store.put(root, path, "one");
    await store.put("/other-project", path, "two");
    expect(await store.get("/other-project", path)).toEqual({ root: "/other-project", path, content: "two" });
    expect(await store.list(root)).toEqual({ paths: [path], unreadable: 0 });
    expect(await store.list("/other-project")).toEqual({ paths: [path], unreadable: 0 });
    expect(await store.list("/missing-project")).toEqual({ paths: [], unreadable: 0 });
  });

  it("coalesces synchronous edits into one durable batch and waits for it in get/list", async () => {
    const writes = [store.put(root, path, "one"), store.put(root, path, "two"), store.put(root, path, "three")];
    expect(writes[0]).toBe(writes[1]);
    expect(writes[1]).toBe(writes[2]);
    const listed = store.list(root);
    expect(await store.get(root, path)).toEqual({ root, path, content: "three" });
    expect(await listed).toEqual({ paths: [path], unreadable: 0 });
    await Promise.all(writes);
    expect(durableAtomicWrite).toHaveBeenCalledTimes(1);
  });

  it("settles each batch only after durability, and orders a queued removal after an active edit", async () => {
    const actual = await vi.importActual<typeof import("../../../shared/durable-write.ts")>("../../../shared/durable-write.ts");
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(durableAtomicWrite).mockImplementationOnce(async (file, content) => {
      started();
      await blocked;
      await actual.durableAtomicWrite(file, content);
    });
    let settled = false;
    const first = store.put(root, path, "active").then(() => { settled = true; });
    await entered;
    const queued = store.put(root, path, "pending");
    const removed = store.put(root, path, null);
    expect(queued).toBe(removed);
    const flushed = store.flush();
    expect(settled).toBe(false);
    release();
    await Promise.all([first, queued, removed, flushed]);
    expect(durableAtomicWrite).toHaveBeenCalledTimes(1);
    expect(await store.get(root, path)).toBeNull();
    expect(await readdir(directory)).toEqual([]);
    expect(vi.mocked(syncDirectoryAsync)).toHaveBeenLastCalledWith(directory);
  });

  it.each([
    ["invalid JSON", "{broken"],
    ["wrong shape", JSON.stringify({ root, path, content: 123 })],
    ["wrong key", JSON.stringify({ root, path: "/project/other.ts", content: "keep" })],
  ])("refuses %s without overwriting or deleting recovery data", async (_label, bytes) => {
    await mkdir(directory, { recursive: true });
    await writeFile(recordPath(), bytes);
    await expect(store.get(root, path)).rejects.toThrow(/draft/i);
    await expect(store.list(root)).resolves.toEqual({ paths: [], unreadable: 1 });
    await expect(store.put(root, path, "replacement")).rejects.toThrow(/draft/i);
    await expect(store.put(root, path, null)).rejects.toThrow(/draft/i);
    expect(await readFile(recordPath(), "utf8")).toBe(bytes);
    await store.put(root, "/project/good.ts", "good");
    expect((await store.get(root, "/project/good.ts"))?.content).toBe("good");
    expect(await store.list(root)).toEqual({ paths: ["/project/good.ts"], unreadable: 1 });
    expect(await readFile(recordPath(), "utf8")).toBe(bytes);
  });

  it("enforces UTF-8 content limits both before queueing and when recovering disk data", async () => {
    const boundary = "π".repeat(MAX_EDITOR_DRAFT_BYTES / 2);
    await store.put(root, path, boundary);
    expect((await store.get(root, path))?.content).toBe(boundary);
    await expect(store.put(root, path, `${boundary}π`)).rejects.toThrow(/large|limit/i);
    expect((await store.get(root, path))?.content).toBe(boundary);
    const oversized = JSON.stringify({ root, path, content: "x".repeat(MAX_EDITOR_DRAFT_BYTES + 1) });
    await writeFile(recordPath(), oversized);
    await expect(store.get(root, path)).rejects.toThrow(/large|limit/i);
    await expect(store.put(root, path, "replacement")).rejects.toThrow(/large|limit/i);
    expect(await readFile(recordPath(), "utf8")).toBe(oversized);
  });

  it("rejects an oversized physical record before reading its body", async () => {
    await mkdir(directory, { recursive: true });
    const handle = await open(recordPath(), "w");
    await handle.truncate(MAX_EDITOR_DRAFT_BYTES * 6 + 64 * 1024 + 1);
    await handle.close();
    const size = (await lstat(recordPath())).size;
    await expect(store.get(root, path)).rejects.toThrow(/large|limit/i);
    await expect(store.put(root, path, null)).rejects.toThrow(/large|limit/i);
    expect((await lstat(recordPath())).size).toBe(size);
  });

  it("supports worst-case JSON escaping within the content byte cap", async () => {
    const content = "\0".repeat(MAX_EDITOR_DRAFT_BYTES);
    await store.put(root, path, content);
    expect((await new EditorDraftStore(directory).get(root, path))?.content).toBe(content);
  });

  it("caps persisted drafts globally at 64 without evicting recovery copies", async () => {
    for (let index = 0; index < MAX_EDITOR_DRAFTS; index++) {
      await store.put(root, `/project/${index}.ts`, String(index));
    }
    await expect(store.put("/other", "/other/new.ts", "new")).rejects.toThrow(/64|limit/i);
    expect((await store.list(root)).paths).toHaveLength(MAX_EDITOR_DRAFTS);
    await store.put(root, "/project/0.ts", "updated");
    await store.put(root, "/project/1.ts", null);
    await store.put("/other", "/other/new.ts", "new");
    expect(await store.list("/other")).toEqual({ paths: ["/other/new.ts"], unreadable: 0 });
  });

  it("bounds the pending record queue and still accepts a replacement for an already pending key", async () => {
    const pending: Promise<void>[] = [];
    for (let index = 0; index < MAX_EDITOR_DRAFTS; index++) {
      pending.push(store.put(root, `/project/${index}.ts`, String(index)));
    }
    const rejected = store.put(root, "/project/overflow.ts", "overflow");
    await expect(rejected).rejects.toThrow(/queue|limit/i);
    pending.push(store.put(root, "/project/63.ts", "latest"));
    await Promise.all(pending);
    expect((await store.get(root, "/project/63.ts"))?.content).toBe("latest");
  });

  it("refuses symlink records without touching their outside target", async () => {
    await mkdir(directory, { recursive: true });
    const outside = join(temporary, "outside.json");
    const bytes = JSON.stringify({ root, path, content: "outside" });
    await writeFile(outside, bytes);
    await symlink(outside, recordPath());
    await expect(store.get(root, path)).rejects.toThrow(/symlink|regular/i);
    await expect(store.list(root)).resolves.toEqual({ paths: [], unreadable: 1 });
    await expect(store.put(root, path, "replacement")).rejects.toThrow(/symlink|regular/i);
    await expect(store.put(root, path, null)).rejects.toThrow(/symlink|regular/i);
    expect(await readFile(outside, "utf8")).toBe(bytes);
    expect((await lstat(recordPath())).isSymbolicLink()).toBe(true);
  });

  it("refuses hard-linked records without reading or replacing their outside recovery data", async () => {
    await mkdir(directory, { recursive: true });
    const outside = join(temporary, "outside.json");
    const bytes = JSON.stringify({ root, path, content: "outside" });
    await writeFile(outside, bytes);
    await link(outside, recordPath());
    await expect(store.get(root, path)).rejects.toThrow(/hard link|private/i);
    await expect(store.put(root, path, "no")).rejects.toThrow(/hard link|private/i);
    expect(await readFile(outside, "utf8")).toBe(bytes);
    expect((await lstat(recordPath())).nlink).toBe(2);
  });

  it("refuses a symlink store directory", async () => {
    const outside = join(temporary, "outside");
    await mkdir(outside);
    await mkdir(join(temporary, "private"));
    await symlink(outside, directory);
    await expect(store.put(root, path, "no")).rejects.toThrow(/directory|symlink/i);
    await expect(store.get(root, path)).rejects.toThrow(/directory|symlink/i);
    await expect(store.list(root)).rejects.toThrow(/directory|symlink/i);
    expect(await readdir(outside)).toEqual([]);
  });

  it("reports write and flush failures but continues other queued records", async () => {
    vi.mocked(durableAtomicWrite).mockRejectedValueOnce(new Error("ENOSPC: no space left"));
    const failed = store.put(root, path, "failed");
    const good = store.put(root, "/project/good.ts", "good");
    const flushed = store.flush();
    await expect(failed).rejects.toThrow(/ENOSPC/);
    await expect(flushed).rejects.toThrow(/ENOSPC/);
    await good;
    expect(await store.get(root, path)).toBeNull();
    expect((await store.get(root, "/project/good.ts"))?.content).toBe("good");
    await store.put(root, path, "retry");
    expect((await store.get(root, path))?.content).toBe("retry");
  });

  it("keeps the previous draft and cleans temporary files when atomic rename fails", async () => {
    await store.put(root, path, "previous");
    vi.mocked(rename).mockRejectedValueOnce(new Error("EACCES: rename denied"));
    await expect(store.put(root, path, "replacement")).rejects.toThrow(/EACCES/);
    expect((await store.get(root, path))?.content).toBe("previous");
    expect(await readdir(directory)).toEqual([recordPath().split("/").at(-1)]);
    await store.put(root, path, "retry");
    expect((await store.get(root, path))?.content).toBe("retry");
  });

  it("retries failed parent creation syncs before accepting another durable record", async () => {
    vi.mocked(syncDirectoryAsync).mockRejectedValueOnce(new Error("EIO: parent sync failed"));
    const failed = store.put(root, path, "failed");
    const good = store.put(root, "/project/good.ts", "good");
    await expect(failed).rejects.toThrow(/EIO/);
    await good;
    expect(vi.mocked(syncDirectoryAsync).mock.calls.map(([synced]) => synced)).toEqual([
      join(temporary, "private"),
      join(temporary, "private"),
      temporary,
      directory,
    ]);
    expect((await store.get(root, "/project/good.ts"))?.content).toBe("good");
  });

  it("rejects a removal whose directory sync fails, and synchronizes an absent record on retry", async () => {
    await store.put(root, path, "remove me");
    vi.mocked(syncDirectoryAsync).mockRejectedValueOnce(new Error("EIO: directory sync failed"));
    await expect(store.put(root, path, null)).rejects.toThrow(/EIO/);
    expect(await readdir(directory)).toEqual([]);
    await store.put(root, path, null);
    expect(vi.mocked(syncDirectoryAsync)).toHaveBeenLastCalledWith(directory);
    expect(await store.get(root, path)).toBeNull();
  });

  it("propagates directory inspection and enumeration failures", async () => {
    await store.put(root, path, "keep");
    vi.mocked(lstat).mockRejectedValueOnce(new Error("EACCES: directory inspection denied"));
    await expect(store.list(root)).rejects.toThrow(/EACCES/);
    vi.mocked(opendir).mockRejectedValueOnce(new Error("EIO: directory enumeration failed"));
    await expect(store.list(root)).rejects.toThrow(/EIO/);
    expect(await store.list(root)).toEqual({ paths: [path], unreadable: 0 });
  });

  it("rejects invalid storage keys during enumeration without deleting them", async () => {
    await store.put(root, path, "keep");
    const invalid = join(directory, "invalid.json");
    await writeFile(invalid, "preserve");
    await expect(store.list(root)).rejects.toThrow(/invalid storage key/);
    expect(await readFile(invalid, "utf8")).toBe("preserve");
  });

  it("surfaces filesystem errors rather than treating an unusable directory as an empty store", async () => {
    await mkdir(join(temporary, "private"));
    await writeFile(directory, "not a directory");
    await expect(store.get(root, path)).rejects.toThrow(/directory/i);
    await expect(store.list(root)).rejects.toThrow(/directory/i);
    await expect(store.put(root, path, "no")).rejects.toThrow();
    expect(await readFile(directory, "utf8")).toBe("not a directory");
  });
});
