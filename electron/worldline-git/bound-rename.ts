/** Explorer moves use the same native descriptor boundary as promotion. */
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { coreClient } from "./core-process.js";
import { boundPromotionOpenDirectory, promotionIdentityPayload } from "./bound-promotion.js";

export async function renameBoundEntry(root: string, source: string, destination: string): Promise<void> {
  if (source === destination) return;
  const components = (path: string): string[] => {
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("rename path outside workspace");
    return rel.split(sep);
  };
  const sourceComponents = components(source);
  const destinationComponents = components(destination);
  const identity = await boundPromotionOpenDirectory({ path: root });
  const sourceIdentity = await lstat(source, { bigint: true });
  await coreClient.request({
    op: "promotion-bound-rename", root,
    rootIdentity: promotionIdentityPayload(identity),
    ...(identity.capability ? { rootCapability: identity.capability } : {}),
    sourceComponents, destinationComponents,
    expectedIdentity: { dev: String(sourceIdentity.dev), ino: String(sourceIdentity.ino) },
  });
}
