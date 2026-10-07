import type { CanonicalizePath, PlanTask, PlanTaskCreateResult } from "../../shared/types.js";
import { createPendingPlanTask, planTaskTextError } from "../plan-board.js";

/** Main supplies exact snapshot/lifecycle reads; mutation happens only after derivation. */
export async function appendPlanTask(host: {
  text: string;
  root: string;
  plan: PlanTask[];
  currentError(): string | null;
  canonicalize: CanonicalizePath;
  publish(): void;
}): Promise<PlanTaskCreateResult> {
  const error = host.currentError() ?? planTaskTextError(host.text, host.plan);
  if (error) return { ok: false, error };
  let task: PlanTask;
  try {
    task = await createPendingPlanTask(host.text, host.root, host.canonicalize);
  } catch (error) {
    return { ok: false, error: `Could not derive task paths: ${error instanceof Error ? error.message : String(error)}` };
  }
  const changed = host.currentError() ?? planTaskTextError(host.text, host.plan);
  if (changed) return { ok: false, error: changed };
  host.plan.push(task);
  host.publish();
  return { ok: true, task };
}
