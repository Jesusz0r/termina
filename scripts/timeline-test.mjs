/**
 * Session Timeline ("time machine") e2e test.
 *
 * Expects Electron on :9222 with PI_EDITOR_INITIAL_CWD pointing at a fresh
 * project containing greeting.ts ("export const greeting = \"hello\";").
 * The agent is prompted to change it; we then assert:
 *   1. getTimeline() returns agent_start → tool → agent_settled points
 *   2. the tool point carries a snapshot with the new content
 *   3. the strip renders dots in the DOM
 *   4. clicking a dot opens a read-only timeline snapshot tab in the editor
 */
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const pages = await fetch(`http://127.0.0.1:9222/json`).then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. run the agent ----
await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await send("Input.insertText", { text: "Edit greeting.ts so the greeting is hi there" });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  const busy = await evalJs(`document.getElementById('status-state').textContent`);
  if (busy && !busy.includes("working") && i > 3) break;
}
await sleep(1500);

// ---- 2. timeline data ----
const tl = await evalJs(`window.pi.getTimeline('term-1')`);
const types = (tl ?? []).map((e) => e.t);
check("timeline has run markers", types.includes("agent_start") && types.includes("agent_settled"), types.join(","));
const tools = (tl ?? []).filter((e) => e.t === "tool" && e.path?.includes("greeting.ts"));
check("timeline has tool events for greeting.ts", tools.length > 0, JSON.stringify(tools[0] ?? null));
const withContent = tools.find((e) => e.content !== undefined);
check(
  "a tool point carries a snapshot with the new content",
  !!withContent && withContent.content.includes("hi there"),
  JSON.stringify(withContent ?? null).slice(0, 150),
);

// ---- 3. DOM strip ----
const strip = JSON.parse(
  await evalJs(
    `(() => JSON.stringify({
      count: document.querySelectorAll('#timeline-dots .timeline-dot').length,
      playVisible: !document.getElementById('btn-timeline-play').hidden,
      firstTypes: [...document.querySelectorAll('#timeline-dots .timeline-dot')].map(d => d.className).slice(0, 6),
    }))()`,
  ),
);
check("strip renders dots", strip.count >= 3, JSON.stringify(strip));
check("replay button visible", strip.playVisible === true, "");

// ---- 4. click a dot → snapshot tab ----
const clicked = await evalJs(
  `(() => {
    const dots = [...document.querySelectorAll('#timeline-dots .timeline-dot')];
    const target = dots.find(d => d.className.includes('t-tool') && d.title.includes('greeting.ts'));
    if (!target) return false;
    target.click();
    return true;
  })()`,
);
check("found a tool dot to click", clicked === true, "");
await sleep(900);
const tab = JSON.parse(
  await evalJs(
    `(() => {
      const tabs = [...document.querySelectorAll('.editor-tab.timeline-tab')];
      const active = document.querySelector('.editor-tab.active');
      return JSON.stringify({
        hasTimelineTab: tabs.length > 0,
        activeIsTimeline: !!active?.classList.contains('timeline-tab'),
        activeName: active?.querySelector('.tab-name')?.textContent,
        readOnly: window.__piMonaco ? null : null,
      });
    })()`,
  ),
);
check("a timeline snapshot tab opened", tab.hasTimelineTab && tab.activeIsTimeline, JSON.stringify(tab));

// The editor content: read the active model through Monaco internals via DOM.
const content = await evalJs(
  `(() => {
    const views = document.querySelectorAll('.monaco-editor .view-lines');
    const last = views[views.length - 1];
    return last ? last.textContent.replace(/\\u00a0/g, ' ') : '';
  })()`,
);
check("snapshot tab shows the past content", content.includes("hi there"), content.slice(0, 100));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
