// Reproduce + detect the "WWWWWWW" terminal artifact: captures the xterm canvas
// and analyzes rows for repeated-glyph smears (long runs of identical lit columns).
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const getJson = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
      res.on("error", reject);
    });
  });

const targets = await getJson("http://localhost:9222/json");
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
};

/** Capture canvas rows; report rows with suspicious repeated-glyph runs. */
const analyze = async (label) => {
  const res = await evalJs(`
    (() => {
      const canvas = document.querySelector('.xterm-screen canvas');
      if (!canvas) return 'no-canvas';
      const ctx = canvas.getContext('2d');
      const { width: w, height: h } = canvas;
      const img = ctx.getImageData(0, 0, w, h).data;
      const bg = [20, 20, 20]; // terminal background
      const isBg = (i) => Math.abs(img[i] - bg[0]) < 12 && Math.abs(img[i + 1] - bg[1]) < 12 && Math.abs(img[i + 2] - bg[2]) < 12;
      const rows = [];
      for (let y = 0; y < h; y++) {
        let lit = 0;
        let maxRun = 0, run = 0;
        let prevLit = false;
        for (let x = 0; x < w; x++) {
          const px = (y * w + x) * 4;
          const l = !isBg(px);
          if (l) lit++;
          if (l === prevLit) { run++; } else { run = 1; }
          if (l) maxRun = Math.max(maxRun, run);
          prevLit = l;
        }
        if (lit > 0) rows.push({ y, lit, litPct: Math.round((lit / w) * 100), maxRun });
      }
      // also find runs of repeated *same-colored* columns (glyph smear)
      let smears = [];
      for (let y = 0; y < h; y++) {
        let x = 0;
        while (x < w) {
          const px = (y * w + x) * 4;
          if (isBg(px)) { x++; continue; }
          const r = img[px], g = img[px + 1], b = img[px + 2];
          let end = x;
          while (end < w) {
            const p2 = (y * w + end) * 4;
            if (Math.abs(img[p2] - r) > 8 || Math.abs(img[p2 + 1] - g) > 8 || Math.abs(img[p2 + 2] - b) > 8) break;
            end++;
          }
          const len = end - x;
          if (len > 25) smears.push({ y, x, len });
          x = end;
        }
      }
      return JSON.stringify({ w, h, rows: rows.slice(0, 60), smears: smears.slice(0, 20) });
    })()
  `);
  const data = JSON.parse(res);
  console.log(`\n=== ${label} (canvas ${data.w}x${data.h}) ===`);
  console.log("rows with content (y, lit%, maxRun):");
  for (const r of data.rows) console.log(`  y=${String(r.y).padStart(4)} lit=${String(r.litPct).padStart(3)}% maxRun=${r.maxRun}`);
  console.log("smear runs (y, x, len>25):", data.smears.length ? JSON.stringify(data.smears) : "(none)");
  return data;
};

// ---------------------------------------------------------------------------
const prompt = async (text) => {
  await evalJs(`(() => {
    const input = document.getElementById('prompt-input');
    input.value = ${JSON.stringify(text)};
    document.getElementById('btn-send').click();
  })()`);
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    const st = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
    if (st && !st.includes('working') && i > 2) return;
  }
};

// 1. fresh state
await evalJs(`(async () => { const insts = await window.pi.getInstances(); if (insts[0]) await window.pi.newSession(insts[0].id); })()`);
await sleep(2500);

// 2. create a file so the modified panel expands (terminal shrinks)
await prompt('Create a file artifact.txt containing the text test');
await sleep(2500);
await analyze("after file created (panel expanded)");

// 3. clear the panel -> it collapses -> terminal container resizes -> fit()
await evalJs(`document.getElementById('btn-clear-modified').click()`);
await sleep(800);
await analyze("after panel collapsed (resize)");

// 4. also trigger a window-like resize via device metrics
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
await sleep(800);
await analyze("after viewport resize");
await send("Emulation.clearDeviceMetricsOverride");
await sleep(800);
await analyze("after viewport restore");

process.exit(0);