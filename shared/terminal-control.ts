/** Private thinking-visibility controls for core terminals. */

export const SHOW_THINKING_CSI = "\x1b[?9001h";
export const HIDE_THINKING_CSI = "\x1b[?9001l";
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
