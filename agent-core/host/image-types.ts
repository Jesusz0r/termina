/** Image value contracts shared by tool output, storage, and the host queue. */
import { STORED_IMAGE_NAME } from "../session/primitives.ts";

export { STORED_IMAGE_NAME };
export const MAX_PENDING_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PENDING_IMAGE_BATCH_BYTES = MAX_PENDING_IMAGES * MAX_IMAGE_BYTES;
export const PENDING_IMAGE_NAME = /^image-[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)$/;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type ImageRef = { name: string; mediaType: string };
export type LoadedImage = ImageRef & { bytes: Buffer };
export type PendingImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export function isSafeImageName(name: string): boolean {
  return PENDING_IMAGE_NAME.test(name) || STORED_IMAGE_NAME.test(name);
}

export function mediaTypeOfName(name: string): string {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

export function extForMedia(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "png";
}

export function isAllowedMediaType(value: string): value is PendingImageMediaType {
  return MEDIA_TYPES.has(value);
}
