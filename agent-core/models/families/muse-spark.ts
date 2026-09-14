import type { EffortLevelMap } from "../capabilities.ts";
import { modelLeaf } from "./identity.ts";

/**
 * Muse Spark reasoning lineage on Responses routes.
 * Leaf-anchored so unrelated ids that merely contain the substring
 * cannot claim the family contract.
 */
export function museSparkReasoningFamily(model: string): boolean {
  return modelLeaf(model).startsWith("muse-spark");
}

/**
 * Effort contract, verified 2026-09-14 against the provider reasoning docs:
 * https://ai.developer.meta.com/docs/reasoning/
 * - none is rejected with HTTP 400, so off is hidden and clamps to minimal.
 * - minimal/low/medium/high/xhigh are valid wire values.
 * - max is Standard-tier 1.3 only and unavailable on Contributor-tier
 *   models, so it is offered only when the model id carries no
 *   `-contributor` marker (Contributor ids are marker-bearing, e.g.
 *   `muse-spark-1.3-contributor-free`; Standard ids are bare, e.g.
 *   `muse-spark-1.3`).
 *
 * Assumption: Contributor tier is inferred from a `-contributor` marker in
 * the model id leaf. An unmarked Contributor-tier id would be offered max
 * and would fail at the provider.
 */
export function museSparkEffortLevelMap(model: string): EffortLevelMap {
  if (modelLeaf(model).includes("-contributor")) return { off: null, xhigh: "xhigh" };
  return { off: null, xhigh: "xhigh", max: "max" };
}
