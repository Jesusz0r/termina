/** Terminal clipboard E2E test. */
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
check("terminal copy shortcut uses the selection", await evaluate(`(() => {
  const pane = [...window.__panes.values()][0];
  const term = pane?.view.getTerminal();
  if (!term?.textarea) return false;
  term.selectAll();
  term.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true }));
  return true;
})()`));
await sleep(100);
check("copy shortcut updates the system clipboard", (await evaluate(`window.pi.readClipboard()`)).includes(marker));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
