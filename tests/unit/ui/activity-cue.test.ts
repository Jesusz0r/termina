import { describe, expect, it } from "vitest";
import {
  activityCueCopy,
  activityCueIsWatching,
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

  it("stays silent when that terminal's TUI already has focus in a focused window", () => {
    expect(activityCueShouldSound("working", "idle", { viewing: true })).toBe(false);
    expect(activityCueShouldSound("working", "blocked", { viewing: true, windowFocused: true })).toBe(false);
  });

  it("still chimes when the window is in the background", () => {
    expect(activityCueShouldSound("working", "idle", { viewing: true, windowFocused: false })).toBe(true);
    expect(activityCueShouldSound("working", "blocked", { viewing: true, windowFocused: false })).toBe(true);
  });
});

describe("activityCueIsWatching", () => {
  it("is false for a pane in a background project even if that xterm kept DOM focus", () => {
    expect(activityCueIsWatching({
      paneProjectId: "b",
      activeProjectId: "a",
      activePane: true,
      tuiFocused: true,
    })).toBe(false);
  });

  it("is true only for the focused TUI of the project in front", () => {
    expect(activityCueIsWatching({
      paneProjectId: "a",
      activeProjectId: "a",
      activePane: true,
      tuiFocused: true,
    })).toBe(true);
    expect(activityCueIsWatching({
      paneProjectId: "a",
      activeProjectId: "a",
      activePane: true,
      tuiFocused: false,
    })).toBe(false);
    expect(activityCueIsWatching({
      paneProjectId: "a",
      activeProjectId: "a",
      activePane: false,
      tuiFocused: true,
    })).toBe(false);
  });
});

describe("noteActivityCue", () => {
  it("plays once per terminal transition unless that terminal is in front", () => {
    const heard: string[] = [];
    const play = (kind: "idle" | "blocked") => {
      heard.push(kind);
    };
    expect(noteActivityCue("t1", "idle", { viewing: false, play })).toBeNull();
    noteActivityCue("t1", "working", { viewing: false, play });
    expect(noteActivityCue("t1", "idle", { viewing: true, play })).toBeNull();
    expect(heard).toEqual([]);
    noteActivityCue("t1", "working", { viewing: false, play });
    expect(noteActivityCue("t1", "idle", { viewing: false, play })).toBe("idle");
    expect(noteActivityCue("t1", "blocked", { viewing: false, play })).toBe("blocked");
    expect(heard).toEqual(["idle", "blocked"]);
    forgetActivityCue("t1");
    heard.length = 0;
    expect(noteActivityCue("t1", "idle", { viewing: false, play })).toBeNull();
    expect(heard).toEqual([]);
  });
});

describe("activityCueCopy", () => {
  it("names the project, and the terminal when it distinguishes the agent", () => {
    expect(activityCueCopy({ kind: "idle", project: "pi-editor" })).toBe("pi-editor is idle");
    expect(activityCueCopy({ kind: "blocked", project: "pi-editor", terminal: "dispatch" })).toBe(
      "pi-editor · dispatch needs you",
    );
    expect(activityCueCopy({ kind: "idle", project: "pi-editor", terminal: "pi-editor" })).toBe("pi-editor is idle");
    expect(activityCueCopy({ kind: "idle", project: "  ", terminal: "A" })).toBe("project · A is idle");
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
