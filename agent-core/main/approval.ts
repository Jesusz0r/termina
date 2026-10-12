import { randomUUID } from "node:crypto";
import type { AgentIntervention } from "../../shared/types.ts";
import type { AgentTui } from "../tui.ts";

type ApprovalSurface = Pick<AgentTui, "active" | "setChoices" | "clearChoices">;
type InterventionEvent =
  | ({ t: "intervention_requested" } & AgentIntervention)
  | ({ t: "intervention_resolved" } & Pick<AgentIntervention, "requestId">);

/** Owns only the human picker lifetime; callers retain permission policy and queueing. */
export class ApprovalPicker {
  private resolve: ((line: string) => void) | null = null;

  private readonly surface: () => ApprovalSurface | null;
  private readonly logEvent: (event: InterventionEvent) => void;

  constructor(surface: () => ApprovalSurface | null, logEvent: (event: InterventionEvent) => void) {
    this.surface = surface;
    this.logEvent = logEvent;
  }

  get pending(): boolean { return this.resolve !== null; }

  answer(line: string): boolean {
    if (!this.resolve) return false;
    const resolve = this.resolve;
    this.resolve = null;
    resolve(line);
    return true;
  }

  cancel(): boolean { return this.answer("/approve deny"); }

  async ask(prompt: string, rows: Parameters<AgentTui["setChoices"]>[1], timeoutMs?: number): Promise<string> {
    const surface = this.surface();
    if (!surface?.active()) return "/approve deny";
    if (this.pending) throw new Error("approval picker is already active");
    const requestId = randomUUID();
    let requested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = new Promise<string>((resolve) => { this.resolve = resolve; });
    try {
      surface.setChoices(prompt, rows);
      this.logEvent({ t: "intervention_requested", requestId, kind: "permission", since: Date.now() });
      requested = true;
      if (timeoutMs !== undefined) timer = setTimeout(() => this.cancel(), Math.max(0, timeoutMs));
      return await answer;
    } finally {
      clearTimeout(timer);
      this.resolve = null;
      try {
        surface.clearChoices();
      } finally {
        if (requested) this.logEvent({ t: "intervention_resolved", requestId });
      }
    }
  }
}
