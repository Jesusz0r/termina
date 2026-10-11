import type { AgentTerminalInstance } from "../terminal-instance.js";

/** Canonical baseline semantics for Change Review. */
export async function reviewBaseline(inst: Pick<AgentTerminalInstance, "baselines" | "baselineFills" | "modified">, path: string, live: () => boolean) {
  if (!inst.baselines.has(path)) {
    const pending = inst.baselineFills.get(path);
    if (pending) await pending;
  }
  if (!live()) return { status: "modified" as const, baseline: undefined };
  const status = inst.modified.get(path)?.status;
  const baseline = inst.baselines.get(path);
  if (baseline === undefined) return { status: status === "deleted" ? "deleted" as const : "modified" as const, baseline: undefined };
  if (baseline === null) return { status: "created" as const, baseline: null };
  return { status: status === "deleted" ? "deleted" as const : "modified" as const, baseline };
}
