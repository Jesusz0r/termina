/**
 * Descriptor-bound directory helpers for the worldline owner.
 * Rebind a retained binding after a native core restart, and project a
 * binding to the filesystem identity the core expects.
 */
import type { PromotionFsIdentity } from "../worldline-git.js";
import { boundPromotionOpenDirectory } from "../worldline-git.js";
import type { BoundPromotionDirectory } from "./types.js";

export async function refreshBoundPromotionDirectory(bound: BoundPromotionDirectory): Promise<BoundPromotionDirectory> {
  let identity: PromotionFsIdentity;
  try {
    identity = await boundPromotionOpenDirectory({
      path: bound.path,
      expectedIdentity: { dev: bound.dev, ino: bound.ino },
      ...(bound.capability ? { capability: bound.capability } : {}),
    });
  } catch {
    // The native core may have restarted and forgotten its in-memory token.
    // Rebind only with the persisted identity; a replacement root still
    // fails this check before any ledger or admission write is attempted.
    identity = await boundPromotionOpenDirectory({
      path: bound.path,
      expectedIdentity: { dev: bound.dev, ino: bound.ino },
    });
  }
  return { path: bound.path, dev: identity.dev, ino: identity.ino, capability: identity.capability };
}

export function promotionIdentityOf(bound: BoundPromotionDirectory): PromotionFsIdentity {
  return {
    dev: bound.dev,
    ino: bound.ino,
    ...(bound.capability ? { capability: bound.capability } : {}),
  };
}
