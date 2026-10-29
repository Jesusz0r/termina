import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// Creation only: no caller-controlled destination and no operation on old notes.
try {
  if (process.argv.length !== 2) throw new Error("Save notes with stdin and no arguments; a destination cannot be selected.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Read note text from stdin as bytes.");
    bytes += chunk.length;
    if (bytes > 16 * 1024) throw new Error("Keep a note within 16 KiB.");
    chunks.push(chunk);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).trim();
  if (!text || text.includes("\0")) throw new Error("A note must contain non-empty UTF-8 text without NUL bytes.");

  const project = realpathSync(process.cwd());
  const directory = join(project, ".termina-notes");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error("The project's .termina-notes must be a real directory, not a symlink.");
  }
  const path = join(directory, `${randomUUID()}.md`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, `# Working notes\n\nUnverified context. Run current checks before claiming completion.\n\n${text}\n`);
  } finally {
    closeSync(fd);
  }
  console.log(relative(project, path));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not save notes.");
  process.exitCode = 1;
}
