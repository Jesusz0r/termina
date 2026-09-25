import { describe, expect, it } from "vitest";
import { parseLsofCwd } from "../../../electron/process-cwd.ts";

describe("process cwd", () => {
  it("reads the n record from lsof cwd output", () => {
    expect(parseLsofCwd("p42\nfcwd\nn/Users/me/project/src\n")).toBe("/Users/me/project/src");
    expect(parseLsofCwd("n/not/the/cwd\nfcwd\nn/Users/me/src\n")).toBe("/Users/me/src");
    expect(parseLsofCwd("p1\n")).toBeNull();
  });
});
