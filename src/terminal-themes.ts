import type { ThemeId } from "../shared/types";

/** xterm palettes keyed by the app theme id. */
export const TERMINAL_THEMES: Record<ThemeId, Record<string, string>> = {
  dark: {
    background: "#0b0d09", foreground: "#edf2e2", cursor: "#b8f04a", cursorAccent: "#0b0d09", selectionBackground: "#333c26",
    black: "#11140d", red: "#ff7a6b", green: "#86e29b", yellow: "#ffb454", blue: "#7cc4ff", magenta: "#c586c0", cyan: "#56d4dd", white: "#edf2e2",
  },
  light: {
    background: "#eef1f4", foreground: "#1f2328", cursor: "#0969da", selectionBackground: "#b6d7ff",
    black: "#24292f", red: "#cf222e", green: "#1a7f37", yellow: "#9a6700", blue: "#0969da", magenta: "#8250df", cyan: "#0a7b83", white: "#f6f8fa",
  },
  "high-contrast": {
    background: "#000000", foreground: "#ffffff", cursor: "#ffffff", selectionBackground: "#264f78",
    black: "#000000", red: "#ff6b6b", green: "#7ee787", yellow: "#f2cc60", blue: "#79c0ff", magenta: "#d2a8ff", cyan: "#56d4dd", white: "#ffffff",
  },
  atom: {
    background: "#21252b", foreground: "#abb2bf", cursor: "#528bff", selectionBackground: "#3e4451",
    black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
  },
};
