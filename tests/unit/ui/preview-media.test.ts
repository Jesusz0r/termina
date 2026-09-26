import { describe, expect, it } from "vitest";
import { isPdfPreviewUrl, previewContentType, previewKind, previewMediaUrl } from "../../../shared/preview-media.ts";

describe("editor media preview", () => {
  it("classifies images and pdfs, and leaves source files as text", () => {
    expect(previewKind("/proj/shot.PNG")).toBe("image");
    expect(previewKind("/proj/diagram.svg")).toBe("image");
    expect(previewKind("/proj/notes.pdf")).toBe("pdf");
    expect(previewKind("/proj/main.ts")).toBeNull();
    expect(previewContentType("/proj/a.jpeg")).toBe("image/jpeg");
    expect(previewContentType("/proj/notes.pdf")).toBe("application/pdf");
  });

  it("allows only app-owned PDF URLs to navigate a subframe", () => {
    expect(isPdfPreviewUrl(previewMediaUrl("/proj/notes.PDF", 1))).toBe(true);
    for (const value of [
      previewMediaUrl("/proj/image.svg", 1), previewMediaUrl("/proj/page.html", 1),
      previewMediaUrl("/proj/bad\0.pdf", 1), "https://media/file?path=/proj/notes.pdf",
      "termina-media://foreign/file?path=/proj/notes.pdf", "termina-media://media/other?path=/proj/notes.pdf",
      "termina-media://user@media/file?path=/proj/notes.pdf", "termina-media://media:123/file?path=/proj/notes.pdf",
      "termina-media://media/file", "not a URL",
    ]) expect(isPdfPreviewUrl(value)).toBe(false);
  });

  it("points the preview at the media scheme with the file version", () => {
    const url = new URL(previewMediaUrl("/proj/shot.png", 42));
    expect(url.protocol).toBe("termina-media:");
    expect(url.hostname).toBe("media");
    expect(url.searchParams.get("path")).toBe("/proj/shot.png");
    expect(url.searchParams.get("v")).toBe("42");
  });
});
