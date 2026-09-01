/** Settings e2e test. */
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { e2ePort } from "./e2e-port.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
};

const pages = await fetch(`http://127.0.0.1:${e2ePort()}/json`).then((r) => r.json());
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
const persistedSettings = await evaluate(`(async () => {
  const deadline = Date.now() + 2_000;
  let value = await window.pi.getPreferences();
  while (value.terminalFontSize !== 16 || value.wordWrap !== true) {
    if (Date.now() >= deadline) return { settled: false, value };
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await window.pi.getPreferences();
  }
  return { settled: true, value };
})()`);
check(
  "terminal font size and word wrap persist",
  persistedSettings?.settled === true
    && persistedSettings.value?.terminalFontSize === 16
    && persistedSettings.value?.wordWrap === true,
  JSON.stringify(persistedSettings?.value),
);

await evaluate(`document.querySelectorAll(".settings-nav-item")[1].click()`);
check("keyboard section lists shortcuts", await evaluate(`document.querySelectorAll(".settings-shortcut-row").length >= 39`));
check("keyboard section lists Toggle Thinking", await evaluate(`Boolean(document.querySelector('[data-shortcut="toggle-thinking"]'))`));

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

check(
  "renderer patches cannot set openProjects",
  await evaluate(`(async () => {
    const before = await window.pi.getPreferences();
    const saved = await window.pi.updatePreferences({ patch: { openProjects: ["/evil"] }, activateShortcuts: false });
    return Array.isArray(saved.openProjects) && !saved.openProjects.includes("/evil") && JSON.stringify(saved.openProjects) === JSON.stringify(before.openProjects);
  })()`),
);

const runRoot = process.env.TERMINA_E2E_RUN_ROOT;
if (!runRoot) throw new Error("TERMINA_E2E_RUN_ROOT is required");
const extraRoot = join(runRoot, "termina-settings-extra");
await rm(extraRoot, { recursive: true, force: true });
await mkdir(extraRoot, { recursive: true });
const raced = await evaluate(`(async () => {
  const current = await window.pi.getPreferences();
  const pTheme = window.pi.updatePreferences({ patch: { theme: "light" }, activateShortcuts: false });
  const pFont = window.pi.updatePreferences({ patch: { editorFontSize: 18 }, activateShortcuts: false });
  const pMini = window.pi.updatePreferences({ patch: { minimap: false }, activateShortcuts: false });
  const pKeys = window.pi.updatePreferences({
    patch: { shortcuts: { ...current.shortcuts, "save-all": "CmdOrCtrl+Shift+S" } },
    activateShortcuts: false,
  });
  const pProject = window.pi.projectOpenPath(${JSON.stringify(extraRoot)});
  const [themeSaved, fontSaved, miniSaved, keysSaved, projectSaved] = await Promise.all([pTheme, pFont, pMini, pKeys, pProject]);
  let final = await window.pi.getPreferences();
  for (let i = 0; i < 20; i++) {
    if ((final.openProjects || []).some((p) => String(p).includes("termina-settings-extra"))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
    final = await window.pi.getPreferences();
  }
  return {
    theme: final.theme,
    editorFontSize: final.editorFontSize,
    minimap: final.minimap,
    saveAll: final.shortcuts["save-all"],
    hasExtra: (final.openProjects || []).some((p) => String(p).includes("termina-settings-extra")),
    projectOk: Boolean(projectSaved && projectSaved.cancelled !== true),
    themeSaved: themeSaved.theme,
    fontSaved: fontSaved.editorFontSize,
  };
})()`);
check(
  "disjoint preference patches all commit",
  raced?.theme === "light" && raced?.editorFontSize === 18 && raced?.minimap === false && raced?.saveAll === "CmdOrCtrl+Shift+S" && raced?.hasExtra === true,
  JSON.stringify(raced),
);

const userData = process.env.TERMINA_USER_DATA_DIR;
let diskPrefs = null;
if (userData) {
  for (let i = 0; i < 10; i++) {
    try {
      diskPrefs = JSON.parse(await readFile(join(userData, "preferences.json"), "utf8"));
      if (diskPrefs?.theme === "light" && Array.isArray(diskPrefs.openProjects) && diskPrefs.openProjects.some((p) => String(p).includes("termina-settings-extra"))) break;
    } catch {
      diskPrefs = null;
    }
    await sleep(100);
  }
}
check(
  "queued project patch is on disk",
  Boolean(diskPrefs?.openProjects?.some((p) => String(p).includes("termina-settings-extra"))),
  JSON.stringify(diskPrefs?.openProjects),
);

if (userData) {
  const prefsPath = join(userData, "preferences.json");
  const beforeReject = await evaluate(`window.pi.getPreferences()`);
  await rm(prefsPath, { recursive: true, force: true });
  await mkdir(prefsPath);
  const rejected = await evaluate(`window.pi.updatePreferences({ patch: { wordWrap: true }, activateShortcuts: false }).then(() => ({ ok: true })).catch((err) => ({ ok: false, message: String(err && err.message ? err.message : err) }))`);
  const afterReject = await evaluate(`window.pi.getPreferences()`);
  check("a blocked preference file rejects the patch", rejected?.ok === false, JSON.stringify(rejected));
  check(
    "a rejected save does not change committed preferences",
    afterReject?.wordWrap === beforeReject?.wordWrap && afterReject?.theme === beforeReject?.theme,
    JSON.stringify({ before: beforeReject?.wordWrap, after: afterReject?.wordWrap }),
  );
  await rm(prefsPath, { recursive: true, force: true });
  const recovered = await evaluate(`window.pi.updatePreferences({ patch: { wordWrap: true }, activateShortcuts: false })`);
  check("the next patch commits after the blocked path is removed", recovered?.wordWrap === true, JSON.stringify(recovered?.wordWrap));
}

const piMenu = await evaluate(`(() => {
  const pane = window.__panes.get("term-1") || [...window.__panes.values()].find((p) => p.engine === "pi");
  if (!pane) return { ok: false };
  pane.container.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }));
  const labels = [...document.querySelectorAll(".context-menu-item")].map((el) => el.textContent);
  document.body.click();
  return { ok: true, labels, engine: pane.engine };
})()`);
check(
  "Pi context menu has no thinking item",
  piMenu?.ok === true && !piMenu.labels.some((label) => /thinking/i.test(label || "")),
  JSON.stringify(piMenu),
);

const coreCreated = await evaluate(`window.pi.createTerminal({ type: "agent", engine: "core" })`);
check("core terminal created for thinking menu", coreCreated?.ok === true, coreCreated?.error);
const coreId = coreCreated?.id;
for (let i = 0; i < 20 && coreId; i++) {
  const ready = await evaluate(`Boolean(window.__panes.get(${JSON.stringify(coreId)})?.engine === "core")`);
  if (ready) break;
  await sleep(250);
}
const coreMenu = await evaluate(`(() => {
  const pane = window.__panes.get(${JSON.stringify(coreId)});
  if (!pane) return { ok: false };
  pane.container.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }));
  const labels = [...document.querySelectorAll(".context-menu-item")].map((el) => el.textContent);
  document.body.click();
  return { ok: true, labels, engine: pane.engine };
})()`);
check(
  "core context menu can hide thinking",
  coreMenu?.ok === true && coreMenu.labels.includes("Hide Thinking"),
  JSON.stringify(coreMenu),
);

const toggled = await evaluate(`(async () => {
  const before = await window.pi.getPreferences();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "H", code: "KeyH", metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  for (let i = 0; i < 20; i++) {
    const now = await window.pi.getPreferences();
    if (now.showThinking !== before.showThinking) return now;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return window.pi.getPreferences();
})()`);
check("thinking shortcut persists hide", toggled?.showThinking === false, JSON.stringify(toggled?.showThinking));
const hiddenMenu = await evaluate(`(() => {
  const pane = window.__panes.get(${JSON.stringify(coreId)});
  pane.container.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }));
  const labels = [...document.querySelectorAll(".context-menu-item")].map((el) => el.textContent);
  document.body.click();
  return labels;
})()`);
check("core context menu can show thinking after hide", Array.isArray(hiddenMenu) && hiddenMenu.includes("Show Thinking"), JSON.stringify(hiddenMenu));

if (userData) {
  const prefsPath = join(userData, "preferences.json");
  await rm(prefsPath, { recursive: true, force: true });
  await mkdir(prefsPath);
  const hideRejected = await evaluate(`window.pi.updatePreferences({ patch: { showThinking: true }, activateShortcuts: false }).then(() => ({ ok: true })).catch(() => ({ ok: false }))`);
  const stillHidden = await evaluate(`window.pi.getPreferences()`);
  check("a rejected thinking save keeps the live preference", hideRejected?.ok === false && stillHidden?.showThinking === false, JSON.stringify({ hideRejected, showThinking: stillHidden?.showThinking }));
  await rm(prefsPath, { recursive: true, force: true });
  const restored = await evaluate(`window.pi.updatePreferences({ patch: { showThinking: true }, activateShortcuts: false })`);
  check("thinking save recovers after the blocked path is removed", restored?.showThinking === true);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
