/**
 * Files the editor shows instead of a text model. The media URL is only a
 * pointer; main still checks that the path sits in an open workspace.
 */

export type PreviewKind = "image" | "pdf";

const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);

export function previewKind(path: string): PreviewKind | null {
  const base = path.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

export function previewContentType(path: string): string | null {
  const kind = previewKind(path);
  if (kind === "pdf") return "application/pdf";
  if (kind !== "image") return null;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "ico") return "image/x-icon";
  return `image/${ext}`;
}

/** Only PDF documents may navigate a preview frame; SVG remains image-only. */
export function isPdfPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const path = url.searchParams.get("path");
    return url.protocol === "termina-media:" && url.hostname === "media"
      && url.pathname === "/file" && !url.username && !url.password && !url.port
      && !!path && !path.includes("\0") && previewKind(path) === "pdf";
  } catch {
    return false;
  }
}

/** URL the renderer loads. `version` is the file mtime so a rewrite refetches. */
export function previewMediaUrl(absPath: string, version: number): string {
  const url = new URL("termina-media://media/file");
  url.searchParams.set("path", absPath);
  url.searchParams.set("v", String(version));
  return url.href;
}
