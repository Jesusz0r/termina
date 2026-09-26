import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { decodeEditorText, readEditorBytes, readEditorFile } from "../../../electron/main/editor-file.ts";

describe("editor text decoding", () => {
  it.each(["", "hello\r\n\tworld\f", "résumé 😀 日本語", "\ufeffBOM", "replacement character: �"])(
    "preserves valid UTF-8 bytes: %j", (text) => {
      const bytes = Buffer.from(text);
      expect(Buffer.from(decodeEditorText(bytes))).toEqual(bytes);
    },
  );

  it.each([
    Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), // ZIP and modern Office containers
    Buffer.from("SQLite format 3\0"),
    Buffer.from([0xff, 0xfe, 0x61, 0]), // UTF-16 is not silently decoded as UTF-8
    Buffer.from([0x72, 0xe9, 0x73]), // Legacy encoding
    Buffer.from([0xf0, 0x9f, 0x98]), // Truncated UTF-8
    Buffer.from([1, 2, 3]), // Valid UTF-8 does not imply text
  ])("rejects binary or non-UTF-8 content: %j", (bytes) => {
    expect(() => decodeEditorText(bytes)).toThrow(/binary|unsupported text encoding/);
  });
});

describe("bounded editor reads", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "editor-file-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("accepts empty files and exactly the limit, but rejects oversized and nonregular files", async () => {
    const path = join(root, "file");
    await writeFile(path, "");
    expect(await readEditorFile(path, 4)).toEqual(Buffer.alloc(0));
    await writeFile(path, "text");
    expect(await readEditorFile(path, 4)).toEqual(Buffer.from("text"));
    await expect(readEditorFile(path, 3)).rejects.toThrow("too large");
    await expect(readEditorFile(root, 4)).rejects.toThrow("not a regular file");
  });

  it.each(["grow", "truncate", "rewrite"])("rejects a file that changes during the read: %s", async (change) => {
    const original = { size: 4, mtimeMs: 1, ctimeMs: 1, isFile: () => true };
    const content = Buffer.from(change === "grow" ? "longer content" : change === "truncate" ? "a" : "edit");
    let statCalls = 0;
    let totalRequested = 0;
    const handle = {
      stat: async () => statCalls++ === 0 ? original : { ...original, size: content.length, mtimeMs: 2 },
      read: async (target: Buffer, offset: number, length: number, position: number) => {
        totalRequested += length;
        const bytesRead = content.copy(target, offset, position, position + length);
        return { bytesRead, buffer: target };
      },
    } as unknown as Parameters<typeof readEditorBytes>[0];
    await expect(readEditorBytes(handle, 8)).rejects.toThrow("changed while reading");
    // Even growth beyond the limit never causes an unbounded read/allocation.
    expect(totalRequested).toBeLessThanOrEqual(9);
  });

  it.skipIf(process.platform === "win32")("rejects a symlink introduced after path authorization", async () => {
    const target = join(root, "target");
    await writeFile(target, "text");
    const path = join(root, "link");
    await symlink(target, path);
    await expect(readEditorFile(path, 4)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO promptly and leaves subsequent reads healthy", async () => {
    const fifo = join(root, "fifo");
    await promisify(execFile)("mkfifo", [fifo]);
    const path = join(root, "text");
    await writeFile(path, "okay");
    const moduleUrl = new URL("../../../electron/main/editor-file.ts", import.meta.url).href;
    await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { readEditorFile } from ${JSON.stringify(moduleUrl)};
      import assert from 'node:assert/strict';
      await assert.rejects(readEditorFile(${JSON.stringify(fifo)}, 4), /not a regular file/);
      assert.equal((await readEditorFile(${JSON.stringify(path)}, 4)).toString(), 'okay');
    `], { timeout: 5_000 });
  });
});
