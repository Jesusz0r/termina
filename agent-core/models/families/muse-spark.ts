import type { EffortLevelMap } from "../capabilities.ts";
import { modelLeaf } from "./identity.ts";

/**
 * Muse Spark reasoning lineage served through relay Responses routes.
 * Leaf-anchored so unrelated ids that merely contain the substring
 * cannot claim the family contract.
 */
export function museSparkReasoningFamily(model: string): boolean {
  return modelLeaf(model).startsWith("muse-spark");
}

/**
 * The route rejects reasoning none with HTTP 400, so off/minimal
 * floor at low instead of mapping to none.
 */
export function museSparkEffortLevelMap(): EffortLevelMap {
  return { off: null, minimal: null };
}
