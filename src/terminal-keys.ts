/**
 * Bytes for a navigation chord, or null if xterm should encode the key.
 *
 * xterm.js emits CSI `1;<mod>X` for every modified navigation key. That
 * encoding is only valid after the child enables modifyOtherKeys or the
 * kitty keyboard protocol. Until then the unbound tail is inserted.
 * Command is not a transmitted modifier: xterm drops it, so those chords
 * stay terminal-local. Option is Meta, the legacy encoding, only while
 * reporting is off.
 */
export type LineEditKey = {
  type: string;
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
};

export type LineEditMode = {
  modifierReporting: boolean;
  applicationCursor: boolean;
};

type Nav = "left" | "right" | "up" | "down" | "home" | "end" | "delete" | "pageup" | "pagedown" | "fn";

function navKey(event: LineEditKey): { which: Nav; fn: number } | null {
  const name = event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End"
    || event.key === "Delete" || event.key.startsWith("Page") || /^F(?:[1-9]|1[0-2])$/.test(event.key)
    ? event.key
    : event.code;
  switch (name) {
    case "ArrowLeft": return { which: "left", fn: 0 };
    case "ArrowRight": return { which: "right", fn: 0 };
    case "ArrowUp": return { which: "up", fn: 0 };
    case "ArrowDown": return { which: "down", fn: 0 };
    case "Home": return { which: "home", fn: 0 };
    case "End": return { which: "end", fn: 0 };
    case "Delete": return { which: "delete", fn: 0 };
    case "PageUp": return { which: "pageup", fn: 0 };
    case "PageDown": return { which: "pagedown", fn: 0 };
    default: {
      const fn = /^F(\d+)$/.exec(name);
      return fn ? { which: "fn", fn: Number(fn[1]) } : null;
    }
  }
}

/** Unmodified sequence xterm would send for this key. */
function legacy(which: Nav, fn: number, applicationCursor: boolean): string {
  if (which === "left") return applicationCursor ? "\x1bOD" : "\x1b[D";
  if (which === "right") return applicationCursor ? "\x1bOC" : "\x1b[C";
  if (which === "up") return applicationCursor ? "\x1bOA" : "\x1b[A";
  if (which === "down") return applicationCursor ? "\x1bOB" : "\x1b[B";
  if (which === "home") return applicationCursor ? "\x1bOH" : "\x1b[H";
  if (which === "end") return applicationCursor ? "\x1bOF" : "\x1b[F";
  if (which === "delete") return "\x1b[3~";
  if (which === "pageup") return "\x1b[5~";
  if (which === "pagedown") return "\x1b[6~";
  if (fn >= 1 && fn <= 4) return `\x1bO${"PQRS"[fn - 1]}`;
  const tilde: Record<number, number> = { 5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24 };
  const code = tilde[fn];
  return code === undefined ? "" : `\x1b[${code}~`;
}

/**
 * Bytes to write, or null if xterm should handle the key. An empty string
 * means swallow the key and write nothing.
 */
export function shellLineEdit(event: LineEditKey, mode: LineEditMode): string | null {
  if (event.type !== "keydown" || event.isComposing) return null;
  const nav = navKey(event);
  if (!nav) return null;
  const modified = event.shiftKey || event.ctrlKey || event.altKey || event.metaKey;
  if (!modified) return null;
  // Shift+Page scrolls the viewport. xterm does not send it to the pty.
  if ((nav.which === "pageup" || nav.which === "pagedown")
    && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    return null;
  }
  // Command never reaches the pty. xterm drops meta+arrow.
  if (event.metaKey && !event.altKey && !event.ctrlKey) {
    if (nav.which === "left" || nav.which === "home") return "\x01";
    if (nav.which === "right" || nav.which === "end") return "\x05";
    if (nav.which === "up") return "\x10";
    if (nav.which === "down") return "\x0e";
    if (nav.which === "delete") return null;
  }
  if (mode.modifierReporting) return null;
  if (event.altKey && !event.ctrlKey) {
    if (nav.which === "left") return "\x1bb";
    if (nav.which === "right") return "\x1bf";
    if (nav.which === "delete") return "\x1bd";
  }
  return legacy(nav.which, nav.fn, mode.applicationCursor);
}
