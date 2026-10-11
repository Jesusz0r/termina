import type { ReviewTarget, TerminaBridge, VerifyInfo } from "../../shared/types";
import { createCheckDetails } from "./check-details";

interface CheckContext {
  target: ReviewTarget;
  activationGeneration: number;
  verify: VerifyInfo;
}

/** Contextual check inspection. Selection never executes or cancels a check. */
export function createChecksPanel(bindings: {
  element: HTMLElement;
  getVerifyReport: TerminaBridge["getVerifyReport"];
  getContext(): CheckContext | null;
}): { syncContext(): void; showCheck(): Promise<boolean>; focus(): void; dispose(): void } {
  const { element } = bindings;
  const context = element.querySelector<HTMLElement>(".checks-context")!;
  const button = element.querySelector<HTMLButtonElement>(".checks-details")!;
  const report = element.querySelector<HTMLElement>(".checks-report")!;
  const keyOf = (value: CheckContext | null): string => value ? JSON.stringify(value) : "";
  let contextKey = "";
  const details = createCheckDetails({ report, getVerifyReport: bindings.getVerifyReport,
    isCurrent: () => contextKey === keyOf(bindings.getContext()) });
  function syncContext(): void {
    const value = bindings.getContext();
    contextKey = keyOf(value);
    details.sync(value?.target ?? null, contextKey);
    button.disabled = !value;
    context.textContent = value ? `${value.target.terminalId} · ${value.target.root}\n`
      + `${value.verify.state === "untested" ? "Not run" : value.verify.state === "stale" ? "Outdated" : value.verify.state}`
      + (value.verify.command ? ` · ${value.verify.command}` : "")
      + (value.verify.state === "stale" && value.verify.result ? ` · historical ${value.verify.result.state} (exit ${value.verify.result.exitCode ?? "unknown"})` : "")
      + (value.verify.staleReason ? `\n${value.verify.staleReason}` : "")
      : "Select an agent terminal to inspect its checks. Checks are unavailable for shells.";
  }
  const onDetails = (): void => { void details.show(); };
  button.addEventListener("click", onDetails);
  button.disabled = true;
  return {
    syncContext,
    showCheck: () => { syncContext(); return details.show(); },
    focus: () => button.focus(),
    dispose: () => { button.removeEventListener("click", onDetails); details.dispose(); },
  };
}
