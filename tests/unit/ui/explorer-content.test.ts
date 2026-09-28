import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom, type FakeDocument, type FakeEl } from "./fake-dom.ts";

type ContentMod = typeof import("../../../src/components/explorer-content.ts");

let ExplorerContent: ContentMod["ExplorerContent"];
let fake: { document: FakeDocument; cleanup: () => void };

beforeAll(async () => {
  fake = installFakeDom();
  ({ ExplorerContent } = await import("../../../src/components/explorer-content.ts"));
});

afterAll(() => {
  fake.cleanup();
});

function mount(): { listing: InstanceType<ContentMod["ExplorerContent"]>; opened: string[]; root: FakeEl } {
  const root = fake.document.createElement("div");
  const section = fake.document.createElement("div");
  section.id = "explorer-content";
  section.hidden = true;
  const title = fake.document.createElement("span");
  title.id = "explorer-content-title";
  const results = fake.document.createElement("div");
  results.id = "explorer-content-results";
  const rerun = fake.document.createElement("button");
  rerun.id = "explorer-content-rerun";
  const clear = fake.document.createElement("button");
  clear.id = "explorer-content-clear";
  section.append(title, rerun, clear, results);
  root.append(section);
  const opened: string[] = [];
  const listing = new ExplorerContent(root as unknown as HTMLElement, {
    onContentHit: (relPath) => opened.push(relPath),
  });
  return { listing, opened, root };
}

describe("explorer content listing", () => {
  it("highlights the match and opens it from the keyboard", () => {
    const { listing, opened, root } = mount();
    listing.showContentResults("needle", [{
      relPath: "src/a.ts",
      line: 4,
      column: 3,
      text: "a needle here",
      matchOffset: 2,
      matchLength: 6,
    }], false);
    const text = root.querySelector(".explorer-content-text");
    expect(text?.querySelector("mark")?.textContent).toBe("needle");
    const hit = root.querySelector(".explorer-content-hit");
    expect(hit?.getAttribute("role")).toBe("listitem");
    hit?.focus();
    hit?.dispatch("keydown", { key: "Enter" });
    expect(opened).toEqual(["src/a.ts"]);
  });

  it("bumps the generation on clear so a late modal result can be dropped", () => {
    const { listing } = mount();
    const before = listing.contentGeneration();
    listing.showContentResults("needle", [], false);
    listing.clearContentResults();
    expect(listing.contentGeneration()).toBe(before + 1);
  });

  it("shows a cut-short note instead of a plain no-match when nothing was searched completely", () => {
    const { listing, root } = mount();
    listing.showContentResults("needle", [], true);
    expect(root.querySelector(".explorer-note")?.textContent).toContain("cut short");
  });
});
