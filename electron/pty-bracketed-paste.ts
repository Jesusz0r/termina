/**
 * Track DECSET 2004 (bracketed paste) from PTY output so a late-attached
 * xterm can restore the mode the child already enabled.
 *
 * Replay only retains unacked chunks; the original `\x1b[?2004h` is often
 * already retired. This tracker is the surviving source of truth.
 */

const MAX_REMNANT = 64;
const PARAM_START = 0x30;
const PARAM_END = 0x3f;
const FINAL_START = 0x40;
const FINAL_END = 0x7e;
const FINAL_SET = 0x68; // h
const FINAL_RESET = 0x6c; // l

/** Streaming scanner for CSI ? ... h/l with parameter 2004. */
export class BracketedPasteModeTracker {
  private _enabled = false;
  private remnant = "";

  get enabled(): boolean {
    return this._enabled;
  }

  feed(chunk: string): void {
    if (chunk.length === 0) return;
    const text = this.remnant ? this.remnant + chunk : chunk;
    this.remnant = "";
    let i = 0;
    while (i < text.length) {
      const esc = text.indexOf("\x1b", i);
      if (esc < 0) return;
      if (esc + 2 >= text.length) {
        this.hold(text.slice(esc));
        return;
      }
      if (text[esc + 1] !== "[" || text[esc + 2] !== "?") {
        i = text[esc + 1] === "[" ? esc + 2 : esc + 1;
        continue;
      }
      let j = esc + 3;
      while (j < text.length) {
        const code = text.charCodeAt(j);
        if (code < PARAM_START || code > PARAM_END) break;
        j++;
      }
      if (j >= text.length) {
        this.hold(text.slice(esc));
        return;
      }
      const final = text.charCodeAt(j);
      if (final < FINAL_START || final > FINAL_END) {
        i = j;
        continue;
      }
      if ((final === FINAL_SET || final === FINAL_RESET) && hasDecParam(text, esc + 3, j, 2004)) {
        this._enabled = final === FINAL_SET;
      }
      i = j + 1;
    }
  }

  private hold(partial: string): void {
    this.remnant = partial.length > MAX_REMNANT ? "" : partial;
  }
}

function hasDecParam(text: string, start: number, end: number, value: number): boolean {
  let n = 0;
  let digits = 0;
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x3b) {
      if (digits > 0 && n === value) return true;
      n = 0;
      digits = 0;
      continue;
    }
    if (code < 0x30 || code > 0x39) {
      n = 0;
      digits = 0;
      continue;
    }
    n = n * 10 + (code - 0x30);
    digits++;
  }
  return digits > 0 && n === value;
}
