import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom, type FakeDocument, type FakeEl } from "./fake-dom.ts";

type QuickOpenMod = typeof import("../../../src/quick-open.ts");

let QuickOpen: QuickOpenMod["QuickOpen"];
let fake: { document: FakeDocument; modalRoot: FakeEl; cleanup: () => void };
const instances: Array<InstanceType<QuickOpenMod["QuickOpen"]>> = [];
let generation = 0;
const delivered: string[] = [];
const opened: string[] = [];
const pending: Array<{ pattern: string; resolve: (value: unknown) => void }> = [];

beforeAll(async () => {
  fake = installFakeDom();
  (globalThis as { window?: unknown }).window = {
    termina: {
      searchContent: (pattern: string) => new Promise((resolve) => {
        pending.push({ pattern, resolve });
      }),
      searchFiles: () => new Promise(() => {}),
    },
  };
  ({ QuickOpen } = await import("../../../src/quick-open.ts"));
});

afterAll(() => {
  fake.cleanup();
});

function mount(): { qo: InstanceType<QuickOpenMod["QuickOpen"]>; input: FakeEl; root: FakeEl } {
  generation = 0;
  delivered.length = 0;
  opened.length = 0;
  pending.length = 0;
  const qo = new QuickOpen();
  instances.push(qo);
  qo.bind({
    onOpenFile: () => {},
    onOpenContentHit: (relPath) => opened.push(relPath),
    onContentResults: (pattern) => delivered.push(pattern),
    onExecuteCommand: () => {},
    getShortcut: () => "",
    contentGeneration: () => generation,
  });
  qo.open("content");
  const input = fake.modalRoot.querySelector(".search-input");
  const root = fake.modalRoot.querySelector(".search-modal");
  if (!input || !root) throw new Error("content search modal did not render");
  return { qo, input, root };
}

function hit(text: string) {
  return {
    relPath: "src/a.ts",
    line: 2,
    column: 4,
    text,
    matchOffset: 0,
    matchLength: text.length,
  };
}

afterEach(() => {
  for (const qo of instances) qo.close();
  instances.length = 0;
  fake.modalRoot.replaceChildren();
  pending.length = 0;
});

describe("content search modal", () => {
  it("does not dismiss on Enter before a search has results", () => {
    const { input, root } = mount();
    input.value = "export";
    input.dispatch("input");
    input.dispatch("keydown", { key: "Enter" });
    expect(root.style.display).toBe("flex");
    expect(pending).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it("ignores IME composition Enter", () => {
    const { input, root } = mount();
    input.dispatch("keydown", { key: "Enter", isComposing: true });
    expect(root.style.display).toBe("flex");
    expect(pending).toHaveLength(0);
  });

  it("does not activate a previous query's row while a refinement is pending", () => {
    const { input, root } = mount();
    input.value = "foo";
    input.dispatch("input");
    input.dispatch("keydown", { key: "Enter" });
    pending[0]!.resolve({ hits: [hit("foo")] });
    return Promise.resolve().then(() => {
      input.value = "foobar";
      input.dispatch("input");
      input.dispatch("keydown", { key: "Enter" });
      expect(opened).toEqual([]);
      expect(root.style.display).toBe("flex");
    });
  });

  it("opens the current hit on Enter and leaves the modal", async () => {
    const { input, root } = mount();
    input.value = "foo";
    input.dispatch("input");
    input.dispatch("keydown", { key: "Enter" });
    pending[0]!.resolve({ hits: [hit("foo")] });
    await Promise.resolve();
    input.dispatch("keydown", { key: "Enter" });
    expect(opened).toEqual(["src/a.ts"]);
    expect(root.style.display).toBe("none");
  });

  it("does not restore a cleared explorer listing from an in-flight search", async () => {
    const { input } = mount();
    input.value = "foo";
    input.dispatch("input");
    input.dispatch("keydown", { key: "Enter" });
    generation = 1;
    pending[0]!.resolve({ hits: [hit("foo")] });
    await Promise.resolve();
    expect(delivered).toEqual([]);
    expect(fake.modalRoot.querySelector(".search-hit")).not.toBeNull();
  });

  it("says a truncated empty search was cut short", async () => {
    const { input } = mount();
    input.value = "foo";
    input.dispatch("input");
    input.dispatch("keydown", { key: "Enter" });
    pending[0]!.resolve({ hits: [], truncated: true });
    await Promise.resolve();
    expect(fake.modalRoot.querySelector(".search-status")?.textContent).toContain("cut short");
  });

  it("restores focus when cancelled", () => {
    const previous = fake.document.createElement("button");
    fake.modalRoot.appendChild(previous);
    previous.focus();
    const { input } = mount();
    expect(fake.document.activeElement).toBe(input);
    input.dispatch("keydown", { key: "Escape" });
    expect(fake.document.activeElement).toBe(previous);
  });

  it("marks the dialog and keeps the empty hint out of the listbox", () => {
    mount();
    const dialog = fake.modalRoot.querySelector(".modal");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(fake.modalRoot.querySelector("#quick-open-results")?.querySelector(".search-status")).toBeNull();
  });
});
