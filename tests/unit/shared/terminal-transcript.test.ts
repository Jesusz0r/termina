import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalOscUri, terminalTranscriptEntryId, terminalTranscriptUri } from "../../../shared/terminal-link.ts";
import { toggleTranscriptEntryControl } from "../../../shared/terminal-control.ts";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("../../../src/components/modals", () => ({ toast: vi.fn() }));

import { PtyView } from "../../../src/pty-view.ts";

describe("terminal transcript controls", () => {
  it.each([1, 42, Number.MAX_SAFE_INTEGER])("round-trips entry %s", (entryId) => {
    const uri = terminalTranscriptUri(entryId);
    expect(uri).toBe(`termina-transcript:${entryId}`);
    expect(terminalTranscriptEntryId(uri)).toBe(entryId);
    expect(toggleTranscriptEntryControl(entryId)).toBe(`\x1b[?9002;${entryId}h`);
    expect(terminalOscUri(uri)).toBeNull();
  });

  it.each([0, -0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid numeric id %s", (entryId) => {
    expect(() => terminalTranscriptUri(entryId)).toThrow(RangeError);
    expect(() => toggleTranscriptEntryControl(entryId)).toThrow(RangeError);
  });

  it.each([
    "", "termina-transcript:", "termina-transcript:0", "termina-transcript:01",
    "termina-transcript:-1", "termina-transcript:+1", "termina-transcript:1.0",
    "termina-transcript:1e2", "termina-transcript:0x10", "termina-transcript:NaN",
    "termina-transcript:Infinity", "termina-transcript:9007199254740992",
    "termina-transcript:999999999999999999999999999999999999999999999999",
    "termina-transcript: 1", " termina-transcript:1", "termina-transcript:1 ",
    "termina-transcript:1\n", "termina-transcript:1\r\n", "termina-transcript:1\0",
    "termina-transcript:1\x1b[?9002;2h", "termina-transcript:1;2",
    "termina-transcript:1/path", "termina-transcript:1?entry=2", "termina-transcript:1#2",
    "termina-transcript://1", "termina-transcript:%31", "termina-transcript:１",
    "TERMINA-TRANSCRIPT:1", "https://example.com/termina-transcript:1",
    "file://termina.local/?target=termina-transcript:1",
  ])("rejects malformed or forged URI %j", (uri) => {
    expect(terminalTranscriptEntryId(uri)).toBeNull();
  });

  it.each([
    "termina-transcript:1", " termina-transcript:1 ", "TERMINA-TRANSCRIPT:1",
    "termina-transcript:src/app.ts", "termina-transcript://src/app.ts",
  ])("does not promote markdown target %j to an internal link", (target) => {
    expect(terminalOscUri(target)).toBeNull();
  });
});

describe("PtyView transcript link activation", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(overrides: { disposed?: boolean; engine?: "core" | undefined; buffer?: "alternate" | "normal"; selected?: boolean } = {}) {
    const sendInput = vi.fn();
    const onOpenFile = vi.fn();
    const openWeb = vi.fn();
    const view = Object.assign(Object.create(PtyView.prototype), {
      disposed: false,
      engine: "core",
      ...overrides,
      term: { buffer: { active: { type: overrides.buffer ?? "alternate" } }, hasSelection: () => overrides.selected ?? false },
      sendInput,
      onOpenFile,
      openWeb,
    }) as PtyView;
    const activate = (uri = terminalTranscriptUri(42), event: Partial<MouseEvent> = {}) => {
      view["openOscLink"]({ button: 0, detail: 1, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...event } as MouseEvent, uri);
    };
    return { activate, sendInput, onOpenFile, openWeb };
  }

  it("sends the toggle control for a plain primary click", () => {
    const { activate, sendInput, onOpenFile, openWeb } = setup();
    activate();
    expect(sendInput).toHaveBeenCalledExactlyOnceWith("\x1b[?9002;42h");
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(openWeb).not.toHaveBeenCalled();
  });

  it.each([
    { button: 1 }, { button: 2 }, { detail: 0 }, { detail: 2 }, { detail: 3 },
    { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true },
  ])("ignores non-plain clicks %j", (event) => {
    const { activate, sendInput } = setup();
    activate(undefined, event);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it.each([
    { disposed: true }, { engine: undefined }, { buffer: "normal" as const }, { selected: true },
  ])("does not toggle unavailable or selected transcript %j", (state) => {
    const { activate, sendInput } = setup(state);
    activate();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it.each(["MacIntel", "Linux x86_64"])("preserves modifier-only file/web activation on %s", (platform) => {
    vi.stubGlobal("navigator", { platform });
    const { activate, sendInput, onOpenFile, openWeb } = setup();
    const file = terminalOscUri("src/pty-view.ts:12")!;
    const web = "https://example.com/";
    activate(file);
    activate(web);
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(openWeb).not.toHaveBeenCalled();
    const modifier = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
    activate(file, modifier);
    activate(web, modifier);
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("src/pty-view.ts", 12, undefined);
    expect(openWeb).toHaveBeenCalledExactlyOnceWith(web);
    expect(sendInput).not.toHaveBeenCalled();
  });
});
