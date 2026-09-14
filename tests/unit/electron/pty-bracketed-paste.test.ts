import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BracketedPasteModeTracker } from "../../../electron/pty-bracketed-paste.ts";
import {
  BRACKETED_PASTE_DISABLE_CSI,
  BRACKETED_PASTE_ENABLE_CSI,
} from "../../../shared/terminal-control.ts";

describe("BracketedPasteModeTracker (refs #278)", () => {
  it("defaults to off", () => {
    expect(new BracketedPasteModeTracker().enabled).toBe(false);
  });

  it("enables and disables on DECSET/DECRST 2004", () => {
    const tracker = new BracketedPasteModeTracker();
    tracker.feed(BRACKETED_PASTE_ENABLE_CSI);
    expect(tracker.enabled).toBe(true);
    tracker.feed(BRACKETED_PASTE_DISABLE_CSI);
    expect(tracker.enabled).toBe(false);
  });

  it("sees 2004 among combined private-mode parameters", () => {
    const tracker = new BracketedPasteModeTracker();
    tracker.feed("\x1b[?1;2004;7h");
    expect(tracker.enabled).toBe(true);
    tracker.feed("\x1b[?2004;1l");
    expect(tracker.enabled).toBe(false);
  });

  it("survives the core TUI bootstrap CSI run", () => {
    const tracker = new BracketedPasteModeTracker();
    tracker.feed("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?7l");
    expect(tracker.enabled).toBe(true);
    tracker.feed("\x1b[?2026l\x1b[?7h\x1b[?2004l\x1b[?25h\x1b[?1049l");
    expect(tracker.enabled).toBe(false);
  });

  it("reassembles 2004 split across PTY quanta", () => {
    const tracker = new BracketedPasteModeTracker();
    tracker.feed("hello\x1b[?20");
    expect(tracker.enabled).toBe(false);
    tracker.feed("04hworld");
    expect(tracker.enabled).toBe(true);
  });

  it("holds a trailing ESC and completes on the next chunk", () => {
    const tracker = new BracketedPasteModeTracker();
    tracker.feed("\x1b");
    tracker.feed("[?2004h");
    expect(tracker.enabled).toBe(true);
  });

  it("ignores neighboring mode numbers", () => {
    const tracker = new BracketedPasteModeTracker();
    tracker.feed("\x1b[?200h\x1b[?12004h\x1b[?20040h\x1b[2004h");
    expect(tracker.enabled).toBe(false);
  });

  it("keeps the last 2004 decision when a later CSI does not mention it", () => {
    const tracker = new BracketedPasteModeTracker();
    tracker.feed(BRACKETED_PASTE_ENABLE_CSI);
    tracker.feed("\x1b[?25loutput\x1b[H");
    expect(tracker.enabled).toBe(true);
  });
});

describe("bracketed-paste attach handshake (refs #278)", () => {
  const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../../../electron/preload.ts", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
  const ptyView = readFileSync(new URL("../../../src/pty-view.ts", import.meta.url), "utf8");
  const instance = readFileSync(new URL("../../../electron/terminal-instance.ts", import.meta.url), "utf8");

  it("feeds DECSET 2004 only from successfully queued PTY output", () => {
    expect(instance).toContain("notePtyOutput(data: string)");
    expect(instance).toContain("this.bracketedPaste.feed(data)");
    const sendPtyData = main.slice(main.indexOf("private sendPtyData("), main.indexOf("private registerIpc("));
    expect(sendPtyData).toContain("const accepted = this.ptyEgress.enqueue(id, terminalGeneration, data)");
    expect(sendPtyData).toContain("if (accepted) inst.notePtyOutput(data)");
  });

  it("replays DECSET 2004 on pty:ready before hydrate starts the pump", () => {
    const ready = main.slice(main.indexOf('ipcMain.on("pty:ready"'), main.indexOf('ipcMain.on("pty:ack"'));
    const modesAt = ready.indexOf("this.sendPtyModes(");
    const hydrateAt = ready.indexOf("this.ptyEgress.hydrateTerminal(");
    expect(modesAt).toBeGreaterThan(0);
    expect(hydrateAt).toBeGreaterThan(modesAt);
    expect(main).toContain('win.webContents.send("pty:modes"');
    expect(main).toContain("bracketedPasteMode: inst.bracketedPasteMode");
    expect(preload).toContain('onPtyModes: (cb) => bindPushEvent("pty:modes", cb)');
    expect(renderer).toContain("window.termina.onPtyModes");
    expect(renderer).toContain("pane.view.setBracketedPasteMode(bracketedPasteMode)");
  });

  it("sends every text paste through term.paste after xterm mode restore", () => {
    expect(ptyView).toContain("setBracketedPasteMode(enabled: boolean)");
    expect(ptyView).toContain("BRACKETED_PASTE_ENABLE_CSI");
    expect(ptyView).toContain("this.term.paste(result.text)");
    expect(ptyView).not.toContain("${text}\\x1b[201~");
    expect(ptyView).not.toContain("this.engine && /[");
    // Image attach still signals the TUI with paste-end; that is not text wrapping.
    expect(ptyView).toContain("this.sendInput(\"\\x1b[201~\")");
  });
});
