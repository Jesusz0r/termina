/**
 * Comparison manifests and markers.
 *
 * Owns bound comparison-manifest/marker reads and writes. Split from
 * promotion-recovery.ts (issue #38).
 */
import { boundPromotionReadFile, boundPromotionWriteFile, type BoundPromotionExpectedLeaf } from "../../worldline-git.js";
import { promotionIdentityOf } from "../bindings.js";
import { MARKER, MAX_WORLDLINE_FILE_BYTES } from "../limits.js";
import { type BoundPromotionDirectory, type ComparisonManifest } from "../types.js";
import { parseComparisonManifest } from "../uncertain-comparison.js";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "./primitives.js";


export async function writeComparisonManifestBound(
  root: BoundPromotionDirectory,
  manifest: ComparisonManifest,
  expectedDestination: BoundPromotionExpectedLeaf | { state: { type: "missing" } },
): Promise<BoundPromotionExpectedLeaf> {
  return boundPromotionWriteFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: ["manifest.json"],
    parentIdentity: promotionIdentityOf(root),
    expectedDestination,
    content: Buffer.from(JSON.stringify(manifest, null, 2)),
    mode: 0o600,
  });
}


export async function writeComparisonMarkerBound(root: BoundPromotionDirectory): Promise<BoundPromotionExpectedLeaf> {
  return boundPromotionWriteFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: [MARKER],
    parentIdentity: promotionIdentityOf(root),
    expectedDestination: { state: { type: "missing" } },
    content: Buffer.from(randomUUID()),
    mode: 0o600,
  });
}


export async function readComparisonManifestBound(
  root: BoundPromotionDirectory,
  expected: BoundPromotionExpectedLeaf | undefined,
): Promise<{ manifest: ComparisonManifest; leaf: BoundPromotionExpectedLeaf }> {
  const result = await boundPromotionReadFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: ["manifest.json"],
    parentIdentity: promotionIdentityOf(root),
    ...(expected ? { expectedIdentity: expected.identity } : {}),
    maxBytes: MAX_WORLDLINE_FILE_BYTES,
  });
  const parsed = parseComparisonManifest(JSON.parse(result.content.toString("utf8")) as unknown);
  if (!parsed) throw new Error("comparison manifest is invalid");
  return {
    manifest: parsed,
    leaf: {
      identity: result.identity,
      state: { type: "file", mode: 0o600, size: String(result.content.byteLength), sha256: sha256Hex(result.content) },
    },
  };
}
