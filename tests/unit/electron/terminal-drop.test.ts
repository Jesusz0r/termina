import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
} from "../../../electron/terminal-drop.ts";
import { MAX_IMAGE_BYTES } from "../../../agent-core/host.ts";

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x04, 0, 0, 0]), Buffer.from("WEBP")]);
const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00");

describe("Terminal drop unit tests", () => {
  let root: string;
  let absA: string;
  let absB: string;
  let absC: string;
  let linkPath: string;
  let pngPath: string;
  let jpegPath: string;
  let webpPath: string;
  let gifPath: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "termina-drop-"));
    absA = join(root, "a file.txt");
    absB = join(root, "quote'.txt");
    absC = join(root, "dir");
    writeFileSync(absA, "a");
    writeFileSync(absB, "b");
    mkdirSync(absC);

    linkPath = join(root, "link-to-a");
    symlinkSync(absA, linkPath);

    pngPath = join(root, "pic.png");
    jpegPath = join(root, "pic.JPG");
    webpPath = join(root, "pic.webp");
    gifPath = join(root, "pic.gif");
    writeFileSync(pngPath, png1x1);
    writeFileSync(jpegPath, jpeg);
    writeFileSync(webpPath, webp);
    writeFileSync(gifPath, gif);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("normalizeDroppedPaths", () => {
    it("preserves first order and deduplicates", () => {
      const order = normalizeDroppedPaths([absB, absA, absB, `${absA}/../${absA.split("/").pop()}`]);
      expect(order.ok).toBe(true);
      if (order.ok) {
        expect(order.paths.length).toBe(2);
        expect(order.paths[0]).toBe(absB);
      }
    });

    it("rejects invalid inputs", () => {
      expect(normalizeDroppedPaths([]).ok).toBe(false);
      expect(normalizeDroppedPaths([absA, 1 as any]).ok).toBe(false);
      expect(normalizeDroppedPaths([`${absA}\0x`]).ok).toBe(false);
      expect(normalizeDroppedPaths([`${absA}\rx`]).ok).toBe(false);
      expect(normalizeDroppedPaths([`${absA}\nx`]).ok).toBe(false);
      expect(normalizeDroppedPaths(["tmp/file"]).ok).toBe(false);
      expect(normalizeDroppedPaths([`/${"a".repeat(4097)}`]).ok).toBe(false);

      const many = Array.from({ length: 17 }, (_, i) => join(root, `f${i}`));
      expect(normalizeDroppedPaths(many).ok).toBe(false);

      const huge = Array.from({ length: 16 }, (_, i) => `/${"x".repeat(5000)}${i}`);
      expect(normalizeDroppedPaths(huge).ok).toBe(false);
    });
  });

  describe("quotePosixPaths", () => {
    it("wraps paths and embeds single quotes", () => {
      const quoted = quotePosixPaths([absA, absB, "/tmp/$x`y\\z", "/--leading"], "darwin");
      expect(quoted.ok).toBe(true);
      if (quoted.ok) {
        expect(quoted.text).toContain("'\\''");
        expect(quoted.text).toContain("/--leading");
        expect(quoted.text).toContain("$x");
      }
    });

    it("rejects unsupported platforms and accepts linux", () => {
      expect(quotePosixPaths([absA], "win32" as any).ok).toBe(false);
      expect(quotePosixPaths([absA], "linux").ok).toBe(true);
    });
  });

  describe("validatePathDropTargets", () => {
    it("accepts files, directories, and symlinks", async () => {
      const pathOk = await validatePathDropTargets([absA, absC, linkPath]);
      expect(pathOk.ok).toBe(true);
    });

    it("rejects missing path", async () => {
      const missing = await validatePathDropTargets([join(root, "missing")]);
      expect(missing.ok).toBe(false);
    });
  });

  describe("readDroppedImages", () => {
    it("accepts valid image formats and uppercase extensions", async () => {
      const readOk = await readDroppedImages([pngPath, jpegPath, webpPath, gifPath], 4);
      expect(readOk.ok).toBe(true);
      if (readOk.ok) {
        expect(readOk.images.length).toBe(4);
        expect(readOk.images.every((img) => img.id.length > 0)).toBe(true);
      }
    });

    it("rejects corrupt, empty, directory, symlink or oversized files", async () => {
      const mismatch = join(root, "fake.png");
      writeFileSync(mismatch, jpeg);
      expect((await readDroppedImages([mismatch], 4)).ok).toBe(false);

      const empty = join(root, "empty.png");
      writeFileSync(empty, "");
      expect((await readDroppedImages([empty], 4)).ok).toBe(false);

      expect((await readDroppedImages([absC], 4)).ok).toBe(false);
      expect((await readDroppedImages([linkPath], 4)).ok).toBe(false);

      const big = join(root, "big.png");
      writeFileSync(big, Buffer.concat([png1x1, Buffer.alloc(MAX_IMAGE_BYTES)]));
      expect((await readDroppedImages([big], 4)).ok).toBe(false);
    });

    it("deduplicates hard links", async () => {
      const hard = join(root, "hard.png");
      linkSync(pngPath, hard);
      const dup = await readDroppedImages([pngPath, hard], 4);
      expect(dup.ok).toBe(true);
      if (dup.ok) {
        expect(dup.images.length).toBe(1);
      }
    });

    it("enforces remaining budget", async () => {
      const extras: string[] = [];
      for (let i = 0; i < 5; i++) {
        const p = join(root, `u${i}.png`);
        writeFileSync(p, png1x1);
        extras.push(p);
      }
      expect((await readDroppedImages(extras, 4)).ok).toBe(false);
      expect((await readDroppedImages([pngPath], 0)).ok).toBe(false);
    });
  });

  describe("readStableImage", () => {
    it("rejects size changes after read", async () => {
      const resizeHandle = {
        reads: 0,
        async stat() {
          return { size: this.reads === 0 ? 4 : 8 } as any;
        },
        async read(buf: Buffer, offset: number, length: number, position: number) {
          this.reads += 1;
          if (position >= 4) return { bytesRead: 0, buffer: buf };
          const n = Math.min(length, 4 - position);
          buf.fill(1, offset, offset + n);
          return { bytesRead: n, buffer: buf };
        },
      };
      const resized = await readStableImage(resizeHandle as any, 4);
      expect(resized.ok).toBe(false);
    });

    it("rejects early EOF", async () => {
      const eofHandle = {
        async stat() {
          return { size: 4 } as any;
        },
        async read(_buf: Buffer, _offset: number, _length: number, position: number) {
          return { bytesRead: position === 0 ? 2 : 0, buffer: _buf };
        },
      };
      expect((await readStableImage(eofHandle as any, 4)).ok).toBe(false);
    });

    it("rejects extra data past expected size", async () => {
      const growHandle = {
        async stat() {
          return { size: 4 } as any;
        },
        async read(buf: Buffer, offset: number, length: number, position: number) {
          if (position >= 4) {
            buf[offset] = 9;
            return { bytesRead: 1, buffer: buf };
          }
          const n = Math.min(length, 4 - position);
          buf.fill(2, offset, offset + n);
          return { bytesRead: n, buffer: buf };
        },
      };
      expect((await readStableImage(growHandle as any, 4)).ok).toBe(false);
    });
  });

  describe("isAuthorizedDropSender", () => {
    const webContents = { isDestroyed: () => false, mainFrame: { id: "main" } };
    const win = { isDestroyed: () => false, webContents };

    it("accepts current main frame and rejects unauthorized senders", () => {
      expect(
        isAuthorizedDropSender({ sender: webContents as any, senderFrame: webContents.mainFrame as any }, win as any),
      ).toBe(true);
      expect(
        isAuthorizedDropSender({ sender: webContents as any, senderFrame: { id: "child" } as any }, win as any),
      ).toBe(false);
      expect(
        isAuthorizedDropSender(
          { sender: { isDestroyed: () => false, mainFrame: webContents.mainFrame } as any, senderFrame: webContents.mainFrame as any },
          win as any,
        ),
      ).toBe(false);
      expect(
        isAuthorizedDropSender({ sender: webContents as any, senderFrame: null }, win as any),
      ).toBe(false);
      expect(
        isAuthorizedDropSender(
          { sender: webContents as any, senderFrame: webContents.mainFrame as any },
          { isDestroyed: () => true, webContents } as any,
        ),
      ).toBe(false);
      expect(
        isAuthorizedDropSender({ sender: webContents as any, senderFrame: webContents.mainFrame as any }, null),
      ).toBe(false);
    });
  });
});
