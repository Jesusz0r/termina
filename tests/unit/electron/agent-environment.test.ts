import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import { BRIDGE_EXTENSION } from "../../../electron/bridge-extension.ts";

const pins = {
  TERMINA_EVENTS_DIR: "/unused/events",
  TERMINA_TERMINAL_ID: "term-parent",
  TERMINA_CORE_SESSION_ID: "core-parent",
  TERMINA_CORE_SESSION_FILE: "/unused/session.jsonl",
  TERMINA_CORE_RESUME: "1",
};

describe("agent child environment isolation", () => {
  for (const engine of ["pi", "core"]) {
    it(`${engine} keeps its binding while children inherit no session pins`, () => {
      const root = mkdtempSync(join(tmpdir(), "termina-env-"));
      try {
        const bridge = join(root, "bridge.mjs");
        writeFileSync(bridge, transformSync(BRIDGE_EXTENSION, { loader: "ts", format: "esm" }).code);
        const source = engine === "pi"
          ? `const bridge = await import(${JSON.stringify(pathToFileURL(bridge).href)});
             const handlers = new Map();
             bridge.default({ on: (name, fn) => handlers.set(name, fn) });
             if (!handlers.has('input')) throw new Error('parent lost bridge');
             const reloaded = await import(${JSON.stringify(pathToFileURL(bridge).href + "?reload")});
             const again = new Map();
             reloaded.default({ on: (name, fn) => again.set(name, fn) });
             if (!again.has('input')) throw new Error('reload lost bridge');`
          : `await import(${JSON.stringify(pathToFileURL(resolve("agent-core/main.ts")).href)});`;
        const script = `${source}
          const { execFileSync } = await import('node:child_process');
          const keys = ${JSON.stringify(Object.keys(pins))};
          const child = execFileSync(process.execPath, ['-e', 'const keys = ' + JSON.stringify(keys) + '; console.log(JSON.stringify({pins: keys.filter(key => process.env[key] !== undefined), configurable: process.env.TERMINA_CORE_BIN}))'], {encoding:'utf8'});
          console.log(child.trim());`;
        const result = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
          env: { ...process.env, ...pins, TERMINA_EVENTS_DIR: join(root, "events"), TERMINA_CORE_SESSION_FILE: join(root, "session.jsonl"), HOME: root, TERMINA_CORE_BIN: "/custom/core" }, encoding: "utf8",
        });
        expect(JSON.parse(result.trim())).toEqual({ pins: [], configurable: "/custom/core" });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});
