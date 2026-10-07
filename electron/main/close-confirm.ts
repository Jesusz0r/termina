import type { MessageBoxOptions } from "electron";

/** Main-owned facts. Shell command activity is unknown, not inferred from output. */
export interface TerminalCloseImpact {
  id: string;
  generation: number;
  projectRoot: string | null;
  cwd: string;
  type: "agent" | "shell";
  working: boolean;
  exited: boolean;
  runId: string | null;
  dispatchTask: string | null;
  taskText: string | null;
  promptPayloadFile: string | null;
  childRunIds: string[];
  verifying: boolean;
  verifyPid: number | null;
  changedFiles: number;
}

export interface CandidateCloseImpact {
  projectRoot: string;
  count: number;
  comparisonIds: string[];
}

export function closeTaskText(text: string | null | undefined): string | null {
  if (!text) return null;
  const preview = text.slice(0, 240).replace(/\s+/g, " ").trim();
  return preview ? preview + (text.length > 240 ? "…" : "") : null;
}

export function needsCloseConfirmation(impact: TerminalCloseImpact): boolean {
  return (impact.type === "shell" && !impact.exited) || impact.working || impact.dispatchTask !== null
    || impact.childRunIds.length > 0 || impact.verifying || impact.changedFiles > 0;
}

function terminalDescription(impact: TerminalCloseImpact): string {
  const kind = impact.dispatchTask !== null ? "dispatch worker"
    : impact.exited ? `exited ${impact.type}`
    : impact.type === "shell" ? "shell (command activity unknown)"
    : impact.working ? "active agent" : "idle agent";
  const details = [
    `${impact.id} — ${kind} — ${impact.projectRoot ?? impact.cwd}`,
  ];
  const task = impact.dispatchTask ?? impact.taskText;
  if (task !== null) details.push(`  Task: ${task}`);
  else if (impact.working) details.push("  Task description unavailable");
  if (impact.childRunIds.length > 0) details.push(`  ${impact.childRunIds.length} background child run(s): ${impact.childRunIds.join(", ")}`);
  if (impact.verifying) details.push("  Verification in progress (starting, running, or finishing)");
  if (impact.changedFiles > 0) details.push(`  ${impact.changedFiles} file(s) in Change Review`);
  return details.join("\n");
}

/** One presentation for terminal, project, and application lifecycle gates. */
export function closeConfirmation(
  scope: { kind: "terminal" | "interrupt"; id: string } | { kind: "project"; root: string } | { kind: "app" },
  terminals: TerminalCloseImpact[],
  candidates: CandidateCloseImpact[] = [],
): MessageBoxOptions | null {
  if (!candidates.some((candidate) => candidate.count > 0) && !terminals.some(needsCloseConfirmation)) return null;
  const interrupt = scope.kind === "interrupt";
  const message = scope.kind === "project" ? `Close project ${scope.root}?`
    : scope.kind === "app" ? "Quit Termina?"
    : interrupt ? `Send Ctrl+C to ${scope.id}?` : `Close terminal ${scope.id}?`;
  const consequences = interrupt
    ? "This sends Ctrl+C to the terminal's foreground work; it does not close the terminal. Background child runs and separate verification commands are not directly stopped. If the owner exits, its background child runs are terminated."
    : "Closing ends the listed terminal sessions, stops their background child runs, and cancels their verification commands. Running commands are interrupted or terminated; separately detached processes are not guaranteed to stop. This is not a detach or a switch to background work. Files already written are not reverted. Terminal-local Change Review state is removed.";
  const details = [consequences, ...terminals.map(terminalDescription)];
  for (const candidate of candidates) {
    if (candidate.count === 0) continue;
    details.push(`${candidate.count} candidate(s) in ${candidate.projectRoot} have source changes or session activity. Their work areas and activity will be discarded, except recovery files retained when cleanup cannot safely finish. Export anything you need before closing.`);
  }
  if (scope.kind === "project") details.push("Other projects remain open and keep running.");
  if (scope.kind === "terminal" || interrupt) details.push("Other terminal tabs remain open, including separate dispatch workers.");
  return {
    type: "warning",
    title: interrupt ? "Interrupt terminal" : "Close work",
    message,
    detail: details.join("\n\n"),
    buttons: [interrupt ? "Send Ctrl+C" : scope.kind === "app" ? "Quit Termina" : scope.kind === "project" ? "Close project" : "Close terminal", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  };
}
