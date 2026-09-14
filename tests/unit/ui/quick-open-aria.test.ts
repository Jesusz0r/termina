import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COMMAND_DEFINITIONS } from "../../../shared/commands.ts";
import { installFakeDom, type FakeDocument, type FakeEl } from "./fake-dom.ts";

type QuickOpenMod = typeof import("../../../src/quick-open.ts");

let QuickOpen: QuickOpenMod["QuickOpen"];
let fake: { document: FakeDocument; modalRoot: FakeEl; cleanup: () => void };

beforeAll(async () => {
  fake = installFakeDom();
  ({ QuickOpen } = await import("../../../src/quick-open.ts"));
});

beforeEach(() => {
  fake.modalRoot.replaceChildren();
});

afterAll(() => {
  fake.cleanup();
});

function mountPalette(): { input: FakeEl; results: FakeEl } {
  const qo = new QuickOpen();
  qo.bind({
    onOpenFile: () => {},
    onOpenContentHit: () => {},
    onContentResults: () => {},
    onExecuteCommand: () => {},
    getShortcut: () => "",
  });
  qo.open("actions");
  const input = fake.modalRoot.querySelector(".search-input");
  const results = fake.modalRoot.querySelector("#quick-open-results");
  if (!input || !results) throw new Error("Quick Open did not render the combobox");
  return { input, results };
}

describe("Quick Open combobox ARIA (refs #304)", () => {
  it("wires the WAI-ARIA 1.2 combobox/listbox/option pattern after render", () => {
    const { input, results } = mountPalette();
    const options = results.querySelectorAll('[role="option"]');
    const rendererCount = COMMAND_DEFINITIONS.filter((d) => d.scope === "renderer").length;

    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-haspopup")).toBe("listbox");
    expect(input.getAttribute("aria-controls")).toBe("quick-open-results");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("quick-open-opt-0");

    expect(results.id).toBe("quick-open-results");
    expect(results.getAttribute("role")).toBe("listbox");
    expect(options.length).toBe(rendererCount);
    expect(options[0]!.id).toBe("quick-open-opt-0");
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(options[1]!.id).toBe("quick-open-opt-1");
    expect(options[1]!.getAttribute("aria-selected")).toBe("false");
  });

  it("moves aria-activedescendant and aria-selected with the highlight", () => {
    const { input, results } = mountPalette();
    input.dispatch("keydown", { key: "ArrowDown" });
    const options = results.querySelectorAll('[role="option"]');

    expect(input.getAttribute("aria-activedescendant")).toBe("quick-open-opt-1");
    expect(options[0]!.getAttribute("aria-selected")).toBe("false");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(options[1]!.classList.contains("selected")).toBe(true);
    expect(options[0]!.classList.contains("selected")).toBe(false);
  });

  it("does not mark the empty hint as an option", () => {
    const qo = new QuickOpen();
    qo.bind({
      onOpenFile: () => {},
      onOpenContentHit: () => {},
      onContentResults: () => {},
      onExecuteCommand: () => {},
      getShortcut: () => "",
    });
    qo.open("content");
    const input = fake.modalRoot.querySelector(".search-input");
    const results = fake.modalRoot.querySelector("#quick-open-results");
    if (!input || !results) throw new Error("Quick Open did not render the combobox");

    expect(results.querySelectorAll('[role="option"]').length).toBe(0);
    expect(results.querySelector(".search-empty")?.textContent).toBe("Type to search file contents.");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });
});
