/**
 * Explorer e2e test: tree rendering, context-menu actions (create/rename/
 * delete, cut/copy/paste, path copying), and open-in-editor.
 *
 * Launch requirement:
 *   TERMINA_INITIAL_CWD=<fresh fixture: greeting.ts "hello", hello.txt, src/>
 *   --remote-debugging-port=9222
 */
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
const getJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); res.on("error", reject); });
  req.on("error", reject);
});
const targets = await getJson("http://localhost:9222/json");
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

const rowNames = async () =>
  JSON.parse(
    await evalJs(
      `JSON.stringify([...document.querySelectorAll('#explorer-tree .explorer-name')].map(n => n.textContent))`,
    ),
  );

/** Single-click a row (preview-open files; toggles folders). */
const clickRow = async (name) => {
  await evalJs(`
    (() => {
      const row = [...document.querySelectorAll('#explorer-tree .explorer-row')].find(r => r.querySelector('.explorer-name')?.textContent === '${name}');
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()
  `);
};

/** Double-click a row (pins files as permanent tabs). */
const dblClickRow = async (name) => {
  await evalJs(`
    (() => {
      const row = [...document.querySelectorAll('#explorer-tree .explorer-row')].find(r => r.querySelector('.explorer-name')?.textContent === '${name}');
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    })()
  `);
};

/** Direct child names of one directory node (strict :scope selectors). */
const dirKids = async (dirName) =>
  JSON.parse(await evalJs(`(() => {
    const node = [...document.querySelectorAll('#explorer-tree .explorer-node')].find(n => {
      const own = n.querySelector(':scope > .explorer-row > .explorer-name');
      return own?.textContent === '${dirName}';
    });
    const kids = node?.querySelector(':scope > .explorer-children');
    return JSON.stringify(kids ? kids.innerText.split("\n").map(s => s.trim()).filter(Boolean) : null);
  })()`));

/** The root folder's direct children (top-level names only). */
const rootLevel = async () =>
  JSON.parse(await evalJs(`(() => {
    const rootNode = document.querySelector('#explorer-tree > .explorer-node');
    const kids = rootNode?.querySelector(':scope > .explorer-children');
    return JSON.stringify(kids ? kids.innerText.split("\n").map(s => s.trim()).filter(Boolean) : []);
  })()`));

/** Real right-click on a row (CDP synthesizes the contextmenu event). */
const rightClickRow = async (name) => {
  const pos = JSON.parse(
    await evalJs(`(() => {
      const r = [...document.querySelectorAll('#explorer-tree .explorer-row')].find(r => r.querySelector('.explorer-name')?.textContent === '${name}');
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x + Math.min(24, b.width / 2)), y: Math.round(b.y + Math.min(12, b.height / 2)) });
    })()`),
  );
  if (!pos) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "right", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "right", clickCount: 1 });
  return true;
};

const menuLabels = async () => (await evalJs(`JSON.stringify([...document.querySelectorAll('.context-menu .context-menu-item')].map(i => i.textContent))`)) ?? "[]";
const clickMenuItem = async (label) =>
  evalJs(`(() => {
    const item = [...document.querySelectorAll('.context-menu .context-menu-item')].find(i => i.textContent === '${label}');
    item?.click();
    return !!item;
  })()`);
/** Fill the open modal's input and press its primary button. */
const submitModal = async (value) => {
  const v = JSON.stringify(value);
  await evalJs(`(() => {
    const input = document.querySelector('.modal input');
    if (input && ${v} !== null) {
      input.value = ${v};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await sleep(150);
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.modal .modal-btn')].find(b => b.textContent === 'OK');
    btn?.click();
  })()`);
  await sleep(600);
};

// ---- 0. scrub artifacts from earlier runs (suites own their pollution) --
for (const p of [
  "/tmp/termina-test-project/greeting copy.txt",
  "/tmp/termina-test-project/greeting copy 2.txt",
  "/tmp/termina-test-project/greeting copy.ts",
  "/tmp/termina-test-project/src/greeting copy.txt",
  "/tmp/termina-test-project/src/hello.txt",
  "/tmp/termina-test-project/src/greeting.ts",
  "/tmp/termina-test-project/menu-dir",
]) {
  try { rmSync(p, { recursive: true }); } catch {}
}

// ---- 1. explorer rendered with the project root ----
await sleep(500);
const boot = JSON.parse(await evalJs(`
  (() => JSON.stringify({
    explorer: !!document.getElementById('explorer'),
    rootName: document.querySelector('#explorer-tree .explorer-row .explorer-name')?.textContent,
    rows: document.querySelectorAll('#explorer-tree .explorer-row').length,
  }))()
`));
check("explorer shows project root", boot.explorer && boot.rootName === "termina-test-project", JSON.stringify(boot));

// ---- 2. root is expanded by default → see files + src dir ----
await sleep(300);
const rootChildren = (await rowNames()).filter((n) => n !== "termina-test-project");
check("root lists files", rootChildren.includes("greeting.ts") && rootChildren.includes("hello.txt") && rootChildren.includes("src"), rootChildren.join(", "));

// ---- 3. context menu creates a file at the root ----
await rightClickRow("termina-test-project");
await sleep(200);
console.log("DEBUG root menu:", await menuLabels());
await clickMenuItem("New File");
await sleep(300);
console.log("DEBUG modal:", await evalJs(`JSON.stringify({ inputs: document.querySelectorAll('.modal input').length, btns: [...document.querySelectorAll('.modal .modal-btn')].map(b => b.textContent) })`));
await sleep(200);
await submitModal("menu-created.txt");
check("create file works", (await rowNames()).includes("menu-created.txt"), JSON.stringify(await rowNames()));

// ---- 4. rename via context menu ----
await rightClickRow("menu-created.txt");
await sleep(200);
await clickMenuItem("Rename");
await sleep(200);
await submitModal("menu-renamed.txt");
check("rename works", (await rowNames()).includes("menu-renamed.txt"), JSON.stringify(await rowNames()));

// ---- 5. delete via context menu (confirm modal) ----
await rightClickRow("menu-renamed.txt");
await sleep(200);
await clickMenuItem("Delete");
await sleep(200);
await submitModal(null); // no input; just presses OK
await sleep(400);
check("delete works", !(await rowNames()).includes("menu-renamed.txt"), JSON.stringify(await rowNames()));

// ---- 6. folder + nested file via context menus ----
await rightClickRow("termina-test-project");
await sleep(200);
await clickMenuItem("New Folder");
await sleep(200);
await submitModal("menu-dir");
await sleep(300);
await clickRow("menu-dir"); // expand
await sleep(400);
await rightClickRow("menu-dir");
await sleep(200);
await clickMenuItem("New File");
await sleep(200);
await submitModal("nested.txt");
await sleep(400);
const afterFolder = await rowNames();
check("create folder + nested file works", afterFolder.includes("menu-dir") && afterFolder.includes("nested.txt"), afterFolder.join(", "));

// ---- 7. clicking a file opens it in the editor ----
await clickRow("hello.txt");
await sleep(800);
const tabs = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('.editor-tab .tab-name')].map(t => t.textContent))`));
check("clicking a file opens it in the editor", tabs.includes("hello.txt"), tabs.join(", "));

// ---- 8. file context menu offers the VS Code action set ----
const opened = await rightClickRow("hello.txt");
await sleep(200);
const fileLabels = (await menuLabels()) ?? "";
const wanted = ["Cut", "Copy", "Paste", "Copy Path", "Copy Relative Path"];
check("file menu offers cut/copy/paste and paths",
  opened && wanted.every((l) => fileLabels.includes(`"${l}"`)),
  fileLabels);

// ---- 9. cut + paste moves greeting into src ----
await rightClickRow("greeting.ts");
await sleep(200);
await clickMenuItem("Cut");
await sleep(150);
await clickRow("src"); // expand
await sleep(400);
await rightClickRow("src");
await sleep(200);
await clickMenuItem("Paste");
await sleep(700);
const { existsSync } = await import("node:fs");
const pastedIntoSrc = existsSync("/tmp/termina-test-project/src/greeting.ts");
check("cut + paste moves greeting into src", pastedIntoSrc, String(pastedIntoSrc));

// ---- 10. copy back out to the root ----
await rightClickRow("greeting.ts"); // unique: the root copy moved away
await sleep(200);
await clickMenuItem("Copy");
await sleep(150);
await rightClickRow("termina-test-project");
await sleep(200);
await clickMenuItem("Paste");
await sleep(700);
const t = await rowNames();
check("copy pastes a duplicate at the root", t.filter((n) => n === "greeting.ts").length === 2, JSON.stringify(t));

// ---- 11. pasting the held clipboard again collides -> numbered copy ----
await rightClickRow("termina-test-project");
await sleep(200);
await clickMenuItem("Paste");
await sleep(700);
const t2 = await rowNames();
check("name collision gets a numbered copy", t2.includes("greeting copy.ts"), JSON.stringify(t2));

// ---- cleanup: the suite owns its fixture pollution ----
for (const p of [
  "/tmp/termina-test-project/hello copy.txt",
  "/tmp/termina-test-project/hello copy 2.txt",
  "/tmp/termina-test-project/src/hello copy.txt",
  "/tmp/termina-test-project/menu-dir",
]) {
  try { rmSync(p, { recursive: true }); } catch {}
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
