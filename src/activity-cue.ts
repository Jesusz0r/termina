/**
 * Terminal activity cues: a short Web Audio chime on settle and block.
 * Working is the pulsing tab dot — it does not beep on every prompt.
 * A terminal already in front of a focused window stays silent.
 */

export type ActivityCueKind = "idle" | "working" | "blocked";

const lastByTerminal = new Map<string, ActivityCueKind>();

export interface ActivityCueContext {
  /** True when this terminal is the active pane. */
  viewing: boolean;
  /** False when the app window is in the background. Defaults to focused. */
  windowFocused?: boolean;
}

/** First paint is silent. Working stays visual. Idle/blocked chime unless
 *  that terminal is already in front of a focused window. */
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

export function forgetActivityCue(terminalId: string): void {
  lastByTerminal.delete(terminalId);
}

export function noteActivityCue(
  terminalId: string,
  next: ActivityCueKind,
  context: ActivityCueContext & { play?: (kind: "idle" | "blocked") => void },
): void {
  const previous = lastByTerminal.get(terminalId);
  lastByTerminal.set(terminalId, next);
  if (!activityCueShouldSound(previous, next, context)) return;
  (context.play ?? playActivityChime)(next);
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

/** Quiet two-note chime. `idle` is a settle; `blocked` is a lower warning. */
export function playActivityChime(kind: "idle" | "blocked", sink: ToneSink | null = audioSink()): void {
  if (!sink) return;
  void sink.resume?.();
  const t = sink.currentTime;
  if (kind === "idle") {
    tone(sink, 523.25, t, 0.12, 0.045);
    tone(sink, 783.99, t + 0.1, 0.16, 0.04);
    return;
  }
  tone(sink, 392.0, t, 0.14, 0.05);
  tone(sink, 311.13, t + 0.12, 0.2, 0.04);
}
