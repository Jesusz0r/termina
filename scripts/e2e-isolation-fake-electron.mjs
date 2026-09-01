import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

const foreignArg = process.argv.find((arg) => arg.startsWith("--foreign-listener="));
const userDataArg = process.argv.find((arg) => arg.startsWith("--user-data-dir="));
const instance = process.env.TERMINA_E2E_TEST_INSTANCE ?? "unknown";
const signalFile = process.env.TERMINA_E2E_TEST_SIGNAL_FILE
  ?? (process.env.TERMINA_E2E_TEST_SIGNAL_DIR ? `${process.env.TERMINA_E2E_TEST_SIGNAL_DIR}/${instance}-signals.log` : "");
const pidDir = process.env.TERMINA_E2E_TEST_PID_DIR;
let jsonRequests = 0;

const port = foreignArg ? Number(foreignArg.slice("--foreign-listener=".length)) : 0;
const userData = userDataArg?.slice("--user-data-dir=".length);
if (pidDir && !foreignArg) {
  await mkdir(pidDir, { recursive: true });
  await writeFile(join(pidDir, `${instance}-electron.json`), `${JSON.stringify({
    pid: process.pid,
    runRoot: process.env.TERMINA_E2E_RUN_ROOT,
    userData,
  })}\n`);
}
const server = createServer((request, response) => {
  if (foreignArg && request.url === "/health") {
    response.end("foreign");
    return;
  }
  if (request.url === "/json") {
    jsonRequests++;
    if (process.env.TERMINA_E2E_TEST_HANG_JSON === "1"
      || (process.env.TERMINA_E2E_TEST_HANG_FIRST_JSON === "1" && jsonRequests === 1)) return;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1/fake" }]));
    return;
  }
  response.statusCode = 404;
  response.end("missing");
});

async function recordSignal(signal) {
  if (signalFile) {
    await mkdir(dirname(signalFile), { recursive: true });
    await appendFile(signalFile, `${signal}\n`);
  }
  if (process.env.TERMINA_E2E_TEST_IGNORE_TERM === "1" && signal === "SIGTERM") return;
  server.closeAllConnections();
  server.close(() => process.exit(0));
}

process.once("SIGTERM", () => { void recordSignal("SIGTERM"); });
process.once("SIGINT", () => { void recordSignal("SIGINT"); });

server.listen(port, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fake listener address");
  if (foreignArg) {
    console.log(`FOREIGN_READY ${address.port}`);
    return;
  }
  if (!userDataArg) throw new Error("fake Electron requires --user-data-dir");
  const readyDelay = Number(process.env.TERMINA_E2E_TEST_ELECTRON_READY_DELAY_MS ?? 0);
  if (Number.isFinite(readyDelay) && readyDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, readyDelay));
  }
  await mkdir(userData, { recursive: true });
  await writeFile(`${userData}/DevToolsActivePort`, `${address.port}\n/devtools/browser/fake\n`);
});
