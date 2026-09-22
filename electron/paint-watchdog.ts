/**
 * Paint-watchdog sampling. capturePage bitmaps are BGRA; a bilinear
 * downscale of Termina's dark chrome looks uniformly blank even when the
 * document is painted, so we stride-sample the real pixels.
 */
export function bgraPixelHex(pixel: number): string {
  const r = (pixel >>> 16) & 0xff;
  const g = (pixel >>> 8) & 0xff;
  const b = pixel & 0xff;
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function cssHexEquals(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

type SampledImage = {
  getSize(): { width: number; height: number };
  toBitmap(): Buffer;
};

/** True when every stride sample is the same color (a solid, unpainted fill). */
export function nativeImageLooksUnpainted(img: SampledImage): boolean {
  const { width, height } = img.getSize();
  if (width < 1 || height < 1) return false;
  const bitmap = img.toBitmap();
  if (bitmap.length < 4) return false;
  const first = bitmap.readUInt32LE(0);
  const stepX = Math.max(1, Math.floor(width / 64));
  const stepY = Math.max(1, Math.floor(height / 40));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      if (bitmap.readUInt32LE((y * width + x) * 4) !== first) return false;
    }
  }
  return true;
}

export function nativeImageSolidHex(img: SampledImage): string | null {
  if (!nativeImageLooksUnpainted(img)) return null;
  return bgraPixelHex(img.toBitmap().readUInt32LE(0));
}
