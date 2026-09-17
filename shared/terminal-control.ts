/** Private thinking-visibility controls for core terminals. */

export const SHOW_THINKING_CSI = "\x1b[?9001h";
export const HIDE_THINKING_CSI = "\x1b[?9001l";
/** Bracketed paste (DECSET 2004). Written to xterm on attach; never forged at paste. */
export const BRACKETED_PASTE_ENABLE_CSI = "\x1b[?2004h";
export const BRACKETED_PASTE_DISABLE_CSI = "\x1b[?2004l";
const HIDE_THINKING_ARG = "--hide-thinking";

export function thinkingStartupArgs(showThinking: boolean): string[] {
  return showThinking ? [] : [HIDE_THINKING_ARG];
}

export function parseHideThinking(argv: string[]): boolean {
  return argv.includes(HIDE_THINKING_ARG);
}

/** Quote one argument for POSIX shell execution. */
export function quoteShellArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Collapse CR/LF variants from xterm copy/paste to `\n`.
 *
 * Trailing spaces are kept: TUI chrome no longer writes fill cells
 * (`clip` / `paintRow` / `paintBoxContentRow`). Trimming them here would
 * drop significant whitespace from copied source.
 */
export function normalizeCopiedTerminalText(text: string): string {
  return text.replace(/\r\n|\n\r|\n|\r/g, "\n");
}
