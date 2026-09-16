/**
 * Terminal activity cues: a short Web Audio chime on settle and block,
 * plus the named toast copy that jumps to that terminal. Working is the
 * pulsing tab dot — it does not beep on every prompt. A terminal whose TUI
 * already has keyboard focus in a focused window stays silent.
 */

export type ActivityCueKind = "idle" | "working" | "blocked";

const lastByTerminal = new Map<string, ActivityCueKind>();

export interface ActivityCueContext {
  /** True when this terminal's TUI has keyboard focus in the active project. */
  viewing: boolean;
  /** False when the app window is in the background. Defaults to focused. */
  windowFocused?: boolean;
}

/** First paint is silent. Working stays visual. Idle/blocked chime unless
 *  that terminal's TUI already has keyboard focus in a focused window. */
export function activityCueShouldSound(
  previous: ActivityCueKind | undefined,
  next: ActivityCueKind,
  context: ActivityCueContext = { viewing: false },
): next is "idle" | "blocked" {
  if (previous === undefined || previous === next) return false;
  if (next !== "idle" && next !== "blocked") return false;
  if (context.viewing && (context.windowFocused ?? true)) return false;
  return true;
}

/** True only for the TUI the user is actually typing in — not a hidden
 *  project whose xterm can keep DOM focus after its pane is display:none. */
export function activityCueIsWatching(input: {
  paneProjectId: string | null;
  activeProjectId: string | null;
  activePane: boolean;
  tuiFocused: boolean;
}): boolean {
  return input.paneProjectId === input.activeProjectId && input.activePane && input.tuiFocused;
}

export function forgetActivityCue(terminalId: string): void {
  lastByTerminal.delete(terminalId);
}

export function noteActivityCue(
  terminalId: string,
  next: ActivityCueKind,
  context: ActivityCueContext & { play?: (kind: "idle" | "blocked") => void },
): "idle" | "blocked" | null {
  const previous = lastByTerminal.get(terminalId);
  lastByTerminal.set(terminalId, next);
  if (!activityCueShouldSound(previous, next, context)) return null;
  (context.play ?? playActivityChime)(next);
  return next;
}

/** Project name, plus the terminal when that project has more than one agent. */
export function activityCueCopy(input: {
  kind: "idle" | "blocked";
  project: string;
  terminal?: string;
}): string {
  const project = input.project.trim() || "project";
  const terminal = input.terminal?.trim();
  const who = terminal && terminal !== project ? `${project} · ${terminal}` : project;
  return input.kind === "blocked" ? `${who} needs you` : `${who} is idle`;
}

interface ToneSink {
  currentTime: number;
  destination: AudioNode | null;
  resume?: () => Promise<void>;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
}

let sharedCtx: AudioContext | null | undefined;

function audioSink(): ToneSink | null {
  if (sharedCtx === null) return null;
  if (sharedCtx) return sharedCtx;
  try {
    const Ctor = globalThis.AudioContext;
    if (!Ctor) {
      sharedCtx = null;
      return null;
    }
    sharedCtx = new Ctor();
    return sharedCtx;
  } catch {
    sharedCtx = null;
    return null;
  }
}

function tone(ctx: ToneSink, freq: number, start: number, dur: number, peak: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  if (ctx.destination) {
    osc.connect(gain);
    gain.connect(ctx.destination);
  }
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** Two-note chime. `idle` is a settle; `blocked` is a lower warning. */
export function playActivityChime(kind: "idle" | "blocked", sink: ToneSink | null = audioSink()): void {
  if (!sink) return;
  void sink.resume?.();
  const t = sink.currentTime;
  if (kind === "idle") {
    tone(sink, 523.25, t, 0.12, 0.18);
    tone(sink, 783.99, t + 0.1, 0.16, 0.16);
    return;
  }
  tone(sink, 392.0, t, 0.14, 0.2);
  tone(sink, 311.13, t + 0.12, 0.2, 0.16);
}
