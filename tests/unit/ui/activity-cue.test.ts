import { describe, expect, it } from "vitest";
import {
  activityCueShouldSound,
  forgetActivityCue,
  noteActivityCue,
  playActivityChime,
} from "../../../src/activity-cue.ts";

describe("activityCueShouldSound", () => {
  it("stays silent on first paint and unchanged state", () => {
    expect(activityCueShouldSound(undefined, "idle")).toBe(false);
    expect(activityCueShouldSound("working", "working")).toBe(false);
    expect(activityCueShouldSound("idle", "working")).toBe(false);
  });

  it("chimes when a background terminal settles or blocks", () => {
    expect(activityCueShouldSound("working", "idle", { viewing: false })).toBe(true);
    expect(activityCueShouldSound("working", "blocked", { viewing: false })).toBe(true);
    expect(activityCueShouldSound("idle", "blocked")).toBe(true);
    expect(activityCueShouldSound("blocked", "idle")).toBe(true);
  });

  it("stays silent when that terminal is already in front of a focused window", () => {
    expect(activityCueShouldSound("working", "idle", { viewing: true })).toBe(false);
    expect(activityCueShouldSound("working", "blocked", { viewing: true, windowFocused: true })).toBe(false);
  });

  it("still chimes when the window is in the background", () => {
    expect(activityCueShouldSound("working", "idle", { viewing: true, windowFocused: false })).toBe(true);
    expect(activityCueShouldSound("working", "blocked", { viewing: true, windowFocused: false })).toBe(true);
  });
});

describe("noteActivityCue", () => {
  it("plays once per terminal transition unless that terminal is in front", () => {
    const heard: string[] = [];
    const play = (kind: "idle" | "blocked") => {
      heard.push(kind);
    };
    noteActivityCue("t1", "idle", { viewing: false, play });
    noteActivityCue("t1", "working", { viewing: false, play });
    noteActivityCue("t1", "idle", { viewing: true, play });
    expect(heard).toEqual([]);
    noteActivityCue("t1", "working", { viewing: false, play });
    noteActivityCue("t1", "idle", { viewing: false, play });
    noteActivityCue("t1", "blocked", { viewing: false, play });
    expect(heard).toEqual(["idle", "blocked"]);
    forgetActivityCue("t1");
    heard.length = 0;
    noteActivityCue("t1", "idle", { viewing: false, play });
    expect(heard).toEqual([]);
  });
});

describe("playActivityChime", () => {
  function fakeSink(): { freqs: number[]; starts: number[]; sink: Parameters<typeof playActivityChime>[1] } {
    const freqs: number[] = [];
    const starts: number[] = [];
    return {
      freqs,
      starts,
      sink: {
        currentTime: 1,
        destination: {} as AudioNode,
        createOscillator() {
          return {
            type: "sine",
            frequency: {
              get value() {
                return freqs[freqs.length - 1] ?? 0;
              },
              set value(v: number) {
                freqs.push(v);
              },
            },
            connect() {},
            start() {
              starts.push(1);
            },
            stop() {},
          } as unknown as OscillatorNode;
        },
        createGain() {
          return {
            gain: {
              setValueAtTime() {},
              linearRampToValueAtTime() {},
              exponentialRampToValueAtTime() {},
            },
            connect() {},
          } as unknown as GainNode;
        },
      },
    };
  }

  it("drives two sine tones into the sink", () => {
    const idle = fakeSink();
    playActivityChime("idle", idle.sink);
    expect(idle.starts).toHaveLength(2);
    expect(idle.freqs).toEqual([523.25, 783.99]);
    const blocked = fakeSink();
    playActivityChime("blocked", blocked.sink);
    expect(blocked.freqs).toEqual([392, 311.13]);
  });
});
