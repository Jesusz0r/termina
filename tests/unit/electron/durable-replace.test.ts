import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open as realOpen, rename as realRename, rm as realRm } from "node:fs/promises";
import { randomUUID as realRandomUUID } from "node:crypto";
import { syncParentDir as realSyncParentDir } from "../../../shared/fsync.ts";
import ts from "typescript";

/**
 * Crash-durability sequence of TerminaApp.durableReplaceFile, extracted from
 * electron/main.ts (the save-revert-lease suite's pattern: main imports
 * Electron and cannot be imported here).
 *
 * Crash-consistency argument, asserted structurally below:
 * 1. handle.sync() precedes rename: the temp's bytes are durable before the
 *    directory entry flips, so a crash after rename always finds complete content.
 * 2. syncParentDir(path) follows rename: the new directory entry itself is
 *    durable, so the rename (or revert delete) survives a crash.
 * 3. One fsRename call flips the entry atomically: readers see the old file
 *    or the new file, never a torn write.
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

type DurableReplaceFile = (path: string, data: string | Buffer, mode?: number) => Promise<void>;

interface ScriptedFs {
  events: string[];
  openArgs: Array<{ temp: string; flags: string; mode: number | string | undefined }>;
  written: Array<string | Buffer>;
  renamed: Array<{ temp: string; path: string }>;
  parentSynced: string[];
  removed: string[];
  renameError: Error | null;
  openError: Error | null;
}

function makeScriptedFs(): { fs: ScriptedFs; fakes: Record<string, unknown> } {
  const fs: ScriptedFs = {
    events: [],
    openArgs: [],
    written: [],
    renamed: [],
    parentSynced: [],
    removed: [],
    renameError: null,
    openError: null,
  };
  const handle = {
    writeFile: async (data: string | Buffer) => {
      fs.events.push("writeFile");
      fs.written.push(data);
    },
    sync: async () => {
      fs.events.push("sync");
    },
    close: async () => {
      fs.events.push("close");
    },
  };
  const fakes: Record<string, unknown> = {
    open: async (temp: string, flags: string, mode?: number | string) => {
      fs.events.push("open");
      fs.openArgs.push({ temp, flags, mode });
      if (fs.openError) throw fs.openError;
      return handle;
    },
    fsRename: async (temp: string, path: string) => {
      fs.events.push("rename");
      fs.renamed.push({ temp, path });
      if (fs.renameError) throw fs.renameError;
    },
    rm: async (temp: string) => {
      fs.events.push("rm");
      fs.removed.push(temp);
    },
    syncParentDir: (path: string) => {
      fs.events.push("syncParentDir");
      fs.parentSynced.push(path);
    },
    randomUUID: () => "fixed-uuid",
  };
  return { fs, fakes };
}

function loadScripted(fakes: Record<string, unknown>): DurableReplaceFile {
  return loadMethod(
    "durableReplaceFile",
    "private async durableReplaceFile(",
    ["open", "fsRename", "rm", "syncParentDir", "randomUUID"],
    [fakes.open, fakes.fsRename, fakes.rm, fakes.syncParentDir, fakes.randomUUID],
  ) as DurableReplaceFile;
}

const loadReal = (): DurableReplaceFile =>
  loadMethod(
    "durableReplaceFile",
    "private async durableReplaceFile(",
    ["open", "fsRename", "rm", "syncParentDir", "randomUUID"],
    [realOpen, realRename, realRm, realSyncParentDir, realRandomUUID],
  ) as DurableReplaceFile;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "durable-replace-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("durableReplaceFile sequence", () => {
  it("fsyncs the temp file, renames, then fsyncs the parent dir, in order", async () => {
    const { fs, fakes } = makeScriptedFs();
    const durableReplaceFile = loadScripted(fakes);
    const target = join(dir, "note.txt");
    await durableReplaceFile(target, "new-content", 0o640);
    expect(fs.events).toEqual(["open", "writeFile", "sync", "close", "rename", "syncParentDir"]);
    const temp = `${target}.${process.pid}.fixed-uuid.tmp`;
    expect(fs.openArgs).toEqual([{ temp, flags: "wx", mode: 0o640 }]);
    expect(fs.written).toEqual(["new-content"]);
    expect(fs.renamed).toEqual([{ temp, path: target }]);
    expect(fs.parentSynced).toEqual([target]);
    expect(fs.removed).toEqual([]);
  });

  it("writes buffers byte-exact and defaults the temp mode for new files", async () => {
    const { fs, fakes } = makeScriptedFs();
    const durableReplaceFile = loadScripted(fakes);
    const target = join(dir, "blob.bin");
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    await durableReplaceFile(target, bytes);
    expect(fs.openArgs[0]?.mode).toBe(0o666);
    expect(fs.written).toHaveLength(1);
    expect(Buffer.from(fs.written[0] as Buffer)).toEqual(bytes);
  });

  it("cleans the temp file and skips the parent sync when rename fails", async () => {
    const { fs, fakes } = makeScriptedFs();
    fs.renameError = new Error("rename blew up");
    const durableReplaceFile = loadScripted(fakes);
    const target = join(dir, "note.txt");
    await expect(durableReplaceFile(target, "new")).rejects.toThrow("rename blew up");
    expect(fs.removed).toEqual([`${target}.${process.pid}.fixed-uuid.tmp`]);
    expect(fs.parentSynced).toEqual([]);
  });

  it("renames nothing when the temp cannot be created", async () => {
    const { fs, fakes } = makeScriptedFs();
    fs.openError = new Error("EACCES");
    const durableReplaceFile = loadScripted(fakes);
    await expect(durableReplaceFile(join(dir, "note.txt"), "new")).rejects.toThrow("EACCES");
    expect(fs.renamed).toEqual([]);
    expect(fs.parentSynced).toEqual([]);
  });
});

describe("durableReplaceFile on a real filesystem", () => {
  it("replaces content atomically and leaves no temp behind", async () => {
    const durableReplaceFile = loadReal();
    const target = join(dir, "note.txt");
    writeFileSync(target, "old", { mode: 0o640 });
    await durableReplaceFile(target, "new-content", 0o640);
    expect(readFileSync(target, "utf8")).toBe("new-content");
    expect(readdirSync(dir)).toEqual(["note.txt"]);
    expect(statSync(target).isFile()).toBe(true);
  });

  it("restores binary blobs byte-exact", async () => {
    const durableReplaceFile = loadReal();
    const target = join(dir, "blob.bin");
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x89, 0x50]);
    await durableReplaceFile(target, bytes);
    expect(readFileSync(target)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(["blob.bin"]);
  });
});
