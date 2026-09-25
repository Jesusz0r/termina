import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { link, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isErrno } from "../../../shared/guards.ts";
import ts from "typescript";
import { renameBoundEntry, disposeWorldlineGitCore } from "../../../electron/worldline-git.ts";

/**
 * Explorer no-replace mutations (refs #167).
 *
 * The real TerminaApp helpers are extracted from electron/main.ts and
 * transpiled (the save-revert-lease suite's pattern: main imports Electron
 * and cannot be imported here), then exercised against real temp files.
 * Handler wiring is asserted structurally below.
 */

const root = process.cwd();
const main = readFileSync(join(root, "electron", "main.ts"), "utf8");

function extractMethod(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing method ${signature}`);
  const paramsEnd = source.indexOf(")", start + signature.length) + 1;
  let angle = 0;
  let brace = -1;
  for (let i = paramsEnd; i < source.length; i++) {
    const ch = source[i];
    if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
    else if (ch === "{" && angle === 0) {
      brace = i;
      break;
    }
  }
  if (brace < 0) throw new Error(`unclosed method ${signature}`);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed method ${signature}`);
}

function loadMethod(factoryName: string, signature: string, names: string[], values: unknown[]): unknown {
  const methodSource = extractMethod(main, signature).replace(/^private /, "");
  const factory = ts.transpileModule(`return ({ ${methodSource} }).${factoryName};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const construct = new Function(...names, factory) as unknown as (...args: unknown[]) => unknown;
  return construct(...values);
}

const createFileExclusive = loadMethod(
  "createFileExclusive",
  "private async createFileExclusive(",
  ["open", "isErrno"],
  [open, isErrno],
) as (abs: string) => Promise<void>;

const originalCoreBin = process.env.TERMINA_CORE_BIN;
beforeAll(() => { process.env.TERMINA_CORE_BIN = join(root, "core/target/debug/termina-core"); });
afterAll(() => {
  disposeWorldlineGitCore();
  if (originalCoreBin === undefined) delete process.env.TERMINA_CORE_BIN;
  else process.env.TERMINA_CORE_BIN = originalCoreBin;
});
const renameNoReplace = (src: string, dest: string) => renameBoundEntry(dirname(src), src, dest);

function handlerSpan(channel: string, nextChannel: string): string {
  const start = main.indexOf(`ipcMain.handle("${channel}"`);
  const end = main.indexOf(`ipcMain.handle("${nextChannel}"`, start + 1);
  if (start < 0 || end < 0) throw new Error(`missing handler span ${channel}`);
  return main.slice(start, end);
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "termina-no-replace-"));
}

describe("explorer no-replace mutations (refs #167)", () => {
  it("routes explorer create/rename through the no-replace helpers", () => {
    const create = handlerSpan("explorer:create", "explorer:rename");
    expect(create).toContain("createFileExclusive");
    expect(create).not.toContain("writeFile(abs");
    // Directory creation is an exclusive mkdir, not a recursive no-op.
    expect(create).toContain("mkdir(abs)");
    expect(create).not.toContain("mkdir(abs, { recursive: true })");
    const rename = handlerSpan("explorer:rename", "explorer:delete");
    expect(rename).toContain("renameBoundEntry(workspace.root,");
    expect(rename).not.toContain("fsRename(abs, join(");
  });

  it("creates fresh files empty and refuses to truncate existing ones", async () => {
    const dir = tmp();
    try {
      const fresh = join(dir, "fresh.txt");
      await createFileExclusive(fresh);
      expect(readFileSync(fresh, "utf8")).toBe("");
      const existing = join(dir, "existing.txt");
      const bytes = "x".repeat(40);
      writeFileSync(existing, bytes);
      await expect(createFileExclusive(existing)).rejects.toThrow("destination already exists");
      expect(readFileSync(existing, "utf8")).toBe(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renames files and refuses to replace an existing destination", async () => {
    const dir = tmp();
    try {
      const src = join(dir, "source.txt");
      const dest = join(dir, "renamed.txt");
      writeFileSync(src, "source-bytes");
      await renameNoReplace(src, dest);
      expect(existsSync(src)).toBe(false);
      expect(readFileSync(dest, "utf8")).toBe("source-bytes");

      const victim = join(dir, "destination.txt");
      writeFileSync(src, "source-again");
      writeFileSync(victim, "destination-bytes");
      await expect(renameNoReplace(src, victim)).rejects.toThrow("destination already exists");
      expect(readFileSync(victim, "utf8")).toBe("destination-bytes");
      expect(readFileSync(src, "utf8")).toBe("source-again");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renames directories and refuses to replace existing ones", async () => {
    const dir = tmp();
    try {
      const src = join(dir, "src-dir");
      mkdirSync(join(src, "nested"), { recursive: true });
      writeFileSync(join(src, "nested", "file.txt"), "nested-bytes");
      const dest = join(dir, "dest-dir");
      await renameNoReplace(src, dest);
      expect(existsSync(src)).toBe(false);
      expect(readFileSync(join(dest, "nested", "file.txt"), "utf8")).toBe("nested-bytes");

      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "b.txt"), "b");
      await expect(renameNoReplace(src, dest)).rejects.toThrow("destination already exists");
      expect(readFileSync(join(src, "b.txt"), "utf8")).toBe("b");
      expect(readFileSync(join(dest, "nested", "file.txt"), "utf8")).toBe("nested-bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats same-name and inode-identical renames as safe no-ops", async () => {
    const dir = tmp();
    try {
      const file = join(dir, "same.txt");
      writeFileSync(file, "bytes");
      await renameNoReplace(file, file);
      expect(readFileSync(file, "utf8")).toBe("bytes");
      // A hardlink alias has the same inode: replacing it cannot lose bytes.
      const alias = join(dir, "alias.txt");
      await link(file, alias);
      await renameNoReplace(file, alias);
      expect(readFileSync(alias, "utf8")).toBe("bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("renames symlinks without following them", async () => {
    const dir = tmp();
    try {
      const target = join(dir, "target.txt");
      writeFileSync(target, "target-bytes");
      const src = join(dir, "link");
      symlinkSync(target, src);
      const dest = join(dir, "moved-link");
      await renameNoReplace(src, dest);
      expect(existsSync(src)).toBe(false);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dest)).toBe(target);

      symlinkSync(target, src);
      const occupant = join(dir, "occupant");
      writeFileSync(occupant, "occupant-bytes");
      await expect(renameNoReplace(src, occupant)).rejects.toThrow("destination already exists");
      expect(readFileSync(occupant, "utf8")).toBe("occupant-bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("admits exactly one winner when two renames race for one name", async () => {
    const dir = tmp();
    try {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      const dest = join(dir, "winner.txt");
      writeFileSync(a, "aaa");
      writeFileSync(b, "bbb");
      const results = await Promise.allSettled([renameNoReplace(a, dest), renameNoReplace(b, dest)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const content = readFileSync(dest, "utf8");
      expect(["aaa", "bbb"]).toContain(content);
      // The loser kept its source; the winner moved.
      const survivors = [a, b].filter((p) => existsSync(p));
      expect(survivors).toHaveLength(1);
      expect(readFileSync(survivors[0]!, "utf8")).not.toBe(content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("admits exactly one winner when two directory renames race", async () => {
    const dir = tmp();
    try {
      const a = join(dir, "a-dir");
      const b = join(dir, "b-dir");
      const dest = join(dir, "winner-dir");
      mkdirSync(a);
      mkdirSync(b);
      writeFileSync(join(a, "marker.txt"), "a");
      writeFileSync(join(b, "marker.txt"), "b");
      const results = await Promise.allSettled([renameNoReplace(a, dest), renameNoReplace(b, dest)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const external = readFileSync(join(dest, "marker.txt"), "utf8");
      expect(["a", "b"]).toContain(external);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no reservation behind when a directory rename fails", async () => {
    const dir = tmp();
    try {
      const src = join(dir, "gone");
      const dest = join(dir, "dest");
      // Source vanished: the mkdir reservation must be rolled back.
      await expect(renameNoReplace(src, dest)).rejects.toThrow();
      expect(existsSync(dest)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
