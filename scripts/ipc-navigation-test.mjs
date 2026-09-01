/**
 * Live Electron navigation probe for the privileged renderer bridge.
 *
 * Run through the isolated E2E harness:
 *   node scripts/e2e.mjs --skip-build ipc-navigation-test.mjs
 *
 * The CDP navigation is deliberately a data: URL so the probe does not rely
 * on network access. A real app keeps the trusted document, while any foreign
 * document that does load must not be able to invoke privileged IPC.
 */
import { e2ePort } from "./e2e-port.mjs";

const port = e2ePort();
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ""}`);
};

const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = pages.find((item) => item.type === "page");
if (!page) throw new Error("no Electron page is available");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const pending = new Map();
ws.onmessage = (message) => {
  const response = JSON.parse(message.data);
  const resolve = pending.get(response.id);
  if (!resolve) return;
  pending.delete(response.id);
  resolve(response);
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

await send("Page.enable");
const before = await evaluate(`({
  href: location.href,
  protocol: location.protocol,
  hasBridge: typeof window.pi === "object",
  canList: typeof window.pi?.projectList === "function"
})`);
check("trusted application document has its bridge", before?.hasBridge === true && before?.canList === true, JSON.stringify(before));

const foreignUrl = `data:text/html,${encodeURIComponent("<title>foreign</title><script>window.__foreignLoaded = true</script>")}`;
await send("Page.navigate", { url: foreignUrl });
await sleep(500);
const foreign = await evaluate(`(async () => {
  let invoke = "unavailable";
  if (typeof window.pi?.projectList === "function") {
    try { await window.pi.projectList(); invoke = "allowed"; }
    catch { invoke = "denied"; }
  }
  return { href: location.href, protocol: location.protocol, foreignLoaded: window.__foreignLoaded === true, invoke };
})()`);
const stayedTrusted = foreign?.href === before?.href;
const foreignCannotInvoke = foreign?.invoke !== "allowed";
check("foreign navigation is denied or receives no privileged bridge", stayedTrusted || foreignCannotInvoke, JSON.stringify(foreign));
check("a foreign-origin document never obtains privileged IPC", foreign?.invoke !== "allowed", JSON.stringify(foreign));

if (!stayedTrusted && before?.href) {
  await send("Page.navigate", { url: before.href });
  await sleep(500);
}
const restored = await evaluate(`({ href: location.href, hasBridge: typeof window.pi === "object" })`);
check("trusted document can be restored after the foreign probe", restored?.hasBridge === true, JSON.stringify(restored));

console.log(`\nipc navigation probe: ${results.filter(Boolean).length}/${results.length} passed`);
ws.close();
process.exit(results.every(Boolean) ? 0 : 1);
