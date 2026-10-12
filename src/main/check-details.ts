import type { TerminaBridge } from "../../shared/types";

/** Lazy, exact-generation report reader for the workspace Checks panel. */
export function createCheckDetails(bindings: {
  report: HTMLElement;
  getVerifyReport: TerminaBridge["getVerifyReport"];
  isCurrent(): boolean;
}): {
  sync(terminal: { terminalId: string; generation: number } | null, contextKey: string): void;
  show(): Promise<boolean>;
  dispose(): void;
} {
  const { report } = bindings;
  let target: { terminalId: string; generation: number } | null = null;
  let key = "";
  let sequence = 0;
  let disposed = false;
  function invalidate(): void {
    sequence++;
    report.hidden = true;
    report.textContent = "";
    report.setAttribute("aria-busy", "false");
  }
  invalidate();
  return {
    sync: (terminal, contextKey) => {
      if (disposed) return;
      if (key !== contextKey) invalidate();
      key = contextKey;
      target = terminal;
    },
    show: async () => {
      if (disposed || !target || !bindings.isCurrent()) return false;
      const terminal = target;
      const revision = ++sequence;
      const current = (): boolean => !disposed && revision === sequence && bindings.isCurrent();
      report.hidden = false;
      report.textContent = "Loading check details…";
      report.setAttribute("aria-busy", "true");
      try {
        const text = await bindings.getVerifyReport(terminal.terminalId, terminal.generation);
        if (!current()) return false;
        report.textContent = text ?? "Check details unavailable for this terminal generation. Refresh work or open the terminal.";
        return text !== null;
      } catch {
        if (current()) report.textContent = "Could not load check details. Try again or open the terminal.";
        return false;
      } finally {
        if (current()) report.setAttribute("aria-busy", "false");
      }
    },
    dispose: () => { disposed = true; target = null; invalidate(); },
  };
}
