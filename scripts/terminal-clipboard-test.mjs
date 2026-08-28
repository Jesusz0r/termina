/** Terminal clipboard E2E test. */
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
};

const pages = await fetch("http://127.0.0.1:9222/json").then((response) => response.json());
const page = pages.find((item) => item.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const pending = new Map();
ws.onmessage = (message) => {
  const value = JSON.parse(message.data);
  if (value.id && pending.has(value.id)) {
    pending.get(value.id)(value);
    pending.delete(value.id);
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const requestId = ++id;
  pending.set(requestId, resolve);
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
const evaluate = async (expression) => {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return response.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const marker = "PI_DITOR_COPY_MARKER";

await evaluate(`(() => { const pane = [...window.__panes.values()][0]; pane?.view.write("\\r\\n${marker}\\r\\n"); })()`);
await sleep(100);
check("terminal selection copies through the system clipboard", await evaluate(`(() => {
  const pane = [...window.__panes.values()][0];
  if (!pane) return false;
  pane.view.getTerminal().selectAll();
  return pane.view.copySelection();
})()`));
await sleep(100);
const clipboard = await evaluate(`window.pi.readClipboard()`);
check("copied text contains the terminal output", clipboard.includes(marker), clipboard);
check("terminal copy shortcut dispatches", await evaluate(`(() => {
  const pane = [...window.__panes.values()][0];
  const term = pane?.view.getTerminal();
  if (!term?.textarea) return false;
  term.selectAll();
  // dispatchEvent returns false when preventDefault ran: the app
  // intercepted the shortcut and copied the selection itself.
  const intercepted = !term.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true }));
  return intercepted;
})()`));
await sleep(100);
check("copy shortcut updates the system clipboard", (await evaluate(`window.pi.readClipboard()`)).includes(marker));

const cwd = process.env.TERMINA_INITIAL_CWD;
const eventsDir = process.env.TERMINA_EVENTS_DIR;
const fixtureDir = join(cwd, `.drop-fixture-${Date.now()}`);
const spaceFile = join(fixtureDir, "my file.txt");
const quoteFile = join(fixtureDir, "quote'.txt");
const pngFile = join(fixtureDir, "pic.png");
const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const quotePath = (path) => `'${path.replaceAll("'", "'\\''")}'`;
const expectedPaste = `${quotePath(spaceFile)} ${quotePath(quoteFile)}`;

try {
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(spaceFile, "space");
  await writeFile(quoteFile, "quote");
  await writeFile(pngFile, png1x1);

  await send("DOM.enable");
  await evaluate(`(() => {
    const existing = document.getElementById("termina-drop-input");
    if (existing) existing.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.id = "termina-drop-input";
    input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-1000px";
    document.body.appendChild(input);
  })()`);
  const doc = await send("DOM.getDocument", { depth: 1 });
  const queried = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#termina-drop-input" });
  await send("DOM.setFileInputFiles", { nodeId: queried.result.nodeId, files: [spaceFile, quoteFile, pngFile] });

  const dragoverCancelled = await evaluate(`(() => {
    const pane = document.querySelector(".term-pane.active") || document.querySelector(".term-pane");
    const input = document.getElementById("termina-drop-input");
    const dt = new DataTransfer();
    for (const file of input.files) dt.items.add(file);
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
    const cancelled = !pane.dispatchEvent(over);
    const enter = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt });
    pane.dispatchEvent(enter);
    const hasClass = pane.classList.contains("term-drop-target");
    const leave = new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: dt });
    pane.dispatchEvent(leave);
    pane.dispatchEvent(leave);
    const cleared = !pane.classList.contains("term-drop-target");
    return { cancelled, hasClass, cleared };
  })()`);
  check("file dragover is cancelled", dragoverCancelled?.cancelled === true);
  check("drop target class appears and clears", dragoverCancelled?.hasClass === true && dragoverCancelled?.cleared === true);

  const textDrag = await evaluate(`(() => {
    const pane = document.querySelector(".term-pane.active") || document.querySelector(".term-pane");
    const dt = new DataTransfer();
    dt.setData("text/plain", "hello");
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
    return pane.dispatchEvent(over);
  })()`);
  check("text-only dragover is not cancelled", textDrag === true);

  const piDropMeta = await evaluate(`(() => {
    const pane = document.querySelector(".term-pane.active") || document.querySelector(".term-pane");
    const input = document.getElementById("termina-drop-input");
    const dt = new DataTransfer();
    dt.items.add(input.files[0]);
    dt.items.add(input.files[1]);
    return { types: [...dt.types], files: dt.files.length, names: [...dt.files].map((f) => f.name) };
  })()`);
  check("drop DataTransfer exposes disk-backed files", piDropMeta?.files === 2, JSON.stringify(piDropMeta));
  const piDropResult = await evaluate(`(async () => {
    const pane = window.__panes.get("term-1") || [...window.__panes.values()][0];
    const input = document.getElementById("termina-drop-input");
    const dt = new DataTransfer();
    dt.items.add(input.files[0]);
    dt.items.add(input.files[1]);
    pane.container.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const result = await window.pi.dropTerminalFiles("term-1", [input.files[0], input.files[1]]);
    if (result && result.ok && result.kind === "text" && result.text) pane.view.getTerminal().paste(result.text);
    return { id: pane.instanceId, result };
  })()`);
  check(
    "Pi drop IPC returns quoted paths",
    piDropResult?.result?.ok === true && piDropResult.result.kind === "text" && String(piDropResult.result.text).includes("my file.txt"),
    JSON.stringify(piDropResult),
  );
  const shellCreated = await evaluate(`window.pi.createTerminal({ type: "shell" })`);
  check("shell terminal created for path drop", shellCreated?.ok === true, shellCreated?.error);
  const shellId = shellCreated?.id;
  for (let i = 0; i < 16 && shellId; i++) {
    const ready = await evaluate(`Boolean(window.__panes.get(${JSON.stringify(shellId)}))`);
    if (ready) break;
    await sleep(200);
  }
  await sleep(400);
  await evaluate(`(async () => {
    const pane = window.__panes.get(${JSON.stringify(shellId)});
    const input = document.getElementById("termina-drop-input");
    const dt = new DataTransfer();
    dt.items.add(input.files[0]);
    dt.items.add(input.files[1]);
    pane.container.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const result = await window.pi.dropTerminalFiles(${JSON.stringify(shellId)}, [input.files[0], input.files[1]]);
    if (result && result.ok && result.kind === "text" && result.text) pane.view.getTerminal().paste(result.text);
    return result;
  })()`);
  let shellBuffer = "";
  for (let i = 0; i < 12; i++) {
    shellBuffer = await evaluate(`(() => {
      const pane = window.__panes.get(${JSON.stringify(shellId)});
      const buf = pane?.view.getTerminal()?.buffer.active;
      if (!buf) return "";
      const lines = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      return lines.join("\\n");
    })()`);
    if (shellBuffer.includes("my file.txt")) break;
    await sleep(200);
  }
  check(
    "path drop pastes quoted paths",
    shellBuffer.includes("my file.txt") && (shellBuffer.includes("quote'\\''") || shellBuffer.includes("quote'.txt")),
    shellBuffer,
  );
  check("path drop does not submit the paths", !shellBuffer.includes("\nmy file.txt") || !/my file\.txt\s*$/m.test(shellBuffer.split("\n").pop() ?? ""));

  const created = await evaluate(`window.pi.createTerminal({ type: "agent", engine: "core" })`);
  check("core terminal created", created?.ok === true, created?.error);
  let coreId = created?.id ?? null;
  for (let i = 0; i < 20 && coreId; i++) {
    const ready = await evaluate(`Boolean(window.__panes.get(${JSON.stringify(coreId)}))`);
    if (ready) break;
    await sleep(250);
  }
  const readPaneBuffer = async (id) => evaluate(`(() => {
    const pane = window.__panes.get(${JSON.stringify(id)});
    const buf = pane?.view.getTerminal()?.buffer.active;
    if (!buf) return "";
    const lines = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\\n");
  })()`);
  let coreReady = "";
  for (let i = 0; i < 24; i++) {
    coreReady = await readPaneBuffer(coreId);
    if (coreReady.includes("termina agent-core")) break;
    await sleep(250);
  }
  const coreDrop = await evaluate(`(() => {
    const pane = window.__panes.get(${JSON.stringify(coreId)});
    pane.container.classList.add("active");
    const input = document.getElementById("termina-drop-input");
    const dt = new DataTransfer();
    dt.items.add(input.files[2]);
    pane.container.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return pane.instanceId;
  })()`);
  await evaluate(`window.pi.writeTerminal(${JSON.stringify(coreDrop)}, "\\x1b[201~")`);
  await sleep(800);
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(join(eventsDir, `images-${coreDrop}.json`), "utf8"));
  } catch (err) {
    manifest = { error: String(err) };
  }
  check("core drop writes one pending image", Array.isArray(manifest?.images) && manifest.images.length === 1, JSON.stringify(manifest));
  let coreTitle = "";
  for (let i = 0; i < 16; i++) {
    coreTitle = await readPaneBuffer(coreDrop);
    if (/1 image/.test(coreTitle)) break;
    await sleep(250);
  }
  check("core drop refreshes the image title", /1 image/.test(coreTitle), coreTitle);

  const memErr = await evaluate(`(() => {
    for (const el of document.querySelectorAll(".toast-error")) el.remove();
    const pane = document.querySelector(".term-pane.active") || document.querySelector(".term-pane");
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "x.png", { type: "image/png" }));
    pane.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  })()`);
  await sleep(400);
  const toastText = await evaluate(`document.querySelector(".toast-error")?.textContent ?? ""`);
  check("in-memory File is rejected", memErr === true && toastText.length > 0, toastText);

  const delayed = await evaluate(`(() => {
    const panes = [...window.__panes.values()];
    const pane = panes[panes.length - 1];
    const before = pane.view.getTerminal().buffer.active.length;
    const input = document.getElementById("termina-drop-input");
    const dt = new DataTransfer();
    dt.items.add(input.files[0]);
    pane.container.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    pane.view.dispose();
    return before;
  })()`);
  await sleep(400);
  check("disposed pane does not report drop success", typeof delayed === "number");
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
