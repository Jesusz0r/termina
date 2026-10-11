import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { boundPromotionInspectPrivateFile, boundPromotionOpenDirectory, boundPromotionReadFile, disposeWorldlineGitCore } from "../../../electron/worldline-git.ts";
import { copyBoundPrivateFile } from "../../../electron/worldlines/promotion-recovery/bound-dirs.ts";
import { MAX_AGENT_RESOURCE_BYTES } from "../../../electron/worldlines/limits.ts";
import { MAX_MCP_JSON_BYTES } from "../../../agent-core/mcp.ts";

// Observe lifecycle only; every native request uses the actual core binary.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const roots: string[] = [];

async function fixture(name: string, content: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "termina-bound-private-copy-")));
  roots.push(root);
  const sourceDir = join(root, "source");
  const destinationDir = join(root, "destination");
  await mkdir(sourceDir, { mode: 0o700 });
  await mkdir(destinationDir, { mode: 0o700 });
  const source = join(sourceDir, name);
  await writeFile(source, content, { mode: 0o600 });
  const identity = await boundPromotionOpenDirectory({ path: destinationDir });
  return { source, destination: { path: destinationDir, ...identity }, target: join(destinationDir, name) };
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

async function inspectionOptions(source: string, maxBytes: number) {
  const parent = dirname(source);
  const identity = await boundPromotionOpenDirectory({ path: parent });
  const info = await lstat(source, { bigint: true });
  return {
    root: parent, rootIdentity: identity, parentIdentity: identity,
    components: [basename(source)],
    expectedIdentity: { dev: String(info.dev), ino: String(info.ino) }, maxBytes,
  };
}

describe("private resource copies through the real native boundary", () => {
  it.each([
    ["auth.json", '{"openai":{"type":"api_key","key":"synthetic-copy-token"}}\n', MAX_AGENT_RESOURCE_BYTES],
    ["mcp.json", '{"mcpServers":{"fixture":{"command":"node","disabled":true}}}\n', MAX_MCP_JSON_BYTES],
  ] as const)("copies a small %s without requesting the journal read budget", async (name, content, maxBytes) => {
    const { source, destination, target } = await fixture(name, content);
    const before = await lstat(source);
    await copyBoundPrivateFile(source, destination, name, maxBytes);
    expect(await readFile(target, "utf8")).toBe(content);
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    expect(await readFile(source, "utf8")).toBe(content);
    const after = await lstat(source);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("returns only the native identity and content proof, never private bytes", async () => {
    const content = '{"synthetic":"private bytes"}\n';
    const { source } = await fixture("auth.json", content);
    const options = await inspectionOptions(source, MAX_AGENT_RESOURCE_BYTES);
    const observed = await boundPromotionInspectPrivateFile(options);
    expect(observed).toEqual({
      identity: options.expectedIdentity,
      state: { type: "file", mode: 0o600, size: String(Buffer.byteLength(content)), sha256: createHash("sha256").update(content).digest("hex") },
    });
  });

  it("copies auth resources above 16 MiB without widening the byte-returning reader", async () => {
    const content = `{"synthetic":"${"x".repeat(17 * 1024 * 1024)}"}`;
    const { source, destination, target } = await fixture("auth.json", content);
    await copyBoundPrivateFile(source, destination, "auth.json", MAX_AGENT_RESOURCE_BYTES);
    expect(await readFile(target, "utf8")).toBe(content);
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    const options = await inspectionOptions(source, MAX_AGENT_RESOURCE_BYTES);
    await expect(boundPromotionReadFile(options)).rejects.toThrow("16 MiB budget");
  });

  it("keeps the existing native copy file budget even when the resource budget is larger", async () => {
    const { source, destination, target } = await fixture("auth.json", "{}");
    await truncate(source, 64 * 1024 * 1024 + 1);
    await expect(copyBoundPrivateFile(source, destination, "auth.json", MAX_AGENT_RESOURCE_BYTES)).rejects.toThrow("bounded private app-owned file");
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies MCP at its exact limit and rejects larger bytes at both boundaries", async () => {
    const exact = await fixture("mcp.json", "{}" + " ".repeat(MAX_MCP_JSON_BYTES - 2));
    await copyBoundPrivateFile(exact.source, exact.destination, "mcp.json", MAX_MCP_JSON_BYTES);
    expect(await readFile(exact.target)).toEqual(await readFile(exact.source));
    const over = await fixture("mcp.json", "{}" + " ".repeat(MAX_MCP_JSON_BYTES - 1));
    await expect(copyBoundPrivateFile(over.source, over.destination, "mcp.json", MAX_MCP_JSON_BYTES)).rejects.toThrow("bounded regular file");
    const options = await inspectionOptions(over.source, MAX_MCP_JSON_BYTES);
    await expect(boundPromotionInspectPrivateFile(options)).rejects.toThrow("bounded private app-owned file");
    await expect(lstat(over.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a replaced source identity even when its bytes are identical", async () => {
    const { source } = await fixture("auth.json", "{}");
    const options = await inspectionOptions(source, MAX_AGENT_RESOURCE_BYTES);
    await rename(source, `${source}-original`);
    await writeFile(source, "{}", { mode: 0o600 });
    await expect(boundPromotionInspectPrivateFile(options)).rejects.toThrow("identity mismatch");
    expect(await readFile(`${source}-original`, "utf8")).toBe("{}");
  });

  it("rejects a source symlink in the helper and in the native inspector", async () => {
    const { source, destination, target } = await fixture("auth.json", "{}");
    const options = await inspectionOptions(source, MAX_AGENT_RESOURCE_BYTES);
    await rename(source, `${source}-original`);
    await symlink(`${source}-original`, source);
    await expect(copyBoundPrivateFile(source, destination, "auth.json", MAX_AGENT_RESOURCE_BYTES)).rejects.toThrow("bounded regular file");
    await expect(boundPromotionInspectPrivateFile(options)).rejects.toThrow();
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(`${source}-original`, "utf8")).toBe("{}");
  });

  it("does not follow a symlinked source parent", async () => {
    const { source, destination, target } = await fixture("auth.json", "{}");
    const parent = dirname(source);
    await rename(parent, `${parent}-original`);
    await symlink(`${parent}-original`, parent);
    await expect(copyBoundPrivateFile(source, destination, "auth.json", MAX_AGENT_RESOURCE_BYTES)).rejects.toThrow("parent is not a real directory");
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["group-writable", "hardlinked"])("retains private-file validation for %s sources", async (kind) => {
    const { source, destination, target } = await fixture("auth.json", "{}");
    if (kind === "group-writable") await chmod(source, 0o620);
    else await link(source, `${source}-linked`);
    await expect(copyBoundPrivateFile(source, destination, "auth.json", MAX_AGENT_RESOURCE_BYTES)).rejects.toThrow("bounded private app-owned file");
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a replaced destination root without writing to either directory", async () => {
    const { source, destination, target } = await fixture("auth.json", "{}");
    await rename(destination.path, `${destination.path}-original`);
    await mkdir(destination.path, { mode: 0o700 });
    await expect(copyBoundPrivateFile(source, destination, "auth.json", MAX_AGENT_RESOURCE_BYTES)).rejects.toThrow(/identity|capability/);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(`${destination.path}-original`, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites an occupied destination", async () => {
    const { source, destination, target } = await fixture("auth.json", "{}");
    await writeFile(target, "retained destination", { mode: 0o600 });
    await expect(copyBoundPrivateFile(source, destination, "auth.json", MAX_AGENT_RESOURCE_BYTES)).rejects.toThrow("destination is occupied");
    expect(await readFile(target, "utf8")).toBe("retained destination");
    expect(await readFile(source, "utf8")).toBe("{}");
  });

  it.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid byte budgets: %s", async (maxBytes) => {
    const { source, destination, target } = await fixture("auth.json", "{}");
    await expect(copyBoundPrivateFile(source, destination, "auth.json", maxBytes)).rejects.toThrow("byte budget must be positive");
    const options = await inspectionOptions(source, maxBytes);
    if (maxBytes <= 0 || Number.isNaN(maxBytes)) {
      await expect(boundPromotionInspectPrivateFile(options)).rejects.toThrow("maxBytes must be positive");
    }
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
