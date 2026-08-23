/**
 * Editor tab actions e2e test: VS Code-style context menu, drag reorder,
 * middle-click close, and Keep Open (preview pinning).
 *
 * Launch requirement:
 *   TERMINA_INITIAL_CWD=<fresh fixture: greeting.ts "hello", hello.txt, src/>
 *   --remote-debugging-port=9222
 */
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const pages = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pendingMap = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pendingMap.has(msg.id)) { pendingMap.get(msg.id)(msg); pendingMap.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pendingMap.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Single-click an explorer row (opens a replaceable preview tab). */
const clickFile = async (path) => {
  const name = path.split("/").pop();
  const folder = path.includes("/") ? path.split("/").slice(-2, -1)[0] : null;
  const visible = await evalJs(`[...document.querySelectorAll('#explorer-tree .explorer-row')].some(r => r.querySelector('.explorer-name')?.textContent === '${name}')`);
  if (!visible && folder) {
    await evalJs(`(() => {
      const dir = [...document.querySelectorAll('#explorer-tree .explorer-row')].find(r => r.querySelector('.explorer-name')?.textContent === '${folder}');
      dir?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await sleep(300);
  }
  await evalJs(`(() => {
    const target = [...document.querySelectorAll('#explorer-tree .explorer-row')].find(r => r.querySelector('.explorer-name')?.textContent === '${name}');
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
};

/** Double-click pins the file as a permanent tab. Expands parent folders. */
const openPinned = async (path) => {
  const name = path.split("/").pop();
  const folder = path.includes("/") ? path.split("/").slice(-2, -1)[0] : null;
  const visible = await evalJs(`[...document.querySelectorAll('#explorer-tree .explorer-row')].some(r => r.querySelector('.explorer-name')?.textContent === '${name}')`);
  if (!visible && folder) {
    await evalJs(`(() => {
      const dir = [...document.querySelectorAll('#explorer-tree .explorer-row')].find(r => r.querySelector('.explorer-name')?.textContent === '${folder}');
      dir?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await sleep(300);
  }
  await evalJs(`(() => {
    const target = [...document.querySelectorAll('#explorer-tree .explorer-row')].find(r => r.querySelector('.explorer-name')?.textContent === '${name}');
    target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await sleep(350);
};

const names = async () =>
  JSON.parse(
    await evalJs(
      `JSON.stringify([...document.querySelectorAll('.editor-tab:not(.timeline-tab)')].map(t => t.querySelector('.tab-name')?.textContent))`,
    ),
  );

const tabCenter = async (name) =>
  JSON.parse(
    await evalJs(`(() => {
      const t = [...document.querySelectorAll('.editor-tab')].find(t => t.querySelector('.tab-name')?.textContent === '${name}');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    })()`),
  );

/** Real right-click on a tab by name (CDP synthesizes the contextmenu event). */
const rightClickTab = async (name) => {
  const pos = await tabCenter(name);
  if (!pos) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "right", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "right", clickCount: 1 });
  return true;
};

const menuOpen = () => evalJs(`!!document.querySelector('.context-menu')`);
const menuLabels = () => evalJs(`[...document.querySelectorAll('.context-menu .context-menu-item')].map(i => i.textContent)`);
const clickMenuItem = (label) =>
  evalJs(`(() => {
    const item = [...document.querySelectorAll('.context-menu .context-menu-item')].find(i => i.textContent === '${label}');
    item?.click();
    return !!item;
  })()`);
const escapeMenu = () => send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

// ---- 1. three pinned tabs in open order ----
// The explorer renders asynchronously; wait for its rows before clicking.
for (let i = 0; i < 30; i++) {
  const ready = await evalJs(`document.querySelectorAll('#explorer-tree .explorer-row').length > 0`);
  if (ready) break;
  await sleep(500);
}
await openPinned("greeting.ts");
await openPinned("hello.txt");
await openPinned("src/index.ts");
let t = await names();
check("three pinned tabs in open order", JSON.stringify(t) === JSON.stringify(["greeting.ts", "hello.txt", "index.ts"]), JSON.stringify(t));

// ---- 2. right-click shows the action menu ----
await rightClickTab("hello.txt");
await sleep(200);
const labels = (await menuLabels()) ?? [];
check("context menu opens with VS Code actions",
  (await menuOpen()) &&
  ["Close", "Close Others", "Close to the Left", "Close to the Right", "Close All"].every((l) => labels.includes(l)),
  JSON.stringify(labels));

// ---- 3. Close to the Right ----
await clickMenuItem("Close to the Right");
await sleep(300);
t = await names();
check("close to the right keeps left tabs", JSON.stringify(t) === JSON.stringify(["greeting.ts", "hello.txt"]), JSON.stringify(t));
check("menu closed after an action", !(await menuOpen()));

// ---- 4. Close Others ----
await openPinned("src/index.ts");
t = await names();
check("reopened index appends", JSON.stringify(t) === JSON.stringify(["greeting.ts", "hello.txt", "index.ts"]), JSON.stringify(t));
await rightClickTab("hello.txt");
await sleep(150);
await clickMenuItem("Close Others");
await sleep(300);
t = await names();
check("close others keeps only the clicked tab", JSON.stringify(t) === JSON.stringify(["hello.txt"]), JSON.stringify(t));

// ---- 5. Close to the Left ----
await openPinned("src/index.ts");
await sleep(200);
await openPinned("greeting.ts");
t = await names();
check("fixture state for left-close", JSON.stringify(t) === JSON.stringify(["hello.txt", "index.ts", "greeting.ts"]), JSON.stringify(t));
await rightClickTab("index.ts");
await sleep(150);
const midLabels = (await menuLabels()) ?? [];
check("middle tab offers both directional closes", midLabels.includes("Close to the Left") && midLabels.includes("Close to the Right"), JSON.stringify(midLabels));
await clickMenuItem("Close to the Left");
await sleep(300);
t = await names();
check("close to the left keeps right tabs", JSON.stringify(t) === JSON.stringify(["index.ts", "greeting.ts"]), JSON.stringify(t));

// ---- 6. Keep Open pins a preview tab ----
// Close index, then single-click its row: the reopened tab is a preview.
await rightClickTab("index.ts");
await sleep(150);
await clickMenuItem("Close");
await sleep(200);
await clickFile("src/index.ts");
await sleep(500);
let previewState = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('.editor-tab:not(.timeline-tab)')].map(t => ({ n: t.querySelector('.tab-name')?.textContent, p: t.classList.contains('preview') })))`));
const wasPreview = previewState.find((s) => s.n === "index.ts")?.p === true;
await rightClickTab("index.ts");
await sleep(150);
await clickMenuItem("Keep Open");
await sleep(300);
previewState = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('.editor-tab:not(.timeline-tab)')].map(t => ({ n: t.querySelector('.tab-name')?.textContent, p: t.classList.contains('preview') })))`));
check("keep open pins the preview tab", wasPreview && previewState.find((s) => s.n === "index.ts")?.p === false, JSON.stringify(previewState));

// ---- 7. drag reorder ----
// State after step 6: [greeting.ts, hello.txt, index.ts].
await openPinned("hello.txt");
t = await names();
check("three tabs before drag", JSON.stringify(t) === JSON.stringify(["greeting.ts", "index.ts", "hello.txt"]), JSON.stringify(t));
let dragResult = await evalJs(`(() => {
  const find = (n) => [...document.querySelectorAll('.editor-tab')].find(t => t.querySelector('.tab-name')?.textContent === n);
  const a = find('hello.txt'), b = find('index.ts');
  if (!a || !b) return 'missing tabs';
  const dt = new DataTransfer();
  const fire = (el, type, cx) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx }));
  const ra = a.getBoundingClientRect();
  fire(a, 'dragstart', ra.x + 10);
  const rb = b.getBoundingClientRect();
  const cx = rb.x + rb.width * 0.25; // left half -> insert before
  fire(b, 'dragover', cx);
  fire(b, 'drop', cx);
  fire(a, 'dragend', cx);
  return 'ok';
})()`);
await sleep(300);
t = await names();
check("drag moves hello before index", dragResult === "ok" && JSON.stringify(t) === JSON.stringify(["greeting.ts", "hello.txt", "index.ts"]), `${dragResult} ${JSON.stringify(t)}`);
// Reverse direction: drop hello onto the right half of index -> after it.
dragResult = await evalJs(`(() => {
  const find = (n) => [...document.querySelectorAll('.editor-tab')].find(t => t.querySelector('.tab-name')?.textContent === n);
  const a = find('greeting.ts'), b = find('hello.txt');
  if (!a || !b) return 'missing tabs';
  const dt = new DataTransfer();
  const fire = (el, type, cx) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx }));
  const ra = a.getBoundingClientRect();
  fire(a, 'dragstart', ra.x + 10);
  const rb = b.getBoundingClientRect();
  const cx = rb.x + rb.width * 0.75; // right half -> insert after
  fire(b, 'dragover', cx);
  fire(b, 'drop', cx);
  fire(a, 'dragend', cx);
  return 'ok';
  fire(b, 'dragover', cx);
  fire(b, 'drop', cx);
  fire(a, 'dragend', cx);
  return 'ok';
})()`);
await sleep(300);
t = await names();
check("second drag lands greeting after hello", dragResult === "ok" && JSON.stringify(t) === JSON.stringify(["hello.txt", "greeting.ts", "index.ts"]), `${dragResult} ${JSON.stringify(t)}`);

// ---- 8. Escape dismisses the menu without acting ----
await rightClickTab("greeting.ts");
await sleep(150);
check("menu open before escape", await menuOpen());
await escapeMenu();
await sleep(200);
check("escape dismisses the menu", !(await menuOpen()));
check("escape did not close the tab", (await names()).includes("greeting.ts"), JSON.stringify(await names()));

// ---- 9. middle-click closes a tab ----
const midPos = await tabCenter("greeting.ts");
if (!midPos) {
  check("middle-click closes the tab", false, "tab missing");
} else {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: midPos.x, y: midPos.y, button: "middle", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: midPos.x, y: midPos.y, button: "middle", clickCount: 1 });
  await sleep(300);
  t = await names();
  check("middle-click closes the tab", !t.includes("greeting.ts"), JSON.stringify(t));
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
