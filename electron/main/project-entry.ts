import type { AgentIntervention } from "../../shared/types.js";

export interface ProjectTerminalChoice {
  id: string;
  generation: number;
  intervention: AgentIntervention | null;
}

/** Input contains only live, admitted terminals in the requested project/workspace.
 * Stable input order breaks equal-age ties and supplies the first-entry default. */
export function chooseProjectTerminal(
  terminals: ProjectTerminalChoice[],
  remembered: { id: string; generation: number } | undefined,
  intent: "entry" | "context",
): ProjectTerminalChoice | null {
  if (intent === "entry") {
    let oldest: ProjectTerminalChoice | null = null;
    for (const terminal of terminals) {
      if (terminal.intervention && (!oldest || terminal.intervention.since < oldest.intervention!.since)) oldest = terminal;
    }
    if (oldest) return oldest;
  }
  return terminals.find((terminal) => terminal.id === remembered?.id && terminal.generation === remembered.generation)
    ?? terminals[0] ?? null;
}

/**
 * Stored project list: open tabs in tab order, plus saved roots that did not
 * open this launch (an unmounted volume) back in their saved slots. Open tabs
 * win the capped list.
 */
export function storedProjectOrder(
  open: readonly string[],
  absent: Iterable<string>,
  stored: readonly string[],
  cap: number,
): string[] {
  const out = [...open];
  for (const root of absent) {
    if (out.includes(root)) continue;
    let at = 0;
    for (let k = stored.indexOf(root) - 1; k >= 0; k--) {
      const j = out.indexOf(stored[k]!);
      if (j >= 0) {
        at = j + 1;
        break;
      }
    }
    out.splice(at, 0, root);
  }
  for (let i = out.length - 1; i >= 0 && out.length > cap; i--) {
    if (!open.includes(out[i]!)) out.splice(i, 1);
  }
  return out;
}
