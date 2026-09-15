import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { installFakeDom, FakeEl } from "./fake-dom.ts";
import { createTerminalFind } from "../../../src/main/terminal-find.ts";

const owner = readFileSync(new URL("../../../src/main/terminal-find.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");

describe("terminal-find owner (issue #358)", () => {
  it("owns the bar, decorations, and container ResizeObserver", () => {
    expect(owner).toContain("export function createTerminalFind");
    expect(owner).toContain("function positionTerminalFindBar");
    expect(owner).toContain("resizeObserver.observe(termContainer)");
    expect(renderer).toContain("createTerminalFind");
    expect(renderer).not.toContain("function openTerminalFind");
    expect(renderer).not.toContain("let findBar:");
  });

  describe("find bar behavior", () => {
    let fake: ReturnType<typeof installFakeDom>;
    let observed: unknown[] = [];

    beforeAll(() => {
      fake = installFakeDom();
      observed = [];
      Object.assign(FakeEl.prototype, {
        getBoundingClientRect: () => ({
          top: 0,
          right: 400,
          left: 0,
          bottom: 200,
          width: 400,
          height: 200,
        }),
        select: () => undefined,
      });
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe(target: unknown): void {
          observed.push(target);
        }
        disconnect(): void {}
      };
    });

    afterAll(() => {
      fake.cleanup();
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    });

    function pane(id: string, selection = "") {
      const clears: string[] = [];
      const finds: Array<{ dir: "next" | "prev"; term: string }> = [];
      return {
        instanceId: id,
        error: false,
        clears,
        finds,
        view: {
          clearFind: () => {
            clears.push(id);
          },
          findNext: (term: string) => {
            finds.push({ dir: "next", term });
            return true;
          },
          findPrevious: (term: string) => {
            finds.push({ dir: "prev", term });
            return true;
          },
          onFindResults: () => ({ dispose() {} }),
          focus: () => {},
          getTerminal: () => ({ getSelection: () => selection }),
        },
      };
    }

    it("searches the active pane and clears the previous pane's decorations", () => {
      const container = fake.document.createElement("div") as unknown as HTMLElement;
      (container as unknown as FakeEl).style = {};
      const first = pane("term-1");
      const second = pane("term-2", "needle");
      const panes = new Map<string, ReturnType<typeof pane>>([
        ["term-1", first],
        ["term-2", second],
      ]);
      let active = first;
      const find = createTerminalFind({
        termContainer: container,
        getActivePane: () => active,
        getPaneById: (id) => panes.get(id),
      });
      expect(observed).toContain(container);

      find.open();
      const input = fake.document.body.querySelector("input")!;
      input.value = "alpha";
      input.dispatch("input");
      expect(first.finds).toEqual([{ dir: "next", term: "alpha" }]);

      active = second;
      find.open();
      expect(first.clears).toEqual(["term-1"]);
      expect(second.finds.some((f) => f.term === "needle")).toBe(true);

      find.dispose();
    });

    it("shows error when the search backend throws", () => {
      const container = fake.document.createElement("div") as unknown as HTMLElement;
      const broken = pane("term-err");
      broken.view.findNext = () => {
        throw new Error("search backend");
      };
      const find = createTerminalFind({
        termContainer: container,
        getActivePane: () => broken,
        getPaneById: () => broken,
      });
      find.open();
      const input = fake.document.body.querySelector("input")!;
      input.value = "x";
      input.dispatch("input");
      const count = fake.document.body.querySelector(".terminal-find-count")!;
      expect(count.textContent).toBe("error");
      find.dispose();
    });
  });
});
