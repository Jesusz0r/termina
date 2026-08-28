/**
 * Unit tests for privileged terminal-drop helpers.
 *
 *   npm run test:terminal-drop
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAuthorizedDropSender,
  normalizeDroppedPaths,
  quotePosixPaths,
  readDroppedImages,
  readStableImage,
  validatePathDropTargets,
} from "../electron/terminal-drop.ts";
import { MAX_IMAGE_BYTES } from "../agent-core/host.ts";

const results = [];
const leftovers = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
};

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x04, 0, 0, 0]), Buffer.from("WEBP")]);
const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00");

const root = mkdtempSync(join(tmpdir(), "termina-drop-"));
leftovers.push(root);
process.on("exit", () => {
  for (const p of leftovers) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const absA = join(root, "a file.txt");
const absB = join(root, "quote'.txt");
const absC = join(root, "dir");
writeFileSync(absA, "a");
writeFileSync(absB, "b");
mkdirSync(absC);

const order = normalizeDroppedPaths([absB, absA, absB, `${absA}/../${absA.split("/").pop()}`]);
check(
  "normalizeDroppedPaths preserves first order and deduplicates",
  order.ok && order.paths.length === 2 && order.paths[0] === absB,
);
check("normalizeDroppedPaths rejects empty input", normalizeDroppedPaths([]).ok === false);
check("normalizeDroppedPaths rejects non-strings", normalizeDroppedPaths([absA, 1]).ok === false);
check("normalizeDroppedPaths rejects NUL", normalizeDroppedPaths([`${absA}\0x`]).ok === false);
check("normalizeDroppedPaths rejects CR", normalizeDroppedPaths([`${absA}\rx`]).ok === false);
check("normalizeDroppedPaths rejects LF", normalizeDroppedPaths([`${absA}\nx`]).ok === false);
check("normalizeDroppedPaths rejects a relative path", normalizeDroppedPaths(["tmp/file"]).ok === false);
check(
  "normalizeDroppedPaths rejects a too-long path before dedup",
  normalizeDroppedPaths([`/${"a".repeat(4097)}`]).ok === false,
);
const many = Array.from({ length: 17 }, (_, i) => join(root, `f${i}`));
check("normalizeDroppedPaths rejects more than 16 paths before dedup", normalizeDroppedPaths(many).ok === false);
const huge = Array.from({ length: 16 }, (_, i) => `/${"x".repeat(5000)}${i}`);
check("normalizeDroppedPaths rejects oversized total bytes before dedup", normalizeDroppedPaths(huge).ok === false);

const quoted = quotePosixPaths([absA, absB, "/tmp/$x`y\\z", "/--leading"], "darwin");
check(
  "quotePosixPaths wraps paths and embeds single quotes",
  quoted.ok && quoted.text.includes("'\\''") && quoted.text.includes("/--leading") && quoted.text.includes("$x"),
);
check("quotePosixPaths rejects an unsupported platform", quotePosixPaths([absA], "win32").error === "unsupported platform");
check("quotePosixPaths accepts linux", quotePosixPaths([absA], "linux").ok === true);

const linkPath = join(root, "link-to-a");
symlinkSync(absA, linkPath);
const pathOk = await validatePathDropTargets([absA, absC, linkPath]);
check("path-only validation accepts files, directories, and symlinks", pathOk.ok === true);
check("path-only validation rejects a missing path", (await validatePathDropTargets([join(root, "missing")])).ok === false);

const pngPath = join(root, "pic.png");
const jpegPath = join(root, "pic.JPG");
const webpPath = join(root, "pic.webp");
const gifPath = join(root, "pic.gif");
writeFileSync(pngPath, png1x1);
writeFileSync(jpegPath, jpeg);
writeFileSync(webpPath, webp);
writeFileSync(gifPath, gif);
const readOk = await readDroppedImages([pngPath, jpegPath, webpPath, gifPath], 4);
check(
  "readDroppedImages accepts png jpeg webp gif including uppercase extensions",
  readOk.ok && readOk.images.length === 4 && readOk.images.every((img) => img.id.length > 0),
);

const mismatch = join(root, "fake.png");
writeFileSync(mismatch, jpeg);
check("readDroppedImages rejects extension/signature mismatch", (await readDroppedImages([mismatch], 4)).ok === false);
writeFileSync(join(root, "empty.png"), "");
check("readDroppedImages rejects a zero-byte file", (await readDroppedImages([join(root, "empty.png")], 4)).ok === false);
check("readDroppedImages rejects a directory", (await readDroppedImages([absC], 4)).ok === false);
check("readDroppedImages rejects a symlink", (await readDroppedImages([linkPath], 4)).ok === false);
const big = join(root, "big.png");
writeFileSync(big, Buffer.concat([png1x1, Buffer.alloc(MAX_IMAGE_BYTES)]));
check("readDroppedImages rejects an oversized file", (await readDroppedImages([big], 4)).ok === false);

const hard = join(root, "hard.png");
linkSync(pngPath, hard);
const dup = await readDroppedImages([pngPath, hard], 4);
check("readDroppedImages deduplicates hard links", dup.ok && dup.images.length === 1);

const extras = [];
for (let i = 0; i < 5; i++) {
  const p = join(root, `u${i}.png`);
  writeFileSync(p, png1x1);
  extras.push(p);
}
check("readDroppedImages rejects more unique images than remaining", (await readDroppedImages(extras, 4)).ok === false);
check("readDroppedImages rejects remaining 0", (await readDroppedImages([pngPath], 0)).ok === false);

const resizeHandle = {
  reads: 0,
  async stat() {
    return { size: this.reads === 0 ? 4 : 8 };
  },
  async read(buf, offset, length, position) {
    this.reads += 1;
    if (position >= 4) return { bytesRead: 0 };
    const n = Math.min(length, 4 - position);
    buf.fill(1, offset, offset + n);
    return { bytesRead: n };
  },
};
const resized = await readStableImage(resizeHandle, 4);
check("readStableImage rejects a size change after the read", resized.ok === false);

const eofHandle = {
  async stat() {
    return { size: 4 };
  },
  async read(_buf, _offset, _length, position) {
    return { bytesRead: position === 0 ? 2 : 0 };
  },
};
check("readStableImage rejects early EOF", (await readStableImage(eofHandle, 4)).ok === false);

const growHandle = {
  async stat() {
    return { size: 4 };
  },
  async read(buf, offset, length, position) {
    if (position >= 4) {
      buf[offset] = 9;
      return { bytesRead: 1 };
    }
    const n = Math.min(length, 4 - position);
    buf.fill(2, offset, offset + n);
    return { bytesRead: n };
  },
};
check("readStableImage rejects extra data past expectedSize", (await readStableImage(growHandle, 4)).ok === false);

const webContents = { isDestroyed: () => false, mainFrame: { id: "main" } };
const win = { isDestroyed: () => false, webContents };
check(
  "isAuthorizedDropSender accepts the current main frame",
  isAuthorizedDropSender({ sender: webContents, senderFrame: webContents.mainFrame }, win) === true,
);
check(
  "isAuthorizedDropSender rejects a subframe",
  isAuthorizedDropSender({ sender: webContents, senderFrame: { id: "child" } }, win) === false,
);
check(
  "isAuthorizedDropSender rejects a mismatched webContents",
  isAuthorizedDropSender({ sender: { isDestroyed: () => false, mainFrame: webContents.mainFrame }, senderFrame: webContents.mainFrame }, win) === false,
);
check("isAuthorizedDropSender rejects a null frame", isAuthorizedDropSender({ sender: webContents, senderFrame: null }, win) === false);
check("isAuthorizedDropSender rejects a destroyed window", isAuthorizedDropSender({ sender: webContents, senderFrame: webContents.mainFrame }, { isDestroyed: () => true, webContents }) === false);
check("isAuthorizedDropSender rejects a missing window", isAuthorizedDropSender({ sender: webContents, senderFrame: webContents.mainFrame }, null) === false);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
