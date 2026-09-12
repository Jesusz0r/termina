import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("Renderer Chromium sandbox invariants", () => {
  it("keeps the renderer sandboxed, permissionless, and under a strict CSP", () => {
/**
 * Source-level probes for Chromium renderer hardening. The sandboxed
 * preload can only import the renderer-process Electron modules
 * (contextBridge, ipcRenderer, webUtils), so the sandbox flag, the
 * preload imports, and the CSP must move together. Live behavior (boot,
 * inline-script denial, permission denial) is covered by
 * tests/e2e/renderer-sandbox.spec.ts.
 */
const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../../../electron/preload.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../../../src/index.html", import.meta.url), "utf8");

const checks: string[] = [];
function check(name: string, value: unknown) {
  assert.equal(Boolean(value), true, name);
  checks.push(name);
}

// Sandboxed renderer with no Node: the preload runs inside the sandbox.
check("renderer sandbox is on", main.includes("sandbox: true") && !main.includes("sandbox: false"));
check(
  "context isolation stays on with node integration off",
  main.includes("contextIsolation: true") && main.includes("nodeIntegration: false"),
);

// No web permission surface except the DOM clipboard Monaco and the copy
// buttons need: every other request is denied, every other check fails.
check(
  "permission requests deny by default except the dom clipboard",
  main.includes("setPermissionRequestHandler")
    && main.includes('permission === "clipboard-read"')
    && main.includes('permission === "clipboard-sanitized-write"'),
);
check(
  "permission checks fail closed except the dom clipboard",
  main.includes("setPermissionCheckHandler")
    && main.includes('permission === "clipboard-read"')
    && main.includes('permission === "clipboard-sanitized-write"'),
);

// The sandboxed preload may only use the sandbox-compatible Electron
// modules; a Node builtin import would break the window at load.
const electronImport = preload.match(/import\s*\{([^}]*)\}\s*from\s*"electron"/);
const importedNames = new Set(
  (electronImport?.[1] ?? "").split(",").map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean),
);
check(
  "preload imports only sandbox-compatible electron modules",
  electronImport !== null
    && importedNames.size > 0
    && [...importedNames].every((name) => ["contextBridge", "ipcRenderer", "webUtils"].includes(name)),
);
check("preload imports no node builtins", !/from\s+"node:/.test(preload) && !preload.includes("require("));

// The document CSP is the script-execution boundary: no inline scripts and
// no eval anywhere. Inline styles stay for Monaco/xterm and the <style>
// first-paint block; blob: workers stay for Monaco language workers.
const csp = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/)?.[1] ?? "";
const directives = csp.split(";").map((part) => part.trim()).filter(Boolean);
const scriptSrc = directives.find((part) => part.startsWith("script-src ")) ?? "";
check("csp defaults to self", directives.includes("default-src 'self'"));
check(
  "csp script-src allows neither inline scripts nor eval",
  scriptSrc.startsWith("script-src 'self'")
    && !scriptSrc.includes("unsafe-inline")
    && !scriptSrc.includes("unsafe-eval"),
);
check("csp allows eval nowhere", !csp.includes("unsafe-eval"));
check(
  "csp keeps the documented monaco/xterm allowances",
  directives.includes("style-src 'self' 'unsafe-inline'") && directives.includes("worker-src 'self' blob:"),
);
check(
  "csp denies objects, frames, foreign bases, and forms",
  directives.includes("object-src 'none'")
    && directives.includes("frame-src 'none'")
    && directives.includes("base-uri 'self'")
    && directives.includes("form-action 'none'"),
);

assert.equal(checks.length, 11);
  });
});
