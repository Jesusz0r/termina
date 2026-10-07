import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("../../../src/components/modals", () => ({ toast: vi.fn() }));

import { PtyView } from "../../../src/pty-view.ts";

function fixture() {
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  const container = { clientWidth: 960, clientHeight: 600 };
  const proposeDimensions = vi.fn(() => ({ cols: 120, rows: 30 }));
  const resize = vi.fn();
  const view = Object.assign(Object.create(PtyView.prototype), {
    disposed: false, visible: false, watchdog: null, refreshFont: false, container,
    term: { element: { parentElement: container }, cols: 80, rows: 24, textarea: null, resize },
    fitAddon: { proposeDimensions }, correctedCols: (_parent: unknown, cols: number) => cols,
    readScrollAnchor: () => ({ pinToBottom: true, fromBottom: 0 }), restoreScrollAnchor: vi.fn(),
  }) as PtyView;
  return { view, proposeDimensions, resize };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PTY visibility and sizing", () => {
  it("keeps measurable background terminals from sending resizes until activation", () => {
    vi.useFakeTimers();
    const { view, proposeDimensions, resize } = fixture();
    view.fit();
    expect(proposeDimensions).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    view.setVisible(true);
    view.fit();
    expect(resize).toHaveBeenCalledExactlyOnceWith(120, 30);
    view.setVisible(false);
    view.fit();
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("does not resize the active terminal when its work pane is minimized", () => {
    const { view, proposeDimensions } = fixture();
    Object.assign(view, { visible: true });
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "hidden" }));
    view.fit();
    expect(proposeDimensions).not.toHaveBeenCalled();
  });

  it("does not fit a disposed view even while marked visible", () => {
    const { view, proposeDimensions } = fixture();
    Object.assign(view, { disposed: true, visible: true });
    view.fit();
    expect(proposeDimensions).not.toHaveBeenCalled();
  });
});
