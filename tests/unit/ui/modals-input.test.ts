import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installFakeDom, type FakeDocument, type FakeEl } from "./fake-dom.ts";

type Modals = typeof import("../../../src/components/modals.ts");

let modals: Modals;
let fake: { document: FakeDocument; modalRoot: FakeEl; cleanup: () => void };

beforeAll(async () => {
  fake = installFakeDom();
  // modals.ts captures #modal-root at import time, so import after installing
  // (once: the module registry caches it, and the root persists per file).
  modals = await import("../../../src/components/modals.ts");
});

beforeEach(() => {
  fake.modalRoot.replaceChildren();
});

afterAll(() => {
  fake.cleanup();
});

function findInput(root: FakeEl): FakeEl {
  const input = root.querySelector("input");
  if (!input) throw new Error("showInput rendered no textbox");
  return input;
}

describe("showInput keyboard confirm (refs #201)", () => {
  it("resolves with the typed value on Enter", async () => {
    const promise = modals.showInput("New file", "name", "");
    const input = findInput(fake.modalRoot);
    input.value = "notes.txt";
    input.dispatch("keydown", { key: "Enter" });
    await expect(promise).resolves.toEqual({ cancelled: false, value: "notes.txt" });
    // The single close+resolve path ran: the backdrop is gone.
    expect(fake.modalRoot.children.length).toBe(0);
  });

  it("ignores other keys and IME composition Enter", async () => {
    const promise = modals.showInput("Rename", "new name", "old.txt");
    const input = findInput(fake.modalRoot);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    input.dispatch("keydown", { key: "a" });
    input.dispatch("keydown", { key: "Enter", isComposing: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(fake.modalRoot.children.length).toBe(1);
  });

  it("still cancels through the Cancel button", async () => {
    const promise = modals.showInput("New folder", "name", "");
    const cancel = fake.modalRoot.querySelectorAll(".modal-btn").find((b) => b.textContent === "Cancel");
    if (!cancel) throw new Error("showInput rendered no Cancel button");
    cancel.click();
    await expect(promise).resolves.toEqual({ cancelled: true });
  });
});
