import { describe, expect, it } from "vitest";
import {
  bgraPixelHex,
  cssHexEquals,
  nativeImageLooksUnpainted,
  nativeImageSolidHex,
} from "../../../electron/paint-watchdog.ts";

function fakeImage(width: number, height: number, pixels: number[]): {
  getSize(): { width: number; height: number };
  toBitmap(): Buffer;
} {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i++) bitmap.writeUInt32LE(pixels[i]!, i * 4);
  return {
    getSize: () => ({ width, height }),
    toBitmap: () => bitmap,
  };
}

/** BGRA #1e1e1e opaque. */
const NATIVE_FILL = 0xff1e1e1e;
/** BGRA #0b0d09 opaque (page --bg). */
const PAGE_BG = 0xff0b0d09;

describe("paint watchdog sampling", () => {
  it("reads BGRA as #rrggbb", () => {
    expect(bgraPixelHex(NATIVE_FILL)).toBe("#1e1e1e");
    expect(bgraPixelHex(PAGE_BG)).toBe("#0b0d09");
    expect(cssHexEquals("#1E1E1E", "#1e1e1e")).toBe(true);
  });

  it("treats a solid bitmap as unpainted", () => {
    const img = fakeImage(8, 8, Array(64).fill(NATIVE_FILL));
    expect(nativeImageLooksUnpainted(img)).toBe(true);
    expect(nativeImageSolidHex(img)).toBe("#1e1e1e");
  });

  it("does not treat a painted dark UI as blank", () => {
    const pixels = Array(64).fill(PAGE_BG);
    pixels[20] = NATIVE_FILL;
    const img = fakeImage(8, 8, pixels);
    expect(nativeImageLooksUnpainted(img)).toBe(false);
    expect(nativeImageSolidHex(img)).toBeNull();
  });
});
