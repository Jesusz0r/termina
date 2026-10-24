import { describe, expect, it } from "vitest";
import { storedProjectOrder } from "../../../electron/main/project-entry.ts";

describe("stored project order", () => {
  it("keeps a project that did not open in its saved slot", () => {
    expect(storedProjectOrder(["/a", "/c"], ["/b"], ["/a", "/b", "/c"], 12)).toEqual(["/a", "/b", "/c"]);
    expect(storedProjectOrder(["/b", "/c"], ["/a"], ["/a", "/b", "/c"], 12)).toEqual(["/a", "/b", "/c"]);
  });

  it("anchors consecutive absent projects after each other", () => {
    expect(storedProjectOrder(["/a", "/d"], ["/b", "/c"], ["/a", "/b", "/c", "/d"], 12)).toEqual(["/a", "/b", "/c", "/d"]);
  });

  it("follows the open tabs when the user reordered them", () => {
    expect(storedProjectOrder(["/c", "/a"], ["/b"], ["/a", "/b", "/c"], 12)).toEqual(["/c", "/a", "/b"]);
  });

  it("drops absent projects before open tabs at the cap", () => {
    expect(storedProjectOrder(["/a", "/c"], ["/b"], ["/a", "/b", "/c"], 2)).toEqual(["/a", "/c"]);
  });
});
