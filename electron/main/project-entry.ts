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
