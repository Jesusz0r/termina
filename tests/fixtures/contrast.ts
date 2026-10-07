/** WCAG 2.x contrast between two opaque six-digit sRGB colors. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string): number => {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected an opaque sRGB color: ${hex}`);
    const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}
