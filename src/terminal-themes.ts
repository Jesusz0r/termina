import type { ITheme } from "@xterm/xterm";
import type { ThemeId } from "../shared/types";
import { THEME_TOKENS, type ThemeTokens } from "./theme-tokens.gen";

const CORE_EXTENDED: Record<ThemeId, string[]> = {
  dark: ["#16324a", "#163a28", "#4a1818"],
  light: ["#c5ddf6", "#c5e6d0", "#f5c8c8"],
  "high-contrast": ["#003366", "#004422", "#550000"],
  atom: ["#1c3148", "#1e3a2a", "#4a2024"],
};

/** Slots below read the generated styles.css tokens where the value is that
 *  token; the remaining literals are ANSI-only hues with no token counterpart
 *  (each written once per theme and shared with its bright twin). */
function darkTerminal(t: ThemeTokens): ITheme {
  const magenta = "#c586c0";
  const cyan = "#56d4dd";
  return {
    background: t.bg,
    foreground: t.text,
    cursor: t.accent,
    cursorAccent: t.bg,
    selectionBackground: t.selection,
    black: t.bgPanel,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.purple,
    magenta,
    cyan,
    white: t.text,
    brightBlack: t.textDim,
    brightRed: t.red,
    brightGreen: t.green,
    brightYellow: t.yellow,
    brightBlue: t.accent,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: t.text,
  };
}

function lightTerminal(t: ThemeTokens): ITheme {
  const black = "#24292f";
  const cyan = "#09757c";
  const brightCyan = "#0a7b83";
  const brightWhite = "#ffffff";
  return {
    background: t.bgPanel,
    foreground: t.text,
    cursor: t.accent,
    cursorAccent: t.bg,
    selectionBackground: t.selection,
    black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.accent,
    magenta: t.purple,
    cyan,
    white: t.bg,
    brightBlack: t.textDim,
    brightRed: t.red,
    brightGreen: t.green,
    brightYellow: t.yellow,
    brightBlue: t.accent,
    brightMagenta: t.purple,
    brightCyan,
    brightWhite,
  };
}

function highContrastTerminal(t: ThemeTokens): ITheme {
  const cyan = "#56d4dd";
  return {
    background: t.bg,
    foreground: t.text,
    cursor: t.text,
    cursorAccent: t.bg,
    selectionBackground: t.selection,
    black: t.bg,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.accent,
    magenta: t.purple,
    cyan,
    white: t.text,
    brightBlack: t.textDim,
    brightRed: t.red,
    brightGreen: t.green,
    brightYellow: t.yellow,
    brightBlue: t.accent,
    brightMagenta: t.purple,
    brightCyan: cyan,
    brightWhite: t.text,
  };
}

function atomTerminal(t: ThemeTokens): ITheme {
  const cyan = "#56b6c2";
  const brightBlack = "#8b92a0";
  const brightWhite = "#ffffff";
  return {
    background: t.bgPanel,
    foreground: t.text,
    cursor: t.accent,
    cursorAccent: t.bgPanel,
    selectionBackground: t.selection,
    black: t.bg,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.accent,
    magenta: t.purple,
    cyan,
    white: t.text,
    brightBlack,
    brightRed: t.red,
    brightGreen: t.green,
    brightYellow: t.yellow,
    brightBlue: t.accent,
    brightMagenta: t.purple,
    brightCyan: cyan,
    brightWhite,
  };
}

/** xterm palettes keyed by the app theme id. Agent-core uses blue as the
 *  accent and bright black as dim text. */
export const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
  dark: darkTerminal(THEME_TOKENS.dark),
  light: lightTerminal(THEME_TOKENS.light),
  "high-contrast": highContrastTerminal(THEME_TOKENS["high-contrast"]),
  atom: atomTerminal(THEME_TOKENS.atom),
};

export function terminalTheme(theme: ThemeId, engine?: "core"): ITheme {
  const base = TERMINAL_THEMES[theme];
  if (engine !== "core") return base;
  return { ...base, extendedAnsi: [...CORE_EXTENDED[theme]] };
}
