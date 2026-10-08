import { afterEach, describe, expect, it, vi } from "vitest";
import { Explorer } from "../../../src/components/explorer";

vi.mock("../../../src/components/modals", () => ({ showInput: vi.fn(), showConfirm: vi.fn(), toast: vi.fn(), copyText: vi.fn() }));
vi.mock("../../../src/components/context-menu", () => ({ closeContextMenu: vi.fn(), showContextMenu: vi.fn() }));
import { showInput, showConfirm } from "../../../src/components/modals";

// Exercise the owner's lifecycle without mounting the unrelated rendering helpers.
function harness() {
  const explorer = Object.create(Explorer.prototype) as any;
  Object.assign(explorer, {
    owner: null, readOnly: true, dirs: new Map(), dirViews: new Map(),
    tree: { reset: vi.fn(), renderRoot: vi.fn(), refresh: vi.fn() },
    filter: { reset: vi.fn(), applyFilter: vi.fn() }, keyboard: { reset: vi.fn(), restoreFocus: vi.fn() },
    content: { clearContentResults: vi.fn() }, filterInput: null, filterClearBtn: null,
    expandTimer: null, refresh: vi.fn(), revealDirRel: vi.fn(),
  });
  const bridge = { listDir: vi.fn(), createEntry: vi.fn().mockResolvedValue({ ok: true }), renameEntry: vi.fn().mockResolvedValue({ ok: true }), deleteEntry: vi.fn().mockResolvedValue({ ok: true }), pasteEntry: vi.fn().mockResolvedValue({ ok: true }) };
  vi.stubGlobal("window", { termina: bridge });
  explorer.setProject("project", "/source", "primary", false);
  return { explorer, bridge };
}
const entry = { path: "/source/file.ts", relPath: "file.ts", name: "file.ts", type: "file" };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Explorer workspace ownership", () => {
  it("freezes explicit ownership and sends it for every mutation", async () => {
    const { explorer, bridge } = harness();
    vi.mocked(showInput).mockResolvedValue({ cancelled: false, value: "new.ts" });
    vi.mocked(showConfirm).mockResolvedValue({ confirmed: true });
    const owner = explorer.owner;
    expect(Object.isFrozen(owner)).toBe(true);
    await explorer.createAt("", "file");
    await explorer.renameAt(entry);
    await explorer.deleteAt(entry);
    explorer.copyEntry(entry);
    await explorer.pasteAt("");
    await explorer.moveDragged(entry, "folder");
    for (const action of [bridge.createEntry, bridge.renameEntry, bridge.deleteEntry, bridge.pasteEntry]) {
      expect(action.mock.calls.every(([actual]) => actual === owner)).toBe(true);
      expect(action).toHaveBeenCalled();
    }
    expect(owner).toEqual({ projectId: "project", workspaceId: "primary" });
  });

  it("refuses candidate mutations, menus and native commands without IPC or modals", async () => {
    const { explorer, bridge } = harness();
    explorer.setProject("project", "/candidate", "candidate", true);
    explorer.selected = entry;
    for (const command of ["new-file", "new-folder", "rename", "delete"]) explorer.handleCommand(command);
    await explorer.createAt("", "file");
    await explorer.renameAt(entry);
    await explorer.deleteAt(entry);
    explorer.copyEntry(entry);
    explorer.cutEntry(entry);
    await explorer.pasteAt("");
    expect(await explorer.moveDragged(entry, "folder")).toBe(false);
    expect(explorer.canDrop("folder")).toBe(false);
    expect(explorer.clipboardEntry).toBeNull();
    expect(showInput).not.toHaveBeenCalled();
    expect(showConfirm).not.toHaveBeenCalled();
    for (const action of [bridge.createEntry, bridge.renameEntry, bridge.deleteEntry, bridge.pasteEntry]) expect(action).not.toHaveBeenCalled();
    for (const item of explorer.entryMenuItems(entry)) {
      if (["Cut", "Copy", "Paste", "Rename", "Delete"].includes(item.label)) expect(item.disabled).toBe(true);
    }
    expect(explorer.entryMenuItems(entry).find((item: any) => item.label === "Open").disabled).toBeFalsy();
  });

  it("resets clipboard and drag and fences an old menu on a same-project workspace switch", () => {
    const { explorer } = harness();
    explorer.copyEntry(entry);
    explorer.dragSrc = entry;
    const oldMenu = explorer.entryMenuItems(entry);
    explorer.setProject("project", "/candidate", "candidate", true);
    explorer.setProject("project", "/source", "primary", false);
    oldMenu.find((item: any) => item.label === "Cut").action();
    expect(explorer.clipboardEntry).toBeNull();
    expect(explorer.dragSrc).toBeNull();
  });

  it.each(["create", "rename", "delete"])("fences pending %s modal across candidate and source", async (kind) => {
    const { explorer, bridge } = harness();
    let resolve!: (value: any) => void;
    const pending = new Promise<any>((done) => { resolve = done; });
    vi.mocked(showInput).mockReturnValue(pending);
    vi.mocked(showConfirm).mockReturnValue(pending);
    const action = kind === "create" ? explorer.createAt("", "file") : kind === "rename" ? explorer.renameAt(entry) : explorer.deleteAt(entry);
    explorer.setProject("project", "/candidate", "candidate", true);
    explorer.setProject("project", "/source", "primary", false);
    resolve({ cancelled: false, value: "new.ts", confirmed: true });
    await action;
    expect(bridge.createEntry).not.toHaveBeenCalled();
    expect(bridge.renameEntry).not.toHaveBeenCalled();
    expect(bridge.deleteEntry).not.toHaveBeenCalled();
  });

  it("lists the candidate owner and fences its pending load when returning to source", async () => {
    const { explorer, bridge } = harness();
    explorer.setProject("project", "/candidate", "candidate", true);
    let resolve!: (value: any) => void;
    bridge.listDir.mockReturnValue(new Promise((done) => { resolve = done; }));
    const state = { expanded: true, loaded: true, loadSeq: 0 };
    const children = { replaceChildren: vi.fn() };
    const candidate = { ...entry, path: "/candidate", name: "candidate", relPath: "", type: "dir" };
    const action = explorer.renderChildren(children, candidate, state, true);
    expect(bridge.listDir).toHaveBeenCalledWith({ projectId: "project", workspaceId: "candidate" }, "/candidate");
    explorer.setProject("project", "/source", "primary", false);
    resolve({ entries: [entry] });
    await action;
    expect(children.replaceChildren).not.toHaveBeenCalled();
    expect(explorer.dirs.size).toBe(0);
  });
});
