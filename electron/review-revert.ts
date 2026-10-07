/** Conditional Change Review mutations use the native filesystem boundary. */
import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import {
  boundPromotionOpenDirectory, boundPromotionRemoveTree, boundPromotionTransition, boundPromotionWriteFile,
} from "./worldline-git.js";
import { promotionIdentityOf } from "./worldlines/bindings.js";
import { ensureBoundRelativeDirectory } from "./worldlines/promotion-recovery/bound-dirs.js";
import { assertPromotionState, boundPromotionExpectedLeaf } from "./worldlines/promotion-recovery/entry-state.js";
import type { PromotionEntryState } from "./worldlines/types.js";

export async function revertReviewedFile(root: string, path: string, expected: PromotionEntryState, data: Buffer | string | null): Promise<void> {
  const rel = relative(root, path);
  const components = rel.split(/[\\/]/);
  if (!rel || isAbsolute(rel) || components.some((p) => !p || p === "." || p === "..")) throw new Error("file is outside the review workspace");
  if (expected.type !== "file" && expected.type !== "missing") throw new Error("path is not a regular file");
  await assertPromotionState(path, expected, "the file changed after this session's edit; review the current changes before reverting");
  if (data === null && expected.type === "missing") return;
  const rootIdentity = await boundPromotionOpenDirectory({ path: root });
  const binding = { path: root, dev: rootIdentity.dev, ino: rootIdentity.ino, capability: rootIdentity.capability };
  const parent = await ensureBoundRelativeDirectory(binding, components.slice(0, -1), "review parent");
  const destination = expected.type === "missing" ? { state: { type: "missing" as const } }
    : await boundPromotionExpectedLeaf(path, expected, "review file");
  if (data !== null) {
    await boundPromotionWriteFile({
      root, rootIdentity, components, parentIdentity: promotionIdentityOf(parent), expectedDestination: destination,
      content: typeof data === "string" ? Buffer.from(data) : data,
      mode: expected.type === "file" ? expected.mode : undefined,
    });
    return;
  }
  if (!("identity" in destination)) return;
  const retainedName = `.termina-promotion-retained-${randomUUID()}.tmp`;
  const result = await boundPromotionTransition({
    primaryRoot: root, primaryRootIdentity: rootIdentity, destinationComponents: components,
    parentIdentity: promotionIdentityOf(parent), transition: { kind: "retire", retainedName, expectedDestination: destination },
  });
  if (result.outcome !== "applied") throw new Error(`the file changed during revert; retained as ${retainedName}`);
  await boundPromotionRemoveTree({
    root, rootIdentity, components: [...components.slice(0, -1), retainedName], parentIdentity: promotionIdentityOf(parent),
    expectedIdentity: destination.identity,
  });
}
