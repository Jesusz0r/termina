/** Probe: do the pane dividers still receive drags? */
import { e2ePort } from "../e2e-port.mjs";

const pages = await fetch(`http://127.0.0.1:${e2ePort()}/json`).then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((resolve) => { const i = nextId++; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open a file first so the editor pane un-minimizes.
await evalJs(`
  (() => {
    const row = [...document.querySelectorAll('#explorer-tree .explorer-row')].find(r => r.querySelector('.explorer-name')?.textContent === 'hello.txt');
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()
`);
await sleep(600);
// Wait out any open modal from the host suite before probing.
for (let i = 0; i < 30; i++) {
  const blocked = await evalJs(`!!document.querySelector('.modal-backdrop')`);
  if (!blocked) break;
  await sleep(500);
}
const info = await evalJs(`(() => {
  const d = document.getElementById('divider');
  const ed = document.getElementById('explorer-divider');
  const lp = document.getElementById('left-pane');
  const ex = document.getElementById('explorer');
  const r = d?.getBoundingClientRect();
  const er = ed?.getBoundingClientRect();
  const cs = d ? getComputedStyle(d) : null;
  const ecs = ed ? getComputedStyle(ed) : null;
  return JSON.stringify({
    dividerRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
    explorerDividerRect: er ? { x: er.x, y: er.y, w: er.width, h: er.height } : null,
    dividerBg: cs?.backgroundColor,
    dividerCursor: cs?.cursor,
    explorerBg: ecs?.backgroundColor,
    leftWidth: lp?.style.width ?? "(unset)",
    explorerWidth: ex?.style.width ?? "(unset)",
    layout: document.getElementById('main-split')?.className,
  });
})()`);
console.log("INFO:", info);

// Drag #divider right by 150px.
const d = JSON.parse(await evalJs(`(() => { const r = document.getElementById('divider').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`));
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: d.x, y: d.y, button: "left", clickCount: 1 });
for (let dx = 10; dx <= 150; dx += 25) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: d.x + dx, y: d.y });
}
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: d.x + 150, y: d.y });
await sleep(200);
console.log("after divider drag:", await evalJs(`document.getElementById('left-pane').style.width || "(unset)"`));

// Drag #explorer-divider right by 100px.
console.log("DEBUG hit:", await evalJs(`(() => { const r = document.getElementById('explorer-divider').getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width/2, r.y + Math.min(12, r.height/2)); return el ? el.id + "|" + el.className : "none"; })()`));
const ed = JSON.parse(await evalJs(`(() => { const r = document.getElementById('explorer-divider').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`));
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: ed.x, y: ed.y, button: "left", clickCount: 1 });
for (let dx = 10; dx <= 100; dx += 20) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ed.x + dx, y: ed.y });
}
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ed.x + 100, y: ed.y });
await sleep(200);
console.log("after explorer drag:", await evalJs(`document.getElementById('explorer').style.width || "(unset)"`));

process.exit(0);
