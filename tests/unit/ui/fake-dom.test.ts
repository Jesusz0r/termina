import { describe, expect, it } from "vitest";
import { FakeDocument } from "./fake-dom.ts";

describe("fake DOM connection tracking", () => {
  it("connects elements only while their tree reaches the document body", () => {
    const document = new FakeDocument();
    const parent = document.createElement("section");
    const opener = document.createElement("button");
    parent.append(opener);
    expect(document.body.isConnected).toBe(true);
    expect(parent.isConnected).toBe(false);
    expect(opener.isConnected).toBe(false);
    document.body.append(parent);
    expect(parent.isConnected).toBe(true);
    expect(opener.isConnected).toBe(true);
    parent.remove();
    expect(parent.isConnected).toBe(false);
    expect(opener.isConnected).toBe(false);
    document.body.append(parent);
    expect(opener.isConnected).toBe(true);
    opener.remove();
    expect(opener.isConnected).toBe(false);
    expect(parent.isConnected).toBe(true);
  });
});
