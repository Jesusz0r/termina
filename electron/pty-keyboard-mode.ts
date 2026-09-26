/**
 * Track whether the PTY child asked for modifier key reporting.
 *
 * xterm.js always emits CSI `1;<mod>X`. That form is only defined once the
 * child enables modifyOtherKeys (`CSI > 4 ; Pv m`, Pv 1 or 2) or the kitty
 * keyboard protocol (`CSI > flags u` / `CSI = flags u`). Until then the
 * tail is unbound and zsh inserts it.
 *
 * https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
 * https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */

const MAX_REMNANT = 64;
const MAX_KITTY_STACK = 8;
const FINAL_START = 0x40;
const FINAL_END = 0x7e;

export class PtyKeyboardModeTracker {
  private modifyOtherKeys = 0;
  private readonly kittyStack: number[] = [];
  private _applicationCursor = false;
  private remnant = "";

  /** Child wants modifier-parameter sequences, not legacy keys. */
  get modifierReporting(): boolean {
    if (this.modifyOtherKeys > 0) return true;
    const top = this.kittyStack[this.kittyStack.length - 1];
    return top !== undefined && top !== 0;
  }

  /** DECSET 1. Legacy arrows are SS3, not CSI. */
  get applicationCursor(): boolean {
    return this._applicationCursor;
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
      if (text[esc + 1] !== "[") {
        i = esc + 1;
        continue;
      }
      const parsed = parseCsi(text, esc + 2);
      if (parsed === "incomplete") {
        this.hold(text.slice(esc));
        return;
      }
      if (parsed) this.apply(parsed);
      i = parsed ? parsed.next : esc + 2;
    }
  }

  private apply(seq: Csi): void {
    if (seq.private === "?" && (seq.final === "h" || seq.final === "l") && hasParam(seq.params, 1)) {
      this._applicationCursor = seq.final === "h";
      return;
    }
    if (seq.private === ">" && seq.final === "m" && seq.params[0] === 4 && seq.params.length >= 2) {
      const level = seq.params[1] ?? 0;
      this.modifyOtherKeys = level === 1 || level === 2 ? level : 0;
      return;
    }
    if (seq.final !== "u") return;
    if (seq.private === ">") {
      this.kittyStack.push(seq.params.length === 0 ? 1 : seq.params[0] ?? 0);
      if (this.kittyStack.length > MAX_KITTY_STACK) this.kittyStack.shift();
      return;
    }
    if (seq.private === "<") {
      this.kittyStack.pop();
      return;
    }
    if (seq.private === "=") {
      const flags = seq.params.length === 0 ? 0 : seq.params[0] ?? 0;
      this.kittyStack.length = 0;
      if (flags !== 0) this.kittyStack.push(flags);
    }
  }

  private hold(partial: string): void {
    this.remnant = partial.length > MAX_REMNANT ? "" : partial;
  }
}

type Csi = {
  private: string;
  params: number[];
  final: string;
  next: number;
};

function parseCsi(text: string, start: number): Csi | "incomplete" | null {
  let i = start;
  let privateMark = "";
  const mark = text[i];
  if (mark === "?" || mark === ">" || mark === "<" || mark === "=") {
    privateMark = mark;
    i++;
  }
  const params: number[] = [];
  let n = 0;
  let digits = 0;
  let sawParam = false;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0x30 && code <= 0x39) {
      n = n * 10 + (code - 0x30);
      digits++;
      sawParam = true;
      i++;
      continue;
    }
    if (code === 0x3b) {
      params.push(digits > 0 ? n : 0);
      n = 0;
      digits = 0;
      sawParam = true;
      i++;
      continue;
    }
    break;
  }
  if (i >= text.length) return "incomplete";
  const final = text.charCodeAt(i);
  if (final < FINAL_START || final > FINAL_END) return null;
  if (sawParam) params.push(digits > 0 ? n : 0);
  return { private: privateMark, params, final: text[i] ?? "", next: i + 1 };
}

function hasParam(params: number[], value: number): boolean {
  return params.includes(value);
}
