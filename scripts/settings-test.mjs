/** Settings e2e test. */
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
};

const pages = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
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

await evaluate(`localStorage.removeItem("termina.preferences"); window.__openSettings()`);
await sleep(100);
check("settings opens from the explorer header", await evaluate(`Boolean(document.querySelector(".settings-modal"))`));
check("appearance section is selected", await evaluate(`document.querySelector(".settings-nav-item.active")?.textContent === "Appearance"`));

await evaluate(`document.querySelector('.settings-theme-card[data-theme="light"]').click()`);
check("light theme applies immediately", await evaluate(`document.documentElement.dataset.theme === "light"`));
check("light theme changes the surface color", await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "#f6f8fa"`));
check("appearance lists type controls", await evaluate(`Array.from(document.querySelectorAll(".settings-inline-control label")).map((el) => el.textContent).join("|") === "Editor font size|Terminal font size|Font family"`));

await evaluate(`(() => { const input = document.querySelectorAll(".settings-inline-control input[type=range]")[1]; input.value = "16"; input.dispatchEvent(new Event("input", { bubbles: true })); document.querySelectorAll(".settings-check-row input")[0].click(); })()`);
check("terminal font size and word wrap persist", await evaluate(`window.pi.getPreferences().then((value) => value.terminalFontSize === 16 && value.wordWrap === true)`));

await evaluate(`document.querySelectorAll(".settings-nav-item")[1].click()`);
check("keyboard section lists shortcuts", await evaluate(`document.querySelectorAll(".settings-shortcut-row").length === 38`));

await evaluate(`(() => { const button = document.querySelector('[data-shortcut="open-settings"]'); button.click(); button.dispatchEvent(new KeyboardEvent("keydown", { key: "K", code: "KeyK", metaKey: true, bubbles: true, cancelable: true })); })()`);
check("shortcut recording accepts a new key", await evaluate(`document.querySelector('[data-shortcut="open-settings"]')?.textContent === "⌘K" || document.querySelector('[data-shortcut="open-settings"]')?.textContent === "Ctrl+K"`));
check("preferences persist through the main process", await evaluate(`window.pi.getPreferences().then((value) => value.shortcuts["open-settings"] === "CmdOrCtrl+K")`));
check("preferences do not use renderer storage", await evaluate(`localStorage.getItem("termina.preferences") === null`));

await evaluate(`document.querySelector(".settings-close").click()`);
await evaluate(`window.__openSettings()`);
check("theme persists after reopening", await evaluate(`document.querySelector('.settings-theme-card[data-theme="light"]')?.classList.contains("selected")`));
await evaluate(`document.querySelector(".settings-reset").click()`);
check("reset all restores the default theme", await evaluate(`document.documentElement.dataset.theme === "dark"`));
await evaluate(`document.querySelector(".settings-close").click()`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
