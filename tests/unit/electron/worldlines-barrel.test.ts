import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const indexSrc = readFileSync(new URL("../../../electron/worldlines/index.ts", import.meta.url), "utf8");
const mainSrc = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");

describe("worldlines barrel (issue #379)", () => {
  it("does not re-export quoteShellArg; main imports the shared owner", () => {
    expect(indexSrc).not.toMatch(/\bquoteShellArg\b/);
    expect(mainSrc).toMatch(
      /import \{[^}]*\bquoteShellArg\b[^}]*\} from ["']\.\.\/shared\/terminal-control\.(?:js|ts)["']/,
    );
    expect(mainSrc).not.toMatch(
      /import \{[^}]*\bquoteShellArg\b[^}]*\} from ["']\.\/worldlines\//,
    );
  });
});
