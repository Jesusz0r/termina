/**
 * First-run login gate: when a fresh TUI has no authenticated provider,
 * prefill `/login` so the provider picker is visible without typing.
 * Pure over caller-supplied state; the engine decides, the TUI renders.
 */

export function shouldAutoOpenLogin(opts: {
  /** A started full-screen TUI exists to render the picker. */
  hasSurface: boolean;
  /** Live session messages; a resumed session never auto-opens. */
  historyLength: number;
  /** A startup-control prefill already owns the composer draft. */
  startupPrefilled: boolean;
  /** A structured startup prompt will run instead of idling. */
  hasStructuredPrompt: boolean;
  /** Headless `--subagent-task` children never touch the TUI. */
  isSubagent: boolean;
  /** `-p/--print` runs headless and exits. */
  isPrintMode: boolean;
  /** Any stored or env credential for a supported provider. */
  hasAuthenticatedProvider: boolean;
}): boolean {
  if (!opts.hasSurface) return false;
  if (opts.historyLength > 0) return false;
  if (opts.startupPrefilled) return false;
  if (opts.hasStructuredPrompt) return false;
  if (opts.isSubagent) return false;
  if (opts.isPrintMode) return false;
  return !opts.hasAuthenticatedProvider;
}
