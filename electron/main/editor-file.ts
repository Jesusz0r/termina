import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

/** The path has already been resolved and authorized by main. */
export async function readEditorFile(path: string, maxBytes: number): Promise<Buffer<ArrayBuffer>> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW
    | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
  const handle = await open(path, flags);
  try {
    return await readEditorBytes(handle, maxBytes);
  } finally {
    await handle.close();
  }
}

/** Bound allocation and reads to the observed file size plus one growth probe. */
export async function readEditorBytes(handle: Pick<FileHandle, "stat" | "read">, maxBytes: number): Promise<Buffer<ArrayBuffer>> {
  const before = await handle.stat();
  if (!before.isFile()) throw new Error("not a regular file");
  if (before.size > maxBytes) {
    throw new Error(`file is too large to open or preview (${before.size} bytes)`);
  }
  const bytes = Buffer.alloc(before.size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await handle.stat();
  if (offset !== before.size || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error("file changed while reading; open it again");
  }
  return bytes.subarray(0, offset);
}

/** Do not create an editable model from bytes that cannot round-trip as text. */
export function decodeEditorText(bytes: Buffer): string {
  if (!isUtf8(bytes)) {
    throw new Error("This file is binary or uses an unsupported text encoding. Only UTF-8 text can be edited.");
  }
  const text = bytes.toString("utf8");
  // Tabs, newlines, form feeds and carriage returns are valid text controls.
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) {
    throw new Error("This binary file has no supported preview and cannot be edited as text.");
  }
  return text;
}
