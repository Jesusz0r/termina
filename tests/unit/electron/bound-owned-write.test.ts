import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundPromotionOpenDirectory, disposeWorldlineGitCore, writeBoundOwnedFile } from "../../../electron/worldline-git.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const roots: string[] = [];

async function fixture(content = "stable context", mode = 0o600) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "termina-bound-owned-write-")));
  roots.push(root);
  const path = join(root, "context.md");
  await writeFile(path, content, { mode });
  const binding = await boundPromotionOpenDirectory({ path: root });
  return {
    root, path,
    options: {
      root, rootIdentity: binding, parentIdentity: binding, components: ["context.md"],
      content: Buffer.from(content), maxBytes: 1024, skipIfUnchanged: true,
    },
  };
}

afterAll(async () => {
  const closed = vi.mocked(spawn).mock.results.flatMap((result) => {
    if (result.type !== "return") return [];
    const child = result.value;
    if (child.exitCode !== null || child.signalCode !== null) return [];
    return [new Promise<void>((resolve) => child.once("close", () => resolve()))];
  });
  disposeWorldlineGitCore();
  await Promise.all(closed);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("unchanged bound-owned context writes", () => {
  it.each(["stable context", "", "診断 🧪"])("preserves identical content, identity, and mtime: %j", async (content) => {
    const { path, options } = await fixture(content);
    await utimes(path, new Date(1_000), new Date(1_000));
    const before = await lstat(path);
    const result = await writeBoundOwnedFile(options);
    const after = await lstat(path);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path)).toEqual(options.content);
    expect(result.identity.ino).toBe(String(before.ino));
  });

  it.each([undefined, 0o600])("applies the requested mode even when content is identical: %s", async (mode) => {
    const { path, options } = await fixture("private but executable", 0o700);
    const result = await writeBoundOwnedFile({ ...options, mode });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(result.state).toMatchObject({ type: "file", mode: 0o600 });
    expect(await readFile(path)).toEqual(options.content);
  });

  it("rejects an invalid requested mode instead of skipping validation", async () => {
    const { path, options } = await fixture();
    await expect(writeBoundOwnedFile({ ...options, mode: -1 })).rejects.toThrow(/mode/);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("writes changed content and creates missing leaves", async () => {
    const { path, options } = await fixture();
    await writeBoundOwnedFile({ ...options, content: Buffer.from("changed") });
    expect(await readFile(path, "utf8")).toBe("changed");
    await rm(path);
    await writeBoundOwnedFile(options);
    expect(await readFile(path)).toEqual(options.content);
  });

  it("keeps unconditional writes unconditional", async () => {
    const { path, options } = await fixture();
    await utimes(path, new Date(1_000), new Date(1_000));
    await writeBoundOwnedFile({ ...options, skipIfUnchanged: false });
    expect((await lstat(path)).mtimeMs).not.toBe(1_000);
  });

  it("repairs a non-private leaf instead of skipping its validation", async () => {
    const { path, options } = await fixture();
    await chmod(path, 0o644);
    await writeBoundOwnedFile(options);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path)).toEqual(options.content);
  });

  it("rejects a replaced root even when the replacement has identical content", async () => {
    const { root, options } = await fixture();
    const parked = `${root}-parked`;
    roots.push(parked);
    await rename(root, parked);
    await mkdir(root);
    await writeFile(join(root, "context.md"), options.content, { mode: 0o600 });
    await expect(writeBoundOwnedFile(options)).rejects.toThrow(/identity/);
    expect(await readFile(join(parked, "context.md"))).toEqual(options.content);
    expect(await readFile(join(root, "context.md"))).toEqual(options.content);
  });

  it("does not follow a symlink to identical content outside the bound root", async () => {
    const { root, path, options } = await fixture();
    const outside = `${root}-outside`;
    roots.push(outside);
    await writeFile(outside, options.content, { mode: 0o600 });
    await rm(path);
    await symlink(outside, path);
    await expect(writeBoundOwnedFile(options)).rejects.toThrow();
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside)).toEqual(options.content);
  });
});
