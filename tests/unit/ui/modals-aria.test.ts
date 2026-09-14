import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeEl, installFakeDom, type FakeDocument } from "./fake-dom.ts";

type Modals = typeof import("../../../src/components/modals.ts");

let modals: Modals;
let fake: { document: FakeDocument; modalRoot: FakeEl; cleanup: () => void };

beforeAll(async () => {
  fake = installFakeDom();
  // FakeEl is not an HTMLElement subclass; makeModal remembers the opener
  // via `document.activeElement instanceof HTMLElement`.
  Object.setPrototypeOf(FakeEl.prototype, HTMLElement.prototype);
  modals = await import("../../../src/components/modals.ts");
});

beforeEach(() => {
  fake.modalRoot.replaceChildren();
});

afterAll(() => {
  fake.cleanup();
});

function dialog(): FakeEl {
  const modal = fake.modalRoot.querySelector(".modal");
  if (!modal) throw new Error("expected a modal");
  return modal;
}

function labelledByTitle(modal: FakeEl): void {
  const title = modal.querySelector(".modal-title");
  if (!title) throw new Error("expected a modal title");
  expect(title.id).toMatch(/^modal-title-\d+$/);
  expect(modal.getAttribute("aria-modal")).toBe("true");
  expect(modal.getAttribute("aria-labelledby")).toBe(title.id);
}

function button(label: string): FakeEl {
  const btn = fake.modalRoot.querySelectorAll(".modal-btn").find((el) => el.textContent === label);
  if (!btn) throw new Error(`expected button ${label}`);
  return btn;
}

function connectedTrigger(): FakeEl {
  const trigger = fake.document.createElement("button");
  fake.document.body.appendChild(trigger);
  trigger.focus();
  return trigger;
}

describe("makeModal dialog ARIA (refs #303)", () => {
  it("marks confirm and unsaved prompts as alertdialogs labelled by the title", () => {
    void modals.showConfirm("Delete", "Remove this file?");
    const confirm = dialog();
    expect(confirm.getAttribute("role")).toBe("alertdialog");
    labelledByTitle(confirm);
    expect(confirm.querySelector(".modal-title")!.textContent).toBe("Delete");

    fake.modalRoot.replaceChildren();
    void modals.showUnsavedConfirm("Unsaved changes", "Save before close?");
    const unsaved = dialog();
    expect(unsaved.getAttribute("role")).toBe("alertdialog");
    labelledByTitle(unsaved);
  });

  it("marks input and file-list prompts as dialogs through the same builder", () => {
    void modals.showInput("New file", "name", "");
    const input = dialog();
    expect(input.getAttribute("role")).toBe("dialog");
    labelledByTitle(input);

    fake.modalRoot.replaceChildren();
    modals.showFileListModal("A ⇄ B — 2 file(s)", [["a.ts", "modified"], ["b.ts", "created"]], () => {});
    const list = dialog();
    expect(list.classList.contains("worldline-list-modal")).toBe(true);
    expect(list.getAttribute("role")).toBe("dialog");
    labelledByTitle(list);
    const files = list.querySelector(".worldline-list");
    if (!files) throw new Error("expected a file list");
    expect(files.querySelectorAll("li")).toHaveLength(2);
  });

  it("gives stacked modals unique title ids", () => {
    void modals.showConfirm("First", "one");
    void modals.showConfirm("Second", "two");
    const titles = fake.modalRoot.querySelectorAll(".modal-title");
    const dialogs = fake.modalRoot.querySelectorAll(".modal");
    expect(titles).toHaveLength(2);
    expect(titles[0].id).not.toBe(titles[1].id);
    expect(dialogs[0].getAttribute("aria-labelledby")).toBe(titles[0].id);
    expect(dialogs[1].getAttribute("aria-labelledby")).toBe(titles[1].id);
  });

  it("keeps showConfirm's { cancelled, confirmed } contract", async () => {
    const confirmed = modals.showConfirm("Delete", "Remove?");
    button("OK").click();
    await expect(confirmed).resolves.toEqual({ confirmed: true });

    const cancelled = modals.showConfirm("Delete", "Remove?");
    button("Cancel").click();
    await expect(cancelled).resolves.toEqual({ cancelled: true });
  });

  it("restores focus to the opener when it is still connected", async () => {
    const trigger = connectedTrigger();
    expect(trigger instanceof HTMLElement).toBe(true);
    const done = modals.showConfirm("Delete", "Remove?");
    expect(fake.document.activeElement).not.toBe(trigger);
    button("OK").click();
    await expect(done).resolves.toEqual({ confirmed: true });
    expect(fake.document.activeElement).toBe(trigger);
    expect(fake.modalRoot.children.length).toBe(0);
  });

  it("does not restore focus when the opener has been disconnected", async () => {
    const trigger = connectedTrigger();
    const done = modals.showConfirm("Delete", "Remove?");
    trigger.remove();
    button("Cancel").click();
    await expect(done).resolves.toEqual({ cancelled: true });
    expect(fake.document.activeElement).not.toBe(trigger);
  });

  it("restores focus when a file-list row is picked", () => {
    const trigger = connectedTrigger();
    let picked = "";
    modals.showFileListModal("Changed", [["src/a.ts", "modified"]], (relPath) => {
      picked = relPath;
    });
    const files = fake.modalRoot.querySelector(".worldline-list");
    const row = files?.querySelector("li");
    if (!row) throw new Error("expected a file-list row");
    row.click();
    expect(picked).toBe("src/a.ts");
    expect(fake.document.activeElement).toBe(trigger);
    expect(fake.modalRoot.children.length).toBe(0);
  });
});
